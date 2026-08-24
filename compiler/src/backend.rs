use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Serialize;
use wasm_encoder::{
    BlockType, BranchHint, BranchHints, CodeSection, ConstExpr, CustomSection, DataSection,
    EntityType, ExportKind, ExportSection, Function, FunctionSection, GlobalSection, GlobalType,
    Ieee32, Ieee64, ImportSection, InstructionSink, MemorySection, MemoryType, Module, TypeSection,
    ValType,
};
use wasmparser::{BinaryReader, FunctionBody, Operator};

use crate::hir::{
    RuntimeBlock, RuntimeExport, RuntimeFunction, RuntimeModule, RuntimeOperation,
    RuntimeTerminator, RuntimeType, WireConstant,
};

const HEAP_GLOBAL: u32 = 0;
const ACTIVE_EXPORT_GLOBAL: u32 = 3;
const RESULT_POINTER_GLOBAL: u32 = 4;
const HEAP_CHECKPOINT_GLOBAL: u32 = 5;
const MAX_STRUCTURED_LOOP_BLOCKS: usize = 128;

#[derive(Clone, Copy)]
struct DynamicHelpers {
    realloc: u32,
    text_compare: Option<u32>,
    text_contains: Option<u32>,
    text_scalar_count: Option<u32>,
    text_scalar_offset: Option<u32>,
    text_find_from: Option<u32>,
    utf8_validator: Option<u32>,
    i64_to_text: Option<u32>,
}

#[derive(Clone, Copy)]
struct CanonicalResult<'a> {
    type_: &'a AbiType,
    runtime_type: usize,
    pointer: u32,
    realloc: u32,
}

#[derive(Clone, Copy)]
enum StructuredResult<'a> {
    Internal,
    Canonical(CanonicalResult<'a>),
}

#[derive(Clone, Copy)]
struct PublicExport<'a> {
    parameter_types: &'a [AbiType],
    parameter_runtime_types: &'a [usize],
    result_type: &'a AbiType,
    result_runtime_type: usize,
    call_id: u32,
}

#[derive(Clone)]
pub struct CompiledModule {
    pub wasm: Vec<u8>,
    pub manifest: Vec<u8>,
    pub capabilities: Vec<String>,
}

pub struct ClosedProgram {
    runtime: RuntimeModule,
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
    #[serde(rename = "signed-integer-64")]
    SignedInteger64,
    #[serde(rename = "float-32")]
    Float32,
    #[serde(rename = "float-64")]
    Float64,
    Boolean,
    Text,
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
}

#[derive(Clone, Serialize)]
struct AbiImport {
    capability: String,
    operation: String,
    module: String,
    name: String,
    function: AbiFunction,
}

#[derive(Serialize)]
struct AbiManifest {
    format: &'static str,
    abi: AbiPolicy,
    source: String,
    exports: Vec<AbiExport>,
    imports: Vec<AbiImport>,
}

pub fn close(runtime: RuntimeModule) -> Result<ClosedProgram, String> {
    let manifest = build_manifest(&runtime)?;
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

fn build_manifest(module: &RuntimeModule) -> Result<AbiManifest, String> {
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
            }),
            RuntimeExport::Runtime {
                source_name,
                phase,
                wasm_name,
                signature,
                ownership,
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
                let post_return = if flattened_type(&function.result).len() > 1 {
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
            });
        }
    }
    let required_features = required_wasm_features(module)?;
    Ok(AbiManifest {
        format: "blot-core-wasm",
        abi: AbiPolicy {
            major: 1,
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
    })
}

fn exported_runtime_function_ids(module: &RuntimeModule) -> BTreeSet<usize> {
    module
        .exports
        .iter()
        .filter_map(|exported| match exported {
            RuntimeExport::Runtime { function, .. } => Some(*function),
            RuntimeExport::Comptime { .. } => None,
        })
        .collect()
}

fn direct_tail_call<'a>(
    function: &'a RuntimeFunction,
    block: &'a RuntimeBlock,
) -> Option<&'a RuntimeOperation> {
    let operation = block.operations.last()?;
    if operation.kind != "call.direct" {
        return None;
    }
    forwards_to_return(
        function,
        &block.terminator,
        operation.result,
        &mut HashSet::new(),
    )
    .then_some(operation)
}

fn forwards_to_return(
    function: &RuntimeFunction,
    terminator: &RuntimeTerminator,
    value: usize,
    visited: &mut HashSet<usize>,
) -> bool {
    match terminator {
        RuntimeTerminator::Return {
            value: returned, ..
        } => *returned == value,
        RuntimeTerminator::Branch {
            target, arguments, ..
        } => {
            if !visited.insert(*target) {
                return false;
            }
            let Some(block) = function.blocks.get(*target) else {
                return false;
            };
            if block.id != *target || !block.operations.is_empty() {
                return false;
            }
            block
                .parameters
                .iter()
                .zip(arguments)
                .filter(|(_, argument)| **argument == value)
                .any(|(parameter, _)| {
                    let mut path = visited.clone();
                    forwards_to_return(function, &block.terminator, parameter.value, &mut path)
                })
        }
        RuntimeTerminator::Conditional { .. } | RuntimeTerminator::Trap { .. } => false,
    }
}

fn runtime_type_uses_simd(module: &RuntimeModule, type_id: usize) -> Result<bool, String> {
    Ok(flattened_runtime_type(module, type_id)?.contains(&ValType::V128))
}

fn required_wasm_features(module: &RuntimeModule) -> Result<Vec<&'static str>, String> {
    let exported_functions = exported_runtime_function_ids(module);
    let internal_functions = module
        .functions
        .iter()
        .filter(|function| !exported_functions.contains(&function.id))
        .collect::<Vec<_>>();
    let internal_ids = internal_functions
        .iter()
        .map(|function| function.id)
        .collect::<BTreeSet<_>>();
    let mut features = BTreeSet::new();

    // `cabi_realloc` always contains `memory.copy`, so every emitted artifact
    // requires bulk-memory even when the source does not allocate dynamically.
    features.insert("bulk-memory");

    let helper_uses_multi_value = module.functions.iter().any(|function| {
        function.blocks.iter().any(|block| {
            block
                .operations
                .iter()
                .any(|operation| operation.kind == "text.from-i64")
        })
    });
    let mut uses_multi_value = helper_uses_multi_value;
    for function in &internal_functions {
        let signature = module.signatures.get(function.signature).ok_or_else(|| {
            format!(
                "{}: runtime function {} references unknown signature {}",
                module.source, function.id, function.signature
            )
        })?;
        uses_multi_value |= flattened_runtime_type(module, signature.result)?.len() > 1;
    }
    if uses_multi_value {
        features.insert("multi-value");
    }

    let mut uses_simd = false;
    for function in &module.functions {
        let signature = module.signatures.get(function.signature).ok_or_else(|| {
            format!(
                "{}: runtime function {} references unknown signature {}",
                module.source, function.id, function.signature
            )
        })?;
        for type_id in signature
            .parameters
            .iter()
            .copied()
            .chain(std::iter::once(signature.result))
        {
            uses_simd |= runtime_type_uses_simd(module, type_id)?;
        }
        for block in &function.blocks {
            for parameter in &block.parameters {
                uses_simd |= runtime_type_uses_simd(module, parameter.type_id)?;
            }
            for operation in &block.operations {
                uses_simd |= runtime_type_uses_simd(module, operation.type_id)?;
            }
        }
    }
    if uses_simd {
        features.insert("simd");
    }

    let uses_tail_calls = internal_functions.iter().any(|function| {
        function.blocks.iter().any(|block| {
            direct_tail_call(function, block)
                .and_then(|operation| operation.function)
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
    runtime_layout_type(module, type_id, resolving, false)
}

fn runtime_layout_type(
    module: &RuntimeModule,
    type_id: usize,
    resolving: &mut Vec<usize>,
    admit_indirect: bool,
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
        RuntimeType::Integer32 => {
            return Err(format!(
                "{}: internal integer-32 type {type_id} cannot cross the Blot ABI",
                module.source
            ));
        }
        RuntimeType::SignedInteger64 => Some(AbiType::SignedInteger64),
        RuntimeType::Float32 => Some(AbiType::Float32),
        RuntimeType::Float64 => Some(AbiType::Float64),
        RuntimeType::Boolean => Some(AbiType::Boolean),
        RuntimeType::Text => Some(AbiType::Text),
        _ => None,
    };
    if let Some(scalar) = scalar {
        return Ok(scalar);
    }
    resolving.push(type_id);
    let canonical = match type_ {
        RuntimeType::Store { element_type } => AbiType::Array {
            element: Box::new(runtime_layout_type(
                module,
                *element_type,
                resolving,
                admit_indirect,
            )?),
        },
        RuntimeType::Scratch { .. } if admit_indirect => AbiType::Record {
            fields: ["0", "1", "2"]
                .into_iter()
                .map(|name| AbiField {
                    name: name.to_owned(),
                    type_: AbiType::InternalPointer,
                })
                .collect(),
        },
        RuntimeType::Scratch { .. } => {
            return Err(format!(
                "{}: live Scratch type {type_id} cannot cross Blot Core Wasm ABI 1",
                module.source
            ));
        }
        RuntimeType::Indirect { .. } if admit_indirect => AbiType::InternalPointer,
        RuntimeType::Indirect { .. } => {
            return Err(format!(
                "{}: recursive type {type_id} cannot cross Blot Core Wasm ABI 1",
                module.source
            ));
        }
        RuntimeType::Product { name, .. } if name.starts_with("$region:") => {
            return Err(format!(
                "{}: live Region type {type_id} cannot cross Blot Core Wasm ABI 1",
                module.source
            ));
        }
        RuntimeType::Product { fields, .. } => {
            let mut fields = fields.clone();
            fields.sort_by(|left, right| left.name.cmp(&right.name));
            AbiType::Record {
                fields: fields
                    .into_iter()
                    .map(|field| {
                        Ok(AbiField {
                            name: field.name,
                            type_: runtime_layout_type(
                                module,
                                field.type_id,
                                resolving,
                                admit_indirect,
                            )?,
                        })
                    })
                    .collect::<Result<_, String>>()?,
            }
        }
        RuntimeType::Sum { cases, .. } => {
            let mut cases = cases.clone();
            if !admit_indirect {
                cases.sort_by(|left, right| left.name.cmp(&right.name));
            }
            AbiType::Variant {
                cases: cases
                    .into_iter()
                    .map(|case_| {
                        let payload = runtime_layout_type(
                            module,
                            case_.payload_type,
                            resolving,
                            admit_indirect,
                        )?;
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
                admit_indirect,
            )?),
        },
        RuntimeType::Vector { .. } | RuntimeType::Mask { .. } => {
            return Err(format!(
                "{}: SIMD type {type_id} cannot cross the Blot ABI",
                module.source
            ));
        }
        RuntimeType::Unit
        | RuntimeType::Integer32
        | RuntimeType::SignedInteger64
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
        AbiType::SignedInteger64 => vec![ValType::I64],
        AbiType::Float32 => vec![ValType::F32],
        AbiType::Float64 => vec![ValType::F64],
        AbiType::Boolean => vec![ValType::I32],
        AbiType::Text | AbiType::Array { .. } => vec![ValType::I32, ValType::I32],
        AbiType::Sealed { inner, .. } => flattened_type(inner),
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

fn emit_dynamic_module(
    module: &RuntimeModule,
    manifest: &AbiManifest,
    manifest_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let mut static_end = 1_024_u32;
    let mut text_offsets = HashMap::new();
    let mut data_segments = Vec::new();
    for function in &module.functions {
        for block in &function.blocks {
            for operation in &block.operations {
                let Some(WireConstant::Text(value)) = &operation.value else {
                    continue;
                };
                let offset = static_end;
                static_end = static_end
                    .checked_add(value.len() as u32)
                    .ok_or_else(|| format!("{}: residual text exceeds memory32", module.source))?;
                text_offsets.insert((function.id, operation.result), offset);
                data_segments.push((offset, value.as_bytes().to_vec()));
            }
        }
    }
    let heap_start = align_to(static_end, 8);

    let mut types = TypeSection::new();
    let mut imports = ImportSection::new();
    for imported in &manifest.imports {
        let mut parameters = imported
            .function
            .parameters
            .iter()
            .flat_map(flattened_type)
            .collect::<Vec<_>>();
        let flattened_results = flattened_type(&imported.function.result);
        let results = if flattened_results.len() <= 1 {
            flattened_results
        } else {
            parameters.push(ValType::I32);
            Vec::new()
        };
        let type_index = add_function_type(&mut types, parameters, results);
        imports.import(
            &imported.module,
            &imported.name,
            EntityType::Function(type_index),
        );
    }

    let mut functions = FunctionSection::new();
    let mut code = CodeSection::new();
    let mut branch_hints = BranchHints::new();
    let imported_function_count = manifest.imports.len() as u32;
    let realloc_type = add_function_type(
        &mut types,
        vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
        vec![ValType::I32],
    );
    let realloc_index = imported_function_count;
    functions.function(realloc_type);
    append_code_function(
        &mut code,
        &mut branch_hints,
        realloc_index,
        realloc_function(),
    )?;

    let has_operation = |kind: &str| {
        module.functions.iter().any(|function| {
            function.blocks.iter().any(|block| {
                block
                    .operations
                    .iter()
                    .any(|operation| operation.kind == kind)
            })
        })
    };
    let text_compare_index = if has_operation("text.compare") {
        let type_index = add_function_type(
            &mut types,
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
    let text_contains_index = if has_operation("text.contains") {
        let type_index = add_function_type(
            &mut types,
            vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
            vec![ValType::I32],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            text_contains_function(),
        )?;
        Some(function_index)
    } else {
        None
    };
    let text_scalar_count_index = if has_operation("text.length") || has_operation("text.find-from")
    {
        let type_index = add_function_type(
            &mut types,
            vec![ValType::I32, ValType::I32],
            vec![ValType::I64],
        );
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&text_scalar_count_function());
        Some(function_index)
    } else {
        None
    };
    let text_scalar_offset_index = if has_operation("text.scalar-at")
        || has_operation("text.slice")
        || has_operation("text.find-from")
    {
        let type_index = add_function_type(
            &mut types,
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
    let text_find_from_index = if has_operation("text.find-from") {
        let type_index = add_function_type(
            &mut types,
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
        code.function(&text_find_from_function());
        Some(function_index)
    } else {
        None
    };
    let utf8_validator_index = if has_operation("host.call") {
        let type_index =
            add_function_type(&mut types, vec![ValType::I32, ValType::I32], Vec::new());
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            utf8_validator_function(),
        )?;
        Some(function_index)
    } else {
        None
    };
    let i64_to_text_index = if has_operation("text.from-i64") {
        let type_index = add_function_type(
            &mut types,
            vec![ValType::I64],
            vec![ValType::I32, ValType::I32],
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
    let dynamic_helpers = DynamicHelpers {
        realloc: realloc_index,
        text_compare: text_compare_index,
        text_contains: text_contains_index,
        text_scalar_count: text_scalar_count_index,
        text_scalar_offset: text_scalar_offset_index,
        text_find_from: text_find_from_index,
        utf8_validator: utf8_validator_index,
        i64_to_text: i64_to_text_index,
    };

    let exported_functions = exported_runtime_function_ids(module);
    let mut runtime_function_indices = HashMap::new();
    let internal_functions = module
        .functions
        .iter()
        .filter(|function| !exported_functions.contains(&function.id))
        .collect::<Vec<_>>();
    for function in &internal_functions {
        let signature = module.signatures.get(function.signature).ok_or_else(|| {
            format!(
                "{}: runtime function {} references unknown signature {}",
                module.source, function.id, function.signature
            )
        })?;
        let mut parameters = Vec::new();
        for type_id in &signature.parameters {
            parameters.extend(flattened_runtime_type(module, *type_id)?);
        }
        let results = flattened_runtime_type(module, signature.result)?;
        let type_index = add_function_type(&mut types, parameters, results);
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
                function,
                manifest,
                dynamic_helpers,
                &text_offsets,
                &runtime_function_indices,
            )?,
        )?;
    }

    let mut function_exports = Vec::new();
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
        let flattened_result = flattened_type(result);
        let wasm_results = if flattened_result.len() <= 1 {
            flattened_result
        } else {
            vec![ValType::I32]
        };
        let wasm_parameters = public_function
            .parameters
            .iter()
            .flat_map(flattened_type)
            .collect();
        let type_index = add_function_type(&mut types, wasm_parameters, wasm_results);
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        append_code_function(
            &mut code,
            &mut branch_hints,
            function_index,
            dynamic_export_function(
                module,
                runtime_function,
                manifest,
                PublicExport {
                    parameter_types: &public_function.parameters,
                    parameter_runtime_types: &signature.parameters,
                    result_type: result,
                    result_runtime_type: signature.result,
                    call_id: export_ordinal as u32 + 1,
                },
                dynamic_helpers,
                &text_offsets,
                &runtime_function_indices,
            )?,
        )?;
        function_exports.push((wasm_name.clone(), function_index));
        if let Some(post_return) = &manifest_export.post_return {
            let post_type = add_function_type(&mut types, vec![ValType::I32], Vec::new());
            let post_index = imported_function_count + functions.len();
            functions.function(post_type);
            append_code_function(
                &mut code,
                &mut branch_hints,
                post_index,
                post_return_function(export_ordinal as u32 + 1),
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
    let mut globals = GlobalSection::new();
    add_i32_global(&mut globals, heap_start as i32, true);
    add_i32_global(&mut globals, 1, false);
    add_i32_global(&mut globals, 0, false);
    add_i32_global(&mut globals, 0, true);
    add_i32_global(&mut globals, 0, true);
    add_i32_global(&mut globals, heap_start as i32, true);

    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("cabi_realloc", ExportKind::Func, realloc_index);
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
    wasm.section(&types);
    if !manifest.imports.is_empty() {
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

fn dynamic_internal_function(
    module: &RuntimeModule,
    function: &RuntimeFunction,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    text_offsets: &HashMap<(usize, usize), u32>,
    runtime_function_indices: &HashMap<usize, u32>,
) -> Result<Function, String> {
    let signature = module.signatures.get(function.signature).ok_or_else(|| {
        format!(
            "{}: runtime function {} references unknown signature {}",
            module.source, function.id, function.signature
        )
    })?;
    let entry = function
        .blocks
        .iter()
        .find(|block| block.id == function.entry_block)
        .ok_or_else(|| {
            format!(
                "{}: runtime function {} has no entry block {}",
                module.source, function.id, function.entry_block
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
        if parameter.type_id != *type_id {
            return Err(format!(
                "{}: runtime function {} entry parameter type does not match its signature",
                module.source, function.id
            ));
        }
        let flattened = flattened_runtime_type(module, *type_id)?;
        value_locals.insert(
            parameter.value,
            (parameter_count..parameter_count + flattened.len() as u32).collect(),
        );
        parameter_count += flattened.len() as u32;
    }

    let mut definitions = BTreeMap::new();
    for block in &function.blocks {
        for parameter in &block.parameters {
            if !value_locals.contains_key(&parameter.value) {
                definitions.insert(parameter.value, parameter.type_id);
            }
        }
        for operation in &block.operations {
            definitions.insert(operation.result, operation.type_id);
        }
    }
    let mut local_types = Vec::new();
    for (value, type_id) in definitions {
        let flattened = flattened_runtime_type(module, type_id)?;
        let start = parameter_count + local_types.len() as u32;
        local_types.extend(flattened.iter().copied());
        value_locals.insert(
            value,
            (start..start + flattened.len() as u32).collect::<Vec<_>>(),
        );
    }
    let structured_loop = structured_loop_eligible(function);
    let dispatcher = if structured_loop {
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

    let mut wasm_function = Function::new(local_types.into_iter().map(|type_| (1, type_)));
    let mut instructions = wasm_function.instructions();
    if structured_loop {
        instructions.loop_(BlockType::Empty);
        emit_structured_loop_block(
            &mut instructions,
            module,
            function,
            function.entry_block,
            manifest,
            helpers,
            text_offsets,
            &value_locals,
            scratch_pointer,
            scratch_length,
            scratch_index,
            runtime_function_indices,
            StructuredResult::Internal,
            0,
        )?;
        instructions.unreachable().end().unreachable().end();
    } else {
        let dispatcher = dispatcher.expect("dispatcher loop omitted its state local");
        instructions
            .i32_const(function.entry_block as i32)
            .local_set(dispatcher)
            .loop_(BlockType::Empty);
        for block in &function.blocks {
            instructions
                .local_get(dispatcher)
                .i32_const(block.id as i32)
                .i32_eq()
                .if_(BlockType::Empty);
            let tail_call = direct_tail_call(function, block);
            let operation_count = block.operations.len() - if tail_call.is_some() { 1 } else { 0 };
            for operation in &block.operations[..operation_count] {
                emit_dynamic_operation(
                    &mut instructions,
                    module,
                    function,
                    operation,
                    manifest,
                    helpers,
                    text_offsets,
                    &value_locals,
                    scratch_pointer,
                    scratch_length,
                    scratch_index,
                    runtime_function_indices,
                )?;
            }
            if let Some(operation) = tail_call {
                emit_direct_tail_call(
                    &mut instructions,
                    module,
                    function,
                    operation,
                    &value_locals,
                    runtime_function_indices,
                )?;
            } else {
                emit_internal_terminator(
                    &mut instructions,
                    module,
                    function,
                    &block.terminator,
                    &value_locals,
                    dispatcher,
                )?;
            }
            instructions.end();
        }
        instructions.unreachable().end().unreachable().end();
    }
    Ok(wasm_function)
}

fn dynamic_export_function(
    module: &RuntimeModule,
    function: &RuntimeFunction,
    manifest: &AbiManifest,
    public_export: PublicExport<'_>,
    helpers: DynamicHelpers,
    text_offsets: &HashMap<(usize, usize), u32>,
    runtime_function_indices: &HashMap<usize, u32>,
) -> Result<Function, String> {
    let entry = function
        .blocks
        .iter()
        .find(|block| block.id == function.entry_block)
        .ok_or_else(|| {
            format!(
                "{}: exported runtime function {} has no entry block {}",
                module.source, function.id, function.entry_block
            )
        })?;
    if entry.parameters.len() != public_export.parameter_runtime_types.len()
        || entry.parameters.len() != public_export.parameter_types.len()
    {
        return Err(format!(
            "{}: exported runtime function {} does not match its public parameters",
            module.source, function.id
        ));
    }
    let mut value_locals = HashMap::new();
    let mut parameter_count = 0_u32;
    for ((parameter, runtime_type), public_type) in entry
        .parameters
        .iter()
        .zip(public_export.parameter_runtime_types)
        .zip(public_export.parameter_types)
    {
        if parameter.type_id != *runtime_type {
            return Err(format!(
                "{}: exported runtime function {} entry parameter type does not match its signature",
                module.source, function.id
            ));
        }
        let runtime_flattened = flattened_runtime_type(module, *runtime_type)?;
        let public_flattened = flattened_type(public_type);
        if runtime_flattened != public_flattened {
            return Err(format!(
                "{}: exported runtime function {} parameter has incompatible public and runtime layouts",
                module.source, function.id
            ));
        }
        value_locals.insert(
            parameter.value,
            (parameter_count..parameter_count + runtime_flattened.len() as u32).collect(),
        );
        parameter_count += runtime_flattened.len() as u32;
    }
    let mut definitions = BTreeMap::new();
    for block in &function.blocks {
        for parameter in &block.parameters {
            if !value_locals.contains_key(&parameter.value) {
                definitions.insert(parameter.value, parameter.type_id);
            }
        }
        for operation in &block.operations {
            definitions.insert(operation.result, operation.type_id);
        }
    }
    let mut local_types = Vec::new();
    for (value, type_id) in definitions {
        let flattened = flattened_runtime_type(module, type_id)?;
        let start = parameter_count + local_types.len() as u32;
        local_types.extend(flattened.iter().copied());
        value_locals.insert(
            value,
            (start..start + flattened.len() as u32).collect::<Vec<_>>(),
        );
    }
    let structured_loop = structured_loop_eligible(function);
    let dispatcher = if structured_loop {
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
    let mut wasm_function = Function::new(local_types.into_iter().map(|type_| (1, type_)));
    let mut instructions = wasm_function.instructions();
    begin_call(&mut instructions, public_export.call_id);
    if structured_loop {
        instructions.loop_(BlockType::Empty);
        emit_structured_loop_block(
            &mut instructions,
            module,
            function,
            function.entry_block,
            manifest,
            helpers,
            text_offsets,
            &value_locals,
            scratch_pointer,
            scratch_length,
            scratch_index,
            runtime_function_indices,
            StructuredResult::Canonical(CanonicalResult {
                type_: public_export.result_type,
                runtime_type: public_export.result_runtime_type,
                pointer: scratch_pointer,
                realloc: helpers.realloc,
            }),
            0,
        )?;
        instructions.unreachable().end().unreachable().end();
    } else {
        let dispatcher = dispatcher.expect("dispatcher loop omitted its state local");
        instructions
            .i32_const(function.entry_block as i32)
            .local_set(dispatcher)
            .loop_(BlockType::Empty);
        for block in &function.blocks {
            instructions
                .local_get(dispatcher)
                .i32_const(block.id as i32)
                .i32_eq()
                .if_(BlockType::Empty);
            for operation in &block.operations {
                emit_dynamic_operation(
                    &mut instructions,
                    module,
                    function,
                    operation,
                    manifest,
                    helpers,
                    text_offsets,
                    &value_locals,
                    scratch_pointer,
                    scratch_length,
                    scratch_index,
                    runtime_function_indices,
                )?;
            }
            emit_dynamic_terminator(
                &mut instructions,
                module,
                function,
                &block.terminator,
                &value_locals,
                dispatcher,
                CanonicalResult {
                    type_: public_export.result_type,
                    runtime_type: public_export.result_runtime_type,
                    pointer: scratch_pointer,
                    realloc: helpers.realloc,
                },
            )?;
            instructions.end();
        }
        instructions.unreachable().end().unreachable().end();
    }
    Ok(wasm_function)
}

#[allow(clippy::too_many_arguments)]
fn emit_dynamic_operation(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    operation: &RuntimeOperation,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    text_offsets: &HashMap<(usize, usize), u32>,
    value_locals: &HashMap<usize, Vec<u32>>,
    scratch_pointer: u32,
    scratch_length: u32,
    scratch_index: u32,
    runtime_function_indices: &HashMap<usize, u32>,
) -> Result<(), String> {
    let result = locals_for(module, value_locals, operation.result)?;
    match operation.kind {
        "constant" => match operation
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
                let offset = text_offsets
                    .get(&(function.id, operation.result))
                    .ok_or_else(|| {
                        format!("{}: residual text has no data offset", module.source)
                    })?;
                instructions
                    .i32_const(*offset as i32)
                    .local_set(result[0])
                    .i32_const(value.len() as i32)
                    .local_set(result[1]);
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
        "host.call" => {
            let utf8_validator = helpers.utf8_validator.ok_or_else(|| {
                format!("{}: host.call omitted the UTF-8 validator", module.source)
            })?;
            let capability = operation
                .capability
                .as_deref()
                .ok_or_else(|| format!("{}: host.call omitted its capability", module.source))?;
            let name = operation
                .operation
                .as_deref()
                .ok_or_else(|| format!("{}: host.call omitted its operation", module.source))?;
            let (import_index, imported) = manifest
                .imports
                .iter()
                .enumerate()
                .find(|(_, imported)| {
                    imported.capability == capability && imported.operation == name
                })
                .ok_or_else(|| {
                    format!("{}: manifest omitted {capability}.{name}", module.source)
                })?;
            for operand in &operation.operands {
                emit_local_values(instructions, locals_for(module, value_locals, *operand)?);
            }
            let flattened_result = flattened_type(&imported.function.result);
            if flattened_result.len() <= 1 {
                instructions.call(import_index as u32);
                if let Some(local) = result.first() {
                    instructions.local_set(*local);
                }
            } else {
                instructions
                    .i32_const(0)
                    .i32_const(0)
                    .i32_const(4)
                    .i32_const(memory_layout(&imported.function.result).size as i32)
                    .call(helpers.realloc)
                    .local_tee(scratch_pointer)
                    .call(import_index as u32);
                emit_load_canonical_result(
                    instructions,
                    &imported.function.result,
                    result,
                    scratch_pointer,
                    0,
                )?;
                let mut flat_index = 0;
                emit_validate_canonical_texts(
                    instructions,
                    &imported.function.result,
                    result,
                    &mut flat_index,
                    scratch_length,
                    utf8_validator,
                )?;
            }
        }
        "call.direct" => {
            let target = operation
                .function
                .ok_or_else(|| format!("{}: call.direct omitted its function", module.source))?;
            let function_index = runtime_function_indices.get(&target).ok_or_else(|| {
                format!(
                    "{}: call.direct references unavailable function {target}",
                    module.source
                )
            })?;
            for operand in &operation.operands {
                emit_local_values(instructions, locals_for(module, value_locals, *operand)?);
            }
            instructions.call(*function_index);
            for local in result.iter().rev() {
                instructions.local_set(*local);
            }
        }
        "text.compare" => {
            let text_compare = helpers.text_compare.ok_or_else(|| {
                format!("{}: text.compare omitted its runtime helper", module.source)
            })?;
            let left = locals_for(module, value_locals, operation.operands[0])?;
            let right = locals_for(module, value_locals, operation.operands[1])?;
            emit_local_values(instructions, left);
            emit_local_values(instructions, right);
            instructions.call(text_compare).local_set(result[0]);
        }
        "text.contains" => {
            let text_contains = helpers.text_contains.ok_or_else(|| {
                format!(
                    "{}: text.contains omitted its runtime helper",
                    module.source
                )
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let query = locals_for(module, value_locals, operation.operands[1])?;
            emit_local_values(instructions, text);
            emit_local_values(instructions, query);
            instructions.call(text_contains).local_set(result[0]);
        }
        "text.length" => {
            let scalar_count = helpers.text_scalar_count.ok_or_else(|| {
                format!("{}: text.length omitted its runtime helper", module.source)
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            emit_local_values(instructions, text);
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
                .local_set(result[1]);
        }
        "text.slice" => {
            let scalar_offset = helpers.text_scalar_offset.ok_or_else(|| {
                format!("{}: text.slice omitted its runtime helper", module.source)
            })?;
            let text = locals_for(module, value_locals, operation.operands[0])?;
            let start = locals_for(module, value_locals, operation.operands[1])?;
            let end = locals_for(module, value_locals, operation.operands[2])?;
            instructions
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
                .local_set(result[1]);
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
                .local_set(result[1])
                .local_set(result[0]);
        }
        "scalar" => {
            let left = locals_for(module, value_locals, operation.operands[0])?;
            let right = locals_for(module, value_locals, operation.operands[1])?;
            let operand_type = runtime_value_type(function, operation.operands[0])?;
            if matches!(module.types[operand_type], RuntimeType::SignedInteger64) {
                emit_i64_operation(
                    instructions,
                    left[0],
                    right[0],
                    result[0],
                    operation.operator,
                    &module.source,
                )?;
            } else if matches!(module.types[operand_type], RuntimeType::Float32) {
                emit_float_operation(
                    instructions,
                    left[0],
                    right[0],
                    result[0],
                    operation.operator,
                    true,
                    &module.source,
                )?;
            } else if matches!(module.types[operand_type], RuntimeType::Float64) {
                emit_float_operation(
                    instructions,
                    left[0],
                    right[0],
                    result[0],
                    operation.operator,
                    false,
                    &module.source,
                )?;
            } else {
                instructions.local_get(left[0]).local_get(right[0]);
                emit_i32_operator(instructions, operation.operator, &module.source)?;
                instructions.local_set(result[0]);
            }
        }
        "scalar.unary" => {
            let operand = locals_for(module, value_locals, operation.operands[0])?;
            let operand_type = runtime_value_type(function, operation.operands[0])?;
            instructions.local_get(operand[0]);
            match (&module.types[operand_type], operation.operator) {
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
            match operation.conversion {
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
                value_locals,
                result[0],
            )?;
        }
        "product.make" => {
            let mut destination = 0;
            for operand in &operation.operands {
                let source = locals_for(module, value_locals, *operand)?;
                let end = destination + source.len();
                assign_locals(instructions, &result[destination..end], source)?;
                destination = end;
            }
        }
        "product.project" => {
            let product_type = runtime_value_type(function, operation.operands[0])?;
            let RuntimeType::Product { fields, .. } = &module.types[product_type] else {
                return Err(format!(
                    "{}: product.project reads a non-product",
                    module.source
                ));
            };
            let field = operation
                .field
                .ok_or_else(|| format!("{}: product.project omitted its field", module.source))?;
            let mut offset = 0;
            for field_type in fields.iter().take(field) {
                offset += flattened_runtime_type(module, field_type.type_id)?.len();
            }
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
                        .case
                        .ok_or_else(|| format!("{}: sum.make omitted its case", module.source))?
                        as i32,
                )
                .local_set(result[0]);
            let payload = locals_for(module, value_locals, operation.operands[0])?;
            assign_locals(instructions, &result[1..1 + payload.len()], payload)?;
            let flattened = flattened_runtime_type(module, operation.type_id)?;
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
            assign_locals(instructions, result, &sum[1..1 + result.len()])?;
        }
        "indirect.make" => {
            let RuntimeType::Indirect { target_type } = module
                .types
                .get(operation.type_id)
                .ok_or_else(|| format!("{}: indirect.make has no result type", module.source))?
            else {
                return Err(format!(
                    "{}: indirect.make result is not indirect",
                    module.source
                ));
            };
            let target_layout = runtime_layout_type(module, *target_type, &mut Vec::new(), true)?;
            let layout = memory_layout(&target_layout);
            let value = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .i32_const(0)
                .i32_const(0)
                .i32_const(layout.alignment as i32)
                .i32_const(layout.size as i32)
                .call(helpers.realloc)
                .local_set(result[0]);
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
            let indirect_type = runtime_value_type(function, operation.operands[0])?;
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
            if *target_type != operation.type_id {
                return Err(format!(
                    "{}: indirect.load target type differs from its result",
                    module.source
                ));
            }
            let target_layout = runtime_layout_type(module, *target_type, &mut Vec::new(), true)?;
            let pointer = locals_for(module, value_locals, operation.operands[0])?;
            emit_load_canonical_result(instructions, &target_layout, result, pointer[0], 0)?;
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
            let store_type = runtime_value_type(function, operation.operands[0])?;
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
            let element_type = canonical_type(module, element_type_id, &mut Vec::new())?;
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
        "store.new" => {
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.type_id)
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
            let element_type = canonical_type(module, element_type_id, &mut Vec::new())?;
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
            emit_store_public_result(
                instructions,
                module,
                element_type_id,
                &element_type,
                initial,
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
                .get(operation.type_id)
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
            let element_type = canonical_type(module, element_type_id, &mut Vec::new())?;
            let element_layout = memory_layout(&element_type);
            if operation.update == Some("persistent") {
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
                assign_locals(instructions, result, store)?;
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
            emit_store_public_result(
                instructions,
                module,
                element_type_id,
                &element_type,
                value,
                scratch_pointer,
                0,
            )?;
        }
        "store.grow" => {
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.type_id)
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
            let element_type = canonical_type(module, element_type_id, &mut Vec::new())?;
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
            if operation.update == Some("owned-reuse") {
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
            if operation.update == Some("persistent") {
                instructions
                    .local_get(result[0])
                    .local_get(store[0])
                    .local_get(store[1])
                    .i32_const(element_layout.size as i32)
                    .i32_mul()
                    .memory_copy(0, 0);
            }
            instructions
                .local_get(result[0])
                .local_get(store[1])
                .i32_const(element_layout.size as i32)
                .i32_mul()
                .i32_add()
                .local_set(scratch_pointer);
            emit_store_public_result(
                instructions,
                module,
                element_type_id,
                &element_type,
                value,
                scratch_pointer,
                0,
            )?;
        }
        "scratch.with-capacity" => {
            let RuntimeType::Scratch { element_type } =
                module.types.get(operation.type_id).ok_or_else(|| {
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
            let element_type = canonical_type(module, *element_type, &mut Vec::new())?;
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
                .get(operation.type_id)
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
            let element_type = canonical_type(module, element_type_id, &mut Vec::new())?;
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
            emit_store_public_result(
                instructions,
                module,
                element_type_id,
                &element_type,
                value,
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
            instructions
                .local_get(store[0])
                .local_set(result[0])
                .i32_const(0)
                .local_set(result[1])
                .local_get(store[1])
                .local_set(result[2]);
        }
        "seal.wrap" | "seal.unwrap" | "resource.move" | "resource.borrow" | "resource.freeze" => {
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
    Ok(())
}

fn structured_loop_eligible(function: &RuntimeFunction) -> bool {
    let mut active = HashSet::new();
    let mut expanded = HashSet::new();
    let mut has_back_edge = false;
    let Some(expanded_blocks) = structured_loop_expansion(
        function,
        function.entry_block,
        &mut active,
        &mut expanded,
        &mut has_back_edge,
    ) else {
        return false;
    };
    has_back_edge && expanded_blocks <= MAX_STRUCTURED_LOOP_BLOCKS
}

fn structured_loop_expansion(
    function: &RuntimeFunction,
    block_id: usize,
    active: &mut HashSet<usize>,
    expanded: &mut HashSet<usize>,
    has_back_edge: &mut bool,
) -> Option<usize> {
    // Recursive emission unfolds targets as nested Wasm constructs. A shared
    // join would be emitted under more than one construct, so leave arbitrary
    // reconvergent CFGs to the dispatcher instead of guessing a duplication.
    if !active.insert(block_id) || !expanded.insert(block_id) {
        return None;
    }
    let block = function.blocks.get(block_id)?;
    if block.id != block_id {
        return None;
    }
    let mut expanded_blocks = 1;
    for target in terminator_targets(&block.terminator) {
        if target == function.entry_block {
            *has_back_edge = true;
            continue;
        }
        expanded_blocks +=
            structured_loop_expansion(function, target, active, expanded, has_back_edge)?;
        if expanded_blocks > MAX_STRUCTURED_LOOP_BLOCKS {
            return None;
        }
    }
    active.remove(&block_id);
    Some(expanded_blocks)
}

fn terminator_targets(terminator: &RuntimeTerminator) -> Vec<usize> {
    match terminator {
        RuntimeTerminator::Branch { target, .. } => vec![*target],
        RuntimeTerminator::Conditional {
            consequent,
            alternate,
            ..
        } => vec![*consequent, *alternate],
        RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_structured_loop_block(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    block_id: usize,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    text_offsets: &HashMap<(usize, usize), u32>,
    value_locals: &HashMap<usize, Vec<u32>>,
    scratch_pointer: u32,
    scratch_length: u32,
    scratch_index: u32,
    runtime_function_indices: &HashMap<usize, u32>,
    result: StructuredResult<'_>,
    loop_depth: u32,
) -> Result<(), String> {
    let block = function.blocks.get(block_id).ok_or_else(|| {
        format!(
            "{}: structured loop references unknown block {block_id}",
            module.source
        )
    })?;
    if block.id != block_id {
        return Err(format!(
            "{}: structured loop block index {block_id} contains block {}",
            module.source, block.id
        ));
    }
    let tail_call = if matches!(result, StructuredResult::Internal) {
        direct_tail_call(function, block)
    } else {
        None
    };
    let operation_count = block.operations.len() - if tail_call.is_some() { 1 } else { 0 };
    for operation in &block.operations[..operation_count] {
        emit_dynamic_operation(
            instructions,
            module,
            function,
            operation,
            manifest,
            helpers,
            text_offsets,
            value_locals,
            scratch_pointer,
            scratch_length,
            scratch_index,
            runtime_function_indices,
        )?;
    }
    if let Some(operation) = tail_call {
        emit_direct_tail_call(
            instructions,
            module,
            function,
            operation,
            value_locals,
            runtime_function_indices,
        )?;
        return Ok(());
    }
    match &block.terminator {
        RuntimeTerminator::Branch {
            target, arguments, ..
        } => emit_structured_loop_target(
            instructions,
            module,
            function,
            *target,
            arguments,
            manifest,
            helpers,
            text_offsets,
            value_locals,
            scratch_pointer,
            scratch_length,
            scratch_index,
            runtime_function_indices,
            result,
            loop_depth,
        )?,
        RuntimeTerminator::Conditional {
            condition,
            consequent,
            consequent_arguments,
            alternate,
            alternate_arguments,
            ..
        } => {
            let condition = locals_for(module, value_locals, *condition)?;
            instructions.local_get(condition[0]).if_(BlockType::Empty);
            emit_structured_loop_target(
                instructions,
                module,
                function,
                *consequent,
                consequent_arguments,
                manifest,
                helpers,
                text_offsets,
                value_locals,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                result,
                loop_depth + 1,
            )?;
            instructions.else_();
            emit_structured_loop_target(
                instructions,
                module,
                function,
                *alternate,
                alternate_arguments,
                manifest,
                helpers,
                text_offsets,
                value_locals,
                scratch_pointer,
                scratch_length,
                scratch_index,
                runtime_function_indices,
                result,
                loop_depth + 1,
            )?;
            instructions.end();
        }
        RuntimeTerminator::Return { value, .. } => {
            emit_structured_return(instructions, module, value_locals, *value, result)?;
        }
        RuntimeTerminator::Trap { .. } => {
            instructions.unreachable();
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_structured_loop_target(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    target: usize,
    arguments: &[usize],
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    text_offsets: &HashMap<(usize, usize), u32>,
    value_locals: &HashMap<usize, Vec<u32>>,
    scratch_pointer: u32,
    scratch_length: u32,
    scratch_index: u32,
    runtime_function_indices: &HashMap<usize, u32>,
    result: StructuredResult<'_>,
    loop_depth: u32,
) -> Result<(), String> {
    assign_block_arguments(
        instructions,
        module,
        function,
        target,
        arguments,
        value_locals,
    )?;
    if target == function.entry_block {
        instructions.br(loop_depth);
        return Ok(());
    }
    emit_structured_loop_block(
        instructions,
        module,
        function,
        target,
        manifest,
        helpers,
        text_offsets,
        value_locals,
        scratch_pointer,
        scratch_length,
        scratch_index,
        runtime_function_indices,
        result,
        loop_depth,
    )
}

fn emit_structured_return(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    value_locals: &HashMap<usize, Vec<u32>>,
    value: usize,
    result: StructuredResult<'_>,
) -> Result<(), String> {
    match result {
        StructuredResult::Internal => {
            emit_local_values(instructions, locals_for(module, value_locals, value)?);
        }
        StructuredResult::Canonical(canonical) => {
            emit_canonical_return(instructions, module, value_locals, value, canonical)?;
        }
    }
    instructions.return_();
    Ok(())
}

fn emit_direct_tail_call(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    operation: &RuntimeOperation,
    value_locals: &HashMap<usize, Vec<u32>>,
    runtime_function_indices: &HashMap<usize, u32>,
) -> Result<(), String> {
    let target = operation
        .function
        .ok_or_else(|| format!("{}: call.direct omitted its function", module.source))?;
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
    let caller_signature = module.signatures.get(function.signature).ok_or_else(|| {
        format!(
            "{}: runtime function {} references unknown signature {}",
            module.source, function.id, function.signature
        )
    })?;
    let target_signature = module
        .signatures
        .get(target_function.signature)
        .ok_or_else(|| {
            format!(
                "{}: tail-call target {target} references unknown signature {}",
                module.source, target_function.signature
            )
        })?;
    let caller_results = flattened_runtime_type(module, caller_signature.result)?;
    let operation_results = flattened_runtime_type(module, operation.type_id)?;
    let target_results = flattened_runtime_type(module, target_signature.result)?;
    if caller_results != operation_results || caller_results != target_results {
        return Err(format!(
            "{}: tail call from function {} changes its Wasm result layout",
            module.source, function.id
        ));
    }
    if operation.operands.len() != target_signature.parameters.len() {
        return Err(format!(
            "{}: tail call to function {target} supplies {} arguments for {} parameters",
            module.source,
            operation.operands.len(),
            target_signature.parameters.len()
        ));
    }
    for (operand, parameter_type) in operation.operands.iter().zip(&target_signature.parameters) {
        let operand_type = runtime_value_type(function, *operand)?;
        if flattened_runtime_type(module, operand_type)?
            != flattened_runtime_type(module, *parameter_type)?
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

fn emit_internal_terminator(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    terminator: &RuntimeTerminator,
    value_locals: &HashMap<usize, Vec<u32>>,
    dispatcher: u32,
) -> Result<(), String> {
    match terminator {
        RuntimeTerminator::Branch {
            target, arguments, ..
        } => {
            assign_block_arguments(
                instructions,
                module,
                function,
                *target,
                arguments,
                value_locals,
            )?;
            instructions
                .i32_const(*target as i32)
                .local_set(dispatcher)
                .br(1);
        }
        RuntimeTerminator::Conditional {
            condition,
            consequent,
            consequent_arguments,
            alternate,
            alternate_arguments,
            ..
        } => {
            let condition = locals_for(module, value_locals, *condition)?;
            instructions.local_get(condition[0]).if_(BlockType::Empty);
            assign_block_arguments(
                instructions,
                module,
                function,
                *consequent,
                consequent_arguments,
                value_locals,
            )?;
            instructions
                .i32_const(*consequent as i32)
                .local_set(dispatcher)
                .else_();
            assign_block_arguments(
                instructions,
                module,
                function,
                *alternate,
                alternate_arguments,
                value_locals,
            )?;
            instructions
                .i32_const(*alternate as i32)
                .local_set(dispatcher)
                .end()
                .br(1);
        }
        RuntimeTerminator::Return { value, .. } => {
            emit_local_values(instructions, locals_for(module, value_locals, *value)?);
            instructions.return_();
        }
        RuntimeTerminator::Trap { .. } => {
            instructions.unreachable();
        }
    }
    Ok(())
}

fn emit_dynamic_terminator(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    terminator: &RuntimeTerminator,
    value_locals: &HashMap<usize, Vec<u32>>,
    dispatcher: u32,
    canonical_result: CanonicalResult<'_>,
) -> Result<(), String> {
    match terminator {
        RuntimeTerminator::Branch {
            target, arguments, ..
        } => {
            assign_block_arguments(
                instructions,
                module,
                function,
                *target,
                arguments,
                value_locals,
            )?;
            instructions
                .i32_const(*target as i32)
                .local_set(dispatcher)
                .br(1);
        }
        RuntimeTerminator::Conditional {
            condition,
            consequent,
            consequent_arguments,
            alternate,
            alternate_arguments,
            ..
        } => {
            let condition = locals_for(module, value_locals, *condition)?;
            instructions.local_get(condition[0]).if_(BlockType::Empty);
            assign_block_arguments(
                instructions,
                module,
                function,
                *consequent,
                consequent_arguments,
                value_locals,
            )?;
            instructions
                .i32_const(*consequent as i32)
                .local_set(dispatcher)
                .else_();
            assign_block_arguments(
                instructions,
                module,
                function,
                *alternate,
                alternate_arguments,
                value_locals,
            )?;
            instructions
                .i32_const(*alternate as i32)
                .local_set(dispatcher)
                .end()
                .br(1);
        }
        RuntimeTerminator::Return { value, .. } => {
            emit_canonical_return(instructions, module, value_locals, *value, canonical_result)?;
            instructions.return_();
        }
        RuntimeTerminator::Trap { .. } => {
            instructions.unreachable();
        }
    }
    Ok(())
}

fn emit_canonical_return(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    value_locals: &HashMap<usize, Vec<u32>>,
    value: usize,
    canonical_result: CanonicalResult<'_>,
) -> Result<(), String> {
    let result = locals_for(module, value_locals, value)?;
    let flattened = flattened_type(canonical_result.type_);
    if flattened.len() <= 1 {
        finish_call(instructions);
        emit_local_values(instructions, result);
        return Ok(());
    }
    let layout = memory_layout(canonical_result.type_);
    instructions
        .i32_const(0)
        .i32_const(0)
        .i32_const(layout.alignment as i32)
        .i32_const(layout.size as i32)
        .call(canonical_result.realloc)
        .local_tee(canonical_result.pointer)
        .global_set(RESULT_POINTER_GLOBAL);
    emit_store_public_result(
        instructions,
        module,
        canonical_result.runtime_type,
        canonical_result.type_,
        result,
        canonical_result.pointer,
        0,
    )?;
    instructions.local_get(canonical_result.pointer);
    Ok(())
}

fn assign_block_arguments(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    function: &RuntimeFunction,
    target: usize,
    arguments: &[usize],
    value_locals: &HashMap<usize, Vec<u32>>,
) -> Result<(), String> {
    let block = function
        .blocks
        .get(target)
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
        let destination = locals_for(module, value_locals, parameter.value)?;
        let source = locals_for(module, value_locals, *argument)?;
        if destination.len() != source.len() {
            let argument_type = runtime_value_type(function, *argument)?;
            let argument_kind = module
                .types
                .get(argument_type)
                .map(runtime_kind)
                .unwrap_or("unknown");
            let parameter_kind = module
                .types
                .get(parameter.type_id)
                .map(runtime_kind)
                .unwrap_or("unknown");
            return Err(format!(
                "{}: function {} branches to block {target} with value {} ({argument_kind}, {} locals) for parameter {} ({parameter_kind}, {} locals)",
                module.source,
                function.name,
                argument,
                source.len(),
                parameter.value,
                destination.len(),
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
    value_locals: &'a HashMap<usize, Vec<u32>>,
    value: usize,
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
    operation: &RuntimeOperation,
    value_locals: &HashMap<usize, Vec<u32>>,
    result: u32,
) -> Result<(), String> {
    let vector_type_id = match module.types.get(operation.type_id) {
        Some(RuntimeType::Vector { .. } | RuntimeType::Mask { .. }) => operation.type_id,
        _ => runtime_value_type(function, operation.operands[0])?,
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
        match operation.operator {
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
    if element != "integer-32" || lanes != 4 {
        return Err(format!(
            "{}: dynamic {element}x{lanes} operation is not emitted yet",
            module.source
        ));
    }
    match operation.operator {
        Some("make") => {
            instructions.local_get(operands[0]).i32x4_splat();
            for (lane, operand) in operands.iter().enumerate().skip(1) {
                instructions
                    .local_get(*operand)
                    .i32x4_replace_lane(lane as u8);
            }
        }
        Some("splat") => {
            instructions.local_get(operands[0]).i32x4_splat();
        }
        Some("extract") => {
            let lane = operation
                .lane
                .ok_or_else(|| format!("{}: vector extract omitted its lane", module.source))?;
            instructions.local_get(operands[0]).i32x4_extract_lane(lane);
        }
        Some("replace") => {
            let lane = operation
                .lane
                .ok_or_else(|| format!("{}: vector replace omitted its lane", module.source))?;
            instructions
                .local_get(operands[0])
                .local_get(operands[1])
                .i32x4_replace_lane(lane);
        }
        Some("add") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_add();
        }
        Some("subtract") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_sub();
        }
        Some("multiply") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_mul();
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
            instructions.i32x4_shl();
        }
        Some("shift-right-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_shr_s();
        }
        Some("shift-right-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_shr_u();
        }
        Some("equal") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_eq();
        }
        Some("not-equal") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_ne();
        }
        Some("less-than-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_lt_s();
        }
        Some("less-than-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_lt_u();
        }
        Some("greater-than-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_gt_s();
        }
        Some("greater-than-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_gt_u();
        }
        Some("less-than-or-equal-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_le_s();
        }
        Some("less-than-or-equal-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_le_u();
        }
        Some("greater-than-or-equal-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_ge_s();
        }
        Some("greater-than-or-equal-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_ge_u();
        }
        Some("minimum-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_min_s();
        }
        Some("minimum-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_min_u();
        }
        Some("maximum-signed") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_max_s();
        }
        Some("maximum-unsigned") => {
            emit_local_pair(instructions, &operands);
            instructions.i32x4_max_u();
        }
        Some("select") => {
            instructions
                .local_get(operands[1])
                .local_get(operands[2])
                .local_get(operands[0])
                .v128_bitselect();
        }
        Some("mask-bitmask") => {
            instructions.local_get(operands[0]).i32x4_bitmask();
        }
        Some("mask-all") => {
            instructions.local_get(operands[0]).i32x4_all_true();
        }
        Some("mask-any") => {
            instructions.local_get(operands[0]).v128_any_true();
        }
        operator => {
            return Err(format!(
                "{}: dynamic i32x4 operator {operator:?} is not emitted yet",
                module.source
            ));
        }
    }
    instructions.local_set(result);
    Ok(())
}

fn emit_local_pair(instructions: &mut InstructionSink<'_>, operands: &[u32]) {
    instructions.local_get(operands[0]).local_get(operands[1]);
}

fn flattened_runtime_type(module: &RuntimeModule, type_id: usize) -> Result<Vec<ValType>, String> {
    let type_ = module
        .types
        .get(type_id)
        .ok_or_else(|| format!("{}: runtime type {type_id} does not exist", module.source))?;
    match type_ {
        RuntimeType::Unit => Ok(Vec::new()),
        RuntimeType::Integer32 | RuntimeType::Boolean => Ok(vec![ValType::I32]),
        RuntimeType::SignedInteger64 => Ok(vec![ValType::I64]),
        RuntimeType::Float32 => Ok(vec![ValType::F32]),
        RuntimeType::Float64 => Ok(vec![ValType::F64]),
        RuntimeType::Text | RuntimeType::Store { .. } => Ok(vec![ValType::I32, ValType::I32]),
        RuntimeType::Scratch { .. } => Ok(vec![ValType::I32, ValType::I32, ValType::I32]),
        RuntimeType::Indirect { .. } => Ok(vec![ValType::I32]),
        RuntimeType::Vector { .. } | RuntimeType::Mask { .. } => Ok(vec![ValType::V128]),
        RuntimeType::Product { fields, .. } => {
            let mut result = Vec::new();
            for field in fields {
                result.extend(flattened_runtime_type(module, field.type_id)?);
            }
            Ok(result)
        }
        RuntimeType::Sum { cases, .. } => {
            // One case's payload occupies the sum's payload locals from the
            // first one on: `sum.make` zero-fills whatever it does not write and
            // `sum.payload` reads back only its own case's width. A narrower
            // case therefore costs nothing as long as it is a prefix of the
            // widest, which is what lets a defunctionalized function choice give
            // each alternative its own capture product.
            let mut payload: Vec<ValType> = Vec::new();
            for case_ in cases {
                let flattened = flattened_runtime_type(module, case_.payload_type)?;
                if flattened.is_empty() {
                    continue;
                }
                let (wide, narrow) = match flattened.len() > payload.len() {
                    true => (&flattened, &payload),
                    false => (&payload, &flattened),
                };
                if wide[..narrow.len()] != narrow[..] {
                    return Err(format!(
                        "{}: dynamic sum payloads require different Wasm layouts",
                        module.source
                    ));
                }
                if flattened.len() > payload.len() {
                    payload = flattened;
                }
            }
            let mut result = vec![ValType::I32];
            result.extend(payload);
            Ok(result)
        }
        RuntimeType::Sealed {
            representation_type,
            ..
        } => flattened_runtime_type(module, *representation_type),
    }
}

fn runtime_kind(type_: &RuntimeType) -> &'static str {
    match type_ {
        RuntimeType::Unit => "unit",
        RuntimeType::Integer32 => "integer-32",
        RuntimeType::SignedInteger64 => "signed-integer-64",
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

fn runtime_value_type(function: &RuntimeFunction, value: usize) -> Result<usize, String> {
    for block in &function.blocks {
        if let Some(parameter) = block
            .parameters
            .iter()
            .find(|parameter| parameter.value == value)
        {
            return Ok(parameter.type_id);
        }
        if let Some(operation) = block
            .operations
            .iter()
            .find(|operation| operation.result == value)
        {
            return Ok(operation.type_id);
        }
    }
    Err(format!(
        "runtime function {} omitted the type of value {value}",
        function.name
    ))
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
                .end();
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
    match type_ {
        AbiType::Unit => Ok(0),
        AbiType::InternalPointer => {
            instructions
                .local_get(pointer)
                .i32_load(wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: 2,
                    memory_index: 0,
                })
                .local_set(destination[0]);
            Ok(1)
        }
        AbiType::SignedInteger64 => {
            instructions
                .local_get(pointer)
                .i64_load(wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: 3,
                    memory_index: 0,
                });
            instructions.local_set(destination[0]);
            Ok(1)
        }
        AbiType::Float32 => {
            instructions
                .local_get(pointer)
                .f32_load(wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: 2,
                    memory_index: 0,
                });
            instructions.local_set(destination[0]);
            Ok(1)
        }
        AbiType::Float64 => {
            instructions
                .local_get(pointer)
                .f64_load(wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: 3,
                    memory_index: 0,
                });
            instructions.local_set(destination[0]);
            Ok(1)
        }
        AbiType::Boolean => {
            instructions
                .local_get(pointer)
                .i32_load8_u(wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: 0,
                    memory_index: 0,
                });
            instructions.local_set(destination[0]);
            Ok(1)
        }
        AbiType::Text | AbiType::Array { .. } => {
            instructions
                .local_get(pointer)
                .i32_load(wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: 2,
                    memory_index: 0,
                });
            instructions.local_set(destination[0]);
            instructions
                .local_get(pointer)
                .i32_load(wasm_encoder::MemArg {
                    offset: u64::from(offset + 4),
                    align: 2,
                    memory_index: 0,
                });
            instructions.local_set(destination[1]);
            Ok(2)
        }
        AbiType::Record { fields } => {
            let mut written = 0;
            for field in record_layout(fields) {
                written += emit_load_canonical_result(
                    instructions,
                    &field.type_,
                    &destination[written..],
                    pointer,
                    offset + field.offset,
                )?;
            }
            Ok(written)
        }
        AbiType::Variant { cases } => {
            let layout = variant_layout(cases);
            let tag = destination[0];
            instructions.local_get(pointer);
            let memory_argument = wasm_encoder::MemArg {
                offset: u64::from(offset),
                align: layout.discriminant_size.trailing_zeros(),
                memory_index: 0,
            };
            match layout.discriminant_size {
                1 => {
                    instructions.i32_load8_u(memory_argument);
                }
                2 => {
                    instructions.i32_load16_u(memory_argument);
                }
                4 => {
                    instructions.i32_load(memory_argument);
                }
                size => return Err(format!("unsupported variant discriminant size {size}")),
            }
            instructions.local_set(tag);
            let flattened = flattened_type(type_);
            for (local, type_) in destination[1..].iter().zip(flattened[1..].iter()) {
                emit_zero_local(instructions, *type_, *local)?;
            }
            let mut payload_width = 0;
            for (case_index, case_) in cases.iter().enumerate() {
                let Some(payload) = &case_.payload else {
                    continue;
                };
                let width = flattened_type(payload).len();
                payload_width = payload_width.max(width);
                instructions
                    .local_get(tag)
                    .i32_const(case_index as i32)
                    .i32_eq()
                    .if_(BlockType::Empty);
                emit_load_canonical_result(
                    instructions,
                    payload,
                    &destination[1..1 + width],
                    pointer,
                    offset + layout.payload_offset,
                )?;
                instructions.end();
            }
            Ok(1 + payload_width)
        }
        AbiType::Sealed { inner, .. } => {
            emit_load_canonical_result(instructions, inner, destination, pointer, offset)
        }
    }
}

fn emit_store_public_result(
    instructions: &mut InstructionSink<'_>,
    module: &RuntimeModule,
    runtime_type_id: usize,
    public_type: &AbiType,
    source: &[u32],
    pointer: u32,
    offset: u32,
) -> Result<(), String> {
    let runtime_type = module.types.get(runtime_type_id).ok_or_else(|| {
        format!(
            "{}: public result references unknown runtime type {runtime_type_id}",
            module.source
        )
    })?;
    match (runtime_type, public_type) {
        (
            RuntimeType::Unit
            | RuntimeType::SignedInteger64
            | RuntimeType::Float32
            | RuntimeType::Float64
            | RuntimeType::Boolean
            | RuntimeType::Text
            | RuntimeType::Store { .. },
            AbiType::Unit
            | AbiType::SignedInteger64
            | AbiType::Float32
            | AbiType::Float64
            | AbiType::Boolean
            | AbiType::Text
            | AbiType::Array { .. },
        ) => {
            let mut flat_index = 0;
            emit_store_canonical_result(
                instructions,
                public_type,
                source,
                &mut flat_index,
                pointer,
                offset,
            )?;
            if flat_index != source.len() {
                return Err(format!(
                    "{}: public {} consumed {flat_index} of {} runtime values",
                    module.source,
                    abi_kind(public_type),
                    source.len()
                ));
            }
        }
        (
            RuntimeType::Sealed {
                representation_type,
                ..
            },
            AbiType::Sealed { inner, .. },
        ) => emit_store_public_result(
            instructions,
            module,
            *representation_type,
            inner,
            source,
            pointer,
            offset,
        )?,
        (
            RuntimeType::Product { fields, .. },
            AbiType::Record {
                fields: public_fields,
            },
        ) => {
            let mut runtime_offsets = BTreeMap::new();
            let mut runtime_offset = 0;
            for field in fields {
                let width = flattened_runtime_type(module, field.type_id)?.len();
                runtime_offsets.insert(field.name.as_str(), (field.type_id, runtime_offset, width));
                runtime_offset += width;
            }
            if runtime_offset != source.len() {
                return Err(format!(
                    "{}: runtime record has {runtime_offset} flattened values, received {}",
                    module.source,
                    source.len()
                ));
            }
            for field in record_layout(public_fields) {
                let (field_type_id, field_offset, field_width) =
                    runtime_offsets.get(field.name.as_str()).ok_or_else(|| {
                        format!(
                            "{}: runtime record omitted public field {}",
                            module.source, field.name
                        )
                    })?;
                emit_store_public_result(
                    instructions,
                    module,
                    *field_type_id,
                    &field.type_,
                    &source[*field_offset..*field_offset + *field_width],
                    pointer,
                    offset + field.offset,
                )?;
            }
        }
        (
            RuntimeType::Sum { cases, .. },
            AbiType::Variant {
                cases: public_cases,
            },
        ) => {
            let tag = source
                .first()
                .ok_or_else(|| format!("{}: runtime variant omitted its tag", module.source))?;
            let layout = variant_layout(public_cases);
            for (runtime_case_index, runtime_case) in cases.iter().enumerate() {
                let public_case_index = public_cases
                    .iter()
                    .position(|candidate| candidate.name == runtime_case.name)
                    .ok_or_else(|| {
                        format!(
                            "{}: public variant omitted runtime case {}",
                            module.source, runtime_case.name
                        )
                    })?;
                instructions
                    .local_get(*tag)
                    .i32_const(runtime_case_index as i32)
                    .i32_eq()
                    .if_(BlockType::Empty)
                    .local_get(pointer)
                    .i32_const(public_case_index as i32);
                let memory_argument = wasm_encoder::MemArg {
                    offset: u64::from(offset),
                    align: layout.discriminant_size.trailing_zeros(),
                    memory_index: 0,
                };
                match layout.discriminant_size {
                    1 => {
                        instructions.i32_store8(memory_argument);
                    }
                    2 => {
                        instructions.i32_store16(memory_argument);
                    }
                    4 => {
                        instructions.i32_store(memory_argument);
                    }
                    size => return Err(format!("unsupported variant discriminant size {size}")),
                }
                if let Some(payload) = &public_cases[public_case_index].payload {
                    let payload_width =
                        flattened_runtime_type(module, runtime_case.payload_type)?.len();
                    emit_store_public_result(
                        instructions,
                        module,
                        runtime_case.payload_type,
                        payload,
                        &source[1..1 + payload_width],
                        pointer,
                        offset + layout.payload_offset,
                    )?;
                }
                instructions.end();
            }
        }
        _ => {
            return Err(format!(
                "{}: runtime {} cannot use public {} layout",
                module.source,
                runtime_kind(runtime_type),
                abi_kind(public_type)
            ));
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
    let memory_argument = |offset, align| wasm_encoder::MemArg {
        offset: u64::from(offset),
        align,
        memory_index: 0,
    };
    match type_ {
        AbiType::Unit => {}
        AbiType::InternalPointer => {
            instructions
                .local_get(pointer)
                .local_get(source[*flat_index])
                .i32_store(memory_argument(offset, 2));
            *flat_index += 1;
        }
        AbiType::SignedInteger64 => {
            instructions
                .local_get(pointer)
                .local_get(source[*flat_index])
                .i64_store(memory_argument(offset, 3));
            *flat_index += 1;
        }
        AbiType::Float32 => {
            instructions
                .local_get(pointer)
                .local_get(source[*flat_index])
                .f32_store(memory_argument(offset, 2));
            *flat_index += 1;
        }
        AbiType::Float64 => {
            instructions
                .local_get(pointer)
                .local_get(source[*flat_index])
                .f64_store(memory_argument(offset, 3));
            *flat_index += 1;
        }
        AbiType::Boolean => {
            instructions
                .local_get(pointer)
                .local_get(source[*flat_index])
                .i32_store8(memory_argument(offset, 0));
            *flat_index += 1;
        }
        AbiType::Text | AbiType::Array { .. } => {
            instructions
                .local_get(pointer)
                .local_get(source[*flat_index])
                .i32_store(memory_argument(offset, 2))
                .local_get(pointer)
                .local_get(source[*flat_index + 1])
                .i32_store(memory_argument(offset + 4, 2));
            *flat_index += 2;
        }
        AbiType::Record { fields } => {
            for field in record_layout(fields) {
                emit_store_canonical_result(
                    instructions,
                    &field.type_,
                    source,
                    flat_index,
                    pointer,
                    offset + field.offset,
                )?;
            }
        }
        AbiType::Variant { cases } => {
            let layout = variant_layout(cases);
            let tag = source[*flat_index];
            instructions.local_get(pointer).local_get(tag);
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
            *flat_index += 1;
            let payload_start = *flat_index;
            let mut payload_width = 0;
            for (case_index, case_) in cases.iter().enumerate() {
                let Some(payload) = &case_.payload else {
                    continue;
                };
                let case_width = flattened_type(payload).len();
                payload_width = payload_width.max(case_width);
                instructions
                    .local_get(tag)
                    .i32_const(case_index as i32)
                    .i32_eq()
                    .if_(BlockType::Empty);
                let mut case_flat_index = payload_start;
                emit_store_canonical_result(
                    instructions,
                    payload,
                    source,
                    &mut case_flat_index,
                    pointer,
                    offset + layout.payload_offset,
                )?;
                instructions.end();
            }
            *flat_index = payload_start + payload_width;
        }
        AbiType::Sealed { inner, .. } => {
            emit_store_canonical_result(instructions, inner, source, flat_index, pointer, offset)?;
        }
    }
    Ok(())
}

fn emit_validate_canonical_texts(
    instructions: &mut InstructionSink<'_>,
    type_: &AbiType,
    locals: &[u32],
    flat_index: &mut usize,
    scratch_end: u32,
    utf8_validator: u32,
) -> Result<(), String> {
    match type_ {
        AbiType::Unit => {}
        AbiType::SignedInteger64 | AbiType::Float32 | AbiType::Float64 | AbiType::Boolean => {
            *flat_index += 1;
        }
        AbiType::Text => {
            let pointer = locals[*flat_index];
            let length = locals[*flat_index + 1];
            emit_text_bounds_check(instructions, pointer, length, scratch_end);
            instructions
                .local_get(pointer)
                .local_get(length)
                .call(utf8_validator);
            *flat_index += 2;
        }
        AbiType::Record { fields } => {
            for field in record_layout(fields) {
                emit_validate_canonical_texts(
                    instructions,
                    &field.type_,
                    locals,
                    flat_index,
                    scratch_end,
                    utf8_validator,
                )?;
            }
        }
        AbiType::Sealed { inner, .. } => {
            emit_validate_canonical_texts(
                instructions,
                inner,
                locals,
                flat_index,
                scratch_end,
                utf8_validator,
            )?;
        }
        _ => {
            return Err(format!(
                "indirect dynamic {} host results are not validated yet",
                abi_kind(type_)
            ));
        }
    }
    Ok(())
}

fn emit_text_bounds_check(
    instructions: &mut InstructionSink<'_>,
    pointer: u32,
    length: u32,
    scratch_end: u32,
) {
    instructions
        .local_get(length)
        .i32_eqz()
        .if_(BlockType::Empty)
        .else_()
        .local_get(pointer)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(pointer)
        .local_get(length)
        .i32_add()
        .local_tee(scratch_end)
        .local_get(pointer)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(scratch_end)
        .memory_size(0)
        .i32_const(16)
        .i32_shl()
        .i32_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .end();
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

fn text_find_from_function() -> Function {
    let mut function = Function::new([(5, ValType::I32)]);
    let start = 5;
    let index = 6;
    let text_byte = 7;
    let query_byte = 8;
    let mut instructions = function.instructions();
    instructions
        .local_get(4)
        .local_set(start)
        .local_get(3)
        .i32_eqz()
        .if_(BlockType::Empty)
        .local_get(start)
        .return_()
        .end()
        .local_get(3)
        .local_get(1)
        .local_get(start)
        .i32_sub()
        .i32_gt_u()
        .if_(BlockType::Empty)
        .i32_const(-1)
        .return_()
        .end()
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(start)
        .local_get(1)
        .local_get(3)
        .i32_sub()
        .i32_gt_u()
        .br_if(1)
        .i32_const(0)
        .local_set(index)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(index)
        .local_get(3)
        .i32_ge_u()
        .if_(BlockType::Empty)
        .local_get(start)
        .return_()
        .end()
        .local_get(0)
        .local_get(start)
        .i32_add()
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(text_byte)
        .local_get(2)
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(query_byte)
        .local_get(text_byte)
        .local_get(query_byte)
        .i32_ne()
        .br_if(1)
        .local_get(index)
        .i32_const(1)
        .i32_add()
        .local_set(index)
        .br(0)
        .end()
        .end()
        .local_get(start)
        .i32_const(1)
        .i32_add()
        .local_set(start)
        .br(0)
        .end()
        .end()
        .i32_const(-1)
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

fn text_contains_function() -> Function {
    let mut function = Function::new([(4, ValType::I32)]);
    let start = 4;
    let index = 5;
    let text_byte = 6;
    let query_byte = 7;
    let mut instructions = function.instructions();
    instructions
        .local_get(3)
        .i32_eqz()
        .if_(BlockType::Empty)
        .i32_const(1)
        .return_()
        .end()
        .local_get(3)
        .local_get(1)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .i32_const(0)
        .return_()
        .end()
        .i32_const(0)
        .local_set(start)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(start)
        .local_get(1)
        .local_get(3)
        .i32_sub()
        .i32_gt_u()
        .br_if(1)
        .i32_const(0)
        .local_set(index)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(index)
        .local_get(3)
        .i32_ge_u()
        .if_(BlockType::Empty)
        .i32_const(1)
        .return_()
        .end()
        .local_get(0)
        .local_get(start)
        .i32_add()
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(text_byte)
        .local_get(2)
        .local_get(index)
        .i32_add()
        .i32_load8_u(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_set(query_byte)
        .local_get(text_byte)
        .local_get(query_byte)
        .i32_ne()
        .br_if(1)
        .local_get(index)
        .i32_const(1)
        .i32_add()
        .local_set(index)
        .br(0)
        .end()
        .end()
        .local_get(start)
        .i32_const(1)
        .i32_add()
        .local_set(start)
        .br(0)
        .end()
        .end()
        .i32_const(0)
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

fn add_function_type(
    types: &mut TypeSection,
    parameters: Vec<ValType>,
    results: Vec<ValType>,
) -> u32 {
    let index = types.len();
    types.ty().function(parameters, results);
    index
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

fn realloc_function() -> Function {
    let mut function = Function::new([(4, ValType::I32)]);
    let mut instructions = function.instructions();
    let new_pointer = 4;
    let end_pointer = 5;
    let required_pages = 6;
    let copy_length = 7;
    instructions
        .local_get(2)
        .i32_const(1)
        .i32_ge_s()
        .local_get(2)
        .i32_const(8)
        .i32_le_s()
        .i32_and()
        .local_get(2)
        .local_get(2)
        .i32_const(1)
        .i32_sub()
        .i32_and()
        .i32_eqz()
        .i32_and()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(3)
        .i32_eqz()
        .if_(BlockType::Result(ValType::I32))
        .i32_const(0)
        .else_()
        .local_get(0)
        .i32_eqz()
        .i32_eqz()
        .local_get(1)
        .local_get(3)
        .i32_le_u()
        .i32_and()
        .local_get(0)
        .local_get(1)
        .i32_add()
        .global_get(HEAP_GLOBAL)
        .i32_eq()
        .i32_and()
        .local_get(0)
        .local_get(2)
        .i32_const(1)
        .i32_sub()
        .i32_and()
        .i32_eqz()
        .i32_and()
        .if_(BlockType::Result(ValType::I32))
        .local_get(0)
        .else_()
        .global_get(HEAP_GLOBAL)
        .local_get(2)
        .i32_const(1)
        .i32_sub()
        .i32_add()
        .local_get(2)
        .i32_const(-1)
        .i32_mul()
        .i32_and()
        .end()
        .local_tee(new_pointer)
        .local_get(3)
        .i32_add()
        .local_tee(end_pointer)
        .local_get(new_pointer)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(end_pointer)
        .memory_size(0)
        .i32_const(16)
        .i32_shl()
        .i32_gt_u()
        .if_(BlockType::Empty)
        .local_get(end_pointer)
        .i32_const(1)
        .i32_sub()
        .i32_const(16)
        .i32_shr_u()
        .i32_const(1)
        .i32_add()
        .local_tee(required_pages)
        .memory_size(0)
        .i32_sub()
        .memory_grow(0)
        .i32_const(-1)
        .i32_eq()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .end()
        .local_get(0)
        .if_(BlockType::Empty)
        .local_get(new_pointer)
        .local_get(0)
        .i32_ne()
        .if_(BlockType::Empty)
        .local_get(1)
        .local_get(3)
        .i32_lt_u()
        .if_(BlockType::Result(ValType::I32))
        .local_get(1)
        .else_()
        .local_get(3)
        .end()
        .local_set(copy_length)
        .local_get(new_pointer)
        .local_get(0)
        .local_get(copy_length)
        .memory_copy(0, 0)
        .end()
        .end()
        .local_get(end_pointer)
        .global_set(HEAP_GLOBAL)
        .local_get(new_pointer)
        .end()
        .end();
    function
}

fn post_return_function(call_id: u32) -> Function {
    let mut function = Function::new(Vec::new());
    function
        .instructions()
        .global_get(ACTIVE_EXPORT_GLOBAL)
        .i32_const(call_id as i32)
        .i32_eq()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(RESULT_POINTER_GLOBAL)
        .local_get(0)
        .i32_eq()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    finish_call(&mut function.instructions());
    function.instructions().end();
    function
}

fn begin_call(instructions: &mut InstructionSink<'_>, call_id: u32) {
    instructions
        .global_get(ACTIVE_EXPORT_GLOBAL)
        .i32_eqz()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(HEAP_GLOBAL)
        .global_set(HEAP_CHECKPOINT_GLOBAL)
        .i32_const(call_id as i32)
        .global_set(ACTIVE_EXPORT_GLOBAL);
}

fn finish_call(instructions: &mut InstructionSink<'_>) {
    instructions
        .global_get(HEAP_CHECKPOINT_GLOBAL)
        .global_set(HEAP_GLOBAL)
        .i32_const(0)
        .global_set(RESULT_POINTER_GLOBAL)
        .i32_const(0)
        .global_set(ACTIVE_EXPORT_GLOBAL);
}

fn abi_kind(type_: &AbiType) -> &'static str {
    match type_ {
        AbiType::Unit => "unit",
        AbiType::InternalPointer => "internal-pointer",
        AbiType::SignedInteger64 => "signed-integer-64",
        AbiType::Float32 => "float-32",
        AbiType::Float64 => "float-64",
        AbiType::Boolean => "boolean",
        AbiType::Text => "text",
        AbiType::Array { .. } => "array",
        AbiType::Record { .. } => "record",
        AbiType::Variant { .. } => "variant",
        AbiType::Sealed { .. } => "sealed",
    }
}

#[derive(Clone, Copy)]
struct MemoryLayout {
    alignment: u32,
    size: u32,
}

#[derive(Clone)]
struct LaidOutField {
    name: String,
    type_: AbiType,
    offset: u32,
}

struct VariantLayout {
    discriminant_size: u32,
    payload_offset: u32,
    alignment: u32,
    size: u32,
}

fn memory_layout(type_: &AbiType) -> MemoryLayout {
    match type_ {
        AbiType::Unit => MemoryLayout {
            alignment: 1,
            size: 0,
        },
        AbiType::InternalPointer => MemoryLayout {
            alignment: 4,
            size: 4,
        },
        AbiType::Boolean => MemoryLayout {
            alignment: 1,
            size: 1,
        },
        AbiType::Float32 => MemoryLayout {
            alignment: 4,
            size: 4,
        },
        AbiType::SignedInteger64 | AbiType::Float64 => MemoryLayout {
            alignment: 8,
            size: 8,
        },
        AbiType::Text | AbiType::Array { .. } => MemoryLayout {
            alignment: 4,
            size: 8,
        },
        AbiType::Sealed { inner, .. } => memory_layout(inner),
        AbiType::Record { fields } => {
            let fields = record_layout(fields);
            let alignment = fields
                .iter()
                .map(|field| memory_layout(&field.type_).alignment)
                .max()
                .unwrap_or(1);
            let end = fields
                .iter()
                .map(|field| field.offset + memory_layout(&field.type_).size)
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

fn record_layout(fields: &[AbiField]) -> Vec<LaidOutField> {
    let mut fields = fields.to_vec();
    fields.sort_by(|left, right| left.name.cmp(&right.name));
    let mut offset = 0;
    fields
        .into_iter()
        .map(|field| {
            let layout = memory_layout(&field.type_);
            offset = align_to(offset, layout.alignment);
            let result = LaidOutField {
                name: field.name,
                type_: field.type_,
                offset,
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
    use crate::hir::{RuntimeBlock, RuntimeBlockParameter, RuntimeSpan};

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
    fn entry_cycle_with_acyclic_body_is_a_structured_loop() {
        let function = runtime_function(vec![
            conditional_block(0, 1, 2),
            return_block(1),
            branch_block(2, 0),
        ]);

        assert!(structured_loop_eligible(&function));
    }

    #[test]
    fn non_entry_cycle_keeps_the_dispatcher() {
        let function = runtime_function(vec![
            branch_block(0, 1),
            branch_block(1, 2),
            branch_block(2, 1),
        ]);

        assert!(!structured_loop_eligible(&function));
    }

    #[test]
    fn reconverging_loop_body_keeps_the_dispatcher() {
        let function = runtime_function(vec![
            conditional_block(0, 1, 2),
            branch_block(1, 3),
            branch_block(2, 3),
            branch_block(3, 0),
        ]);

        assert!(!structured_loop_eligible(&function));
    }

    #[test]
    fn recursive_representation_is_private_to_runtime_hir() {
        let module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
            source: "recursive-boundary-test".to_owned(),
            types: vec![RuntimeType::Unit, RuntimeType::Indirect { target_type: 0 }],
            signatures: Vec::new(),
            functions: Vec::new(),
            capabilities: Vec::new(),
            exports: Vec::new(),
        };

        let Err(error) = canonical_type(&module, 1, &mut Vec::new()) else {
            panic!("a recursive value acquired an ABI 1 layout");
        };

        assert!(error.contains("cannot cross Blot Core Wasm ABI 1"));
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
            functions: Vec::new(),
            capabilities: Vec::new(),
            exports: Vec::new(),
        };

        assert!(canonical_type(&module, 2, &mut Vec::new()).is_err());
        let internal = runtime_layout_type(&module, 2, &mut Vec::new(), true)
            .expect("Scratch needs a private layout inside indirect carriers");
        assert_eq!(flattened_type(&internal), vec![ValType::I32; 3]);
        assert_eq!(memory_layout(&internal).size, 12);
    }

    #[test]
    fn direct_call_return_is_a_tail_call_candidate() {
        let block = RuntimeBlock {
            id: 0,
            parameters: Vec::new(),
            operations: vec![direct_call_operation(7)],
            terminator: RuntimeTerminator::Return {
                value: 7,
                span: span(),
            },
        };
        let function = runtime_function(vec![block]);
        assert_eq!(
            direct_tail_call(&function, &function.blocks[0]).map(|candidate| candidate.result),
            Some(7)
        );

        let mut not_tail = function.clone();
        not_tail.blocks[0].terminator = RuntimeTerminator::Return {
            value: 8,
            span: span(),
        };
        assert!(direct_tail_call(&not_tail, &not_tail.blocks[0]).is_none());
    }

    #[test]
    fn direct_call_forwarded_through_empty_join_is_a_tail_call_candidate() {
        let function = runtime_function(vec![
            RuntimeBlock {
                id: 0,
                parameters: Vec::new(),
                operations: vec![direct_call_operation(7)],
                terminator: RuntimeTerminator::Branch {
                    target: 1,
                    arguments: vec![7],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 1,
                parameters: vec![parameter(8)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Return {
                    value: 8,
                    span: span(),
                },
            },
        ]);

        assert_eq!(
            direct_tail_call(&function, &function.blocks[0]).map(|candidate| candidate.result),
            Some(7)
        );
    }

    fn direct_call_operation(result: usize) -> RuntimeOperation {
        RuntimeOperation {
            kind: "call.direct",
            result,
            type_id: 1,
            operands: vec![0],
            ownership: "plain",
            span: span(),
            value: None,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: Some(2),
            signature: None,
        }
    }

    fn runtime_function(blocks: Vec<RuntimeBlock>) -> RuntimeFunction {
        RuntimeFunction {
            id: 0,
            name: "structured-loop-test".to_owned(),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks,
            span: span(),
        }
    }

    fn conditional_block(id: usize, consequent: usize, alternate: usize) -> RuntimeBlock {
        RuntimeBlock {
            id,
            parameters: vec![parameter(id)],
            operations: Vec::new(),
            terminator: RuntimeTerminator::Conditional {
                condition: id,
                consequent,
                consequent_arguments: Vec::new(),
                alternate,
                alternate_arguments: Vec::new(),
                span: span(),
            },
        }
    }

    fn branch_block(id: usize, target: usize) -> RuntimeBlock {
        RuntimeBlock {
            id,
            parameters: Vec::new(),
            operations: Vec::new(),
            terminator: RuntimeTerminator::Branch {
                target,
                arguments: Vec::new(),
                span: span(),
            },
        }
    }

    fn return_block(id: usize) -> RuntimeBlock {
        RuntimeBlock {
            id,
            parameters: Vec::new(),
            operations: Vec::new(),
            terminator: RuntimeTerminator::Return {
                value: 0,
                span: span(),
            },
        }
    }

    fn parameter(value: usize) -> RuntimeBlockParameter {
        RuntimeBlockParameter {
            value,
            type_id: 1,
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
