use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, CustomSection, DataSection, EntityType, ExportKind,
    ExportSection, Function, FunctionSection, GlobalSection, GlobalType, Ieee32, Ieee64,
    ImportSection, InstructionSink, MemorySection, MemoryType, Module, TypeSection, ValType,
};

use crate::hir::{
    RuntimeExport, RuntimeFunction, RuntimeModule, RuntimeOperation, RuntimeTerminator,
    RuntimeType, WireConstant,
};

const HEAP_GLOBAL: u32 = 0;
const ACTIVE_EXPORT_GLOBAL: u32 = 3;
const RESULT_POINTER_GLOBAL: u32 = 4;
const HEAP_CHECKPOINT_GLOBAL: u32 = 5;

#[derive(Clone, Copy)]
struct DynamicHelpers {
    realloc: u32,
    text_compare: u32,
    utf8_validator: u32,
    i64_to_text: u32,
}

#[derive(Clone)]
pub struct CompiledModule {
    pub wasm: Vec<u8>,
    pub manifest: Vec<u8>,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum AbiType {
    Unit,
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

#[derive(Clone)]
enum ConstantValue {
    Unit,
    Integer(i64),
    Float32(f32),
    Float64(f64),
    Boolean(bool),
    Text(String),
    Product(BTreeMap<String, ConstantValue>),
    Sum {
        case: String,
        payload: Box<ConstantValue>,
    },
    Store(Vec<ConstantValue>),
}

struct ConstantHostCall {
    capability: String,
    operation: String,
    argument: ConstantValue,
}

struct Evaluation {
    value: ConstantValue,
    calls: Vec<ConstantHostCall>,
}

struct PlannedTemplate {
    contents: Vec<u8>,
    relocations: Vec<Relocation>,
}

struct Relocation {
    field_offset: u32,
    target_offset: u32,
}

struct PlannedExport {
    wasm_name: String,
    post_return: Option<String>,
    abi_type: AbiType,
    evaluation: Evaluation,
    template: Option<PlannedTemplate>,
    template_offset: u32,
    host_calls: Vec<PlannedHostCall>,
}

struct PlannedHostCall {
    import_index: u32,
    parameter: AbiType,
    argument: ConstantValue,
    text: Option<(u32, Vec<u8>)>,
}

pub fn compile(module: &RuntimeModule) -> Result<CompiledModule, String> {
    let manifest = build_manifest(module)?;
    let mut manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("could not serialize Blot ABI manifest: {error}"))?;
    manifest_text.push('\n');
    let manifest_bytes = manifest_text.into_bytes();
    let dynamic = module.functions.iter().any(|function| {
        if function.blocks.len() != 1 || !function.blocks[0].parameters.is_empty() {
            return true;
        }
        let block = &function.blocks[0];
        if !matches!(block.terminator, RuntimeTerminator::Return { .. }) {
            return true;
        }
        block
            .operations
            .iter()
            .any(|operation| match operation.kind {
                "constant" | "product.make" | "sum.make" | "store.empty" | "store.new"
                | "store.write" | "store.grow" | "seal.wrap" | "seal.unwrap" | "resource.move"
                | "resource.borrow" | "resource.freeze" => false,
                "host.call" => !matches!(module.types[operation.type_id], RuntimeType::Unit),
                _ => true,
            })
    });
    let wasm = if dynamic {
        emit_dynamic_module(module, &manifest, &manifest_bytes)?
    } else {
        emit_constant_module(module, &manifest, &manifest_bytes)?
    };
    let mut capabilities = manifest
        .imports
        .iter()
        .map(|imported| imported.capability.clone())
        .collect::<Vec<_>>();
    capabilities.sort();
    capabilities.dedup();
    Ok(CompiledModule {
        wasm,
        manifest: manifest_bytes,
        capabilities,
    })
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
                        .map(|type_id| canonical_type(module, *type_id, &mut Vec::new()))
                        .collect::<Result<_, _>>()?,
                    result: canonical_type(module, signature.result, &mut Vec::new())?,
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
                        .map(|type_id| canonical_type(module, *type_id, &mut Vec::new()))
                        .collect::<Result<_, _>>()?,
                    result: canonical_type(module, signature.result, &mut Vec::new())?,
                },
            });
        }
    }
    Ok(AbiManifest {
        format: "blot-core-wasm",
        abi: AbiPolicy {
            major: 1,
            minor: 0,
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

fn canonical_type(
    module: &RuntimeModule,
    type_id: usize,
    resolving: &mut Vec<usize>,
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
            element: Box::new(canonical_type(module, *element_type, resolving)?),
        },
        RuntimeType::Product { fields, .. } => {
            let mut fields = fields.clone();
            fields.sort_by(|left, right| left.name.cmp(&right.name));
            AbiType::Record {
                fields: fields
                    .into_iter()
                    .map(|field| {
                        Ok(AbiField {
                            name: field.name,
                            type_: canonical_type(module, field.type_id, resolving)?,
                        })
                    })
                    .collect::<Result<_, String>>()?,
            }
        }
        RuntimeType::Sum { cases, .. } => {
            let mut cases = cases.clone();
            cases.sort_by(|left, right| left.name.cmp(&right.name));
            AbiType::Variant {
                cases: cases
                    .into_iter()
                    .map(|case_| {
                        let payload = canonical_type(module, case_.payload_type, resolving)?;
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
            inner: Box::new(canonical_type(module, *representation_type, resolving)?),
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

fn evaluate_constant_function(
    module: &RuntimeModule,
    function: &RuntimeFunction,
) -> Result<Evaluation, String> {
    if function.blocks.len() != 1 || !function.blocks[0].parameters.is_empty() {
        return Err(format!(
            "{}: {} is not a closed constant function",
            module.source, function.name
        ));
    }
    let block = &function.blocks[0];
    let mut values = HashMap::new();
    let mut calls = Vec::new();
    for operation in &block.operations {
        let operands = operation
            .operands
            .iter()
            .map(|operand| {
                values.get(operand).cloned().ok_or_else(|| {
                    format!(
                        "{}: constant operation reads value {operand}",
                        module.source
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let result = evaluate_operation(module, operation, &operands, &mut calls)?;
        values.insert(operation.result, result);
    }
    let crate::hir::RuntimeTerminator::Return { value, .. } = &block.terminator else {
        return Err(format!(
            "{}: {} does not directly return",
            module.source, function.name
        ));
    };
    let value = values.get(value).cloned().ok_or_else(|| {
        format!(
            "{}: {} omitted its constant result",
            module.source, function.name
        )
    })?;
    Ok(Evaluation { value, calls })
}

fn evaluate_operation(
    module: &RuntimeModule,
    operation: &RuntimeOperation,
    operands: &[ConstantValue],
    calls: &mut Vec<ConstantHostCall>,
) -> Result<ConstantValue, String> {
    match operation.kind {
        "constant" => {
            wire_constant(operation.value.as_ref().ok_or_else(|| {
                format!("{}: constant operation omitted its value", module.source)
            })?)
        }
        "product.make" => {
            let RuntimeType::Product { fields, .. } = &module.types[operation.type_id] else {
                return Err(format!(
                    "{}: product.make has type {}",
                    module.source, operation.type_id
                ));
            };
            Ok(ConstantValue::Product(
                fields
                    .iter()
                    .zip(operands)
                    .map(|(field, value)| (field.name.clone(), value.clone()))
                    .collect(),
            ))
        }
        "sum.make" => {
            let case = operation
                .case
                .ok_or_else(|| format!("{}: sum.make omitted its case", module.source))?;
            let RuntimeType::Sum { cases, .. } = &module.types[operation.type_id] else {
                return Err(format!(
                    "{}: sum.make has type {}",
                    module.source, operation.type_id
                ));
            };
            let case = cases
                .get(case)
                .ok_or_else(|| format!("{}: sum.make has unknown case {case}", module.source))?;
            Ok(ConstantValue::Sum {
                case: case.name.clone(),
                payload: Box::new(
                    operands.first().cloned().ok_or_else(|| {
                        format!("{}: sum.make omitted its payload", module.source)
                    })?,
                ),
            })
        }
        "store.empty" => Ok(ConstantValue::Store(Vec::new())),
        "store.new" => {
            let length = integer_operand(module, operands.first(), "Store length")?;
            if !(0..=16_777_216).contains(&length) {
                return Err(format!(
                    "{}: invalid constant Store length {length}",
                    module.source
                ));
            }
            let initial = operands
                .get(1)
                .cloned()
                .ok_or_else(|| format!("{}: Store.new omitted its initial value", module.source))?;
            Ok(ConstantValue::Store(vec![initial; length as usize]))
        }
        "store.write" => {
            let ConstantValue::Store(elements) = &operands[0] else {
                return Err(format!("{}: invalid constant Store write", module.source));
            };
            let index = integer_operand(module, operands.get(1), "Store index")?;
            if index < 0 || index as usize >= elements.len() {
                return Err(format!(
                    "{}: constant Store index {index} is out of bounds",
                    module.source
                ));
            }
            let mut elements = elements.clone();
            elements[index as usize] = operands[2].clone();
            Ok(ConstantValue::Store(elements))
        }
        "store.grow" => {
            let ConstantValue::Store(elements) = &operands[0] else {
                return Err(format!("{}: invalid constant Store grow", module.source));
            };
            let length = integer_operand(module, operands.get(1), "Store length")?;
            if length < 0 {
                return Err(format!("{}: invalid constant Store grow", module.source));
            }
            let mut elements = elements[..elements.len().min(length as usize)].to_vec();
            elements.resize(length as usize, operands[2].clone());
            Ok(ConstantValue::Store(elements))
        }
        "seal.wrap" | "seal.unwrap" | "resource.move" | "resource.borrow" | "resource.freeze" => {
            operands
                .first()
                .cloned()
                .ok_or_else(|| format!("{}: {} omitted its operand", module.source, operation.kind))
        }
        "host.call" => {
            calls.push(ConstantHostCall {
                capability: operation.capability.clone().ok_or_else(|| {
                    format!("{}: host.call omitted its capability", module.source)
                })?,
                operation: operation
                    .operation
                    .clone()
                    .ok_or_else(|| format!("{}: host.call omitted its operation", module.source))?,
                argument: operands
                    .first()
                    .cloned()
                    .ok_or_else(|| format!("{}: host.call omitted its argument", module.source))?,
            });
            Ok(ConstantValue::Unit)
        }
        kind => Err(format!(
            "{}: constant function contains non-constant {kind}",
            module.source
        )),
    }
}

fn wire_constant(value: &WireConstant) -> Result<ConstantValue, String> {
    match value {
        WireConstant::Unit => Ok(ConstantValue::Unit),
        WireConstant::SignedInteger32(value) => Ok(ConstantValue::Integer(i64::from(*value))),
        WireConstant::SignedInteger64(value) => value
            .parse()
            .map(ConstantValue::Integer)
            .map_err(|error| format!("invalid signed 64-bit integer constant {value}: {error}")),
        WireConstant::Float32(value) => Ok(ConstantValue::Float32(*value)),
        WireConstant::Float64(value) => Ok(ConstantValue::Float64(*value)),
        WireConstant::Boolean(value) => Ok(ConstantValue::Boolean(*value)),
        WireConstant::Text(value) => Ok(ConstantValue::Text(value.clone())),
    }
}

fn integer_operand(
    module: &RuntimeModule,
    value: Option<&ConstantValue>,
    label: &str,
) -> Result<i64, String> {
    let Some(ConstantValue::Integer(value)) = value else {
        return Err(format!("{}: invalid constant {label}", module.source));
    };
    Ok(*value)
}

fn emit_constant_module(
    module: &RuntimeModule,
    manifest: &AbiManifest,
    manifest_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let runtime_exports = module
        .exports
        .iter()
        .filter_map(|exported| match exported {
            RuntimeExport::Runtime {
                wasm_name,
                function,
                ..
            } => Some((wasm_name, *function)),
            RuntimeExport::Comptime { .. } => None,
        })
        .collect::<Vec<_>>();
    let mut static_end = 1_024_u32;
    let mut planned_exports = Vec::new();
    for (wasm_name, function_id) in runtime_exports {
        let function = module.functions.get(function_id).ok_or_else(|| {
            format!(
                "{}: runtime export references unknown function {function_id}",
                module.source
            )
        })?;
        let evaluation = evaluate_constant_function(module, function)?;
        let manifest_export = manifest
            .exports
            .iter()
            .find(|exported| exported.name.as_deref() == Some(wasm_name))
            .ok_or_else(|| format!("manifest omitted runtime export {wasm_name}"))?;
        let abi_type = manifest_export
            .function
            .as_ref()
            .ok_or_else(|| format!("manifest export {wasm_name} has no function"))?
            .result
            .clone();
        let template = if flattened_type(&abi_type).len() > 1 {
            Some(CanonicalTemplate::new(&abi_type, &evaluation.value).finish()?)
        } else {
            None
        };
        let template_offset = if let Some(template) = &template {
            let offset = static_end;
            static_end = align_to(
                static_end
                    .checked_add(template.contents.len() as u32)
                    .ok_or_else(|| {
                        format!("{}: canonical template exceeds memory32", module.source)
                    })?,
                8,
            );
            offset
        } else {
            0
        };
        planned_exports.push(PlannedExport {
            wasm_name: wasm_name.clone(),
            post_return: manifest_export.post_return.clone(),
            abi_type,
            evaluation,
            template,
            template_offset,
            host_calls: Vec::new(),
        });
    }

    for exported in &mut planned_exports {
        for call in &exported.evaluation.calls {
            let (import_index, imported) = manifest
                .imports
                .iter()
                .enumerate()
                .find(|(_, imported)| {
                    imported.capability == call.capability && imported.operation == call.operation
                })
                .ok_or_else(|| {
                    format!(
                        "manifest omitted host import {}.{}",
                        call.capability, call.operation
                    )
                })?;
            if imported.function.parameters.len() != 1 {
                return Err(format!(
                    "{}: constant host call {}.{} requires one parameter",
                    module.source, call.capability, call.operation
                ));
            }
            if !flattened_type(&imported.function.result).is_empty() {
                return Err(format!(
                    "{}: constant host call {}.{} does not return unit",
                    module.source, call.capability, call.operation
                ));
            }
            let parameter = imported.function.parameters[0].clone();
            let text = if matches!(parameter, AbiType::Text) {
                let ConstantValue::Text(value) = &call.argument else {
                    return Err("canonical text cannot encode non-text constant".to_owned());
                };
                let contents = value.as_bytes().to_vec();
                let offset = static_end;
                static_end = static_end
                    .checked_add(contents.len() as u32)
                    .ok_or_else(|| format!("{}: host text exceeds memory32", module.source))?;
                Some((offset, contents))
            } else {
                None
            };
            exported.host_calls.push(PlannedHostCall {
                import_index: import_index as u32,
                parameter,
                argument: call.argument.clone(),
                text,
            });
        }
    }
    let heap_start = align_to(static_end, 8);
    let minimum_pages = u64::from(heap_start).div_ceil(65_536).max(1);

    let mut types = TypeSection::new();
    let mut imports = ImportSection::new();
    for imported in &manifest.imports {
        let parameters = imported
            .function
            .parameters
            .iter()
            .flat_map(flattened_type)
            .collect::<Vec<_>>();
        let results = flattened_type(&imported.function.result);
        if parameters.len() > 16 || !results.is_empty() {
            return Err(format!(
                "{}: constant host import {}.{} exceeds the direct unit-result subset",
                module.source, imported.module, imported.name
            ));
        }
        let type_index = add_function_type(&mut types, parameters, Vec::new());
        imports.import(
            &imported.module,
            &imported.name,
            EntityType::Function(type_index),
        );
    }

    let mut functions = FunctionSection::new();
    let mut code = CodeSection::new();
    let imported_function_count = manifest.imports.len() as u32;
    let realloc_type = add_function_type(
        &mut types,
        vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
        vec![ValType::I32],
    );
    let realloc_index = imported_function_count;
    functions.function(realloc_type);
    code.function(&realloc_function());

    let mut function_exports = Vec::new();
    let mut data_segments = Vec::new();
    for (ordinal, exported) in planned_exports.iter().enumerate() {
        for call in &exported.host_calls {
            if let Some((offset, contents)) = &call.text {
                data_segments.push((*offset, contents.clone()));
            }
        }
        let flattened = flattened_type(&exported.abi_type);
        let result_types = if flattened.len() <= 1 {
            flattened.clone()
        } else {
            vec![ValType::I32]
        };
        let type_index = add_function_type(&mut types, Vec::new(), result_types);
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&export_function(
            exported,
            ordinal as u32 + 1,
            realloc_index,
        )?);
        function_exports.push((exported.wasm_name.clone(), function_index));
        if let Some(template) = &exported.template {
            data_segments.push((exported.template_offset, template.contents.clone()));
            let post_type = add_function_type(&mut types, vec![ValType::I32], Vec::new());
            let post_index = imported_function_count + functions.len();
            functions.function(post_type);
            code.function(&post_return_function(ordinal as u32 + 1));
            let post_name = exported.post_return.clone().ok_or_else(|| {
                format!("manifest omitted post-return for {}", exported.wasm_name)
            })?;
            function_exports.push((post_name, post_index));
        }
    }

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
        .section(&exports)
        .section(&code);
    if !data.is_empty() {
        wasm.section(&data);
    }
    wasm.section(&CustomSection {
        name: Cow::Borrowed("blot:abi"),
        data: Cow::Borrowed(manifest_bytes),
    });
    Ok(wasm.finish())
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
    let imported_function_count = manifest.imports.len() as u32;
    let realloc_type = add_function_type(
        &mut types,
        vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
        vec![ValType::I32],
    );
    let realloc_index = imported_function_count;
    functions.function(realloc_type);
    code.function(&realloc_function());

    let text_compare_type = add_function_type(
        &mut types,
        vec![ValType::I32, ValType::I32, ValType::I32, ValType::I32],
        vec![ValType::I32],
    );
    let text_compare_index = imported_function_count + functions.len();
    functions.function(text_compare_type);
    code.function(&text_compare_function());

    let utf8_validator_type =
        add_function_type(&mut types, vec![ValType::I32, ValType::I32], Vec::new());
    let utf8_validator_index = imported_function_count + functions.len();
    functions.function(utf8_validator_type);
    code.function(&utf8_validator_function());

    let i64_to_text_type = add_function_type(
        &mut types,
        vec![ValType::I64],
        vec![ValType::I32, ValType::I32],
    );
    let i64_to_text_index = imported_function_count + functions.len();
    functions.function(i64_to_text_type);
    code.function(&i64_to_text_function(realloc_index));
    let dynamic_helpers = DynamicHelpers {
        realloc: realloc_index,
        text_compare: text_compare_index,
        utf8_validator: utf8_validator_index,
        i64_to_text: i64_to_text_index,
    };

    let mut function_exports = Vec::new();
    for exported in &module.exports {
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
        if !signature.parameters.is_empty()
            || !matches!(module.types[signature.result], RuntimeType::Unit)
        {
            return Err(format!(
                "{}: residual Rust emission currently requires a Unit -> Unit export",
                module.source
            ));
        }
        let type_index = add_function_type(&mut types, Vec::new(), Vec::new());
        let function_index = imported_function_count + functions.len();
        functions.function(type_index);
        code.function(&dynamic_export_function(
            module,
            runtime_function,
            manifest,
            dynamic_helpers,
            &text_offsets,
        )?);
        function_exports.push((wasm_name.clone(), function_index));
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
        .section(&exports)
        .section(&code);
    if !data.is_empty() {
        wasm.section(&data);
    }
    wasm.section(&CustomSection {
        name: Cow::Borrowed("blot:abi"),
        data: Cow::Borrowed(manifest_bytes),
    });
    Ok(wasm.finish())
}

fn dynamic_export_function(
    module: &RuntimeModule,
    function: &RuntimeFunction,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    text_offsets: &HashMap<(usize, usize), u32>,
) -> Result<Function, String> {
    let mut definitions = BTreeMap::new();
    for block in &function.blocks {
        for parameter in &block.parameters {
            definitions.insert(parameter.value, parameter.type_id);
        }
        for operation in &block.operations {
            definitions.insert(operation.result, operation.type_id);
        }
    }
    let mut local_types = Vec::new();
    let mut value_locals = HashMap::new();
    for (value, type_id) in definitions {
        let flattened = flattened_runtime_type(module, type_id)?;
        let start = local_types.len() as u32;
        local_types.extend(flattened.iter().copied());
        value_locals.insert(
            value,
            (start..start + flattened.len() as u32).collect::<Vec<_>>(),
        );
    }
    let dispatcher = local_types.len() as u32;
    local_types.push(ValType::I32);
    let scratch_pointer = local_types.len() as u32;
    local_types.push(ValType::I32);
    let scratch_length = local_types.len() as u32;
    local_types.push(ValType::I32);
    let mut wasm_function = Function::new(local_types.into_iter().map(|type_| (1, type_)));
    let mut instructions = wasm_function.instructions();
    begin_call(&mut instructions, 1);
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
            )?;
        }
        emit_dynamic_terminator(
            &mut instructions,
            module,
            function,
            &block.terminator,
            &value_locals,
            dispatcher,
        )?;
        instructions.end();
    }
    instructions.unreachable().end().unreachable().end();
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
            WireConstant::Float32(_) | WireConstant::Float64(_) => {
                return Err(format!(
                    "{}: dynamic float constants are not emitted yet",
                    module.source
                ));
            }
        },
        "host.call" => {
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
                    helpers.utf8_validator,
                )?;
            }
        }
        "text.compare" => {
            let left = locals_for(module, value_locals, operation.operands[0])?;
            let right = locals_for(module, value_locals, operation.operands[1])?;
            emit_local_values(instructions, left);
            emit_local_values(instructions, right);
            instructions.call(helpers.text_compare).local_set(result[0]);
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
            let value = locals_for(module, value_locals, operation.operands[0])?;
            instructions
                .local_get(value[0])
                .call(helpers.i64_to_text)
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
            } else {
                instructions.local_get(left[0]).local_get(right[0]);
                emit_i32_operator(instructions, operation.operator, &module.source)?;
                instructions.local_set(result[0]);
            }
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
            assign_locals(instructions, &result[1..], payload)?;
        }
        "sum.tag" => {
            let sum = locals_for(module, value_locals, operation.operands[0])?;
            instructions.local_get(sum[0]).local_set(result[0]);
        }
        "sum.payload" => {
            let sum = locals_for(module, value_locals, operation.operands[0])?;
            assign_locals(instructions, result, &sum[1..])?;
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

fn emit_dynamic_terminator(
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
            let result = locals_for(module, value_locals, *value)?;
            if !result.is_empty() {
                return Err(format!(
                    "{}: dynamic non-Unit return is not emitted yet",
                    module.source
                ));
            }
            finish_call(instructions);
            instructions.return_();
        }
    }
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
    for (parameter, argument) in block.parameters.iter().zip(arguments) {
        let destination = locals_for(module, value_locals, parameter.value)?;
        let source = locals_for(module, value_locals, *argument)?;
        assign_locals(instructions, destination, source)?;
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
        RuntimeType::Text => Ok(vec![ValType::I32, ValType::I32]),
        RuntimeType::Product { fields, .. } => {
            let mut result = Vec::new();
            for field in fields {
                result.extend(flattened_runtime_type(module, field.type_id)?);
            }
            Ok(result)
        }
        RuntimeType::Sum { cases, .. } => {
            let mut payload = Vec::new();
            for case_ in cases {
                let flattened = flattened_runtime_type(module, case_.payload_type)?;
                if payload.is_empty() {
                    payload = flattened;
                } else if payload != flattened {
                    return Err(format!(
                        "{}: dynamic sum payloads require different Wasm layouts",
                        module.source
                    ));
                }
            }
            let mut result = vec![ValType::I32];
            result.extend(payload);
            Ok(result)
        }
        _ => Err(format!(
            "{}: dynamic {} values are not emitted yet",
            module.source,
            runtime_kind(type_)
        )),
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
        AbiType::Text => {
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
        AbiType::Sealed { inner, .. } => {
            emit_load_canonical_result(instructions, inner, destination, pointer, offset)
        }
        _ => Err(format!(
            "indirect dynamic {} host results are not emitted yet",
            abi_kind(type_)
        )),
    }
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
        .global_get(HEAP_GLOBAL)
        .local_get(2)
        .i32_const(1)
        .i32_sub()
        .i32_add()
        .local_get(2)
        .i32_const(-1)
        .i32_mul()
        .i32_and()
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
        .local_get(end_pointer)
        .global_set(HEAP_GLOBAL)
        .local_get(new_pointer)
        .end()
        .end();
    function
}

fn export_function(
    exported: &PlannedExport,
    call_id: u32,
    realloc: u32,
) -> Result<Function, String> {
    let flattened = flattened_type(&exported.abi_type);
    let locals = if flattened.len() == 1 {
        vec![(1, flattened[0])]
    } else if flattened.len() > 1 {
        vec![(1, ValType::I32)]
    } else {
        Vec::new()
    };
    let mut function = Function::new(locals);
    let mut instructions = function.instructions();
    begin_call(&mut instructions, call_id);
    for call in &exported.host_calls {
        if let Some((offset, contents)) = &call.text {
            instructions
                .i32_const(*offset as i32)
                .i32_const(contents.len() as i32);
        } else {
            emit_direct_constant(&mut instructions, &call.parameter, &call.argument)?;
        }
        instructions.call(call.import_index);
    }
    if flattened.is_empty() {
        finish_call(&mut instructions);
    } else if flattened.len() == 1 {
        emit_direct_constant(
            &mut instructions,
            &exported.abi_type,
            &exported.evaluation.value,
        )?;
        instructions.local_set(0);
        finish_call(&mut instructions);
        instructions.local_get(0);
    } else {
        let template = exported
            .template
            .as_ref()
            .ok_or_else(|| format!("{} has no canonical result template", exported.wasm_name))?;
        instructions
            .i32_const(0)
            .i32_const(0)
            .i32_const(8)
            .i32_const(template.contents.len() as i32)
            .call(realloc)
            .local_tee(0)
            .i32_const(exported.template_offset as i32)
            .i32_const(template.contents.len() as i32)
            .memory_copy(0, 0);
        for relocation in &template.relocations {
            instructions
                .local_get(0)
                .i32_const(relocation.field_offset as i32)
                .i32_add()
                .local_get(0)
                .i32_const(relocation.target_offset as i32)
                .i32_add()
                .i32_store(wasm_encoder::MemArg {
                    offset: 0,
                    align: 2,
                    memory_index: 0,
                });
        }
        instructions
            .local_get(0)
            .global_set(RESULT_POINTER_GLOBAL)
            .local_get(0);
    }
    instructions.end();
    Ok(function)
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

fn emit_direct_constant(
    instructions: &mut InstructionSink<'_>,
    type_: &AbiType,
    value: &ConstantValue,
) -> Result<(), String> {
    match (type_, value) {
        (AbiType::Unit, ConstantValue::Unit) => Ok(()),
        (AbiType::SignedInteger64, ConstantValue::Integer(value)) => {
            instructions.i64_const(*value);
            Ok(())
        }
        (AbiType::Float32, ConstantValue::Float32(value)) => {
            instructions.f32_const(Ieee32::new(value.to_bits()));
            Ok(())
        }
        (AbiType::Float64, ConstantValue::Float64(value)) => {
            instructions.f64_const(Ieee64::new(value.to_bits()));
            Ok(())
        }
        (AbiType::Boolean, ConstantValue::Boolean(value)) => {
            instructions.i32_const(i32::from(*value));
            Ok(())
        }
        (AbiType::Sealed { inner, .. }, value) => emit_direct_constant(instructions, inner, value),
        (AbiType::Record { fields }, ConstantValue::Product(values)) => {
            let present = fields
                .iter()
                .filter(|field| !flattened_type(&field.type_).is_empty())
                .collect::<Vec<_>>();
            if present.len() != 1 {
                return Err("canonical record is not a direct constant".to_owned());
            }
            let field = present[0];
            let value = values
                .get(&field.name)
                .ok_or_else(|| format!("constant record omitted field {}", field.name))?;
            emit_direct_constant(instructions, &field.type_, value)
        }
        (AbiType::Variant { cases }, ConstantValue::Sum { case, .. })
            if flattened_type(type_).len() == 1 =>
        {
            let case = cases
                .iter()
                .position(|candidate| candidate.name == *case)
                .ok_or_else(|| format!("constant variant has unknown case {case}"))?;
            instructions.i32_const(case as i32);
            Ok(())
        }
        _ => Err(format!(
            "canonical {} cannot encode constant {}",
            abi_kind(type_),
            constant_kind(value)
        )),
    }
}

fn abi_kind(type_: &AbiType) -> &'static str {
    match type_ {
        AbiType::Unit => "unit",
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

fn constant_kind(value: &ConstantValue) -> &'static str {
    match value {
        ConstantValue::Unit => "unit",
        ConstantValue::Integer(_) => "integer",
        ConstantValue::Float32(_) => "float32",
        ConstantValue::Float64(_) => "float64",
        ConstantValue::Boolean(_) => "boolean",
        ConstantValue::Text(_) => "text",
        ConstantValue::Product(_) => "product",
        ConstantValue::Sum { .. } => "sum",
        ConstantValue::Store(_) => "store",
    }
}

struct CanonicalTemplate<'a> {
    bytes: Vec<u8>,
    relocations: Vec<Relocation>,
    type_: &'a AbiType,
    value: &'a ConstantValue,
}

impl<'a> CanonicalTemplate<'a> {
    fn new(type_: &'a AbiType, value: &'a ConstantValue) -> Self {
        Self {
            bytes: Vec::new(),
            relocations: Vec::new(),
            type_,
            value,
        }
    }

    fn finish(mut self) -> Result<PlannedTemplate, String> {
        let layout = memory_layout(self.type_);
        let root = self.allocate(layout.size, layout.alignment);
        if root != 0 {
            return Err(format!("canonical template root began at {root}"));
        }
        self.write(self.type_, self.value, root)?;
        Ok(PlannedTemplate {
            contents: self.bytes,
            relocations: self.relocations,
        })
    }

    fn write(&mut self, type_: &AbiType, value: &ConstantValue, offset: u32) -> Result<(), String> {
        match (type_, value) {
            (AbiType::Unit, ConstantValue::Unit) => Ok(()),
            (AbiType::SignedInteger64, ConstantValue::Integer(value)) => {
                self.set(offset, &value.to_le_bytes());
                Ok(())
            }
            (AbiType::Float32, ConstantValue::Float32(value)) => {
                self.set(offset, &value.to_le_bytes());
                Ok(())
            }
            (AbiType::Float64, ConstantValue::Float64(value)) => {
                self.set(offset, &value.to_le_bytes());
                Ok(())
            }
            (AbiType::Boolean, ConstantValue::Boolean(value)) => {
                self.bytes[offset as usize] = u8::from(*value);
                Ok(())
            }
            (AbiType::Text, ConstantValue::Text(value)) => {
                let encoded = value.as_bytes();
                let target = self.allocate(encoded.len() as u32, 1);
                self.set(target, encoded);
                self.pointer(offset, target);
                self.set(offset + 4, &(encoded.len() as u32).to_le_bytes());
                Ok(())
            }
            (AbiType::Array { element }, ConstantValue::Store(elements)) => {
                let layout = memory_layout(element);
                let target = self.allocate(layout.size * elements.len() as u32, layout.alignment);
                for (index, element_value) in elements.iter().enumerate() {
                    self.write(element, element_value, target + index as u32 * layout.size)?;
                }
                self.pointer(offset, target);
                self.set(offset + 4, &(elements.len() as u32).to_le_bytes());
                Ok(())
            }
            (AbiType::Sealed { inner, .. }, value) => self.write(inner, value, offset),
            (AbiType::Record { fields }, ConstantValue::Product(values)) => {
                for field in record_layout(fields) {
                    let value = values
                        .get(&field.name)
                        .ok_or_else(|| format!("constant record omitted field {}", field.name))?;
                    self.write(&field.type_, value, offset + field.offset)?;
                }
                Ok(())
            }
            (AbiType::Variant { cases }, ConstantValue::Sum { case, payload }) => {
                let source_case = cases
                    .iter()
                    .find(|candidate| candidate.name == *case)
                    .ok_or_else(|| format!("constant variant has unknown case {case}"))?;
                let tag = cases
                    .iter()
                    .position(|candidate| candidate.name == source_case.name)
                    .expect("ABI cases omitted their source case");
                let layout = variant_layout(cases);
                let tag_bytes = (tag as u32).to_le_bytes();
                self.set(offset, &tag_bytes[..layout.discriminant_size as usize]);
                if let Some(payload_type) = &source_case.payload {
                    self.write(payload_type, payload, offset + layout.payload_offset)?;
                }
                Ok(())
            }
            _ => Err(format!(
                "canonical {} cannot encode constant {}",
                abi_kind(type_),
                constant_kind(value)
            )),
        }
    }

    fn pointer(&mut self, field_offset: u32, target_offset: u32) {
        self.set(field_offset, &target_offset.to_le_bytes());
        self.relocations.push(Relocation {
            field_offset,
            target_offset,
        });
    }

    fn allocate(&mut self, size: u32, alignment: u32) -> u32 {
        let offset = align_to(self.bytes.len() as u32, alignment);
        self.bytes.resize((offset + size) as usize, 0);
        offset
    }

    fn set(&mut self, offset: u32, encoded: &[u8]) {
        let start = offset as usize;
        let end = start + encoded.len();
        self.bytes[start..end].copy_from_slice(encoded);
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
