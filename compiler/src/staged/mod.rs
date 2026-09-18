//! Opt-in staged compiler laboratory. Compiled only by the separate research crate.
//!
//! This deliberately small pure fragment uses the existing Baba frontend and a
//! separate, explicitly experimental contract. Unsupported syntax is refused;
//! there is no fallback to the production evaluator or a second host checker.
mod check;
mod core;
mod static_eval;
#[cfg(test)]
mod tests;
mod types;
mod wasm;

use crate::ast::{Declaration, DeclarationKind, Expression, Pattern, Qualifier, Span};
use core::{Dependency, Global, Symbol, TermId, Terms, Value, Values};
use serde::Serialize;
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use types::{Type, TypeId, Types};

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Site {
    pub start: u32,
    pub end: u32,
}
impl From<Span> for Site {
    fn from(s: Span) -> Self {
        Self {
            start: s.start,
            end: s.end,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub enum FailureClass {
    Source,
    Limit,
    Unsupported,
    Invariant,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Failure {
    pub class: FailureClass,
    pub site: Site,
    pub message: String,
}
impl Failure {
    fn from_diagnostic(diagnostic: &crate::diagnostic::Diagnostic) -> Self {
        let class = match diagnostic.failure_class() {
            crate::diagnostic::FailureClass::Source => FailureClass::Source,
            crate::diagnostic::FailureClass::Limit => FailureClass::Limit,
            crate::diagnostic::FailureClass::TargetRefusal => FailureClass::Unsupported,
            crate::diagnostic::FailureClass::Invariant => FailureClass::Invariant,
        };
        Self {
            class,
            site: diagnostic.span.into(),
            message: format!("{}: {}", diagnostic.code, diagnostic.message),
        }
    }
    fn source(site: Site, message: impl Into<String>) -> Self {
        Self {
            class: FailureClass::Source,
            site,
            message: message.into(),
        }
    }
    fn unsupported(site: Site, message: impl Into<String>) -> Self {
        Self {
            class: FailureClass::Unsupported,
            site,
            message: message.into(),
        }
    }
    fn invariant(site: Site, message: impl Into<String>) -> Self {
        Self {
            class: FailureClass::Invariant,
            site,
            message: message.into(),
        }
    }
    fn limit(site: Site, message: impl Into<String>) -> Self {
        Self {
            class: FailureClass::Limit,
            site,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub source_units: usize,
    pub work: usize,
    pub depth: usize,
    pub retained_nodes: usize,
    pub retained_storage_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            source_units: 262_144,
            work: 2_000_000,
            depth: 128,
            retained_nodes: 500_000,
            retained_storage_bytes: 128 * 1024 * 1024,
        }
    }
}
#[derive(Clone)]
struct Budget {
    remaining: Rc<Cell<usize>>,
    max_depth: usize,
}
impl Budget {
    fn new(limits: &Limits) -> Self {
        Self {
            remaining: Rc::new(Cell::new(limits.work)),
            max_depth: limits.depth,
        }
    }
    fn tick(&self, site: Site) -> Result<(), Failure> {
        let n = self.remaining.get();
        if n == 0 {
            return Err(Failure::limit(site, "experimental work budget exhausted"));
        }
        self.remaining.set(n - 1);
        Ok(())
    }
    fn depth(&self, site: Site, depth: usize) -> Result<(), Failure> {
        if depth > self.max_depth {
            Err(Failure::limit(site, "experimental depth budget exhausted"))
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Work {
    pub parsed_expressions: usize,
    pub frontend_parser_executed: bool,
    pub frontend_reused_nodes: usize,
    pub frontend_storage_bytes: usize,
    pub checked_definitions: usize,
    pub reused_definitions: usize,
    pub unification_steps: usize,
    pub static_steps: usize,
    pub static_calls: usize,
    pub static_tail_calls: usize,
    pub static_obligations: usize,
    pub static_obligation_attempts: usize,
    pub resolved_static_obligations: usize,
    pub static_obligation_wakeups: usize,
    pub static_cache_hits: usize,
    pub fresh_identities: usize,
    pub emitted_functions: usize,
    pub reused_functions: usize,
    pub work_units: usize,
    pub retained_types: usize,
    pub retained_terms: usize,
    pub retained_values: usize,
    /// Charged interner/cache storage, not allocator capacity or process RSS.
    pub charged_storage_bytes: usize,
}
#[derive(Debug, Serialize)]
pub struct Artifact {
    #[serde(skip)]
    pub wasm: Vec<u8>,
    pub interfaces: BTreeMap<String, String>,
    pub work: Work,
    pub abi: &'static str,
}
#[derive(Clone)]
struct DefinitionCache {
    source: String,
    dependencies: Vec<Dependency>,
    global: Global,
}

/// A session owns immutable interners and dependency-validated definition/static
/// queries. Baba may reuse its own syntax state; semantic checks and emission
/// still observe every request. No frontend work is hidden in setup.
/// `reset` is an explicit retention boundary. Failed requests return no artifact.
#[derive(Default)]
pub struct PrototypeSession {
    types: Types,
    terms: Terms,
    values: Values,
    symbols: HashMap<(String, usize), Symbol>,
    definitions: HashMap<Symbol, DefinitionCache>,
    static_cache: HashMap<(core::ValueId, core::ValueId), static_eval::Memo>,
    fragments: HashMap<TermId, wasm::Fragment>,
    labels: BTreeMap<String, u32>,
    next_nominal: u64,
    next_code_local: u32,
    symbol_bytes: usize,
    limits: Limits,
    frontend: Option<crate::frontend::FrontendState>,
}
impl PrototypeSession {
    pub fn with_limits(limits: Limits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }
    pub fn reset(&mut self) {
        let limits = self.limits.clone();
        *self = Self::with_limits(limits);
    }
    fn symbol(&mut self, name: &str, occurrence: usize) -> Symbol {
        let next = self.symbols.len();
        if !self.symbols.contains_key(&(name.to_owned(), occurrence)) {
            self.symbol_bytes += name.len() + 64;
        }
        *self
            .symbols
            .entry((name.to_owned(), occurrence))
            .or_insert(next)
    }
    fn value_type(&mut self, id: usize, budget: &Budget, site: Site) -> Result<TypeId, Failure> {
        // Values use handles, so iterative visitation does not expand diamonds.
        let mut memo = HashMap::new();
        let mut pending = vec![(id, false)];
        while let Some((id, done)) = pending.pop() {
            budget.tick(site)?;
            if memo.contains_key(&id) {
                continue;
            }
            let children = match &self.values.nodes[id] {
                Value::Tuple(xs) | Value::Array(xs) => xs.clone(),
                Value::Variant(_, payload) => payload.iter().copied().collect(),
                Value::Record(fs) => fs.values().copied().collect(),
                _ => vec![],
            };
            if !done {
                pending.push((id, true));
                pending.extend(children.into_iter().map(|v| (v, false)));
                continue;
            }
            let ty = match &self.values.nodes[id] {
                Value::Int(_) => types::INT,
                Value::Bool(_) => types::BOOL,
                Value::Unit => types::UNIT,
                Value::Text(_) => types::TEXT,
                Value::Type(_) => types::UNIVERSE,
                Value::Code(_) => types::CODE,
                Value::Tuple(xs) => self
                    .types
                    .intern(Type::Tuple(xs.iter().map(|v| memo[v]).collect())),
                Value::Array(xs) => {
                    let children = xs.iter().map(|v| memo[v]).collect::<Vec<_>>();
                    let mut element = self.types.intern(Type::Bound(0, types::Kind::Value));
                    for (index, ty) in children.into_iter().enumerate() {
                        element = if index == 0 {
                            ty
                        } else {
                            self.join_value_types(element, ty, budget, site, 0)?
                        };
                    }
                    self.types.intern(Type::Array(element))
                }
                Value::Variant(name, payload) => {
                    let ty = self
                        .types
                        .intern(Type::Tuple(payload.iter().map(|v| memo[v]).collect()));
                    let row = self
                        .types
                        .intern(Type::Row(BTreeMap::from([(name.clone(), ty)]), None));
                    self.types.intern(Type::Variant(row))
                }
                Value::Record(fs) => {
                    let row = self.types.intern(Type::Row(
                        fs.iter().map(|(n, v)| (n.clone(), memo[v])).collect(),
                        None,
                    ));
                    self.types.intern(Type::Record(row))
                }
                Value::Closure { function, .. } => self.terms.nodes[*function].ty,
                Value::Primitive(..) => {
                    return Err(Failure::unsupported(
                        site,
                        "first-class static primitive result requires an explicit wrapper",
                    ));
                }
            };
            memo.insert(id, ty);
        }
        Ok(memo[&id])
    }

    // Static arrays retain a homogeneous type. Variant members join by label;
    // payload arities remain distinct and all common payloads are joined exactly.
    fn join_value_types(
        &mut self,
        a: TypeId,
        b: TypeId,
        budget: &Budget,
        site: Site,
        depth: usize,
    ) -> Result<TypeId, Failure> {
        budget.depth(site, depth)?;
        budget.tick(site)?;
        if a == b {
            return Ok(a);
        }
        let ty = match (self.types.nodes[a].clone(), self.types.nodes[b].clone()) {
            (Type::Bound(_, types::Kind::Value), _) => return Ok(b),
            (_, Type::Bound(_, types::Kind::Value)) => return Ok(a),
            (Type::Variant(ar), Type::Variant(br)) | (Type::Record(ar), Type::Record(br)) => {
                let is_variant = matches!(self.types.nodes[a], Type::Variant(_));
                let (Type::Row(mut af, None), Type::Row(bf, None)) =
                    (self.types.nodes[ar].clone(), self.types.nodes[br].clone())
                else {
                    return Err(Failure::source(site, "open static aggregate row"));
                };
                if !is_variant && af.keys().ne(bf.keys()) {
                    return Err(Failure::source(site, "static array record fields differ"));
                }
                for (name, b) in bf {
                    if let Some(a) = af.get(&name).copied() {
                        af.insert(name, self.join_value_types(a, b, budget, site, depth + 1)?);
                    } else {
                        af.insert(name, b);
                    }
                }
                let row = self.types.intern(Type::Row(af, None));
                if is_variant {
                    Type::Variant(row)
                } else {
                    Type::Record(row)
                }
            }
            (Type::Tuple(xs), Type::Tuple(ys)) if xs.len() == ys.len() => Type::Tuple(
                xs.into_iter()
                    .zip(ys)
                    .map(|(a, b)| self.join_value_types(a, b, budget, site, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            (Type::Array(a), Type::Array(b)) => {
                Type::Array(self.join_value_types(a, b, budget, site, depth + 1)?)
            }
            _ => {
                return Err(Failure::source(
                    site,
                    "incompatible static array element types",
                ));
            }
        };
        Ok(self.types.intern(ty))
    }

    fn charged_storage(&self) -> usize {
        self.frontend.as_ref().map_or(0, |f| f.observations().2)
            + self.types.storage_bytes
            + self.terms.storage_bytes
            + self.values.storage_bytes
            + self.symbol_bytes
            + self
                .definitions
                .values()
                .map(|d| d.source.len() + d.dependencies.len() * 96)
                .sum::<usize>()
            + self
                .static_cache
                .values()
                .map(|m| m.dependencies.len() * 96 + 64)
                .sum::<usize>()
            + self
                .fragments
                .values()
                .map(wasm::Fragment::storage_bytes)
                .sum::<usize>()
            + self.labels.keys().map(|n| n.len() + 32).sum::<usize>()
    }

    pub fn compile(&mut self, source: &str) -> Result<Artifact, Failure> {
        self.compile_observed(source, |_| {})
    }

    /// Optional host observations of completed phases, not semantic cache inputs.
    /// The library has no clock or ambient host authority of its own.
    pub fn compile_observed(
        &mut self,
        source: &str,
        mut completed_phase: impl FnMut(&'static str),
    ) -> Result<Artifact, Failure> {
        let units = source.encode_utf16().collect::<Vec<_>>();
        let site = Site {
            start: 0,
            end: units.len().min(u32::MAX as usize) as u32,
        };
        if units.len() > self.limits.source_units {
            return Err(Failure::limit(site, "experimental source-size limit"));
        }
        if self.charged_storage() > self.limits.retained_storage_bytes
            || self.types.nodes.len() + self.terms.nodes.len() + self.values.nodes.len()
                > self.limits.retained_nodes
        {
            return Err(Failure::limit(
                site,
                "experimental retained-node limit; reset the session",
            ));
        }
        let budget = Budget::new(&self.limits);
        let mut work = Work::default();
        let lowered = crate::source::lower_incremental(&units, self.frontend.as_ref(), None)
            .map_err(|error| match error {
                crate::source::SourceError::Diagnostics(ds) => {
                    ds.first().map(Failure::from_diagnostic).unwrap_or_else(|| {
                        Failure::invariant(site, "frontend failed without a diagnostic")
                    })
                }
                crate::source::SourceError::Lowering(message) => Failure::invariant(site, message),
            })?;
        let module = lowered.module;
        work.frontend_parser_executed = lowered.frontend.observations().0;
        work.frontend_reused_nodes = lowered.frontend.observations().1;
        work.frontend_storage_bytes = lowered.frontend.observations().2;
        completed_phase("frontend");
        work.parsed_expressions = module.arena.expressions.len();
        if module.parameter.is_some() {
            return Err(Failure::unsupported(
                module.span.into(),
                "prototype modules have no implicit parameter",
            ));
        }
        let mut names = BTreeMap::new();
        let mut globals = BTreeMap::new();
        let mut signatures = BTreeMap::new();
        let mut occurrences = HashMap::<String, usize>::new();
        let mut live = std::collections::HashSet::new();
        for declaration in &module.declarations {
            budget.tick(site)?;
            match &module.arena.declarations[declaration.0 as usize] {
                Declaration::Signature {
                    kind,
                    recursive: _,
                    name,
                    value,
                    span,
                } => {
                    if *kind == DeclarationKind::Effect {
                        return Err(Failure::unsupported(
                            (*span).into(),
                            "recursive/effect signatures are not in the prototype fragment",
                        ));
                    }
                    if signatures.insert(name.clone(), (*value, *span)).is_some() {
                        return Err(Failure::source(
                            (*span).into(),
                            "duplicate signature without a binding",
                        ));
                    }
                }
                Declaration::Binding {
                    kind,
                    tags,
                    pattern,
                    value,
                    span,
                } => {
                    if *kind == DeclarationKind::Effect || !tags.is_empty() {
                        return Err(Failure::unsupported(
                            (*span).into(),
                            "effects and declaration tags require the production compiler",
                        ));
                    }
                    let Pattern::Name {
                        name,
                        qualifier: Qualifier::None,
                        ..
                    } = &module.arena.patterns[pattern.0 as usize]
                    else {
                        return Err(Failure::unsupported(
                            (*span).into(),
                            "prototype top-level bindings require an unqualified name",
                        ));
                    };
                    let n = occurrences.entry(name.clone()).or_default();
                    let symbol = self.symbol(name, *n);
                    *n += 1;
                    live.insert(symbol);
                    let annotation = signatures.remove(name);
                    let start = annotation.map(|(_, s)| s.start).unwrap_or(span.start) as usize;
                    let text = format!(
                        "{}\0{}",
                        String::from_utf16_lossy(&units[..module.span.start as usize]),
                        String::from_utf16_lossy(&units[start..span.end as usize])
                    );
                    let cached = self
                        .definitions
                        .get(&symbol)
                        .filter(|c| {
                            c.source == text
                                && c.dependencies.iter().all(|d| d.valid(&names, &globals))
                        })
                        .cloned();
                    let global = if let Some(cached) = cached {
                        work.reused_definitions += 1;
                        cached.global
                    } else {
                        work.checked_definitions += 1;
                        let (global, deps) = check::definition(
                            self,
                            check::Input {
                                module: &module,
                                names: &names,
                                globals: &globals,
                                expression: *value,
                                annotation: annotation.map(|(e, _)| e),
                                binding_name: Some(name),
                            },
                            &budget,
                            &mut work,
                        )?;
                        self.definitions.insert(
                            symbol,
                            DefinitionCache {
                                source: text,
                                dependencies: deps,
                                global: global.clone(),
                            },
                        );
                        global
                    };
                    globals.insert(symbol, global);
                    names.insert(name.clone(), symbol);
                }
                _ => {
                    return Err(Failure::unsupported(
                        site,
                        "open/rebinding declarations are outside this experimental fragment",
                    ));
                }
            }
        }
        if let Some((_, (_, span))) = signatures.first_key_value() {
            return Err(Failure::source((*span).into(), "signature has no binding"));
        }
        let Expression::Shape { members, .. } = &module.arena.expressions[module.result.0 as usize]
        else {
            return Err(Failure::unsupported(
                module.arena.expression_span(module.result).into(),
                "prototype module result must be an export record",
            ));
        };
        let mut exports = BTreeMap::new();
        for member in members {
            let crate::ast::ShapeMember::Field { name, value } = member else {
                return Err(Failure::unsupported(
                    site,
                    "export spreads/computed names are not supported",
                ));
            };
            if exports.contains_key(name) {
                return Err(Failure::source(site, "duplicate export"));
            }
            let (global, _) = check::definition(
                self,
                check::Input {
                    module: &module,
                    names: &names,
                    globals: &globals,
                    expression: *value,
                    annotation: None,
                    binding_name: None,
                },
                &budget,
                &mut work,
            )?;
            exports.insert(name.clone(), global);
        }
        let interfaces = names
            .iter()
            .map(|(n, s)| (n.clone(), self.types.display(globals[s].ty)))
            .collect();
        completed_phase("checking-and-staging");
        let wasm = wasm::emit(self, &globals, &exports, &budget, &mut work, site)?;
        completed_phase("lowering-emission-validation");
        self.definitions.retain(|s, _| live.contains(s));
        // Cache entries retain handles, never entire mutable evaluator scopes.
        if self.static_cache.len() > 1024 {
            self.static_cache.clear();
        }
        work.work_units = self.limits.work - budget.remaining.get();
        work.retained_types = self.types.nodes.len();
        work.retained_terms = self.terms.nodes.len();
        work.retained_values = self.values.nodes.len();
        work.charged_storage_bytes = self.charged_storage()
            - self.frontend.as_ref().map_or(0, |f| f.observations().2)
            + work.frontend_storage_bytes;
        if work.charged_storage_bytes > self.limits.retained_storage_bytes
            || work.retained_types + work.retained_terms + work.retained_values
                > self.limits.retained_nodes
        {
            return Err(Failure::limit(
                site,
                "experimental retained-node limit; reset the session",
            ));
        }
        // Only replace the last successful syntax snapshot after the full request
        // and retained-storage check succeed. A failed edit supplies no authority.
        self.frontend = Some(lowered.frontend);
        completed_phase("retention-accounting");
        Ok(Artifact {
            wasm,
            interfaces,
            work,
            abi: "blot-staged-lab-v1 (not the production Blot ABI)",
        })
    }
}
