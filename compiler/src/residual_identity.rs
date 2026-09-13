//! Trace-local evidence for residual code sharing, not source value equality.
//!
//! Runtime captures are named by their ABI slot, not by a caller's SSA number.
//! Everything consumed statically is retained, including transitive closures.
//! Unsupported state never produces a reusable key.

use super::{LexicalClosure, hir_error};
use crate::diagnostic::Diagnostic;
use crate::eval::{
    ApplicationRoot, ApplicationSite, CompilerApplication, Context, EffectScope,
    ModuleInstanceScope, closure_free_names,
};
use crate::value::{
    ChoiceSource, Domain, EffectOperationContract, OrderedFields, RuntimeMeaning, RuntimeValue,
    Value, lookup, lookup_signature,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::mem::{Discriminant, discriminant};
use std::rc::{Rc, Weak};

#[derive(Clone, PartialEq)]
pub(super) struct ResidualEnvironmentKey(Vec<Part>);

// Lengths and variant markers make this a structural encoding, not a display
// string or a hash. Scope values retain their revision-qualified identities.
#[derive(Clone, PartialEq)]
enum Part {
    Source(String),
    Body(String, crate::ast::ExpressionId),
    SessionOnly,
    Value(Discriminant<Value>),
    Number(u64),
    Variable(u32),
    Integer(num_bigint::BigInt),
    Text(String),
    Domain(Option<Domain>),
    Runtime(usize, usize, RuntimeMeaning),
    Closure(usize),
    Reference(usize),
    Instances(Rc<ModuleInstanceScope>),
    Scope(Rc<EffectScope>),
    Ownership(EffectOperationContract),
}

enum PortablePart<'a> {
    Source(usize),
    Body(usize, crate::ast::ExpressionId),
    Value(usize),
    Number(u64),
    Variable(usize),
    Integer(Vec<u8>),
    Text(usize),
    Domain(u8),
    Closure(usize),
    Reference(usize),
    Instances(usize),
    Scope(usize),
    Runtime(usize, Vec<u8>, u8, &'a [String]),
}

impl Serialize for PortablePart<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Source(path) => (0_u8, path).serialize(serializer),
            Self::Body(path, body) => (1_u8, path, body).serialize(serializer),
            Self::Value(tag) => (2_u8, tag).serialize(serializer),
            Self::Number(number) => (3_u8, number).serialize(serializer),
            Self::Variable(variable) => (4_u8, variable).serialize(serializer),
            Self::Integer(bytes) => (5_u8, PortableBytes(bytes)).serialize(serializer),
            Self::Text(text) => (6_u8, text).serialize(serializer),
            Self::Domain(domain) => (7_u8, domain).serialize(serializer),
            Self::Closure(index) => (8_u8, index).serialize(serializer),
            Self::Reference(index) => (9_u8, index).serialize(serializer),
            Self::Instances(index) => (10_u8, index).serialize(serializer),
            Self::Scope(index) => (11_u8, index).serialize(serializer),
            Self::Runtime(slot, representation, meaning, cases) => {
                (12_u8, slot, PortableBytes(representation), meaning, cases).serialize(serializer)
            }
        }
    }
}

#[derive(Default)]
struct PortableSymbols<'a> {
    strings: Vec<Cow<'a, str>>,
    indices: HashMap<Cow<'a, str>, usize>,
}

impl<'a> PortableSymbols<'a> {
    fn intern(&mut self, text: Cow<'a, str>) -> usize {
        if let Some(index) = self.indices.get(&text) {
            return *index;
        }
        let index = self.strings.len();
        self.strings.push(text.clone());
        self.indices.insert(text, index);
        index
    }
}

impl ResidualEnvironmentKey {
    pub(super) fn portable(
        &self,
        context: &Rc<Context>,
        signature: &Value,
        checked_argument: Option<&Value>,
        expected_result: Option<&Value>,
        actual_evidence: Option<&Value>,
        runtime_types: &[super::RuntimeType],
    ) -> Result<Option<Vec<u8>>, Diagnostic> {
        let stamp = context.residual_cache_effect_stamp();
        let memo = context.residual_cache.borrow().registry.clone();
        let registry = if let Some(memo) = memo.filter(|memo| memo.stamp == stamp) {
            memo.evidence
        } else {
            let mut registry = Builder::new(context, &[]);
            let mut supported = true;
            for (owner, name, value) in context.residual_operator_extensions() {
                registry.parts.push(Part::Source(owner));
                registry.text(&name);
                if !registry.value(&value)? {
                    supported = false;
                    break;
                }
            }
            let evidence = if supported {
                portable_evidence(
                    context,
                    runtime_types,
                    registry.parts.iter(),
                    HashMap::new(),
                )?
                .map(Rc::new)
            } else {
                None
            };
            context.residual_cache.borrow_mut().registry = Some(RegistryMemo {
                stamp,
                evidence: evidence.clone(),
            });
            evidence
        };
        let Some(registry) = registry else {
            return Ok(None);
        };
        let mut extra = Builder::new(context, &[]);
        if !extra.value(signature)?
            || !extra.optional_value(checked_argument)?
            || !extra.optional_value(expected_result)?
            || !extra.optional_value(actual_evidence)?
        {
            return Ok(None);
        }
        let Some(evidence) = portable_evidence(
            context,
            runtime_types,
            self.0.iter().chain(&extra.parts),
            registry.variables.clone(),
        )?
        else {
            return Ok(None);
        };
        let mut digest = Sha256::new();
        digest.update(registry.digest);
        digest.update(evidence.digest);
        Ok(Some(digest.finalize().to_vec()))
    }
}

#[derive(Clone)]
pub(super) struct RegistryMemo {
    pub(super) stamp: (u32, u64),
    evidence: Option<Rc<PortableEvidence>>,
}

struct PortableEvidence {
    #[cfg(test)]
    encoded_bytes: usize,
    digest: [u8; 32],
    variables: HashMap<u32, usize>,
}

const PROVENANCE_MEMO_ENTRIES: usize = 1024;
const PROVENANCE_MEMO_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct ProvenanceMemo {
    entries: HashMap<(u8, usize), ProvenanceEntry>,
    bytes: usize,
    #[cfg(test)]
    encodings: usize,
}

struct ProvenanceEvidence {
    digest: [u8; 32],
    sources: std::collections::BTreeSet<String>,
}

enum ProvenanceOwner {
    Scope(Weak<EffectScope>),
    Instances(Weak<ModuleInstanceScope>),
}

impl ProvenanceOwner {
    fn alive(&self) -> bool {
        match self {
            Self::Scope(scope) => scope.strong_count() != 0,
            Self::Instances(instances) => instances.strong_count() != 0,
        }
    }
}

struct ProvenanceEntry {
    owner: ProvenanceOwner,
    evidence: Option<Rc<ProvenanceEvidence>>,
    bytes: usize,
}

impl ProvenanceMemo {
    fn evidence(&mut self, part: &Part) -> Option<Rc<ProvenanceEvidence>> {
        let key = match part {
            Part::Scope(scope) => (0, Rc::as_ptr(scope) as usize),
            Part::Instances(scope) => (1, Rc::as_ptr(scope) as usize),
            _ => unreachable!("only immutable provenance enters its encoding memo"),
        };
        if let Some(entry) = self.entries.get(&key) {
            return entry.evidence.clone();
        }
        let mut sources = std::collections::BTreeSet::new();
        let mut encoder = PortableProvenance {
            remaining: 256,
            sources: &mut sources,
        };
        let (encoded, owner) = match part {
            Part::Scope(scope) => (
                encoder.scope(scope, 0),
                ProvenanceOwner::Scope(Rc::downgrade(scope)),
            ),
            Part::Instances(scope) => (
                encoder.instances(scope),
                ProvenanceOwner::Instances(Rc::downgrade(scope)),
            ),
            _ => unreachable!("only immutable provenance enters its encoding memo"),
        };
        #[cfg(test)]
        {
            self.encodings += 1;
        }
        let evidence = encoded.map(|encoded| {
            Rc::new(ProvenanceEvidence {
                digest: Sha256::digest(
                    rmp_serde::to_vec(&encoded).expect("portable provenance serialization"),
                )
                .into(),
                sources,
            })
        });
        let mut bytes = std::mem::size_of::<ProvenanceEntry>() + 64;
        if let Some(evidence) = &evidence {
            bytes += std::mem::size_of::<ProvenanceEvidence>();
            bytes += evidence
                .sources
                .iter()
                .map(|source| source.capacity() + 64)
                .sum::<usize>();
        }
        if bytes > PROVENANCE_MEMO_BYTES {
            return evidence;
        }
        if self.entries.len() >= PROVENANCE_MEMO_ENTRIES
            || self.bytes + bytes > PROVENANCE_MEMO_BYTES
        {
            self.entries.retain(|_, entry| entry.owner.alive());
            self.bytes = self.entries.values().map(|entry| entry.bytes).sum();
            if self.entries.len() >= PROVENANCE_MEMO_ENTRIES
                || self.bytes + bytes > PROVENANCE_MEMO_BYTES
            {
                self.entries.clear();
                self.bytes = 0;
            }
        }
        // Weak owners prevent address reuse without retaining scope contents or
        // retired module revisions. Encoding is pure; source digests stay fresh.
        self.entries.insert(
            key,
            ProvenanceEntry {
                owner,
                evidence: evidence.clone(),
                bytes,
            },
        );
        self.bytes += bytes;
        evidence
    }
}

fn portable_evidence<'a>(
    context: &Rc<Context>,
    runtime_types: &[super::RuntimeType],
    parts: impl Iterator<Item = &'a Part>,
    mut variables: HashMap<u32, usize>,
) -> Result<Option<PortableEvidence>, Diagnostic> {
    let modules = context.modules.borrow();
    let mut sources = std::collections::BTreeSet::new();
    let mut transitive = Vec::new();
    let mut queued = std::collections::HashSet::new();
    let mut encoded = Vec::new();
    let mut symbols = PortableSymbols::default();
    let mut digests = HashMap::new();
    let mut tags = HashMap::new();
    let mut instances = HashMap::new();
    let mut scopes = HashMap::new();
    for part in parts {
        let value = match part {
            Part::SessionOnly => return Ok(None),
            Part::Body(module, body) => {
                let loaded = modules
                    .get(module)
                    .ok_or_else(|| hir_error("A residual cache body lost its module."))?;
                let mut bodies = loaded.scalar_cache_bodies.borrow_mut();
                let portable = *bodies.entry(*body).or_insert_with(|| {
                    crate::source_identity::expression_subtree(&loaded.module, *body)
                        .into_iter()
                        .all(|expression| {
                            match &loaded.module.arena.expressions[expression.0 as usize] {
                                crate::ast::Expression::Intrinsic { name, .. } => {
                                    portable_primitive(name)
                                }
                                _ => true,
                            }
                        })
                });
                if !portable {
                    return Ok(None);
                }
                if queued.insert(module.as_str()) {
                    transitive.push(module.as_str());
                }
                PortablePart::Body(symbols.intern(Cow::Borrowed(module)), *body)
            }
            Part::Source(module) => {
                if queued.insert(module.as_str()) {
                    transitive.push(module.as_str());
                }
                PortablePart::Source(symbols.intern(Cow::Borrowed(module)))
            }
            Part::Value(tag) => PortablePart::Value(
                *tags
                    .entry(*tag)
                    .or_insert_with(|| symbols.intern(Cow::Owned(format!("{tag:?}")))),
            ),
            Part::Number(number) => PortablePart::Number(*number),
            Part::Variable(variable) => {
                let next = variables.len();
                let index = variables.entry(*variable).or_insert(next);
                PortablePart::Variable(*index)
            }
            Part::Integer(number) => PortablePart::Integer(number.to_signed_bytes_le()),
            Part::Text(text) => PortablePart::Text(symbols.intern(Cow::Borrowed(text))),
            Part::Domain(domain) => PortablePart::Domain(match domain {
                None => 0,
                Some(Domain::Int) => 1,
                Some(Domain::Text) => 2,
                Some(Domain::Float) => 3,
                Some(Domain::Float32) => 4,
            }),
            Part::Closure(index) => PortablePart::Closure(*index),
            Part::Reference(index) => PortablePart::Reference(*index),
            Part::Instances(scope) => {
                let pointer = Rc::as_ptr(scope);
                let index = if let Some(index) = instances.get(&pointer) {
                    *index
                } else {
                    let Some(evidence) = context
                        .residual_cache
                        .borrow_mut()
                        .provenance
                        .evidence(part)
                    else {
                        return Ok(None);
                    };
                    sources.extend(evidence.sources.iter().cloned());
                    let digest = evidence.digest;
                    let next = digests.len();
                    let index = *digests.entry(digest).or_insert(next);
                    instances.insert(pointer, index);
                    index
                };
                PortablePart::Instances(index)
            }
            Part::Scope(scope) => {
                let pointer = Rc::as_ptr(scope);
                let index = if let Some(index) = scopes.get(&pointer) {
                    *index
                } else {
                    let Some(evidence) = context
                        .residual_cache
                        .borrow_mut()
                        .provenance
                        .evidence(part)
                    else {
                        return Ok(None);
                    };
                    sources.extend(evidence.sources.iter().cloned());
                    let digest = evidence.digest;
                    let next = digests.len();
                    let index = *digests.entry(digest).or_insert(next);
                    scopes.insert(pointer, index);
                    index
                };
                PortablePart::Scope(index)
            }
            Part::Runtime(slot, type_id, meaning) => {
                let Some(representation) =
                    super::residual_cache::type_identity(runtime_types, &[*type_id])
                else {
                    return Ok(None);
                };
                let (meaning, cases) = match meaning {
                    RuntimeMeaning::Plain => (0, &[][..]),
                    RuntimeMeaning::DeferredStore => (1, &[][..]),
                    RuntimeMeaning::SharedStore => (2, &[][..]),
                    RuntimeMeaning::ReusableStore => (3, &[][..]),
                    RuntimeMeaning::Sum { cases } => (4, cases.as_slice()),
                    RuntimeMeaning::Ordering | RuntimeMeaning::ScalarOrdering { .. } => {
                        return Ok(None);
                    }
                };
                PortablePart::Runtime(*slot, representation, meaning, cases)
            }
            Part::Ownership(_) => return Ok(None),
        };
        encoded.push(value);
    }
    while let Some(path) = transitive.pop() {
        let loaded = modules
            .get(path)
            .ok_or_else(|| hir_error("A residual cache dependency lost its module."))?;
        for dependency in loaded.imports.values() {
            if queued.insert(dependency.as_str()) {
                transitive.push(dependency.as_str());
            }
        }
        sources.insert(path.to_owned());
    }
    let sources = sources
        .into_iter()
        .map(|path| {
            let loaded = &modules[&path];
            let digest = loaded.scalar_cache_source_digest.get_or_init(|| {
                let includes = loaded
                    .includes
                    .iter()
                    .map(|(specifier, included)| (specifier, (&included.path, &included.text)))
                    .collect::<BTreeMap<_, _>>();
                let arena = &loaded.module.arena;
                let synthetic = [
                    &arena.synthetic_expressions,
                    &arena.synthetic_closure_bodies,
                    &arena.synthetic_runtime_type_expressions,
                    &arena.synthetic_static_closure_bodies,
                ]
                .map(|expressions| {
                    let mut ids = expressions
                        .iter()
                        .map(|expression| expression.0)
                        .collect::<Vec<_>>();
                    ids.sort_unstable();
                    ids
                });
                let bytes = serde_json::to_vec(&(
                    loaded.module.as_ref(),
                    synthetic,
                    &loaded.imports,
                    includes,
                ))
                .expect("checked module input serialization");
                Sha256::digest(bytes).into()
            });
            (path, *digest)
        })
        .collect::<BTreeMap<_, _>>();
    let mut ordered_digests = vec![[0; 32]; digests.len()];
    for (digest, index) in digests {
        ordered_digests[index] = digest;
    }
    let digest_bytes = ordered_digests.into_iter().flatten().collect::<Vec<_>>();
    rmp_serde::to_vec(&(
        symbols.strings,
        PortableBytes(&digest_bytes),
        encoded,
        sources,
    ))
    .map(|bytes| {
        Some(PortableEvidence {
            #[cfg(test)]
            encoded_bytes: bytes.len(),
            digest: Sha256::digest(bytes).into(),
            variables,
        })
    })
    .map_err(|error| hir_error(&format!("Residual cache key encoding failed: {error}")))
}

struct PortableBytes<'a>(&'a [u8]);

impl Serialize for PortableBytes<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(self.0)
    }
}

// These are administrative addresses only for the non-generative scalar
// cache. ModuleRevision itself deliberately has no portable serialization.
struct PortableProvenance<'a> {
    remaining: usize,
    sources: &'a mut std::collections::BTreeSet<String>,
}

impl PortableProvenance<'_> {
    fn scope(&mut self, scope: &EffectScope, depth: usize) -> Option<serde_json::Value> {
        if depth > 32 {
            return None;
        }
        let mut frames = Vec::new();
        for frame in scope {
            let application = self.site(&frame.application, depth + 1)?;
            let creation = self.scope(&frame.creation_scope, depth + 1)?;
            frames.push(serde_json::json!([application, creation]));
        }
        Some(serde_json::json!(frames))
    }

    fn instances(&mut self, instances: &ModuleInstanceScope) -> Option<serde_json::Value> {
        let mut encoded = Vec::new();
        for instance in instances {
            self.sources
                .insert(instance.imported.source_path().to_owned());
            encoded.push(serde_json::json!([
                self.site(&instance.application, 0)?,
                instance.imported.source_path()
            ]));
        }
        Some(serde_json::json!(encoded))
    }

    fn site(&mut self, site: &ApplicationSite, depth: usize) -> Option<serde_json::Value> {
        if depth > 32 || self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let revision = match &site.root {
            ApplicationRoot::Expression { revision, .. }
            | ApplicationRoot::Declaration { revision, .. } => revision,
        };
        self.sources.insert(revision.source_path().to_owned());
        let root = match &site.root {
            ApplicationRoot::Expression {
                revision,
                expression,
            } => serde_json::json!(["expression", revision.source_path(), expression]),
            ApplicationRoot::Declaration {
                revision,
                declaration,
            } => serde_json::json!(["declaration", revision.source_path(), declaration]),
        };
        let mut steps = Vec::new();
        for step in &site.compiler_steps {
            if self.remaining == 0 {
                return None;
            }
            self.remaining -= 1;
            steps.push(match step {
                CompilerApplication::ForceEffectDeclaration => {
                    serde_json::json!(["effect-declaration"])
                }
                CompilerApplication::ForallBody => serde_json::json!(["forall-body"]),
                CompilerApplication::IncludeParser => serde_json::json!(["include-parser"]),
                CompilerApplication::HandleThunk => serde_json::json!(["handle-thunk"]),
                CompilerApplication::HandleReturn => serde_json::json!(["handle-return"]),
                CompilerApplication::HandleOperation { operation, request } => serde_json::json!([
                    "handle-operation",
                    operation,
                    self.site(request, depth + 1)?
                ]),
                CompilerApplication::RequirementPredicate => {
                    serde_json::json!(["requirement-predicate"])
                }
                CompilerApplication::RecognitionArgument { probe, position } => {
                    serde_json::json!(["recognition-argument", probe, position])
                }
                CompilerApplication::RuntimeExportParameter(index) => {
                    serde_json::json!(["export-parameter", index])
                }
                CompilerApplication::HostCallbackEntry => serde_json::json!(["host-callback"]),
            });
        }
        Some(serde_json::json!([root, steps]))
    }
}

pub(super) fn residual_environment_key(
    context: &Rc<Context>,
    closure: LexicalClosure<'_>,
    captures: &[RuntimeValue],
    instances: &Rc<ModuleInstanceScope>,
    scope: &Rc<EffectScope>,
    reuse: bool,
) -> Result<Option<ResidualEnvironmentKey>, Diagnostic> {
    let mut key = Builder::new(context, captures);
    key.parts.push(Part::Instances(instances.clone()));
    key.parts.push(Part::Scope(scope.clone()));
    key.number(u64::from(reuse));
    if !key.closure(closure)? {
        return Ok(None);
    }
    Ok(Some(ResidualEnvironmentKey(key.parts)))
}

struct Builder<'a> {
    context: &'a Rc<Context>,
    slots: HashMap<(usize, usize), usize>,
    closures: HashMap<(String, u32, usize), usize>,
    parts: Vec<Part>,
}

impl<'a> Builder<'a> {
    fn new(context: &'a Rc<Context>, captures: &[RuntimeValue]) -> Self {
        Self {
            context,
            slots: captures
                .iter()
                .enumerate()
                .map(|(slot, capture)| ((capture.id, capture.type_id), slot))
                .collect(),
            closures: HashMap::new(),
            parts: Vec::new(),
        }
    }

    fn number(&mut self, number: u64) {
        self.parts.push(Part::Number(number));
    }

    fn text(&mut self, text: &str) {
        self.parts.push(Part::Text(text.to_owned()));
    }

    fn optional_value(&mut self, value: Option<&Value>) -> Result<bool, Diagnostic> {
        self.number(u64::from(value.is_some()));
        match value {
            Some(value) => self.value(value),
            None => Ok(true),
        }
    }

    fn values<'v>(
        &mut self,
        values: impl ExactSizeIterator<Item = &'v Value>,
    ) -> Result<bool, Diagnostic> {
        self.number(values.len() as u64);
        for value in values {
            if !self.value(value)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn fields(&mut self, fields: &OrderedFields) -> Result<bool, Diagnostic> {
        self.number(fields.len() as u64);
        for (name, value) in fields {
            self.text(name);
            if !self.value(value)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn runtime(&mut self, value: &RuntimeValue) -> Result<bool, Diagnostic> {
        if matches!(
            value.meaning,
            RuntimeMeaning::Ordering | RuntimeMeaning::ScalarOrdering { .. }
        ) {
            return Ok(false);
        }
        let slot = self.slots.get(&(value.id, value.type_id)).ok_or_else(|| {
            hir_error("Residual environment evidence refers to an unplanned runtime capture.")
        })?;
        self.parts
            .push(Part::Runtime(*slot, value.type_id, value.meaning.clone()));
        Ok(true)
    }

    fn closure(&mut self, closure: LexicalClosure<'_>) -> Result<bool, Diagnostic> {
        let identity = (
            closure.module.to_owned(),
            closure.body.0,
            Rc::as_ptr(closure.environment) as usize,
        );
        if let Some(index) = self.closures.get(&identity) {
            self.parts.push(Part::Reference(*index));
            return Ok(true);
        }
        let index = self.closures.len();
        self.closures.insert(identity, index);
        self.parts.push(Part::Closure(index));
        self.parts
            .push(Part::Body(closure.module.to_owned(), closure.body));
        self.text(closure.module);
        self.number(closure.parameter.0 as u64);
        self.number(closure.body.0 as u64);
        self.number(u64::from(closure.self_name.is_some()));
        if let Some(name) = closure.self_name {
            self.text(name);
        }

        // These substitutions are read by specialization independently of free
        // term variables. Retain the nearest lexical value of every variable.
        let mut substitutions = BTreeMap::new();
        let mut effect_substitutions = BTreeMap::new();
        let mut environment = Some(closure.environment.clone());
        while let Some(current) = environment {
            for (effect, value) in current.effect_substitutions.borrow().iter() {
                effect_substitutions
                    .entry(*effect)
                    .or_insert_with(|| value.clone());
            }
            for (variable, value) in current.type_substitutions.borrow().iter() {
                substitutions
                    .entry(*variable)
                    .or_insert_with(|| value.clone());
            }
            environment = current.parent.borrow().clone();
        }
        self.number(substitutions.len() as u64);
        for (variable, value) in substitutions {
            self.parts.push(Part::Variable(variable));
            if !self.value(&value)? {
                return Ok(false);
            }
        }
        self.number(effect_substitutions.len() as u64);
        for (effect, value) in effect_substitutions {
            self.number(u64::from(effect));
            if !self.value(&value)? {
                return Ok(false);
            }
        }
        let names = closure_free_names(
            self.context,
            closure.module,
            closure.parameter,
            closure.body,
            closure.self_name,
        )?;
        self.number(names.len() as u64);
        for name in names {
            self.text(&name);
            // An absent binding is recorded explicitly, not conflated with a
            // value. Demand may make a syntactic free occurrence unreachable.
            if !self.optional_value(lookup(closure.environment, &name).as_ref())?
                || !self.optional_value(lookup_signature(closure.environment, &name).as_ref())?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn value(&mut self, value: &Value) -> Result<bool, Diagnostic> {
        self.parts.push(Part::Value(discriminant(value)));
        match value {
            Value::Int(value) => self.parts.push(Part::Integer(value.clone())),
            Value::Float(value) => self.number(value.to_bits()),
            Value::Float32(value) => self.number(value.to_bits() as u64),
            Value::Vector(values) => {
                for value in values {
                    self.number(value.to_bits() as u64);
                }
            }
            Value::VectorMask(values) => {
                for value in values {
                    self.number(u64::from(*value));
                }
            }
            Value::IntegerVector { bits, lanes } => {
                self.number(*bits as u64);
                self.number(lanes.len() as u64);
                for value in lanes {
                    self.number(*value as u32 as u64);
                }
            }
            Value::IntegerVectorMask { bits, lanes } => {
                self.number(*bits as u64);
                self.number(lanes.len() as u64);
                for value in lanes {
                    self.number(u64::from(*value));
                }
            }
            Value::Text(value) => self.text(value),
            Value::OpaqueType(value) => self.text(value),
            Value::Unit | Value::Unbounded => {}
            Value::TypeVariable(variable) => self.parts.push(Part::Variable(*variable)),
            Value::Shape(fields) => return self.fields(fields),
            Value::Array(values) => return self.values(values.iter()),
            Value::Union(values) => return self.values(values.iter()),
            Value::IndexedStep { elements } => return self.values(elements.iter()),
            Value::Scratch { values, capacity } => {
                self.parts.push(Part::SessionOnly);
                self.number(*capacity as u64);
                return self.values(values.iter());
            }
            Value::RegionType(value)
            | Value::ScratchType(value)
            | Value::EmptyArray { element: value } => return self.value(value),
            Value::ResourceType { family, payload } => {
                self.text(family);
                return self.value(payload);
            }
            Value::DeferredScratch { capacity } => {
                self.parts.push(Part::SessionOnly);
                return self.value(capacity);
            }
            Value::Tag { name, payload } => {
                self.text(name);
                return self.optional_value(payload.as_deref());
            }
            Value::Primitive {
                name,
                arity,
                applied,
            } => {
                if !portable_primitive(name) {
                    self.parts.push(Part::SessionOnly);
                }
                self.text(name);
                self.number(*arity as u64);
                return self.values(applied.iter());
            }
            Value::Range { low, high, domain } => {
                self.parts.push(Part::Domain(*domain));
                return Ok(self.value(low)? && self.value(high)?);
            }
            Value::Arrow {
                deferred,
                domain,
                codomain,
                effects,
                effect_tail,
            } => {
                self.number(u64::from(*deferred));
                self.number(u64::from(effect_tail.is_some()));
                if let Some(tail) = effect_tail {
                    self.parts.push(Part::Variable(*tail));
                }
                return Ok(self.value(domain)?
                    && self.value(codomain)?
                    && self.values(effects.iter())?);
            }
            Value::Forall { variable, body } => {
                self.parts.push(Part::Variable(*variable));
                return self.value(body);
            }
            Value::Effect {
                id,
                name,
                operations,
                operation_ownership,
                host,
            } => {
                self.parts.push(Part::SessionOnly);
                self.number(*id as u64);
                self.text(name);
                self.number(u64::from(*host));
                self.number(operation_ownership.len() as u64);
                for (name, ownership) in operation_ownership {
                    self.text(name);
                    self.parts.push(Part::Ownership(ownership.clone()));
                }
                return self.fields(operations);
            }
            Value::Operation { effect, name } => {
                self.text(name);
                return self.value(effect);
            }
            Value::Sealed { name, inner } => {
                self.text(name);
                return self.value(inner);
            }
            Value::Extended { inner, members } => {
                return Ok(self.value(inner)? && self.fields(members)?);
            }
            Value::ModuleClosure { module } => {
                self.parts.push(Part::SessionOnly);
                self.text(module);
            }
            Value::Runtime(value) => return self.runtime(value),
            Value::Closure {
                module,
                module_instances,
                effect_scope,
                parameter,
                body,
                environment,
                self_name,
                imports,
                signature,
                reuse_assertion,
                deferred,
            } => {
                self.parts.push(Part::Instances(module_instances.clone()));
                self.parts.push(Part::Scope(effect_scope.clone()));
                self.number(u64::from(*deferred));
                self.number(u64::from(reuse_assertion.is_some()));
                self.number(u64::from(imports.is_some()));
                if let Some(imports) = imports {
                    self.number(imports.len() as u64);
                    for (name, path) in imports {
                        self.text(name);
                        self.text(path);
                    }
                }
                if !self.optional_value(signature.as_deref())? {
                    return Ok(false);
                }
                return self.closure(LexicalClosure {
                    module,
                    parameter: *parameter,
                    body: *body,
                    environment,
                    self_name: self_name.as_deref(),
                });
            }
            Value::ClosureChoice {
                selector,
                alternatives,
            } => {
                if !self.runtime(selector)? {
                    return Ok(false);
                }
                self.number(alternatives.len() as u64);
                for alternative in alternatives.iter() {
                    self.number(alternative.product_type as u64);
                    self.number(alternative.payload_type as u64);
                    self.number(alternative.captures.len() as u64);
                    for capture in &alternative.captures {
                        if !self.runtime(capture)? {
                            return Ok(false);
                        }
                    }
                    let source = match &alternative.source {
                        ChoiceSource::Lambda {
                            module,
                            module_instances,
                            effect_scope,
                            parameter,
                            body,
                            environment,
                            self_name,
                            signature,
                            reuse_assertion,
                            deferred,
                        } => Value::Closure {
                            module: module.clone(),
                            module_instances: module_instances.clone(),
                            effect_scope: effect_scope.clone(),
                            parameter: *parameter,
                            body: *body,
                            environment: environment.clone(),
                            self_name: self_name.clone(),
                            imports: None,
                            signature: signature.clone(),
                            reuse_assertion: *reuse_assertion,
                            deferred: *deferred,
                        },
                        ChoiceSource::Primitive {
                            name,
                            arity,
                            applied,
                        } => Value::Primitive {
                            name: name.clone(),
                            arity: *arity,
                            applied: applied.clone(),
                        },
                    };
                    if !self.value(&source)? {
                        return Ok(false);
                    }
                }
            }
            // Mutable authority and one-shot demand cannot be snapshotted by
            // copying an Rc. Continue staging instead of claiming equality.
            Value::Region { .. }
            | Value::RegionRejoin { .. }
            | Value::Deferred { .. }
            | Value::Continuation { .. } => return Ok(false),
        }
        Ok(true)
    }
}

fn portable_primitive(name: &str) -> bool {
    !matches!(name, "@effect" | "@effect.host" | "@handle" | "@import")
        && !name.starts_with("@continuation.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(value: &Value, captures: &[RuntimeValue]) -> Option<ResidualEnvironmentKey> {
        let context = Rc::new(Context::default());
        let mut builder = Builder::new(&context, captures);
        builder
            .value(value)
            .unwrap()
            .then_some(ResidualEnvironmentKey(builder.parts))
    }

    fn runtime(id: usize, meaning: RuntimeMeaning) -> RuntimeValue {
        RuntimeValue {
            id,
            type_id: 4,
            meaning,
        }
    }

    #[test]
    fn static_values_and_float_bits_are_evidence() {
        assert!(key(&Value::Text("left".into()), &[]) != key(&Value::Text("right".into()), &[]));
        assert!(key(&Value::Float(0.0), &[]) != key(&Value::Float(-0.0), &[]));
        let nan = Value::Float(f64::from_bits(0x7ff8_0000_0000_0001));
        assert!(key(&nan, &[]) == key(&nan, &[]));
        assert!(key(&nan, &[]) != key(&Value::Float(f64::from_bits(0x7ff8_0000_0000_0002)), &[]));
    }

    #[test]
    fn runtime_renaming_preserves_slots_not_caller_numbers() {
        let left = runtime(7, RuntimeMeaning::Plain);
        let right = runtime(91, RuntimeMeaning::Plain);
        assert!(
            key(&Value::Runtime(left.clone()), &[left])
                == key(&Value::Runtime(right.clone()), &[right])
        );
    }

    #[test]
    fn capture_permutations_and_aliases_do_not_share() {
        let x = runtime(7, RuntimeMeaning::Plain);
        let y = runtime(91, RuntimeMeaning::Plain);
        let captures = [x.clone(), y.clone()];
        let pair = |left, right| {
            Value::Shape(OrderedFields::from([
                ("left".into(), Value::Runtime(left)),
                ("right".into(), Value::Runtime(right)),
            ]))
        };
        let original = key(&pair(x.clone(), y.clone()), &captures);
        assert!(original != key(&pair(y.clone(), x.clone()), &captures));
        assert!(original != key(&pair(x.clone(), x), &captures));
    }

    #[test]
    fn capture_ownership_meaning_is_not_just_a_layout() {
        let shared = runtime(7, RuntimeMeaning::SharedStore);
        let reusable = runtime(7, RuntimeMeaning::ReusableStore);
        assert!(
            key(&Value::Runtime(shared.clone()), &[shared])
                != key(&Value::Runtime(reusable.clone()), &[reusable])
        );
    }

    #[test]
    fn empty_array_element_types_and_record_order_are_retained() {
        let ints = Value::EmptyArray {
            element: Box::new(Value::OpaqueType("Int".into())),
        };
        let texts = Value::EmptyArray {
            element: Box::new(Value::OpaqueType("Text".into())),
        };
        assert!(key(&ints, &[]) != key(&texts, &[]));
        let first = Value::Shape(OrderedFields::from([
            ("x".into(), Value::Unit),
            ("y".into(), Value::Unit),
        ]));
        let second = Value::Shape(OrderedFields::from([
            ("y".into(), Value::Unit),
            ("x".into(), Value::Unit),
        ]));
        assert!(key(&first, &[]) != key(&second, &[]));
    }

    #[test]
    fn portable_symbols_preserve_order_values_and_variable_aliases() {
        let context = Rc::new(Context::default());
        let parts = (0..2048)
            .map(|index| Part::Text(format!("repeated evidence {}", index % 2)))
            .collect::<Vec<_>>();
        let encode = |parts: &[Part]| {
            portable_evidence(&context, &[], parts.iter(), HashMap::new())
                .unwrap()
                .unwrap()
        };
        let original = encode(&parts);
        assert!(
            original.encoded_bytes < 9000,
            "repeated strings were serialized in full"
        );
        assert_eq!(original.digest, encode(&parts.clone()).digest);
        let reversed = parts.into_iter().rev().collect::<Vec<_>>();
        assert_ne!(original.digest, encode(&reversed).digest);
        assert_ne!(
            encode(&[Part::Variable(10), Part::Variable(10)]).digest,
            encode(&[Part::Variable(10), Part::Variable(11)]).digest
        );
        assert_eq!(
            encode(&[Part::Variable(10), Part::Variable(11)]).digest,
            encode(&[Part::Variable(20), Part::Variable(21)]).digest
        );
        assert_ne!(
            encode(&[Part::Number(0)]).digest,
            encode(&[Part::Variable(0)]).digest
        );
        let tag = discriminant(&Value::Unit);
        assert_ne!(
            encode(&[Part::Value(tag)]).digest,
            encode(&[Part::Text(format!("{tag:?}"))]).digest
        );
    }

    #[test]
    fn portable_scope_evidence_ignores_allocation_sharing() {
        let context = Rc::new(Context::default());
        let encode = |parts: &[Part]| {
            portable_evidence(&context, &[], parts.iter(), HashMap::new())
                .unwrap()
                .unwrap()
        };
        let scope = Rc::new(Vec::new());
        let shared = encode(&[Part::Scope(scope.clone()), Part::Scope(scope.clone())]);
        let separate = encode(&[
            Part::Scope(Rc::new(Vec::new())),
            Part::Scope(Rc::new(Vec::new())),
        ]);
        assert_eq!(shared.digest, separate.digest);
        assert_ne!(
            shared.digest,
            encode(&[
                Part::Instances(Rc::new(Vec::new())),
                Part::Instances(Rc::new(Vec::new())),
            ])
            .digest
        );
        assert!(encode(&vec![Part::Scope(scope); 2048]).encoded_bytes < 7000);
    }

    #[test]
    fn immutable_provenance_memo_preserves_keys_and_releases_revisions() {
        let context = Rc::new(Context::default());
        let scope = Rc::new(Vec::new());
        let part = Part::Scope(scope.clone());
        let encode = || {
            portable_evidence(&context, &[], std::iter::once(&part), HashMap::new())
                .unwrap()
                .unwrap()
                .digest
        };
        let original = encode();
        for _ in 0..20 {
            assert_eq!(original, encode());
        }
        assert_eq!(context.residual_cache.borrow().provenance.encodings, 1);
        assert_eq!(Rc::strong_count(&scope), 2);
        context.residual_cache.borrow_mut().provenance = ProvenanceMemo::default();
        assert_eq!(original, encode());
        let weak = Rc::downgrade(&scope);
        drop(part);
        drop(scope);
        assert!(weak.upgrade().is_none());
        let instances = (0..PROVENANCE_MEMO_ENTRIES + 1)
            .map(|_| Rc::new(Vec::new()))
            .collect::<Vec<_>>();
        for scope in &instances {
            context
                .residual_cache
                .borrow_mut()
                .provenance
                .evidence(&Part::Instances(scope.clone()));
        }
        let memo = context.residual_cache.borrow();
        assert!(memo.provenance.entries.len() <= PROVENANCE_MEMO_ENTRIES);
        assert!(memo.provenance.bytes <= PROVENANCE_MEMO_BYTES);
        assert_eq!(Rc::strong_count(&instances[0]), 1);
    }

    #[test]
    fn mutable_regions_have_no_reusable_key() {
        let value = Value::Region {
            store: Rc::new(std::cell::RefCell::new(vec![Value::Unit])),
            start: 0,
            end: 1,
        };
        assert!(key(&value, &[]).is_none());
    }
}
