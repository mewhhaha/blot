//! Persistent closed continuation graphs at development boundaries.
//! Function cycles are retained as complete components; arena IDs are relocated.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::rc::Rc;

use super::{
    ResidualTrace, RuntimeSignature, RuntimeStaticStore, RuntimeType, StagedModule,
    StoreReuseWitness,
};
use crate::continuation::{CallTarget, FunctionId, Graph, SignatureId, Transition, TypeId};
use crate::eval::Context;

const RESIDENT_LIMIT: usize = 64 * 1024 * 1024;
const SCHEMA: u32 = 2;

pub(crate) fn word<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<&'static str, D::Error> {
    let value = String::deserialize(decoder)?;
    cache_word(&value).ok_or_else(|| {
        serde::de::Error::custom(format!("unsupported cached runtime word {value:?}"))
    })
}

pub(crate) fn optional_word<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<&'static str>, D::Error> {
    Option::<String>::deserialize(decoder)?
        .map(|value| {
            cache_word(&value).ok_or_else(|| {
                serde::de::Error::custom(format!("unsupported cached runtime word {value:?}"))
            })
        })
        .transpose()
}

fn cache_word(value: &str) -> Option<&'static str> {
    const WORDS: &[&str] = &[
        "plain",
        "owned",
        "borrowed",
        "checked",
        "owned-reuse",
        "persistent",
        "integer-8",
        "integer-16",
        "integer-32",
        "float-32",
        "constant",
        "scalar",
        "scalar.unary",
        "convert",
        "call.direct",
        "product.make",
        "product.project",
        "sum.make",
        "sum.tag",
        "sum.payload",
        "indirect.make",
        "indirect.load",
        "store.empty",
        "store.literal",
        "store.new",
        "store.length",
        "store.read",
        "store.read.field",
        "store.write",
        "store.grow",
        "store.copy",
        "text.append",
        "text.join",
        "text.length",
        "text.scalar-at",
        "text.next-byte",
        "text.slice",
        "text.find-from",
        "text.compare",
        "text.contains",
        "text.from-i64",
        "add",
        "subtract",
        "multiply",
        "divide",
        "remainder",
        "equal",
        "not-equal",
        "less-than",
        "less-than-or-equal",
        "greater-than",
        "greater-than-or-equal",
        "negate",
        "square-root",
        "float-32-to-float-64",
        "float-64-to-float-32",
        "float-64-to-signed-integer-64",
        "signed-integer-32-to-signed-integer-64",
        "signed-integer-64-to-signed-integer-32",
        "signed-integer-64-to-float-32",
        "signed-integer-64-to-float-64",
        "length",
        "at",
        "next-byte",
        "slice",
        "concat",
    ];
    WORDS.iter().copied().find(|candidate| *candidate == value)
}

fn portable_operation(kind: &str) -> bool {
    matches!(
        kind,
        "constant"
            | "scalar"
            | "scalar.unary"
            | "convert"
            | "product.make"
            | "product.project"
            | "sum.make"
            | "sum.tag"
            | "sum.payload"
            | "indirect.make"
            | "indirect.load"
            | "store.empty"
            | "store.literal"
            | "store.new"
            | "store.length"
            | "store.read"
            | "store.read.field"
            | "store.write"
            | "store.grow"
            | "store.copy"
            | "text.append"
            | "text.join"
            | "text.length"
            | "text.scalar-at"
            | "text.next-byte"
            | "text.slice"
            | "text.find-from"
            | "text.compare"
            | "text.contains"
            | "text.from-i64"
    )
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GraphCacheOutcome {
    Hit,
    Miss,
    RepresentationChanged,
    UnsupportedIdentity,
    IncompleteComponent,
    UnsupportedOperation,
    LiveAuthority,
    GenerativeChange,
    Budget,
}

pub(super) fn record(context: &Context, outcome: GraphCacheOutcome) {
    *context
        .development_work
        .borrow_mut()
        .graph_cache
        .entry(outcome)
        .or_default() += 1;
}

#[derive(Default)]
pub(crate) struct ResidualCache {
    pub(super) registry: Option<super::residual_identity::RegistryMemo>,
    entries: HashMap<Rc<Vec<u8>>, Rc<Entry>>,
    order: VecDeque<Rc<Vec<u8>>>,
    bytes: usize,
    pending: Vec<Rc<Vec<u8>>>,
    disabled: bool,
}

pub(super) struct Request {
    pub(super) context: Rc<Context>,
    key: Vec<u8>,
    effect_stamp: (u32, u64),
    function: usize,
    signature: RuntimeSignature,
}

pub(super) struct Restored {
    pub(super) function: usize,
    pub(super) signature: usize,
    pub(super) result_reuse: StoreReuseWitness,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    types: Vec<RuntimeType>,
    signatures: Vec<RuntimeSignature>,
    static_stores: Vec<RuntimeStaticStore>,
    graph: Graph,
    root: FunctionId,
    components: Vec<Vec<FunctionId>>,
    result_reuse: StoreReuseWitness,
    #[serde(skip)]
    bytes: usize,
}

/// Ordered roots establish portable type slots; cycles use local references.
/// Product/sum display names do not distinguish runtime representations.
pub(super) fn type_graph(
    types: &[RuntimeType],
    roots: &[usize],
) -> Option<(Vec<RuntimeType>, Vec<usize>)> {
    let mut originals = Vec::new();
    let mut indices = HashMap::new();
    let mut pending = VecDeque::from(roots.to_vec());
    while let Some(id) = pending.pop_front() {
        if indices.contains_key(&id) {
            continue;
        }
        let type_ = types.get(id)?;
        if matches!(
            type_,
            RuntimeType::Callback { .. }
                | RuntimeType::Resource { .. }
                | RuntimeType::Scratch { .. }
        ) {
            return None;
        }
        indices.insert(id, originals.len());
        originals.push(id);
        pending.extend(super::runtime_type_shape(type_).1);
    }
    let mut remap = vec![0; types.len()];
    for (original, relocated) in &indices {
        remap[*original] = *relocated;
    }
    let result = originals
        .iter()
        .map(|original| {
            let mut type_ = types[*original].clone();
            super::remap_runtime_type(&mut type_, &remap);
            match &mut type_ {
                RuntimeType::Product { name, .. } => *name = "$cached-product".to_owned(),
                RuntimeType::Sum { name, .. } => *name = "$cached-sum".to_owned(),
                _ => {}
            }
            type_
        })
        .collect();
    Some((result, originals))
}

pub(super) fn type_identity(types: &[RuntimeType], roots: &[usize]) -> Option<Vec<u8>> {
    let (types, originals) = type_graph(types, roots)?;
    let indices = originals
        .iter()
        .enumerate()
        .map(|(local, original)| (*original, local))
        .collect::<HashMap<_, _>>();
    let roots = roots.iter().map(|root| indices[root]).collect::<Vec<_>>();
    Some(rmp_serde::to_vec(&(types, roots)).expect("portable runtime type serialization"))
}

fn signature_roots(signature: &RuntimeSignature) -> Vec<usize> {
    signature
        .parameters
        .iter()
        .copied()
        .chain(std::iter::once(signature.result))
        .collect()
}

impl Entry {
    fn validate(&self) -> Result<(), String> {
        if self.graph.functions.get(self.root.0).is_none() {
            return Err("cached graph has an absent root".to_owned());
        }
        if self.signatures.iter().any(|signature| {
            !signature.effects.is_empty()
                || signature_roots(signature)
                    .iter()
                    .any(|id| *id >= self.types.len())
        }) {
            return Err("cached graph has an open or absent signature representation".to_owned());
        }
        let roots = (0..self.types.len()).collect::<Vec<_>>();
        if type_graph(&self.types, &roots).is_none() {
            return Err(
                "cached graph contains live authority or an absent representation".to_owned(),
            );
        }
        super::validate_runtime_layouts(&self.types).map_err(|diagnostic| diagnostic.message)?;
        for store in &self.static_stores {
            if super::static_store_key(store.element_type, &store.values).is_none()
                || store.element_type >= self.types.len()
                || store.values.iter().any(|value| {
                    !crate::continuation::constant_matches(value, &self.types[store.element_type])
                })
            {
                return Err("cached graph has an invalid static Store".to_owned());
            }
        }
        for function in &self.graph.functions {
            if function.suspends || function.framed {
                return Err("cached graph contains a live scheduling contract".to_owned());
            }
            for continuation in &function.continuations {
                for instruction in &continuation.instructions {
                    let operation = &instruction.operation;
                    if !portable_operation(operation.kind)
                        || operation.function.is_some()
                        || operation.signature.is_some()
                        || operation
                            .static_store
                            .is_some_and(|store| store >= self.static_stores.len())
                    {
                        return Err(
                            "cached graph contains an unsupported operation or reference"
                                .to_owned(),
                        );
                    }
                }
                if matches!(
                    &continuation.transition,
                    Transition::Call {
                        target: CallTarget::Host { .. } | CallTarget::Link { .. },
                        ..
                    }
                ) {
                    return Err("cached graph contains an external request".to_owned());
                }
            }
        }
        self.graph.validate(crate::continuation::Tables {
            types: &self.types,
            signatures: &self.signatures,
            static_stores: &self.static_stores,
            capabilities: &[],
            links: &[],
        })?;
        let signature = &self.signatures[self.graph.functions[self.root.0].signature.0];
        if !valid_result_reuse(&self.result_reuse, signature.result, &self.types) {
            return Err("cached graph has an invalid result reuse witness".to_owned());
        }
        if self.components != components(&self.graph)? {
            return Err("cached graph has stale function components".to_owned());
        }
        Ok(())
    }
}

fn valid_result_reuse(witness: &StoreReuseWitness, type_id: usize, types: &[RuntimeType]) -> bool {
    match witness {
        StoreReuseWitness::None => true,
        StoreReuseWitness::Deferred => false,
        StoreReuseWitness::Shared | StoreReuseWitness::Reusable => {
            matches!(types[type_id], RuntimeType::Store { .. })
        }
        StoreReuseWitness::Shape(witnesses) => {
            let RuntimeType::Product { fields, .. } = &types[type_id] else {
                return false;
            };
            let mut names = BTreeSet::new();
            witnesses.iter().all(|(name, witness)| {
                names.insert(name)
                    && fields
                        .iter()
                        .find(|field| field.name == *name)
                        .is_some_and(|field| valid_result_reuse(witness, field.type_id, types))
            })
        }
        StoreReuseWitness::Tag(name, payload) => {
            let RuntimeType::Sum { cases, .. } = &types[type_id] else {
                return false;
            };
            cases
                .iter()
                .find(|case| case.name == *name)
                .is_some_and(|case| {
                    payload
                        .as_ref()
                        .is_none_or(|witness| valid_result_reuse(witness, case.payload_type, types))
                })
        }
    }
}

/// Iterative Kosaraju traversal keeps recursive function groups atomic.
fn components(graph: &Graph) -> Result<Vec<Vec<FunctionId>>, String> {
    let mut outgoing = vec![Vec::new(); graph.functions.len()];
    let mut incoming = vec![Vec::new(); graph.functions.len()];
    for function in &graph.functions {
        for continuation in &function.continuations {
            if let Transition::Call {
                target: CallTarget::Function { function: target },
                ..
            } = &continuation.transition
            {
                if target.0 >= graph.functions.len() {
                    return Err("cached component references an absent function".to_owned());
                }
                outgoing[function.id.0].push(target.0);
                incoming[target.0].push(function.id.0);
            }
        }
    }
    let mut visited = vec![false; outgoing.len()];
    let mut finished = Vec::new();
    for start in 0..outgoing.len() {
        let mut pending = vec![(start, false)];
        while let Some((id, returning)) = pending.pop() {
            if returning {
                finished.push(id);
                continue;
            }
            if std::mem::replace(&mut visited[id], true) {
                continue;
            }
            pending.push((id, true));
            pending.extend(outgoing[id].iter().rev().map(|id| (*id, false)));
        }
    }
    visited.fill(false);
    let mut result = Vec::new();
    for start in finished.into_iter().rev() {
        if visited[start] {
            continue;
        }
        let mut members = Vec::new();
        let mut pending = vec![start];
        while let Some(id) = pending.pop() {
            if std::mem::replace(&mut visited[id], true) {
                continue;
            }
            members.push(FunctionId(id));
            pending.extend(&incoming[id]);
        }
        members.sort_unstable();
        result.push(members);
    }
    result.sort_by_key(|members| members[0]);
    Ok(result)
}

impl Request {
    pub(super) fn new(
        context: &Rc<Context>,
        mut key: Vec<u8>,
        trace: &ResidualTrace,
        signature: RuntimeSignature,
    ) -> Option<Self> {
        let Some(representation) = type_identity(&trace.types, &signature_roots(&signature)) else {
            record(context, GraphCacheOutcome::LiveAuthority);
            return None;
        };
        key.extend(representation);
        Some(Self {
            context: context.clone(),
            key,
            effect_stamp: context.residual_cache_effect_stamp(),
            function: trace.next_function,
            signature,
        })
    }

    pub(super) fn restore(&self, trace: &mut ResidualTrace) -> Option<Restored> {
        let mut cache = self.context.residual_cache.borrow_mut();
        let Some((key, entry)) = cache.entries.get_key_value(&self.key) else {
            record(&self.context, GraphCacheOutcome::Miss);
            return None;
        };
        let key = key.clone();
        let entry = entry.clone();
        let root = &entry.graph.functions[entry.root.0];
        let signature = &entry.signatures[root.signature.0];
        let cached_roots = signature_roots(signature);
        let fresh_roots = signature_roots(&self.signature);
        if type_identity(&entry.types, &cached_roots)? != type_identity(&trace.types, &fresh_roots)?
        {
            record(&self.context, GraphCacheOutcome::RepresentationChanged);
            return None;
        }
        let (_, cached_types) = type_graph(&entry.types, &cached_roots)?;
        let (_, fresh_types) = type_graph(&trace.types, &fresh_roots)?;
        let mut type_map = vec![usize::MAX; entry.types.len()];
        for (cached, fresh) in cached_types.into_iter().zip(fresh_types) {
            type_map[cached] = fresh;
        }
        let mut appended = Vec::new();
        for (cached, fresh) in type_map.iter_mut().enumerate() {
            if *fresh != usize::MAX {
                continue;
            }
            *fresh = trace.types.len() + appended.len();
            appended.push(cached);
        }
        for cached in appended {
            let mut type_ = entry.types[cached].clone();
            super::remap_runtime_type(&mut type_, &type_map);
            trace.types.push(type_);
        }
        let signature_offset = trace.signatures.len();
        for signature in &entry.signatures {
            trace.signatures.push(RuntimeSignature {
                parameters: signature
                    .parameters
                    .iter()
                    .map(|id| type_map[*id])
                    .collect(),
                result: type_map[signature.result],
                effects: Vec::new(),
            });
        }
        let store_offset = trace.static_stores.len();
        for store in &entry.static_stores {
            trace.static_stores.push(RuntimeStaticStore {
                element_type: type_map[store.element_type],
                values: store.values.clone(),
            });
        }
        let function_offset = trace.next_function;
        trace.next_function += entry.graph.functions.len();
        for function in &entry.graph.functions {
            let mut function = function.clone();
            function.map_types(|id| TypeId(type_map[id.0]));
            function.map_signatures(|id| SignatureId(id.0 + signature_offset));
            function.map_functions(|id| FunctionId(id.0 + function_offset));
            for instruction in function
                .continuations
                .iter_mut()
                .flat_map(|continuation| &mut continuation.instructions)
            {
                if let Some(store) = &mut instruction.operation.static_store {
                    *store += store_offset;
                }
            }
            *self
                .context
                .development_work
                .borrow_mut()
                .reused_functions
                .entry(function.span.file.clone())
                .or_default() += 1;
            trace.checked_functions.insert(function.id.0, function);
        }
        cache.order.retain(|previous| *previous != key);
        cache.order.push_back(key);
        record(&self.context, GraphCacheOutcome::Hit);
        Some(Restored {
            function: root.id.0 + function_offset,
            signature: root.signature.0 + signature_offset,
            result_reuse: entry.result_reuse.clone(),
        })
    }

    pub(super) fn store(self, trace: &ResidualTrace, result_reuse: &StoreReuseWitness) {
        if self.effect_stamp != self.context.residual_cache_effect_stamp() {
            record(&self.context, GraphCacheOutcome::GenerativeChange);
            return;
        }
        let mut entry = match self.closed_graph(trace, result_reuse) {
            Ok(entry) => entry,
            Err(outcome) => {
                record(&self.context, outcome);
                return;
            }
        };
        if entry.validate().is_err() {
            record(&self.context, GraphCacheOutcome::UnsupportedOperation);
            return;
        }
        let bytes = rmp_serde::to_vec_named(&(SCHEMA, (&self.key, &entry)))
            .expect("closed graph cache serialization");
        if bytes.len() > RESIDENT_LIMIT
            || crate::value_capsule::validate_snapshot_message_pack(&bytes).is_err()
        {
            record(&self.context, GraphCacheOutcome::Budget);
            return;
        }
        entry.bytes = bytes.len();
        let mut cache = self.context.residual_cache.borrow_mut();
        let key = cache.insert(self.key, Rc::new(entry));
        cache.pending.push(key);
    }

    fn closed_graph(
        &self,
        trace: &ResidualTrace,
        result_reuse: &StoreReuseWitness,
    ) -> Result<Entry, GraphCacheOutcome> {
        let mut originals = Vec::new();
        let mut indices = HashMap::new();
        let mut pending = VecDeque::from([self.function]);
        while let Some(id) = pending.pop_front() {
            if indices.contains_key(&id) {
                continue;
            }
            indices.insert(id, originals.len());
            originals.push(id);
            if let Some(function) = trace.functions.get(&id) {
                if !trace.signatures[function.signature].effects.is_empty() {
                    return Err(GraphCacheOutcome::UnsupportedOperation);
                }
                for operation in function.blocks.iter().flat_map(|block| &block.operations) {
                    if operation.kind == "call.direct" {
                        pending.push_back(
                            operation
                                .function
                                .ok_or(GraphCacheOutcome::IncompleteComponent)?,
                        );
                    } else if !portable_operation(operation.kind) {
                        return Err(GraphCacheOutcome::UnsupportedOperation);
                    }
                }
            } else if let Some(function) = trace.checked_functions.get(&id) {
                for continuation in &function.continuations {
                    if let Transition::Call {
                        target: CallTarget::Function { function },
                        ..
                    } = &continuation.transition
                    {
                        pending.push_back(function.0);
                    }
                }
            } else {
                return Err(GraphCacheOutcome::IncompleteComponent);
            }
        }
        let mut functions = Vec::new();
        let mut checked_functions = Vec::new();
        for id in originals {
            if let Some(function) = trace.functions.get(&id) {
                let mut function = function.clone();
                function.id = indices[&id];
                for operation in function
                    .blocks
                    .iter_mut()
                    .flat_map(|block| &mut block.operations)
                {
                    if let Some(function) = &mut operation.function {
                        *function = indices[function];
                    }
                }
                functions.push(function);
            } else {
                let mut function = trace.checked_functions[&id].clone();
                function.map_functions(|id| FunctionId(indices[&id.0]));
                checked_functions.push(function);
            }
        }
        let root_signature = trace
            .functions
            .get(&self.function)
            .map(|function| function.signature)
            .or_else(|| {
                trace
                    .checked_functions
                    .get(&self.function)
                    .map(|function| function.signature.0)
            })
            .ok_or(GraphCacheOutcome::IncompleteComponent)?;
        let mut module = StagedModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: trace.source.clone(),
            types: trace.types.clone(),
            signatures: trace.signatures.clone(),
            static_stores: trace.static_stores.clone(),
            functions,
            checked_functions,
            capabilities: Vec::new(),
            links: Vec::new(),
            resumable_roots: Vec::new(),
            exports: vec![super::RuntimeExport::Runtime {
                source_name: "cache-root".to_owned(),
                phase: "runtime",
                wasm_name: "cache-root".to_owned(),
                function: 0,
                signature: root_signature,
                ownership: "owned",
            }],
        };
        compact_cache_tables(&mut module)?;
        super::optimize_runtime_module(&mut module, trace.development_units.as_deref())
            .map_err(|_| GraphCacheOutcome::UnsupportedOperation)?;
        let mut graph =
            Graph::lower(&module).map_err(|_| GraphCacheOutcome::UnsupportedOperation)?;
        let super::RuntimeExport::Runtime { function: root, .. } = module.exports[0] else {
            return Err(GraphCacheOutcome::UnsupportedOperation);
        };
        let mut signature_ids = BTreeSet::new();
        for function in &graph.functions {
            signature_ids.insert(function.signature.0);
            for continuation in &function.continuations {
                if let Transition::Call { signature, .. } = &continuation.transition {
                    signature_ids.insert(signature.0);
                }
            }
        }
        let signature_map = signature_ids
            .iter()
            .enumerate()
            .map(|(local, original)| (*original, local))
            .collect::<HashMap<_, _>>();
        let mut roots = Vec::new();
        for signature in &signature_ids {
            roots.extend(signature_roots(&module.signatures[*signature]));
        }
        for function in &graph.functions {
            for continuation in &function.continuations {
                roots.extend(
                    continuation
                        .parameters
                        .iter()
                        .chain(&continuation.captures)
                        .map(|definition| definition.type_id.0),
                );
                roots.extend(
                    continuation
                        .instructions
                        .iter()
                        .map(|instruction| instruction.definition.type_id.0),
                );
            }
        }
        let stores = graph
            .functions
            .iter()
            .flat_map(|function| &function.continuations)
            .flat_map(|continuation| &continuation.instructions)
            .filter_map(|instruction| instruction.operation.static_store)
            .collect::<BTreeSet<_>>();
        roots.extend(
            stores
                .iter()
                .map(|id| module.static_stores[*id].element_type),
        );
        let (types, originals) =
            type_graph(&module.types, &roots).ok_or(GraphCacheOutcome::LiveAuthority)?;
        let mut type_map = vec![0; module.types.len()];
        for (local, original) in originals.into_iter().enumerate() {
            type_map[original] = local;
        }
        let signatures = signature_ids
            .iter()
            .map(|id| RuntimeSignature {
                parameters: module.signatures[*id]
                    .parameters
                    .iter()
                    .map(|id| type_map[*id])
                    .collect(),
                result: type_map[module.signatures[*id].result],
                effects: Vec::new(),
            })
            .collect();
        let store_map = stores
            .iter()
            .enumerate()
            .map(|(local, original)| (*original, local))
            .collect::<HashMap<_, _>>();
        let static_stores = stores
            .iter()
            .map(|id| RuntimeStaticStore {
                element_type: type_map[module.static_stores[*id].element_type],
                values: module.static_stores[*id].values.clone(),
            })
            .collect();
        for function in &mut graph.functions {
            function.map_types(|id| TypeId(type_map[id.0]));
            function.map_signatures(|id| SignatureId(signature_map[&id.0]));
            for instruction in function
                .continuations
                .iter_mut()
                .flat_map(|continuation| &mut continuation.instructions)
            {
                if let Some(store) = &mut instruction.operation.static_store {
                    *store = store_map[store];
                }
            }
        }
        let components = components(&graph).map_err(|_| GraphCacheOutcome::IncompleteComponent)?;
        Ok(Entry {
            types,
            signatures,
            static_stores,
            graph,
            root: FunctionId(root),
            components,
            result_reuse: result_reuse.clone(),
            bytes: 0,
        })
    }
}

fn compact_cache_tables(module: &mut StagedModule) -> Result<(), GraphCacheOutcome> {
    let mut signature_ids = BTreeSet::new();
    let mut roots = Vec::new();
    let mut stores = BTreeSet::new();
    for function in &module.functions {
        signature_ids.insert(function.signature);
        for block in &function.blocks {
            roots.extend(block.parameters.iter().map(|parameter| parameter.type_id));
            for operation in &block.operations {
                roots.push(operation.type_id);
                if let Some(signature) = operation.signature {
                    signature_ids.insert(signature);
                }
                if let Some(store) = operation.static_store {
                    stores.insert(store);
                }
            }
        }
    }
    for function in &module.checked_functions {
        signature_ids.insert(function.signature.0);
        for continuation in &function.continuations {
            roots.extend(
                continuation
                    .parameters
                    .iter()
                    .chain(&continuation.captures)
                    .map(|definition| definition.type_id.0),
            );
            for instruction in &continuation.instructions {
                roots.push(instruction.definition.type_id.0);
                if let Some(signature) = instruction.operation.signature {
                    signature_ids.insert(signature.0);
                }
                if let Some(store) = instruction.operation.static_store {
                    stores.insert(store);
                }
            }
            if let Transition::Call { signature, .. } = &continuation.transition {
                signature_ids.insert(signature.0);
            }
        }
    }
    roots.extend(
        signature_ids
            .iter()
            .flat_map(|id| signature_roots(&module.signatures[*id])),
    );
    roots.extend(
        stores
            .iter()
            .map(|id| module.static_stores[*id].element_type),
    );
    let (types, originals) =
        type_graph(&module.types, &roots).ok_or(GraphCacheOutcome::LiveAuthority)?;
    let mut type_map = vec![0; module.types.len()];
    for (local, original) in originals.into_iter().enumerate() {
        type_map[original] = local;
    }
    let signature_map = signature_ids
        .iter()
        .enumerate()
        .map(|(local, original)| (*original, local))
        .collect::<HashMap<_, _>>();
    let store_map = stores
        .iter()
        .enumerate()
        .map(|(local, original)| (*original, local))
        .collect::<HashMap<_, _>>();
    let signatures = signature_ids
        .iter()
        .map(|id| RuntimeSignature {
            parameters: module.signatures[*id]
                .parameters
                .iter()
                .map(|id| type_map[*id])
                .collect(),
            result: type_map[module.signatures[*id].result],
            effects: module.signatures[*id].effects.clone(),
        })
        .collect();
    let static_stores = stores
        .iter()
        .map(|id| RuntimeStaticStore {
            element_type: type_map[module.static_stores[*id].element_type],
            values: module.static_stores[*id].values.clone(),
        })
        .collect();
    for function in &mut module.functions {
        function.signature = signature_map[&function.signature];
        for block in &mut function.blocks {
            for parameter in &mut block.parameters {
                parameter.type_id = type_map[parameter.type_id];
            }
            for operation in &mut block.operations {
                operation.type_id = type_map[operation.type_id];
                if let Some(signature) = &mut operation.signature {
                    *signature = signature_map[signature];
                }
                if let Some(store) = &mut operation.static_store {
                    *store = store_map[store];
                }
            }
        }
    }
    for function in &mut module.checked_functions {
        function.map_types(|id| TypeId(type_map[id.0]));
        function.map_signatures(|id| SignatureId(signature_map[&id.0]));
        for instruction in function
            .continuations
            .iter_mut()
            .flat_map(|continuation| &mut continuation.instructions)
        {
            if let Some(store) = &mut instruction.operation.static_store {
                *store = store_map[store];
            }
        }
    }
    for exported in &mut module.exports {
        if let super::RuntimeExport::Runtime { signature, .. } = exported {
            *signature = signature_map[signature];
        }
    }
    module.types = types;
    module.signatures = signatures;
    module.static_stores = static_stores;
    Ok(())
}

impl ResidualCache {
    pub(crate) fn begin_request(&mut self) {
        self.registry = None;
    }
    pub(crate) fn enabled(&self) -> bool {
        !self.disabled
    }
    pub(crate) fn disable(&mut self) {
        *self = Self {
            disabled: true,
            ..Self::default()
        };
    }
    pub(crate) fn take_pending(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .filter_map(|key| {
                self.entries.get(&key).map(|entry| {
                    rmp_serde::to_vec_named(&(SCHEMA, (key, entry)))
                        .expect("residual cache serialization")
                })
            })
            .collect()
    }
    pub(crate) fn import(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > RESIDENT_LIMIT {
            return Err("residual cache entry exceeds 64 MiB".to_owned());
        }
        crate::value_capsule::validate_snapshot_message_pack(bytes)?;
        let (version, (key, mut entry)): (u32, (Vec<u8>, Entry)) = rmp_serde::from_slice(bytes)
            .map_err(|error| format!("invalid residual cache entry: {error}"))?;
        if version != SCHEMA {
            return Err(format!("unsupported residual cache schema {version}"));
        }
        entry.validate()?;
        entry.bytes = bytes.len();
        if !self.disabled {
            self.insert(key, Rc::new(entry));
        }
        Ok(())
    }
    fn insert(&mut self, key: Vec<u8>, entry: Rc<Entry>) -> Rc<Vec<u8>> {
        let key = Rc::new(key);
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes -= previous.bytes;
        }
        self.order.retain(|existing| *existing != key);
        self.pending.retain(|existing| *existing != key);
        while self.bytes + entry.bytes > RESIDENT_LIMIT {
            let oldest = self
                .order
                .pop_front()
                .expect("nonempty bounded residual cache");
            if let Some(previous) = self.entries.remove(&oldest) {
                self.bytes -= previous.bytes;
            }
            self.pending.retain(|key| *key != oldest);
        }
        self.bytes += entry.bytes;
        self.order.push_back(key.clone());
        self.entries.insert(key.clone(), entry);
        key
    }
}

#[cfg(test)]
#[path = "residual_cache_tests.rs"]
mod tests;
