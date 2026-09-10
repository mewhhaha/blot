use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use serde::Serialize;

use crate::backend::CompiledModule;
use crate::continuation::{
    CallTarget, Function as RuntimeFunction, FunctionId, Graph, SignatureId, Transition, TypeId,
};
use crate::hir::{RuntimeExport, RuntimeLink, RuntimeModule, RuntimeType};

#[cfg(test)]
thread_local! {
    static MODULE_IDENTITY_COMPUTATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Clone)]
pub(crate) struct DevelopmentUnit {
    pub(crate) name: String,
    pub(crate) root: String,
    pub(crate) module: Option<RuntimeModule>,
    pub(crate) source_paths: HashSet<String>,
    pub(crate) partition: DevelopmentUnitPartition,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct DevelopmentUnitPartition {
    function_ids: Vec<FunctionId>,
    boundary_links: Vec<(LinkDemand, String)>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevelopmentUnitEdge {
    pub(crate) consumer: String,
    pub(crate) provider: String,
    pub(crate) name: String,
}

pub(crate) struct DevelopmentProgram {
    pub(crate) entry_unit: String,
    pub(crate) units: Vec<DevelopmentUnit>,
    pub(crate) edges: Vec<DevelopmentUnitEdge>,
}

pub(crate) struct DevelopmentCompilationUnit {
    pub(crate) name: String,
    pub(crate) root: String,
    pub(crate) artifact: DevelopmentUnitArtifact,
    pub(crate) implementation_key: String,
}

pub(crate) struct CompiledDevelopmentProgram {
    pub(crate) transaction_id: u32,
    pub(crate) entry_unit: String,
    pub(crate) units: Vec<DevelopmentCompilationUnit>,
    pub(crate) edges: Vec<DevelopmentUnitEdge>,
    pub(crate) work: DevelopmentWork,
    #[cfg(feature = "development-profile")]
    pub(crate) memory_profile: DevelopmentMemoryProfile,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevelopmentWork {
    pub(crate) specialized_functions: BTreeMap<String, usize>,
    pub(crate) reused_functions: BTreeMap<String, usize>,
    pub(crate) emitted_units: usize,
    pub(crate) graph_cache: BTreeMap<crate::hir::residual_cache::GraphCacheOutcome, usize>,
}

#[cfg(feature = "development-profile")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevelopmentMemoryCheckpoint {
    stage: String,
    pages: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    solver: Option<DevelopmentSolverCardinality>,
}

#[cfg(feature = "development-profile")]
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevelopmentSolverCardinality {
    pub(crate) variables: usize,
    pub(crate) constraint_type_nodes: usize,
    pub(crate) constraint_type_interned: usize,
    pub(crate) settled_variables: usize,
    pub(crate) residual_variables: usize,
}

#[cfg(feature = "development-profile")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevelopmentMemoryProfile {
    checkpoints: Vec<DevelopmentMemoryCheckpoint>,
}

#[cfg(feature = "development-profile")]
impl DevelopmentMemoryProfile {
    pub(crate) fn start() -> Self {
        let mut profile = Self {
            checkpoints: Vec::new(),
        };
        profile.checkpoint("start");
        profile
    }

    pub(crate) fn checkpoint(&mut self, stage: impl Into<String>) {
        self.checkpoints.push(DevelopmentMemoryCheckpoint {
            stage: stage.into(),
            pages: compiler_memory_pages(),
            solver: None,
        });
    }

    pub(crate) fn checkpoint_solver(
        &mut self,
        stage: impl Into<String>,
        solver: DevelopmentSolverCardinality,
    ) {
        self.checkpoints.push(DevelopmentMemoryCheckpoint {
            stage: stage.into(),
            pages: compiler_memory_pages(),
            solver: Some(solver),
        });
    }
}

#[cfg(all(feature = "development-profile", target_arch = "wasm32"))]
fn compiler_memory_pages() -> usize {
    core::arch::wasm32::memory_size(0)
}

#[cfg(all(feature = "development-profile", not(target_arch = "wasm32")))]
fn compiler_memory_pages() -> usize {
    0
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct DevelopmentModuleIdentity {
    implementation_key: String,
    canonical_runtime_module: Vec<u8>,
}

impl DevelopmentModuleIdentity {
    pub(crate) fn implementation_key(&self) -> &str {
        &self.implementation_key
    }
}

pub(crate) enum DevelopmentUnitArtifact {
    Compiled(Rc<CompiledModule>),
    Reused { capabilities: Vec<String> },
}

impl DevelopmentUnitArtifact {
    pub(crate) fn artifact_source(&self) -> &'static str {
        match self {
            Self::Compiled(_) => "compiled",
            Self::Reused { .. } => "unit-cache",
        }
    }

    pub(crate) fn capabilities(&self) -> &[String] {
        match self {
            Self::Compiled(compiled) => &compiled.capabilities,
            Self::Reused { capabilities } => capabilities,
        }
    }

    pub(crate) fn compiled(&self) -> Option<&CompiledModule> {
        match self {
            Self::Compiled(compiled) => Some(compiled),
            Self::Reused { .. } => None,
        }
    }
}

pub(crate) struct CachedDevelopmentArtifact {
    identity: DevelopmentModuleIdentity,
    compiled: Rc<CompiledModule>,
    source_paths: HashSet<String>,
    partition: DevelopmentUnitPartition,
}

impl CachedDevelopmentArtifact {
    pub(crate) fn new(
        identity: DevelopmentModuleIdentity,
        compiled: Rc<CompiledModule>,
        source_paths: HashSet<String>,
        partition: DevelopmentUnitPartition,
    ) -> Self {
        Self {
            identity,
            compiled,
            source_paths,
            partition,
        }
    }

    pub(crate) fn reuse(
        &self,
        identity: &DevelopmentModuleIdentity,
    ) -> Option<DevelopmentUnitArtifact> {
        if self.identity != *identity {
            return None;
        }
        Some(DevelopmentUnitArtifact::Reused {
            capabilities: self.compiled.capabilities.clone(),
        })
    }

    pub(crate) fn reusable_partition(
        &self,
        changed_paths: &HashSet<String>,
    ) -> Option<DevelopmentUnitPartition> {
        changed_paths
            .is_disjoint(&self.source_paths)
            .then(|| self.partition.clone())
    }

    pub(crate) fn reuse_unaffected(&self) -> (DevelopmentUnitArtifact, String) {
        (
            DevelopmentUnitArtifact::Reused {
                capabilities: self.compiled.capabilities.clone(),
            },
            self.identity.implementation_key.clone(),
        )
    }
}

pub(crate) fn development_module_identity(
    module: &RuntimeModule,
) -> Result<DevelopmentModuleIdentity, String> {
    #[cfg(test)]
    MODULE_IDENTITY_COMPUTATIONS.with(|computations| computations.set(computations.get() + 1));
    let canonical_runtime_module = serde_json::to_vec(module).map_err(|error| {
        format!(
            "{}: could not encode development implementation identity: {error}",
            module.source
        )
    })?;
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in &canonical_runtime_module {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(DevelopmentModuleIdentity {
        implementation_key: format!("{hash:016x}"),
        canonical_runtime_module,
    })
}

#[cfg(test)]
pub(crate) fn reset_module_identity_computations() {
    MODULE_IDENTITY_COMPUTATIONS.with(|computations| computations.set(0));
}

#[cfg(test)]
pub(crate) fn module_identity_computations() -> usize {
    MODULE_IDENTITY_COMPUTATIONS.with(std::cell::Cell::get)
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct LinkDemand {
    consumer: String,
    provider: String,
    function: FunctionId,
}

pub(crate) fn split_runtime_module(
    module: &RuntimeModule,
    entry_unit: &str,
    configured_units: &BTreeMap<String, String>,
    reusable_partitions: &HashMap<String, DevelopmentUnitPartition>,
) -> Result<DevelopmentProgram, String> {
    let entry_root = configured_units
        .get(entry_unit)
        .ok_or_else(|| format!("development entry unit {entry_unit:?} has no configured root"))?;
    if entry_root != &module.source {
        return Err(format!(
            "development entry unit {entry_unit:?} names {entry_root:?}, but Runtime HIR belongs to {:?}",
            module.source
        ));
    }
    let mut unit_by_root = HashMap::new();
    for (name, root) in configured_units {
        if let Some(previous) = unit_by_root.insert(root.clone(), name.clone()) {
            return Err(format!(
                "development units {previous:?} and {name:?} repeat root {root:?}"
            ));
        }
    }

    let functions = module
        .functions
        .iter()
        .map(|function| (function.id, function))
        .collect::<HashMap<_, _>>();
    let mut included = BTreeMap::<String, BTreeSet<FunctionId>>::new();
    let mut demands = BTreeSet::new();
    let mut pending = module
        .exports
        .iter()
        .filter_map(|exported| match exported {
            RuntimeExport::Runtime { function, .. } => {
                Some((entry_unit.to_owned(), FunctionId(*function)))
            }
            RuntimeExport::Comptime { .. } => None,
        })
        .collect::<Vec<_>>();

    while let Some((unit, function_id)) = pending.pop() {
        if !included
            .entry(unit.clone())
            .or_default()
            .insert(function_id)
        {
            continue;
        }
        let function = functions.get(&function_id).ok_or_else(|| {
            format!(
                "{}: development unit {unit:?} references absent function {function_id}",
                module.source
            )
        })?;
        let signature = &module.signatures[function.signature.0];
        let mut pending_types = signature.parameters.clone();
        pending_types.push(signature.result);
        for continuation in &function.continuations {
            pending_types.extend(
                continuation
                    .parameters
                    .iter()
                    .chain(&continuation.captures)
                    .map(|definition| definition.type_id.0),
            );
            pending_types.extend(
                continuation
                    .instructions
                    .iter()
                    .map(|instruction| instruction.definition.type_id.0),
            );
            if let Transition::Call { signature, .. } = &continuation.transition {
                let signature = &module.signatures[signature.0];
                pending_types.extend(&signature.parameters);
                pending_types.push(signature.result);
            }
        }
        let mut visited_types = HashSet::new();
        while let Some(type_id) = pending_types.pop() {
            if !visited_types.insert(type_id) {
                continue;
            }
            match &module.types[type_id] {
                crate::hir::RuntimeType::Callback {
                    function: target,
                    signature,
                    environment_type,
                } => {
                    pending.push((unit.clone(), FunctionId(*target)));
                    pending_types.push(*environment_type);
                    let signature = &module.signatures[*signature];
                    pending_types.extend(&signature.parameters);
                    pending_types.push(signature.result);
                }
                crate::hir::RuntimeType::Product { fields, .. } => {
                    pending_types.extend(fields.iter().map(|field| field.type_id))
                }
                crate::hir::RuntimeType::Sum { cases, .. } => {
                    pending_types.extend(cases.iter().map(|case_| case_.payload_type))
                }
                crate::hir::RuntimeType::Store { element_type }
                | crate::hir::RuntimeType::Scratch { element_type } => {
                    pending_types.push(*element_type)
                }
                crate::hir::RuntimeType::Resource { payload_type, .. } => {
                    pending_types.push(*payload_type)
                }
                crate::hir::RuntimeType::Sealed {
                    representation_type,
                    ..
                } => pending_types.push(*representation_type),
                crate::hir::RuntimeType::Indirect { target_type } => {
                    pending_types.push(*target_type)
                }
                _ => {}
            }
        }
        for continuation in &function.continuations {
            for instruction in &continuation.instructions {
                let operation = &instruction.operation;
                let Some(target) = operation.function else {
                    continue;
                };
                let target_function = functions.get(&target).ok_or_else(|| {
                    format!(
                        "{}: development unit {unit:?} references absent function {target}",
                        module.source
                    )
                })?;
                let target_unit = unit_by_root.get(&target_function.span.file);
                if operation.kind == "closure.make"
                    && target_unit.is_some_and(|target_unit| target_unit != &unit)
                {
                    return Err(format!(
                        "development unit {unit:?} exposes closure function {target} from unit {:?}; functions may be called through a reload boundary but cannot cross it as values",
                        target_unit.expect("checked target unit")
                    ));
                }
                pending.push((unit.clone(), target));
            }
            let Transition::Call {
                target: CallTarget::Function { function: target },
                ..
            } = &continuation.transition
            else {
                continue;
            };
            let target_function = functions.get(target).ok_or_else(|| {
                format!(
                    "{}: development unit {unit:?} references absent function {target}",
                    module.source
                )
            })?;
            let target_unit = unit_by_root.get(&target_function.span.file);
            if let Some(provider) = target_unit.filter(|provider| *provider != &unit) {
                demands.insert(LinkDemand {
                    consumer: unit.clone(),
                    provider: provider.clone(),
                    function: *target,
                });
                pending.push((provider.clone(), *target));
                continue;
            }
            pending.push((unit.clone(), *target));
        }
    }

    for name in configured_units.keys() {
        included.entry(name.clone()).or_default();
    }
    let link_names = demands
        .iter()
        .map(|demand| {
            let function = functions.get(&demand.function).ok_or_else(|| {
                format!(
                    "{}: development link references absent function {}",
                    module.source, demand.function
                )
            })?;
            Ok((
                demand.clone(),
                development_export_name(module, &demand.provider, function)?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;

    let mut units = Vec::with_capacity(configured_units.len());
    for (name, root) in configured_units {
        let function_ids = included
            .get(name)
            .ok_or_else(|| format!("development unit {name:?} lost its function set"))?;
        let source_paths = std::iter::once(root.clone())
            .chain(function_ids.iter().map(|function_id| {
                functions
                    .get(function_id)
                    .expect("included development function disappeared")
                    .span
                    .file
                    .clone()
            }))
            .collect();
        let partition = DevelopmentUnitPartition {
            function_ids: function_ids.iter().copied().collect(),
            boundary_links: demands
                .iter()
                .filter(|demand| demand.consumer == *name || demand.provider == *name)
                .map(|demand| (demand.clone(), link_names[demand].clone()))
                .collect(),
        };
        let unit_module = if reusable_partitions.get(name) == Some(&partition) {
            None
        } else {
            Some(build_unit_module(
                module,
                name,
                root,
                entry_unit,
                function_ids,
                &unit_by_root,
                &demands,
                &link_names,
            )?)
        };
        units.push(DevelopmentUnit {
            name: name.clone(),
            root: root.clone(),
            module: unit_module,
            source_paths,
            partition,
        });
    }
    let edges = demands
        .iter()
        .map(|demand| DevelopmentUnitEdge {
            consumer: demand.consumer.clone(),
            provider: demand.provider.clone(),
            name: link_names[demand].clone(),
        })
        .collect();
    Ok(DevelopmentProgram {
        entry_unit: entry_unit.to_owned(),
        units,
        edges,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_unit_module(
    module: &RuntimeModule,
    unit: &str,
    root: &str,
    entry_unit: &str,
    function_ids: &BTreeSet<FunctionId>,
    unit_by_root: &HashMap<String, String>,
    demands: &BTreeSet<LinkDemand>,
    link_names: &BTreeMap<LinkDemand, String>,
) -> Result<RuntimeModule, String> {
    let functions_by_id = module
        .functions
        .iter()
        .map(|function| (function.id, function))
        .collect::<HashMap<_, _>>();
    let function_map = function_ids
        .iter()
        .enumerate()
        .map(|(next, previous)| (*previous, FunctionId(next)))
        .collect::<HashMap<_, _>>();
    let mut links = Vec::<RuntimeLink>::new();
    let mut linked_imports = HashSet::<(String, String)>::new();
    let mut functions = Vec::with_capacity(function_ids.len());
    for previous_id in function_ids {
        let previous = functions_by_id.get(previous_id).ok_or_else(|| {
            format!(
                "{}: development unit {unit:?} lost function {previous_id}",
                module.source
            )
        })?;
        let mut function = (*previous).clone();
        function.id = function_map[previous_id];
        rewrite_function(
            module,
            unit,
            &mut function,
            &functions_by_id,
            &function_map,
            unit_by_root,
            link_names,
            &mut links,
            &mut linked_imports,
        )?;
        functions.push(function);
    }

    let mut exports = Vec::new();
    if unit == entry_unit {
        for exported in &module.exports {
            let mut exported = exported.clone();
            if let RuntimeExport::Runtime { function, .. } = &mut exported {
                *function = function_map
                    .get(&FunctionId(*function))
                    .ok_or_else(|| {
                        format!(
                            "{}: entry unit {unit:?} omitted exported function {function}",
                            module.source
                        )
                    })?
                    .0;
            }
            exports.push(exported);
        }
    }
    let mut exported_targets = BTreeSet::new();
    for demand in demands.iter().filter(|demand| demand.provider == unit) {
        if !exported_targets.insert(demand.function) {
            continue;
        }
        let target = functions_by_id.get(&demand.function).ok_or_else(|| {
            format!(
                "{}: development export lost function {}",
                module.source, demand.function
            )
        })?;
        let mut wrapper = (*target).clone();
        wrapper.id = FunctionId(functions.len());
        rewrite_function(
            module,
            unit,
            &mut wrapper,
            &functions_by_id,
            &function_map,
            unit_by_root,
            link_names,
            &mut links,
            &mut linked_imports,
        )?;
        let exported_function = wrapper.id;
        functions.push(wrapper);
        let link_name = link_names[demand].clone();
        exports.push(RuntimeExport::Runtime {
            source_name: format!("$development${link_name}"),
            phase: "runtime",
            wasm_name: format!("blot:dev:{link_name}"),
            function: exported_function.0,
            signature: target.signature.0,
            ownership: "owned",
        });
    }

    let mut unit_module = RuntimeModule {
        format: "blot-runtime-hir",
        schema_version: module.schema_version,
        source: root.to_owned(),
        types: module.types.clone(),
        signatures: module.signatures.clone(),
        static_stores: module.static_stores.clone(),
        graph: Graph { functions },
        capabilities: module.capabilities.clone(),
        links,
        exports,
    };
    for type_ in &mut unit_module.types {
        if let crate::hir::RuntimeType::Callback { function, .. } = type_
            && let Some(mapped) = function_map.get(&FunctionId(*function))
        {
            *function = mapped.0;
        }
    }
    normalize_unit_module(&mut unit_module)?;
    unit_module.graph.validate(unit_module.tables())?;
    Ok(unit_module)
}

fn canonicalize_unit_functions(module: &mut RuntimeModule) {
    module.exports.sort_by(|left, right| {
        let name = |export: &RuntimeExport| match export {
            RuntimeExport::Runtime { source_name, .. }
            | RuntimeExport::Comptime { source_name, .. } => source_name.clone(),
        };
        name(left).cmp(&name(right))
    });
    let mut pending = module
        .exports
        .iter()
        .filter_map(|export| match export {
            RuntimeExport::Runtime { function, .. } => Some(FunctionId(*function)),
            RuntimeExport::Comptime { .. } => None,
        })
        .collect::<std::collections::VecDeque<_>>();
    let mut order = Vec::new();
    let mut visited = HashSet::new();
    let mut visited_types = HashSet::new();
    while let Some(function_id) = pending.pop_front() {
        if !visited.insert(function_id) {
            continue;
        }
        order.push(function_id);
        let function = &module.functions[function_id.0];
        let signature = &module.signatures[function.signature.0];
        let mut types = signature
            .parameters
            .iter()
            .copied()
            .chain([signature.result])
            .collect::<std::collections::VecDeque<_>>();
        for continuation in &function.continuations {
            types.extend(
                continuation
                    .parameters
                    .iter()
                    .chain(&continuation.captures)
                    .map(|definition| definition.type_id.0),
            );
            for instruction in &continuation.instructions {
                types.push_back(instruction.definition.type_id.0);
                if let Some(target) = instruction.operation.function {
                    pending.push_back(target);
                }
            }
            if let Transition::Call {
                target, signature, ..
            } = &continuation.transition
            {
                if let CallTarget::Function { function } = target {
                    pending.push_back(*function);
                }
                let signature = &module.signatures[signature.0];
                types.extend(&signature.parameters);
                types.push_back(signature.result);
            }
        }
        while let Some(type_id) = types.pop_front() {
            if !visited_types.insert(type_id) {
                continue;
            }
            match &module.types[type_id] {
                RuntimeType::Callback {
                    function,
                    signature,
                    environment_type,
                } => {
                    pending.push_back(FunctionId(*function));
                    types.push_back(*environment_type);
                    let signature = &module.signatures[*signature];
                    types.extend(&signature.parameters);
                    types.push_back(signature.result);
                }
                RuntimeType::Product { fields, .. } => {
                    types.extend(fields.iter().map(|field| field.type_id))
                }
                RuntimeType::Sum { cases, .. } => {
                    types.extend(cases.iter().map(|case_| case_.payload_type))
                }
                RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } => {
                    types.push_back(*element_type)
                }
                RuntimeType::Resource { payload_type, .. } => types.push_back(*payload_type),
                RuntimeType::Indirect { target_type } => types.push_back(*target_type),
                RuntimeType::Sealed {
                    representation_type,
                    ..
                } => types.push_back(*representation_type),
                _ => {}
            }
        }
    }
    let functions = order
        .iter()
        .enumerate()
        .map(|(next, previous)| (*previous, FunctionId(next)))
        .collect::<HashMap<_, _>>();
    module.graph.functions = order
        .iter()
        .map(|previous| {
            let mut function = module.functions[previous.0].clone();
            function.map_functions(|function| functions[&function]);
            function
        })
        .collect();
    for type_ in &mut module.types {
        if let RuntimeType::Callback { function, .. } = type_
            && let Some(mapped) = functions.get(&FunctionId(*function))
        {
            *function = mapped.0;
        }
    }
    for export in &mut module.exports {
        if let RuntimeExport::Runtime { function, .. } = export {
            *function = functions[&FunctionId(*function)].0;
        }
    }
}

fn normalize_unit_module(module: &mut RuntimeModule) -> Result<(), String> {
    canonicalize_unit_functions(module);
    retain_referenced_static_stores(module)?;
    let mut signature_ids = BTreeSet::new();
    let mut host_operations = BTreeSet::new();
    for function in &module.functions {
        signature_ids.insert(function.signature.0);
        for instruction in function
            .continuations
            .iter()
            .flat_map(|continuation| &continuation.instructions)
        {
            let operation = &instruction.operation;
            if let Some(signature) = operation.signature {
                signature_ids.insert(signature.0);
            }
            if operation.kind == "callback.make" {
                let crate::hir::RuntimeType::Callback { signature, .. } =
                    &module.types[instruction.definition.type_id.0]
                else {
                    return Err("development callback has no checked callback type".to_owned());
                };
                signature_ids.insert(*signature);
            }
        }
    }
    for continuation in module
        .functions
        .iter()
        .flat_map(|function| &function.continuations)
    {
        if let Transition::Call {
            target, signature, ..
        } = &continuation.transition
        {
            signature_ids.insert(signature.0);
            if let CallTarget::Host {
                capability,
                operation,
            } = target
            {
                host_operations.insert((capability.clone(), operation.clone()));
            }
        }
    }
    signature_ids.extend(module.links.iter().map(|link| link.signature));
    signature_ids.extend(module.exports.iter().filter_map(|exported| match exported {
        RuntimeExport::Runtime { signature, .. } => Some(*signature),
        RuntimeExport::Comptime { .. } => None,
    }));

    for (capability, operation) in &host_operations {
        let declared = module
            .capabilities
            .iter()
            .find(|candidate| candidate.name == *capability)
            .and_then(|capability| {
                capability
                    .operations
                    .iter()
                    .find(|candidate| candidate.name == *operation)
            })
            .ok_or_else(|| {
                format!(
                    "{}: development host call {capability}.{operation} has no declaration",
                    module.source
                )
            })?;
        signature_ids.insert(declared.signature);
    }

    let mut required_capabilities = signature_ids
        .iter()
        .flat_map(|signature| {
            module
                .signatures
                .get(*signature)
                .into_iter()
                .flat_map(|signature| signature.effects.iter().cloned())
        })
        .collect::<BTreeSet<_>>();
    required_capabilities.extend(
        host_operations
            .iter()
            .map(|(capability, _)| capability.clone()),
    );
    module
        .capabilities
        .retain(|capability| required_capabilities.contains(&capability.name));
    for capability in &mut module.capabilities {
        capability.operations.retain(|operation| {
            host_operations.contains(&(capability.name.clone(), operation.name.clone()))
        });
    }

    let mut type_ids = BTreeSet::from([0]);
    type_ids.extend(module.static_stores.iter().map(|store| store.element_type));
    for function in &module.functions {
        for continuation in &function.continuations {
            type_ids.extend(
                continuation
                    .parameters
                    .iter()
                    .chain(&continuation.captures)
                    .map(|definition| definition.type_id.0),
            );
            type_ids.extend(
                continuation
                    .instructions
                    .iter()
                    .map(|instruction| instruction.definition.type_id.0),
            );
        }
    }
    for signature in &signature_ids {
        let signature = module.signatures.get(*signature).ok_or_else(|| {
            format!(
                "{}: development unit references absent signature {signature}",
                module.source
            )
        })?;
        type_ids.extend(signature.parameters.iter().copied());
        type_ids.insert(signature.result);
    }
    let mut pending = type_ids.iter().copied().collect::<Vec<_>>();
    while let Some(type_id) = pending.pop() {
        let type_ = module.types.get(type_id).ok_or_else(|| {
            format!(
                "{}: development unit references absent type {type_id}",
                module.source
            )
        })?;
        let dependencies = match type_ {
            crate::hir::RuntimeType::Callback {
                signature,
                environment_type,
                ..
            } => {
                signature_ids.insert(*signature);
                let signature = &module.signatures[*signature];
                let mut dependencies = signature.parameters.clone();
                dependencies.extend([signature.result, *environment_type]);
                dependencies
            }
            crate::hir::RuntimeType::Store { element_type }
            | crate::hir::RuntimeType::Scratch { element_type }
            | crate::hir::RuntimeType::Resource {
                payload_type: element_type,
                ..
            } => vec![*element_type],
            crate::hir::RuntimeType::Indirect { target_type } => vec![*target_type],
            crate::hir::RuntimeType::Product { fields, .. } => {
                fields.iter().map(|field| field.type_id).collect()
            }
            crate::hir::RuntimeType::Sum { cases, .. } => {
                cases.iter().map(|case_| case_.payload_type).collect()
            }
            crate::hir::RuntimeType::Sealed {
                representation_type,
                ..
            } => vec![*representation_type],
            _ => Vec::new(),
        };
        for dependency in dependencies {
            if type_ids.insert(dependency) {
                pending.push(dependency);
            }
        }
    }

    let type_map = type_ids
        .iter()
        .enumerate()
        .map(|(next, previous)| (*previous, next))
        .collect::<HashMap<_, _>>();
    let signature_map = signature_ids
        .iter()
        .enumerate()
        .map(|(next, previous)| (*previous, next))
        .collect::<HashMap<_, _>>();
    let mut types = type_ids
        .iter()
        .map(|type_id| module.types[*type_id].clone())
        .collect::<Vec<_>>();
    for (type_id, type_) in types.iter_mut().enumerate() {
        match type_ {
            crate::hir::RuntimeType::Callback {
                signature,
                environment_type,
                ..
            } => {
                *signature = signature_map[signature];
                *environment_type = type_map[environment_type];
            }
            crate::hir::RuntimeType::Store { element_type }
            | crate::hir::RuntimeType::Scratch { element_type }
            | crate::hir::RuntimeType::Resource {
                payload_type: element_type,
                ..
            } => {
                *element_type = type_map[element_type];
            }
            crate::hir::RuntimeType::Indirect { target_type } => {
                *target_type = type_map[target_type];
            }
            crate::hir::RuntimeType::Product { name, fields } => {
                *name = format!("$development${type_id}");
                for field in fields {
                    field.type_id = type_map[&field.type_id];
                }
            }
            crate::hir::RuntimeType::Sum { name, cases } => {
                *name = format!("$development${type_id}");
                for case_ in cases {
                    case_.payload_type = type_map[&case_.payload_type];
                }
            }
            crate::hir::RuntimeType::Sealed {
                representation_type,
                ..
            } => {
                *representation_type = type_map[representation_type];
            }
            _ => {}
        }
    }
    let mut signatures = signature_ids
        .iter()
        .map(|signature| module.signatures[*signature].clone())
        .collect::<Vec<_>>();
    for signature in &mut signatures {
        for parameter in &mut signature.parameters {
            *parameter = type_map[parameter];
        }
        signature.result = type_map[&signature.result];
    }
    for function in &mut module.graph.functions {
        function.signature = SignatureId(signature_map[&function.signature.0]);
        for continuation in &mut function.continuations {
            for definition in continuation
                .parameters
                .iter_mut()
                .chain(&mut continuation.captures)
            {
                definition.type_id = TypeId(type_map[&definition.type_id.0]);
            }
            for instruction in &mut continuation.instructions {
                instruction.definition.type_id =
                    TypeId(type_map[&instruction.definition.type_id.0]);
                if let Some(signature) = &mut instruction.operation.signature {
                    *signature = SignatureId(signature_map[&signature.0]);
                }
            }
            if let Transition::Call { signature, .. } = &mut continuation.transition {
                *signature = SignatureId(signature_map[&signature.0]);
            }
        }
    }
    for store in &mut module.static_stores {
        store.element_type = type_map[&store.element_type];
    }
    for capability in &mut module.capabilities {
        for operation in &mut capability.operations {
            operation.signature = signature_map[&operation.signature];
        }
    }
    for link in &mut module.links {
        link.signature = signature_map[&link.signature];
    }
    for exported in &mut module.exports {
        if let RuntimeExport::Runtime { signature, .. } = exported {
            *signature = signature_map[signature];
        }
    }
    module.types = types;
    module.signatures = signatures;
    Ok(())
}

fn retain_referenced_static_stores(module: &mut RuntimeModule) -> Result<(), String> {
    let retained_ids = module
        .functions
        .iter()
        .flat_map(|function| &function.continuations)
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| instruction.operation.static_store)
        .collect::<BTreeSet<_>>();
    let store_map = retained_ids
        .iter()
        .enumerate()
        .map(|(next, previous)| (*previous, next))
        .collect::<HashMap<_, _>>();
    let retained_stores = retained_ids
        .iter()
        .map(|store_id| {
            module.static_stores.get(*store_id).cloned().ok_or_else(|| {
                format!(
                    "{}: development unit references absent static Store {store_id}",
                    module.source
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    for operation in module
        .functions
        .iter_mut()
        .flat_map(|function| &mut function.continuations)
        .flat_map(|block| &mut block.instructions)
    {
        let Some(store_id) = &mut operation.operation.static_store else {
            continue;
        };
        *store_id = store_map[store_id];
    }
    module.static_stores = retained_stores;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn rewrite_function(
    module: &RuntimeModule,
    unit: &str,
    function: &mut RuntimeFunction,
    functions: &HashMap<FunctionId, &RuntimeFunction>,
    function_map: &HashMap<FunctionId, FunctionId>,
    unit_by_root: &HashMap<String, String>,
    link_names: &BTreeMap<LinkDemand, String>,
    links: &mut Vec<RuntimeLink>,
    linked_imports: &mut HashSet<(String, String)>,
) -> Result<(), String> {
    for continuation in &mut function.continuations {
        for instruction in &mut continuation.instructions {
            if let Some(target) = &mut instruction.operation.function {
                *target = *function_map.get(target).ok_or_else(|| {
                    format!(
                        "{}: development unit {unit:?} omitted local function {target}",
                        module.source
                    )
                })?;
            }
        }
        let Transition::Call {
            target,
            signature,
            suspends,
            ..
        } = &mut continuation.transition
        else {
            continue;
        };
        let callee = match target {
            CallTarget::Function { function } => *function,
            CallTarget::Host { .. } => continue,
            CallTarget::Link {
                unit: provider,
                name,
            } => {
                let declaration = module
                    .links
                    .iter()
                    .find(|link| link.unit == *provider && link.name == *name)
                    .ok_or_else(|| {
                        format!(
                            "{}: development link {provider}.{name} has no declaration",
                            module.source
                        )
                    })?;
                if linked_imports.insert((provider.clone(), name.clone())) {
                    links.push(declaration.clone());
                }
                continue;
            }
        };
        let target_function = functions.get(&callee).ok_or_else(|| {
            format!(
                "{}: development call references absent function {callee}",
                module.source
            )
        })?;
        let provider = unit_by_root.get(&target_function.span.file);
        if let Some(provider) = provider.filter(|provider| *provider != unit) {
            let demand = LinkDemand {
                consumer: unit.to_owned(),
                provider: provider.clone(),
                function: callee,
            };
            let link_name = link_names.get(&demand).ok_or_else(|| {
                format!(
                    "{}: development call from {unit:?} to {provider:?} function {callee} has no demand",
                    module.source
                )
            })?;
            if linked_imports.insert((provider.clone(), link_name.clone())) {
                links.push(RuntimeLink {
                    unit: provider.clone(),
                    name: link_name.clone(),
                    signature: target_function.signature.0,
                    suspends: target_function.suspends,
                });
            }
            *target = CallTarget::Link {
                unit: provider.clone(),
                name: link_name.clone(),
            };
            *signature = target_function.signature;
            *suspends = target_function.suspends;
            continue;
        }
        *target = CallTarget::Function {
            function: *function_map.get(&callee).ok_or_else(|| {
                format!(
                    "{}: development unit {unit:?} omitted local function {callee}",
                    module.source
                )
            })?,
        };
    }
    Ok(())
}

fn development_export_name(
    module: &RuntimeModule,
    provider: &str,
    function: &RuntimeFunction,
) -> Result<String, String> {
    let signature = module.signatures.get(function.signature.0).ok_or_else(|| {
        format!(
            "{}: development function {} references absent signature {}",
            module.source, function.id, function.signature
        )
    })?;
    let parameters = signature
        .parameters
        .iter()
        .map(|type_id| development_type_identity(module, *type_id, &mut HashSet::new()))
        .collect::<Result<Vec<_>, _>>()?;
    let result = development_type_identity(module, signature.result, &mut HashSet::new())?;
    let encoded = serde_json::to_vec(&(
        provider,
        &function.span.file,
        &function.name,
        module
            .functions
            .iter()
            .take_while(|candidate| candidate.id != function.id)
            .filter(|candidate| {
                candidate.span.file == function.span.file && candidate.name == function.name
            })
            .count(),
        parameters,
        result,
        &signature.effects,
    ))
    .map_err(|error| {
        format!(
            "{}: could not encode development specialization identity: {error}",
            module.source
        )
    })?;
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in encoded {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(format!("f{hash:016x}"))
}

fn development_type_identity(
    module: &RuntimeModule,
    type_id: usize,
    active: &mut HashSet<usize>,
) -> Result<String, String> {
    if !active.insert(type_id) {
        return Err(format!(
            "{}: development boundary type {type_id} is recursive",
            module.source
        ));
    }
    let type_ = module.types.get(type_id).ok_or_else(|| {
        format!(
            "{}: development boundary references absent type {type_id}",
            module.source
        )
    })?;
    let identity = match type_ {
        crate::hir::RuntimeType::Unit => "unit".to_owned(),
        crate::hir::RuntimeType::Callback {
            function,
            signature,
            environment_type,
        } => {
            let callback = &module.functions[*function];
            let signature = &module.signatures[*signature];
            let parameters = signature
                .parameters
                .iter()
                .map(|type_id| development_type_identity(module, *type_id, active))
                .collect::<Result<Vec<_>, _>>()?;
            let result = development_type_identity(module, signature.result, active)?;
            let environment = development_type_identity(module, *environment_type, active)?;
            let ordinal = module
                .functions
                .iter()
                .take_while(|candidate| candidate.id != callback.id)
                .filter(|candidate| {
                    candidate.span.file == callback.span.file && candidate.name == callback.name
                })
                .count();
            format!(
                "callback:{}",
                serde_json::to_string(&(
                    &callback.span.file,
                    &callback.name,
                    ordinal,
                    parameters,
                    result,
                    &signature.effects,
                    environment
                ))
                .map_err(|error| format!("could not identify development callback: {error}"))?
            )
        }
        crate::hir::RuntimeType::Integer32 => "integer-32".to_owned(),
        crate::hir::RuntimeType::SignedInteger64 => "signed-integer-64".to_owned(),
        crate::hir::RuntimeType::Resource { name, payload_type } => format!(
            "resource({name:?}){}",
            development_type_identity(module, *payload_type, active)?
        ),
        crate::hir::RuntimeType::Float32 => "float-32".to_owned(),
        crate::hir::RuntimeType::Float64 => "float-64".to_owned(),
        crate::hir::RuntimeType::Boolean => "boolean".to_owned(),
        crate::hir::RuntimeType::Text => "text".to_owned(),
        crate::hir::RuntimeType::Vector { element, lanes } => {
            format!("vector:{element}:{lanes}")
        }
        crate::hir::RuntimeType::Mask { element, lanes } => {
            format!("mask:{element}:{lanes}")
        }
        crate::hir::RuntimeType::Store { element_type } => format!(
            "array:{}",
            development_type_identity(module, *element_type, active)?
        ),
        crate::hir::RuntimeType::Scratch { .. } => {
            return Err(format!(
                "{}: compiler-private Scratch storage cannot cross a development boundary",
                module.source
            ));
        }
        crate::hir::RuntimeType::Indirect { .. } => {
            return Err(format!(
                "{}: compiler-private indirection cannot cross a development boundary",
                module.source
            ));
        }
        crate::hir::RuntimeType::Product { fields, .. } => {
            let fields = fields
                .iter()
                .map(|field| {
                    Ok((
                        field.name.clone(),
                        development_type_identity(module, field.type_id, active)?,
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            serde_json::to_string(&fields).map_err(|error| {
                format!(
                    "{}: could not identify record boundary: {error}",
                    module.source
                )
            })?
        }
        crate::hir::RuntimeType::Sum { cases, .. } => {
            let cases = cases
                .iter()
                .map(|case_| {
                    Ok((
                        case_.name.clone(),
                        development_type_identity(module, case_.payload_type, active)?,
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            format!(
                "variant:{}",
                serde_json::to_string(&cases).map_err(|error| {
                    format!(
                        "{}: could not identify variant boundary: {error}",
                        module.source
                    )
                })?
            )
        }
        crate::hir::RuntimeType::Sealed {
            name,
            representation_type,
        } => format!(
            "sealed:{name}:{}",
            development_type_identity(module, *representation_type, active)?
        ),
    };
    active.remove(&type_id);
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuation::{
        Argument, Continuation, ContinuationId, Definition, Edge, Instruction, Operation, TypeId,
        ValueId,
    };
    use crate::hir::{RuntimeSignature, RuntimeSpan, RuntimeType, WireConstant};

    #[test]
    fn cached_unit_reuse_returns_metadata_without_retaining_compiled_bytes() {
        let cached_identity = development_module_identity(&scalar_program(41))
            .expect("cached development identity should encode");
        let requested_identity = development_module_identity(&scalar_program(41))
            .expect("requested development identity should encode");
        let compiled = Rc::new(CompiledModule {
            wasm: vec![0, 97, 115, 109],
            manifest: br#"{"format":"blot-core-wasm"}"#.to_vec(),
            capabilities: vec!["blot:host/Test".to_owned()],
        });
        let compiled_ownership = Rc::downgrade(&compiled);
        let cached = CachedDevelopmentArtifact::new(
            cached_identity,
            compiled,
            HashSet::from(["game.blot".to_owned()]),
            DevelopmentUnitPartition::default(),
        );

        let reused = cached
            .reuse(&requested_identity)
            .expect("equal Runtime HIR should reuse its unit");

        assert_eq!(reused.artifact_source(), "unit-cache");
        assert_eq!(reused.capabilities(), ["blot:host/Test"]);
        assert!(reused.compiled().is_none());
        assert_eq!(compiled_ownership.strong_count(), 1);
    }

    #[test]
    fn equal_implementation_keys_do_not_reuse_different_runtime_modules() {
        let first = development_module_identity(&scalar_program(41))
            .expect("first development identity should encode");
        let mut different = development_module_identity(&scalar_program(42))
            .expect("different development identity should encode");
        different.implementation_key = first.implementation_key.clone();
        assert_eq!(first.implementation_key, different.implementation_key);
        assert_ne!(
            first.canonical_runtime_module,
            different.canonical_runtime_module
        );
        let cached = CachedDevelopmentArtifact::new(
            first,
            Rc::new(CompiledModule {
                wasm: vec![0, 97, 115, 109],
                manifest: br#"{"format":"blot-core-wasm"}"#.to_vec(),
                capabilities: Vec::new(),
            }),
            HashSet::from(["game.blot".to_owned()]),
            DevelopmentUnitPartition::default(),
        );

        assert!(cached.reuse(&different).is_none());
    }

    #[test]
    fn direct_calls_at_configured_roots_become_stable_external_links() {
        let original = scalar_program(41);
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);

        let split = split_runtime_module(&original, "game", &configured, &HashMap::new())
            .expect("development program should split");

        assert_eq!(split.entry_unit, "game");
        assert_eq!(split.units.len(), 2);
        assert_eq!(split.edges.len(), 1);
        let game = split
            .units
            .iter()
            .find(|unit| unit.name == "game")
            .expect("entry unit");
        let game_module = game.module.as_ref().expect("entry unit should be prepared");
        let Transition::Call {
            target: CallTarget::Link { unit, .. },
            ..
        } = &game_module.functions[0].continuations[0].transition
        else {
            panic!("cross-unit call should become a link transition");
        };
        assert_eq!(unit, "math");
        assert_eq!(game_module.links.len(), 1);
        let math = split
            .units
            .iter()
            .find(|unit| unit.name == "math")
            .expect("provider unit");
        assert_eq!(
            math.module
                .as_ref()
                .expect("provider unit should be prepared")
                .exports
                .len(),
            1
        );

        let edited =
            split_runtime_module(&scalar_program(42), "game", &configured, &HashMap::new())
                .expect("edited development program should split");
        assert_eq!(split.edges, edited.edges);

        let reusable_partitions = HashMap::from([("math".to_owned(), math.partition.clone())]);
        let reused = split_runtime_module(
            &scalar_program(42),
            "game",
            &configured,
            &reusable_partitions,
        )
        .expect("unaffected provider should skip unit preparation");
        let reused_math = reused
            .units
            .iter()
            .find(|unit| unit.name == "math")
            .expect("provider unit");
        assert!(reused_math.module.is_none());
        assert!(reused_math.source_paths.contains("math.blot"));
    }

    #[test]
    fn development_links_preserve_suspension_without_promoting_framed_functions() {
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);
        for suspends in [false, true] {
            let mut original = scalar_program(41);
            original.functions[0].suspends = suspends;
            original.functions[0].framed = true;
            original.functions[1].suspends = suspends;
            original.functions[1].framed = true;
            let Transition::Call {
                suspends: call_suspends,
                ..
            } = &mut original.functions[0].continuations[0].transition
            else {
                panic!("entry fixture should call the provider");
            };
            *call_suspends = suspends;

            let split = split_runtime_module(&original, "game", &configured, &HashMap::new())
                .expect("framed development program should split");
            for unit in &split.units {
                let module = unit.module.as_ref().expect("unit should be prepared");
                assert!(module.functions.iter().all(|function| function.framed));
                assert!(
                    module
                        .functions
                        .iter()
                        .all(|function| function.suspends == suspends)
                );
                if unit.name == "game" {
                    assert_eq!(module.links[0].suspends, suspends);
                    assert!(matches!(module.functions[0].continuations[0].transition,
                        Transition::Call { suspends: call_suspends, .. } if call_suspends == suspends));
                }
            }
        }
    }

    #[test]
    fn unit_normalization_remaps_captured_definitions_and_call_signatures() {
        let mut original = scalar_program(41);
        original.types = vec![
            RuntimeType::Unit,
            RuntimeType::Text,
            RuntimeType::SignedInteger64,
        ];
        original.signatures.insert(
            0,
            RuntimeSignature {
                parameters: vec![1],
                result: 1,
                effects: Vec::new(),
            },
        );
        original.signatures[1].result = 2;
        for function in &mut original.graph.functions {
            function.signature = SignatureId(1);
        }
        let RuntimeExport::Runtime { signature, .. } = &mut original.exports[0] else {
            panic!("entry fixture should export a runtime function");
        };
        *signature = 1;
        let mut captured = instruction("game.blot", "constant");
        captured.definition.value = ValueId(1);
        captured.definition.type_id = TypeId(2);
        captured.operation.value = Some(WireConstant::SignedInteger64("1".to_owned()));
        let mut sum = instruction("game.blot", "scalar");
        sum.definition.value = ValueId(2);
        sum.definition.type_id = TypeId(2);
        sum.operands = vec![ValueId(0), ValueId(1)];
        sum.operation.operator = Some("add");
        let entry = &mut original.functions[0];
        entry.continuations[1].parameters[0].type_id = TypeId(2);
        entry.continuations[1]
            .captures
            .push(captured.definition.clone());
        entry.continuations[1].instructions.push(sum);
        entry.continuations[1].transition = Transition::Return { value: ValueId(2) };
        entry.continuations[0].instructions.push(captured);
        let Transition::Call { signature, .. } = &mut entry.continuations[0].transition else {
            panic!("entry fixture should call the provider");
        };
        *signature = SignatureId(1);
        original.functions[1].continuations[0].instructions[0]
            .definition
            .type_id = TypeId(2);
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);

        let split = split_runtime_module(&original, "game", &configured, &HashMap::new())
            .expect("captured values should survive development partitioning");
        let game = split
            .units
            .iter()
            .find(|unit| unit.name == "game")
            .expect("entry unit")
            .module
            .as_ref()
            .expect("entry unit should be prepared");
        assert_eq!(game.types.len(), 2);
        assert_eq!(game.signatures.len(), 1);
        assert_eq!(game.links[0].signature, 0);
        let continuation = &game.functions[0].continuations[1];
        assert_eq!(continuation.parameters[0].type_id, TypeId(1));
        assert_eq!(continuation.captures[0].type_id, TypeId(1));
        assert_eq!(continuation.instructions[0].definition.type_id, TypeId(1));
        assert_eq!(continuation.captures[0].value, ValueId(1));
        assert!(matches!(
            game.functions[0].continuations[0].transition,
            Transition::Call {
                signature: SignatureId(0),
                ..
            }
        ));
    }

    #[test]
    fn changed_call_demand_rebuilds_an_unchanged_provider_partition() {
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);
        let initial =
            split_runtime_module(&scalar_program(41), "game", &configured, &HashMap::new())
                .expect("initial development program should split");
        let math_partition = initial
            .units
            .iter()
            .find(|unit| unit.name == "math")
            .expect("provider unit")
            .partition
            .clone();

        let mut edited = scalar_program(41);
        let mut alternative = edited.functions[1].clone();
        alternative.id = FunctionId(2);
        alternative.name = "alternative".to_owned();
        edited.functions.push(alternative);
        let Transition::Call { target, .. } = &mut edited.functions[0].continuations[0].transition
        else {
            panic!("entry fixture should call the provider");
        };
        *target = CallTarget::Function {
            function: FunctionId(2),
        };
        let reusable_partitions = HashMap::from([("math".to_owned(), math_partition)]);
        let split = split_runtime_module(&edited, "game", &configured, &reusable_partitions)
            .expect("changed call demand should split");
        let math = split
            .units
            .iter()
            .find(|unit| unit.name == "math")
            .expect("provider unit");

        assert!(math.module.is_some());
    }

    #[test]
    fn provider_static_store_edits_do_not_change_consumer_identity() {
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("project".to_owned(), "project.blot".to_owned()),
        ]);
        let initial = split_runtime_module(
            &static_store_program(41),
            "game",
            &configured,
            &HashMap::new(),
        )
        .expect("initial development program should split");
        let edited = split_runtime_module(
            &static_store_program(42),
            "game",
            &configured,
            &HashMap::new(),
        )
        .expect("edited development program should split");
        fn unit_module<'a>(program: &'a DevelopmentProgram, name: &str) -> &'a RuntimeModule {
            program
                .units
                .iter()
                .find(|unit| unit.name == name)
                .unwrap_or_else(|| panic!("development program omitted {name} unit"))
                .module
                .as_ref()
                .expect("development unit should be prepared")
        }
        let initial_game = unit_module(&initial, "game");
        let edited_game = unit_module(&edited, "game");

        assert!(initial_game.static_stores.is_empty());
        assert!(edited_game.static_stores.is_empty());
        assert_eq!(
            development_module_identity(initial_game).expect("initial game identity should encode"),
            development_module_identity(edited_game).expect("edited game identity should encode")
        );
        assert_ne!(
            development_module_identity(unit_module(&initial, "project"))
                .expect("initial project identity should encode"),
            development_module_identity(unit_module(&edited, "project"))
                .expect("edited project identity should encode")
        );
    }

    #[test]
    fn split_units_emit_linked_wasm_artifacts() {
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);
        let split = split_runtime_module(&scalar_program(41), "game", &configured, &HashMap::new())
            .expect("development program should split");

        for unit in split.units {
            let compiled =
                crate::backend::close(unit.module.expect("development unit should be prepared"))
                    .and_then(|program| program.compile())
                    .unwrap_or_else(|error| panic!("unit {} did not emit: {error}", unit.name));
            assert_eq!(compiled.wasm.get(..4), Some(b"\0asm".as_slice()));
            let manifest: serde_json::Value = serde_json::from_slice(&compiled.manifest)
                .expect("development manifest should be JSON");
            if unit.name == "game" {
                assert_eq!(manifest["links"][0]["unit"], "math");
            }
        }
    }

    #[test]
    fn function_values_cannot_cross_development_boundaries() {
        let mut original = scalar_program(41);
        let mut closure = instruction("game.blot", "closure.make");
        closure.operation.function = Some(FunctionId(1));
        original.functions[0].continuations[0]
            .instructions
            .push(closure);
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);

        let Err(error) = split_runtime_module(&original, "game", &configured, &HashMap::new())
        else {
            panic!("a cross-unit closure should be refused");
        };

        assert!(
            error.contains("functions may be called through a reload boundary"),
            "{error}"
        );
    }

    #[test]
    fn development_callback_types_include_entry_bodies_in_both_units() {
        let mut module = scalar_program(41);
        module.types.extend([
            RuntimeType::Unit,
            RuntimeType::Product {
                name: "captures".to_owned(),
                fields: Vec::new(),
            },
            RuntimeType::Callback {
                function: 2,
                signature: 1,
                environment_type: 2,
            },
        ]);
        module.signatures.push(RuntimeSignature {
            parameters: vec![1],
            result: 0,
            effects: Vec::new(),
        });
        let mut callback = module.functions[1].clone();
        callback.id = FunctionId(2);
        callback.name = "callback".to_owned();
        callback.signature = SignatureId(1);
        callback.framed = true;
        callback.continuations[0].parameters.push(Definition {
            value: ValueId(1),
            type_id: TypeId(1),
            ownership: "plain",
            span: span("math.blot"),
        });
        module.functions.push(callback);
        module.signatures[0].result = 3;
        module.functions[0].continuations[1].parameters[0].type_id = TypeId(3);
        module.functions[0].continuations[1].parameters[0].ownership = "owned";
        let mut make = instruction("math.blot", "callback.make");
        make.definition.type_id = TypeId(3);
        make.definition.ownership = "owned";
        make.operation.function = Some(FunctionId(2));
        let mut environment = instruction("math.blot", "product.make");
        environment.definition.value = ValueId(1);
        environment.definition.type_id = TypeId(2);
        environment.definition.ownership = "owned";
        make.operands = vec![ValueId(1)];
        module.functions[1].continuations[0].instructions = vec![environment, make];
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);
        let split = split_runtime_module(&module, "game", &configured, &HashMap::new())
            .expect("callback boundary should split");
        for unit in split.units {
            let module = unit.module.expect("unit should be prepared");
            assert!(
                module
                    .types
                    .iter()
                    .any(|type_| matches!(type_, RuntimeType::Callback { .. }))
            );
            let compiled = crate::backend::close(module)
                .and_then(|program| program.compile())
                .expect("callback entries should emit in each unit");
            wasmparser::Validator::new()
                .validate_all(&compiled.wasm)
                .expect("callback unit should validate");
        }
    }

    #[test]
    fn development_provider_exports_each_target_once_for_multiple_consumers() {
        let mut module = scalar_program(41);
        let mut middle = module.functions[0].clone();
        middle.id = FunctionId(2);
        middle.span = span("middle.blot");
        module.functions.push(middle);
        let entry = &mut module.functions[0];
        entry.continuations[1].transition = Transition::Call {
            target: CallTarget::Function {
                function: FunctionId(2),
            },
            signature: SignatureId(0),
            arguments: Vec::new(),
            next: Edge {
                target: ContinuationId(2),
                arguments: vec![Argument::Result],
            },
            suspends: false,
        };
        let mut result = entry.continuations[1].clone();
        result.id = ContinuationId(2);
        result.parameters[0].value = ValueId(1);
        result.transition = Transition::Return { value: ValueId(1) };
        entry.continuations.push(result);
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
            ("middle".to_owned(), "middle.blot".to_owned()),
        ]);
        let split = split_runtime_module(&module, "game", &configured, &HashMap::new())
            .expect("shared provider should split");
        let provider = split
            .units
            .into_iter()
            .find(|unit| unit.name == "math")
            .unwrap()
            .module
            .unwrap();
        assert_eq!(provider.exports.len(), 1);
        let compiled = crate::backend::close(provider)
            .and_then(|program| program.compile())
            .expect("shared provider should emit");
        wasmparser::Validator::new()
            .validate_all(&compiled.wasm)
            .expect("shared provider must not repeat exports");
    }

    fn span(file: &str) -> RuntimeSpan {
        RuntimeSpan {
            file: file.to_owned(),
            start: 0,
            end: 1,
        }
    }

    fn instruction(file: &str, kind: &'static str) -> Instruction {
        Instruction {
            definition: Definition {
                value: ValueId(0),
                type_id: TypeId(0),
                ownership: "plain",
                span: span(file),
            },
            operands: Vec::new(),
            operation: Operation {
                kind,
                value: None,
                update: None,
                case: None,
                operator: None,
                conversion: None,
                lane: None,
                field: None,
                function: None,
                signature: None,
                static_store: None,
            },
        }
    }

    fn scalar_program(value: i64) -> RuntimeModule {
        let mut constant = instruction("math.blot", "constant");
        constant.operation.value = Some(WireConstant::SignedInteger64(value.to_string()));
        RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "game.blot".to_owned(),
            types: vec![RuntimeType::SignedInteger64],
            signatures: vec![RuntimeSignature {
                parameters: Vec::new(),
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            graph: Graph {
                functions: vec![
                    RuntimeFunction {
                        id: FunctionId(0),
                        name: "entry".to_owned(),
                        signature: SignatureId(0),
                        reuse: None,
                        entry: ContinuationId(0),
                        suspends: false,
                        framed: false,
                        continuations: vec![
                            Continuation {
                                id: ContinuationId(0),
                                parameters: Vec::new(),
                                captures: Vec::new(),
                                instructions: Vec::new(),
                                transition: Transition::Call {
                                    target: CallTarget::Function {
                                        function: FunctionId(1),
                                    },
                                    signature: SignatureId(0),
                                    arguments: Vec::new(),
                                    next: Edge {
                                        target: ContinuationId(1),
                                        arguments: vec![Argument::Result],
                                    },
                                    suspends: false,
                                },
                                span: span("game.blot"),
                            },
                            Continuation {
                                id: ContinuationId(1),
                                parameters: vec![Definition {
                                    value: ValueId(0),
                                    type_id: TypeId(0),
                                    ownership: "plain",
                                    span: span("game.blot"),
                                }],
                                captures: Vec::new(),
                                instructions: Vec::new(),
                                transition: Transition::Return { value: ValueId(0) },
                                span: span("game.blot"),
                            },
                        ],
                        span: span("game.blot"),
                    },
                    RuntimeFunction {
                        id: FunctionId(1),
                        name: "answer".to_owned(),
                        signature: SignatureId(0),
                        reuse: None,
                        entry: ContinuationId(0),
                        suspends: false,
                        framed: false,
                        continuations: vec![Continuation {
                            id: ContinuationId(0),
                            parameters: Vec::new(),
                            captures: Vec::new(),
                            instructions: vec![constant],
                            transition: Transition::Return { value: ValueId(0) },
                            span: span("math.blot"),
                        }],
                        span: span("math.blot"),
                    },
                ],
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: vec![RuntimeExport::Runtime {
                source_name: "default".to_owned(),
                phase: "runtime",
                wasm_name: "blot:default".to_owned(),
                function: 0,
                signature: 0,
                ownership: "owned",
            }],
        }
    }

    fn static_store_program(value: i64) -> RuntimeModule {
        let mut module = scalar_program(value);
        module.types.push(RuntimeType::Store { element_type: 0 });
        module.signatures[0].result = 1;
        module.static_stores.push(crate::hir::RuntimeStaticStore {
            element_type: 0,
            values: vec![WireConstant::SignedInteger64(value.to_string())],
        });
        let result = &mut module.functions[0].continuations[1].parameters[0];
        result.type_id = TypeId(1);
        result.ownership = "owned";
        let provider = &mut module.functions[1];
        provider.name = "project".to_owned();
        provider.span = span("project.blot");
        provider.continuations[0].span = span("project.blot");
        let mut store = instruction("project.blot", "store.literal");
        store.definition.type_id = TypeId(1);
        store.definition.ownership = "owned";
        store.operation.static_store = Some(0);
        provider.continuations[0].instructions = vec![store];
        module
    }
}
