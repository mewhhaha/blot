use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use serde::Serialize;

use crate::backend::CompiledModule;
use crate::hir::{RuntimeExport, RuntimeFunction, RuntimeLink, RuntimeModule, RuntimeOperation};

#[derive(Clone)]
pub(crate) struct DevelopmentUnit {
    pub(crate) name: String,
    pub(crate) root: String,
    pub(crate) module: RuntimeModule,
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
    #[cfg(feature = "development-profile")]
    pub(crate) memory_profile: DevelopmentMemoryProfile,
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
}

impl CachedDevelopmentArtifact {
    pub(crate) fn new(identity: DevelopmentModuleIdentity, compiled: Rc<CompiledModule>) -> Self {
        Self { identity, compiled }
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
}

pub(crate) fn development_module_identity(
    module: &RuntimeModule,
) -> Result<DevelopmentModuleIdentity, String> {
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

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct LinkDemand {
    consumer: String,
    provider: String,
    function: usize,
}

pub(crate) fn split_runtime_module(
    module: &RuntimeModule,
    entry_unit: &str,
    configured_units: &BTreeMap<String, String>,
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
    let mut included = BTreeMap::<String, BTreeSet<usize>>::new();
    let mut demands = BTreeSet::new();
    let mut pending = module
        .exports
        .iter()
        .filter_map(|exported| match exported {
            RuntimeExport::Runtime { function, .. } => Some((entry_unit.to_owned(), *function)),
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
        for operation in function.blocks.iter().flat_map(|block| &block.operations) {
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
            if operation.kind != "call.direct" && operation.kind != "closure.make" {
                continue;
            }
            if let Some(provider) = target_unit.filter(|provider| *provider != &unit) {
                demands.insert(LinkDemand {
                    consumer: unit.clone(),
                    provider: provider.clone(),
                    function: target,
                });
                pending.push((provider.clone(), target));
                continue;
            }
            pending.push((unit.clone(), target));
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
        units.push(DevelopmentUnit {
            name: name.clone(),
            root: root.clone(),
            module: build_unit_module(
                module,
                name,
                root,
                entry_unit,
                function_ids,
                &unit_by_root,
                &demands,
                &link_names,
            )?,
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
    function_ids: &BTreeSet<usize>,
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
        .map(|(next, previous)| (*previous, next))
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
        for operation in function
            .blocks
            .iter_mut()
            .flat_map(|block| &mut block.operations)
        {
            rewrite_operation(
                module,
                unit,
                operation,
                &functions_by_id,
                &function_map,
                unit_by_root,
                link_names,
                &mut links,
                &mut linked_imports,
            )?;
        }
        functions.push(function);
    }

    let mut exports = Vec::new();
    if unit == entry_unit {
        for exported in &module.exports {
            let mut exported = exported.clone();
            if let RuntimeExport::Runtime { function, .. } = &mut exported {
                *function = *function_map.get(function).ok_or_else(|| {
                    format!(
                        "{}: entry unit {unit:?} omitted exported function {function}",
                        module.source
                    )
                })?;
            }
            exports.push(exported);
        }
    }
    for demand in demands.iter().filter(|demand| demand.provider == unit) {
        let target = functions_by_id.get(&demand.function).ok_or_else(|| {
            format!(
                "{}: development export lost function {}",
                module.source, demand.function
            )
        })?;
        let mut wrapper = (*target).clone();
        wrapper.id = functions.len();
        for operation in wrapper
            .blocks
            .iter_mut()
            .flat_map(|block| &mut block.operations)
        {
            rewrite_operation(
                module,
                unit,
                operation,
                &functions_by_id,
                &function_map,
                unit_by_root,
                link_names,
                &mut links,
                &mut linked_imports,
            )?;
        }
        let exported_function = wrapper.id;
        functions.push(wrapper);
        let link_name = link_names[demand].clone();
        exports.push(RuntimeExport::Runtime {
            source_name: format!("$development${link_name}"),
            phase: "runtime",
            wasm_name: format!("blot:dev:{link_name}"),
            function: exported_function,
            signature: target.signature,
            ownership: "owned",
        });
    }

    let mut unit_module = RuntimeModule {
        format: "blot-runtime-hir",
        schema_version: module.schema_version,
        source: root.to_owned(),
        types: module.types.clone(),
        signatures: module.signatures.clone(),
        functions,
        capabilities: module.capabilities.clone(),
        links,
        exports,
    };
    normalize_unit_module(&mut unit_module)?;
    Ok(unit_module)
}

fn normalize_unit_module(module: &mut RuntimeModule) -> Result<(), String> {
    let mut signature_ids = BTreeSet::new();
    let mut host_operations = BTreeSet::new();
    for function in &module.functions {
        signature_ids.insert(function.signature);
        for operation in function.blocks.iter().flat_map(|block| &block.operations) {
            if let Some(signature) = operation.signature {
                signature_ids.insert(signature);
            }
            if operation.kind == "host.call" {
                let capability = operation.capability.clone().ok_or_else(|| {
                    format!(
                        "{}: development host call omitted its capability",
                        module.source
                    )
                })?;
                let name = operation.operation.clone().ok_or_else(|| {
                    format!(
                        "{}: development host call omitted its operation",
                        module.source
                    )
                })?;
                host_operations.insert((capability, name));
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
    for function in &module.functions {
        for block in &function.blocks {
            type_ids.extend(block.parameters.iter().map(|parameter| parameter.type_id));
            type_ids.extend(block.operations.iter().map(|operation| operation.type_id));
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
            crate::hir::RuntimeType::Store { element_type }
            | crate::hir::RuntimeType::Scratch { element_type } => vec![*element_type],
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
            crate::hir::RuntimeType::Store { element_type }
            | crate::hir::RuntimeType::Scratch { element_type } => {
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
    for function in &mut module.functions {
        function.signature = signature_map[&function.signature];
        for block in &mut function.blocks {
            for parameter in &mut block.parameters {
                parameter.type_id = type_map[&parameter.type_id];
            }
            for operation in &mut block.operations {
                operation.type_id = type_map[&operation.type_id];
                if let Some(signature) = &mut operation.signature {
                    *signature = signature_map[signature];
                }
            }
        }
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

#[allow(clippy::too_many_arguments)]
fn rewrite_operation(
    module: &RuntimeModule,
    unit: &str,
    operation: &mut RuntimeOperation,
    functions: &HashMap<usize, &RuntimeFunction>,
    function_map: &HashMap<usize, usize>,
    unit_by_root: &HashMap<String, String>,
    link_names: &BTreeMap<LinkDemand, String>,
    links: &mut Vec<RuntimeLink>,
    linked_imports: &mut HashSet<(String, String)>,
) -> Result<(), String> {
    let Some(target) = operation.function else {
        return Ok(());
    };
    let target_function = functions.get(&target).ok_or_else(|| {
        format!(
            "{}: development operation references absent function {target}",
            module.source
        )
    })?;
    let provider = unit_by_root.get(&target_function.span.file);
    if operation.kind == "call.direct" && provider.is_some_and(|provider| provider != unit) {
        let provider = provider.expect("checked provider");
        let demand = LinkDemand {
            consumer: unit.to_owned(),
            provider: provider.clone(),
            function: target,
        };
        let link_name = link_names.get(&demand).ok_or_else(|| {
            format!(
                "{}: development call from {unit:?} to {provider:?} function {target} has no demand",
                module.source
            )
        })?;
        let key = (provider.clone(), link_name.clone());
        if linked_imports.insert(key) {
            links.push(RuntimeLink {
                unit: provider.clone(),
                name: link_name.clone(),
                signature: target_function.signature,
            });
        }
        operation.kind = "call.external";
        operation.function = None;
        operation.capability = Some(provider.clone());
        operation.operation = Some(link_name.clone());
        operation.signature = Some(target_function.signature);
        return Ok(());
    }
    operation.function = Some(*function_map.get(&target).ok_or_else(|| {
        format!(
            "{}: development unit {unit:?} omitted local function {target}",
            module.source
        )
    })?);
    Ok(())
}

fn development_export_name(
    module: &RuntimeModule,
    provider: &str,
    function: &RuntimeFunction,
) -> Result<String, String> {
    let signature = module.signatures.get(function.signature).ok_or_else(|| {
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
        function.span.start,
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
        crate::hir::RuntimeType::Integer32 => "integer-32".to_owned(),
        crate::hir::RuntimeType::SignedInteger64 => "signed-integer-64".to_owned(),
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
    use crate::hir::{
        RuntimeBlock, RuntimeBlockParameter, RuntimeOperation, RuntimeSignature, RuntimeSpan,
        RuntimeTerminator, RuntimeType,
    };

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
        let cached = CachedDevelopmentArtifact::new(cached_identity, compiled);

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

        let split = split_runtime_module(&original, "game", &configured)
            .expect("development program should split");

        assert_eq!(split.entry_unit, "game");
        assert_eq!(split.units.len(), 2);
        assert_eq!(split.edges.len(), 1);
        let game = split
            .units
            .iter()
            .find(|unit| unit.name == "game")
            .expect("entry unit");
        let operation = &game.module.functions[0].blocks[0].operations[0];
        assert_eq!(operation.kind, "call.external");
        assert_eq!(operation.capability.as_deref(), Some("math"));
        assert_eq!(game.module.links.len(), 1);
        let math = split
            .units
            .iter()
            .find(|unit| unit.name == "math")
            .expect("provider unit");
        assert_eq!(math.module.exports.len(), 1);

        let edited = split_runtime_module(&scalar_program(42), "game", &configured)
            .expect("edited development program should split");
        assert_eq!(split.edges, edited.edges);
    }

    #[test]
    fn split_units_emit_linked_wasm_artifacts() {
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);
        let split = split_runtime_module(&scalar_program(41), "game", &configured)
            .expect("development program should split");

        for unit in split.units {
            let compiled = crate::backend::close(unit.module)
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
        original.functions[0].blocks[0].operations[0].kind = "closure.make";
        let configured = BTreeMap::from([
            ("game".to_owned(), "game.blot".to_owned()),
            ("math".to_owned(), "math.blot".to_owned()),
        ]);

        let Err(error) = split_runtime_module(&original, "game", &configured) else {
            panic!("a cross-unit closure should be refused");
        };

        assert!(
            error.contains("functions may be called through a reload boundary"),
            "{error}"
        );
    }

    fn scalar_program(value: i64) -> RuntimeModule {
        let span = |file: &str| RuntimeSpan {
            file: file.to_owned(),
            start: 0,
            end: 1,
        };
        let operation = |kind, result, function, value| RuntimeOperation {
            kind,
            result,
            type_id: 0,
            operands: Vec::new(),
            ownership: "unrestricted",
            span: span("game.blot"),
            value,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function,
            signature: None,
        };
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
            functions: vec![
                RuntimeFunction {
                    id: 0,
                    name: "entry".to_owned(),
                    signature: 0,
                    reuse: None,
                    entry_block: 0,
                    blocks: vec![RuntimeBlock {
                        id: 0,
                        parameters: Vec::<RuntimeBlockParameter>::new(),
                        operations: vec![operation("call.direct", 0, Some(1), None)],
                        terminator: RuntimeTerminator::Return {
                            value: 0,
                            span: span("game.blot"),
                        },
                    }],
                    span: span("game.blot"),
                },
                RuntimeFunction {
                    id: 1,
                    name: "answer".to_owned(),
                    signature: 0,
                    reuse: None,
                    entry_block: 0,
                    blocks: vec![RuntimeBlock {
                        id: 0,
                        parameters: Vec::new(),
                        operations: vec![operation(
                            "constant",
                            0,
                            None,
                            Some(crate::hir::WireConstant::SignedInteger64(value.to_string())),
                        )],
                        terminator: RuntimeTerminator::Return {
                            value: 0,
                            span: span("math.blot"),
                        },
                    }],
                    span: span("math.blot"),
                },
            ],
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
}
