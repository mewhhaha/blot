use std::borrow::Cow;
use std::cell::{OnceCell, RefCell};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet};

use serde::Serialize;
use wasm_encoder::{
    BlockType, BranchHint, BranchHints, CodeSection, ConstExpr, CustomSection, DataSection,
    EntityType, ExportKind, ExportSection, Function, FunctionSection, GlobalSection, GlobalType,
    Ieee32, Ieee64, ImportSection, InstructionSink, MemorySection, MemoryType, Module, TypeSection,
    ValType,
};
use wasmparser::{BinaryReader, FunctionBody, Operator};

mod allocation;
mod boundary_validation;
mod canonical;
mod lifetimes;
mod managed;
mod suspension;
mod text_cursor;
mod text_search;

use crate::hir::{
    RuntimeExport, RuntimeModule, RuntimeOperationContract, RuntimeType, WireConstant,
};

use crate::continuation::{
    Argument, CallTarget, Continuation as RuntimeContinuation, ContinuationId, Edge,
    Function as RuntimeFunction, FunctionId, Instruction as RuntimeInstruction, SignatureId,
    Transition as RuntimeTransition, ValueId,
};

#[cfg(test)]
use crate::continuation::{Definition as RuntimeParameter, TypeId};

const HEAP_GLOBAL: u32 = 0;
const MAX_STRUCTURED_DUPLICATED_BLOCKS: usize = 128;

#[derive(Clone, Copy)]
struct DynamicHelpers<'a> {
    allocator: allocation::Functions,
    allocation_globals: allocation::Globals,
    managed: &'a managed::ManagedValues,
    canonical: &'a canonical::CanonicalAdapters,
    realloc: u32,
    heap_start: u32,
    text_compare: Option<u32>,
    text_scalar_count: Option<u32>,
    text_next_byte: Option<u32>,
    text_scalar_offset: Option<u32>,
    text_byte_offset: Option<u32>,
    text_find_from: Option<u32>,
    canonical_validator: u32,
    i64_to_text: Option<u32>,
}

struct StaticData {
    text_offsets: HashMap<(FunctionId, ValueId), u32>,
    store_offsets: HashMap<(FunctionId, ValueId), (u32, u32)>,
}

#[derive(Clone, Copy)]
struct Dispatcher {
    local: u32,
    depth: u32,
}

#[derive(Clone, Copy)]
struct PublicExport<'a> {
    parameter_types: &'a [AbiType],
    parameter_runtime_types: &'a [usize],
    result_type: &'a AbiType,
    result_runtime_type: usize,
    call_id: u32,
}

struct DynamicExport<'a> {
    function: &'a RuntimeFunction,
    public: PublicExport<'a>,
}

struct ValueLocalAllocation {
    value_locals: HashMap<ValueId, Vec<u32>>,
    value_types: HashMap<ValueId, usize>,
    local_types: Vec<ValType>,
}

#[derive(Clone, Copy)]
struct FunctionEmissionFacts<'a> {
    runtime_layouts: &'a RuntimeTypeLayouts,
    value_locals: &'a HashMap<ValueId, Vec<u32>>,
    value_types: &'a HashMap<ValueId, usize>,
}

struct RuntimeTypeLayouts {
    flattened: Vec<OnceCell<Vec<ValType>>>,
    product_offsets: Vec<OnceCell<Vec<usize>>>,
    pending: RefCell<HashSet<usize>>,
}

impl RuntimeTypeLayouts {
    fn new(module: &RuntimeModule) -> Result<Self, String> {
        Ok(Self {
            flattened: std::iter::repeat_with(OnceCell::new)
                .take(module.types.len())
                .collect(),
            product_offsets: std::iter::repeat_with(OnceCell::new)
                .take(module.types.len())
                .collect(),
            pending: RefCell::new(HashSet::new()),
        })
    }

    fn flattened<'a>(
        &'a self,
        module: &RuntimeModule,
        type_id: usize,
    ) -> Result<&'a [ValType], String> {
        let cell = self
            .flattened
            .get(type_id)
            .ok_or_else(|| format!("{}: runtime type {type_id} does not exist", module.source))?;
        if let Some(flattened) = cell.get() {
            return Ok(flattened);
        }
        if !self.pending.borrow_mut().insert(type_id) {
            return Err(format!(
                "{}: runtime type {type_id} recursively contains itself without indirection",
                module.source
            ));
        }
        let result = (|| {
            let type_ = module.types.get(type_id).ok_or_else(|| {
                format!("{}: runtime type {type_id} does not exist", module.source)
            })?;
            match type_ {
                RuntimeType::Unit => Ok(Vec::new()),
                RuntimeType::Callback {
                    environment_type, ..
                } => Ok(self.flattened(module, *environment_type)?.to_vec()),
                RuntimeType::Integer32 | RuntimeType::Boolean => Ok(vec![ValType::I32]),
                RuntimeType::SignedInteger64 | RuntimeType::Resource { .. } => {
                    Ok(vec![ValType::I64])
                }
                RuntimeType::Float32 => Ok(vec![ValType::F32]),
                RuntimeType::Float64 => Ok(vec![ValType::F64]),
                RuntimeType::Text | RuntimeType::Store { .. } => {
                    Ok(vec![ValType::I32, ValType::I32, ValType::I32])
                }
                RuntimeType::Scratch { .. } => Ok(vec![ValType::I32; 4]),
                RuntimeType::Indirect { .. } => Ok(vec![ValType::I32]),
                RuntimeType::Vector { .. } | RuntimeType::Mask { .. } => Ok(vec![ValType::V128]),
                RuntimeType::Product { fields, .. } => {
                    let mut result = Vec::new();
                    for field in fields {
                        result.extend_from_slice(self.flattened(module, field.type_id)?);
                    }
                    Ok(result)
                }
                RuntimeType::Sum { cases, .. } => {
                    let mut payload = Vec::new();
                    for case_ in cases {
                        let case = self.flattened(module, case_.payload_type)?;
                        for (index, lane) in case.iter().enumerate() {
                            if index == payload.len() {
                                payload.push(*lane);
                                continue;
                            }
                            if payload[index] != *lane
                                && (payload[index] == ValType::V128 || *lane == ValType::V128)
                            {
                                return Err(format!(
                                    "{}: a sum cannot share a Wasm lane between SIMD and scalar payloads",
                                    module.source
                                ));
                            }
                            payload[index] = join_flat_types(Some(&payload[index]), Some(lane));
                        }
                    }
                    let mut result = vec![ValType::I32];
                    result.extend(payload);
                    Ok(result)
                }
                RuntimeType::Sealed {
                    representation_type,
                    ..
                } => Ok(self.flattened(module, *representation_type)?.to_vec()),
            }
        })();
        self.pending.borrow_mut().remove(&type_id);
        let result = result?;
        cell.set(result).map_err(|_| {
            format!(
                "{}: runtime type {type_id} layout was initialized twice",
                module.source
            )
        })?;
        Ok(cell.get().expect("runtime type layout was initialized"))
    }

    fn product_offset(
        &self,
        module: &RuntimeModule,
        type_id: usize,
        field: usize,
    ) -> Result<usize, String> {
        let cell = self
            .product_offsets
            .get(type_id)
            .ok_or_else(|| format!("{}: runtime type {type_id} does not exist", module.source))?;
        if cell.get().is_none() {
            let Some(RuntimeType::Product { fields, .. }) = module.types.get(type_id) else {
                return Err(format!(
                    "{}: runtime type {type_id} is not a product",
                    module.source
                ));
            };
            let mut offset = 0;
            let mut offsets = Vec::with_capacity(fields.len());
            for product_field in fields {
                offsets.push(offset);
                offset += self.flattened(module, product_field.type_id)?.len();
            }
            cell.set(offsets).map_err(|_| {
                format!(
                    "{}: runtime product type {type_id} offsets were initialized twice",
                    module.source
                )
            })?;
        }
        cell.get()
            .and_then(|offsets| offsets.get(field))
            .copied()
            .ok_or_else(|| {
                format!(
                    "{}: runtime product type {type_id} has no field {field}",
                    module.source
                )
            })
    }
}

#[derive(Hash, PartialEq, Eq)]
struct FunctionType {
    parameters: Vec<ValType>,
    results: Vec<ValType>,
}

struct FunctionTypes {
    section: TypeSection,
    indices: HashMap<FunctionType, u32>,
}

impl FunctionTypes {
    fn new() -> Self {
        Self {
            section: TypeSection::new(),
            indices: HashMap::new(),
        }
    }

    fn intern(&mut self, parameters: Vec<ValType>, results: Vec<ValType>) -> u32 {
        let function_type = FunctionType {
            parameters,
            results,
        };
        if let Some(index) = self.indices.get(&function_type) {
            return *index;
        }
        let index = self.section.len();
        self.section.ty().function(
            function_type.parameters.iter().copied(),
            function_type.results.iter().copied(),
        );
        self.indices.insert(function_type, index);
        index
    }
}

#[derive(Clone)]
pub struct CompiledModule {
    pub wasm: Vec<u8>,
    pub manifest: Vec<u8>,
    pub capabilities: Vec<String>,
}

pub struct ClosedProgram {
    runtime: RuntimeModule,
    runtime_layouts: RuntimeTypeLayouts,
    public_layout: PublicLayout,
    compiled: RefCell<Option<CompiledModule>>,
}

struct PublicLayout {
    manifest: AbiManifest,
    bytes: Vec<u8>,
    capabilities: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum AbiType {
    Unit,
    InternalPointer,
    Vector128,
    #[serde(rename = "signed-integer-64")]
    SignedInteger64,
    #[serde(rename = "float-32")]
    Float32,
    #[serde(rename = "float-64")]
    Float64,
    Boolean,
    Text,
    Callback {
        entry: String,
        function: Box<AbiFunction>,
        environment: Box<AbiType>,
    },
    Resource {
        name: String,
        payload: Box<AbiType>,
    },
    Array {
        element: Box<AbiType>,
    },
    Record {
        fields: Vec<AbiField>,
    },
    Variant {
        cases: Vec<AbiCase>,
    },
    Sealed {
        name: String,
        inner: Box<AbiType>,
    },
}

#[derive(Clone, Serialize)]
struct AbiField {
    name: String,
    #[serde(rename = "type")]
    type_: AbiType,
}

#[derive(Clone, Serialize)]
struct AbiCase {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<AbiType>,
}

#[derive(Clone, Serialize)]
struct AbiFunction {
    parameters: Vec<AbiType>,
    result: AbiType,
}

#[derive(Serialize)]
struct AbiPolicy {
    major: u8,
    minor: u8,
    #[serde(rename = "coreSpecification")]
    core_specification: &'static str,
    #[serde(rename = "requiredFeatures")]
    required_features: Vec<&'static str>,
    #[serde(rename = "optimizationFeatures")]
    optimization_features: Vec<&'static str>,
    memory: &'static str,
    #[serde(rename = "stringEncoding")]
    string_encoding: &'static str,
    #[serde(rename = "maximumFlatParameters")]
    maximum_flat_parameters: u8,
    #[serde(rename = "maximumFlatResults")]
    maximum_flat_results: u8,
    #[serde(rename = "memoryExport")]
    memory_export: &'static str,
    #[serde(rename = "reallocExport")]
    realloc_export: &'static str,
}

#[derive(Serialize)]
struct AbiExport {
    #[serde(rename = "sourceName")]
    source_name: String,
    name: Option<String>,
    phase: &'static str,
    function: Option<AbiFunction>,
    #[serde(rename = "postReturn")]
    post_return: Option<String>,
    effects: Vec<String>,
    ownership: Option<&'static str>,
    execution: &'static str,
}

#[derive(Clone, Serialize)]
struct AbiImport {
    capability: String,
    operation: String,
    #[serde(rename = "sourceName")]
    source_name: String,
    module: String,
    name: String,
    function: AbiFunction,
    contract: RuntimeOperationContract,
}

#[derive(Clone, Serialize)]
struct AbiLink {
    unit: String,
    name: String,
    module: String,
    function: AbiFunction,
    suspends: bool,
}

#[derive(Serialize)]
struct AbiManifest {
    format: &'static str,
    abi: AbiPolicy,
    source: String,
    exports: Vec<AbiExport>,
    imports: Vec<AbiImport>,
    callbacks: Vec<AbiCallback>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    links: Vec<AbiLink>,
}

#[derive(Clone, Serialize)]
struct AbiCallback {
    name: String,
    function: AbiFunction,
}

pub fn close(runtime: RuntimeModule) -> Result<ClosedProgram, String> {
    runtime.graph.validate(runtime.tables())?;
    let runtime_layouts = RuntimeTypeLayouts::new(&runtime)?;
    let manifest = build_manifest(&runtime, &runtime_layouts)?;
    if manifest
        .exports
        .iter()
        .any(|exported| exported.execution == "resumable")
        && manifest.imports.iter().any(|imported| {
            imported.contract.input.has_linear() || imported.contract.result.has_linear()
        })
    {
        return Err(
            "Suspending artifacts with linear host transfers require registered scope cleanup."
                .to_owned(),
        );
    }
    let mut manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("could not serialize Blot ABI manifest: {error}"))?;
    manifest_text.push('\n');
    let bytes = manifest_text.into_bytes();
    let mut capabilities = manifest
        .imports
        .iter()
        .map(|imported| imported.capability.clone())
        .collect::<Vec<_>>();
    capabilities.sort();
    capabilities.dedup();
    Ok(ClosedProgram {
        runtime,
        runtime_layouts,
        public_layout: PublicLayout {
            manifest,
            bytes,
            capabilities,
        },
        compiled: RefCell::new(None),
    })
}

impl ClosedProgram {
    pub fn runtime(&self) -> &RuntimeModule {
        &self.runtime
    }

    pub fn compile(&self) -> Result<CompiledModule, String> {
        if let Some(compiled) = self.compiled.borrow().as_ref() {
            return Ok(compiled.clone());
        }
        let wasm = emit_dynamic_module(
            &self.runtime,
            &self.runtime_layouts,
            &self.public_layout.manifest,
            &self.public_layout.bytes,
        )?;
        let compiled = CompiledModule {
            wasm,
            manifest: self.public_layout.bytes.clone(),
            capabilities: self.public_layout.capabilities.clone(),
        };
        *self.compiled.borrow_mut() = Some(compiled.clone());
        Ok(compiled)
    }
}

fn build_manifest(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
) -> Result<AbiManifest, String> {
    let suspending = module
        .functions
        .iter()
        .filter(|function| function.suspends)
        .map(|function| function.id)
        .collect::<HashSet<_>>();
    let mut exports = Vec::new();
    for exported in &module.exports {
        match exported {
            RuntimeExport::Comptime {
                source_name, phase, ..
            } => exports.push(AbiExport {
                source_name: source_name.clone(),
                name: None,
                phase,
                function: None,
                post_return: None,
                effects: Vec::new(),
                ownership: None,
                execution: "comptime",
            }),
            RuntimeExport::Runtime {
                source_name,
                phase,
                wasm_name,
                signature,
                ownership,
                function: function_id,
                ..
            } => {
                let signature = module.signatures.get(*signature).ok_or_else(|| {
                    format!(
                        "{}: runtime export references unknown signature {signature}",
                        module.source
                    )
                })?;
                let function = AbiFunction {
                    parameters: signature
                        .parameters
                        .iter()
                        .enumerate()
                        .map(|(index, type_id)| {
                            canonical_type(module, *type_id, &mut Vec::new()).map_err(
                                |error| {
                                    format!(
                                        "export '{source_name}' parameter {index} is unsupported: {error}"
                                    )
                                },
                            )
                        })
                        .collect::<Result<_, _>>()?,
                    result: canonical_type(module, signature.result, &mut Vec::new()).map_err(
                        |error| {
                            format!(
                                "export '{source_name}' result is unsupported: {error}"
                            )
                        },
                    )?,
                };
                let post_return = if suspending.contains(&FunctionId(*function_id)) {
                    Some("blot:release".to_owned())
                } else if flattened_type(&function.result).len() > 1 {
                    Some(format!("cabi_post_{wasm_name}"))
                } else {
                    None
                };
                let mut effects = signature.effects.clone();
                effects.sort();
                exports.push(AbiExport {
                    source_name: source_name.clone(),
                    name: Some(wasm_name.clone()),
                    phase,
                    function: Some(function),
                    post_return,
                    effects,
                    ownership: Some(ownership),
                    execution: if suspending.contains(&FunctionId(*function_id)) {
                        "resumable"
                    } else {
                        "direct"
                    },
                });
            }
        }
    }
    let mut imports = Vec::new();
    for capability in &module.capabilities {
        for operation in &capability.operations {
            let signature = module.signatures.get(operation.signature).ok_or_else(|| {
                format!(
                    "{}: capability {}.{} references unknown signature {}",
                    module.source, capability.name, operation.name, operation.signature
                )
            })?;
            imports.push(AbiImport {
                capability: capability.name.clone(),
                operation: operation.name.clone(),
                source_name: operation.source_name.clone(),
                module: format!("blot:host/{}", capability.name),
                name: operation.name.clone(),
                function: AbiFunction {
                    parameters: signature
                        .parameters
                        .iter()
                        .enumerate()
                        .map(|(index, type_id)| {
                            canonical_type(module, *type_id, &mut Vec::new()).map_err(|error| {
                                format!(
                                    "host import '{}.{}' parameter {index} is unsupported: {error}",
                                    capability.name, operation.name
                                )
                            })
                        })
                        .collect::<Result<_, _>>()?,
                    result: canonical_type(module, signature.result, &mut Vec::new()).map_err(
                        |error| {
                            format!(
                                "host import '{}.{}' result is unsupported: {error}",
                                capability.name, operation.name
                            )
                        },
                    )?,
                },
                contract: operation.contract.clone(),
            });
        }
    }
    let required_features = required_wasm_features(module, runtime_layouts)?;
    let links = module
        .links
        .iter()
        .map(|link| {
            let signature = module.signatures.get(link.signature).ok_or_else(|| {
                format!(
                    "{}: development link {}.{} references unknown signature {}",
                    module.source, link.unit, link.name, link.signature
                )
            })?;
            Ok(AbiLink {
                unit: link.unit.clone(),
                name: link.name.clone(),
                module: format!("blot:dev/{}", link.unit),
                suspends: link.suspends,
                function: AbiFunction {
                    parameters: signature
                        .parameters
                        .iter()
                        .enumerate()
                        .map(|(index, type_id)| {
                            canonical_type(module, *type_id, &mut Vec::new()).map_err(|error| {
                                format!(
                                    "development link '{}.{}' parameter {index} is unsupported: {error}",
                                    link.unit, link.name
                                )
                            })
                        })
                        .collect::<Result<_, _>>()?,
                    result: canonical_type(module, signature.result, &mut Vec::new()).map_err(
                        |error| {
                            format!(
                                "development link '{}.{}' result is unsupported: {error}",
                                link.unit, link.name
                            )
                        },
                    )?,
                },
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut callbacks = BTreeMap::new();
    for type_ in &module.types {
        let RuntimeType::Callback {
            function,
            signature,
            ..
        } = type_
        else {
            continue;
        };
        let signature = &module.signatures[*signature];
        callbacks.insert(
            *function,
            AbiCallback {
                name: format!("blot:callback:{function}"),
                function: AbiFunction {
                    parameters: signature
                        .parameters
                        .iter()
                        .map(|type_id| canonical_type(module, *type_id, &mut Vec::new()))
                        .collect::<Result<_, _>>()?,
                    result: canonical_type(module, signature.result, &mut Vec::new())?,
                },
            },
        );
    }
    for callback in callbacks.values() {
        let width = callback
            .function
            .parameters
            .iter()
            .flat_map(flattened_type)
            .count();
        if width > 16 {
            return Err(format!(
                "callback {} requires {width} flat parameters; the callback boundary admits at most 16",
                callback.name
            ));
        }
    }
    Ok(AbiManifest {
        format: "blot-core-wasm",
        abi: AbiPolicy {
            major: 4,
            minor: 0,
            core_specification: "3.0",
            required_features,
            optimization_features: vec!["branch-hinting"],
            memory: "memory32",
            string_encoding: "utf-8",
            maximum_flat_parameters: 16,
            maximum_flat_results: 1,
            memory_export: "memory",
            realloc_export: "cabi_realloc",
        },
        source: module.source.clone(),
        exports,
        imports,
        callbacks: callbacks.into_values().collect(),
        links,
    })
}

fn internally_emitted_runtime_function_ids(module: &RuntimeModule) -> BTreeSet<FunctionId> {
    module
        .functions
        .iter()
        .filter(|function| !function.suspends)
        .map(|function| function.id)
        .collect()
}

struct DirectTailCall<'a> {
    target: FunctionId,
    arguments: &'a [ValueId],
}

fn direct_tail_call<'a>(
    function: &RuntimeFunction,
    continuation: &'a RuntimeContinuation,
) -> Option<DirectTailCall<'a>> {
    let RuntimeTransition::Call {
        target: CallTarget::Function { function: target },
        arguments,
        next,
        ..
    } = &continuation.transition
    else {
        return None;
    };
    function
        .returns_call_result(next)
        .then_some(DirectTailCall {
            target: *target,
            arguments,
        })
}

fn runtime_type_uses_simd(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    type_id: usize,
) -> Result<bool, String> {
    Ok(runtime_layouts
        .flattened(module, type_id)?
        .contains(&ValType::V128))
}

fn required_wasm_features(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
) -> Result<Vec<&'static str>, String> {
    let internal_ids = internally_emitted_runtime_function_ids(module);
    let internal_functions = module
        .functions
        .iter()
        .filter(|function| internal_ids.contains(&function.id))
        .collect::<Vec<_>>();
    let mut features = BTreeSet::new();

    // `cabi_realloc` always contains `memory.copy`, so every emitted artifact
    // requires bulk-memory even when the source does not allocate dynamically.
    features.insert("bulk-memory");

    let helper_uses_multi_value = module.functions.iter().any(|function| {
        function.continuations.iter().any(|block| {
            block
                .instructions
                .iter()
                .any(|operation| operation.operation.kind == "text.from-i64")
        })
    });
    let mut uses_multi_value = helper_uses_multi_value;
    for function in &internal_functions {
        let signature = module.signatures.get(function.signature.0).ok_or_else(|| {
            format!(
                "{}: runtime function {} references unknown signature {}",
                module.source, function.id, function.signature.0
            )
        })?;
        uses_multi_value |= runtime_layouts.flattened(module, signature.result)?.len() > 1;
    }
    if uses_multi_value {
        features.insert("multi-value");
    }

    let mut uses_simd = false;
    for function in &module.functions {
        let signature = module.signatures.get(function.signature.0).ok_or_else(|| {
            format!(
                "{}: runtime function {} references unknown signature {}",
                module.source, function.id, function.signature.0
            )
        })?;
        for type_id in signature
            .parameters
            .iter()
            .copied()
            .chain(std::iter::once(signature.result))
        {
            uses_simd |= runtime_type_uses_simd(module, runtime_layouts, type_id)?;
        }
        for block in &function.continuations {
            for parameter in &block.parameters {
                uses_simd |= runtime_type_uses_simd(module, runtime_layouts, parameter.type_id.0)?;
            }
            for operation in &block.instructions {
                uses_simd |= runtime_type_uses_simd(
                    module,
                    runtime_layouts,
                    operation.definition.type_id.0,
                )?;
            }
        }
    }
    if uses_simd {
        features.insert("simd");
    }

    let uses_tail_calls = internal_functions.iter().any(|function| {
        function.continuations.iter().any(|block| {
            direct_tail_call(function, block)
                .map(|call| call.target)
                .is_some_and(|target| internal_ids.contains(&target))
        })
    });
    if uses_tail_calls {
        features.insert("tail-call");
    }

    Ok(features.into_iter().collect())
}

fn canonical_type(
    module: &RuntimeModule,
    type_id: usize,
    resolving: &mut Vec<usize>,
) -> Result<AbiType, String> {
    runtime_layout_type(module, type_id, resolving, LayoutScope::Public)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum LayoutScope {
    Public,
    Internal,
}

fn internal_memory_type(module: &RuntimeModule, type_id: usize) -> Result<AbiType, String> {
    runtime_layout_type(module, type_id, &mut Vec::new(), LayoutScope::Internal)
}

fn runtime_layout_type(
    module: &RuntimeModule,
    type_id: usize,
    resolving: &mut Vec<usize>,
    scope: LayoutScope,
) -> Result<AbiType, String> {
    if resolving.contains(&type_id) {
        return Err(format!(
            "{}: ABI type {type_id} has a recursive canonical layout",
            module.source
        ));
    }
    let type_ = module
        .types
        .get(type_id)
        .ok_or_else(|| format!("{}: ABI references unknown type {type_id}", module.source))?;
    let scalar = match type_ {
        RuntimeType::Unit => Some(AbiType::Unit),
        RuntimeType::Integer32 if scope == LayoutScope::Internal => Some(AbiType::InternalPointer),
        RuntimeType::Integer32 => {
            return Err(format!(
                "{}: internal integer-32 type {type_id} cannot cross the Blot ABI",
                module.source
            ));
        }
        RuntimeType::SignedInteger64 => Some(AbiType::SignedInteger64),
        RuntimeType::Resource { name, payload_type } => {
            resolving.push(type_id);
            let payload = runtime_layout_type(module, *payload_type, resolving, scope)?;
            resolving.pop();
            Some(AbiType::Resource {
                name: name.clone(),
                payload: Box::new(payload),
            })
        }
        RuntimeType::Float32 => Some(AbiType::Float32),
        RuntimeType::Float64 => Some(AbiType::Float64),
        RuntimeType::Boolean => Some(AbiType::Boolean),
        RuntimeType::Text if scope == LayoutScope::Internal => Some(AbiType::Record {
            fields: ["0", "1", "2"]
                .into_iter()
                .map(|name| AbiField {
                    name: name.to_owned(),
                    type_: AbiType::InternalPointer,
                })
                .collect(),
        }),
        RuntimeType::Text => Some(AbiType::Text),
        _ => None,
    };
    if let Some(scalar) = scalar {
        return Ok(scalar);
    }
    resolving.push(type_id);
    let canonical = match type_ {
        RuntimeType::Callback {
            function,
            signature,
            environment_type,
        } => {
            let signature = &module.signatures[*signature];
            AbiType::Callback {
                entry: format!("blot:callback:{function}"),
                function: Box::new(AbiFunction {
                    parameters: vec![runtime_layout_type(
                        module,
                        signature.parameters[0],
                        resolving,
                        scope,
                    )?],
                    result: runtime_layout_type(module, signature.result, resolving, scope)?,
                }),
                environment: Box::new(runtime_layout_type(
                    module,
                    *environment_type,
                    resolving,
                    scope,
                )?),
            }
        }
        RuntimeType::Store { .. } if scope == LayoutScope::Internal => AbiType::Record {
            fields: ["0", "1", "2"]
                .into_iter()
                .map(|name| AbiField {
                    name: name.to_owned(),
                    type_: AbiType::InternalPointer,
                })
                .collect(),
        },
        RuntimeType::Store { element_type } => AbiType::Array {
            element: Box::new(runtime_layout_type(
                module,
                *element_type,
                resolving,
                scope,
            )?),
        },
        RuntimeType::Scratch { .. } if scope == LayoutScope::Internal => AbiType::Record {
            fields: ["0", "1", "2", "3"]
                .into_iter()
                .map(|name| AbiField {
                    name: name.to_owned(),
                    type_: AbiType::InternalPointer,
                })
                .collect(),
        },
        RuntimeType::Scratch { .. } => {
            return Err(format!(
                "{}: live Scratch type {type_id} cannot cross Blot Core Wasm ABI 4",
                module.source
            ));
        }
        RuntimeType::Indirect { .. } if scope == LayoutScope::Internal => AbiType::InternalPointer,
        RuntimeType::Indirect { .. } => {
            return Err(format!(
                "{}: recursive type {type_id} cannot cross Blot Core Wasm ABI 4",
                module.source
            ));
        }
        RuntimeType::Product { name, .. }
            if name.starts_with("$region:") && scope == LayoutScope::Public =>
        {
            return Err(format!(
                "{}: live Region type {type_id} cannot cross Blot Core Wasm ABI 4",
                module.source
            ));
        }
        RuntimeType::Product { fields, .. } => {
            let mut fields = fields.clone();
            if scope == LayoutScope::Public {
                fields.sort_by(|left, right| left.name.cmp(&right.name));
            }
            AbiType::Record {
                fields: fields
                    .into_iter()
                    .map(|field| {
                        Ok(AbiField {
                            name: field.name,
                            type_: runtime_layout_type(module, field.type_id, resolving, scope)?,
                        })
                    })
                    .collect::<Result<_, String>>()?,
            }
        }
        RuntimeType::Sum { cases, .. } => {
            let mut cases = cases.clone();
            if scope == LayoutScope::Public {
                cases.sort_by(|left, right| left.name.cmp(&right.name));
            }
            AbiType::Variant {
                cases: cases
                    .into_iter()
                    .map(|case_| {
                        let payload =
                            runtime_layout_type(module, case_.payload_type, resolving, scope)?;
                        let payload = if matches!(payload, AbiType::Unit) {
                            None
                        } else {
                            Some(payload)
                        };
                        Ok(AbiCase {
                            name: case_.name,
                            payload,
                        })
                    })
                    .collect::<Result<_, String>>()?,
            }
        }
        RuntimeType::Sealed {
            name,
            representation_type,
        } => AbiType::Sealed {
            name: name.clone(),
            inner: Box::new(runtime_layout_type(
                module,
                *representation_type,
                resolving,
                scope,
            )?),
        },
        RuntimeType::Vector { .. } | RuntimeType::Mask { .. } if scope == LayoutScope::Internal => {
            AbiType::Vector128
        }
        RuntimeType::Vector { .. } | RuntimeType::Mask { .. } => {
            return Err(format!(
                "{}: SIMD type {type_id} cannot cross the Blot ABI",
                module.source
            ));
        }
        RuntimeType::Unit
        | RuntimeType::Integer32
        | RuntimeType::SignedInteger64
        | RuntimeType::Resource { .. }
        | RuntimeType::Float32
        | RuntimeType::Float64
        | RuntimeType::Boolean
        | RuntimeType::Text => unreachable!(),
    };
    resolving.pop();
    Ok(canonical)
}

fn flattened_type(type_: &AbiType) -> Vec<ValType> {
    match type_ {
        AbiType::Unit => Vec::new(),
        AbiType::InternalPointer => vec![ValType::I32],
        AbiType::Vector128 => vec![ValType::V128],
        AbiType::SignedInteger64 | AbiType::Resource { .. } => vec![ValType::I64],
        AbiType::Float32 => vec![ValType::F32],
        AbiType::Float64 => vec![ValType::F64],
        AbiType::Boolean => vec![ValType::I32],
        AbiType::Text | AbiType::Array { .. } => vec![ValType::I32, ValType::I32],
        AbiType::Sealed { inner, .. }
        | AbiType::Callback {
            environment: inner, ..
        } => flattened_type(inner),
        AbiType::Record { fields } => fields
            .iter()
            .flat_map(|field| flattened_type(&field.type_))
            .collect(),
        AbiType::Variant { cases } => {
            let mut payload = Vec::new();
            for case_ in cases {
                let case_payload = case_
                    .payload
                    .as_ref()
                    .map(flattened_type)
                    .unwrap_or_default();
                let length = payload.len().max(case_payload.len());
                let mut joined = Vec::with_capacity(length);
                for index in 0..length {
                    joined.push(join_flat_types(payload.get(index), case_payload.get(index)));
                }
                payload = joined;
            }
            let mut result = vec![ValType::I32];
            result.extend(payload);
            result
        }
    }
}

fn join_flat_types(left: Option<&ValType>, right: Option<&ValType>) -> ValType {
    match (left, right) {
        (None, None) => ValType::I32,
        (Some(left), None) => *left,
        (None, Some(right)) => *right,
        (Some(left), Some(right)) if left == right => *left,
        (Some(ValType::I32 | ValType::F32), Some(ValType::I32 | ValType::F32)) => ValType::I32,
        _ => ValType::I64,
    }
}

// A variant lane stores payload bits, not a numeric conversion of the payload.
fn emit_lane_conversion(
    instructions: &mut InstructionSink<'_>,
    from: ValType,
    to: ValType,
) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let from_bits = match from {
        ValType::I32 => ValType::I32,
        ValType::I64 => ValType::I64,
        ValType::F32 => {
            instructions.i32_reinterpret_f32();
            ValType::I32
        }
        ValType::F64 => {
            instructions.i64_reinterpret_f64();
            ValType::I64
        }
        _ => {
            return Err(format!(
                "unsupported variant lane conversion {from:?} to {to:?}"
            ));
        }
    };
    let to_bits = match to {
        ValType::I32 | ValType::F32 => ValType::I32,
        ValType::I64 | ValType::F64 => ValType::I64,
        _ => {
            return Err(format!(
                "unsupported variant lane conversion {from:?} to {to:?}"
            ));
        }
    };
    if from_bits != to_bits {
        match to_bits {
            ValType::I32 => {
                instructions.i32_wrap_i64();
            }
            ValType::I64 => {
                instructions.i64_extend_i32_u();
            }
            _ => unreachable!(),
        }
    }
    match to {
        ValType::F32 => {
            instructions.f32_reinterpret_i32();
        }
        ValType::F64 => {
            instructions.f64_reinterpret_i64();
        }
        _ => {}
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct FlatLocals<'a> {
    locals: &'a [u32],
    lanes: &'a [ValType],
}

impl<'a> FlatLocals<'a> {
    fn tail(self, start: usize) -> Self {
        Self {
            locals: &self.locals[start..],
            lanes: &self.lanes[start..],
        }
    }

    fn get(
        self,
        instructions: &mut InstructionSink<'_>,
        index: usize,
        lane: ValType,
    ) -> Result<(), String> {
        instructions.local_get(self.locals[index]);
        emit_lane_conversion(instructions, self.lanes[index], lane)
    }

    fn set(
        self,
        instructions: &mut InstructionSink<'_>,
        index: usize,
        lane: ValType,
    ) -> Result<(), String> {
        emit_lane_conversion(instructions, lane, self.lanes[index])?;
        instructions.local_set(self.locals[index]);
        Ok(())
    }
}

fn cold_trap_branch_hints(function: &Function) -> Result<Vec<BranchHint>, String> {
    let body = function.clone().into_raw_body();
    let operators = FunctionBody::new(BinaryReader::new(&body, 0))
        .get_operators_reader()
        .map_err(|error| format!("could not inspect emitted Wasm function: {error}"))?
        .into_iter_with_offsets()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("could not inspect emitted Wasm operator: {error}"))?;
    let mut hints = Vec::new();
    for pair in operators.windows(2) {
        if matches!(&pair[0].0, Operator::If { .. }) && matches!(&pair[1].0, Operator::Unreachable)
        {
            let offset = u32::try_from(pair[0].1)
                .map_err(|_| "emitted Wasm function exceeds branch-hint offset space")?;
            hints.push(BranchHint {
                branch_func_offset: offset,
                branch_hint_value: 0,
            });
        }
    }
    Ok(hints)
}

fn append_code_function(
    code: &mut CodeSection,
    branch_hints: &mut BranchHints,
    function_index: u32,
    function: Function,
) -> Result<(), String> {
    let hints = cold_trap_branch_hints(&function)?;
    if !hints.is_empty() {
        branch_hints.function_hints(function_index, hints);
    }
    code.function(&function);
    Ok(())
}

fn pool_static_data(
    module: &RuntimeModule,
    static_end: &mut u32,
    pooled_data: &mut HashMap<(u32, Vec<u8>), u32>,
    data_segments: &mut Vec<(u32, Vec<u8>)>,
    alignment: u32,
    bytes: Vec<u8>,
) -> Result<u32, String> {
    let key = (alignment, bytes.clone());
    if let Some(offset) = pooled_data.get(&key) {
        return Ok(*offset);
    }
    let offset = static_end
        .checked_add(alignment - 1)
        .map(|end| end / alignment * alignment)
        .ok_or_else(|| format!("{}: static data exceeds memory32", module.source))?;
    let byte_length = u32::try_from(bytes.len())
        .map_err(|_| format!("{}: static data exceeds memory32", module.source))?;
    *static_end = offset
        .checked_add(byte_length)
        .ok_or_else(|| format!("{}: static data exceeds memory32", module.source))?;
    pooled_data.insert(key, offset);
    if !bytes.is_empty() {
        data_segments.push((offset, bytes));
    }
    Ok(offset)
}

fn closed_store_literal_bytes(
    module: &RuntimeModule,
    function: FunctionId,
    operation: &RuntimeInstruction,
    definitions: &HashMap<ValueId, &RuntimeInstruction>,
    text_offsets: &HashMap<(FunctionId, ValueId), u32>,
) -> Result<Option<(u32, Vec<u8>, u32)>, String> {
    let RuntimeType::Store { element_type } = module
        .types
        .get(operation.definition.type_id.0)
        .ok_or_else(|| format!("{}: store.literal has no Store type", module.source))?
    else {
        return Err(format!(
            "{}: store.literal result is not a Store",
            module.source
        ));
    };
    let element_type = *element_type;
    let element_memory_type = internal_memory_type(module, element_type)?;
    let element_layout = memory_layout(&element_memory_type);
    let length = if let Some(store_id) = operation.operation.static_store {
        let store = module.static_stores.get(store_id).ok_or_else(|| {
            format!(
                "{}: store.literal references unknown static Store {store_id}",
                module.source
            )
        })?;
        if store.element_type != element_type {
            return Err(format!(
                "{}: store.literal static Store element type {} does not match {}",
                module.source, store.element_type, element_type
            ));
        }
        store.values.len()
    } else {
        operation.operands.len()
    };
    let byte_length = usize::try_from(element_layout.size)
        .ok()
        .and_then(|stride| stride.checked_mul(length))
        .ok_or_else(|| format!("{}: Store literal exceeds memory32", module.source))?;
    let mut bytes = vec![0; byte_length];
    if let Some(store_id) = operation.operation.static_store {
        let store = &module.static_stores[store_id];
        for (index, value) in store.values.iter().enumerate() {
            let offset = index * element_layout.size as usize;
            if !write_static_constant(module, element_type, value, &mut bytes, offset)? {
                return Ok(None);
            }
        }
    } else {
        let writer = StaticOperationWriter {
            module,
            function,
            definitions,
            text_offsets,
        };
        for (index, operand) in operation.operands.iter().enumerate() {
            let offset = index * element_layout.size as usize;
            if !writer.write(element_type, *operand, &mut bytes, offset)? {
                return Ok(None);
            }
        }
    }
    let length = u32::try_from(length)
        .map_err(|_| format!("{}: Store literal length exceeds memory32", module.source))?;
    Ok(Some((element_layout.alignment, bytes, length)))
}

struct StaticOperationWriter<'a> {
    module: &'a RuntimeModule,
    function: FunctionId,
    definitions: &'a HashMap<ValueId, &'a RuntimeInstruction>,
    text_offsets: &'a HashMap<(FunctionId, ValueId), u32>,
}

impl StaticOperationWriter<'_> {
    fn write(
        &self,
        expected_type: usize,
        value: ValueId,
        destination: &mut [u8],
        offset: usize,
    ) -> Result<bool, String> {
        let Some(operation) = self.definitions.get(&value) else {
            return Ok(false);
        };
        if operation.definition.type_id.0 != expected_type {
            return Err(format!(
                "{}: static value {} has type {}, expected {}",
                self.module.source, value, operation.definition.type_id.0, expected_type
            ));
        }
        if let Some(constant) = &operation.operation.value {
            if matches!(constant, WireConstant::Text(_)) {
                let Some(pointer) = self.text_offsets.get(&(self.function, value)) else {
                    return Err(format!(
                        "{}: static text {} has no pooled address",
                        self.module.source, value
                    ));
                };
                let WireConstant::Text(text) = constant else {
                    unreachable!("guarded static text")
                };
                write_static_bytes(destination, offset, &pointer.to_le_bytes())?;
                let length = u32::try_from(text.len())
                    .map_err(|_| format!("{}: static text exceeds memory32", self.module.source))?;
                write_static_bytes(destination, offset + 4, &length.to_le_bytes())?;
                return Ok(true);
            }
            return write_static_constant(
                self.module,
                expected_type,
                constant,
                destination,
                offset,
            );
        }
        match operation.operation.kind {
            "product.make" => {
                let RuntimeType::Product { fields, .. } = &self.module.types[expected_type] else {
                    return Err(format!(
                        "{}: static product.make has non-product type {}",
                        self.module.source, expected_type
                    ));
                };
                if fields.len() != operation.operands.len() {
                    return Err(format!(
                        "{}: static product.make has {} fields but {} operands",
                        self.module.source,
                        fields.len(),
                        operation.operands.len()
                    ));
                }
                let AbiType::Record {
                    fields: memory_fields,
                } = internal_memory_type(self.module, expected_type)?
                else {
                    return Err(format!(
                        "{}: static product type {} has no record layout",
                        self.module.source, expected_type
                    ));
                };
                for memory_field in record_layout(&memory_fields) {
                    let (field_index, field) = fields
                        .iter()
                        .enumerate()
                        .find(|(_, field)| field.name == memory_field.name)
                        .ok_or_else(|| {
                            format!(
                                "{}: static product memory field `{}` has no runtime field",
                                self.module.source, memory_field.name
                            )
                        })?;
                    let operand = operation.operands[field_index];
                    if !self.write(
                        field.type_id,
                        operand,
                        destination,
                        offset + memory_field.offset as usize,
                    )? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            "sum.make" => {
                let RuntimeType::Sum { cases, .. } = &self.module.types[expected_type] else {
                    return Err(format!(
                        "{}: static sum.make has non-sum type {}",
                        self.module.source, expected_type
                    ));
                };
                let case = operation.operation.case.ok_or_else(|| {
                    format!("{}: static sum.make omitted its case", self.module.source)
                })?;
                let runtime_case = cases.get(case).ok_or_else(|| {
                    format!(
                        "{}: static sum.make case {case} is outside {} cases",
                        self.module.source,
                        cases.len()
                    )
                })?;
                let AbiType::Variant { cases: abi_cases } =
                    internal_memory_type(self.module, expected_type)?
                else {
                    return Err(format!(
                        "{}: static sum type {} has no variant layout",
                        self.module.source, expected_type
                    ));
                };
                let layout = variant_layout(&abi_cases);
                let discriminant = u32::try_from(case)
                    .map_err(|_| format!("{}: static sum case exceeds u32", self.module.source))?
                    .to_le_bytes();
                write_static_bytes(
                    destination,
                    offset,
                    &discriminant[..layout.discriminant_size as usize],
                )?;
                let payload = operation.operands.first().ok_or_else(|| {
                    format!(
                        "{}: static sum.make omitted its payload",
                        self.module.source
                    )
                })?;
                self.write(
                    runtime_case.payload_type,
                    *payload,
                    destination,
                    offset + layout.payload_offset as usize,
                )
            }
            "seal.wrap" | "seal.unwrap" | "callback.make" => {
                let operand = operation.operands.first().ok_or_else(|| {
                    format!(
                        "{}: {} omitted its operand",
                        self.module.source, operation.operation.kind
                    )
                })?;
                let operand_type = self
                    .definitions
                    .get(operand)
                    .map(|operation| operation.definition.type_id.0)
                    .ok_or_else(|| {
                        format!(
                            "{}: {} operand {} is absent",
                            self.module.source, operation.operation.kind, operand
                        )
                    })?;
                self.write(operand_type, *operand, destination, offset)
            }
            _ => Ok(false),
        }
    }
}

fn write_static_constant(
    module: &RuntimeModule,
    expected_type: usize,
    constant: &WireConstant,
    destination: &mut [u8],
    offset: usize,
) -> Result<bool, String> {
    let bytes = match (module.types.get(expected_type), constant) {
        (Some(RuntimeType::Unit), WireConstant::Unit) => Vec::new(),
        (Some(RuntimeType::Boolean), WireConstant::Boolean(value)) => vec![u8::from(*value)],
        (Some(RuntimeType::Integer32), WireConstant::SignedInteger32(value)) => {
            value.to_le_bytes().to_vec()
        }
        (Some(RuntimeType::SignedInteger64), WireConstant::SignedInteger64(value)) => value
            .parse::<i64>()
            .map_err(|error| format!("{}: invalid residual i64 {value}: {error}", module.source))?
            .to_le_bytes()
            .to_vec(),
        (Some(RuntimeType::Float32), WireConstant::Float32(value)) => {
            value.to_bits().to_le_bytes().to_vec()
        }
        (Some(RuntimeType::Float64), WireConstant::Float64(value)) => {
            value.to_bits().to_le_bytes().to_vec()
        }
        _ => return Ok(false),
    };
    write_static_bytes(destination, offset, &bytes)?;
    Ok(true)
}

fn write_static_bytes(destination: &mut [u8], offset: usize, bytes: &[u8]) -> Result<(), String> {
    let destination_length = destination.len();
    let end = offset
        .checked_add(bytes.len())
        .ok_or_else(|| "static value offset overflowed usize".to_owned())?;
    let target = destination.get_mut(offset..end).ok_or_else(|| {
        format!(
            "static value byte range {offset}..{end} exceeds {} bytes",
            destination_length
        )
    })?;
    target.copy_from_slice(bytes);
    Ok(())
}

fn emit_dynamic_module(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    manifest: &AbiManifest,
    manifest_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let mut static_end = 1_024_u32;
    let mut static_data = StaticData {
        text_offsets: HashMap::new(),
        store_offsets: HashMap::new(),
    };
    let mut pooled_data = HashMap::new();
    let mut data_segments = Vec::new();
    for function in &module.functions {
        for block in &function.continuations {
            for operation in &block.instructions {
                if let Some(WireConstant::Text(value)) = &operation.operation.value {
                    let offset = pool_static_data(
                        module,
                        &mut static_end,
                        &mut pooled_data,
                        &mut data_segments,
                        1,
                        value.as_bytes().to_vec(),
                    )?;
                    static_data
                        .text_offsets
                        .insert((function.id, operation.definition.value), offset);
                }
            }
        }
    }
    for function in &module.functions {
        let definitions = function
            .continuations
            .iter()
            .flat_map(|block| block.instructions.iter())
            .map(|operation| (operation.definition.value, operation))
            .collect::<HashMap<_, _>>();
        for block in &function.continuations {
            for operation in &block.instructions {
                if operation.operation.kind != "store.literal" {
                    continue;
                }
                let Some((alignment, bytes, length)) = closed_store_literal_bytes(
                    module,
                    function.id,
                    operation,
                    &definitions,
                    &static_data.text_offsets,
                )?
                else {
                    continue;
                };
                let offset = pool_static_data(
                    module,
                    &mut static_end,
                    &mut pooled_data,
                    &mut data_segments,
                    alignment,
                    bytes,
                )?;
                static_data
                    .store_offsets
                    .insert((function.id, operation.definition.value), (offset, length));
            }
        }
    }
    let heap_start = align_to(static_end, 8);

    let mut types = FunctionTypes::new();
    let mut imports = ImportSection::new();
    for imported in &manifest.imports {
        let mut parameters = imported
            .function
            .parameters
            .iter()
            .flat_map(flattened_type)
            .collect::<Vec<_>>();
        parameters.insert(0, ValType::I32);
        let flattened_results = flattened_type(&imported.function.result);
        let results = if flattened_results.len() <= 1 {
            flattened_results
        } else {
            parameters.push(ValType::I32);
            Vec::new()
        };
        let type_index = types.intern(parameters, results);
        imports.import(
            &imported.module,
            &imported.name,
            EntityType::Function(type_index),
        );
    }
    for link in &manifest.links {
        let mut parameters = link
            .function
            .parameters
            .iter()
            .flat_map(flattened_type)
            .collect::<Vec<_>>();
        parameters.insert(0, ValType::I32);
        let flattened_results = flattened_type(&link.function.result);
        let results = if flattened_results.len() <= 1 {
            flattened_results
        } else {
            parameters.push(ValType::I32);
            Vec::new()
        };
        let type_index = types.intern(parameters, results);
        imports.import(
            &link.module,
            &format!("blot:dev:{}", link.name),
            EntityType::Function(type_index),
        );
    }

    let mut functions = FunctionSection::new();
    let mut code = CodeSection::new();
    let mut branch_hints = BranchHints::new();
    let imported_function_count = (manifest.imports.len() + manifest.links.len()) as u32;
    let mut globals = GlobalSection::new();
    add_i32_global(&mut globals, heap_start as i32, true);
    add_i32_global(&mut globals, 4, false);
    add_i32_global(&mut globals, 0, false);
    let allocation_globals = allocation::Globals::append(&mut globals, HEAP_GLOBAL);
    let allocator =
        allocation::Functions::declare(&mut types, &mut functions, imported_function_count);
    let managed = managed::ManagedValues::declare(
        module,
        runtime_layouts,
        &mut types,
        &mut functions,
        imported_function_count,
    )?;
    let canonical = canonical::CanonicalAdapters::declare(
        module,
        runtime_layouts,
        &mut types,
        &mut functions,
        imported_function_count,
    )?;
    allocator.emit(
        &mut code,
        &mut branch_hints,
        allocation_globals,
        heap_start,
        managed.drop_children,
    )?;
    managed.emit(
        module,
        runtime_layouts,
        allocator,
        &mut code,
        &mut branch_hints,
    )?;
    canonical.emit(
        module,
        runtime_layouts,
        allocator,
        allocation_globals,
        &mut code,
        &mut branch_hints,
    )?;
    let realloc_index = allocator.alloc;

    let has_operation = |kind: &str| {
        module.functions.iter().any(|function| {
            function.continuations.iter().any(|block| {
                block
                    .instructions
                    .iter()
                    .any(|operation| operation.operation.kind == kind)
            })
        })
    };
    let text_compare_index = if has_operation("text.compare") {
        let type_index = types.intern(
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
            vec![ValType::I32],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            text_compare_function(),
        )?;
        Some(function_index)
    } else {
        None
    };
    let text_scalar_count_index = if has_operation("text.length") || has_operation("text.find-from")
    {
        let type_index = types.intern(vec![ValType::I32, ValType::I32], vec![ValType::I64]);
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&text_scalar_count_function());
        Some(function_index)
    } else {
        None
    };
    let text_next_byte_index = if has_operation("text.next-byte") {
        let type_index = types.intern(
            vec![ValType::I32, ValType::I32, ValType::I64],
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I64],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&text_cursor::next_byte_function());
        Some(function_index)
    } else {
        None
    };
    let text_byte_offset_index =
        if has_operation("text.slice-bytes") || has_operation("text.find-byte-from") {
            let type_index = types.intern(
                vec![ValType::I32, ValType::I32, ValType::I64],
                vec![ValType::I32],
            );
            let function_index = imported_function_count + functions.len();
            functions.function(type_index);
            code.function(&text_cursor::byte_offset_function());
            Some(function_index)
        } else {
            None
        };
    let text_scalar_offset_index = if has_operation("text.scalar-at")
        || has_operation("text.slice")
        || has_operation("text.find-from")
    {
        let type_index = types.intern(
            vec![ValType::I32, ValType::I32, ValType::I64],
            vec![ValType::I32],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&text_scalar_offset_function());
        Some(function_index)
    } else {
        None
    };
    let text_find_from_index = if has_operation("text.find-from")
        || has_operation("text.contains")
        || has_operation("text.find-byte-from")
    {
        let type_index = types.intern(
            vec![
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
            ],
            vec![ValType::I32],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&text_search::function());
        Some(function_index)
    } else {
        None
    };
    let utf8_validator_index = {
        let type_index = types.intern(vec![ValType::I32, ValType::I32], Vec::new());
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            utf8_validator_function(),
        )?;
        function_index
    };
    let i64_to_text_index = if has_operation("text.from-i64") {
        let type_index = types.intern(
            vec![ValType::I64],
            vec![ValType::I32, ValType::I32, ValType::I32],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            i64_to_text_function(realloc_index),
        )?;
        Some(function_index)
    } else {
        None
    };
    let canonical_validator_index = {
        let type_index = types.intern(vec![ValType::I32, ValType::I32], Vec::new());
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            boundary_validation::function(module, function_index, utf8_validator_index)?,
        )?;
        function_index
    };
    let dynamic_helpers = DynamicHelpers {
        allocator,
        allocation_globals,
        managed: &managed,
        canonical: &canonical,
        realloc: realloc_index,
        heap_start,
        text_compare: text_compare_index,
        text_scalar_count: text_scalar_count_index,
        text_next_byte: text_next_byte_index,
        text_scalar_offset: text_scalar_offset_index,
        text_byte_offset: text_byte_offset_index,
        text_find_from: text_find_from_index,
        canonical_validator: canonical_validator_index,
        i64_to_text: i64_to_text_index,
    };

    let suspending = module
        .functions
        .iter()
        .filter(|function| function.suspends)
        .map(|function| function.id)
        .collect::<HashSet<_>>();
    let mut runtime_function_indices = HashMap::new();
    let internal_functions = module
        .functions
        .iter()
        .filter(|function| !function.suspends)
        .collect::<Vec<_>>();
    for function in &internal_functions {
        let signature = module.signatures.get(function.signature.0).ok_or_else(|| {
            format!(
                "{}: runtime function {} references unknown signature {}",
                module.source, function.id, function.signature.0
            )
        })?;
        let mut parameters = Vec::new();
        for type_id in &signature.parameters {
            parameters.extend_from_slice(runtime_layouts.flattened(module, *type_id)?);
        }
        let results = runtime_layouts
            .flattened(module, signature.result)?
            .to_vec();
        let type_index = types.intern(parameters, results);
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        runtime_function_indices.insert(function.id, function_index);
    }
    for function in internal_functions {
        let function_index = *runtime_function_indices.get(&function.id).ok_or_else(|| {
            format!(
                "{}: runtime function {} has no emitted function index",
                module.source, function.id
            )
        })?;
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            dynamic_internal_function(
                module,
                runtime_layouts,
                function,
                manifest,
                dynamic_helpers,
                &static_data,
                &runtime_function_indices,
            )?,
        )?;
    }

    let mut function_exports = suspension::emit(
        module,
        runtime_layouts,
        manifest,
        dynamic_helpers,
        &static_data,
        &runtime_function_indices,
        &mut types,
        &mut functions,
        &mut code,
        &mut branch_hints,
        imported_function_count,
    )?;
    for (export_ordinal, exported) in module.exports.iter().enumerate() {
        let RuntimeExport::Runtime {
            wasm_name,
            function,
            signature,
            ..
        } = exported
        else {
            continue;
        };
        let runtime_function = module.functions.get(*function).ok_or_else(|| {
            format!(
                "{}: runtime export references unknown function {function}",
                module.source
            )
        })?;
        let signature = module.signatures.get(*signature).ok_or_else(|| {
            format!(
                "{}: runtime export references unknown signature {signature}",
                module.source
            )
        })?;
        let manifest_export = manifest
            .exports
            .iter()
            .find(|candidate| candidate.name.as_deref() == Some(wasm_name))
            .ok_or_else(|| format!("manifest omitted runtime export {wasm_name}"))?;
        let public_function = manifest_export
            .function
            .as_ref()
            .ok_or_else(|| format!("manifest export {wasm_name} has no function"))?;
        let result = &public_function.result;
        if suspending.contains(&FunctionId(*function)) {
            continue;
        }
        let flattened_result = flattened_type(result);
        let wasm_results = if flattened_result.len() <= 1 {
            flattened_result
        } else {
            vec![ValType::I32]
        };
        let wasm_parameters = std::iter::once(ValType::I32)
            .chain(public_function.parameters.iter().flat_map(flattened_type))
            .collect();
        let type_index = types.intern(wasm_parameters, wasm_results);
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            dynamic_export_function(
                module,
                runtime_layouts,
                DynamicExport {
                    function: runtime_function,
                    public: PublicExport {
                        parameter_types: &public_function.parameters,
                        parameter_runtime_types: &signature.parameters,
                        result_type: result,
                        result_runtime_type: signature.result,
                        call_id: export_ordinal as u32 + 1,
                    },
                },
                manifest,
                dynamic_helpers,
                &static_data,
                &runtime_function_indices,
            )?,
        )?;
        function_exports.push((wasm_name.clone(), function_index));
        if let Some(post_return) = &manifest_export.post_return {
            let post_type = types.intern(vec![ValType::I32, ValType::I32], Vec::new());
            let post_index = imported_function_count + functions.len();
            functions.function(post_type);
            append_code_function(
                &mut code,
                &mut branch_hints,
                post_index,
                post_return_function(export_ordinal as u32 + 1, dynamic_helpers),
            )?;
            function_exports.push((post_return.clone(), post_index));
        }
    }

    let minimum_pages = u64::from(heap_start).div_ceil(65_536).max(1);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: minimum_pages,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });

    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("cabi_realloc", ExportKind::Func, allocator.realloc);
    exports.export("cabi_enter", ExportKind::Func, allocator.enter);
    exports.export("cabi_leave", ExportKind::Func, allocator.leave);
    exports.export("blot:live-bytes", ExportKind::Func, allocator.live_bytes);
    exports.export(
        "blot:live-allocations",
        ExportKind::Func,
        allocator.live_allocations,
    );
    exports.export("blot:live-scopes", ExportKind::Func, allocator.live_scopes);
    exports.export("blot:abi-major", ExportKind::Global, 1);
    exports.export("blot:abi-minor", ExportKind::Global, 2);
    for (name, function) in function_exports {
        exports.export(&name, ExportKind::Func, function);
    }

    let mut data = DataSection::new();
    for (offset, contents) in data_segments {
        data.active(0, &ConstExpr::i32_const(offset as i32), contents);
    }
    let mut wasm = Module::new();
    wasm.section(&types.section);
    if !manifest.imports.is_empty() || !manifest.links.is_empty() {
        wasm.section(&imports);
    }
    wasm.section(&functions)
        .section(&memories)
        .section(&globals)
        .section(&exports);
    if !branch_hints.is_empty() {
        wasm.section(&branch_hints);
    }
    wasm.section(&code);
    if !data.is_empty() {
        wasm.section(&data);
    }
    wasm.section(&CustomSection {
        name: Cow::Borrowed("blot:abi"),
        data: Cow::Borrowed(manifest_bytes),
    });
    Ok(wasm.finish())
}

fn allocate_value_locals(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    function: &RuntimeFunction,
    parameter_count: u32,
    mut value_locals: HashMap<ValueId, Vec<u32>>,
) -> Result<ValueLocalAllocation, String> {
    let mut definitions = BTreeMap::new();
    let mut value_types = HashMap::new();
    for block in &function.continuations {
        for parameter in &block.parameters {
            value_types.insert(parameter.value, parameter.type_id.0);
            if !value_locals.contains_key(&parameter.value) {
                definitions.insert(parameter.value, parameter.type_id.0);
            }
        }
        for operation in &block.instructions {
            value_types.insert(operation.definition.value, operation.definition.type_id.0);
            definitions.insert(operation.definition.value, operation.definition.type_id.0);
        }
    }

    let live_in = function
        .continuations
        .iter()
        .map(|continuation| {
            (
                continuation.id,
                continuation
                    .parameters
                    .iter()
                    .chain(&continuation.captures)
                    .map(|definition| definition.value)
                    .collect::<HashSet<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();
    let live_out = function
        .continuations
        .iter()
        .map(|continuation| {
            let mut values = terminator_operands(&continuation.transition)
                .into_iter()
                .collect::<HashSet<_>>();
            for edge in continuation.transition.edges() {
                values.extend(
                    function.continuations[edge.target.0]
                        .captures
                        .iter()
                        .map(|capture| capture.value),
                );
            }
            (continuation.id, values)
        })
        .collect::<HashMap<_, _>>();

    let mut block_positions = HashMap::new();
    let mut value_ranges = HashMap::new();
    let mut next_position = 0_usize;
    for block in &function.continuations {
        let block_start = next_position;
        for parameter in &block.parameters {
            if definitions.contains_key(&parameter.value) {
                value_ranges.insert(parameter.value, (block_start, block_start));
            }
        }
        for operation in &block.instructions {
            next_position += 1;
            value_ranges.insert(operation.definition.value, (next_position, next_position));
        }
        next_position += 1;
        block_positions.insert(block.id, (block_start, next_position));
    }
    for block in &function.continuations {
        let (block_start, block_end) =
            block_positions.get(&block.id).copied().ok_or_else(|| {
                format!(
                    "{}: function {} omitted positions for block {}",
                    module.source, function.name, block.id
                )
            })?;
        let block_live_in = live_in.get(&block.id).ok_or_else(|| {
            format!(
                "{}: function {} omitted live-in facts for block {}",
                module.source, function.name, block.id
            )
        })?;
        let block_live_out = live_out.get(&block.id).ok_or_else(|| {
            format!(
                "{}: function {} omitted live-out facts for block {}",
                module.source, function.name, block.id
            )
        })?;
        for value in block_live_in {
            if let Some(range) = value_ranges.get_mut(value) {
                range.0 = range.0.min(block_start);
            }
        }
        for value in block_live_out {
            if let Some(range) = value_ranges.get_mut(value) {
                range.1 = range.1.max(block_end);
            }
        }
        for (index, operation) in block.instructions.iter().enumerate() {
            let position = block_start + index + 1;
            for operand in &operation.operands {
                if let Some(range) = value_ranges.get_mut(operand) {
                    range.0 = range.0.min(position);
                    range.1 = range.1.max(position);
                }
            }
        }
        // A call writes its result before the successor's parallel edge copy.
        // Keep that destination distinct from every value still needed by the edge.
        if let RuntimeTransition::Call { next, .. } = &block.transition {
            for (argument, parameter) in next
                .arguments
                .iter()
                .zip(&function.continuations[next.target.0].parameters)
            {
                if matches!(argument, Argument::Result) {
                    let range = value_ranges
                        .get_mut(&parameter.value)
                        .expect("call result parameter has an allocated live range");
                    range.0 = range.0.min(block_end);
                }
            }
        }
        for operand in terminator_operands(&block.transition) {
            if let Some(range) = value_ranges.get_mut(&operand) {
                range.0 = range.0.min(block_end);
                range.1 = range.1.max(block_end);
            }
        }
    }

    let mut layout_groups = Vec::<(Vec<ValType>, Vec<ValueId>)>::new();
    let mut layout_group_indices: HashMap<Vec<ValType>, usize> = HashMap::new();
    for (value, type_id) in definitions {
        let layout = runtime_layouts.flattened(module, type_id)?.to_vec();
        if let Some(index) = layout_group_indices.get(&layout).copied() {
            layout_groups[index].1.push(value);
        } else {
            layout_group_indices.insert(layout.clone(), layout_groups.len());
            layout_groups.push((layout, vec![value]));
        }
    }

    let mut local_types = Vec::new();
    for (layout, mut values) in layout_groups {
        values.sort_by_key(|value| {
            let range = value_ranges
                .get(value)
                .expect("every allocated value has a live range");
            (range.0, *value)
        });
        let mut colors: Vec<Vec<u32>> = Vec::new();
        let mut active = BinaryHeap::<Reverse<(usize, usize)>>::new();
        let mut available = BTreeSet::new();
        for value in values {
            let (start, end) = value_ranges.get(&value).copied().ok_or_else(|| {
                format!(
                    "{}: function {} omitted a live range for value {value}",
                    module.source, function.name
                )
            })?;
            while let Some(Reverse((active_end, color))) = active.peek().copied() {
                if active_end >= start {
                    break;
                }
                active.pop();
                available.insert(color);
            }
            let color = if let Some(color) = available.pop_first() {
                color
            } else {
                let local_offset = u32::try_from(local_types.len()).map_err(|_| {
                    format!(
                        "{}: function {} requires more than memory32 locals",
                        module.source, function.name
                    )
                })?;
                let local_start = parameter_count.checked_add(local_offset).ok_or_else(|| {
                    format!(
                        "{}: function {} local index exceeds memory32",
                        module.source, function.name
                    )
                })?;
                let width = u32::try_from(layout.len()).map_err(|_| {
                    format!(
                        "{}: function {} local layout exceeds memory32",
                        module.source, function.name
                    )
                })?;
                let local_end = local_start.checked_add(width).ok_or_else(|| {
                    format!(
                        "{}: function {} local range exceeds memory32",
                        module.source, function.name
                    )
                })?;
                let color = colors.len();
                colors.push((local_start..local_end).collect());
                local_types.extend(&layout);
                color
            };
            value_locals.insert(value, colors[color].clone());
            active.push(Reverse((end, color)));
        }
    }
    Ok(ValueLocalAllocation {
        value_locals,
        value_types,
        local_types,
    })
}

fn terminator_operands(transition: &RuntimeTransition) -> Vec<ValueId> {
    let mut values = transition.uses();
    for edge in transition.edges() {
        values.extend(edge.arguments.iter().filter_map(|argument| match argument {
            Argument::Value(value) => Some(*value),
            Argument::Result => None,
        }));
    }
    values
}

fn compact_local_declarations(local_types: &[ValType]) -> Vec<(u32, ValType)> {
    let mut declarations = Vec::new();
    for type_ in local_types {
        if let Some((count, previous)) = declarations.last_mut()
            && previous == type_
        {
            *count += 1;
            continue;
        }
        declarations.push((1, *type_));
    }
    declarations
}

fn dynamic_internal_function(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    function: &RuntimeFunction,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    runtime_function_indices: &HashMap<FunctionId, u32>,
) -> Result<Function, String> {
    let signature = module.signatures.get(function.signature.0).ok_or_else(|| {
        format!(
            "{}: runtime function {} references unknown signature {}",
            module.source, function.id, function.signature.0
        )
    })?;
    let entry = function
        .continuations
        .iter()
        .find(|block| block.id == function.entry)
        .ok_or_else(|| {
            format!(
                "{}: runtime function {} has no entry block {}",
                module.source, function.id, function.entry
            )
        })?;
    if entry.parameters.len() != signature.parameters.len() {
        return Err(format!(
            "{}: runtime function {} has {} entry parameters for a {}-parameter signature",
            module.source,
            function.id,
            entry.parameters.len(),
            signature.parameters.len()
        ));
    }

    let mut value_locals = HashMap::new();
    let mut parameter_count = 0_u32;
    for (parameter, type_id) in entry.parameters.iter().zip(&signature.parameters) {
        if parameter.type_id.0 != *type_id {
            return Err(format!(
                "{}: runtime function {} entry parameter type does not match its signature",
                module.source, function.id
            ));
        }
        let flattened = runtime_layouts.flattened(module, *type_id)?;
        value_locals.insert(
            parameter.value,
            (parameter_count..parameter_count + flattened.len() as u32).collect(),
        );
        parameter_count += flattened.len() as u32;
    }

    let allocation = allocate_value_locals(
        module,
        runtime_layouts,
        function,
        parameter_count,
        value_locals,
    )?;
    let value_locals = allocation.value_locals;
    let value_types = allocation.value_types;
    let mut local_types = allocation.local_types;
    let control_flow = structured_control_flow(function);
    let dispatcher = if control_flow.is_some() {
        None
    } else {
        let dispatcher = parameter_count + local_types.len() as u32;
        local_types.push(ValType::I32);
        Some(dispatcher)
    };
    let scratch_pointer = parameter_count + local_types.len() as u32;
    local_types.push(ValType::I32);
    let scratch_length = parameter_count + local_types.len() as u32;
    local_types.push(ValType::I32);
    let scratch_index = parameter_count + local_types.len() as u32;
    local_types.push(ValType::I32);

    let facts = FunctionEmissionFacts {
        runtime_layouts,
        value_locals: &value_locals,
        value_types: &value_types,
    };

    let mut wasm_function = Function::new(compact_local_declarations(&local_types));
    let mut instructions = wasm_function.instructions();
    match control_flow {
        Some(StructuredControlFlow::EntryLoop) => {
            instructions.loop_(BlockType::Empty);
            emit_structured_block(
                &mut instructions,
                module,
                function,
                function.entry,
                manifest,
                helpers,
                static_data,
                facts,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                0,
            )?;
            instructions.unreachable().end().unreachable().end();
        }
        Some(StructuredControlFlow::Acyclic) => {
            emit_structured_block(
                &mut instructions,
                module,
                function,
                function.entry,
                manifest,
                helpers,
                static_data,
                facts,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                0,
            )?;
            instructions.unreachable().end();
        }
        None => {
            let dispatcher = dispatcher.expect("dispatcher loop omitted its state local");
            instructions
                .i32_const(function.entry.0 as i32)
                .local_set(dispatcher)
                .block(BlockType::Empty)
                .loop_(BlockType::Empty);
            for _ in &function.continuations {
                instructions.block(BlockType::Empty);
            }
            instructions.local_get(dispatcher).br_table(
                (0..function.continuations.len() as u32).rev(),
                function.continuations.len() as u32 + 1,
            );
            for block in function.continuations.iter().rev() {
                instructions.end();
                let lifetimes = lifetimes::ContinuationLifetimes::new(function, block);
                release_roots(
                    &mut instructions,
                    module,
                    &lifetimes.entry_drops,
                    facts,
                    helpers,
                )?;
                let tail_call = direct_tail_call(function, block);
                for (index, operation) in block.instructions.iter().enumerate() {
                    emit_instruction(
                        &mut instructions,
                        module,
                        function,
                        operation,
                        helpers,
                        static_data,
                        facts,
                        scratch_pointer,
                        scratch_length,
                        scratch_index,
                    )?;
                    release_roots(
                        &mut instructions,
                        module,
                        &lifetimes.instruction_drops[index],
                        facts,
                        helpers,
                    )?;
                }
                if let Some(operation) = tail_call {
                    transfer_roots(
                        &mut instructions,
                        module,
                        &lifetimes.transition_roots,
                        operation.arguments.iter().copied(),
                        facts,
                        helpers,
                    )?;
                    emit_direct_tail_call(
                        &mut instructions,
                        module,
                        function,
                        operation,
                        facts,
                        runtime_function_indices,
                    )?;
                } else {
                    emit_transition_call(
                        &mut instructions,
                        module,
                        function,
                        &block.transition,
                        manifest,
                        helpers,
                        facts,
                        scratch_pointer,
                        scratch_length,
                        runtime_function_indices,
                        &lifetimes.transition_roots,
                    )?;
                    emit_dispatch_transition(
                        &mut instructions,
                        module,
                        function,
                        &block.transition,
                        facts,
                        Dispatcher {
                            local: dispatcher,
                            depth: block.id.0 as u32,
                        },
                        &lifetimes.transition_roots,
                        helpers,
                    )?;
                }
            }
            instructions.end().end().unreachable().end();
        }
    }
    Ok(wasm_function)
}

fn dynamic_export_function(
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    exported: DynamicExport<'_>,
    _manifest: &AbiManifest,
    helpers: DynamicHelpers,
    _static_data: &StaticData,
    runtime_function_indices: &HashMap<FunctionId, u32>,
) -> Result<Function, String> {
    let DynamicExport { function, public } = exported;
    let parameter_count = 1 + public
        .parameter_types
        .iter()
        .map(|type_| flattened_type(type_).len() as u32)
        .sum::<u32>();
    let pointer = parameter_count;
    let mut local_types = vec![ValType::I32];
    let mut arguments = Vec::new();
    for type_id in public.parameter_runtime_types {
        let lanes = runtime_layouts.flattened(module, *type_id)?;
        let first = parameter_count + local_types.len() as u32;
        arguments.push((first..first + lanes.len() as u32).collect::<Vec<_>>());
        local_types.extend_from_slice(lanes);
    }
    let result_lanes = runtime_layouts.flattened(module, public.result_runtime_type)?;
    let first = parameter_count + local_types.len() as u32;
    let result = (first..first + result_lanes.len() as u32).collect::<Vec<_>>();
    local_types.extend_from_slice(result_lanes);
    let public_lanes = flattened_type(public.result_type);
    let mut body = Function::new(compact_local_declarations(&local_types));
    let mut ins = body.instructions();
    ins.local_get(0).call(helpers.allocator.select);
    begin_call(&mut ins, public.call_id, helpers);
    let mut first = 1;
    for ((type_id, public_type), private) in public
        .parameter_runtime_types
        .iter()
        .zip(public.parameter_types)
        .zip(&arguments)
    {
        let width = flattened_type(public_type).len() as u32;
        let incoming = (first..first + width).collect::<Vec<_>>();
        first += width;
        if !helpers.managed.values[type_id].owns_memory {
            emit_lower_flat_value(
                &mut ins,
                module,
                runtime_layouts,
                *type_id,
                public_type,
                &incoming,
                private,
            )?;
            continue;
        }
        let layout = memory_layout(public_type);
        ins.i32_const(0)
            .i32_const(0)
            .i32_const(layout.alignment as i32)
            .i32_const(layout.size.max(1) as i32)
            .call(helpers.allocator.alloc)
            .local_set(pointer);
        let mut flat = 0;
        emit_store_canonical_result(&mut ins, public_type, &incoming, &mut flat, pointer, 0)?;
        ins.local_get(pointer)
            .i32_const(*type_id as i32)
            .call(helpers.canonical_validator);
        ins.local_get(pointer)
            .call(helpers.canonical.types[type_id].lower);
        for local in private.iter().rev() {
            ins.local_set(*local);
        }
        ins.local_get(pointer).call(helpers.allocator.release);
    }
    ins.local_get(0).call(helpers.allocator.clear_temporaries);
    for argument in &arguments {
        emit_local_values(&mut ins, argument);
    }
    ins.call(runtime_function_indices[&function.id]);
    for local in result.iter().rev() {
        ins.local_set(*local);
    }
    if public_lanes.len() <= 1 && !helpers.managed.values[&public.result_runtime_type].owns_memory {
        finish_call(&mut ins, helpers);
        emit_direct_canonical_value(
            &mut ins,
            module,
            runtime_layouts,
            public.result_runtime_type,
            public.result_type,
            &result,
        )?;
    } else {
        let layout = memory_layout(public.result_type);
        ins.local_get(0)
            .i32_const(0)
            .i32_const(0)
            .i32_const(layout.alignment as i32)
            .i32_const(layout.size.max(1) as i32)
            .call(helpers.allocator.realloc)
            .local_set(pointer);
        ins.local_get(pointer);
        emit_local_values(&mut ins, &result);
        ins.call(helpers.canonical.types[&public.result_runtime_type].upper);
        emit_local_values(&mut ins, &result);
        ins.call(helpers.managed.values[&public.result_runtime_type].release);
        ins.global_get(helpers.allocation_globals.current_scope)
            .local_get(pointer)
            .i32_store(allocation_mem(allocation::SCOPE_RESULT));
        ins.local_get(pointer);
    }
    ins.end();
    Ok(body)
}

#[allow(clippy::too_many_arguments)]
fn emit_call(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    target: &CallTarget,
    signature: SignatureId,
    arguments: &[ValueId],
    result: &[u32],
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    facts: FunctionEmissionFacts<'_>,
    scratch_pointer: u32,
    scratch_length: u32,
    runtime_function_indices: &HashMap<FunctionId, u32>,
) -> Result<(), String> {
    if let CallTarget::Function { function } = target {
        let index = runtime_function_indices.get(function).ok_or_else(|| {
            format!(
                "{}: direct call references unavailable function {function}",
                module.source
            )
        })?;
        for argument in arguments {
            emit_local_values(
                instructions,
                locals_for(module, facts.value_locals, *argument)?,
            );
        }
        instructions.call(*index);
        for local in result.iter().rev() {
            instructions.local_set(*local);
        }
        return Ok(());
    }
    let (index, imported) = match target {
        CallTarget::Host {
            capability,
            operation,
        } => {
            let (index, imported) = manifest
                .imports
                .iter()
                .enumerate()
                .find(|(_, imported)| {
                    &imported.capability == capability && &imported.operation == operation
                })
                .ok_or_else(|| {
                    format!(
                        "{}: manifest omitted {capability}.{operation}",
                        module.source
                    )
                })?;
            (index, &imported.function)
        }
        CallTarget::Link { unit, name } => {
            let (index, link) = manifest
                .links
                .iter()
                .enumerate()
                .find(|(_, link)| &link.unit == unit && &link.name == name)
                .ok_or_else(|| format!("{}: manifest omitted {unit}.{name}", module.source))?;
            (manifest.imports.len() + index, &link.function)
        }
        CallTarget::Function { .. } => unreachable!(),
    };
    let signature = &module.signatures[signature.0];
    let result_layout = memory_layout(&imported.result);
    instructions
        .i32_const(0)
        .i32_const(0)
        .i32_const(result_layout.alignment as i32)
        .i32_const(result_layout.size.max(1) as i32)
        .call(helpers.allocator.alloc)
        .local_tee(scratch_pointer)
        .call(helpers.allocator.temporary);
    let direct = flattened_type(&imported.result).len() <= 1;
    instructions
        .global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_TOKEN));
    if direct {
        instructions.local_get(scratch_pointer);
    }
    instructions
        .global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_TOKEN));
    for (argument, type_id) in arguments.iter().zip(&signature.parameters) {
        let public = canonical_type(module, *type_id, &mut Vec::new())?;
        let layout = memory_layout(&public);
        instructions
            .i32_const(0)
            .i32_const(0)
            .i32_const(layout.alignment as i32)
            .i32_const(layout.size.max(1) as i32)
            .call(helpers.allocator.alloc)
            .local_tee(scratch_length)
            .call(helpers.allocator.temporary)
            .local_get(scratch_length);
        emit_local_values(
            instructions,
            locals_for(module, facts.value_locals, *argument)?,
        );
        instructions
            .call(helpers.canonical.types[type_id].upper)
            .local_get(scratch_length)
            .call(helpers.canonical.types[type_id].read);
    }
    if !direct {
        instructions.local_get(scratch_pointer);
    }
    instructions.call(index as u32);
    if direct {
        instructions.call(helpers.canonical.types[&signature.result].write);
    }
    instructions.call(helpers.allocator.select);
    instructions
        .local_get(scratch_pointer)
        .i32_const(signature.result as i32)
        .call(helpers.canonical_validator)
        .local_get(scratch_pointer)
        .call(helpers.canonical.types[&signature.result].lower);
    for local in result.iter().rev() {
        instructions.local_set(*local);
    }
    instructions
        .global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_TOKEN))
        .call(helpers.allocator.clear_temporaries);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_transition_call(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    transition: &RuntimeTransition,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    facts: FunctionEmissionFacts<'_>,
    scratch_pointer: u32,
    scratch_length: u32,
    runtime_function_indices: &HashMap<FunctionId, u32>,
    roots: &BTreeSet<ValueId>,
) -> Result<(), String> {
    let RuntimeTransition::Call {
        target,
        signature,
        arguments,
        next,
        ..
    } = transition
    else {
        return Ok(());
    };
    let index = next
        .arguments
        .iter()
        .position(|argument| matches!(argument, Argument::Result))
        .expect("checked call has a result parameter");
    let parameter = &function.continuations[next.target.0].parameters[index];
    let result = locals_for(module, facts.value_locals, parameter.value)?;
    let destinations = edge_destinations(function, next);
    if matches!(target, CallTarget::Function { .. }) {
        transfer_roots(
            instructions,
            module,
            roots,
            destinations
                .iter()
                .copied()
                .chain(arguments.iter().copied()),
            facts,
            helpers,
        )?;
    }
    emit_call(
        instructions,
        module,
        target,
        *signature,
        arguments,
        result,
        manifest,
        helpers,
        facts,
        scratch_pointer,
        scratch_length,
        runtime_function_indices,
    )?;
    if !matches!(target, CallTarget::Function { .. }) {
        transfer_roots(
            instructions,
            module,
            roots,
            destinations.into_iter(),
            facts,
            helpers,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_instruction(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    operation: &RuntimeInstruction,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    facts: FunctionEmissionFacts<'_>,
    scratch_pointer: u32,
    scratch_length: u32,
    scratch_index: u32,
) -> Result<(), String> {
    let value_locals = facts.value_locals;
    let result = locals_for(module, value_locals, operation.definition.value)?;
    match operation.operation.kind {
        "constant" => match operation
            .operation
            .value
            .as_ref()
            .ok_or_else(|| format!("{}: residual constant omitted its value", module.source))?
        {
            WireConstant::Unit => {}
            WireConstant::SignedInteger32(value) => {
                instructions.i32_const(*value).local_set(result[0]);
            }
            WireConstant::SignedInteger64(value) => {
                let value = value.parse::<i64>().map_err(|error| {
                    format!("{}: invalid residual i64 {value}: {error}", module.source)
                })?;
                instructions.i64_const(value).local_set(result[0]);
            }
            WireConstant::Boolean(value) => {
                instructions
                    .i32_const(i32::from(*value))
                    .local_set(result[0]);
            }
            WireConstant::Text(value) => {
                let offset = static_data
                    .text_offsets
                    .get(&(function.id, operation.definition.value))
                    .ok_or_else(|| {
                        format!("{}: residual text has no data offset", module.source)
                    })?;
                instructions
                    .i32_const(*offset as i32)
                    .local_set(result[0])
                    .i32_const(value.len() as i32)
                    .local_set(result[1])
                    .i32_const(0)
                    .local_set(result[2]);
            }
            WireConstant::Float32(value) => {
                instructions
                    .f32_const(Ieee32::new(value.to_bits()))
                    .local_set(result[0]);
            }
            WireConstant::Float64(value) => {
                instructions
                    .f64_const(Ieee64::new(value.to_bits()))
                    .local_set(result[0]);
            }
        },
        "text.compare" => {
            let text_compare = helpers.text_compare.ok_or_else(|| {
                format!("{}: text.compare omitted its runtime helper", module.source)
            })?;
            let left = locals_for(module, value_locals, operation.operands[0])?;
            let right = locals_for(module, value_locals, operation.operands[1])?;
            emit_local_values(instructions, &left[..2]);
            emit_local_values(instructions, &right[..2]);
            instructions.call(text_compare).local_set(result[0]);
        }
        "text.contains" => {
            let text_search = helpers.text_find_from.ok_or_else(|| {
                format!(
                    "{}: text.contains omitted its runtime helper",
                    module.source
                )
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let query = locals_for(module, value_locals, operation.operands[1])?;
            emit_local_values(instructions, &text[..2]);
            emit_local_values(instructions, &query[..2]);
            instructions
                .i32_const(0)
                .call(text_search)
                .i32_const(-1)
                .i32_ne()
                .local_set(result[0]);
        }
        "text.length" => {
            let scalar_count = helpers.text_scalar_count.ok_or_else(|| {
                format!("{}: text.length omitted its runtime helper", module.source)
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            emit_local_values(instructions, &text[..2]);
            instructions.call(scalar_count).local_set(result[0]);
        }
        "text.scalar-at" => {
            let scalar_offset = helpers.text_scalar_offset.ok_or_else(|| {
                format!(
                    "{}: text.scalar-at omitted its runtime helper",
                    module.source
                )
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let index = locals_for(module, value_locals, operation.operands[1])?;
            instructions
                .local_get(text[0])
                .local_get(text[1])
                .local_get(index[0])
                .call(scalar_offset)
                .local_tee(scratch_pointer)
                .local_get(text[0])
                .i32_add()
                .local_set(result[0])
                .local_get(text[0])
                .local_get(text[1])
                .local_get(index[0])
                .i64_const(1)
                .i64_add()
                .call(scalar_offset)
                .local_get(scratch_pointer)
                .i32_sub()
                .local_set(result[1])
                .local_get(text[2])
                .local_set(result[2]);
        }
        "text.byte-length" => {
            let text = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .local_get(text[1])
                .i64_extend_i32_u()
                .local_set(result[0]);
        }
        "text.find-byte-from" => {
            let byte_offset = helpers.text_byte_offset.ok_or_else(|| {
                format!("{}: byte search omitted its boundary helper", module.source)
            })?;
            let find_from = helpers.text_find_from.ok_or_else(|| {
                format!("{}: byte search omitted its search helper", module.source)
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let query = locals_for(module, value_locals, operation.operands[1])?;
            let start = locals_for(module, value_locals, operation.operands[2])?;
            instructions
                .local_get(text[0])
                .local_get(text[1])
                .local_get(start[0])
                .call(byte_offset)
                .local_set(scratch_index)
                .local_get(text[0])
                .local_get(text[1])
                .local_get(query[0])
                .local_get(query[1])
                .local_get(scratch_index)
                .call(find_from)
                .local_tee(scratch_pointer)
                .i32_const(-1)
                .i32_eq()
                .if_(BlockType::Result(ValType::I64))
                .i64_const(-1)
                .else_()
                .local_get(scratch_pointer)
                .i64_extend_i32_u()
                .end()
                .local_set(result[0]);
        }
        "text.next-byte" => {
            let next_byte = helpers.text_next_byte.ok_or_else(|| {
                format!(
                    "{}: text.next-byte omitted its runtime helper",
                    module.source
                )
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let byte = locals_for(module, value_locals, operation.operands[1])?;
            emit_local_values(instructions, &text[..2]);
            emit_local_values(instructions, byte);
            instructions.call(next_byte);
            for local in [result[4], result[2], result[1], result[0]] {
                instructions.local_set(local);
            }
            instructions
                .i32_const(0)
                .local_set(result[3])
                .local_get(result[0])
                .if_(BlockType::Empty)
                .local_get(text[2])
                .local_set(result[3])
                .end();
        }
        "text.slice" | "text.slice-bytes" => {
            let offset = if operation.operation.kind == "text.slice-bytes" {
                helpers.text_byte_offset
            } else {
                helpers.text_scalar_offset
            };
            let scalar_offset = offset.ok_or_else(|| {
                format!("{}: text slice omitted its boundary helper", module.source)
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let start = locals_for(module, value_locals, operation.operands[1])?;
            let end = locals_for(module, value_locals, operation.operands[2])?;
            instructions
                .local_get(start[0])
                .local_get(end[0])
                .i64_gt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(text[0])
                .local_get(text[1])
                .local_get(start[0])
                .call(scalar_offset)
                .local_tee(scratch_pointer)
                .local_get(text[0])
                .i32_add()
                .local_set(result[0])
                .local_get(text[0])
                .local_get(text[1])
                .local_get(end[0])
                .call(scalar_offset)
                .local_get(scratch_pointer)
                .i32_sub()
                .local_set(result[1])
                .local_get(text[2])
                .local_set(result[2]);
        }
        "text.find-from" => {
            let scalar_offset = helpers.text_scalar_offset.ok_or_else(|| {
                format!(
                    "{}: text.find-from omitted its scalar-offset helper",
                    module.source
                )
            })?;
            let find_from = helpers.text_find_from.ok_or_else(|| {
                format!(
                    "{}: text.find-from omitted its search helper",
                    module.source
                )
            })?;
            let scalar_count = helpers.text_scalar_count.ok_or_else(|| {
                format!(
                    "{}: text.find-from omitted its scalar-count helper",
                    module.source
                )
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let query = locals_for(module, value_locals, operation.operands[1])?;
            let start = locals_for(module, value_locals, operation.operands[2])?;
            instructions
                .local_get(text[0])
                .local_get(text[1])
                .local_get(start[0])
                .call(scalar_offset)
                .local_set(scratch_index)
                .local_get(text[0])
                .local_get(text[1])
                .local_get(query[0])
                .local_get(query[1])
                .local_get(scratch_index)
                .call(find_from)
                .local_tee(scratch_pointer)
                .i32_const(-1)
                .i32_eq()
                .if_(BlockType::Result(ValType::I64))
                .i64_const(-1)
                .else_()
                .local_get(text[0])
                .local_get(scratch_pointer)
                .call(scalar_count)
                .end()
                .local_set(result[0]);
        }
        "text.append" => {
            let left = locals_for(module, value_locals, operation.operands[0])?;
            let right = locals_for(module, value_locals, operation.operands[1])?;
            instructions
                .local_get(left[1])
                .local_get(right[1])
                .i32_add()
                .local_tee(scratch_length)
                .local_get(left[1])
                .i32_lt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .i32_const(0)
                .i32_const(0)
                .i32_const(1)
                .local_get(scratch_length)
                .call(helpers.realloc)
                .local_tee(scratch_pointer)
                .local_set(result[0])
                .local_get(scratch_pointer)
                .local_get(left[0])
                .local_get(left[1])
                .memory_copy(0, 0)
                .local_get(scratch_pointer)
                .local_get(left[1])
                .i32_add()
                .local_get(right[0])
                .local_get(right[1])
                .memory_copy(0, 0)
                .local_get(scratch_length)
                .local_set(result[1]);
        }
        "text.join" => {
            let store_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let RuntimeType::Store { element_type } = module
                .types
                .get(store_type)
                .ok_or_else(|| format!("{}: text.join has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: text.join operand is not a Store",
                    module.source
                ));
            };
            if !matches!(module.types.get(*element_type), Some(RuntimeType::Text))
                || !matches!(
                    module.types.get(operation.definition.type_id.0),
                    Some(RuntimeType::Text)
                )
            {
                return Err(format!(
                    "{}: text.join requires Store Text -> Text",
                    module.source
                ));
            }
            let store = locals_for(module, value_locals, operation.operands[0])?;
            let text_layout = memory_layout(&internal_memory_type(module, *element_type)?);
            let pointer_load = wasm_encoder::MemArg {
                offset: 0,
                align: 2,
                memory_index: 0,
            };
            let length_load = wasm_encoder::MemArg {
                offset: 4,
                align: 2,
                memory_index: 0,
            };
            instructions
                .i32_const(0)
                .local_set(scratch_index)
                .i32_const(0)
                .local_set(scratch_length)
                .block(BlockType::Empty)
                .loop_(BlockType::Empty)
                .local_get(scratch_index)
                .local_get(store[1])
                .i32_ge_u()
                .br_if(1)
                .local_get(scratch_length)
                .local_get(store[0])
                .local_get(scratch_index)
                .i32_const(text_layout.size as i32)
                .i32_mul()
                .i32_add()
                .i32_load(length_load)
                .i32_add()
                .local_tee(result[1])
                .local_get(scratch_length)
                .i32_lt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(result[1])
                .local_set(scratch_length)
                .local_get(scratch_index)
                .i32_const(1)
                .i32_add()
                .local_set(scratch_index)
                .br(0)
                .end()
                .end()
                .i32_const(0)
                .i32_const(0)
                .i32_const(1)
                .local_get(scratch_length)
                .call(helpers.realloc)
                .local_set(result[0])
                .local_get(scratch_length)
                .local_set(result[1])
                .i32_const(0)
                .local_set(scratch_index)
                .local_get(result[0])
                .local_set(scratch_length)
                .block(BlockType::Empty)
                .loop_(BlockType::Empty)
                .local_get(scratch_index)
                .local_get(store[1])
                .i32_ge_u()
                .br_if(1)
                .local_get(scratch_length)
                .local_get(store[0])
                .local_get(scratch_index)
                .i32_const(text_layout.size as i32)
                .i32_mul()
                .i32_add()
                .i32_load(pointer_load)
                .local_get(store[0])
                .local_get(scratch_index)
                .i32_const(text_layout.size as i32)
                .i32_mul()
                .i32_add()
                .i32_load(length_load)
                .memory_copy(0, 0)
                .local_get(scratch_length)
                .local_get(store[0])
                .local_get(scratch_index)
                .i32_const(text_layout.size as i32)
                .i32_mul()
                .i32_add()
                .i32_load(length_load)
                .i32_add()
                .local_set(scratch_length)
                .local_get(scratch_index)
                .i32_const(1)
                .i32_add()
                .local_set(scratch_index)
                .br(0)
                .end()
                .end();
        }
        "text.from-i64" => {
            let i64_to_text = helpers.i64_to_text.ok_or_else(|| {
                format!(
                    "{}: text.from-i64 omitted its runtime helper",
                    module.source
                )
            })?;
            let value = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .local_get(value[0])
                .call(i64_to_text)
                .local_set(result[2])
                .local_set(result[1])
                .local_set(result[0]);
        }
        "scalar" => {
            let left = locals_for(module, value_locals, operation.operands[0])?;
            let right = locals_for(module, value_locals, operation.operands[1])?;
            let operand_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            if matches!(module.types[operand_type], RuntimeType::SignedInteger64) {
                emit_i64_operation(
                    instructions,
                    left[0],
                    right[0],
                    result[0],
                    operation.operation.operator,
                    &module.source,
                )?;
            } else if matches!(module.types[operand_type], RuntimeType::Float32) {
                emit_float_operation(
                    instructions,
                    left[0],
                    right[0],
                    result[0],
                    operation.operation.operator,
                    true,
                    &module.source,
                )?;
            } else if matches!(module.types[operand_type], RuntimeType::Float64) {
                emit_float_operation(
                    instructions,
                    left[0],
                    right[0],
                    result[0],
                    operation.operation.operator,
                    false,
                    &module.source,
                )?;
            } else {
                instructions.local_get(left[0]).local_get(right[0]);
                emit_i32_operator(instructions, operation.operation.operator, &module.source)?;
                instructions.local_set(result[0]);
            }
        }
        "scalar.unary" => {
            let operand = locals_for(module, value_locals, operation.operands[0])?;
            let operand_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            instructions.local_get(operand[0]);
            match (&module.types[operand_type], operation.operation.operator) {
                (RuntimeType::Float32, Some("negate")) => {
                    instructions.f32_neg();
                }
                (RuntimeType::Float64, Some("negate")) => {
                    instructions.f64_neg();
                }
                (RuntimeType::Float32, Some("square-root")) => {
                    instructions.f32_sqrt();
                }
                (type_, operator) => {
                    return Err(format!(
                        "{}: dynamic unary scalar operator {operator:?} does not accept {}",
                        module.source,
                        runtime_kind(type_)
                    ));
                }
            }
            instructions.local_set(result[0]);
        }
        "convert" => {
            let operand = locals_for(module, value_locals, operation.operands[0])?;
            instructions.local_get(operand[0]);
            match operation.operation.conversion {
                Some("signed-integer-64-to-signed-integer-32") => {
                    instructions.i32_wrap_i64();
                }
                Some("signed-integer-32-to-signed-integer-64") => {
                    instructions.i64_extend_i32_s();
                }
                Some("signed-integer-64-to-float-64") => {
                    instructions.f64_convert_i64_s();
                }
                Some("signed-integer-64-to-float-32") => {
                    instructions.f32_convert_i64_s();
                }
                Some("float-64-to-float-32") => {
                    instructions.f32_demote_f64();
                }
                Some("float-32-to-float-64") => {
                    instructions.f64_promote_f32();
                }
                Some("float-64-to-signed-integer-64") => {
                    instructions.i64_trunc_f64_s();
                }
                conversion => {
                    return Err(format!(
                        "{}: dynamic conversion {conversion:?} is not emitted yet",
                        module.source
                    ));
                }
            }
            instructions.local_set(result[0]);
        }
        "vector" => {
            emit_dynamic_vector_operation(
                instructions,
                module,
                function,
                operation,
                facts,
                result[0],
            )?;
        }
        "product.make" => {
            let expected = facts
                .runtime_layouts
                .flattened(module, operation.definition.type_id.0)?;
            let mut actual = Vec::new();
            for operand in &operation.operands {
                actual.extend_from_slice(facts.runtime_layouts.flattened(
                    module,
                    runtime_value_type(function, facts.value_types, *operand)?,
                )?);
            }
            if actual != expected {
                return Err(format!(
                    "{}: function {} product.make result {} changes its Wasm field layout",
                    module.source, function.id, operation.definition.value
                ));
            }
            let mut destination = 0;
            for operand in &operation.operands {
                let source = locals_for(module, value_locals, *operand)?;
                let end = destination + source.len();
                assign_locals(instructions, &result[destination..end], source)?;
                destination = end;
            }
        }
        "product.project" => {
            let product_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let RuntimeType::Product { fields, .. } = &module.types[product_type] else {
                return Err(format!(
                    "{}: product.project reads a non-product",
                    module.source
                ));
            };
            let field = operation
                .operation
                .field
                .ok_or_else(|| format!("{}: product.project omitted its field", module.source))?;
            if field >= fields.len() {
                return Err(format!(
                    "{}: product.project field {field} is outside a {}-field product",
                    module.source,
                    fields.len()
                ));
            }
            let offset = facts
                .runtime_layouts
                .product_offset(module, product_type, field)?;
            let product = locals_for(module, value_locals, operation.operands[0])?;
            assign_locals(
                instructions,
                result,
                &product[offset..offset + result.len()],
            )?;
        }
        "sum.make" => {
            instructions
                .i32_const(
                    operation
                        .operation
                        .case
                        .ok_or_else(|| format!("{}: sum.make omitted its case", module.source))?
                        as i32,
                )
                .local_set(result[0]);
            let payload = locals_for(module, value_locals, operation.operands[0])?;
            let flattened = facts
                .runtime_layouts
                .flattened(module, operation.definition.type_id.0)?;
            let payload_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let payload_lanes = facts.runtime_layouts.flattened(module, payload_type)?;
            for (index, local) in payload.iter().enumerate() {
                instructions.local_get(*local);
                emit_lane_conversion(instructions, payload_lanes[index], flattened[index + 1])?;
                instructions.local_set(result[index + 1]);
            }
            for (local, type_) in result[1 + payload.len()..]
                .iter()
                .zip(flattened[1 + payload.len()..].iter())
            {
                emit_zero_local(instructions, *type_, *local)?;
            }
        }
        "sum.tag" => {
            let sum = locals_for(module, value_locals, operation.operands[0])?;
            instructions.local_get(sum[0]).local_set(result[0]);
        }
        "sum.payload" => {
            let sum = locals_for(module, value_locals, operation.operands[0])?;
            let sum_type = runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let sum_lanes = facts.runtime_layouts.flattened(module, sum_type)?;
            let payload_lanes = facts
                .runtime_layouts
                .flattened(module, operation.definition.type_id.0)?;
            for (index, local) in result.iter().enumerate() {
                instructions.local_get(sum[index + 1]);
                emit_lane_conversion(instructions, sum_lanes[index + 1], payload_lanes[index])?;
                instructions.local_set(*local);
            }
        }
        "indirect.make" => {
            let RuntimeType::Indirect { target_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| format!("{}: indirect.make has no result type", module.source))?
            else {
                return Err(format!(
                    "{}: indirect.make result is not indirect",
                    module.source
                ));
            };
            let target_layout = internal_memory_type(module, *target_type)?;
            let layout = memory_layout(&target_layout);
            let value = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .i32_const(0)
                .i32_const(0)
                .i32_const(layout.alignment as i32)
                .i32_const(layout.size as i32)
                .call(helpers.realloc)
                .local_set(result[0]);
            emit_local_values(instructions, value);
            instructions.call(helpers.managed.values[target_type].retain);
            instructions
                .local_get(result[0])
                .i32_const(allocation::INDIRECT as i32)
                .i32_const(*target_type as i32)
                .i32_const(1)
                .call(helpers.allocator.set_layout);
            let mut flat_index = 0;
            emit_store_canonical_result(
                instructions,
                &target_layout,
                value,
                &mut flat_index,
                result[0],
                0,
            )?;
            if flat_index != value.len() {
                return Err(format!(
                    "{}: indirect.make stored {flat_index} of {} values",
                    module.source,
                    value.len()
                ));
            }
        }
        "indirect.load" => {
            let indirect_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let RuntimeType::Indirect { target_type } = module
                .types
                .get(indirect_type)
                .ok_or_else(|| format!("{}: indirect.load has no operand type", module.source))?
            else {
                return Err(format!(
                    "{}: indirect.load operand is not indirect",
                    module.source
                ));
            };
            if *target_type != operation.definition.type_id.0 {
                return Err(format!(
                    "{}: indirect.load target type differs from its result",
                    module.source
                ));
            }
            let target_layout = internal_memory_type(module, *target_type)?;
            let pointer = locals_for(module, value_locals, operation.operands[0])?;
            emit_load_canonical_result(instructions, &target_layout, result, pointer[0], 0)?;
        }
        "store.literal" => {
            if let Some((offset, length)) = static_data
                .store_offsets
                .get(&(function.id, operation.definition.value))
            {
                instructions
                    .i32_const(*offset as i32)
                    .local_set(result[0])
                    .i32_const(*length as i32)
                    .local_set(result[1])
                    .i32_const(0)
                    .local_set(result[2]);
                return Ok(());
            }
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| format!("{}: store.literal has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: store.literal result is not a Store",
                    module.source
                ));
            };
            let element_type_id = *element_type;
            let element_type = internal_memory_type(module, element_type_id)?;
            let element_layout = memory_layout(&element_type);
            let length = u32::try_from(operation.operands.len())
                .map_err(|_| format!("{}: Store literal length exceeds memory32", module.source))?;
            instructions
                .i32_const(0)
                .i32_const(0)
                .i32_const(element_layout.alignment as i32)
                .i32_const(length as i32)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .call(helpers.realloc)
                .local_set(result[0])
                .i32_const(length as i32)
                .local_set(result[1]);
            for (index, operand) in operation.operands.iter().enumerate() {
                let value = locals_for(module, value_locals, *operand)?;
                instructions
                    .local_get(result[0])
                    .i32_const(index as i32)
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .i32_add()
                    .local_set(scratch_pointer);
                emit_local_values(instructions, value);
                instructions.call(helpers.managed.values[&element_type_id].retain);
                let mut consumed = 0;
                emit_store_canonical_result(
                    instructions,
                    &element_type,
                    value,
                    &mut consumed,
                    scratch_pointer,
                    0,
                )?;
            }
        }
        "store.empty" => {
            instructions
                .i32_const(0)
                .local_set(result[0])
                .i32_const(0)
                .local_set(result[1]);
        }
        "store.length" => {
            let store = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .local_get(store[1])
                .i64_extend_i32_u()
                .local_set(result[0]);
        }
        "store.read" => {
            let store_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let RuntimeType::Store { element_type } = module
                .types
                .get(store_type)
                .ok_or_else(|| format!("{}: store.read has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: store.read operand is not a Store",
                    module.source
                ));
            };
            let store = locals_for(module, value_locals, operation.operands[0])?;
            let index = locals_for(module, value_locals, operation.operands[1])?;
            let element_type_id = *element_type;
            let element_type = internal_memory_type(module, element_type_id)?;
            let element_layout = memory_layout(&element_type);
            instructions
                .local_get(index[0])
                .i32_wrap_i64()
                .local_set(scratch_index)
                .local_get(store[0])
                .local_get(scratch_index)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_load_canonical_result(instructions, &element_type, result, scratch_pointer, 0)?;
        }
        "store.read.field" => {
            let store_type =
                runtime_value_type(function, facts.value_types, operation.operands[0])?;
            let RuntimeType::Store { element_type } = module
                .types
                .get(store_type)
                .ok_or_else(|| format!("{}: store.read.field has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: store.read.field operand is not a Store",
                    module.source
                ));
            };
            let RuntimeType::Product { fields, .. } =
                module.types.get(*element_type).ok_or_else(|| {
                    format!(
                        "{}: store.read.field element type {} does not exist",
                        module.source, element_type
                    )
                })?
            else {
                return Err(format!(
                    "{}: store.read.field reads a non-product Store element",
                    module.source
                ));
            };
            let field = operation
                .operation
                .field
                .ok_or_else(|| format!("{}: store.read.field omitted its field", module.source))?;
            let runtime_field = fields.get(field).ok_or_else(|| {
                format!(
                    "{}: store.read.field field {field} is outside a {}-field product",
                    module.source,
                    fields.len()
                )
            })?;
            if runtime_field.type_id != operation.definition.type_id.0 {
                return Err(format!(
                    "{}: store.read.field result type {} does not match field type {}",
                    module.source, operation.definition.type_id.0, runtime_field.type_id
                ));
            }
            let element_memory_type = internal_memory_type(module, *element_type)?;
            let AbiType::Record {
                fields: memory_fields,
            } = &element_memory_type
            else {
                return Err(format!(
                    "{}: store.read.field product has no record memory layout",
                    module.source
                ));
            };
            let laid_out_fields = record_layout(memory_fields);
            let memory_field = laid_out_fields.get(field).ok_or_else(|| {
                format!(
                    "{}: store.read.field memory field {field} is absent",
                    module.source
                )
            })?;
            if memory_field.name != runtime_field.name {
                return Err(format!(
                    "{}: store.read.field runtime field `{}` maps to memory field `{}`",
                    module.source, runtime_field.name, memory_field.name
                ));
            }
            let element_layout = memory_layout(&element_memory_type);
            let store = locals_for(module, value_locals, operation.operands[0])?;
            let index = locals_for(module, value_locals, operation.operands[1])?;
            instructions
                .local_get(index[0])
                .i32_wrap_i64()
                .local_set(scratch_index)
                .local_get(store[0])
                .local_get(scratch_index)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_load_canonical_result(
                instructions,
                memory_field.type_,
                result,
                scratch_pointer,
                memory_field.offset,
            )?;
        }
        "store.new" => {
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| format!("{}: store.new has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: store.new result is not a Store",
                    module.source
                ));
            };
            let length = locals_for(module, value_locals, operation.operands[0])?;
            let initial = locals_for(module, value_locals, operation.operands[1])?;
            let element_type_id = *element_type;
            let element_type = internal_memory_type(module, element_type_id)?;
            let element_layout = memory_layout(&element_type);
            let maximum_length = u32::MAX
                .checked_div(element_layout.size)
                .unwrap_or(u32::MAX);
            instructions
                .local_get(length[0])
                .i64_const(0)
                .i64_lt_s()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(length[0])
                .i64_const(i64::from(maximum_length))
                .i64_gt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(length[0])
                .i32_wrap_i64()
                .local_tee(scratch_length)
                .local_set(result[1])
                .i32_const(0)
                .i32_const(0)
                .i32_const(element_layout.alignment as i32)
                .local_get(scratch_length)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .call(helpers.realloc)
                .local_set(result[0])
                .i32_const(0)
                .local_set(scratch_index)
                .block(BlockType::Empty)
                .loop_(BlockType::Empty)
                .local_get(scratch_index)
                .local_get(scratch_length)
                .i32_ge_u()
                .br_if(1)
                .local_get(result[0])
                .local_get(scratch_index)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_local_values(instructions, initial);
            instructions.call(helpers.managed.values[&element_type_id].retain);
            let mut consumed = 0;
            emit_store_canonical_result(
                instructions,
                &element_type,
                initial,
                &mut consumed,
                scratch_pointer,
                0,
            )?;
            instructions
                .local_get(scratch_index)
                .i32_const(1)
                .i32_add()
                .local_set(scratch_index)
                .br(0)
                .end()
                .end();
        }
        "store.write" => {
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| format!("{}: store.write has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: store.write result is not a Store",
                    module.source
                ));
            };
            let store = locals_for(module, value_locals, operation.operands[0])?;
            let index = locals_for(module, value_locals, operation.operands[1])?;
            let value = locals_for(module, value_locals, operation.operands[2])?;
            let element_type_id = *element_type;
            let element_type = internal_memory_type(module, element_type_id)?;
            let element_layout = memory_layout(&element_type);
            if operation.operation.update == Some("persistent") {
                instructions
                    .i32_const(0)
                    .i32_const(0)
                    .i32_const(element_layout.alignment as i32)
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .call(helpers.realloc)
                    .local_tee(result[0])
                    .local_get(store[0])
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .memory_copy(0, 0)
                    .local_get(store[1])
                    .local_set(result[1]);
            } else {
                instructions
                    .local_get(store[0])
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .i32_const(element_layout.alignment as i32)
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .call(helpers.realloc)
                    .local_set(result[0])
                    .local_get(store[1])
                    .local_set(result[1]);
            }
            if operation.operation.update == Some("persistent") {
                instructions
                    .local_get(result[0])
                    .local_get(store[1])
                    .call(helpers.managed.values[&element_type_id].retain_range);
            }
            instructions
                .local_get(index[0])
                .i64_const(0)
                .i64_lt_s()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(index[0])
                .i32_wrap_i64()
                .local_tee(scratch_index)
                .local_get(store[1])
                .i32_ge_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(result[0])
                .local_get(scratch_index)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_local_values(instructions, value);
            instructions.call(helpers.managed.values[&element_type_id].retain);
            instructions
                .local_get(scratch_pointer)
                .call(helpers.managed.values[&element_type_id].release_stored);
            let mut consumed = 0;
            emit_store_canonical_result(
                instructions,
                &element_type,
                value,
                &mut consumed,
                scratch_pointer,
                0,
            )?;
        }
        "store.grow" => {
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| format!("{}: store.grow has no Store type", module.source))?
            else {
                return Err(format!(
                    "{}: store.grow result is not a Store",
                    module.source
                ));
            };
            let store = locals_for(module, value_locals, operation.operands[0])?;
            let value = locals_for(module, value_locals, operation.operands[1])?;
            let element_type_id = *element_type;
            let element_type = internal_memory_type(module, element_type_id)?;
            let element_layout = memory_layout(&element_type);
            instructions
                .local_get(store[1])
                .i32_const(1)
                .i32_add()
                .local_tee(result[1])
                .local_get(store[1])
                .i32_le_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end();
            if operation.operation.update == Some("owned-reuse") {
                instructions
                    .local_get(store[0])
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul();
            } else {
                instructions.i32_const(0).i32_const(0);
            }
            instructions
                .i32_const(element_layout.alignment as i32)
                .local_get(result[1])
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .call(helpers.realloc)
                .local_set(result[0]);
            if operation.operation.update == Some("persistent") {
                instructions
                    .local_get(result[0])
                    .local_get(store[0])
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .memory_copy(0, 0)
                    .local_get(result[0])
                    .local_get(store[1])
                    .call(helpers.managed.values[&element_type_id].retain_range);
            }
            instructions
                .local_get(result[0])
                .local_get(store[1])
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_local_values(instructions, value);
            instructions.call(helpers.managed.values[&element_type_id].retain);
            let mut consumed = 0;
            emit_store_canonical_result(
                instructions,
                &element_type,
                value,
                &mut consumed,
                scratch_pointer,
                0,
            )?;
        }
        "scratch.with-capacity" => {
            let RuntimeType::Scratch { element_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| {
                    format!(
                        "{}: scratch.with-capacity has no Scratch type",
                        module.source
                    )
                })?
            else {
                return Err(format!(
                    "{}: scratch.with-capacity result is not Scratch",
                    module.source
                ));
            };
            let capacity = locals_for(module, value_locals, operation.operands[0])?;
            let element_type = internal_memory_type(module, *element_type)?;
            let element_layout = memory_layout(&element_type);
            let maximum_length = u32::MAX
                .checked_div(element_layout.size)
                .unwrap_or(u32::MAX);
            instructions
                .local_get(capacity[0])
                .i64_const(0)
                .i64_lt_s()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(capacity[0])
                .i64_const(i64::from(maximum_length))
                .i64_gt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(capacity[0])
                .i32_wrap_i64()
                .local_tee(result[2])
                .local_set(scratch_length)
                .i32_const(0)
                .i32_const(0)
                .i32_const(element_layout.alignment as i32)
                .local_get(scratch_length)
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .call(helpers.realloc)
                .local_set(result[0])
                .i32_const(0)
                .local_set(result[1]);
        }
        "scratch.push" => {
            let RuntimeType::Scratch { element_type } = module
                .types
                .get(operation.definition.type_id.0)
                .ok_or_else(|| format!("{}: scratch.push has no Scratch type", module.source))?
            else {
                return Err(format!(
                    "{}: scratch.push result is not Scratch",
                    module.source
                ));
            };
            let scratch = locals_for(module, value_locals, operation.operands[0])?;
            let value = locals_for(module, value_locals, operation.operands[1])?;
            let element_type_id = *element_type;
            let element_type = internal_memory_type(module, element_type_id)?;
            let element_layout = memory_layout(&element_type);
            let maximum_length = u32::MAX
                .checked_div(element_layout.size)
                .unwrap_or(u32::MAX);
            let half_maximum = maximum_length / 2;
            instructions
                .local_get(scratch[1])
                .i32_const(1)
                .i32_add()
                .local_tee(result[1])
                .local_get(scratch[1])
                .i32_le_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(result[1])
                .i32_const(maximum_length as i32)
                .i32_gt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(scratch[0])
                .local_set(result[0])
                .local_get(scratch[2])
                .local_set(result[2])
                .local_get(result[1])
                .local_get(scratch[2])
                .i32_gt_u()
                .if_(BlockType::Empty)
                .local_get(scratch[2])
                .i32_const(half_maximum as i32)
                .i32_gt_u()
                .if_(BlockType::Empty)
                .i32_const(maximum_length as i32)
                .local_set(result[2])
                .else_()
                .local_get(scratch[2])
                .i32_const(2)
                .i32_mul()
                .local_set(result[2])
                .local_get(result[2])
                .i32_const(1)
                .i32_lt_u()
                .if_(BlockType::Empty)
                .i32_const(1)
                .local_set(result[2])
                .end()
                .end()
                .local_get(scratch[0])
                .local_get(scratch[2])
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_const(element_layout.alignment as i32)
                .local_get(result[2])
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .call(helpers.realloc)
                .local_set(result[0])
                .end()
                .local_get(result[0])
                .local_get(scratch[1])
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_local_values(instructions, value);
            instructions.call(helpers.managed.values[&element_type_id].retain);
            let mut consumed = 0;
            emit_store_canonical_result(
                instructions,
                &element_type,
                value,
                &mut consumed,
                scratch_pointer,
                0,
            )?;
        }
        "scratch.finish" => {
            let scratch = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .local_get(scratch[0])
                .local_set(result[0])
                .local_get(scratch[1])
                .local_set(result[1]);
        }
        "scratch.recycle" => {
            let store = locals_for(module, value_locals, operation.operands[0])?;
            let RuntimeType::Scratch { element_type } =
                module.types[operation.definition.type_id.0]
            else {
                unreachable!("checked Scratch recycle result")
            };
            let layout = memory_layout(&internal_memory_type(module, element_type)?);
            instructions
                .local_get(store[0])
                .local_get(store[1])
                .i32_const(layout.size as i32)
                .i32_mul()
                .i32_const(layout.alignment as i32)
                .local_get(store[1])
                .i32_const(layout.size as i32)
                .i32_mul()
                .call(helpers.realloc)
                .local_set(result[0])
                .local_get(result[0])
                .local_get(store[1])
                .call(helpers.managed.values[&element_type].release_range)
                .i32_const(0)
                .local_set(result[1])
                .local_get(store[1])
                .local_set(result[2]);
        }
        "seal.wrap" | "seal.unwrap" | "callback.make" | "resource.move" | "resource.borrow"
        | "resource.freeze" => {
            let operand = locals_for(module, value_locals, operation.operands[0])?;
            assign_locals(instructions, result, operand)?;
        }
        kind => {
            return Err(format!(
                "{}: dynamic operation {kind} is not emitted yet",
                module.source
            ));
        }
    }
    if matches!(operation.operation.kind, "text.append" | "text.join") {
        instructions.local_get(result[0]).local_set(result[2]);
    }
    if let RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } =
        module.types[operation.definition.type_id.0]
    {
        let owner = *result.last().expect("managed sequence has an owner lane");
        instructions
            .i32_const(0)
            .local_set(owner)
            .local_get(result[0])
            .i32_const(helpers.heap_start as i32)
            .i32_ge_u()
            .if_(BlockType::Empty)
            .local_get(result[0])
            .local_set(owner)
            .end();
        if matches!(operation.operation.kind, "scratch.push" | "scratch.recycle")
            || (operation.operation.kind == "store.grow"
                && operation.operation.update == Some("owned-reuse"))
        {
            // A resize moves the backing allocation and its child references. The
            // consumed SSA root must not release the retired allocation header.
            let previous = locals_for(module, value_locals, operation.operands[0])?;
            let previous_owner = *previous.last().expect("resized sequence has an owner");
            instructions
                .local_get(previous_owner)
                .local_get(owner)
                .i32_ne()
                .if_(BlockType::Empty)
                .i32_const(0)
                .local_set(previous_owner)
                .end();
        }
        instructions
            .local_get(owner)
            .i32_const(allocation::ELEMENTS as i32)
            .i32_const(element_type as i32)
            .local_get(result[1])
            .call(helpers.allocator.set_layout);
    }
    let reference = helpers.managed.values[&operation.definition.type_id.0];
    if reference.owns_memory {
        emit_local_values(instructions, result);
        instructions.call(reference.claim);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StructuredControlFlow {
    Acyclic,
    EntryLoop,
}

fn structured_control_flow(function: &RuntimeFunction) -> Option<StructuredControlFlow> {
    let mut active = HashSet::new();
    let mut visited = HashSet::new();
    let mut expanded_blocks = 0;
    let mut has_back_edge = false;
    structured_loop_expansion(
        function,
        function.entry,
        &mut active,
        &mut visited,
        &mut expanded_blocks,
        &mut has_back_edge,
    )?;
    if has_back_edge {
        Some(StructuredControlFlow::EntryLoop)
    } else {
        Some(StructuredControlFlow::Acyclic)
    }
}

fn structured_loop_expansion(
    function: &RuntimeFunction,
    block_id: ContinuationId,
    active: &mut HashSet<ContinuationId>,
    visited: &mut HashSet<ContinuationId>,
    expanded_blocks: &mut usize,
    has_back_edge: &mut bool,
) -> Option<()> {
    if !active.insert(block_id) {
        return None;
    }
    visited.insert(block_id);
    *expanded_blocks = expanded_blocks.checked_add(1)?;
    if expanded_blocks.saturating_sub(visited.len()) > MAX_STRUCTURED_DUPLICATED_BLOCKS {
        return None;
    }
    let block = function.continuations.get(block_id.0)?;
    if block.id != block_id {
        return None;
    }
    for target in terminator_targets(&block.transition) {
        if target == function.entry {
            *has_back_edge = true;
            continue;
        }
        structured_loop_expansion(
            function,
            target,
            active,
            visited,
            expanded_blocks,
            has_back_edge,
        )?;
    }
    active.remove(&block_id);
    Some(())
}

fn terminator_targets(transition: &RuntimeTransition) -> Vec<ContinuationId> {
    transition.edges().iter().map(|edge| edge.target).collect()
}

#[allow(clippy::too_many_arguments)]
fn emit_structured_block(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    block_id: ContinuationId,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    facts: FunctionEmissionFacts<'_>,
    scratch_pointer: u32,
    scratch_length: u32,
    scratch_index: u32,
    runtime_function_indices: &HashMap<FunctionId, u32>,

    loop_depth: u32,
) -> Result<(), String> {
    let value_locals = facts.value_locals;
    let block = function.continuations.get(block_id.0).ok_or_else(|| {
        format!(
            "{}: structured control flow references unknown block {block_id}",
            module.source
        )
    })?;
    if block.id != block_id {
        return Err(format!(
            "{}: structured block index {block_id} contains block {}",
            module.source, block.id
        ));
    }
    let lifetimes = lifetimes::ContinuationLifetimes::new(function, block);
    release_roots(instructions, module, &lifetimes.entry_drops, facts, helpers)?;
    let tail_call = direct_tail_call(function, block);
    for (index, operation) in block.instructions.iter().enumerate() {
        emit_instruction(
            instructions,
            module,
            function,
            operation,
            helpers,
            static_data,
            facts,
            scratch_pointer,
            scratch_length,
            scratch_index,
        )?;
        release_roots(
            instructions,
            module,
            &lifetimes.instruction_drops[index],
            facts,
            helpers,
        )?;
    }
    if let Some(operation) = tail_call {
        transfer_roots(
            instructions,
            module,
            &lifetimes.transition_roots,
            operation.arguments.iter().copied(),
            facts,
            helpers,
        )?;
        emit_direct_tail_call(
            instructions,
            module,
            function,
            operation,
            facts,
            runtime_function_indices,
        )?;
        return Ok(());
    }
    emit_transition_call(
        instructions,
        module,
        function,
        &block.transition,
        manifest,
        helpers,
        facts,
        scratch_pointer,
        scratch_length,
        runtime_function_indices,
        &lifetimes.transition_roots,
    )?;
    let edge_roots = if matches!(block.transition, RuntimeTransition::Call { .. }) {
        None
    } else {
        Some(&lifetimes.transition_roots)
    };
    match &block.transition {
        RuntimeTransition::Jump { edge } | RuntimeTransition::Call { next: edge, .. } => {
            emit_structured_target(
                instructions,
                module,
                function,
                edge,
                manifest,
                helpers,
                static_data,
                facts,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                edge_roots,
                loop_depth,
            )?
        }
        RuntimeTransition::Branch {
            condition,
            consequent,
            alternate,
            ..
        } => {
            let condition = locals_for(module, value_locals, *condition)?;
            instructions.local_get(condition[0]).if_(BlockType::Empty);
            emit_structured_target(
                instructions,
                module,
                function,
                consequent,
                manifest,
                helpers,
                static_data,
                facts,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                edge_roots,
                loop_depth + 1,
            )?;
            instructions.else_();
            emit_structured_target(
                instructions,
                module,
                function,
                alternate,
                manifest,
                helpers,
                static_data,
                facts,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                edge_roots,
                loop_depth + 1,
            )?;
            instructions.end();
        }
        RuntimeTransition::Switch {
            selector,
            cases,
            fallback,
            ..
        } => {
            let selector = locals_for(module, value_locals, *selector)?[0];
            for (index, case_) in cases.iter().enumerate() {
                let expected = switch_case_integer(&case_.0)?;
                instructions.local_get(selector);
                match case_.0 {
                    WireConstant::SignedInteger32(_) => {
                        instructions.i32_const(expected as i32).i32_eq();
                    }
                    WireConstant::SignedInteger64(_) => {
                        instructions.i64_const(expected).i64_eq();
                    }
                    _ => unreachable!("switch_case_integer accepted a non-integer"),
                }
                instructions.if_(BlockType::Empty);
                emit_structured_target(
                    instructions,
                    module,
                    function,
                    &case_.1,
                    manifest,
                    helpers,
                    static_data,
                    facts,
                    scratch_pointer,
                    scratch_length,
                    scratch_index,
                    runtime_function_indices,
                    edge_roots,
                    loop_depth + index as u32 + 1,
                )?;
                instructions.else_();
            }
            emit_structured_target(
                instructions,
                module,
                function,
                fallback,
                manifest,
                helpers,
                static_data,
                facts,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                edge_roots,
                loop_depth + cases.len() as u32,
            )?;
            for _ in cases {
                instructions.end();
            }
        }
        RuntimeTransition::Return { value, .. } => {
            emit_structured_return(instructions, module, facts, *value)?;
        }
        RuntimeTransition::Trap { .. } => {
            instructions.unreachable();
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_structured_target(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    edge: &Edge,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    facts: FunctionEmissionFacts<'_>,
    scratch_pointer: u32,
    scratch_length: u32,
    scratch_index: u32,
    runtime_function_indices: &HashMap<FunctionId, u32>,

    edge_roots: Option<&BTreeSet<ValueId>>,
    loop_depth: u32,
) -> Result<(), String> {
    assign_block_arguments(
        instructions,
        module,
        function,
        edge,
        facts,
        edge_roots,
        helpers,
    )?;
    if edge.target == function.entry {
        instructions.br(loop_depth);
        return Ok(());
    }
    emit_structured_block(
        instructions,
        module,
        function,
        edge.target,
        manifest,
        helpers,
        static_data,
        facts,
        scratch_pointer,
        scratch_length,
        scratch_index,
        runtime_function_indices,
        loop_depth,
    )
}

fn emit_structured_return(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    facts: FunctionEmissionFacts<'_>,
    value: ValueId,
) -> Result<(), String> {
    let value_locals = facts.value_locals;
    emit_local_values(instructions, locals_for(module, value_locals, value)?);
    instructions.return_();
    Ok(())
}

fn emit_direct_tail_call(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    call: DirectTailCall<'_>,
    facts: FunctionEmissionFacts<'_>,
    runtime_function_indices: &HashMap<FunctionId, u32>,
) -> Result<(), String> {
    let value_locals = facts.value_locals;
    let target = call.target;
    let function_index = runtime_function_indices.get(&target).ok_or_else(|| {
        format!(
            "{}: tail call references unavailable function {target}",
            module.source
        )
    })?;
    let target_function = module
        .functions
        .iter()
        .find(|candidate| candidate.id == target)
        .ok_or_else(|| {
            format!(
                "{}: tail call references unknown function {target}",
                module.source
            )
        })?;
    let caller_signature = module.signatures.get(function.signature.0).ok_or_else(|| {
        format!(
            "{}: runtime function {} references unknown signature {}",
            module.source, function.id, function.signature.0
        )
    })?;
    let target_signature = module
        .signatures
        .get(target_function.signature.0)
        .ok_or_else(|| {
            format!(
                "{}: tail-call target {target} references unknown signature {}",
                module.source, target_function.signature
            )
        })?;
    let caller_results = facts
        .runtime_layouts
        .flattened(module, caller_signature.result)?;
    let target_results = facts
        .runtime_layouts
        .flattened(module, target_signature.result)?;
    if caller_results != target_results {
        return Err(format!(
            "{}: tail call from function {} changes its Wasm result layout",
            module.source, function.id
        ));
    }
    if call.arguments.len() != target_signature.parameters.len() {
        return Err(format!(
            "{}: tail call to function {target} supplies {} arguments for {} parameters",
            module.source,
            call.arguments.len(),
            target_signature.parameters.len()
        ));
    }
    for (operand, parameter_type) in call.arguments.iter().zip(&target_signature.parameters) {
        let operand_type = runtime_value_type(function, facts.value_types, *operand)?;
        if facts.runtime_layouts.flattened(module, operand_type)?
            != facts.runtime_layouts.flattened(module, *parameter_type)?
        {
            return Err(format!(
                "{}: tail call to function {target} changes an argument's Wasm layout",
                module.source
            ));
        }
        emit_local_values(instructions, locals_for(module, value_locals, *operand)?);
    }
    instructions.return_call(*function_index);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_dispatch_transition(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    transition: &RuntimeTransition,
    facts: FunctionEmissionFacts<'_>,
    dispatcher: Dispatcher,
    roots: &BTreeSet<ValueId>,
    helpers: DynamicHelpers,
) -> Result<(), String> {
    let edge_roots = if matches!(transition, RuntimeTransition::Call { .. }) {
        None
    } else {
        Some(roots)
    };
    match transition {
        RuntimeTransition::Jump { edge } | RuntimeTransition::Call { next: edge, .. } => {
            assign_block_arguments(
                instructions,
                module,
                function,
                edge,
                facts,
                edge_roots,
                helpers,
            )?;
            instructions
                .i32_const(edge.target.0 as i32)
                .local_set(dispatcher.local)
                .br(dispatcher.depth);
        }
        RuntimeTransition::Branch {
            condition,
            consequent,
            alternate,
        } => {
            let condition = locals_for(module, facts.value_locals, *condition)?;
            instructions.local_get(condition[0]).if_(BlockType::Empty);
            assign_block_arguments(
                instructions,
                module,
                function,
                consequent,
                facts,
                edge_roots,
                helpers,
            )?;
            instructions
                .i32_const(consequent.target.0 as i32)
                .local_set(dispatcher.local)
                .else_();
            assign_block_arguments(
                instructions,
                module,
                function,
                alternate,
                facts,
                edge_roots,
                helpers,
            )?;
            instructions
                .i32_const(alternate.target.0 as i32)
                .local_set(dispatcher.local)
                .end()
                .br(dispatcher.depth);
        }
        RuntimeTransition::Switch {
            selector,
            cases,
            fallback,
        } => {
            emit_switch_dispatch(
                instructions,
                module,
                function,
                *selector,
                cases,
                fallback,
                facts,
                dispatcher,
                roots,
                helpers,
            )?;
        }
        RuntimeTransition::Return { value } => {
            emit_structured_return(instructions, module, facts, *value)?
        }
        RuntimeTransition::Trap { .. } => {
            instructions.unreachable();
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_switch_dispatch(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    selector: ValueId,
    cases: &[(WireConstant, Edge)],
    fallback: &Edge,
    facts: FunctionEmissionFacts<'_>,
    dispatcher: Dispatcher,
    roots: &BTreeSet<ValueId>,
    helpers: DynamicHelpers,
) -> Result<(), String> {
    let edge_roots = Some(roots);
    let selector_local = locals_for(module, facts.value_locals, selector)?[0];
    let dense_i32 = cases
        .iter()
        .enumerate()
        .all(|(index, (value, _))| *value == WireConstant::SignedInteger32(index as i32));
    if dense_i32 {
        for _ in 0..=cases.len() {
            instructions.block(BlockType::Empty);
        }
        instructions
            .local_get(selector_local)
            .br_table(0..cases.len() as u32, cases.len() as u32);
        for (index, (_, edge)) in cases.iter().enumerate() {
            instructions.end();
            assign_block_arguments(
                instructions,
                module,
                function,
                edge,
                facts,
                edge_roots,
                helpers,
            )?;
            instructions
                .i32_const(edge.target.0 as i32)
                .local_set(dispatcher.local)
                .br((cases.len() - index) as u32 + dispatcher.depth);
        }
        instructions.end();
        assign_block_arguments(
            instructions,
            module,
            function,
            fallback,
            facts,
            edge_roots,
            helpers,
        )?;
        instructions
            .i32_const(fallback.target.0 as i32)
            .local_set(dispatcher.local)
            .br(dispatcher.depth);
        return Ok(());
    }
    let mut ordered = cases
        .iter()
        .map(|case| Ok((switch_case_integer(&case.0)?, case)))
        .collect::<Result<Vec<_>, String>>()?;
    ordered.sort_by_key(|(value, _)| *value);
    let ordered = ordered.iter().map(|(_, case)| *case).collect::<Vec<_>>();
    emit_balanced_switch_selection(
        instructions,
        module,
        function,
        selector_local,
        &ordered,
        fallback,
        facts,
        dispatcher.local,
        roots,
        helpers,
    )?;
    instructions.br(dispatcher.depth);
    Ok(())
}

fn switch_case_integer(value: &WireConstant) -> Result<i64, String> {
    match value {
        WireConstant::SignedInteger32(value) => Ok(i64::from(*value)),
        WireConstant::SignedInteger64(value) => value
            .parse::<i64>()
            .map_err(|error| format!("Runtime HIR switch case `{value}` is not an i64: {error}")),
        value => Err(format!(
            "Runtime HIR switch case {value:?} is not an integer"
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_balanced_switch_selection(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    selector: u32,
    cases: &[&(WireConstant, Edge)],
    fallback: &Edge,
    facts: FunctionEmissionFacts<'_>,
    dispatcher: u32,
    roots: &BTreeSet<ValueId>,
    helpers: DynamicHelpers,
) -> Result<(), String> {
    let edge_roots = Some(roots);
    let (left, remaining) = cases.split_at(cases.len() / 2);
    let Some((case, right)) = remaining.split_first() else {
        assign_block_arguments(
            instructions,
            module,
            function,
            fallback,
            facts,
            edge_roots,
            helpers,
        )?;
        instructions
            .i32_const(fallback.target.0 as i32)
            .local_set(dispatcher);
        return Ok(());
    };
    let expected = switch_case_integer(&case.0)?;
    instructions.local_get(selector);
    match case.0 {
        WireConstant::SignedInteger32(_) => {
            instructions.i32_const(expected as i32).i32_eq();
        }
        WireConstant::SignedInteger64(_) => {
            instructions.i64_const(expected).i64_eq();
        }
        _ => unreachable!("switch_case_integer accepted a non-integer"),
    }
    instructions.if_(BlockType::Empty);
    assign_block_arguments(
        instructions,
        module,
        function,
        &case.1,
        facts,
        edge_roots,
        helpers,
    )?;
    instructions
        .i32_const(case.1.target.0 as i32)
        .local_set(dispatcher)
        .else_()
        .local_get(selector);
    match case.0 {
        WireConstant::SignedInteger32(_) => {
            instructions.i32_const(expected as i32).i32_lt_s();
        }
        WireConstant::SignedInteger64(_) => {
            instructions.i64_const(expected).i64_lt_s();
        }
        _ => unreachable!("switch_case_integer accepted a non-integer"),
    }
    instructions.if_(BlockType::Empty);
    emit_balanced_switch_selection(
        instructions,
        module,
        function,
        selector,
        left,
        fallback,
        facts,
        dispatcher,
        roots,
        helpers,
    )?;
    instructions.else_();
    emit_balanced_switch_selection(
        instructions,
        module,
        function,
        selector,
        right,
        fallback,
        facts,
        dispatcher,
        roots,
        helpers,
    )?;
    instructions.end().end();
    Ok(())
}

fn edge_destinations(function: &RuntimeFunction, edge: &Edge) -> Vec<ValueId> {
    edge.arguments
        .iter()
        .filter_map(|argument| match argument {
            Argument::Value(value) => Some(*value),
            Argument::Result => None,
        })
        .chain(
            function.continuations[edge.target.0]
                .captures
                .iter()
                .map(|definition| definition.value),
        )
        .collect()
}

fn release_roots(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    roots: &[ValueId],
    facts: FunctionEmissionFacts<'_>,
    helpers: DynamicHelpers,
) -> Result<(), String> {
    for value in roots {
        let reference = helpers.managed.values[&facts.value_types[value]];
        if !reference.owns_memory {
            continue;
        }
        emit_local_values(
            instructions,
            locals_for(module, facts.value_locals, *value)?,
        );
        instructions.call(reference.release);
    }
    Ok(())
}

fn transfer_roots(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    roots: &BTreeSet<ValueId>,
    destinations: impl Iterator<Item = ValueId>,
    facts: FunctionEmissionFacts<'_>,
    helpers: DynamicHelpers,
) -> Result<(), String> {
    let mut counts = BTreeMap::<ValueId, usize>::new();
    for value in destinations {
        *counts.entry(value).or_default() += 1;
    }
    for (value, count) in &counts {
        assert!(
            roots.contains(value),
            "continuation transfer needs a live root {value}"
        );
        let reference = helpers.managed.values[&facts.value_types[value]];
        if !reference.owns_memory {
            continue;
        }
        for _ in 1..*count {
            emit_local_values(
                instructions,
                locals_for(module, facts.value_locals, *value)?,
            );
            instructions.call(reference.retain);
        }
    }
    release_roots(
        instructions,
        module,
        &roots
            .iter()
            .copied()
            .filter(|value| !counts.contains_key(value))
            .collect::<Vec<_>>(),
        facts,
        helpers,
    )
}

fn assign_block_arguments(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    edge: &Edge,
    facts: FunctionEmissionFacts<'_>,
    roots: Option<&BTreeSet<ValueId>>,
    helpers: DynamicHelpers,
) -> Result<(), String> {
    if let Some(roots) = roots {
        transfer_roots(
            instructions,
            module,
            roots,
            edge_destinations(function, edge).into_iter(),
            facts,
            helpers,
        )?;
    }
    let value_locals = facts.value_locals;
    let target = edge.target;
    let arguments = &edge.arguments;
    let block = function
        .continuations
        .get(target.0)
        .ok_or_else(|| format!("{}: branch targets unknown block {target}", module.source))?;
    if block.parameters.len() != arguments.len() {
        return Err(format!(
            "{}: branch to block {target} supplies {} arguments for {} parameters",
            module.source,
            arguments.len(),
            block.parameters.len()
        ));
    }
    let mut assignments = Vec::new();
    for (parameter, argument) in block.parameters.iter().zip(arguments) {
        let Argument::Value(argument) = argument else {
            continue;
        };
        let destination = locals_for(module, value_locals, parameter.value)?;
        let source = locals_for(module, value_locals, *argument)?;
        let argument_type = runtime_value_type(function, facts.value_types, *argument)?;
        let argument_layout = facts.runtime_layouts.flattened(module, argument_type)?;
        let parameter_layout = facts
            .runtime_layouts
            .flattened(module, parameter.type_id.0)?;
        if argument_layout != parameter_layout {
            let argument_kind = module
                .types
                .get(argument_type)
                .map(runtime_kind)
                .unwrap_or("unknown");
            let parameter_kind = module
                .types
                .get(parameter.type_id.0)
                .map(runtime_kind)
                .unwrap_or("unknown");
            return Err(format!(
                "{}: function {} branches to block {target} with value {} ({argument_kind}, {argument_layout:?}) for parameter {} ({parameter_kind}, {parameter_layout:?})",
                module.source, function.name, argument, parameter.value,
            ));
        }
        assignments.push((destination, source));
    }
    for (_, source) in &assignments {
        emit_local_values(instructions, source);
    }
    for (destination, _) in assignments.iter().rev() {
        for local in destination.iter().rev() {
            instructions.local_set(*local);
        }
    }
    Ok(())
}

fn assign_locals(
    instructions: &mut InstructionSink<'_>,
    destination: &[u32],
    source: &[u32],
) -> Result<(), String> {
    if destination.len() != source.len() {
        return Err("runtime value flattening changed across an assignment".to_owned());
    }
    for (destination, source) in destination.iter().zip(source) {
        instructions.local_get(*source).local_set(*destination);
    }
    Ok(())
}

fn emit_local_values(instructions: &mut InstructionSink<'_>, locals: &[u32]) {
    for local in locals {
        instructions.local_get(*local);
    }
}

fn emit_zero_local(
    instructions: &mut InstructionSink<'_>,
    type_: ValType,
    local: u32,
) -> Result<(), String> {
    match type_ {
        ValType::I32 => instructions.i32_const(0),
        ValType::I64 => instructions.i64_const(0),
        ValType::F32 => instructions.f32_const(Ieee32::new(0)),
        ValType::F64 => instructions.f64_const(Ieee64::new(0)),
        ValType::V128 => instructions.v128_const(0),
        other => return Err(format!("cannot initialize a {other:?} sum payload local")),
    };
    instructions.local_set(local);
    Ok(())
}

fn locals_for<'a>(
    module: &RuntimeModule,
    value_locals: &'a HashMap<ValueId, Vec<u32>>,
    value: ValueId,
) -> Result<&'a [u32], String> {
    value_locals
        .get(&value)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{}: runtime value {value} has no locals", module.source))
}

fn emit_dynamic_vector_operation(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    operation: &RuntimeInstruction,
    facts: FunctionEmissionFacts<'_>,
    result: u32,
) -> Result<(), String> {
    let value_locals = facts.value_locals;
    let vector_type_id = match module.types.get(operation.definition.type_id.0) {
        Some(RuntimeType::Vector { .. } | RuntimeType::Mask { .. }) => {
            operation.definition.type_id.0
        }
        _ => runtime_value_type(function, facts.value_types, operation.operands[0])?,
    };
    let (element, lanes) = match &module.types[vector_type_id] {
        RuntimeType::Vector { element, lanes } | RuntimeType::Mask { element, lanes } => {
            (*element, *lanes)
        }
        type_ => {
            return Err(format!(
                "{}: vector operation reads a {}",
                module.source,
                runtime_kind(type_)
            ));
        }
    };
    let operands = operation
        .operands
        .iter()
        .map(|operand| locals_for(module, value_locals, *operand).map(|locals| locals[0]))
        .collect::<Result<Vec<_>, _>>()?;
    if element == "float-32" && lanes == 4 {
        match operation.operation.operator {
            Some("make") => {
                instructions.local_get(operands[0]).f32x4_splat();
                for (lane, operand) in operands.iter().enumerate().skip(1) {
                    instructions
                        .local_get(*operand)
                        .f32x4_replace_lane(lane as u8);
                }
            }
            Some("splat") => {
                instructions.local_get(operands[0]).f32x4_splat();
            }
            Some("extract") => {
                let lane = operation
                    .operation
                    .lane
                    .ok_or_else(|| format!("{}: vector extract omitted its lane", module.source))?;
                instructions.local_get(operands[0]).f32x4_extract_lane(lane);
            }
            Some("add") => {
                emit_local_pair(instructions, &operands);
                instructions.f32x4_add();
            }
            Some("subtract") => {
                emit_local_pair(instructions, &operands);
                instructions.f32x4_sub();
            }
            Some("multiply") => {
                emit_local_pair(instructions, &operands);
                instructions.f32x4_mul();
            }
            Some("divide") => {
                emit_local_pair(instructions, &operands);
                instructions.f32x4_div();
            }
            Some("equal") => {
                emit_local_pair(instructions, &operands);
                instructions.f32x4_eq();
            }
            Some("less-than") => {
                emit_local_pair(instructions, &operands);
                instructions.f32x4_lt();
            }
            Some("select") => {
                instructions
                    .local_get(operands[1])
                    .local_get(operands[2])
                    .local_get(operands[0])
                    .v128_bitselect();
            }
            Some("shuffle") => {
                if operation.operands.len() != 6 {
                    return Err(format!(
                        "{}: dynamic f32x4 shuffle has {} operands",
                        module.source,
                        operation.operands.len()
                    ));
                }
                let selectors = operation.operands[2..]
                    .iter()
                    .map(|selector| {
                        let defining = function
                            .continuations
                            .iter()
                            .flat_map(|block| &block.instructions)
                            .find(|candidate| candidate.definition.value == *selector)
                            .ok_or_else(|| {
                                format!(
                                    "{}: f32x4 shuffle selector {selector} has no definition",
                                    module.source
                                )
                            })?;
                        let Some(WireConstant::SignedInteger32(selector)) =
                            defining.operation.value
                        else {
                            return Err(format!(
                                "{}: f32x4 shuffle selector {selector} is not constant",
                                module.source
                            ));
                        };
                        u8::try_from(selector).map_err(|_| {
                            format!(
                                "{}: f32x4 shuffle selector {selector} is outside 0..7",
                                module.source
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let mut lanes = [0_u8; 16];
                for (destination, selector) in selectors.into_iter().enumerate() {
                    if selector > 7 {
                        return Err(format!(
                            "{}: f32x4 shuffle selector {selector} is outside 0..7",
                            module.source
                        ));
                    }
                    let source = selector * 4;
                    for byte in 0..4 {
                        lanes[destination * 4 + byte] = source + byte as u8;
                    }
                }
                instructions
                    .local_get(operands[0])
                    .local_get(operands[1])
                    .i8x16_shuffle(lanes);
            }
            Some("mask-all") => {
                instructions.local_get(operands[0]).i32x4_all_true();
            }
            Some("mask-any") => {
                instructions.local_get(operands[0]).v128_any_true();
            }
            Some("sum") => {
                instructions
                    .local_get(operands[0])
                    .f32x4_extract_lane(0)
                    .local_get(operands[0])
                    .f32x4_extract_lane(1)
                    .f32_add()
                    .local_get(operands[0])
                    .f32x4_extract_lane(2)
                    .f32_add()
                    .local_get(operands[0])
                    .f32x4_extract_lane(3)
                    .f32_add();
            }
            operator => {
                return Err(format!(
                    "{}: dynamic f32x4 operator {operator:?} is not emitted yet",
                    module.source
                ));
            }
        }
        instructions.local_set(result);
        return Ok(());
    }
    let integer_shape = match (element, lanes) {
        ("integer-32", 4) => IntegerVectorShape::I32x4,
        ("integer-16", 8) => IntegerVectorShape::I16x8,
        ("integer-8", 16) => IntegerVectorShape::I8x16,
        _ => {
            return Err(format!(
                "{}: dynamic {element}x{lanes} operation is not emitted yet",
                module.source
            ));
        }
    };
    match operation.operation.operator {
        Some("make") => {
            if !matches!(integer_shape, IntegerVectorShape::I32x4) {
                return Err(format!(
                    "{}: dynamic {element}x{lanes} construction is not defined",
                    module.source
                ));
            }
            instructions.local_get(operands[0]).i32x4_splat();
            for (lane, operand) in operands.iter().enumerate().skip(1) {
                instructions
                    .local_get(*operand)
                    .i32x4_replace_lane(lane as u8);
            }
        }
        Some("splat") => {
            instructions.local_get(operands[0]);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_splat(),
                IntegerVectorShape::I16x8 => instructions.i16x8_splat(),
                IntegerVectorShape::I8x16 => instructions.i8x16_splat(),
            };
        }
        Some("extract") => {
            if !matches!(integer_shape, IntegerVectorShape::I32x4) {
                return Err(format!(
                    "{}: dynamic {element}x{lanes} extraction is not defined",
                    module.source
                ));
            }
            let lane = operation
                .operation
                .lane
                .ok_or_else(|| format!("{}: vector extract omitted its lane", module.source))?;
            instructions.local_get(operands[0]).i32x4_extract_lane(lane);
        }
        Some("replace") => {
            if !matches!(integer_shape, IntegerVectorShape::I32x4) {
                return Err(format!(
                    "{}: dynamic {element}x{lanes} replacement is not defined",
                    module.source
                ));
            }
            let lane = operation
                .operation
                .lane
                .ok_or_else(|| format!("{}: vector replace omitted its lane", module.source))?;
            instructions
                .local_get(operands[0])
                .local_get(operands[1])
                .i32x4_replace_lane(lane);
        }
        Some("add") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_add(),
                IntegerVectorShape::I16x8 => instructions.i16x8_add(),
                IntegerVectorShape::I8x16 => instructions.i8x16_add(),
            };
        }
        Some("subtract") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_sub(),
                IntegerVectorShape::I16x8 => instructions.i16x8_sub(),
                IntegerVectorShape::I8x16 => instructions.i8x16_sub(),
            };
        }
        Some("multiply") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_mul(),
                IntegerVectorShape::I16x8 => instructions.i16x8_mul(),
                IntegerVectorShape::I8x16 => {
                    return Err(format!(
                        "{}: dynamic integer-8x16 multiplication is not defined",
                        module.source
                    ));
                }
            };
        }
        Some("bit-and") => {
            emit_local_pair(instructions, &operands);
            instructions.v128_and();
        }
        Some("bit-or") => {
            emit_local_pair(instructions, &operands);
            instructions.v128_or();
        }
        Some("bit-xor") => {
            emit_local_pair(instructions, &operands);
            instructions.v128_xor();
        }
        Some("bit-not") => {
            instructions.local_get(operands[0]).v128_not();
        }
        Some("shift-left") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_shl(),
                IntegerVectorShape::I16x8 => instructions.i16x8_shl(),
                IntegerVectorShape::I8x16 => instructions.i8x16_shl(),
            };
        }
        Some("shift-right-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_shr_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_shr_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_shr_s(),
            };
        }
        Some("shift-right-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_shr_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_shr_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_shr_u(),
            };
        }
        Some("equal") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_eq(),
                IntegerVectorShape::I16x8 => instructions.i16x8_eq(),
                IntegerVectorShape::I8x16 => instructions.i8x16_eq(),
            };
        }
        Some("not-equal") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_ne(),
                IntegerVectorShape::I16x8 => instructions.i16x8_ne(),
                IntegerVectorShape::I8x16 => instructions.i8x16_ne(),
            };
        }
        Some("less-than-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_lt_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_lt_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_lt_s(),
            };
        }
        Some("less-than-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_lt_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_lt_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_lt_u(),
            };
        }
        Some("greater-than-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_gt_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_gt_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_gt_s(),
            };
        }
        Some("greater-than-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_gt_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_gt_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_gt_u(),
            };
        }
        Some("less-than-or-equal-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_le_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_le_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_le_s(),
            };
        }
        Some("less-than-or-equal-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_le_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_le_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_le_u(),
            };
        }
        Some("greater-than-or-equal-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_ge_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_ge_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_ge_s(),
            };
        }
        Some("greater-than-or-equal-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_ge_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_ge_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_ge_u(),
            };
        }
        Some("minimum-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_min_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_min_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_min_s(),
            };
        }
        Some("minimum-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_min_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_min_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_min_u(),
            };
        }
        Some("maximum-signed") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_max_s(),
                IntegerVectorShape::I16x8 => instructions.i16x8_max_s(),
                IntegerVectorShape::I8x16 => instructions.i8x16_max_s(),
            };
        }
        Some("maximum-unsigned") => {
            emit_local_pair(instructions, &operands);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_max_u(),
                IntegerVectorShape::I16x8 => instructions.i16x8_max_u(),
                IntegerVectorShape::I8x16 => instructions.i8x16_max_u(),
            };
        }
        Some("select") => {
            instructions
                .local_get(operands[1])
                .local_get(operands[2])
                .local_get(operands[0])
                .v128_bitselect();
        }
        Some("mask-bitmask") => {
            instructions.local_get(operands[0]);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_bitmask(),
                IntegerVectorShape::I16x8 => instructions.i16x8_bitmask(),
                IntegerVectorShape::I8x16 => instructions.i8x16_bitmask(),
            };
        }
        Some("mask-all") => {
            instructions.local_get(operands[0]);
            match integer_shape {
                IntegerVectorShape::I32x4 => instructions.i32x4_all_true(),
                IntegerVectorShape::I16x8 => instructions.i16x8_all_true(),
                IntegerVectorShape::I8x16 => instructions.i8x16_all_true(),
            };
        }
        Some("mask-any") => {
            instructions.local_get(operands[0]).v128_any_true();
        }
        operator => {
            return Err(format!(
                "{}: dynamic {element}x{lanes} operator {operator:?} is not emitted yet",
                module.source,
            ));
        }
    }
    instructions.local_set(result);
    Ok(())
}

#[derive(Clone, Copy)]
enum IntegerVectorShape {
    I32x4,
    I16x8,
    I8x16,
}

fn emit_local_pair(instructions: &mut InstructionSink<'_>, operands: &[u32]) {
    instructions.local_get(operands[0]).local_get(operands[1]);
}

fn runtime_kind(type_: &RuntimeType) -> &'static str {
    match type_ {
        RuntimeType::Unit => "unit",
        RuntimeType::Integer32 => "integer-32",
        RuntimeType::SignedInteger64 => "signed-integer-64",
        RuntimeType::Resource { .. } => "resource",
        RuntimeType::Callback { .. } => "callback",
        RuntimeType::Float32 => "float-32",
        RuntimeType::Float64 => "float-64",
        RuntimeType::Boolean => "boolean",
        RuntimeType::Text => "text",
        RuntimeType::Vector { .. } => "vector",
        RuntimeType::Mask { .. } => "mask",
        RuntimeType::Store { .. } => "store",
        RuntimeType::Scratch { .. } => "scratch",
        RuntimeType::Indirect { .. } => "indirect",
        RuntimeType::Product { .. } => "product",
        RuntimeType::Sum { .. } => "sum",
        RuntimeType::Sealed { .. } => "sealed",
    }
}

fn runtime_value_type(
    function: &RuntimeFunction,
    value_types: &HashMap<ValueId, usize>,
    value: ValueId,
) -> Result<usize, String> {
    value_types.get(&value).copied().ok_or_else(|| {
        format!(
            "runtime function {} omitted the type of value {value}",
            function.name
        )
    })
}

fn emit_i32_operator(
    instructions: &mut InstructionSink<'_>,
    operator: Option<&str>,
    source: &str,
) -> Result<(), String> {
    match operator {
        Some("add") => {
            instructions.i32_add();
        }
        Some("subtract") => {
            instructions.i32_sub();
        }
        Some("multiply") => {
            instructions.i32_mul();
        }
        Some("divide") => {
            instructions.i32_div_s();
        }
        Some("remainder") => {
            instructions.i32_rem_s();
        }
        Some("equal") => {
            instructions.i32_eq();
        }
        Some("not-equal") => {
            instructions.i32_ne();
        }
        Some("less-than") => {
            instructions.i32_lt_s();
        }
        Some("less-than-or-equal") => {
            instructions.i32_le_s();
        }
        Some("greater-than") => {
            instructions.i32_gt_s();
        }
        Some("greater-than-or-equal") => {
            instructions.i32_ge_s();
        }
        operator => {
            return Err(format!(
                "{source}: dynamic i32 operator {operator:?} is not emitted yet"
            ));
        }
    }
    Ok(())
}

fn emit_float_operation(
    instructions: &mut InstructionSink<'_>,
    left: u32,
    right: u32,
    result: u32,
    operator: Option<&str>,
    float32: bool,
    source: &str,
) -> Result<(), String> {
    instructions.local_get(left).local_get(right);
    match (float32, operator) {
        (true, Some("add")) => instructions.f32_add(),
        (true, Some("subtract")) => instructions.f32_sub(),
        (true, Some("multiply")) => instructions.f32_mul(),
        (true, Some("divide")) => instructions.f32_div(),
        (true, Some("equal")) => instructions.f32_eq(),
        (true, Some("not-equal")) => instructions.f32_ne(),
        (true, Some("less-than")) => instructions.f32_lt(),
        (true, Some("less-than-or-equal")) => instructions.f32_le(),
        (true, Some("greater-than")) => instructions.f32_gt(),
        (true, Some("greater-than-or-equal")) => instructions.f32_ge(),
        (false, Some("add")) => instructions.f64_add(),
        (false, Some("subtract")) => instructions.f64_sub(),
        (false, Some("multiply")) => instructions.f64_mul(),
        (false, Some("divide")) => instructions.f64_div(),
        (false, Some("equal")) => instructions.f64_eq(),
        (false, Some("not-equal")) => instructions.f64_ne(),
        (false, Some("less-than")) => instructions.f64_lt(),
        (false, Some("less-than-or-equal")) => instructions.f64_le(),
        (false, Some("greater-than")) => instructions.f64_gt(),
        (false, Some("greater-than-or-equal")) => instructions.f64_ge(),
        (true, Some("remainder")) => instructions
            .f32_div()
            .f32_trunc()
            .local_get(right)
            .f32_mul()
            .local_get(left)
            .f32_sub()
            .f32_neg(),
        (false, Some("remainder")) => instructions
            .f64_div()
            .f64_trunc()
            .local_get(right)
            .f64_mul()
            .local_get(left)
            .f64_sub()
            .f64_neg(),
        (_, operator) => {
            return Err(format!(
                "{source}: dynamic float operator {operator:?} is not emitted yet"
            ));
        }
    };
    instructions.local_set(result);
    Ok(())
}

fn emit_i64_operation(
    instructions: &mut InstructionSink<'_>,
    left: u32,
    right: u32,
    result: u32,
    operator: Option<&str>,
    source: &str,
) -> Result<(), String> {
    match operator {
        Some("add") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_add()
                .local_tee(result)
                .local_get(left)
                .i64_xor()
                .local_get(result)
                .local_get(right)
                .i64_xor()
                .i64_and()
                .i64_const(0)
                .i64_lt_s()
                .if_(BlockType::Empty)
                .unreachable()
                .end();
        }
        Some("subtract") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_sub()
                .local_tee(result)
                .local_get(left)
                .local_get(right)
                .i64_xor()
                .local_get(left)
                .local_get(result)
                .i64_xor()
                .i64_and()
                .i64_const(0)
                .i64_lt_s()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .drop();
        }
        Some("multiply") => {
            instructions
                .local_get(left)
                .i64_const(i64::MIN)
                .i64_eq()
                .local_get(right)
                .i64_const(-1)
                .i64_eq()
                .i32_and()
                .local_get(right)
                .i64_const(i64::MIN)
                .i64_eq()
                .local_get(left)
                .i64_const(-1)
                .i64_eq()
                .i32_and()
                .i32_or()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .local_get(left)
                .local_get(right)
                .i64_mul()
                .local_set(result)
                .local_get(left)
                .i64_eqz()
                .if_(BlockType::Empty)
                .else_()
                .local_get(result)
                .local_get(left)
                .i64_div_s()
                .local_get(right)
                .i64_ne()
                .if_(BlockType::Empty)
                .unreachable()
                .end()
                .end();
        }
        Some("divide") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_div_s()
                .local_set(result);
        }
        Some("remainder") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_rem_s()
                .local_set(result);
        }
        Some("equal") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_eq()
                .local_set(result);
        }
        Some("not-equal") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_ne()
                .local_set(result);
        }
        Some("less-than") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_lt_s()
                .local_set(result);
        }
        Some("less-than-or-equal") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_le_s()
                .local_set(result);
        }
        Some("greater-than") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_gt_s()
                .local_set(result);
        }
        Some("greater-than-or-equal") => {
            instructions
                .local_get(left)
                .local_get(right)
                .i64_ge_s()
                .local_set(result);
        }
        operator => {
            return Err(format!(
                "{source}: dynamic i64 operator {operator:?} is not emitted yet"
            ));
        }
    }
    Ok(())
}

fn emit_load_canonical_result(
    instructions: &mut InstructionSink<'_>,
    type_: &AbiType,
    destination: &[u32],
    pointer: u32,
    offset: u32,
) -> Result<usize, String> {
    emit_load_memory_value(
        instructions,
        type_,
        FlatLocals {
            locals: destination,
            lanes: &flattened_type(type_),
        },
        pointer,
        offset,
    )
}

fn emit_load_memory_value(
    instructions: &mut InstructionSink<'_>,
    type_: &AbiType,
    destination: FlatLocals<'_>,
    pointer: u32,
    offset: u32,
) -> Result<usize, String> {
    let memory_argument = |offset, align| wasm_encoder::MemArg {
        offset: u64::from(offset),
        align,
        memory_index: 0,
    };
    match type_ {
        AbiType::Unit => Ok(0),
        AbiType::InternalPointer
        | AbiType::Vector128
        | AbiType::SignedInteger64
        | AbiType::Resource { .. }
        | AbiType::Float32
        | AbiType::Float64
        | AbiType::Boolean => {
            instructions.local_get(pointer);
            let lane = match type_ {
                AbiType::InternalPointer => {
                    instructions.i32_load(memory_argument(offset, 2));
                    ValType::I32
                }
                AbiType::Vector128 => {
                    instructions.v128_load(memory_argument(offset, 4));
                    ValType::V128
                }
                AbiType::SignedInteger64 | AbiType::Resource { .. } => {
                    instructions.i64_load(memory_argument(offset, 3));
                    ValType::I64
                }
                AbiType::Float32 => {
                    instructions.f32_load(memory_argument(offset, 2));
                    ValType::F32
                }
                AbiType::Float64 => {
                    instructions.f64_load(memory_argument(offset, 3));
                    ValType::F64
                }
                AbiType::Boolean => {
                    instructions.i32_load8_u(memory_argument(offset, 0));
                    ValType::I32
                }
                _ => unreachable!(),
            };
            destination.set(instructions, 0, lane)?;
            Ok(1)
        }
        AbiType::Text | AbiType::Array { .. } => {
            for index in 0..2 {
                instructions
                    .local_get(pointer)
                    .i32_load(memory_argument(offset + 4 * index as u32, 2));
                destination.set(instructions, index, ValType::I32)?;
            }
            Ok(2)
        }
        AbiType::Record { fields } => {
            let mut written = 0;
            for field in record_layout(fields) {
                written += emit_load_memory_value(
                    instructions,
                    field.type_,
                    destination.tail(written),
                    pointer,
                    offset + field.offset,
                )?;
            }
            Ok(written)
        }
        AbiType::Variant { cases } => {
            let layout = variant_layout(cases);
            instructions.local_get(pointer);
            let argument = memory_argument(offset, layout.discriminant_size.trailing_zeros());
            match layout.discriminant_size {
                1 => {
                    instructions.i32_load8_u(argument);
                }
                2 => {
                    instructions.i32_load16_u(argument);
                }
                4 => {
                    instructions.i32_load(argument);
                }
                size => return Err(format!("unsupported variant discriminant size {size}")),
            }
            destination.set(instructions, 0, ValType::I32)?;
            let width = flattened_type(type_).len();
            for index in 1..width {
                emit_zero_local(
                    instructions,
                    destination.lanes[index],
                    destination.locals[index],
                )?;
            }
            for (case_index, case_) in cases.iter().enumerate() {
                let Some(payload) = &case_.payload else {
                    continue;
                };
                destination.get(instructions, 0, ValType::I32)?;
                instructions
                    .i32_const(case_index as i32)
                    .i32_eq()
                    .if_(BlockType::Empty);
                emit_load_memory_value(
                    instructions,
                    payload,
                    destination.tail(1),
                    pointer,
                    offset + layout.payload_offset,
                )?;
                instructions.end();
            }
            Ok(width)
        }
        AbiType::Sealed { inner, .. }
        | AbiType::Callback {
            environment: inner, ..
        } => emit_load_memory_value(instructions, inner, destination, pointer, offset),
    }
}

fn emit_direct_canonical_value(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    layouts: &RuntimeTypeLayouts,
    type_id: usize,
    public: &AbiType,
    source: &[u32],
) -> Result<(), String> {
    match (&module.types[type_id], public) {
        (
            RuntimeType::Sum { cases, .. },
            AbiType::Variant {
                cases: public_cases,
            },
        ) => {
            for (index, case_) in cases.iter().enumerate() {
                if index + 1 < cases.len() {
                    instructions
                        .local_get(source[0])
                        .i32_const(index as i32)
                        .i32_eq()
                        .if_(BlockType::Result(ValType::I32));
                }
                let tag = public_cases
                    .iter()
                    .position(|public| public.name == case_.name)
                    .ok_or_else(|| format!("public variant omitted case {}", case_.name))?;
                instructions.i32_const(tag as i32);
                if index + 1 < cases.len() {
                    instructions.else_();
                }
            }
            for _ in 1..cases.len() {
                instructions.end();
            }
        }
        (
            RuntimeType::Product { fields, .. },
            AbiType::Record {
                fields: public_fields,
            },
        ) => {
            let mut offset = 0;
            for field in fields {
                let width = layouts.flattened(module, field.type_id)?.len();
                let public = public_fields
                    .iter()
                    .find(|public| public.name == field.name)
                    .ok_or_else(|| format!("public record omitted field {}", field.name))?;
                emit_direct_canonical_value(
                    instructions,
                    module,
                    layouts,
                    field.type_id,
                    &public.type_,
                    &source[offset..offset + width],
                )?;
                offset += width;
            }
        }
        (
            RuntimeType::Sealed {
                representation_type,
                ..
            },
            AbiType::Sealed { inner, .. },
        )
        | (
            RuntimeType::Callback {
                environment_type: representation_type,
                ..
            },
            AbiType::Callback {
                environment: inner, ..
            },
        ) => {
            emit_direct_canonical_value(
                instructions,
                module,
                layouts,
                *representation_type,
                inner,
                source,
            )?;
        }
        _ => emit_local_values(instructions, source),
    }
    Ok(())
}

fn emit_lower_flat_value(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    runtime_type_id: usize,
    public_type: &AbiType,
    source: &[u32],
    destination: &[u32],
) -> Result<(), String> {
    emit_lower_flat_lanes(
        instructions,
        module,
        runtime_layouts,
        runtime_type_id,
        public_type,
        FlatLocals {
            locals: source,
            lanes: &flattened_type(public_type),
        },
        FlatLocals {
            locals: destination,
            lanes: runtime_layouts.flattened(module, runtime_type_id)?,
        },
    )
}

fn emit_lower_flat_lanes(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    runtime_layouts: &RuntimeTypeLayouts,
    runtime_type_id: usize,
    public_type: &AbiType,
    source: FlatLocals<'_>,
    destination: FlatLocals<'_>,
) -> Result<(), String> {
    let runtime_type = module
        .types
        .get(runtime_type_id)
        .ok_or_else(|| format!("unknown runtime type {runtime_type_id}"))?;
    match (runtime_type, public_type) {
        (RuntimeType::Boolean, AbiType::Boolean) => {
            source.get(instructions, 0, ValType::I32)?;
            instructions
                .i32_const(1)
                .i32_gt_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end();
            source.get(instructions, 0, ValType::I32)?;
            destination.set(instructions, 0, ValType::I32)?;
        }
        (
            RuntimeType::Product { fields, .. },
            AbiType::Record {
                fields: public_fields,
            },
        ) => {
            let mut runtime_offset = 0;
            for field in fields {
                let runtime_width = runtime_layouts.flattened(module, field.type_id)?.len();
                let mut public_offset = 0;
                let mut matched = None;
                for public_field in public_fields {
                    let width = flattened_type(&public_field.type_).len();
                    if public_field.name == field.name {
                        matched = Some((public_field, public_offset, width));
                        break;
                    }
                    public_offset += width;
                }
                let (public_field, public_offset, _public_width) =
                    matched.ok_or_else(|| format!("public record omitted field {}", field.name))?;
                emit_lower_flat_lanes(
                    instructions,
                    module,
                    runtime_layouts,
                    field.type_id,
                    &public_field.type_,
                    source.tail(public_offset),
                    destination.tail(runtime_offset),
                )?;
                runtime_offset += runtime_width;
            }
        }
        (
            RuntimeType::Sum { cases, .. },
            AbiType::Variant {
                cases: public_cases,
            },
        ) => {
            source.get(instructions, 0, ValType::I32)?;
            instructions
                .i32_const(cases.len() as i32)
                .i32_ge_u()
                .if_(BlockType::Empty)
                .unreachable()
                .end();
            let lane_types = runtime_layouts.flattened(module, runtime_type_id)?;
            for index in 1..lane_types.len() {
                emit_zero_local(
                    instructions,
                    destination.lanes[index],
                    destination.locals[index],
                )?;
            }
            for (runtime_index, case_) in cases.iter().enumerate() {
                let public_index = public_cases
                    .iter()
                    .position(|item| item.name == case_.name)
                    .ok_or_else(|| format!("public variant omitted case {}", case_.name))?;
                let (from, to) = (public_index, runtime_index);
                source.get(instructions, 0, ValType::I32)?;
                instructions
                    .i32_const(from as i32)
                    .i32_eq()
                    .if_(BlockType::Empty);
                instructions.i32_const(to as i32);
                destination.set(instructions, 0, ValType::I32)?;
                if let Some(payload) = &public_cases[public_index].payload {
                    emit_lower_flat_lanes(
                        instructions,
                        module,
                        runtime_layouts,
                        case_.payload_type,
                        payload,
                        source.tail(1),
                        destination.tail(1),
                    )?;
                }
                instructions.end();
            }
        }
        (
            RuntimeType::Sealed {
                representation_type,
                ..
            },
            AbiType::Sealed { inner, .. },
        )
        | (
            RuntimeType::Callback {
                environment_type: representation_type,
                ..
            },
            AbiType::Callback {
                environment: inner, ..
            },
        ) => {
            emit_lower_flat_lanes(
                instructions,
                module,
                runtime_layouts,
                *representation_type,
                inner,
                source,
                destination,
            )?;
        }
        _ => {
            let public_lanes = flattened_type(public_type);
            let private_lanes = runtime_layouts.flattened(module, runtime_type_id)?;
            if public_lanes.len() != private_lanes.len() {
                return Err("incompatible public flat value width".to_owned());
            }
            for (index, lane) in public_lanes.iter().enumerate() {
                source.get(instructions, index, *lane)?;
                emit_lane_conversion(instructions, *lane, private_lanes[index])?;
                destination.set(instructions, index, private_lanes[index])?;
            }
        }
    }
    Ok(())
}
fn emit_store_canonical_result(
    instructions: &mut InstructionSink<'_>,
    type_: &AbiType,
    source: &[u32],
    flat_index: &mut usize,
    pointer: u32,
    offset: u32,
) -> Result<(), String> {
    *flat_index += emit_store_memory_value(
        instructions,
        type_,
        FlatLocals {
            locals: &source[*flat_index..],
            lanes: &flattened_type(type_),
        },
        pointer,
        offset,
    )?;
    Ok(())
}

fn emit_store_memory_value(
    instructions: &mut InstructionSink<'_>,
    type_: &AbiType,
    source: FlatLocals<'_>,
    pointer: u32,
    offset: u32,
) -> Result<usize, String> {
    let memory_argument = |offset, align| wasm_encoder::MemArg {
        offset: u64::from(offset),
        align,
        memory_index: 0,
    };
    match type_ {
        AbiType::Unit => Ok(0),
        AbiType::InternalPointer
        | AbiType::Vector128
        | AbiType::SignedInteger64
        | AbiType::Resource { .. }
        | AbiType::Float32
        | AbiType::Float64
        | AbiType::Boolean => {
            let lane = flattened_type(type_)[0];
            instructions.local_get(pointer);
            source.get(instructions, 0, lane)?;
            match type_ {
                AbiType::InternalPointer => {
                    instructions.i32_store(memory_argument(offset, 2));
                }
                AbiType::Vector128 => {
                    instructions.v128_store(memory_argument(offset, 4));
                }
                AbiType::SignedInteger64 | AbiType::Resource { .. } => {
                    instructions.i64_store(memory_argument(offset, 3));
                }
                AbiType::Float32 => {
                    instructions.f32_store(memory_argument(offset, 2));
                }
                AbiType::Float64 => {
                    instructions.f64_store(memory_argument(offset, 3));
                }
                AbiType::Boolean => {
                    instructions.i32_store8(memory_argument(offset, 0));
                }
                _ => unreachable!(),
            }
            Ok(1)
        }
        AbiType::Text | AbiType::Array { .. } => {
            for index in 0..2 {
                instructions.local_get(pointer);
                source.get(instructions, index, ValType::I32)?;
                instructions.i32_store(memory_argument(offset + 4 * index as u32, 2));
            }
            Ok(2)
        }
        AbiType::Record { fields } => {
            let mut consumed = 0;
            for field in record_layout(fields) {
                consumed += emit_store_memory_value(
                    instructions,
                    field.type_,
                    source.tail(consumed),
                    pointer,
                    offset + field.offset,
                )?;
            }
            Ok(consumed)
        }
        AbiType::Variant { cases } => {
            let layout = variant_layout(cases);
            instructions.local_get(pointer);
            source.get(instructions, 0, ValType::I32)?;
            match layout.discriminant_size {
                1 => {
                    instructions.i32_store8(memory_argument(offset, 0));
                }
                2 => {
                    instructions.i32_store16(memory_argument(offset, 1));
                }
                4 => {
                    instructions.i32_store(memory_argument(offset, 2));
                }
                size => return Err(format!("unsupported variant discriminant size {size}")),
            }
            for (case_index, case_) in cases.iter().enumerate() {
                let Some(payload) = &case_.payload else {
                    continue;
                };
                source.get(instructions, 0, ValType::I32)?;
                instructions
                    .i32_const(case_index as i32)
                    .i32_eq()
                    .if_(BlockType::Empty);
                emit_store_memory_value(
                    instructions,
                    payload,
                    source.tail(1),
                    pointer,
                    offset + layout.payload_offset,
                )?;
                instructions.end();
            }
            Ok(flattened_type(type_).len())
        }
        AbiType::Sealed { inner, .. }
        | AbiType::Callback {
            environment: inner, ..
        } => emit_store_memory_value(instructions, inner, source, pointer, offset),
    }
}

fn text_scalar_count_function() -> Function {
    let mut function = Function::new([(1, ValType::I32), (1, ValType::I64)]);
    let index = 2;
    let count = 3;
    let mut instructions = function.instructions();
    instructions
        .i32_const(0)
        .local_set(index)
        .i64_const(0)
        .local_set(count)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(index)
        .local_get(1)
        .i32_ge_u()
        .br_if(1)
        .local_get(0)
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .i32_const(0xc0)
        .i32_and()
        .i32_const(0x80)
        .i32_ne()
        .if_(BlockType::Empty)
        .local_get(count)
        .i64_const(1)
        .i64_add()
        .local_set(count)
        .end()
        .local_get(index)
        .i32_const(1)
        .i32_add()
        .local_set(index)
        .br(0)
        .end()
        .end()
        .local_get(count)
        .end();
    function
}

fn text_scalar_offset_function() -> Function {
    let mut function = Function::new([(1, ValType::I32), (1, ValType::I64)]);
    let byte = 3;
    let scalar = 4;
    let mut instructions = function.instructions();
    instructions
        .local_get(2)
        .i64_const(0)
        .i64_lt_s()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .i32_const(0)
        .local_set(byte)
        .i64_const(0)
        .local_set(scalar)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(byte)
        .local_get(1)
        .i32_ge_u()
        .br_if(1)
        .local_get(0)
        .local_get(byte)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .i32_const(0xc0)
        .i32_and()
        .i32_const(0x80)
        .i32_ne()
        .if_(BlockType::Empty)
        .local_get(scalar)
        .local_get(2)
        .i64_eq()
        .if_(BlockType::Empty)
        .local_get(byte)
        .return_()
        .end()
        .local_get(scalar)
        .i64_const(1)
        .i64_add()
        .local_set(scalar)
        .end()
        .local_get(byte)
        .i32_const(1)
        .i32_add()
        .local_set(byte)
        .br(0)
        .end()
        .end()
        .local_get(scalar)
        .local_get(2)
        .i64_eq()
        .if_(BlockType::Result(ValType::I32))
        .local_get(byte)
        .else_()
        .unreachable()
        .end()
        .end();
    function
}

fn text_compare_function() -> Function {
    let mut function = Function::new([(3, ValType::I32)]);
    let index = 4;
    let left_byte = 5;
    let right_byte = 6;
    let mut instructions = function.instructions();
    instructions
        .i32_const(0)
        .local_set(index)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(index)
        .local_get(1)
        .i32_ge_u()
        .br_if(1)
        .local_get(index)
        .local_get(3)
        .i32_ge_u()
        .br_if(1)
        .local_get(0)
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(left_byte)
        .local_get(2)
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(right_byte)
        .local_get(left_byte)
        .local_get(right_byte)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .i32_const(-1)
        .return_()
        .end()
        .local_get(left_byte)
        .local_get(right_byte)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .i32_const(1)
        .return_()
        .end()
        .local_get(index)
        .i32_const(1)
        .i32_add()
        .local_set(index)
        .br(0)
        .end()
        .end()
        .local_get(1)
        .local_get(3)
        .i32_lt_u()
        .if_(BlockType::Result(ValType::I32))
        .i32_const(-1)
        .else_()
        .local_get(1)
        .local_get(3)
        .i32_gt_u()
        .if_(BlockType::Result(ValType::I32))
        .i32_const(1)
        .else_()
        .i32_const(0)
        .end()
        .end()
        .end();
    function
}

fn utf8_validator_function() -> Function {
    let mut function = Function::new([(5, ValType::I32)]);
    let cursor = 2;
    let end = 3;
    let lead = 4;
    let second = 5;
    let advance = 6;
    let mut instructions = function.instructions();
    instructions
        .local_get(0)
        .local_get(1)
        .i32_add()
        .local_tee(end)
        .local_get(0)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(0)
        .local_set(cursor)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(cursor)
        .local_get(end)
        .i32_ge_u()
        .br_if(1)
        .local_get(cursor)
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_tee(lead)
        .i32_const(128)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .i32_const(1)
        .local_set(advance)
        .else_()
        .local_get(lead)
        .i32_const(194)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(lead)
        .i32_const(224)
        .i32_lt_u()
        .if_(BlockType::Empty);
    emit_utf8_byte(&mut instructions, cursor, 1, end, second);
    emit_utf8_range(&mut instructions, second, 128, 191);
    instructions
        .i32_const(2)
        .local_set(advance)
        .else_()
        .local_get(lead)
        .i32_const(240)
        .i32_lt_u()
        .if_(BlockType::Empty);
    emit_utf8_byte(&mut instructions, cursor, 1, end, second);
    instructions
        .local_get(lead)
        .i32_const(224)
        .i32_eq()
        .if_(BlockType::Empty);
    emit_utf8_range(&mut instructions, second, 160, 191);
    instructions
        .else_()
        .local_get(lead)
        .i32_const(237)
        .i32_eq()
        .if_(BlockType::Empty);
    emit_utf8_range(&mut instructions, second, 128, 159);
    instructions.else_();
    emit_utf8_range(&mut instructions, second, 128, 191);
    instructions.end().end();
    emit_utf8_byte(&mut instructions, cursor, 2, end, second);
    emit_utf8_range(&mut instructions, second, 128, 191);
    instructions
        .i32_const(3)
        .local_set(advance)
        .else_()
        .local_get(lead)
        .i32_const(245)
        .i32_ge_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    emit_utf8_byte(&mut instructions, cursor, 1, end, second);
    instructions
        .local_get(lead)
        .i32_const(240)
        .i32_eq()
        .if_(BlockType::Empty);
    emit_utf8_range(&mut instructions, second, 144, 191);
    instructions
        .else_()
        .local_get(lead)
        .i32_const(244)
        .i32_eq()
        .if_(BlockType::Empty);
    emit_utf8_range(&mut instructions, second, 128, 143);
    instructions.else_();
    emit_utf8_range(&mut instructions, second, 128, 191);
    instructions.end().end();
    emit_utf8_byte(&mut instructions, cursor, 2, end, second);
    emit_utf8_range(&mut instructions, second, 128, 191);
    emit_utf8_byte(&mut instructions, cursor, 3, end, second);
    emit_utf8_range(&mut instructions, second, 128, 191);
    instructions
        .i32_const(4)
        .local_set(advance)
        .end()
        .end()
        .end()
        .local_get(cursor)
        .local_get(advance)
        .i32_add()
        .local_set(cursor)
        .br(0)
        .end()
        .end()
        .end();
    function
}

fn i64_to_text_function(realloc: u32) -> Function {
    let mut function = Function::new([(1, ValType::I64), (4, ValType::I32)]);
    let magnitude = 1;
    let allocation = 2;
    let cursor = 3;
    let digit = 4;
    let negative = 5;
    let mut instructions = function.instructions();
    instructions
        .i32_const(0)
        .i32_const(0)
        .i32_const(1)
        .i32_const(20)
        .call(realloc)
        .local_set(allocation)
        .i32_const(20)
        .local_set(cursor)
        .local_get(0)
        .i64_const(0)
        .i64_lt_s()
        .local_set(negative)
        .local_get(negative)
        .if_(BlockType::Result(ValType::I64))
        .i64_const(0)
        .local_get(0)
        .i64_sub()
        .else_()
        .local_get(0)
        .end()
        .local_set(magnitude)
        .loop_(BlockType::Empty)
        .local_get(magnitude)
        .i64_const(10)
        .i64_rem_u()
        .i32_wrap_i64()
        .local_set(digit)
        .local_get(cursor)
        .i32_const(1)
        .i32_sub()
        .local_tee(cursor)
        .local_get(allocation)
        .i32_add()
        .local_get(digit)
        .i32_const(48)
        .i32_add()
        .i32_store8(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_get(magnitude)
        .i64_const(10)
        .i64_div_u()
        .local_tee(magnitude)
        .i64_eqz()
        .i32_eqz()
        .br_if(0)
        .end()
        .local_get(negative)
        .if_(BlockType::Empty)
        .local_get(cursor)
        .i32_const(1)
        .i32_sub()
        .local_tee(cursor)
        .local_get(allocation)
        .i32_add()
        .i32_const(45)
        .i32_store8(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .end()
        .local_get(allocation)
        .local_get(cursor)
        .i32_add()
        .i32_const(20)
        .local_get(cursor)
        .i32_sub()
        .local_get(allocation)
        .end();
    function
}

fn emit_utf8_byte(
    instructions: &mut InstructionSink<'_>,
    cursor: u32,
    offset: i32,
    end: u32,
    destination: u32,
) {
    instructions
        .local_get(cursor)
        .i32_const(offset)
        .i32_add()
        .local_tee(destination)
        .local_get(end)
        .i32_ge_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(destination)
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(destination);
}

fn emit_utf8_range(instructions: &mut InstructionSink<'_>, value: u32, minimum: i32, maximum: i32) {
    instructions
        .local_get(value)
        .i32_const(minimum)
        .i32_lt_u()
        .local_get(value)
        .i32_const(maximum)
        .i32_gt_u()
        .i32_or()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
}

fn add_i32_global(globals: &mut GlobalSection, value: i32, mutable: bool) {
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable,
            shared: false,
        },
        &ConstExpr::i32_const(value),
    );
}

fn allocation_mem(offset: u32) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

fn post_return_function(call_id: u32, helpers: DynamicHelpers) -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .call(helpers.allocator.select)
        .global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_ACTIVE_EXPORT))
        .i32_const(call_id as i32)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_RESULT))
        .local_get(1)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    finish_call(&mut ins, helpers);
    ins.end();
    body
}

fn begin_call(ins: &mut InstructionSink<'_>, call_id: u32, helpers: DynamicHelpers) {
    ins.global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_ACTIVE_EXPORT))
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(helpers.allocation_globals.current_scope)
        .i32_const(call_id as i32)
        .i32_store(allocation_mem(allocation::SCOPE_ACTIVE_EXPORT));
}

fn finish_call(ins: &mut InstructionSink<'_>, helpers: DynamicHelpers) {
    ins.global_get(helpers.allocation_globals.current_scope)
        .i32_load(allocation_mem(allocation::SCOPE_TOKEN))
        .call(helpers.allocator.clear_temporaries);
    for offset in [allocation::SCOPE_RESULT, allocation::SCOPE_ACTIVE_EXPORT] {
        ins.global_get(helpers.allocation_globals.current_scope)
            .i32_const(0)
            .i32_store(allocation_mem(offset));
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MemoryLayout {
    alignment: u32,
    size: u32,
}

#[derive(Clone, Copy)]
struct LaidOutField<'a> {
    name: &'a str,
    type_: &'a AbiType,
    offset: u32,
    layout: MemoryLayout,
}

struct VariantLayout {
    discriminant_size: u32,
    payload_offset: u32,
    alignment: u32,
    size: u32,
}

#[cfg(test)]
thread_local! {
    static MEMORY_LAYOUT_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn memory_layout(type_: &AbiType) -> MemoryLayout {
    #[cfg(test)]
    MEMORY_LAYOUT_VISITS.with(|visits| visits.set(visits.get() + 1));
    match type_ {
        AbiType::Unit => MemoryLayout {
            alignment: 1,
            size: 0,
        },
        AbiType::InternalPointer => MemoryLayout {
            alignment: 4,
            size: 4,
        },
        AbiType::Vector128 => MemoryLayout {
            alignment: 16,
            size: 16,
        },
        AbiType::Boolean => MemoryLayout {
            alignment: 1,
            size: 1,
        },
        AbiType::Float32 => MemoryLayout {
            alignment: 4,
            size: 4,
        },
        AbiType::SignedInteger64 | AbiType::Float64 | AbiType::Resource { .. } => MemoryLayout {
            alignment: 8,
            size: 8,
        },
        AbiType::Text | AbiType::Array { .. } => MemoryLayout {
            alignment: 4,
            size: 8,
        },
        AbiType::Sealed { inner, .. }
        | AbiType::Callback {
            environment: inner, ..
        } => memory_layout(inner),
        AbiType::Record { fields } => {
            let fields = record_layout(fields);
            let alignment = fields
                .iter()
                .map(|field| field.layout.alignment)
                .max()
                .unwrap_or(1);
            let end = fields
                .iter()
                .map(|field| field.offset + field.layout.size)
                .max()
                .unwrap_or(0);
            MemoryLayout {
                alignment,
                size: align_to(end, alignment),
            }
        }
        AbiType::Variant { cases } => {
            let layout = variant_layout(cases);
            MemoryLayout {
                alignment: layout.alignment,
                size: layout.size,
            }
        }
    }
}

fn record_layout(fields: &[AbiField]) -> Vec<LaidOutField<'_>> {
    // Borrow the types: cloning each nested suffix is quadratic even after
    // eliminating repeated recursive layout queries.
    let mut offset = 0;
    fields
        .iter()
        .map(|field| {
            let layout = memory_layout(&field.type_);
            offset = align_to(offset, layout.alignment);
            let result = LaidOutField {
                name: &field.name,
                type_: &field.type_,
                offset,
                layout,
            };
            offset += layout.size;
            result
        })
        .collect()
}

fn variant_layout(cases: &[AbiCase]) -> VariantLayout {
    let discriminant_size = if cases.len() <= 256 {
        1
    } else if cases.len() <= 65_536 {
        2
    } else {
        4
    };
    let mut payload_alignment = 1;
    let mut payload_size = 0;
    for case_ in cases {
        if let Some(payload) = &case_.payload {
            let layout = memory_layout(payload);
            payload_alignment = payload_alignment.max(layout.alignment);
            payload_size = payload_size.max(layout.size);
        }
    }
    let alignment = discriminant_size.max(payload_alignment);
    let payload_offset = align_to(discriminant_size, payload_alignment);
    VariantLayout {
        discriminant_size,
        payload_offset,
        alignment,
        size: align_to(payload_offset + payload_size, alignment),
    }
}

fn align_to(value: u32, alignment: u32) -> u32 {
    value.div_ceil(alignment) * alignment
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuation::{Graph, Operation};
    use crate::hir::{RuntimeCase, RuntimeSpan};

    #[test]
    fn nested_record_memory_layout_visits_each_type_once() {
        for depth in [0, 1, 8, 32, 64] {
            let mut type_ = AbiType::SignedInteger64;
            for _ in 0..depth {
                type_ = AbiType::Record {
                    fields: vec![AbiField {
                        name: "child".to_owned(),
                        type_,
                    }],
                };
            }
            MEMORY_LAYOUT_VISITS.with(|visits| visits.set(0));
            assert_eq!(
                memory_layout(&type_),
                MemoryLayout {
                    alignment: 8,
                    size: 8
                }
            );
            assert_eq!(MEMORY_LAYOUT_VISITS.with(|visits| visits.get()), depth + 1);
        }
    }

    #[test]
    fn record_layout_borrows_types_and_preserves_the_selected_field_order() {
        let fields = vec![
            AbiField {
                name: "z".to_owned(),
                type_: AbiType::Float32,
            },
            AbiField {
                name: "b".to_owned(),
                type_: AbiType::SignedInteger64,
            },
            AbiField {
                name: "a".to_owned(),
                type_: AbiType::Boolean,
            },
        ];
        let layout = record_layout(&fields);
        assert_eq!(
            layout
                .iter()
                .map(|field| (field.name, field.offset))
                .collect::<Vec<_>>(),
            vec![("z", 0), ("b", 8), ("a", 16)]
        );
        assert!(std::ptr::eq(layout[0].type_, &fields[0].type_));
        assert!(std::ptr::eq(layout[1].type_, &fields[1].type_));
        let record = AbiType::Record { fields };
        assert_eq!(
            memory_layout(&record),
            MemoryLayout {
                alignment: 8,
                size: 24
            }
        );
        assert_eq!(
            memory_layout(&AbiType::Record { fields: Vec::new() }),
            MemoryLayout {
                alignment: 1,
                size: 0
            }
        );
        let variant = AbiType::Variant {
            cases: vec![
                AbiCase {
                    name: "None".to_owned(),
                    payload: None,
                },
                AbiCase {
                    name: "Some".to_owned(),
                    payload: Some(record),
                },
            ],
        };
        assert_eq!(
            memory_layout(&variant),
            MemoryLayout {
                alignment: 8,
                size: 32
            }
        );
    }

    #[test]
    fn unused_heterogeneous_sum_does_not_require_a_local_wasm_layout() {
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "unused-heterogeneous-sum-test".to_owned(),
            types: vec![
                RuntimeType::Unit,
                RuntimeType::Float32,
                RuntimeType::Integer32,
                RuntimeType::Sum {
                    name: "Choice".to_owned(),
                    cases: vec![
                        RuntimeCase {
                            name: "Single".to_owned(),
                            payload_type: 1,
                        },
                        RuntimeCase {
                            name: "Number".to_owned(),
                            payload_type: 2,
                        },
                    ],
                },
            ],
            signatures: Vec::new(),
            static_stores: Vec::new(),
            graph: Graph {
                functions: Vec::new(),
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        close(module).expect("an unused private sum should not need a Wasm-local layout");
    }

    #[test]
    fn immediate_trap_branches_receive_false_hints() {
        let mut function = Function::new(Vec::new());
        function
            .instructions()
            .i32_const(0)
            .if_(BlockType::Empty)
            .unreachable()
            .end()
            .end();

        let hints = cold_trap_branch_hints(&function).expect("trap branch should parse");
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].branch_hint_value, 0);
        assert!(hints[0].branch_func_offset > 0);
    }

    #[test]
    fn ordinary_branches_do_not_receive_speculative_hints() {
        let mut function = Function::new(Vec::new());
        function
            .instructions()
            .i32_const(0)
            .if_(BlockType::Empty)
            .nop()
            .end()
            .end();

        let hints = cold_trap_branch_hints(&function).expect("ordinary branch should parse");
        assert!(hints.is_empty());
    }

    #[test]
    fn branch_hint_inspection_accepts_simd_operators() {
        let mut function = Function::new(Vec::new());
        function
            .instructions()
            .f32_const(Ieee32::new(0))
            .f32x4_splat()
            .drop()
            .i32_const(0)
            .if_(BlockType::Empty)
            .unreachable()
            .end()
            .end();

        let hints = cold_trap_branch_hints(&function).expect("SIMD function should parse");
        assert_eq!(hints.len(), 1);
    }

    #[test]
    fn checked_integer_subtraction_leaves_structured_branches_balanced() {
        let mut function = Function::new(vec![(1, ValType::I64)]);
        let mut instructions = function.instructions();
        instructions.i32_const(1).if_(BlockType::Empty);
        emit_i64_operation(
            &mut instructions,
            0,
            1,
            2,
            Some("subtract"),
            "structured-subtraction-test",
        )
        .expect("checked subtraction should emit");
        instructions
            .local_get(2)
            .return_()
            .else_()
            .local_get(0)
            .return_()
            .end()
            .unreachable()
            .end();

        let mut types = TypeSection::new();
        types
            .ty()
            .function([ValType::I64, ValType::I64], [ValType::I64]);
        let mut functions = FunctionSection::new();
        functions.function(0);
        let mut code = CodeSection::new();
        code.function(&function);
        let mut module = Module::new();
        module.section(&types).section(&functions).section(&code);

        wasmparser::Validator::new()
            .validate_all(&module.finish())
            .expect("checked subtraction should leave no operand below its result");
    }

    #[test]
    fn entry_cycle_with_acyclic_body_is_a_structured_loop() {
        let function = runtime_function(vec![
            conditional_block(0, 1, 2),
            return_block(1),
            branch_block(2, 0),
        ]);

        assert_eq!(
            structured_control_flow(&function),
            Some(StructuredControlFlow::EntryLoop)
        );
    }

    #[test]
    fn non_entry_cycle_keeps_the_dispatcher() {
        let function = runtime_function(vec![
            branch_block(0, 1),
            branch_block(1, 2),
            branch_block(2, 1),
        ]);

        assert_eq!(structured_control_flow(&function), None);
    }

    #[test]
    fn bounded_reconverging_loop_body_is_structured() {
        let function = runtime_function(vec![
            conditional_block(0, 1, 2),
            branch_block(1, 3),
            branch_block(2, 3),
            branch_block(3, 0),
        ]);

        assert_eq!(
            structured_control_flow(&function),
            Some(StructuredControlFlow::EntryLoop)
        );
    }

    #[test]
    fn bounded_switch_with_a_shared_join_is_structured() {
        let function = runtime_function(vec![
            RuntimeContinuation {
                captures: Vec::new(),
                span: span(),
                id: ContinuationId(0),
                parameters: vec![parameter(0)],
                instructions: Vec::new(),
                transition: RuntimeTransition::Switch {
                    selector: ValueId(0),
                    cases: vec![(
                        WireConstant::SignedInteger32(0),
                        Edge {
                            target: ContinuationId(1),
                            arguments: Vec::new(),
                        },
                    )],
                    fallback: Edge {
                        target: ContinuationId(2),
                        arguments: Vec::new(),
                    },
                },
            },
            branch_block(1, 3),
            branch_block(2, 3),
            return_block(3),
        ]);

        assert_eq!(
            structured_control_flow(&function),
            Some(StructuredControlFlow::Acyclic)
        );
    }

    #[test]
    fn large_acyclic_control_flow_is_not_refused_for_its_unique_blocks() {
        let mut blocks = (0..129)
            .map(|block| branch_block(block, block + 1))
            .collect::<Vec<_>>();
        blocks.push(return_block(129));
        let function = runtime_function(blocks);

        assert_eq!(
            structured_control_flow(&function),
            Some(StructuredControlFlow::Acyclic)
        );
    }

    #[test]
    fn single_block_function_emits_without_a_dispatcher() {
        let mut entry = return_block(0);
        entry.parameters.push(parameter(0));
        let function = runtime_function(vec![entry]);
        assert_eq!(
            structured_control_flow(&function),
            Some(StructuredControlFlow::Acyclic)
        );
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "acyclic-structured-test".to_owned(),
            types: vec![RuntimeType::Unit, RuntimeType::Boolean],
            signatures: vec![crate::hir::RuntimeSignature {
                parameters: vec![1],
                result: 1,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            graph: Graph {
                functions: vec![function],
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };
        let runtime_layouts = RuntimeTypeLayouts::new(&module).expect("layouts should close");
        let manifest =
            build_manifest(&module, &runtime_layouts).expect("test manifest should close");
        let wasm = emit_dynamic_module(&module, &runtime_layouts, &manifest, b"{}")
            .expect("acyclic structured function should emit");
        let body = wasmparser::Parser::new(0)
            .parse_all(&wasm)
            .filter_map(
                |payload| match payload.expect("emitted Wasm should parse") {
                    wasmparser::Payload::CodeSectionEntry(body) => Some(body),
                    _ => None,
                },
            )
            .last()
            .expect("module ends with its sole internal runtime function");
        let operators = body
            .get_operators_reader()
            .expect("acyclic operators should parse")
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .expect("acyclic operators should decode");

        assert!(!operators.iter().any(|operator| matches!(
            operator,
            wasmparser::Operator::BrTable { .. } | wasmparser::Operator::Loop { .. }
        )));
    }

    #[test]
    fn generic_dispatch_uses_one_indexed_branch_table() {
        let function = runtime_function(vec![
            RuntimeContinuation {
                captures: Vec::new(),
                span: span(),
                id: ContinuationId(0),
                parameters: vec![parameter(0)],
                instructions: Vec::new(),
                transition: RuntimeTransition::Jump {
                    edge: Edge {
                        target: ContinuationId(1),
                        arguments: vec![Argument::Value(ValueId(0))],
                    },
                },
            },
            RuntimeContinuation {
                captures: Vec::new(),
                span: span(),
                id: ContinuationId(1),
                parameters: vec![parameter(1)],
                instructions: Vec::new(),
                transition: RuntimeTransition::Jump {
                    edge: Edge {
                        target: ContinuationId(2),
                        arguments: vec![Argument::Value(ValueId(1))],
                    },
                },
            },
            RuntimeContinuation {
                captures: Vec::new(),
                span: span(),
                id: ContinuationId(2),
                parameters: vec![parameter(2)],
                instructions: Vec::new(),
                transition: RuntimeTransition::Jump {
                    edge: Edge {
                        target: ContinuationId(1),
                        arguments: vec![Argument::Value(ValueId(2))],
                    },
                },
            },
        ]);
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "indexed-dispatch-test".to_owned(),
            types: vec![RuntimeType::Unit, RuntimeType::Boolean],
            signatures: vec![crate::hir::RuntimeSignature {
                parameters: vec![1],
                result: 1,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            graph: Graph {
                functions: vec![function],
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };
        let runtime_layouts = RuntimeTypeLayouts::new(&module).expect("layouts should close");
        let manifest =
            build_manifest(&module, &runtime_layouts).expect("test manifest should close");
        let wasm = emit_dynamic_module(&module, &runtime_layouts, &manifest, b"{}")
            .expect("generic dispatcher should emit");
        let body = wasmparser::Parser::new(0)
            .parse_all(&wasm)
            .filter_map(
                |payload| match payload.expect("emitted Wasm should parse") {
                    wasmparser::Payload::CodeSectionEntry(body) => Some(body),
                    _ => None,
                },
            )
            .last()
            .expect("module ends with its sole internal runtime function");
        let operators = body
            .get_operators_reader()
            .expect("dispatcher operators should parse")
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .expect("dispatcher operators should decode");

        assert_eq!(
            operators
                .iter()
                .filter(|operator| matches!(operator, wasmparser::Operator::BrTable { .. }))
                .count(),
            1,
        );
        assert!(
            !operators
                .iter()
                .any(|operator| matches!(operator, wasmparser::Operator::I32Eq))
        );
    }

    #[test]
    fn closed_product_store_literal_is_serialized_into_static_memory() {
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "static-product-test".to_owned(),
            types: vec![
                RuntimeType::Unit,
                RuntimeType::Float32,
                RuntimeType::SignedInteger64,
                RuntimeType::Product {
                    name: "Pair".to_owned(),
                    fields: vec![
                        crate::hir::RuntimeField {
                            name: "b".to_owned(),
                            type_id: 2,
                        },
                        crate::hir::RuntimeField {
                            name: "a".to_owned(),
                            type_id: 1,
                        },
                    ],
                },
                RuntimeType::Store { element_type: 3 },
            ],
            signatures: Vec::new(),
            static_stores: Vec::new(),
            graph: Graph {
                functions: Vec::new(),
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };
        let mut left = plain_operation(1, Vec::new());
        left.operation.kind = "constant";
        left.definition.type_id = TypeId(1);
        left.operation.value = Some(WireConstant::Float32(1.5));
        let mut right = plain_operation(2, Vec::new());
        right.operation.kind = "constant";
        right.definition.type_id = TypeId(2);
        right.operation.value = Some(WireConstant::SignedInteger64("7".to_owned()));
        let mut pair = plain_operation(3, vec![2, 1]);
        pair.operation.kind = "product.make";
        pair.definition.type_id = TypeId(3);
        let mut store = plain_operation(4, vec![3]);
        store.operation.kind = "store.literal";
        store.definition.type_id = TypeId(4);
        let definitions = HashMap::from([
            (ValueId(1), &left),
            (ValueId(2), &right),
            (ValueId(3), &pair),
            (ValueId(4), &store),
        ]);

        let (alignment, bytes, length) = closed_store_literal_bytes(
            &module,
            FunctionId(0),
            &store,
            &definitions,
            &HashMap::new(),
        )
        .expect("static product should serialize")
        .expect("closed product should be pooled");

        assert_eq!(alignment, 8);
        assert_eq!(length, 1);
        assert_eq!(bytes.len(), 16);
        assert_eq!(&bytes[0..8], &7_i64.to_le_bytes());
        assert_eq!(&bytes[8..12], &1.5_f32.to_bits().to_le_bytes());
    }

    #[test]
    fn recursive_representation_is_private_to_runtime_hir() {
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "recursive-boundary-test".to_owned(),
            types: vec![RuntimeType::Unit, RuntimeType::Indirect { target_type: 0 }],
            signatures: Vec::new(),
            static_stores: Vec::new(),
            graph: Graph {
                functions: Vec::new(),
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        let Err(error) = canonical_type(&module, 1, &mut Vec::new()) else {
            panic!("a recursive value acquired an ABI 4 layout");
        };

        assert!(error.contains("cannot cross Blot Core Wasm ABI 4"));
    }

    #[test]
    fn scratch_is_private_but_has_an_internal_indirect_layout() {
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "scratch-boundary-test".to_owned(),
            types: vec![
                RuntimeType::Unit,
                RuntimeType::SignedInteger64,
                RuntimeType::Scratch { element_type: 1 },
            ],
            signatures: Vec::new(),
            static_stores: Vec::new(),
            graph: Graph {
                functions: Vec::new(),
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        assert!(canonical_type(&module, 2, &mut Vec::new()).is_err());
        let internal = internal_memory_type(&module, 2)
            .expect("Scratch needs a private layout inside indirect carriers");
        assert_eq!(flattened_type(&internal), vec![ValType::I32; 4]);
        assert_eq!(memory_layout(&internal).size, 16);
    }

    #[test]
    fn simd_store_elements_have_private_memory_layout() {
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "simd-store-layout-test".to_owned(),
            types: vec![
                RuntimeType::Unit,
                RuntimeType::Vector {
                    element: "float-32",
                    lanes: 4,
                },
                RuntimeType::Store { element_type: 1 },
            ],
            signatures: Vec::new(),
            static_stores: Vec::new(),
            graph: Graph {
                functions: Vec::new(),
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        let Err(error) = canonical_type(&module, 2, &mut Vec::new()) else {
            panic!("a SIMD Store acquired a public ABI layout");
        };
        assert!(error.contains("SIMD type"));

        let internal = internal_memory_type(&module, 1)
            .expect("SIMD Store elements need an internal memory layout");
        assert_eq!(flattened_type(&internal), vec![ValType::V128]);
        assert_eq!(memory_layout(&internal).alignment, 16);
        assert_eq!(memory_layout(&internal).size, 16);
    }

    #[test]
    fn simd_memory_layout_emits_vector_loads_and_stores() {
        let mut function = Function::new([(1, ValType::I32), (2, ValType::V128)]);
        {
            let mut instructions = function.instructions();
            let mut flat_index = 0;
            emit_store_canonical_result(
                &mut instructions,
                &AbiType::Vector128,
                &[1],
                &mut flat_index,
                0,
                0,
            )
            .expect("SIMD Store element should emit");
            emit_load_canonical_result(&mut instructions, &AbiType::Vector128, &[2], 0, 0)
                .expect("SIMD Store read should emit");
            instructions.end();
        }

        let body = function.into_raw_body();
        let operators = FunctionBody::new(BinaryReader::new(&body, 0))
            .get_operators_reader()
            .expect("SIMD memory function should parse")
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .expect("SIMD memory operators should parse");
        assert!(
            operators
                .iter()
                .any(|operator| matches!(operator, Operator::V128Store { .. }))
        );
        assert!(
            operators
                .iter()
                .any(|operator| matches!(operator, Operator::V128Load { .. }))
        );
    }

    #[test]
    fn operation_results_do_not_overwrite_their_operand_locals() {
        let function = runtime_function(vec![RuntimeContinuation {
            captures: Vec::new(),
            span: span(),
            id: ContinuationId(0),
            parameters: Vec::new(),
            instructions: vec![
                plain_operation(1, Vec::new()),
                plain_operation(2, vec![1]),
                plain_operation(3, vec![2]),
            ],
            transition: RuntimeTransition::Return { value: ValueId(3) },
        }]);
        let module = allocation_test_module(function.clone());
        let runtime_layouts = RuntimeTypeLayouts::new(&module).expect("layouts should close");

        let allocation =
            allocate_value_locals(&module, &runtime_layouts, &function, 0, HashMap::new())
                .expect("operation chain should allocate");

        assert_eq!(allocation.local_types, vec![ValType::I32; 2]);
        assert_ne!(
            allocation.value_locals[&ValueId(1)],
            allocation.value_locals[&ValueId(2)]
        );
        assert_ne!(
            allocation.value_locals[&ValueId(2)],
            allocation.value_locals[&ValueId(3)]
        );
        assert_eq!(
            allocation.value_locals[&ValueId(1)],
            allocation.value_locals[&ValueId(3)]
        );
    }

    #[test]
    fn simultaneously_live_ssa_values_keep_distinct_wasm_locals() {
        let function = runtime_function(vec![RuntimeContinuation {
            captures: Vec::new(),
            span: span(),
            id: ContinuationId(0),
            parameters: Vec::new(),
            instructions: vec![
                plain_operation(1, Vec::new()),
                plain_operation(2, Vec::new()),
                plain_operation(3, vec![1, 2]),
            ],
            transition: RuntimeTransition::Return { value: ValueId(3) },
        }]);
        let module = allocation_test_module(function.clone());
        let runtime_layouts = RuntimeTypeLayouts::new(&module).expect("layouts should close");

        let allocation =
            allocate_value_locals(&module, &runtime_layouts, &function, 0, HashMap::new())
                .expect("overlapping values should allocate");

        assert_eq!(allocation.local_types, vec![ValType::I32; 3]);
        assert_ne!(
            allocation.value_locals[&ValueId(1)],
            allocation.value_locals[&ValueId(2)]
        );
        assert_ne!(
            allocation.value_locals[&ValueId(1)],
            allocation.value_locals[&ValueId(3)]
        );
        assert_ne!(
            allocation.value_locals[&ValueId(2)],
            allocation.value_locals[&ValueId(3)]
        );
    }

    #[test]
    fn wide_live_product_allocates_without_pairwise_interference_edges() {
        const WIDTH: usize = 2_048;
        let mut operations = (1..=WIDTH)
            .map(|value| plain_operation(value, Vec::new()))
            .collect::<Vec<_>>();
        operations.push(plain_operation(WIDTH + 1, (1..=WIDTH).collect()));
        let function = runtime_function(vec![RuntimeContinuation {
            captures: Vec::new(),
            span: span(),
            id: ContinuationId(0),
            parameters: Vec::new(),
            instructions: operations,
            transition: RuntimeTransition::Return {
                value: ValueId(WIDTH + 1),
            },
        }]);
        let module = allocation_test_module(function.clone());
        let runtime_layouts = RuntimeTypeLayouts::new(&module).expect("layouts should close");

        let allocation =
            allocate_value_locals(&module, &runtime_layouts, &function, 0, HashMap::new())
                .expect("wide live product should allocate");

        assert_eq!(allocation.local_types.len(), WIDTH + 1);
    }

    #[test]
    fn adjacent_wasm_locals_use_counted_declarations() {
        assert_eq!(
            compact_local_declarations(&[
                ValType::I32,
                ValType::I32,
                ValType::F32,
                ValType::F32,
                ValType::I32,
            ]),
            vec![(2, ValType::I32), (2, ValType::F32), (1, ValType::I32),]
        );
    }

    #[test]
    fn equal_physical_function_types_share_one_type_entry() {
        let mut types = FunctionTypes::new();

        let first = types.intern(vec![ValType::I32], vec![ValType::I64]);
        let second = types.intern(vec![ValType::I32], vec![ValType::I64]);

        assert_eq!(first, second);
        assert_eq!(types.section.len(), 1);
    }

    #[test]
    fn direct_call_return_is_a_tail_call_candidate() {
        let mut result = return_block(1);
        result.parameters.push(parameter(7));
        result.transition = RuntimeTransition::Return { value: ValueId(7) };
        let function = runtime_function(vec![call_continuation(0, 2, 1), result]);
        assert_eq!(
            direct_tail_call(&function, &function.continuations[0])
                .map(|candidate| candidate.target),
            Some(FunctionId(2))
        );
        let mut not_tail = function.clone();
        not_tail.continuations[1].transition = RuntimeTransition::Return { value: ValueId(8) };
        assert!(direct_tail_call(&not_tail, &not_tail.continuations[0]).is_none());
    }

    #[test]
    fn direct_call_forwarded_through_empty_join_is_a_tail_call_candidate() {
        let mut join = branch_block(1, 2);
        join.parameters = vec![parameter(7)];
        join.transition = RuntimeTransition::Jump {
            edge: Edge {
                target: ContinuationId(2),
                arguments: vec![Argument::Value(ValueId(7))],
            },
        };
        let mut result = return_block(2);
        result.parameters = vec![parameter(8)];
        result.transition = RuntimeTransition::Return { value: ValueId(8) };
        let function = runtime_function(vec![call_continuation(0, 2, 1), join, result]);
        assert_eq!(
            direct_tail_call(&function, &function.continuations[0])
                .map(|candidate| candidate.target),
            Some(FunctionId(2))
        );
    }

    #[test]
    fn directly_called_exported_tail_body_requires_tail_call_feature() {
        let mut call = call_continuation(0, 0, 1);
        call.parameters = vec![parameter(0)];
        let mut result = return_block(1);
        result.parameters = vec![parameter(7)];
        result.transition = RuntimeTransition::Return { value: ValueId(7) };
        let mut function = runtime_function(vec![call, result]);
        function.name = "exported-tail-body".to_owned();
        let mut module = allocation_test_module(function);
        module.signatures[0].parameters = vec![1];
        module.exports.push(RuntimeExport::Runtime {
            source_name: "default".to_owned(),
            phase: "runtime",
            wasm_name: "blot:default".to_owned(),
            function: 0,
            signature: 0,
            ownership: "plain",
        });
        let runtime_layouts = RuntimeTypeLayouts::new(&module).expect("layouts should close");
        let features =
            required_wasm_features(&module, &runtime_layouts).expect("features should close");
        assert!(features.contains(&"tail-call"));
        assert_eq!(
            internally_emitted_runtime_function_ids(&module),
            BTreeSet::from([FunctionId(0)])
        );
    }

    fn call_continuation(id: usize, target: usize, next: usize) -> RuntimeContinuation {
        RuntimeContinuation {
            id: ContinuationId(id),
            parameters: Vec::new(),
            captures: Vec::new(),
            instructions: Vec::new(),
            span: span(),
            transition: RuntimeTransition::Call {
                target: CallTarget::Function {
                    function: FunctionId(target),
                },
                signature: SignatureId(0),
                arguments: vec![ValueId(0)],
                next: Edge {
                    target: ContinuationId(next),
                    arguments: vec![Argument::Result],
                },
                suspends: false,
            },
        }
    }

    fn plain_operation(result: usize, operands: Vec<usize>) -> RuntimeInstruction {
        RuntimeInstruction {
            definition: parameter(result),
            operands: operands.into_iter().map(ValueId).collect(),
            operation: Operation {
                kind: "scalar",
                value: None,
                update: None,
                case: None,
                operator: Some("boolean.not"),
                conversion: None,
                lane: None,
                field: None,
                function: None,
                signature: None,
                static_store: None,
            },
        }
    }

    fn allocation_test_module(function: RuntimeFunction) -> RuntimeModule {
        RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "local-allocation-test".to_owned(),
            types: vec![RuntimeType::Unit, RuntimeType::Boolean],
            signatures: vec![crate::hir::RuntimeSignature {
                parameters: Vec::new(),
                result: 1,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            graph: Graph {
                functions: vec![function],
            },
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        }
    }

    fn runtime_function(continuations: Vec<RuntimeContinuation>) -> RuntimeFunction {
        RuntimeFunction {
            id: FunctionId(0),
            name: "structured-loop-test".to_owned(),
            signature: SignatureId(0),
            reuse: None,
            entry: ContinuationId(0),
            continuations,
            suspends: false,
            framed: false,
            span: span(),
        }
    }

    fn conditional_block(id: usize, consequent: usize, alternate: usize) -> RuntimeContinuation {
        RuntimeContinuation {
            id: ContinuationId(id),
            parameters: vec![parameter(id)],
            captures: Vec::new(),
            instructions: Vec::new(),
            span: span(),
            transition: RuntimeTransition::Branch {
                condition: ValueId(id),
                consequent: Edge {
                    target: ContinuationId(consequent),
                    arguments: Vec::new(),
                },
                alternate: Edge {
                    target: ContinuationId(alternate),
                    arguments: Vec::new(),
                },
            },
        }
    }

    fn branch_block(id: usize, target: usize) -> RuntimeContinuation {
        RuntimeContinuation {
            id: ContinuationId(id),
            parameters: Vec::new(),
            captures: Vec::new(),
            instructions: Vec::new(),
            span: span(),
            transition: RuntimeTransition::Jump {
                edge: Edge {
                    target: ContinuationId(target),
                    arguments: Vec::new(),
                },
            },
        }
    }

    fn return_block(id: usize) -> RuntimeContinuation {
        RuntimeContinuation {
            id: ContinuationId(id),
            parameters: Vec::new(),
            captures: Vec::new(),
            instructions: Vec::new(),
            span: span(),
            transition: RuntimeTransition::Return { value: ValueId(0) },
        }
    }

    fn parameter(value: usize) -> RuntimeParameter {
        RuntimeParameter {
            value: ValueId(value),
            type_id: TypeId(1),
            ownership: "plain",
            span: span(),
        }
    }

    fn span() -> RuntimeSpan {
        RuntimeSpan {
            file: "structured-loop-test.blot".to_owned(),
            start: 0,
            end: 0,
        }
    }
}
