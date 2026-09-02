use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::rc::Rc;

use serde::Serialize;

use crate::diagnostic::Diagnostic;
use crate::eval::{
    ApplicationSite, CompilerApplication, Computation, Context, Phase, Runtime, closure_free_names,
    evaluate_expression, evaluate_module,
};
use crate::ownership::Produced;
use crate::protocol::RUNTIME_HIR_SCHEMA;
use crate::typecheck::{CheckedModule, Domain, Scalar, Type, sealed_type, sealed_type_name};
use crate::value::{
    ArrayValues, ChoiceSource, ClosureAlternative, EffectOperationOwnership, EffectOwnership,
    Environment, OrderedFields, RuntimeMeaning, RuntimeValue, Value, as_tuple, child_env, lookup,
    recursive_env,
};

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum RuntimeType {
    Unit,
    #[serde(rename = "integer-32")]
    Integer32,
    #[serde(rename = "signed-integer-64")]
    SignedInteger64,
    #[serde(rename = "float-32")]
    Float32,
    #[serde(rename = "float-64")]
    Float64,
    Boolean,
    Text,
    Vector {
        element: &'static str,
        lanes: u8,
    },
    Mask {
        element: &'static str,
        lanes: u8,
    },
    Store {
        #[serde(rename = "elementType")]
        element_type: usize,
    },
    Scratch {
        #[serde(rename = "elementType")]
        element_type: usize,
    },
    Indirect {
        #[serde(rename = "targetType")]
        target_type: usize,
    },
    Product {
        name: String,
        fields: Vec<RuntimeField>,
    },
    Sum {
        name: String,
        cases: Vec<RuntimeCase>,
    },
    Sealed {
        name: String,
        #[serde(rename = "representationType")]
        representation_type: usize,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeLayoutWitness {
    fingerprint: String,
    size: usize,
    alignment: usize,
    stride: usize,
}

fn align_to(offset: usize, alignment: usize) -> Option<usize> {
    if alignment == 0 || !alignment.is_power_of_two() {
        return None;
    }
    offset
        .checked_add(alignment - 1)
        .map(|value| value / alignment * alignment)
}

fn runtime_layout_witness(
    types: &[RuntimeType],
    type_id: usize,
) -> Result<RuntimeLayoutWitness, String> {
    fn visit(
        types: &[RuntimeType],
        type_id: usize,
        memo: &mut HashMap<usize, RuntimeLayoutWitness>,
        active: &mut HashSet<usize>,
    ) -> Result<RuntimeLayoutWitness, String> {
        if let Some(witness) = memo.get(&type_id) {
            return Ok(witness.clone());
        }
        let type_ = types
            .get(type_id)
            .ok_or_else(|| format!("layout names absent type {type_id}"))?;
        if !active.insert(type_id) {
            return Err(format!(
                "type {type_id} has a direct recursive layout; use an indirect or Store representation"
            ));
        }
        let scalar =
            |size: usize, alignment: usize, name: String| -> Result<RuntimeLayoutWitness, String> {
                Ok(RuntimeLayoutWitness {
                    fingerprint: name,
                    size,
                    alignment,
                    stride: align_to(size, alignment)
                        .ok_or_else(|| "invalid scalar alignment".to_owned())?,
                })
            };
        let witness = match type_ {
            RuntimeType::Unit => scalar(0, 1, "unit".to_owned())?,
            RuntimeType::Integer32 => scalar(4, 4, "integer-32".to_owned())?,
            RuntimeType::SignedInteger64 => scalar(8, 8, "signed-integer-64".to_owned())?,
            RuntimeType::Float32 => scalar(4, 4, "float-32".to_owned())?,
            RuntimeType::Float64 => scalar(8, 8, "float-64".to_owned())?,
            RuntimeType::Boolean => scalar(4, 4, "boolean".to_owned())?,
            RuntimeType::Text => scalar(8, 4, "text(memory32)".to_owned())?,
            RuntimeType::Vector { element, lanes } => {
                scalar(16, 16, format!("vector({element}x{lanes})"))?
            }
            RuntimeType::Mask { element, lanes } => {
                scalar(16, 16, format!("mask({element}x{lanes})"))?
            }
            RuntimeType::Indirect { target_type } => {
                scalar(4, 4, format!("indirect({target_type})"))?
            }
            RuntimeType::Store { element_type } => {
                memo.insert(
                    type_id,
                    RuntimeLayoutWitness {
                        fingerprint: format!("store@{type_id}"),
                        size: 8,
                        alignment: 4,
                        stride: 8,
                    },
                );
                let element = visit(types, *element_type, memo, active)?;
                RuntimeLayoutWitness {
                    fingerprint: format!(
                        "store({};stride={})",
                        element.fingerprint, element.stride
                    ),
                    size: 8,
                    alignment: 4,
                    stride: 8,
                }
            }
            RuntimeType::Scratch { element_type } => {
                memo.insert(
                    type_id,
                    RuntimeLayoutWitness {
                        fingerprint: format!("scratch@{type_id}"),
                        size: 12,
                        alignment: 4,
                        stride: 12,
                    },
                );
                let element = visit(types, *element_type, memo, active)?;
                RuntimeLayoutWitness {
                    fingerprint: format!(
                        "scratch({};stride={})",
                        element.fingerprint, element.stride
                    ),
                    size: 12,
                    alignment: 4,
                    stride: 12,
                }
            }
            RuntimeType::Sealed {
                name,
                representation_type,
            } => {
                let representation = visit(types, *representation_type, memo, active)?;
                RuntimeLayoutWitness {
                    fingerprint: format!("sealed({name:?},{})", representation.fingerprint),
                    ..representation
                }
            }
            RuntimeType::Product { name, fields } => {
                let mut offset = 0usize;
                let mut alignment = 1usize;
                let mut keyed = Vec::new();
                for field in fields {
                    let layout = visit(types, field.type_id, memo, active)?;
                    offset = align_to(offset, layout.alignment)
                        .ok_or_else(|| "product layout overflow".to_owned())?;
                    keyed.push(format!(
                        "{:?}@{}:{}",
                        field.name, offset, layout.fingerprint
                    ));
                    offset = offset
                        .checked_add(layout.size)
                        .ok_or_else(|| "product layout overflow".to_owned())?;
                    alignment = alignment.max(layout.alignment);
                }
                let size = align_to(offset, alignment)
                    .ok_or_else(|| "product layout overflow".to_owned())?;
                RuntimeLayoutWitness {
                    fingerprint: format!("product({name:?}){{{}}}", keyed.join(",")),
                    size,
                    alignment,
                    stride: align_to(size, alignment)
                        .ok_or_else(|| "product layout overflow".to_owned())?,
                }
            }
            RuntimeType::Sum { name, cases } => {
                let mut payload_size = 0usize;
                let mut payload_alignment = 1usize;
                let mut keyed = Vec::new();
                for case_ in cases {
                    let layout = visit(types, case_.payload_type, memo, active)?;
                    payload_size = payload_size.max(layout.size);
                    payload_alignment = payload_alignment.max(layout.alignment);
                    keyed.push(format!("{:?}:{}", case_.name, layout.fingerprint));
                }
                let alignment = 4usize.max(payload_alignment);
                let payload_offset = align_to(4, payload_alignment)
                    .ok_or_else(|| "sum layout overflow".to_owned())?;
                let size = align_to(
                    payload_offset
                        .checked_add(payload_size)
                        .ok_or_else(|| "sum layout overflow".to_owned())?,
                    alignment,
                )
                .ok_or_else(|| "sum layout overflow".to_owned())?;
                RuntimeLayoutWitness {
                    fingerprint: format!("sum({name:?}){{{}}}", keyed.join(",")),
                    size,
                    alignment,
                    stride: align_to(size, alignment)
                        .ok_or_else(|| "sum layout overflow".to_owned())?,
                }
            }
        };
        active.remove(&type_id);
        memo.insert(type_id, witness.clone());
        Ok(witness)
    }

    visit(types, type_id, &mut HashMap::new(), &mut HashSet::new())
}

fn validate_runtime_layouts(types: &[RuntimeType]) -> Result<(), Diagnostic> {
    for (type_id, type_) in types.iter().enumerate() {
        let element_type = match type_ {
            RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } => {
                Some(*element_type)
            }
            _ => None,
        };
        if let Some(element_type) = element_type
            && runtime_type_contains_scratch(types, element_type, &mut HashSet::new())
        {
            return Err(hir_error(&format!(
                "Runtime type {type_id} nests compiler-private Scratch storage"
            )));
        }
    }
    for type_id in 0..types.len() {
        runtime_layout_witness(types, type_id).map_err(|error| {
            hir_error(&format!(
                "Runtime type {type_id} has no closed layout: {error}"
            ))
        })?;
    }
    Ok(())
}

fn runtime_type_contains_scratch(
    types: &[RuntimeType],
    type_id: usize,
    seen: &mut HashSet<usize>,
) -> bool {
    if !seen.insert(type_id) {
        return false;
    }
    match &types[type_id] {
        RuntimeType::Scratch { .. } => true,
        RuntimeType::Store { element_type } => {
            runtime_type_contains_scratch(types, *element_type, seen)
        }
        RuntimeType::Indirect { target_type } => {
            runtime_type_contains_scratch(types, *target_type, seen)
        }
        RuntimeType::Product { fields, .. } => fields
            .iter()
            .any(|field| runtime_type_contains_scratch(types, field.type_id, seen)),
        RuntimeType::Sum { cases, .. } => cases
            .iter()
            .any(|case_| runtime_type_contains_scratch(types, case_.payload_type, seen)),
        RuntimeType::Sealed {
            representation_type,
            ..
        } => runtime_type_contains_scratch(types, *representation_type, seen),
        RuntimeType::Unit
        | RuntimeType::Boolean
        | RuntimeType::Integer32
        | RuntimeType::SignedInteger64
        | RuntimeType::Float32
        | RuntimeType::Float64
        | RuntimeType::Text
        | RuntimeType::Vector { .. }
        | RuntimeType::Mask { .. } => false,
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
pub(crate) struct RuntimeField {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) type_id: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
pub(crate) struct RuntimeCase {
    pub(crate) name: String,
    #[serde(rename = "payloadType")]
    pub(crate) payload_type: usize,
}

#[derive(Clone, Eq, Hash, PartialEq, Serialize)]
pub(crate) struct RuntimeSignature {
    pub(crate) parameters: Vec<usize>,
    pub(crate) result: usize,
    pub(crate) effects: Vec<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeOperation {
    pub(crate) kind: &'static str,
    pub(crate) result: usize,
    #[serde(rename = "type")]
    pub(crate) type_id: usize,
    pub(crate) operands: Vec<usize>,
    pub(crate) ownership: &'static str,
    pub(crate) span: RuntimeSpan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<WireConstant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) update: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) case: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) capability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) operator: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) conversion: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) lane: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) field: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) function: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) signature: Option<usize>,
    #[serde(rename = "staticStore", skip_serializing_if = "Option::is_none")]
    pub(crate) static_store: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
pub(crate) enum WireConstant {
    Unit,
    #[serde(rename = "integer-32")]
    SignedInteger32(i32),
    #[serde(rename = "signed-integer-64")]
    SignedInteger64(String),
    #[serde(rename = "float-32")]
    Float32(f32),
    #[serde(rename = "float-64")]
    Float64(f64),
    Boolean(bool),
    Text(String),
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RuntimeStaticStore {
    #[serde(rename = "elementType")]
    pub(crate) element_type: usize,
    pub(crate) values: Vec<WireConstant>,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeSwitchCase {
    pub(crate) value: WireConstant,
    pub(crate) target: usize,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeSpan {
    pub(crate) file: String,
    pub(crate) start: u32,
    pub(crate) end: u32,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum RuntimeTerminator {
    Branch {
        target: usize,
        arguments: Vec<usize>,
        span: RuntimeSpan,
    },
    Conditional {
        condition: usize,
        consequent: usize,
        #[serde(rename = "consequentArguments")]
        consequent_arguments: Vec<usize>,
        alternate: usize,
        #[serde(rename = "alternateArguments")]
        alternate_arguments: Vec<usize>,
        span: RuntimeSpan,
    },
    Switch {
        selector: usize,
        cases: Vec<RuntimeSwitchCase>,
        fallback: usize,
        span: RuntimeSpan,
    },
    Return {
        value: usize,
        span: RuntimeSpan,
    },
    /// The block diverges: an arm whose comptime meaning is `@panic` reached
    /// residual code, so the running program traps instead of producing a
    /// value for the join.
    Trap {
        message: String,
        span: RuntimeSpan,
    },
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeBlockParameter {
    pub(crate) value: usize,
    #[serde(rename = "type")]
    pub(crate) type_id: usize,
    pub(crate) ownership: &'static str,
    pub(crate) span: RuntimeSpan,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeBlock {
    pub(crate) id: usize,
    pub(crate) parameters: Vec<RuntimeBlockParameter>,
    pub(crate) operations: Vec<RuntimeOperation>,
    pub(crate) terminator: RuntimeTerminator,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeFunction {
    pub(crate) id: usize,
    pub(crate) name: String,
    pub(crate) signature: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reuse: Option<&'static str>,
    #[serde(rename = "entryBlock")]
    pub(crate) entry_block: usize,
    pub(crate) blocks: Vec<RuntimeBlock>,
    pub(crate) span: RuntimeSpan,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum RuntimeEffectOwnership {
    Mode(&'static str),
    Record {
        kind: &'static str,
        fields: Vec<RuntimeEffectOwnershipMember>,
    },
    Variant {
        kind: &'static str,
        cases: Vec<RuntimeEffectOwnershipMember>,
    },
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub(crate) struct RuntimeEffectOwnershipMember {
    pub(crate) name: String,
    ownership: RuntimeEffectOwnership,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub(crate) struct RuntimeOperationOwnership {
    input: RuntimeEffectOwnership,
    result: RuntimeEffectOwnership,
}

fn runtime_operation_ownership(ownership: &EffectOperationOwnership) -> RuntimeOperationOwnership {
    RuntimeOperationOwnership {
        input: runtime_effect_ownership(&ownership.input),
        result: runtime_effect_ownership(&ownership.result),
    }
}

fn runtime_effect_ownership(ownership: &EffectOwnership) -> RuntimeEffectOwnership {
    match ownership {
        EffectOwnership::Unrestricted => RuntimeEffectOwnership::Mode("unrestricted"),
        EffectOwnership::Affine => RuntimeEffectOwnership::Mode("affine"),
        EffectOwnership::Linear => RuntimeEffectOwnership::Mode("linear"),
        EffectOwnership::Record(fields) => RuntimeEffectOwnership::Record {
            kind: "record",
            fields: fields
                .iter()
                .map(|(name, ownership)| RuntimeEffectOwnershipMember {
                    name: name.clone(),
                    ownership: runtime_effect_ownership(ownership),
                })
                .collect(),
        },
        EffectOwnership::Variant(cases) => RuntimeEffectOwnership::Variant {
            kind: "variant",
            cases: cases
                .iter()
                .map(|(name, ownership)| RuntimeEffectOwnershipMember {
                    name: name.clone(),
                    ownership: runtime_effect_ownership(ownership),
                })
                .collect(),
        },
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeCapabilityOperation {
    pub(crate) name: String,
    pub(crate) signature: usize,
    pub(crate) ownership: RuntimeOperationOwnership,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeCapability {
    pub(crate) name: String,
    pub(crate) operations: Vec<RuntimeCapabilityOperation>,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeLink {
    pub(crate) unit: String,
    pub(crate) name: String,
    pub(crate) signature: usize,
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub(crate) enum RuntimeExport {
    Runtime {
        #[serde(rename = "sourceName")]
        source_name: String,
        phase: &'static str,
        #[serde(rename = "wasmName")]
        wasm_name: String,
        function: usize,
        signature: usize,
        ownership: &'static str,
    },
    Comptime {
        #[serde(rename = "sourceName")]
        source_name: String,
        phase: &'static str,
    },
}

#[derive(Clone, Serialize)]
pub struct RuntimeModule {
    pub(crate) format: &'static str,
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u8,
    pub(crate) source: String,
    pub(crate) types: Vec<RuntimeType>,
    pub(crate) signatures: Vec<RuntimeSignature>,
    #[serde(rename = "staticStores")]
    pub(crate) static_stores: Vec<RuntimeStaticStore>,
    pub(crate) functions: Vec<RuntimeFunction>,
    pub(crate) capabilities: Vec<RuntimeCapability>,
    pub(crate) links: Vec<RuntimeLink>,
    pub(crate) exports: Vec<RuntimeExport>,
}

pub(crate) struct ResidualTrace {
    source: String,
    development_units: Option<Rc<HashSet<String>>>,
    types: Vec<RuntimeType>,
    type_ids: HashMap<String, usize>,
    signatures: Vec<RuntimeSignature>,
    capabilities: BTreeMap<String, BTreeMap<String, (usize, RuntimeOperationOwnership)>>,
    blocks: Vec<ResidualBlock>,
    current_block: usize,
    next_value: usize,
    active_primitive: Option<String>,
    functions: BTreeMap<usize, RuntimeFunction>,
    function_ids: Vec<ResidualFunctionIdentity>,
    pending_recursive_types: HashSet<usize>,
    settled_recursive_types: HashSet<usize>,
    recursive_result_ids: Vec<RecursiveResultIdentity>,
    exports: Vec<RuntimeExport>,
    export_effects: BTreeSet<String>,
    root_function: usize,
    next_function: usize,
    function_frames: Vec<ResidualFunctionFrame>,
    checked_aggregate_representations: CheckedAggregateRepresentations,
}

struct ResidualFunctionIdentity {
    module: String,
    body: crate::ast::ExpressionId,
    argument_type: usize,
    argument_reuse: StoreReuseWitness,
    result_reuse: StoreReuseWitness,
    result_type: usize,
    capture_types: Vec<usize>,
    signature: Value,
    function: usize,
    runtime_signature: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum StoreReuseWitness {
    None,
    Deferred,
    Shared,
    Reusable,
    Shape(Vec<(String, StoreReuseWitness)>),
    Tag(String, Option<Box<StoreReuseWitness>>),
}

struct RecursiveResultIdentity {
    module: String,
    body: crate::ast::ExpressionId,
    argument_type: usize,
    argument_reuse: StoreReuseWitness,
    capture_types: Vec<usize>,
    signature: Value,
    type_id: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum RepresentationShape {
    Unknown,
    Unit,
    SignedInteger64,
    Float32,
    Float64,
    Text,
    FloatVector { lanes: usize },
    FloatMask { lanes: usize },
    IntegerVector { bits: u8, lanes: usize },
    IntegerMask { bits: u8, lanes: usize },
    Runtime(usize),
    Shape(Vec<(String, RepresentationShape)>),
    Array(Option<Box<RepresentationShape>>),
    Region(Box<RepresentationShape>),
    Scratch(Box<RepresentationShape>),
    Tag(String, Option<Box<RepresentationShape>>),
    Sealed(String, Box<RepresentationShape>),
}

#[derive(Default)]
struct RepresentationFacts {
    exact: Vec<(Value, Option<usize>)>,
    shapes: HashMap<RepresentationShape, Option<usize>>,
}

#[derive(Default)]
struct CheckedAggregateRepresentations {
    arrays: Vec<(ArrayValues, Option<usize>)>,
    shapes: Vec<(OrderedFields, Option<usize>)>,
    structural: HashMap<RepresentationShape, Option<usize>>,
}

impl CheckedAggregateRepresentations {
    fn record(&mut self, value: &Value, type_id: usize) {
        if let Some(shape) = checked_representation_shape(value) {
            self.structural
                .entry(shape)
                .and_modify(|known| {
                    if known.is_some_and(|known| known != type_id) {
                        *known = None;
                    }
                })
                .or_insert(Some(type_id));
        }
        let known = match value {
            Value::Array(values) => self
                .arrays
                .iter_mut()
                .find(|(candidate, _)| candidate.same_identity(values))
                .map(|(_, known)| known),
            Value::Shape(fields) => self
                .shapes
                .iter_mut()
                .find(|(candidate, _)| candidate.same_identity(fields))
                .map(|(_, known)| known),
            _ => return,
        };
        if let Some(known) = known {
            if known.is_some_and(|known| known != type_id) {
                *known = None;
            }
            return;
        }
        match value {
            Value::Array(values) => self.arrays.push((values.clone(), Some(type_id))),
            Value::Shape(fields) => self.shapes.push((fields.clone(), Some(type_id))),
            _ => unreachable!("checked aggregates are arrays or shapes"),
        }
    }

    fn get(&self, value: &Value) -> Option<usize> {
        let exact = match value {
            Value::Array(values) => self
                .arrays
                .iter()
                .find(|(candidate, _)| candidate.same_identity(values))
                .map(|(_, known)| *known),
            Value::Shape(fields) => self
                .shapes
                .iter()
                .find(|(candidate, _)| candidate.same_identity(fields))
                .map(|(_, known)| *known),
            _ => return None,
        };
        if let Some(known) = exact {
            return known;
        }
        let shape = checked_representation_shape(value)?;
        self.structural.get(&shape).copied().flatten()
    }
}

impl RepresentationFacts {
    fn record(&mut self, value: &Value, type_id: usize) {
        if let Some((_, known)) = self
            .exact
            .iter_mut()
            .find(|(candidate, _)| crate::value::equal(candidate, value))
        {
            if known.is_some_and(|known| known != type_id) {
                *known = None;
            }
        } else {
            self.exact.push((value.clone(), Some(type_id)));
        }
        if let Some(shape) = specialization_representation_shape(value) {
            self.shapes
                .entry(shape)
                .and_modify(|known| {
                    if known.is_some_and(|known| known != type_id) {
                        *known = None;
                    }
                })
                .or_insert(Some(type_id));
        }
    }

    fn get(&self, value: &Value) -> Option<usize> {
        if let Some((_, Some(type_id))) = self
            .exact
            .iter()
            .find(|(candidate, _)| crate::value::equal(candidate, value))
        {
            return Some(*type_id);
        }
        let shape = specialization_representation_shape(value)?;
        self.shapes.get(&shape).copied().flatten()
    }
}

struct ResidualFunctionFrame {
    source: String,
    blocks: Vec<ResidualBlock>,
    current_block: usize,
    next_value: usize,
}

struct RuntimeCapturePlan {
    values: Vec<RuntimeValue>,
    requires_staging: bool,
}

pub(crate) enum ResidualFunctionCall {
    Static,
    Existing(Value),
    Compile(ResidualFunctionCompilation),
}

pub(crate) struct ResidualClosure<'a> {
    pub(crate) context: &'a Rc<Context>,
    pub(crate) module: &'a str,
    pub(crate) parameter: crate::ast::PatternId,
    pub(crate) body: crate::ast::ExpressionId,
    pub(crate) name: String,
    pub(crate) self_name: Option<&'a str>,
    pub(crate) environment: &'a Environment,
    pub(crate) signature: Option<&'a Value>,
    pub(crate) reuse: bool,
    pub(crate) root_application: bool,
    pub(crate) crosses_development_boundary: bool,
}

#[derive(Clone, Copy)]
struct LexicalClosure<'a> {
    module: &'a str,
    parameter: crate::ast::PatternId,
    body: crate::ast::ExpressionId,
    environment: &'a Environment,
    self_name: Option<&'a str>,
}

pub(crate) struct ResidualFunctionCompilation {
    pub(crate) argument: Value,
    pub(crate) environment: Environment,
    function: usize,
    signature: usize,
    result_type: usize,
    result_ownership: Produced,
    caller_arguments: Vec<usize>,
    pub(crate) name: String,
    reuse: bool,
    span: crate::ast::Span,
    source_span: crate::ast::Span,
}

#[derive(Clone, Copy)]
struct SimdLayout {
    element: &'static str,
    lanes: u8,
    vector_name: &'static str,
    mask: bool,
}

impl SimdLayout {
    fn key(self) -> String {
        let kind = if self.mask { "mask" } else { "vector" };
        format!("{kind}:{}", self.vector_name)
    }

    fn runtime_type(self) -> RuntimeType {
        if self.mask {
            return RuntimeType::Mask {
                element: self.element,
                lanes: self.lanes,
            };
        }
        RuntimeType::Vector {
            element: self.element,
            lanes: self.lanes,
        }
    }
}

fn simd_layout(name: &str) -> Option<SimdLayout> {
    let (element, lanes, vector_name, mask) = match name {
        "F32x4" => ("float-32", 4, "f32x4", false),
        "F32x4Mask" => ("float-32", 4, "f32x4", true),
        "I32x4" => ("integer-32", 4, "I32x4", false),
        "I32x4Mask" => ("integer-32", 4, "I32x4", true),
        "I16x8" => ("integer-16", 8, "I16x8", false),
        "I16x8Mask" => ("integer-16", 8, "I16x8", true),
        "I8x16" => ("integer-8", 16, "I8x16", false),
        "I8x16Mask" => ("integer-8", 16, "I8x16", true),
        _ => return None,
    };
    Some(SimdLayout {
        element,
        lanes,
        vector_name,
        mask,
    })
}

struct ResidualBlock {
    id: usize,
    parameters: Vec<RuntimeBlockParameter>,
    operations: Vec<RuntimeOperation>,
    terminator: Option<RuntimeTerminator>,
}

pub(crate) struct ResidualReuseScope {
    operation_counts: Vec<usize>,
}

pub(crate) struct ResidualBranches {
    pub(crate) consequent: usize,
    pub(crate) alternate: usize,
    pub(crate) join: usize,
}

#[derive(Clone)]
pub(crate) struct ResidualSwitch {
    pub(crate) arms: Vec<usize>,
    pub(crate) fallback: usize,
    join: usize,
}

#[derive(Clone, Copy)]
enum StoreRangeDestination {
    Fresh,
    Shared,
}

impl StoreRangeDestination {
    fn update(self) -> &'static str {
        match self {
            Self::Fresh => "owned-reuse",
            Self::Shared => "persistent",
        }
    }
}

impl ResidualTrace {
    pub(crate) fn crosses_development_boundary(&self, caller: &str, callee: &str) -> bool {
        caller != callee
            && self
                .development_units
                .as_ref()
                .is_some_and(|units| units.contains(callee))
    }

    pub(crate) fn begin_reuse_scope(&self) -> ResidualReuseScope {
        ResidualReuseScope {
            operation_counts: self
                .blocks
                .iter()
                .map(|block| block.operations.len())
                .collect(),
        }
    }

    pub(crate) fn finish_reuse_scope(
        &self,
        scope: ResidualReuseScope,
        span: crate::ast::Span,
    ) -> Result<(), Diagnostic> {
        for (block_index, block) in self.blocks.iter().enumerate() {
            let start = scope
                .operation_counts
                .get(block_index)
                .copied()
                .unwrap_or(0);
            for operation in block.operations.iter().skip(start) {
                if matches!(operation.kind, "store.write" | "store.grow")
                    && operation.update != Some("owned-reuse")
                {
                    return Err(Diagnostic::new(
                        "BLOT_REUSE_NOT_PROVED",
                        format!(
                            "`@[assert.reuse]` found a persistent {}. Hand off an owned Array, add `Array.copy` at the shared boundary, or remove the assertion.",
                            operation.kind
                        ),
                        span,
                    ));
                }
            }
        }
        Ok(())
    }

    pub(crate) fn new(source: &str) -> Self {
        Self::with_development_units(source, None)
    }

    pub(crate) fn development(source: &str, units: Rc<HashSet<String>>) -> Self {
        Self::with_development_units(source, Some(units))
    }

    fn with_development_units(
        source: &str,
        development_units: Option<Rc<HashSet<String>>>,
    ) -> Self {
        let mut trace = Self {
            source: source.to_owned(),
            development_units,
            types: Vec::new(),
            type_ids: HashMap::new(),
            signatures: Vec::new(),
            capabilities: BTreeMap::new(),
            blocks: Vec::new(),
            current_block: 0,
            next_value: 0,
            active_primitive: None,
            functions: BTreeMap::new(),
            function_ids: Vec::new(),
            pending_recursive_types: HashSet::new(),
            settled_recursive_types: HashSet::new(),
            recursive_result_ids: Vec::new(),
            exports: Vec::new(),
            export_effects: BTreeSet::new(),
            root_function: 0,
            next_function: 1,
            function_frames: Vec::new(),
            checked_aggregate_representations: CheckedAggregateRepresentations::default(),
        };
        trace.insert_type("unit", RuntimeType::Unit);
        trace.insert_type("boolean", RuntimeType::Boolean);
        trace.insert_type("integer-32", RuntimeType::Integer32);
        trace.insert_type("text", RuntimeType::Text);
        trace.block();
        trace
    }

    pub(crate) fn host_call(
        &mut self,
        capability: String,
        operation: String,
        argument: &Value,
        result_type: &Value,
        operation_ownership: &EffectOperationOwnership,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        self.export_effects.insert(capability.clone());
        let argument = self.lower_value(argument, span)?;
        let result_type = self
            .type_from_type_value(result_type)
            .map_err(|mut diagnostic| {
                diagnostic.message = format!(
                    "{} Host operation `{capability}.{operation}` result signature: {}.",
                    diagnostic.message,
                    crate::value::show(result_type)
                );
                diagnostic
            })?;
        let parameter_type = argument.type_id;
        let ownership_contract = runtime_operation_ownership(operation_ownership);
        let operations = self.capabilities.entry(capability.clone()).or_default();
        if let Some((existing, existing_ownership)) = operations.get(&operation) {
            let declared = &self.signatures[*existing];
            if declared.parameters != [parameter_type]
                || declared.result != result_type
                || existing_ownership != &ownership_contract
            {
                return Err(hir_error(&format!(
                    "Host operation `{capability}.{operation}` was used with incompatible signatures or ownership contracts."
                )));
            }
        } else {
            let signature = self.signatures.len();
            self.signatures.push(RuntimeSignature {
                parameters: vec![parameter_type],
                result: result_type,
                effects: vec![capability.clone()],
            });
            operations.insert(operation.clone(), (signature, ownership_contract));
        }
        let result = self.next_value();
        let ownership = self.ownership(result_type);
        let operation_signature = self.capabilities[&capability]
            .get(&operation)
            .expect("inserted host operation")
            .0;
        let _ = operation_signature;
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "host.call",
            result,
            type_id: result_type,
            operands: vec![argument.id],
            ownership,
            span: runtime_span,
            value: None,
            update: None,
            case: None,
            capability: Some(capability),
            operation: Some(operation),
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        if matches!(self.types[result_type], RuntimeType::Unit) {
            return Ok(Value::Unit);
        }
        self.symbolic_value(
            RuntimeValue {
                id: result,
                type_id: result_type,
                meaning: RuntimeMeaning::Plain,
            },
            span,
        )
    }

    pub(crate) fn record_checked_aggregate_representation(&mut self, value: &Value, type_: &Value) {
        if !matches!(value, Value::Array(_) | Value::Shape(_)) {
            return;
        }
        if let Ok(type_id) = self.type_from_type_value(type_) {
            self.checked_aggregate_representations
                .record(value, type_id);
        }
    }

    pub(crate) fn export_parameter(
        &mut self,
        type_: &Type,
        span: crate::ast::Span,
    ) -> Result<(Value, usize), Diagnostic> {
        let type_id = self.runtime_type_from_checked_type(type_)?;
        let parameter = self.next_value();
        let ownership = self.ownership(type_id);
        let runtime_span = self.span(span);
        // An export's parameters are the entry block's parameters, whatever
        // block the trace is standing in. A curried export applies one argument
        // at a time, and applying an earlier one can leave the trace inside a
        // branch — a defunctionalized function choice does exactly that.
        self.blocks[0].parameters.push(RuntimeBlockParameter {
            value: parameter,
            type_id,
            ownership,
            span: runtime_span,
        });
        if matches!(self.types[type_id], RuntimeType::Unit) {
            return Ok((Value::Unit, type_id));
        }
        let value = self.symbolic_value(
            RuntimeValue {
                id: parameter,
                type_id,
                meaning: RuntimeMeaning::Plain,
            },
            span,
        )?;
        Ok((value, type_id))
    }

    pub(crate) fn finish_function_export(
        &mut self,
        name: String,
        value: Value,
        parameter_types: Vec<usize>,
        result_type: &Type,
        reuse: bool,
        function_span: RuntimeSpan,
    ) -> Result<(), Diagnostic> {
        let result = self.lower_value(&value, crate::ast::Span { start: 0, end: 0 })?;
        let expected = self.runtime_type_from_checked_type(result_type)?;
        if result.type_id != expected {
            return Err(hir_error(
                "A function export result does not match its checked type.",
            ));
        }
        let end = self.current_block;
        self.blocks[end].terminator = Some(RuntimeTerminator::Return {
            value: result.id,
            span: self.span(crate::ast::Span { start: 0, end: 0 }),
        });
        let effects = self.export_effects.iter().cloned().collect::<Vec<_>>();
        let signature = self.signatures.len();
        self.signatures.push(RuntimeSignature {
            parameters: parameter_types,
            result: expected,
            effects,
        });
        let blocks = self.take_blocks()?;
        self.functions.insert(
            self.root_function,
            simplify_runtime_function(RuntimeFunction {
                id: self.root_function,
                name: format!("blot$residual${name}"),
                signature,
                reuse: reuse.then_some("checked"),
                entry_block: 0,
                blocks,
                span: function_span,
            }),
        );
        self.exports.push(RuntimeExport::Runtime {
            source_name: name.clone(),
            phase: "runtime",
            wasm_name: format!("blot:{name}"),
            function: self.root_function,
            signature,
            ownership: "owned",
        });
        Ok(())
    }

    pub(crate) fn begin_function_export(&mut self) -> Result<(), Diagnostic> {
        if !self.blocks.is_empty() || !self.function_frames.is_empty() {
            return Err(hir_error(
                "A residual export started while the previous function was still active.",
            ));
        }
        self.root_function = self.next_function;
        self.next_function += 1;
        self.current_block = 0;
        self.next_value = 0;
        self.export_effects.clear();
        self.block();
        Ok(())
    }

    pub(crate) fn finish_module(mut self) -> Result<RuntimeModule, Diagnostic> {
        let capabilities = std::mem::take(&mut self.capabilities)
            .into_iter()
            .map(|(name, operations)| RuntimeCapability {
                name,
                operations: operations
                    .into_iter()
                    .map(
                        |(name, (signature, ownership))| RuntimeCapabilityOperation {
                            name,
                            signature,
                            ownership,
                        },
                    )
                    .collect(),
            })
            .collect();
        validate_runtime_layouts(&self.types)?;
        Ok(RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: self.source,
            types: self.types,
            signatures: self.signatures,
            static_stores: Vec::new(),
            functions: self.functions.into_values().collect(),
            capabilities,
            links: Vec::new(),
            exports: self.exports,
        })
    }

    pub(crate) fn primitive(
        &mut self,
        name: &str,
        arguments: &[Value],
        checked_arguments: &[Option<Value>],
        expected_result: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<Option<Value>, Diagnostic> {
        // Scratch is an operational builder even when its capacity stages to
        // a constant. In a residual trace its element representation comes
        // from the surrounding signature or the first push, so do not let the
        // evaluator turn an empty builder back into an untyped source value.
        if name != "@scratch.with_capacity" && !arguments.iter().any(contains_runtime) {
            return Ok(None);
        }
        self.active_primitive = Some(name.to_owned());
        if name == "@assert.reuse" {
            let mut value = arguments
                .first()
                .cloned()
                .ok_or_else(|| hir_error("A reuse assertion omitted its function."))?;
            let Value::Closure {
                reuse_assertion, ..
            } = &mut value
            else {
                return Err(Diagnostic::new(
                    "BLOT_REUSE_ASSERTION_NOT_FUNCTION",
                    "`@[assert.reuse]` can annotate only a function declaration.",
                    span,
                ));
            };
            *reuse_assertion = Some(span);
            return Ok(Some(value));
        }
        if matches!(name, "@linear.own" | "@linear.maybe") {
            let mut value = arguments
                .first()
                .cloned()
                .ok_or_else(|| hir_error("An ownership marker omitted its value."))?;
            if let Value::Runtime(runtime) = &mut value
                && !matches!(runtime.meaning, RuntimeMeaning::SharedStore)
                && matches!(self.types[runtime.type_id], RuntimeType::Store { .. })
            {
                runtime.meaning = RuntimeMeaning::ReusableStore;
            }
            return Ok(Some(value));
        }
        if matches!(
            name,
            "@linear.borrow" | "@linear.freeze" | "@branch.likely" | "@branch.unlikely"
        ) {
            let mut value = arguments
                .first()
                .cloned()
                .ok_or_else(|| hir_error("A runtime marker omitted its value."))?;
            if matches!(name, "@linear.borrow" | "@linear.freeze")
                && let Value::Runtime(runtime) = &mut value
                && matches!(self.types[runtime.type_id], RuntimeType::Store { .. })
            {
                runtime.meaning = RuntimeMeaning::SharedStore;
            }
            return Ok(Some(value));
        }
        if matches!(
            name,
            "@satisfies"
                | "@type.seal"
                | "@type.open"
                | "@type.attach"
                | "@shape.get"
                | "@shape.remove"
                | "@shape.names"
                | "@shape.has"
        ) {
            return crate::primitives::run_primitive(
                name,
                arguments.to_vec(),
                crate::ast::Span {
                    start: span.start,
                    end: span.end,
                },
                Phase::Runtime,
            )
            .map(Some);
        }
        if name.starts_with("@i32x4.") || name.starts_with("@i16x8.") || name.starts_with("@i8x16.")
        {
            return self.integer_simd_primitive(name, arguments, span).map(Some);
        }
        if name.starts_with("@f32x4.") {
            return self.float_simd_primitive(name, arguments, span).map(Some);
        }
        let value = match name {
            "@scratch.with_capacity" => {
                let capacity = arguments
                    .first()
                    .cloned()
                    .ok_or_else(|| hir_error("Scratch.with_capacity omitted its capacity."))?;
                let Some(Value::ScratchType(element)) = expected_result else {
                    return Ok(Some(Value::DeferredScratch {
                        capacity: Box::new(capacity),
                    }));
                };
                let Ok(element_type) = self.type_from_type_value(element) else {
                    return Ok(Some(Value::DeferredScratch {
                        capacity: Box::new(capacity),
                    }));
                };
                let capacity = self.lower_as(Some(&capacity), "signed-integer-64", span)?;
                let scratch_type = self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                );
                self.operation(
                    "scratch.with-capacity",
                    scratch_type,
                    vec![capacity.id],
                    span,
                    None,
                )
            }
            "@scratch.push" => {
                let empty_capacity = match &arguments[0] {
                    Value::DeferredScratch { capacity } => Some(capacity.as_ref().clone()),
                    Value::Scratch { values, capacity } if values.is_empty() => {
                        Some(Value::Int((*capacity).into()))
                    }
                    _ => None,
                };
                if let Some(capacity) = empty_capacity {
                    let element_type = self.value_type(&arguments[1])?;
                    let capacity = self.lower_as(Some(&capacity), "signed-integer-64", span)?;
                    let scratch_type = self.insert_type(
                        &format!("scratch:{element_type}"),
                        RuntimeType::Scratch { element_type },
                    );
                    let scratch = self.operation(
                        "scratch.with-capacity",
                        scratch_type,
                        vec![capacity.id],
                        span,
                        None,
                    );
                    let value = self.lower_store_element(&arguments[1], element_type, span)?;
                    return Ok(Some(Value::Runtime(self.operation(
                        "scratch.push",
                        scratch_type,
                        vec![scratch.id, value.id],
                        span,
                        None,
                    ))));
                }
                let scratch = self.lower_value(&arguments[0], span)?;
                let RuntimeType::Scratch { element_type } = self.types[scratch.type_id] else {
                    return Err(hir_error("Scratch.push received a non-Scratch value."));
                };
                let value = self.lower_store_element(&arguments[1], element_type, span)?;
                self.operation(
                    "scratch.push",
                    scratch.type_id,
                    vec![scratch.id, value.id],
                    span,
                    None,
                )
            }
            "@scratch.finish" => {
                let empty_capacity = match &arguments[0] {
                    Value::DeferredScratch { capacity } => Some(capacity.as_ref().clone()),
                    Value::Scratch { values, capacity } if values.is_empty() => {
                        Some(Value::Int((*capacity).into()))
                    }
                    _ => None,
                };
                if let Some(capacity) = empty_capacity {
                    let Some(expected_result) = expected_result else {
                        return Err(hir_error(
                            "An empty residual Scratch needs a specialized Array result.",
                        ));
                    };
                    let mut expected_result = expected_result;
                    while let Value::Forall { body, .. } = expected_result {
                        expected_result = body;
                    }
                    let Value::Array(elements) = expected_result else {
                        return Err(hir_error(&format!(
                            "An empty residual Scratch cannot finish as {}.",
                            crate::value::show(expected_result)
                        )));
                    };
                    let element = elements.first().ok_or_else(|| {
                        hir_error("A specialized Array result omitted its element type.")
                    })?;
                    let element_type = self.type_from_type_value(element)?;
                    let capacity = self.lower_as(Some(&capacity), "signed-integer-64", span)?;
                    let scratch_type = self.insert_type(
                        &format!("scratch:{element_type}"),
                        RuntimeType::Scratch { element_type },
                    );
                    let scratch = self.operation(
                        "scratch.with-capacity",
                        scratch_type,
                        vec![capacity.id],
                        span,
                        None,
                    );
                    let store_type = self.insert_type(
                        &format!("store:{element_type}"),
                        RuntimeType::Store { element_type },
                    );
                    return Ok(Some(Value::Runtime(self.operation(
                        "scratch.finish",
                        store_type,
                        vec![scratch.id],
                        span,
                        None,
                    ))));
                }
                let scratch = self.lower_value(&arguments[0], span)?;
                let RuntimeType::Scratch { element_type } = self.types[scratch.type_id] else {
                    return Err(hir_error("Scratch.finish received a non-Scratch value."));
                };
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                self.operation("scratch.finish", store_type, vec![scratch.id], span, None)
            }
            "@scratch.recycle" => {
                let store = self.lower_value(&arguments[0], span)?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Scratch.recycle received a non-Array value."));
                };
                let scratch_type = self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                );
                self.operation("scratch.recycle", scratch_type, vec![store.id], span, None)
            }
            "@float.of_int" => {
                let value = self.lower_as(arguments.first(), "signed-integer-64", span)?;
                let float = self.insert_type("float-64", RuntimeType::Float64);
                self.convert_operation("signed-integer-64-to-float-64", float, value.id, span)
            }
            "@f32.of_float" => {
                let value = self.lower_as(arguments.first(), "float-64", span)?;
                let float = self.insert_type("float-32", RuntimeType::Float32);
                self.convert_operation("float-64-to-float-32", float, value.id, span)
            }
            "@f32.of_int" => {
                let value = self.lower_as(arguments.first(), "signed-integer-64", span)?;
                let float = self.insert_type("float-32", RuntimeType::Float32);
                self.convert_operation("signed-integer-64-to-float-32", float, value.id, span)
            }
            "@float.of_f32" => {
                let value = self.lower_as(arguments.first(), "float-32", span)?;
                let float = self.insert_type("float-64", RuntimeType::Float64);
                self.convert_operation("float-32-to-float-64", float, value.id, span)
            }
            "@int.of_float" => {
                let value = self.lower_as(arguments.first(), "float-64", span)?;
                let integer = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
                self.convert_operation("float-64-to-signed-integer-64", integer, value.id, span)
            }
            "@float.add" | "@float.sub" | "@float.mul" | "@float.div" | "@float.rem"
            | "@f32.add" | "@f32.sub" | "@f32.mul" | "@f32.div" => {
                let expected = if name.starts_with("@f32.") {
                    "float-32"
                } else {
                    "float-64"
                };
                let left = self.lower_as(arguments.first(), expected, span)?;
                let right = self.lower_as(arguments.get(1), expected, span)?;
                let operator = match name.rsplit_once('.').map(|(_, operation)| operation) {
                    Some("add") => "add",
                    Some("sub") => "subtract",
                    Some("mul") => "multiply",
                    Some("div") => "divide",
                    Some("rem") => "remainder",
                    _ => unreachable!("matched float binary primitive"),
                };
                self.operation(
                    "scalar",
                    left.type_id,
                    vec![left.id, right.id],
                    span,
                    Some(operator),
                )
            }
            "@float.neg" | "@f32.neg" => {
                let expected = if name == "@f32.neg" {
                    "float-32"
                } else {
                    "float-64"
                };
                let value = self.lower_as(arguments.first(), expected, span)?;
                self.operation(
                    "scalar.unary",
                    value.type_id,
                    vec![value.id],
                    span,
                    Some("negate"),
                )
            }
            "@f32.sqrt" => {
                let value = self.lower_as(arguments.first(), "float-32", span)?;
                self.operation(
                    "scalar.unary",
                    value.type_id,
                    vec![value.id],
                    span,
                    Some("square-root"),
                )
            }
            "@float.is_nan" | "@f32.is_nan" => {
                let expected = if name == "@f32.is_nan" {
                    "float-32"
                } else {
                    "float-64"
                };
                let value = self.lower_as(arguments.first(), expected, span)?;
                self.operation(
                    "scalar",
                    1,
                    vec![value.id, value.id],
                    span,
                    Some("not-equal"),
                )
            }
            "@float.cmp" | "@f32.cmp" => {
                let expected = if name == "@f32.cmp" {
                    "float-32"
                } else {
                    "float-64"
                };
                let left = self.lower_as(arguments.first(), expected, span)?;
                let right = self.lower_as(arguments.get(1), expected, span)?;
                self.trap_if_nan(left.id, name, span)?;
                self.trap_if_nan(right.id, name, span)?;
                RuntimeValue {
                    id: left.id,
                    type_id: left.type_id,
                    meaning: RuntimeMeaning::ScalarOrdering { right: right.id },
                }
            }
            "@text.concat" => {
                let left = self.lower_as(arguments.first(), "text", span)?;
                let right = self.lower_as(arguments.get(1), "text", span)?;
                self.operation("text.append", 3, vec![left.id, right.id], span, None)
            }
            "@text.join" => {
                let texts = self.lower_value(&arguments[0], span)?;
                let RuntimeType::Store { element_type } = self.types[texts.type_id] else {
                    return Err(hir_error("Text.join received a non-Array value."));
                };
                if element_type != 3 {
                    return Err(hir_error(&format!(
                        "Text.join received Store elements of runtime type {element_type}, expected Text type 3."
                    )));
                }
                self.operation("text.join", 3, vec![texts.id], span, None)
            }
            "@text.len" => {
                let text = self.lower_as(arguments.first(), "text", span)?;
                let integer = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
                self.operation("text.length", integer, vec![text.id], span, None)
            }
            "@text.scalar_at" => {
                let text = self.lower_as(arguments.first(), "text", span)?;
                let index = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                self.operation("text.scalar-at", 3, vec![text.id, index.id], span, None)
            }
            "@text.slice" => {
                let text = self.lower_as(arguments.first(), "text", span)?;
                let start = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                let end = self.lower_as(arguments.get(2), "signed-integer-64", span)?;
                self.operation("text.slice", 3, vec![text.id, start.id, end.id], span, None)
            }
            "@text.find_from" => {
                let text = self.lower_as(arguments.first(), "text", span)?;
                let query = self.lower_as(arguments.get(1), "text", span)?;
                let start = self.lower_as(arguments.get(2), "signed-integer-64", span)?;
                self.operation(
                    "text.find-from",
                    start.type_id,
                    vec![text.id, query.id, start.id],
                    span,
                    None,
                )
            }
            "@text.cmp" => {
                let left = self.lower_as(arguments.first(), "text", span)?;
                let right = self.lower_as(arguments.get(1), "text", span)?;
                let mut result =
                    self.operation("text.compare", 2, vec![left.id, right.id], span, None);
                result.meaning = RuntimeMeaning::Ordering;
                result
            }
            "@text.contains" => {
                let text = self.lower_as(arguments.first(), "text", span)?;
                let query = self.lower_as(arguments.get(1), "text", span)?;
                self.operation("text.contains", 1, vec![text.id, query.id], span, None)
            }
            "@text.of_int" => {
                let value = self.lower_as(arguments.first(), "signed-integer-64", span)?;
                self.operation("text.from-i64", 3, vec![value.id], span, None)
            }
            "@int.cmp" => {
                let left = self.lower_as(arguments.first(), "signed-integer-64", span)?;
                let right = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                RuntimeValue {
                    id: left.id,
                    type_id: left.type_id,
                    meaning: RuntimeMeaning::ScalarOrdering { right: right.id },
                }
            }
            "@int.neg" => {
                let value = self.lower_as(arguments.first(), "signed-integer-64", span)?;
                let zero = self.constant(
                    WireConstant::SignedInteger64("0".to_owned()),
                    value.type_id,
                    span,
                );
                self.operation(
                    "scalar",
                    value.type_id,
                    vec![zero.id, value.id],
                    span,
                    Some("subtract"),
                )
            }
            "@int.add" | "@int.sub" | "@int.mul" | "@int.div" | "@int.rem" => {
                let left = self.lower_as(arguments.first(), "signed-integer-64", span)?;
                let right = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                let operator = match name {
                    "@int.add" => "add",
                    "@int.sub" => "subtract",
                    "@int.mul" => "multiply",
                    "@int.div" => "divide",
                    "@int.rem" => "remainder",
                    _ => unreachable!(),
                };
                self.operation(
                    "scalar",
                    left.type_id,
                    vec![left.id, right.id],
                    span,
                    Some(operator),
                )
            }
            "@region.copy" if arguments.len() == 1 => {
                let original = &arguments[0];
                let lowered = self.lower_value(original, span)?;
                if !matches!(self.types[lowered.type_id], RuntimeType::Store { .. }) {
                    return Err(hir_error("Region copy lowered a non-Store array."));
                }
                let store = if matches!(original, Value::Array(_))
                    || matches!(lowered.meaning, RuntimeMeaning::ReusableStore)
                {
                    RuntimeValue {
                        meaning: RuntimeMeaning::Plain,
                        ..lowered
                    }
                } else {
                    self.private_store_copy(lowered, span)?
                };
                let integer = self.region_integer_type();
                let length = self.operation("store.length", integer, vec![store.id], span, None);
                let zero =
                    self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
                self.make_region(store, zero, length, span)?
            }
            "@region.length" if arguments.len() == 1 => {
                let (_, start, end) = self.lower_region(&arguments[0], span)?;
                let integer = self.region_integer_type();
                self.operation(
                    "scalar",
                    integer,
                    vec![end.id, start.id],
                    span,
                    Some("subtract"),
                )
            }
            "@region.get" if arguments.len() == 2 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                self.region_get(store, start, end, index, span)?
            }
            "@region.set" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Region Store projection lost its Store type."));
                };
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let value = self.lower_store_element(&arguments[2], element_type, span)?;
                self.region_set(store, start, end, index, value, span)?
            }
            "@region.replace" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Region Store projection lost its Store type."));
                };
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let value = self.lower_store_element(&arguments[2], element_type, span)?;
                self.region_replace(store, start, end, index, value, span)?
            }
            "@region.swap" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let left = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let right = self.lower_as(Some(&arguments[2]), "signed-integer-64", span)?;
                self.region_swap(store, start, end, left, right, span)?
            }
            "@region.split" if arguments.len() == 2 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let offset = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                self.split_region(store, start, end, offset, span)?
            }
            "@region.join" if arguments.len() == 3 => {
                // The witness is erased at runtime: ownership proved the
                // pairing before destructive HIR is emitted, so the runtime
                // join is metadata reassembly and the witness lowers to unit.
                self.lower_value(&arguments[0], span)?;
                let (left_store, left_start, _) = self.lower_region(&arguments[1], span)?;
                let (_, _, right_end) = self.lower_region(&arguments[2], span)?;
                self.make_region(left_store, left_start, right_end, span)?
            }
            "@region.reassociate_left" | "@region.reassociate_right" if arguments.len() == 2 => {
                self.lower_value(&arguments[0], span)?;
                self.lower_value(&arguments[1], span)?;
                let pair_type = self.insert_product_type(vec![
                    RuntimeField {
                        name: "0".to_owned(),
                        type_id: 0,
                    },
                    RuntimeField {
                        name: "1".to_owned(),
                        type_id: 0,
                    },
                ]);
                let first = self.constant(WireConstant::Unit, 0, span);
                let second = self.constant(WireConstant::Unit, 0, span);
                self.operation(
                    "product.make",
                    pair_type,
                    vec![first.id, second.id],
                    span,
                    None,
                )
            }
            "@region.freeze" if arguments.len() == 1 => {
                let (store, _, _) = self.lower_region(&arguments[0], span)?;
                RuntimeValue {
                    meaning: RuntimeMeaning::Plain,
                    ..store
                }
            }
            "@array.take" if arguments.len() == 2 => {
                let store = self.lower_value(&arguments[0], span)?;
                let index = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                let taken = self.array_take(store, index, span)?;
                return self.symbolic_value(taken, span).map(Some);
            }
            "@array.split" if arguments.len() == 2 => {
                let store = self.lower_value(&arguments[0], span)?;
                let index = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                let split = self.array_split(store, index, span)?;
                return self.symbolic_value(split, span).map(Some);
            }
            "@array.len" => {
                let store = self.lower_primitive_argument(
                    &arguments[0],
                    checked_arguments.first().and_then(Option::as_ref),
                    span,
                )?;
                if !matches!(self.types[store.type_id], RuntimeType::Store { .. }) {
                    return Err(hir_error(
                        "Dynamic array length received a non-array value.",
                    ));
                }
                let integer = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
                self.array_operation("store.length", integer, vec![store.id], span, None)
            }
            "@array.copy" => {
                let original = &arguments[0];
                let lowered = self.lower_primitive_argument(
                    original,
                    checked_arguments.first().and_then(Option::as_ref),
                    span,
                )?;
                if !matches!(self.types[lowered.type_id], RuntimeType::Store { .. }) {
                    return Err(hir_error("Array copy lowered a non-Store value."));
                }
                let mut copied = if matches!(original, Value::Array(_))
                    || matches!(lowered.meaning, RuntimeMeaning::ReusableStore)
                {
                    lowered
                } else {
                    self.private_store_copy(lowered, span)?
                };
                copied.meaning = RuntimeMeaning::ReusableStore;
                return self.symbolic_value(copied, span).map(Some);
            }
            "@array.get" => {
                let store = if let Some(expected_element) = expected_result
                    && let Ok(element_type) = self.type_from_type_value(expected_element)
                {
                    let store_type = self.insert_type(
                        &format!("store:{element_type}"),
                        RuntimeType::Store { element_type },
                    );
                    self.lower_value_as(&arguments[0], store_type, span)?
                } else {
                    self.lower_primitive_argument(
                        &arguments[0],
                        checked_arguments.first().and_then(Option::as_ref),
                        span,
                    )?
                };
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error(
                        "Dynamic array access received a non-array value.",
                    ));
                };
                let index = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                let value = self.array_operation(
                    "store.read",
                    element_type,
                    vec![store.id, index.id],
                    span,
                    None,
                );
                return self.symbolic_value(value, span).map(Some);
            }
            "@array.set" => {
                let update = if matches!(
                    arguments.first(),
                    Some(Value::Runtime(RuntimeValue {
                        meaning: RuntimeMeaning::ReusableStore,
                        ..
                    }))
                ) {
                    "owned-reuse"
                } else {
                    "persistent"
                };
                let store = self.lower_primitive_argument(
                    &arguments[0],
                    checked_arguments.first().and_then(Option::as_ref),
                    span,
                )?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error(
                        "Dynamic array update received a non-array value.",
                    ));
                };
                let index = self.lower_as(arguments.get(1), "signed-integer-64", span)?;
                let value = self.lower_store_element(&arguments[2], element_type, span)?;
                let mut result = self.array_operation(
                    "store.write",
                    store.type_id,
                    vec![store.id, index.id, value.id],
                    span,
                    Some(update),
                );
                result.meaning = RuntimeMeaning::ReusableStore;
                result
            }
            "@array.push" => {
                let update = if matches!(
                    arguments.first(),
                    Some(Value::Runtime(RuntimeValue {
                        meaning: RuntimeMeaning::ReusableStore,
                        ..
                    }))
                ) {
                    "owned-reuse"
                } else {
                    "persistent"
                };
                let store = self.lower_primitive_argument(
                    &arguments[0],
                    checked_arguments.first().and_then(Option::as_ref),
                    span,
                )?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Dynamic array push received a non-array value."));
                };
                let value = self.lower_store_element(&arguments[1], element_type, span)?;
                let mut result = self.array_operation(
                    "store.grow",
                    store.type_id,
                    vec![store.id, value.id],
                    span,
                    Some(update),
                );
                result.meaning = RuntimeMeaning::ReusableStore;
                result
            }
            _ => {
                return Err(Diagnostic::new(
                    "BLOT_UNSUPPORTED_LOWERING",
                    format!(
                        "The dynamic primitive `{name}` is outside the Rust residual calculus."
                    ),
                    span,
                ));
            }
        };
        Ok(Some(Value::Runtime(value)))
    }

    fn float_simd_primitive(
        &mut self,
        name: &str,
        arguments: &[Value],
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let vector_type = self.insert_type(
            "vector:f32x4",
            RuntimeType::Vector {
                element: "float-32",
                lanes: 4,
            },
        );
        let mask_type = self.insert_type(
            "mask:f32x4",
            RuntimeType::Mask {
                element: "float-32",
                lanes: 4,
            },
        );
        let operation = name
            .strip_prefix("@f32x4.")
            .ok_or_else(|| hir_error("Invalid F32x4 primitive name."))?;
        if operation == "of" {
            let operands = arguments
                .iter()
                .map(|argument| {
                    self.lower_as(Some(argument), "float-32", span)
                        .map(|value| value.id)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let value = self.simd_operation("make", vector_type, operands, span, None);
            return self.symbolic_value(value, span);
        }
        if operation == "splat" {
            let value = self.lower_as(arguments.first(), "float-32", span)?;
            let value = self.simd_operation("splat", vector_type, vec![value.id], span, None);
            return self.symbolic_value(value, span);
        }
        if operation == "shuffle" {
            let left = self.lower_value(&arguments[0], span)?;
            let right = self.lower_value(&arguments[1], span)?;
            let mut operands = vec![left.id, right.id];
            for selector in &arguments[2..] {
                let Value::Int(selector) = selector else {
                    return Err(hir_error("A SIMD shuffle selector is not an integer."));
                };
                let selector = u8::try_from(selector.clone())
                    .map_err(|_| hir_error("A SIMD shuffle selector is outside 0..7."))?;
                if selector > 7 {
                    return Err(hir_error("A SIMD shuffle selector is outside 0..7."));
                }
                operands.push(
                    self.constant(WireConstant::SignedInteger32(i32::from(selector)), 2, span)
                        .id,
                );
            }
            let value = self.simd_operation("shuffle", vector_type, operands, span, None);
            return self.symbolic_value(value, span);
        }
        if let Some(lane) = ["x", "y", "z", "w"]
            .iter()
            .position(|candidate| candidate == &operation)
        {
            let vector = self.lower_value(&arguments[0], span)?;
            let float = self.insert_type("float-32", RuntimeType::Float32);
            let value = self.simd_operation(
                "extract",
                float,
                vec![vector.id],
                span,
                Some(u8::try_from(lane).expect("F32x4 lane fits u8")),
            );
            return self.symbolic_value(value, span);
        }
        let (operator, result_type) = match operation {
            "add" => ("add", vector_type),
            "sub" => ("subtract", vector_type),
            "mul" => ("multiply", vector_type),
            "div" => ("divide", vector_type),
            "eq" => ("equal", mask_type),
            "less" => ("less-than", mask_type),
            "select" => ("select", vector_type),
            "mask_all" => ("mask-all", 2),
            "mask_any" => ("mask-any", 2),
            "sum" => ("sum", self.insert_type("float-32", RuntimeType::Float32)),
            _ => {
                return Err(Diagnostic::new(
                    "BLOT_UNSUPPORTED_LOWERING",
                    format!("The dynamic primitive `{name}` is outside the Rust SIMD calculus."),
                    span,
                ));
            }
        };
        let operands = arguments
            .iter()
            .map(|argument| self.lower_value(argument, span).map(|value| value.id))
            .collect::<Result<Vec<_>, _>>()?;
        let value = self.simd_operation(operator, result_type, operands, span, None);
        if matches!(operation, "mask_all" | "mask_any") {
            let integer_type = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
            let extended = self.convert_operation(
                "signed-integer-32-to-signed-integer-64",
                integer_type,
                value.id,
                span,
            );
            return self.symbolic_value(extended, span);
        }
        self.symbolic_value(value, span)
    }

    fn integer_simd_primitive(
        &mut self,
        name: &str,
        arguments: &[Value],
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let (prefix, operation) = name
            .strip_prefix('@')
            .and_then(|name| name.split_once('.'))
            .ok_or_else(|| hir_error("Invalid SIMD primitive name."))?;
        let operation = operation.strip_suffix("_wrapping").unwrap_or(operation);
        let (bits, lanes) = match prefix {
            "i32x4" => (32_u8, 4_u8),
            "i16x8" => (16_u8, 8_u8),
            "i8x16" => (8_u8, 16_u8),
            _ => return Err(hir_error("Unknown integer SIMD width.")),
        };
        let vector_key = format!("vector:I{bits}x{lanes}");
        let vector_type = self.insert_type(
            &vector_key,
            RuntimeType::Vector {
                element: match bits {
                    32 => "integer-32",
                    16 => "integer-16",
                    _ => "integer-8",
                },
                lanes,
            },
        );
        let mask_key = format!("mask:I{bits}x{lanes}");
        let mask_type = self.insert_type(
            &mask_key,
            RuntimeType::Mask {
                element: match bits {
                    32 => "integer-32",
                    16 => "integer-16",
                    _ => "integer-8",
                },
                lanes,
            },
        );
        if operation == "of" {
            let operands = arguments
                .iter()
                .map(|argument| self.lower_integer32(argument, span).map(|value| value.id))
                .collect::<Result<Vec<_>, _>>()?;
            let value = self.simd_operation("make", vector_type, operands, span, None);
            return self.symbolic_value(value, span);
        }
        if operation == "splat" {
            let lane = self.lower_integer32(&arguments[0], span)?;
            let value = self.simd_operation("splat", vector_type, vec![lane.id], span, None);
            return self.symbolic_value(value, span);
        }
        if operation == "lane" && prefix == "i32x4" {
            let lane = match &arguments[1] {
                Value::Int(lane) => {
                    u8::try_from(lane.clone()).map_err(|_| hir_error("Invalid SIMD lane."))?
                }
                _ => return Err(hir_error("SIMD lane is not an integer.")),
            };
            if lane > 3 {
                return Err(hir_error("SIMD lane is outside 0..3."));
            }
            let vector = self.lower_value(&arguments[0], span)?;
            let extracted = self.simd_operation("extract", 2, vec![vector.id], span, Some(lane));
            let integer_type = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
            let extended = self.convert_operation(
                "signed-integer-32-to-signed-integer-64",
                integer_type,
                extracted.id,
                span,
            );
            return self.symbolic_value(extended, span);
        }
        if let Some(lane) = operation.strip_prefix("lane") {
            let lane = lane
                .parse::<u8>()
                .map_err(|_| hir_error("Invalid SIMD lane."))?;
            let vector = self.lower_value(&arguments[0], span)?;
            let extracted = self.simd_operation("extract", 2, vec![vector.id], span, Some(lane));
            let integer_type = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
            let extended = self.convert_operation(
                "signed-integer-32-to-signed-integer-64",
                integer_type,
                extracted.id,
                span,
            );
            return self.symbolic_value(extended, span);
        }
        if let Some(lane) = operation.strip_prefix("with_lane") {
            let lane = lane
                .parse::<u8>()
                .map_err(|_| hir_error("Invalid SIMD lane."))?;
            let vector = self.lower_value(&arguments[0], span)?;
            let replacement = self.lower_integer32(&arguments[1], span)?;
            let value = self.simd_operation(
                "replace",
                vector_type,
                vec![vector.id, replacement.id],
                span,
                Some(lane),
            );
            return self.symbolic_value(value, span);
        }
        let operators = [
            ("add", "add"),
            ("sub", "subtract"),
            ("mul", "multiply"),
            ("and", "bit-and"),
            ("or", "bit-or"),
            ("xor", "bit-xor"),
            ("not", "bit-not"),
            ("shl", "shift-left"),
            ("shr_s", "shift-right-signed"),
            ("shr_u", "shift-right-unsigned"),
            ("eq", "equal"),
            ("ne", "not-equal"),
            ("lt_s", "less-than-signed"),
            ("lt_u", "less-than-unsigned"),
            ("gt_s", "greater-than-signed"),
            ("gt_u", "greater-than-unsigned"),
            ("le_s", "less-than-or-equal-signed"),
            ("le_u", "less-than-or-equal-unsigned"),
            ("ge_s", "greater-than-or-equal-signed"),
            ("ge_u", "greater-than-or-equal-unsigned"),
            ("min_s", "minimum-signed"),
            ("min_u", "minimum-unsigned"),
            ("max_s", "maximum-signed"),
            ("max_u", "maximum-unsigned"),
            ("select", "select"),
            ("mask_bitmask", "mask-bitmask"),
            ("mask_all", "mask-all"),
            ("mask_any", "mask-any"),
        ];
        let operator = operators
            .iter()
            .find_map(|(source, target)| (*source == operation).then_some(*target))
            .ok_or_else(|| hir_error(&format!("Unsupported integer SIMD primitive {name}.")))?;
        let mut operands = Vec::new();
        for (index, argument) in arguments.iter().enumerate() {
            if index == 1 && matches!(operation, "shl" | "shr_s" | "shr_u") {
                operands.push(self.lower_integer32(argument, span)?.id);
            } else {
                operands.push(self.lower_value(argument, span)?.id);
            }
        }
        let comparison = matches!(
            operation,
            "eq" | "ne" | "lt_s" | "lt_u" | "gt_s" | "gt_u" | "le_s" | "le_u" | "ge_s" | "ge_u"
        );
        let reduction = operation.starts_with("mask_");
        let result_type = if reduction {
            2
        } else if comparison {
            mask_type
        } else {
            vector_type
        };
        let result = self.simd_operation(operator, result_type, operands, span, None);
        let result = if reduction {
            let integer_type = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
            self.convert_operation(
                "signed-integer-32-to-signed-integer-64",
                integer_type,
                result.id,
                span,
            )
        } else {
            result
        };
        self.symbolic_value(result, span)
    }

    fn trap_if_nan(
        &mut self,
        value: usize,
        operation: &str,
        span: crate::ast::Span,
    ) -> Result<(), Diagnostic> {
        let unordered = self.operation("scalar", 1, vec![value, value], span, Some("not-equal"));
        let branches = self.begin_conditional(&unordered, span)?;
        self.select_block(branches.consequent);
        self.trap_current_block(
            &format!("{operation} cannot order NaN. Test for it before comparing."),
            span,
        );
        self.select_block(branches.alternate);
        let ordered_end = self.current_block();
        self.join_survivor(&branches, ordered_end, span);
        Ok(())
    }

    pub(crate) fn ordering_boolean(
        &mut self,
        target: &RuntimeValue,
        true_signs: &[i8],
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        if true_signs.is_empty() || true_signs.len() == 3 {
            return Ok(crate::value::boolean(true_signs.len() == 3));
        }
        let (right, operand_type) = match target.meaning {
            RuntimeMeaning::Ordering => {
                let zero = self.constant(WireConstant::SignedInteger32(0), 2, span);
                (zero.id, 2)
            }
            RuntimeMeaning::ScalarOrdering { right } => (right, target.type_id),
            _ => {
                return Err(Diagnostic::new(
                    "BLOT_UNSUPPORTED_LOWERING",
                    "A dynamic case target is not an ordering value.",
                    span,
                ));
            }
        };
        let operator = if true_signs.len() == 1 {
            match true_signs[0] {
                -1 => "less-than",
                0 => "equal",
                1 => "greater-than",
                _ => unreachable!(),
            }
        } else if !true_signs.contains(&-1) {
            "greater-than-or-equal"
        } else if !true_signs.contains(&0) {
            "not-equal"
        } else {
            "less-than-or-equal"
        };
        let _ = operand_type;
        Ok(Value::Runtime(self.operation(
            "scalar",
            1,
            vec![target.id, right],
            span,
            Some(operator),
        )))
    }

    pub(crate) fn is_integer(&self, value: &RuntimeValue) -> bool {
        matches!(self.types[value.type_id], RuntimeType::SignedInteger64)
    }

    pub(crate) fn is_boolean(&self, value: &RuntimeValue) -> bool {
        matches!(self.types[value.type_id], RuntimeType::Boolean)
    }

    pub(crate) fn sum_cases(&self, value: &RuntimeValue) -> Option<Vec<String>> {
        let (_, cases) = self.sum_representation(value.type_id)?;
        Some(cases.iter().map(|case_| case_.name.clone()).collect())
    }

    fn sum_representation(&self, type_id: usize) -> Option<(usize, &[RuntimeCase])> {
        let representation = match self.types.get(type_id)? {
            RuntimeType::Indirect { target_type } => *target_type,
            RuntimeType::Sum { .. } => type_id,
            _ => return None,
        };
        let RuntimeType::Sum { cases, .. } = self.types.get(representation)? else {
            return None;
        };
        Some((representation, cases))
    }

    fn load_indirect(&mut self, target: &RuntimeValue, span: crate::ast::Span) -> RuntimeValue {
        let RuntimeType::Indirect { target_type } = self.types[target.type_id] else {
            return target.clone();
        };
        self.operation("indirect.load", target_type, vec![target.id], span, None)
    }

    pub(crate) fn type_name(&self, value: &RuntimeValue) -> &'static str {
        match self.types[value.type_id] {
            RuntimeType::Unit => "Unit",
            RuntimeType::Boolean => "Bool",
            RuntimeType::Integer32 => "I32",
            RuntimeType::SignedInteger64 => "Int",
            RuntimeType::Float32 => "F32",
            RuntimeType::Float64 => "F64",
            RuntimeType::Text => "Text",
            RuntimeType::Vector { .. } => "Vector",
            RuntimeType::Mask { .. } => "Mask",
            RuntimeType::Store { .. } => "Store",
            RuntimeType::Scratch { .. } => "Scratch",
            RuntimeType::Indirect { .. } => "Recursive",
            RuntimeType::Product { .. } => "Record",
            RuntimeType::Sum { .. } => "Sum",
            RuntimeType::Sealed { .. } => "Sealed",
        }
    }

    fn type_description(&self, value: &RuntimeValue) -> String {
        match &self.types[value.type_id] {
            RuntimeType::Product { fields, .. } => format!(
                "record {{{}}}",
                fields
                    .iter()
                    .map(|field| field.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            _ => self.type_name(value).to_owned(),
        }
    }

    pub(crate) fn begin_conditional(
        &mut self,
        condition: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<ResidualBranches, Diagnostic> {
        if condition.type_id != 1 {
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!(
                    "A dynamic condition must be Boolean, found {}.",
                    self.type_name(condition)
                ),
                span,
            ));
        }
        let source = self.current_block;
        let consequent = self.block();
        let alternate = self.block();
        let join = self.block();
        self.blocks[source].terminator = Some(RuntimeTerminator::Conditional {
            condition: condition.id,
            consequent,
            consequent_arguments: Vec::new(),
            alternate,
            alternate_arguments: Vec::new(),
            span: self.span(span),
        });
        Ok(ResidualBranches {
            consequent,
            alternate,
            join,
        })
    }

    pub(crate) fn begin_switch(
        &mut self,
        selector: &RuntimeValue,
        values: Vec<WireConstant>,
        span: crate::ast::Span,
    ) -> Result<ResidualSwitch, Diagnostic> {
        let selector_is_integer = matches!(
            self.types[selector.type_id],
            RuntimeType::Integer32 | RuntimeType::SignedInteger64
        );
        if !selector_is_integer {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                "A residual switch selector is not an integer.",
                span,
            ));
        }
        let values_match = values.iter().all(|value| {
            matches!(
                (&self.types[selector.type_id], value),
                (RuntimeType::Integer32, WireConstant::SignedInteger32(_))
                    | (
                        RuntimeType::SignedInteger64,
                        WireConstant::SignedInteger64(_)
                    )
            )
        });
        if !values_match {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                "A residual switch case does not match its selector representation.",
                span,
            ));
        }
        if values
            .iter()
            .enumerate()
            .any(|(index, value)| values[..index].contains(value))
        {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                "A residual switch repeats a case value.",
                span,
            ));
        }
        let source = self.current_block;
        let arms = values.iter().map(|_| self.block()).collect::<Vec<_>>();
        let fallback = self.block();
        let join = self.block();
        let cases = values
            .into_iter()
            .zip(&arms)
            .map(|(value, target)| RuntimeSwitchCase {
                value,
                target: *target,
            })
            .collect();
        self.blocks[source].terminator = Some(RuntimeTerminator::Switch {
            selector: selector.id,
            cases,
            fallback,
            span: self.span(span),
        });
        Ok(ResidualSwitch {
            arms,
            fallback,
            join,
        })
    }

    pub(crate) fn join_switch(
        &mut self,
        context: &Rc<Context>,
        switch: ResidualSwitch,
        branches: Vec<(usize, Option<Value>)>,
        checked_result: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let mut survivors = branches
            .into_iter()
            .filter_map(|(end, value)| value.map(|value| (end, value)))
            .collect::<Vec<_>>();
        let Some((_, first)) = survivors.first() else {
            return Err(Diagnostic::new(
                "BLOT_PANIC",
                "Every residual switch arm traps.",
                span,
            ));
        };
        if survivors
            .iter()
            .all(|(_, value)| crate::value::equal(first, value))
        {
            for (end, _) in &survivors {
                self.blocks[*end].terminator = Some(RuntimeTerminator::Branch {
                    target: switch.join,
                    arguments: Vec::new(),
                    span: self.span(span),
                });
            }
            self.current_block = switch.join;
            return Ok(first.clone());
        }
        if survivors.iter().any(|(_, value)| is_function_value(value)) {
            return self.join_function_switch(context, switch, survivors, span);
        }
        let result_reuse = survivors
            .iter()
            .map(|(_, value)| runtime_store_reuse_witness(value, &self.types))
            .reduce(|left, right| merge_store_reuse_witness(&left, &right))
            .unwrap_or(StoreReuseWitness::None);
        let boolean_tags = survivors.iter().all(|(_, value)| {
            matches!(value, Value::Tag { name, payload: None } if name == "True" || name == "False")
        });
        let all_tags = survivors
            .iter()
            .all(|(_, value)| matches!(value, Value::Tag { .. }));
        let checked_result_type = checked_result
            .and_then(|checked_result| self.type_from_type_value(checked_result).ok());
        let mut required_cases = BTreeSet::new();
        let mut required_payloads = BTreeMap::new();
        let mut candidate_sums = Vec::new();
        for (_, value) in &survivors {
            match value {
                Value::Tag { name, payload } => {
                    required_cases.insert(name.clone());
                    let payload_type =
                        self.value_type(&compiler_tag_payload(payload.as_deref()))?;
                    if let Some(known) = required_payloads.get(name) {
                        if *known != payload_type {
                            return Err(Diagnostic::new(
                                "BLOT_RUST_INVARIANT",
                                format!(
                                    "Constructor `#{name}` reached one multi-way join with payload representations {known} and {payload_type}."
                                ),
                                span,
                            ));
                        }
                    } else {
                        required_payloads.insert(name.clone(), payload_type);
                    }
                }
                Value::Runtime(runtime) => {
                    let Some((_, cases)) = self
                        .sum_representation(runtime.type_id)
                        .map(|(type_id, cases)| (type_id, cases.to_vec()))
                    else {
                        continue;
                    };
                    required_cases.extend(cases.iter().map(|case_| case_.name.clone()));
                    for case_ in cases {
                        if let Some(known) = required_payloads.get(&case_.name) {
                            if *known != case_.payload_type {
                                return Err(Diagnostic::new(
                                    "BLOT_RUST_INVARIANT",
                                    format!(
                                        "Constructor `#{}` reached one multi-way join with payload representations {known} and {}.",
                                        case_.name, case_.payload_type
                                    ),
                                    span,
                                ));
                            }
                        } else {
                            required_payloads.insert(case_.name, case_.payload_type);
                        }
                    }
                    if !candidate_sums.contains(&runtime.type_id) {
                        candidate_sums.push(runtime.type_id);
                    }
                }
                _ => {}
            }
        }
        let expected_sum = checked_result_type
            .filter(|type_id| self.sum_representation(*type_id).is_some())
            .or_else(|| {
                candidate_sums.iter().copied().find(|type_id| {
                    self.sum_representation(*type_id).is_some_and(|(_, cases)| {
                        required_cases
                            .iter()
                            .all(|required| cases.iter().any(|case_| case_.name == *required))
                    })
                })
            });
        let expected_sum = match (expected_sum, candidate_sums.is_empty()) {
            (Some(type_id), _) => Some(type_id),
            (None, true) => None,
            (None, false) => {
                let cases = required_payloads.keys().cloned().collect::<Vec<_>>();
                let payloads = required_payloads.values().copied().collect::<Vec<_>>();
                Some(self.sum_type(&cases, &payloads))
            }
        };
        let mut lowered = Vec::new();
        if let Some(expected_sum) = expected_sum {
            for (end, value) in survivors.drain(..) {
                self.current_block = end;
                let value = match value {
                    Value::Tag { .. } => self.lower_sum_member(&value, expected_sum, span)?,
                    Value::Runtime(runtime) => {
                        if runtime.type_id == expected_sum {
                            runtime
                        } else {
                            let (_, cases) = self
                                .sum_representation(runtime.type_id)
                                .map(|(type_id, cases)| (type_id, cases.to_vec()))
                                .ok_or_else(|| {
                                    hir_error("A sum join received a non-sum runtime value.")
                                })?;
                            let [case_] = cases.as_slice() else {
                                return Err(Diagnostic::new(
                                    "BLOT_UNSUPPORTED_LOWERING",
                                    "A multi-way case cannot widen a dynamic sum with more than one possible constructor.",
                                    span,
                                ));
                            };
                            let payload = self.sum_payload(&runtime, 0, span)?;
                            let payload = if matches!(payload, Value::Unit) {
                                None
                            } else {
                                Some(Box::new(payload))
                            };
                            self.lower_sum_member(
                                &Value::Tag {
                                    name: case_.name.clone(),
                                    payload,
                                },
                                expected_sum,
                                span,
                            )?
                        }
                    }
                    value => self.lower_value_as(&value, expected_sum, span)?,
                };
                lowered.push((end, value));
            }
        } else if all_tags && !boolean_tags {
            let mut cases = Vec::new();
            let mut payload_types = Vec::new();
            for (_, value) in &survivors {
                let Value::Tag { name, payload } = value else {
                    unreachable!("all switch results are constructors")
                };
                if cases.contains(name) {
                    continue;
                }
                cases.push(name.clone());
                payload_types.push(self.value_type(&compiler_tag_payload(payload.as_deref()))?);
            }
            let sum_type = self.sum_type(&cases, &payload_types);
            for (end, value) in survivors.drain(..) {
                self.current_block = end;
                lowered.push((end, self.lower_sum_member(&value, sum_type, span)?));
            }
        } else {
            let mut represented_types = BTreeSet::new();
            for (_, value) in &survivors {
                if let Ok(type_id) = self.value_type(value) {
                    represented_types.insert(type_id);
                }
            }
            let expected_type = checked_result_type
                .or_else(|| self.join_runtime_types(represented_types.iter().copied().collect()));
            for (end, value) in survivors.drain(..) {
                self.current_block = end;
                let value = match expected_type {
                    Some(expected_type) => self.lower_value_as(&value, expected_type, span)?,
                    None => self.lower_value(&value, span)?,
                };
                lowered.push((end, value));
            }
        }
        if let Some(indirect_type) = lowered
            .iter()
            .map(|(_, value)| value.type_id)
            .find(|type_id| self.pending_recursive_types.contains(type_id))
        {
            let concrete_types = lowered
                .iter()
                .map(|(_, value)| value.type_id)
                .filter(|type_id| *type_id != indirect_type)
                .collect::<BTreeSet<_>>();
            if concrete_types.len() == 1 {
                let concrete_type = *concrete_types
                    .first()
                    .expect("guarded recursive join representation");
                if self.settle_recursive_type(indirect_type, concrete_type, span)? {
                    for (end, value) in &mut lowered {
                        if value.type_id == indirect_type {
                            continue;
                        }
                        self.current_block = *end;
                        *value = self.box_recursive_result(value.clone(), indirect_type, span)?;
                    }
                }
            }
        }
        let expected_type = lowered[0].1.type_id;
        if let Some((_, incompatible)) = lowered
            .iter()
            .find(|(_, value)| value.type_id != expected_type)
        {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                format!(
                    "A checked multi-way case produced incompatible runtime representations {} and {}; contextual result {} resolved to {:?}.",
                    serde_json::to_string(&self.types[expected_type])
                        .unwrap_or_else(|_| format!("type {expected_type}")),
                    serde_json::to_string(&self.types[incompatible.type_id])
                        .unwrap_or_else(|_| format!("type {}", incompatible.type_id)),
                    checked_result
                        .map(crate::value::show)
                        .unwrap_or_else(|| "<none>".to_owned()),
                    checked_result_type,
                ),
                span,
            ));
        }
        let mut meaning = lowered[0].1.meaning.clone();
        for (_, value) in &lowered[1..] {
            meaning = merge_meaning(&meaning, &value.meaning);
        }
        for (end, value) in &lowered {
            self.blocks[*end].terminator = Some(RuntimeTerminator::Branch {
                target: switch.join,
                arguments: vec![value.id],
                span: self.span(span),
            });
        }
        let joined = self.next_value();
        let ownership = self.ownership(expected_type);
        let runtime_span = self.span(span);
        self.blocks[switch.join]
            .parameters
            .push(RuntimeBlockParameter {
                value: joined,
                type_id: expected_type,
                ownership,
                span: runtime_span,
            });
        self.current_block = switch.join;
        let value = self.symbolic_value(
            RuntimeValue {
                id: joined,
                type_id: expected_type,
                meaning,
            },
            span,
        )?;
        Ok(apply_store_reuse_witness(&result_reuse, value, &self.types))
    }

    fn join_runtime_types(&mut self, types: Vec<usize>) -> Option<usize> {
        let mut types = types.into_iter();
        let mut joined = types.next()?;
        for type_id in types {
            joined = self.join_runtime_type_pair(joined, type_id, &mut HashSet::new())?;
        }
        Some(joined)
    }

    fn join_runtime_type_pair(
        &mut self,
        left: usize,
        right: usize,
        active: &mut HashSet<(usize, usize)>,
    ) -> Option<usize> {
        if left == right {
            return Some(left);
        }
        let pair = if left < right {
            (left, right)
        } else {
            (right, left)
        };
        if !active.insert(pair) {
            return None;
        }
        let left_type = self.types.get(left)?.clone();
        let right_type = self.types.get(right)?.clone();
        let joined = match (left_type, right_type) {
            (
                RuntimeType::Product {
                    fields: left_fields,
                    ..
                },
                RuntimeType::Product {
                    fields: right_fields,
                    ..
                },
            ) if left_fields.len() == right_fields.len() => {
                let mut fields = Vec::with_capacity(left_fields.len());
                for (left_field, right_field) in left_fields.iter().zip(right_fields) {
                    if left_field.name != right_field.name {
                        active.remove(&pair);
                        return None;
                    }
                    fields.push(RuntimeField {
                        name: left_field.name.clone(),
                        type_id: self.join_runtime_type_pair(
                            left_field.type_id,
                            right_field.type_id,
                            active,
                        )?,
                    });
                }
                Some(self.insert_product_type(fields))
            }
            (
                RuntimeType::Sum {
                    cases: left_cases, ..
                },
                RuntimeType::Sum {
                    cases: right_cases, ..
                },
            ) => {
                let mut payloads = BTreeMap::new();
                for case_ in left_cases.into_iter().chain(right_cases) {
                    let payload_type = match payloads.get(&case_.name).copied() {
                        Some(known) => {
                            self.join_runtime_type_pair(known, case_.payload_type, active)?
                        }
                        None => case_.payload_type,
                    };
                    payloads.insert(case_.name, payload_type);
                }
                let cases = payloads.keys().cloned().collect::<Vec<_>>();
                let payload_types = payloads.values().copied().collect::<Vec<_>>();
                Some(self.sum_type(&cases, &payload_types))
            }
            (
                RuntimeType::Store {
                    element_type: left_element,
                },
                RuntimeType::Store {
                    element_type: right_element,
                },
            ) => {
                let element_type =
                    self.join_runtime_type_pair(left_element, right_element, active)?;
                Some(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            (
                RuntimeType::Scratch {
                    element_type: left_element,
                },
                RuntimeType::Scratch {
                    element_type: right_element,
                },
            ) => {
                let element_type =
                    self.join_runtime_type_pair(left_element, right_element, active)?;
                Some(self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                ))
            }
            (
                RuntimeType::Sealed {
                    name: left_name,
                    representation_type: left_representation,
                },
                RuntimeType::Sealed {
                    name: right_name,
                    representation_type: right_representation,
                },
            ) if left_name == right_name => {
                let representation_type =
                    self.join_runtime_type_pair(left_representation, right_representation, active)?;
                Some(self.insert_type(
                    &format!("sealed:{left_name}:{representation_type}"),
                    RuntimeType::Sealed {
                        name: left_name,
                        representation_type,
                    },
                ))
            }
            _ => None,
        };
        active.remove(&pair);
        joined
    }

    fn join_function_switch(
        &mut self,
        context: &Rc<Context>,
        switch: ResidualSwitch,
        survivors: Vec<(usize, Value)>,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let signature = survivors
            .iter()
            .find_map(|(_, value)| joined_signature(value));
        let mut alternatives = Vec::<ClosureAlternative>::new();
        let mut branches = Vec::with_capacity(survivors.len());
        for (end, value) in survivors {
            let branch_alternatives =
                self.branch_alternatives(context, &value, signature.as_ref(), span)?;
            let mut cases = Vec::with_capacity(branch_alternatives.len());
            for alternative in &branch_alternatives {
                let case = alternatives
                    .iter()
                    .position(|candidate| candidate.same_source(alternative))
                    .unwrap_or_else(|| {
                        alternatives.push(alternative.clone());
                        alternatives.len() - 1
                    });
                cases.push(case);
            }
            branches.push((end, value, branch_alternatives, cases));
        }
        self.settle_payload_types(&mut alternatives);
        let case_names = alternatives
            .iter()
            .enumerate()
            .map(|(case, alternative)| format!("choice${case}${}", alternative.source_name()))
            .collect::<Vec<_>>();
        let payload_types = alternatives
            .iter()
            .map(|alternative| alternative.payload_type)
            .collect::<Vec<_>>();
        let sum_type = self.sum_type(&case_names, &payload_types);
        for (end, value, branch_alternatives, cases) in branches {
            let (selector, end) = self.encode_choice(
                end,
                &value,
                &branch_alternatives,
                &cases,
                &alternatives,
                sum_type,
                span,
            )?;
            self.blocks[end].terminator = Some(RuntimeTerminator::Branch {
                target: switch.join,
                arguments: vec![selector.id],
                span: self.span(span),
            });
        }
        let selector = self.next_value();
        let ownership = self.ownership(sum_type);
        let runtime_span = self.span(span);
        self.blocks[switch.join]
            .parameters
            .push(RuntimeBlockParameter {
                value: selector,
                type_id: sum_type,
                ownership,
                span: runtime_span,
            });
        self.current_block = switch.join;
        Ok(Value::ClosureChoice {
            selector: RuntimeValue {
                id: selector,
                type_id: sum_type,
                meaning: RuntimeMeaning::Sum { cases: case_names },
            },
            alternatives: Rc::new(alternatives),
        })
    }

    pub(crate) fn select_block(&mut self, block: usize) {
        self.current_block = block;
    }

    /// Ends the current block with a runtime trap. Used when a residual branch
    /// evaluates `@panic`: the arm contributes no value to its join, and the
    /// program traps if execution reaches it.
    pub(crate) fn trap_current_block(&mut self, message: &str, span: crate::ast::Span) {
        let block = self.current_block;
        self.blocks[block].terminator = Some(RuntimeTerminator::Trap {
            message: message.to_owned(),
            span: self.span(span),
        });
    }

    /// Completes a conditional whose other arm trapped. The surviving arm
    /// branches to the join carrying no argument — the trapped arm never
    /// reaches it — and the surviving arm's value, comptime or runtime,
    /// remains the result.
    pub(crate) fn join_survivor(
        &mut self,
        branches: &ResidualBranches,
        end: usize,
        span: crate::ast::Span,
    ) {
        self.blocks[end].terminator = Some(RuntimeTerminator::Branch {
            target: branches.join,
            arguments: Vec::new(),
            span: self.span(span),
        });
        self.current_block = branches.join;
    }

    pub(crate) fn current_block(&self) -> usize {
        self.current_block
    }

    pub(crate) fn blocks_share_path(&self, left: usize, right: usize) -> bool {
        left == right || self.block_reaches(left, right) || self.block_reaches(right, left)
    }

    fn block_reaches(&self, source: usize, target: usize) -> bool {
        let mut pending = vec![source];
        let mut seen = HashSet::new();
        while let Some(block) = pending.pop() {
            if !seen.insert(block) {
                continue;
            }
            let Some(terminator) = self
                .blocks
                .get(block)
                .and_then(|block| block.terminator.as_ref())
            else {
                continue;
            };
            let successors = match terminator {
                RuntimeTerminator::Branch { target, .. } => vec![*target],
                RuntimeTerminator::Conditional {
                    consequent,
                    alternate,
                    ..
                } => vec![*consequent, *alternate],
                RuntimeTerminator::Switch {
                    cases, fallback, ..
                } => cases
                    .iter()
                    .map(|case| case.target)
                    .chain(std::iter::once(*fallback))
                    .collect(),
                RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => Vec::new(),
            };
            if successors.contains(&target) {
                return true;
            }
            pending.extend(successors);
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn join_conditional(
        &mut self,
        context: &Rc<Context>,
        branches: ResidualBranches,
        consequent_end: usize,
        consequent: Value,
        alternate_end: usize,
        alternate: Value,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        if is_function_value(&consequent) || is_function_value(&alternate) {
            return self.join_function_conditional(
                context,
                branches,
                consequent_end,
                &consequent,
                alternate_end,
                &alternate,
                span,
            );
        }
        let consequent_value = crate::value::show(&consequent);
        let alternate_value = crate::value::show(&alternate);
        let result_reuse = merge_store_reuse_witness(
            &runtime_store_reuse_witness(&consequent, &self.types),
            &runtime_store_reuse_witness(&alternate, &self.types),
        );
        let (consequent, alternate) =
            self.join_values(consequent_end, consequent, alternate_end, alternate, span)?;
        if consequent.type_id != alternate.type_id {
            let consequent_type = serde_json::to_string(&self.types[consequent.type_id])
                .unwrap_or_else(|_| format!("type {}", consequent.type_id));
            let alternate_type = serde_json::to_string(&self.types[alternate.type_id])
                .unwrap_or_else(|_| format!("type {}", alternate.type_id));
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!(
                    "Dynamic branches return incompatible runtime types: {consequent_value} has {consequent_type}; {alternate_value} has {alternate_type}."
                ),
                span,
            ));
        }
        let joined = self.join_runtime_values(
            &branches,
            consequent_end,
            consequent,
            alternate_end,
            alternate,
            span,
        );
        let value = self.symbolic_value(joined, span)?;
        Ok(apply_store_reuse_witness(&result_reuse, value, &self.types))
    }

    fn join_runtime_values(
        &mut self,
        branches: &ResidualBranches,
        consequent_end: usize,
        consequent: RuntimeValue,
        alternate_end: usize,
        alternate: RuntimeValue,
        span: crate::ast::Span,
    ) -> RuntimeValue {
        self.blocks[consequent_end].terminator = Some(RuntimeTerminator::Branch {
            target: branches.join,
            arguments: vec![consequent.id],
            span: self.span(span),
        });
        self.blocks[alternate_end].terminator = Some(RuntimeTerminator::Branch {
            target: branches.join,
            arguments: vec![alternate.id],
            span: self.span(span),
        });
        let joined = self.next_value();
        let meaning = merge_meaning(&consequent.meaning, &alternate.meaning);
        let ownership = self.ownership(consequent.type_id);
        let parameter = RuntimeBlockParameter {
            value: joined,
            type_id: consequent.type_id,
            ownership,
            span: self.span(span),
        };
        self.blocks[branches.join].parameters.push(parameter);
        self.current_block = branches.join;
        RuntimeValue {
            id: joined,
            type_id: consequent.type_id,
            meaning,
        }
    }

    /// Join two branches whose values are functions by defunctionalizing the
    /// finite set of lambdas they can produce. The joined value is a private
    /// constructor tag: its case selects a closure source and its payload is
    /// that alternative's ordered capture product.
    #[allow(clippy::too_many_arguments)]
    fn join_function_conditional(
        &mut self,
        context: &Rc<Context>,
        branches: ResidualBranches,
        consequent_end: usize,
        consequent: &Value,
        alternate_end: usize,
        alternate: &Value,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let signature = joined_signature(consequent).or_else(|| joined_signature(alternate));
        let consequent_alternatives =
            self.branch_alternatives(context, consequent, signature.as_ref(), span)?;
        let alternate_alternatives =
            self.branch_alternatives(context, alternate, signature.as_ref(), span)?;
        let mut alternatives: Vec<ClosureAlternative> = Vec::new();
        let mut consequent_cases = Vec::new();
        let mut alternate_cases = Vec::new();
        for (source, cases) in [
            (&consequent_alternatives, &mut consequent_cases),
            (&alternate_alternatives, &mut alternate_cases),
        ] {
            for alternative in source {
                let existing = alternatives
                    .iter()
                    .position(|candidate| candidate.same_source(alternative));
                match existing {
                    Some(case) => cases.push(case),
                    None => {
                        cases.push(alternatives.len());
                        alternatives.push(alternative.clone());
                    }
                }
            }
        }
        self.settle_payload_types(&mut alternatives);
        let case_names = alternatives
            .iter()
            .enumerate()
            .map(|(case, alternative)| format!("choice${case}${}", alternative.source_name()))
            .collect::<Vec<_>>();
        let payload_types = alternatives
            .iter()
            .map(|alternative| alternative.payload_type)
            .collect::<Vec<_>>();
        let sum_type = self.sum_type(&case_names, &payload_types);
        let (consequent_selector, consequent_end) = self.encode_choice(
            consequent_end,
            consequent,
            &consequent_alternatives,
            &consequent_cases,
            &alternatives,
            sum_type,
            span,
        )?;
        let (alternate_selector, alternate_end) = self.encode_choice(
            alternate_end,
            alternate,
            &alternate_alternatives,
            &alternate_cases,
            &alternatives,
            sum_type,
            span,
        )?;
        let selector = self.join_runtime_values(
            &branches,
            consequent_end,
            consequent_selector,
            alternate_end,
            alternate_selector,
            span,
        );
        Ok(Value::ClosureChoice {
            selector: RuntimeValue {
                meaning: RuntimeMeaning::Sum { cases: case_names },
                ..selector
            },
            alternatives: Rc::new(alternatives),
        })
    }

    /// Normalize one branch value into its alternative table. A single lambda
    /// or partially applied primitive contributes one alternative; an
    /// already-joined choice contributes the alternatives it carries, so nested
    /// choices flatten into one finite table.
    fn branch_alternatives(
        &mut self,
        context: &Rc<Context>,
        value: &Value,
        signature: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<Vec<ClosureAlternative>, Diagnostic> {
        match value {
            Value::ClosureChoice { alternatives, .. } => Ok(alternatives.as_ref().clone()),
            Value::Closure {
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
                ..
            } => {
                let captures = runtime_capture_plan(
                    context,
                    LexicalClosure {
                        module,
                        parameter: *parameter,
                        body: *body,
                        environment,
                        self_name: self_name.as_deref(),
                    },
                )?
                .values;
                let product_type = self.capture_product_type(&captures);
                Ok(vec![ClosureAlternative {
                    source: ChoiceSource::Lambda {
                        module: module.clone(),
                        module_instances: module_instances.clone(),
                        effect_scope: effect_scope.clone(),
                        parameter: *parameter,
                        body: *body,
                        environment: environment.clone(),
                        self_name: self_name.clone(),
                        signature: signature.clone(),
                        reuse_assertion: *reuse_assertion,
                        deferred: *deferred,
                    },
                    captures,
                    product_type,
                    payload_type: product_type,
                }])
            }
            Value::Primitive {
                name,
                arity,
                applied,
            } => {
                let captures = value_runtime_captures(context, value)?;
                let product_type = self.capture_product_type(&captures);
                Ok(vec![ClosureAlternative {
                    source: ChoiceSource::Primitive {
                        name: name.clone(),
                        arity: *arity,
                        applied: applied.clone(),
                    },
                    captures,
                    product_type,
                    payload_type: product_type,
                }])
            }
            _ => Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!(
                    "A dynamic branch joins {} with a function{}, so the function source set is not closed. Defunctionalization needs every branch to name a lambda or a partially applied primitive.",
                    crate::value::show(value),
                    match signature {
                        Some(signature) => format!(" of type `{}`", crate::value::show(signature)),
                        None => String::new(),
                    }
                ),
                span,
            )),
        }
    }

    /// Decide how the merged table carries its payloads. One case's payload
    /// occupies the sum's payload slots from the first one on, so alternatives
    /// whose capture products are prefixes of the widest can be carried
    /// directly. Alternatives that capture mutually incompatible layouts —
    /// an `Int` in one branch and a `F64` in another — get a private
    /// indirection instead, which is one slot whatever it points at.
    fn settle_payload_types(&mut self, alternatives: &mut [ClosureAlternative]) {
        let layouts = alternatives
            .iter()
            .map(|alternative| self.product_field_types(alternative.product_type))
            .collect::<Vec<_>>();
        let widest = layouts
            .iter()
            .max_by_key(|layout| layout.len())
            .cloned()
            .unwrap_or_default();
        let direct = layouts
            .iter()
            .all(|layout| widest[..layout.len()] == layout[..]);
        for alternative in alternatives {
            alternative.payload_type = match direct || alternative.product_type == 0 {
                true => alternative.product_type,
                false => self.indirect_type(alternative.product_type),
            };
        }
    }

    fn product_field_types(&self, type_id: usize) -> Vec<usize> {
        let RuntimeType::Product { fields, .. } = &self.types[type_id] else {
            return Vec::new();
        };
        fields.iter().map(|field| field.type_id).collect()
    }

    fn indirect_type(&mut self, target_type: usize) -> usize {
        self.insert_type(
            &format!("residual-indirect:{target_type}"),
            RuntimeType::Indirect { target_type },
        )
    }

    fn settle_recursive_type(
        &mut self,
        indirect_type: usize,
        concrete_type: usize,
        _span: crate::ast::Span,
    ) -> Result<bool, Diagnostic> {
        if !self.pending_recursive_types.contains(&indirect_type) {
            return Ok(false);
        }
        let RuntimeType::Indirect { target_type } = self.types[indirect_type] else {
            return Err(hir_error(
                "A pending recursive result lost its indirect representation.",
            ));
        };
        if self.settled_recursive_types.contains(&indirect_type) {
            if target_type != concrete_type {
                return Err(hir_error(&format!(
                    "A recursive result first settled to runtime type {} {:?}, then produced incompatible runtime type {} {:?}.",
                    target_type, self.types[target_type], concrete_type, self.types[concrete_type],
                )));
            }
            return Ok(true);
        }
        self.types[indirect_type] = RuntimeType::Indirect {
            target_type: concrete_type,
        };
        self.settled_recursive_types.insert(indirect_type);
        Ok(true)
    }

    fn box_recursive_result(
        &mut self,
        value: RuntimeValue,
        indirect_type: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        self.settle_recursive_type(indirect_type, value.type_id, span)?;
        let RuntimeType::Indirect { target_type } = self.types[indirect_type] else {
            return Err(hir_error(
                "A pending recursive result lost its indirect representation.",
            ));
        };
        let value = self.coerce_runtime_value(&value, target_type, span)?;
        Ok(self.operation("indirect.make", indirect_type, vec![value.id], span, None))
    }

    /// Move a capture product between the direct and indirect payload forms.
    /// The alternative's product never changes; only how its case carries it.
    fn coerce_payload(
        &mut self,
        payload: RuntimeValue,
        target_type: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        if payload.type_id == target_type {
            return Ok(payload);
        }
        if matches!(self.types[target_type], RuntimeType::Indirect { target_type }
            if target_type == payload.type_id)
        {
            return Ok(self.operation("indirect.make", target_type, vec![payload.id], span, None));
        }
        if matches!(self.types[payload.type_id], RuntimeType::Indirect { target_type: pointee }
            if pointee == target_type)
        {
            return Ok(self.operation("indirect.load", target_type, vec![payload.id], span, None));
        }
        Err(hir_error(
            "A function choice alternative changed its capture product.",
        ))
    }

    fn capture_product_type(&mut self, captures: &[RuntimeValue]) -> usize {
        if captures.is_empty() {
            return 0;
        }
        let fields = captures
            .iter()
            .enumerate()
            .map(|(index, capture)| RuntimeField {
                name: capture_field_name(index),
                type_id: capture.type_id,
            })
            .collect();
        self.insert_product_type(fields)
    }

    /// Emit one branch's tagged selector, returning it with the block that now
    /// ends that branch. A nested choice is retagged onto the joined table.
    #[allow(clippy::too_many_arguments)]
    fn encode_choice(
        &mut self,
        end_block: usize,
        value: &Value,
        alternatives: &[ClosureAlternative],
        cases: &[usize],
        merged: &[ClosureAlternative],
        sum_type: usize,
        span: crate::ast::Span,
    ) -> Result<(RuntimeValue, usize), Diagnostic> {
        self.current_block = end_block;
        match value {
            Value::ClosureChoice { selector, .. } => {
                let selector = selector.clone();
                self.retag_choice(&selector, alternatives, cases, merged, sum_type, 0, span)
            }
            _ => {
                let alternative = alternatives
                    .first()
                    .ok_or_else(|| hir_error("A residual lambda produced no alternative."))?;
                let case = *cases
                    .first()
                    .ok_or_else(|| hir_error("A residual lambda produced no case."))?;
                let payload = self.capture_product(&alternative.captures, span);
                let payload = self.coerce_payload(payload, merged[case].payload_type, span)?;
                let selector =
                    self.operation_with_case("sum.make", sum_type, vec![payload.id], span, case);
                Ok((selector, self.current_block))
            }
        }
    }

    fn capture_product(
        &mut self,
        captures: &[RuntimeValue],
        span: crate::ast::Span,
    ) -> RuntimeValue {
        if captures.is_empty() {
            return self.constant(WireConstant::Unit, 0, span);
        }
        let type_id = self.capture_product_type(captures);
        let RuntimeType::Product { fields, .. } = self.types[type_id].clone() else {
            unreachable!("capture_product_type returned a non-product type");
        };
        let operands = fields
            .iter()
            .map(|field| {
                let index = capture_field_index(&field.name)
                    .expect("capture product field names are generated");
                captures[index].id
            })
            .collect();
        self.operation("product.make", type_id, operands, span, None)
    }

    /// Rewrite an already-tagged choice onto the joined alternative table by
    /// dispatching on its own tag and reinjecting each payload under its new
    /// case. The final alternative needs no test, so `n` cases cost `n - 1`
    /// conditionals.
    #[allow(clippy::too_many_arguments)]
    fn retag_choice(
        &mut self,
        selector: &RuntimeValue,
        alternatives: &[ClosureAlternative],
        cases: &[usize],
        merged: &[ClosureAlternative],
        sum_type: usize,
        index: usize,
        span: crate::ast::Span,
    ) -> Result<(RuntimeValue, usize), Diagnostic> {
        let case = *cases
            .get(index)
            .ok_or_else(|| hir_error("A retagged choice is outside its alternative table."))?;
        let alternative = &alternatives[index];
        let target_type = merged[case].payload_type;
        if index + 1 == cases.len() {
            let payload = self.choice_payload(selector, index, alternative, span)?;
            let payload = self.coerce_payload(payload, target_type, span)?;
            let retagged =
                self.operation_with_case("sum.make", sum_type, vec![payload.id], span, case);
            return Ok((retagged, self.current_block));
        }
        let condition = self.choice_condition(selector, index, span)?;
        let branches = self.begin_conditional(&condition, span)?;
        self.current_block = branches.consequent;
        let payload = self.choice_payload(selector, index, alternative, span)?;
        let payload = self.coerce_payload(payload, target_type, span)?;
        let consequent =
            self.operation_with_case("sum.make", sum_type, vec![payload.id], span, case);
        let consequent_end = self.current_block;
        self.current_block = branches.alternate;
        let (alternate, alternate_end) = self.retag_choice(
            selector,
            alternatives,
            cases,
            merged,
            sum_type,
            index + 1,
            span,
        )?;
        let joined = self.join_runtime_values(
            &branches,
            consequent_end,
            consequent,
            alternate_end,
            alternate,
            span,
        );
        Ok((joined, self.current_block))
    }

    /// Test whether a choice selector holds its `index`th alternative.
    pub(crate) fn choice_condition(
        &mut self,
        selector: &RuntimeValue,
        index: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let sum = self.load_indirect(selector, span);
        if self.sum_representation(sum.type_id).is_none() {
            return Err(hir_error("A function choice lost its alternative table."));
        }
        let tag = self.operation("sum.tag", 2, vec![sum.id], span, None);
        let expected = self.constant(WireConstant::SignedInteger32(index as i32), 2, span);
        Ok(self.operation("scalar", 1, vec![tag.id, expected.id], span, Some("equal")))
    }

    fn choice_payload(
        &mut self,
        selector: &RuntimeValue,
        index: usize,
        alternative: &ClosureAlternative,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let sum = self.load_indirect(selector, span);
        let (sum_type, sum_cases) = self
            .sum_representation(sum.type_id)
            .map(|(sum_type, cases)| (sum_type, cases.to_vec()))
            .ok_or_else(|| hir_error("A function choice lost its alternative table."))?;
        if sum.type_id != sum_type {
            return Err(hir_error("A function choice lost its alternative table."));
        }
        let payload_type = sum_cases
            .get(index)
            .ok_or_else(|| hir_error("A function choice case is outside its runtime type."))?
            .payload_type;
        if payload_type != alternative.payload_type {
            return Err(hir_error(
                "A function choice alternative changed its capture product.",
            ));
        }
        let result = self.next_value();
        let ownership = self.ownership(payload_type);
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "sum.payload",
            result,
            type_id: payload_type,
            operands: vec![sum.id],
            ownership,
            span: runtime_span,
            value: None,
            update: None,
            case: Some(index),
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        Ok(RuntimeValue {
            id: result,
            type_id: payload_type,
            meaning: RuntimeMeaning::Plain,
        })
    }

    /// Rebuild one alternative as an ordinary function value inside a dispatch
    /// branch, with its captures projected out of the selector's payload. A
    /// lambda gets its lexical environment back; a partially applied primitive
    /// gets the arguments it already held.
    pub(crate) fn choice_function(
        &mut self,
        context: &Rc<Context>,
        selector: &RuntimeValue,
        index: usize,
        alternative: &ClosureAlternative,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let replacements = self.choice_replacements(selector, index, alternative, span)?;
        match &alternative.source {
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
            } => {
                let environment = match replacements.is_empty() {
                    true => environment.clone(),
                    false => replace_environment_runtime(
                        context,
                        LexicalClosure {
                            module,
                            parameter: *parameter,
                            body: *body,
                            environment,
                            self_name: self_name.as_deref(),
                        },
                        &replacements,
                    )?,
                };
                Ok(Value::Closure {
                    module: module.clone(),
                    module_instances: module_instances.clone(),
                    effect_scope: effect_scope.clone(),
                    parameter: *parameter,
                    body: *body,
                    deferred: *deferred,
                    environment,
                    self_name: self_name.clone(),
                    imports: None,
                    signature: signature.clone(),
                    reuse_assertion: *reuse_assertion,
                })
            }
            ChoiceSource::Primitive {
                name,
                arity,
                applied,
            } => {
                let applied = match replacements.is_empty() {
                    true => applied.clone(),
                    false => applied
                        .iter()
                        .map(|argument| replace_runtime_in_value(context, argument, &replacements))
                        .collect::<Result<Vec<_>, Diagnostic>>()?,
                };
                Ok(Value::Primitive {
                    name: name.clone(),
                    arity: *arity,
                    applied,
                })
            }
        }
    }

    /// Project this alternative's capture product out of the selector, one
    /// field per capture the branch supplied.
    fn choice_replacements(
        &mut self,
        selector: &RuntimeValue,
        index: usize,
        alternative: &ClosureAlternative,
        span: crate::ast::Span,
    ) -> Result<HashMap<(usize, usize), RuntimeValue>, Diagnostic> {
        if alternative.captures.is_empty() {
            return Ok(HashMap::new());
        }
        let payload = self.choice_payload(selector, index, alternative, span)?;
        let payload = self.load_indirect(&payload, span);
        let RuntimeType::Product { fields, .. } = self.types[payload.type_id].clone() else {
            return Err(hir_error(
                "A function choice payload is not a capture product.",
            ));
        };
        let mut replacements = HashMap::new();
        for (field_index, field) in fields.iter().enumerate() {
            let capture_index = capture_field_index(&field.name)
                .ok_or_else(|| hir_error("A capture product carries an unnamed field."))?;
            let capture = alternative
                .captures
                .get(capture_index)
                .ok_or_else(|| hir_error("A capture product is wider than its alternative."))?;
            let projected = self.project_field(&payload, field_index, field.type_id, span);
            replacements.insert(
                (capture.id, capture.type_id),
                RuntimeValue {
                    meaning: capture.meaning.clone(),
                    ..projected
                },
            );
        }
        Ok(replacements)
    }

    fn project_field(
        &mut self,
        product: &RuntimeValue,
        field: usize,
        type_id: usize,
        span: crate::ast::Span,
    ) -> RuntimeValue {
        let result = self.operation("product.project", type_id, vec![product.id], span, None);
        self.current()
            .operations
            .last_mut()
            .expect("just inserted operation")
            .field = Some(field);
        result
    }

    pub(crate) fn sum_tag(
        &mut self,
        target: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        if self.sum_representation(target.type_id).is_none() {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                "A checked dynamic sum case has a non-sum runtime type.",
                span,
            ));
        }
        let sum = self.load_indirect(target, span);
        Ok(self.operation("sum.tag", 2, vec![sum.id], span, None))
    }

    pub(crate) fn sum_payload(
        &mut self,
        target: &RuntimeValue,
        case: usize,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let (sum_type, cases) = self
            .sum_representation(target.type_id)
            .map(|(sum_type, cases)| (sum_type, cases.to_vec()))
            .ok_or_else(|| hir_error("A dynamic sum value has a non-sum runtime type."))?;
        let sum = self.load_indirect(target, span);
        if sum.type_id != sum_type {
            return Err(hir_error("A dynamic sum value has a non-sum runtime type."));
        }
        let payload_type = cases
            .get(case)
            .ok_or_else(|| hir_error("A dynamic sum case is outside its runtime type."))?
            .payload_type;
        let result = self.next_value();
        let ownership = self.ownership(payload_type);
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "sum.payload",
            result,
            type_id: payload_type,
            operands: vec![sum.id],
            ownership,
            span: runtime_span,
            value: None,
            update: None,
            case: Some(case),
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        if payload_type == 0 {
            return Ok(Value::Unit);
        }
        self.symbolic_value(
            RuntimeValue {
                id: result,
                type_id: payload_type,
                meaning: RuntimeMeaning::Plain,
            },
            span,
        )
    }

    pub(crate) fn begin_residual_function(
        &mut self,
        closure: ResidualClosure<'_>,
        argument: &Value,
        checked_argument_type: Option<&Value>,
        expected_result: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<ResidualFunctionCall, Diagnostic> {
        let ResidualClosure {
            context,
            module,
            parameter: closure_parameter,
            body,
            name,
            self_name,
            environment,
            signature,
            reuse,
            root_application,
            crosses_development_boundary,
        } = closure;
        if root_application {
            return Ok(ResidualFunctionCall::Static);
        }
        let lexical_closure = LexicalClosure {
            module,
            parameter: closure_parameter,
            body,
            environment,
            self_name,
        };
        let source_span = context
            .modules
            .borrow()
            .get(module)
            .map(|loaded| loaded.module.arena.expression_span(body))
            .ok_or_else(|| hir_error("A residual closure lost its source expression."))?;
        let capture_plan = runtime_capture_plan(context, lexical_closure)?;
        if capture_plan.requires_staging {
            return Ok(ResidualFunctionCall::Static);
        }
        let captures = capture_plan.values;
        if (!contains_runtime(argument) && captures.is_empty())
            || contains_staged_iterator(argument)
            || contains_staging_sensitive_runtime(argument)
        {
            return Ok(ResidualFunctionCall::Static);
        }
        let mut signature = signature;
        while let Some(Value::Forall { body, .. }) = signature {
            signature = Some(body);
        }
        let Some(
            signature_value @ Value::Arrow {
                deferred,
                domain,
                codomain,
                effects,
                ..
            },
        ) = signature
        else {
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!(
                    "Residual closure `{name}` at {module} expression {} has no settled function signature.",
                    body.0
                ),
                span,
            ));
        };
        let mut result_body = codomain.as_ref();
        while let Value::Forall { body, .. } | Value::Extended { inner: body, .. } = result_body {
            result_body = body;
        }
        let result_policy = if self_name.is_some() {
            ResidualResultPolicy::Recursive
        } else {
            ResidualResultPolicy::Ordinary
        };
        if *deferred
            || residual_result_requires_staging(codomain, result_policy)
            || (!crosses_development_boundary
                && self_name.is_none()
                && matches!(result_body, Value::Union(_)))
        {
            return Ok(ResidualFunctionCall::Static);
        }
        let mut substitutions = HashMap::new();
        let mut representation_facts = RepresentationFacts::default();
        if let Some(checked_argument_type) = checked_argument_type {
            self.record_checked_runtime_substitutions(
                domain,
                checked_argument_type,
                &mut substitutions,
                &mut representation_facts,
            )?;
            let mut runtime_substitutions = HashMap::new();
            self.record_runtime_substitutions(
                domain,
                argument,
                &mut runtime_substitutions,
                &mut RepresentationFacts::default(),
            )?;
            for (variable, type_id) in runtime_substitutions {
                substitutions.entry(variable).or_insert(type_id);
            }
        } else {
            self.record_runtime_substitutions(
                domain,
                argument,
                &mut substitutions,
                &mut representation_facts,
            )?;
        }
        if let Some(expected_result) = expected_result {
            let mut contextual_substitutions = HashMap::new();
            self.record_checked_runtime_substitutions(
                codomain,
                expected_result,
                &mut contextual_substitutions,
                &mut RepresentationFacts::default(),
            )?;
            for (variable, type_id) in contextual_substitutions {
                substitutions.entry(variable).or_insert(type_id);
            }
        }
        let mut lexical_substitutions = BTreeMap::new();
        let mut scope = Some(environment.clone());
        while let Some(current) = scope {
            for (variable, type_) in current.type_substitutions.borrow().iter() {
                lexical_substitutions
                    .entry(*variable)
                    .or_insert_with(|| type_.clone());
            }
            scope = current.parent.borrow().clone();
        }
        loop {
            let mut progress = false;
            for (variable, type_) in &lexical_substitutions {
                if substitutions.contains_key(variable) {
                    continue;
                }
                let mut candidate_substitutions = substitutions.clone();
                if let Ok(type_id) = self.specialized_type_from_type_value(
                    type_,
                    &mut candidate_substitutions,
                    &representation_facts,
                ) {
                    candidate_substitutions.insert(*variable, type_id);
                    substitutions = candidate_substitutions;
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }
        if has_unresolved_representation(domain, &substitutions) && !contains_runtime(argument) {
            return Ok(ResidualFunctionCall::Static);
        }
        let caller_argument = self
            .lower_residual_argument(argument, domain, &substitutions, span)
            .map_err(|mut diagnostic| {
                diagnostic.message = format!(
                    "{} Residual closure `{name}` argument {} against {}; result {}, context {}.",
                    diagnostic.message,
                    crate::value::show(argument),
                    crate::value::show(domain),
                    crate::value::show(codomain),
                    expected_result
                        .map(crate::value::show)
                        .unwrap_or_else(|| "<none>".to_owned()),
                );
                diagnostic
            })?;
        let capture_types = captures
            .iter()
            .map(|capture| capture.type_id)
            .collect::<Vec<_>>();
        let (input_ownership, result_ownership) = context
            .ownership_contracts
            .borrow()
            .get(module, &body)
            .map(|contract| (contract.input.clone(), contract.result.clone()))
            .unwrap_or((Produced::None, Produced::None));
        let mut argument_reuse = input_store_reuse_witness(&input_ownership, argument, &self.types);
        let recursive_result = context
            .recursive_closures
            .borrow()
            .contains_key(module, &body);
        if recursive_result {
            argument_reuse = preserve_recursive_store_reuse(&argument_reuse, argument, &self.types);
        }
        let signature_result = self.specialized_type_from_type_value(
            codomain,
            &mut substitutions,
            &representation_facts,
        );
        let contextual_result = if signature_result.is_err() {
            expected_result.and_then(|expected| {
                let mut contextual_substitutions = substitutions.clone();
                let specialized = self.specialized_type_from_type_value(
                    expected,
                    &mut contextual_substitutions,
                    &representation_facts,
                );
                let result = specialized.ok();
                if result.is_some() {
                    substitutions = contextual_substitutions;
                }
                result
            })
        } else {
            None
        };
        let forwarded_result = if signature_result.is_err() && contextual_result.is_none() {
            self.forwarded_parameter_result_type(
                context,
                module,
                body,
                closure_parameter,
                argument,
                caller_argument.type_id,
            )?
        } else {
            None
        };
        let result_type = match signature_result {
            Ok(result_type) => result_type,
            Err(_) if contextual_result.is_some() => {
                contextual_result.expect("guarded contextual recursive result")
            }
            Err(_) if forwarded_result.is_some() => {
                forwarded_result
                    .as_ref()
                    .expect("guarded forwarded recursive result")
                    .0
            }
            Err(_)
                if !recursive_result && has_unresolved_representation(codomain, &substitutions) =>
            {
                return Ok(ResidualFunctionCall::Static);
            }
            Err(_)
                if recursive_result && has_unresolved_representation(codomain, &substitutions) =>
            {
                if let Some(identity) = self.recursive_result_ids.iter().find(|identity| {
                    identity.module == module
                        && identity.body == body
                        && identity.argument_type == caller_argument.type_id
                        && identity.argument_reuse == argument_reuse
                        && identity.capture_types == capture_types
                        && crate::value::equal(&identity.signature, signature_value)
                }) {
                    identity.type_id
                } else {
                    let key = format!(
                        "recursive-result:structural:{}",
                        self.recursive_result_ids.len()
                    );
                    let result_type =
                        self.insert_type(&key, RuntimeType::Indirect { target_type: 0 });
                    self.pending_recursive_types.insert(result_type);
                    self.recursive_result_ids.push(RecursiveResultIdentity {
                        module: module.to_owned(),
                        body,
                        argument_type: caller_argument.type_id,
                        argument_reuse: argument_reuse.clone(),
                        capture_types: capture_types.clone(),
                        signature: signature_value.clone(),
                        type_id: result_type,
                    });
                    result_type
                }
            }
            Err(mut diagnostic) => {
                diagnostic.message = format!(
                    "{} Residual signature: {}.",
                    diagnostic.message,
                    crate::value::show(signature_value)
                );
                return Err(diagnostic);
            }
        };
        if let Some((function, signature, result_reuse)) = self
            .function_ids
            .iter()
            .find(|identity| {
                identity.module == module
                    && identity.body == body
                    && identity.argument_type == caller_argument.type_id
                    && identity.argument_reuse == argument_reuse
                    && identity.result_type == result_type
                    && identity.capture_types == capture_types
                    && crate::value::equal(&identity.signature, signature_value)
            })
            .map(|identity| {
                (
                    identity.function,
                    identity.runtime_signature,
                    identity.result_reuse.clone(),
                )
            })
        {
            let result_type = self.signatures[signature].result;
            let mut caller_arguments = vec![caller_argument.id];
            caller_arguments.extend(captures.iter().map(|capture| capture.id));
            let value = self.direct_call(function, result_type, caller_arguments, span)?;
            let value = apply_store_reuse_witness(&result_reuse, value, &self.types);
            let value = mark_reusable_stores(&result_ownership, value, &self.types);
            return Ok(ResidualFunctionCall::Existing(value));
        }

        let signature_id = self.signatures.len();
        self.signatures.push(RuntimeSignature {
            parameters: std::iter::once(caller_argument.type_id)
                .chain(capture_types)
                .collect(),
            result: result_type,
            effects: effects.iter().filter_map(runtime_effect_name).collect(),
        });
        let function = self.next_function;
        self.next_function += 1;
        self.function_ids.push(ResidualFunctionIdentity {
            module: module.to_owned(),
            body,
            argument_type: caller_argument.type_id,
            argument_reuse: argument_reuse.clone(),
            result_reuse: forwarded_result
                .as_ref()
                .map(|(_, witness)| witness.clone())
                .unwrap_or_else(|| deferred_store_reuse_witness(result_type, &self.types)),
            result_type,
            capture_types: captures.iter().map(|capture| capture.type_id).collect(),
            signature: signature_value.clone(),
            function,
            runtime_signature: signature_id,
        });
        self.function_frames.push(ResidualFunctionFrame {
            source: self.source.clone(),
            blocks: std::mem::take(&mut self.blocks),
            current_block: self.current_block,
            next_value: self.next_value,
        });
        self.source = module.to_owned();
        self.current_block = 0;
        self.next_value = 0;
        self.block();
        let parameter_value = self.next_value();
        let ownership = self.ownership(caller_argument.type_id);
        let runtime_span = self.span(span);
        self.current().parameters.push(RuntimeBlockParameter {
            value: parameter_value,
            type_id: caller_argument.type_id,
            ownership,
            span: runtime_span,
        });
        let argument = self.symbolic_value(
            RuntimeValue {
                id: parameter_value,
                type_id: caller_argument.type_id,
                meaning: RuntimeMeaning::Plain,
            },
            span,
        )?;
        let argument = apply_store_reuse_witness(&argument_reuse, argument, &self.types);
        let mut replacements = HashMap::new();
        for capture in &captures {
            let parameter = self.next_value();
            let ownership = self.ownership(capture.type_id);
            let runtime_span = self.span(span);
            self.current().parameters.push(RuntimeBlockParameter {
                value: parameter,
                type_id: capture.type_id,
                ownership,
                span: runtime_span,
            });
            replacements.insert(
                (capture.id, capture.type_id),
                RuntimeValue {
                    id: parameter,
                    type_id: capture.type_id,
                    meaning: capture.meaning.clone(),
                },
            );
        }
        let environment = replace_environment_runtime(context, lexical_closure, &replacements)?;
        let mut caller_arguments = vec![caller_argument.id];
        caller_arguments.extend(captures.iter().map(|capture| capture.id));
        Ok(ResidualFunctionCall::Compile(ResidualFunctionCompilation {
            argument,
            environment,
            function,
            signature: signature_id,
            result_type,
            result_ownership,
            caller_arguments,
            name,
            reuse,
            span,
            source_span,
        }))
    }

    fn forwarded_parameter_result_type(
        &mut self,
        context: &Rc<Context>,
        module: &str,
        body: crate::ast::ExpressionId,
        parameter: crate::ast::PatternId,
        argument: &Value,
        argument_type: usize,
    ) -> Result<Option<(usize, StoreReuseWitness)>, Diagnostic> {
        let contract = context
            .ownership_contracts
            .borrow()
            .get(module, &body)
            .cloned();
        let Some(crate::ownership::OwnershipContract {
            parameter: contract_parameter,
            result,
            ..
        }) = contract
        else {
            return Ok(None);
        };
        let (source, path) = match result {
            Produced::Parameter { source, .. } => (source, Vec::new()),
            Produced::StoreParameter { source, path, .. } => (source, path),
            Produced::Region {
                root: Some(source),
                splits,
                ..
            } if splits.is_empty() => (source, Vec::new()),
            _ => return Ok(None),
        };
        if contract_parameter != parameter {
            return Err(hir_error(
                "A residual closure ownership contract changed its parameter.",
            ));
        }
        let loaded = context
            .modules
            .borrow()
            .get(module)
            .map(|loaded| loaded.module.clone())
            .ok_or_else(|| hir_error("A residual closure lost its source module."))?;
        let value = value_at_pattern(&loaded, parameter, source, argument).ok_or_else(|| {
            hir_error("A residual closure ownership result is absent from its argument pattern.")
        })?;
        let source_type =
            runtime_type_at_pattern(&loaded, parameter, source, argument_type, &self.types)
                .ok_or_else(|| {
                    hir_error(
                        "A residual closure ownership result is absent from its runtime argument.",
                    )
                })?;
        let type_id = runtime_type_at_path(source_type, &path, &self.types).ok_or_else(|| {
            hir_error("A residual closure ownership result path is absent from its runtime type.")
        })?;
        let witness = runtime_store_reuse_witness(&value, &self.types);
        Ok(Some((type_id, witness)))
    }

    pub(crate) fn finish_residual_function(
        &mut self,
        compilation: ResidualFunctionCompilation,
        value: Value,
    ) -> Result<Value, Diagnostic> {
        let observed_result_reuse = runtime_store_reuse_witness(&value, &self.types);
        let mut result = self
            .lower_value(&value, compilation.span)
            .map_err(|mut diagnostic| {
                diagnostic.message = format!(
                    "{} Residual function {} ({}) returned {} for runtime type {}.",
                    diagnostic.message,
                    compilation.name,
                    compilation.function,
                    crate::value::show(&value),
                    compilation.result_type,
                );
                diagnostic
            })?;
        if self
            .pending_recursive_types
            .contains(&compilation.result_type)
        {
            if result.type_id == compilation.result_type {
                let RuntimeType::Indirect { .. } = self.types[compilation.result_type] else {
                    return Err(hir_error(
                        "A pending recursive result lost its indirect representation.",
                    ));
                };
                if !self
                    .settled_recursive_types
                    .contains(&compilation.result_type)
                {
                    return Err(hir_error(
                        "A residual recursive result has no finite constructor case.",
                    ));
                }
            } else {
                result =
                    self.box_recursive_result(result, compilation.result_type, compilation.span)?;
            }
            self.pending_recursive_types
                .remove(&compilation.result_type);
            self.settled_recursive_types
                .remove(&compilation.result_type);
        } else if result.type_id != compilation.result_type {
            return Err(hir_error(&format!(
                "Residual function {} ({}) returned runtime type {} {:?}, but signature {} requires runtime type {} {:?}.",
                compilation.name,
                compilation.function,
                result.type_id,
                self.types[result.type_id],
                compilation.signature,
                compilation.result_type,
                self.types[compilation.result_type],
            )));
        }
        let end = self.current_block;
        self.blocks[end].terminator = Some(RuntimeTerminator::Return {
            value: result.id,
            span: self.span(compilation.span),
        });
        let blocks = self.take_blocks()?;
        self.functions.insert(
            compilation.function,
            simplify_runtime_function(RuntimeFunction {
                id: compilation.function,
                name: format!("blot$residual${}", compilation.name),
                signature: compilation.signature,
                reuse: compilation.reuse.then_some("checked"),
                entry_block: 0,
                blocks,
                span: self.span(compilation.source_span),
            }),
        );
        let identity = self
            .function_ids
            .iter_mut()
            .find(|identity| identity.function == compilation.function)
            .ok_or_else(|| hir_error("A residual function lost its specialization identity."))?;
        let result_reuse =
            settle_store_reuse_witness(&identity.result_reuse, &observed_result_reuse);
        identity.result_reuse = result_reuse.clone();
        let frame = self
            .function_frames
            .pop()
            .ok_or_else(|| hir_error("A residual function lost its caller frame."))?;
        self.blocks = frame.blocks;
        self.current_block = frame.current_block;
        self.next_value = frame.next_value;
        let call = self.direct_call(
            compilation.function,
            compilation.result_type,
            compilation.caller_arguments,
            compilation.span,
        )?;
        let call = apply_store_reuse_witness(&result_reuse, call, &self.types);
        let call = mark_reusable_stores(&compilation.result_ownership, call, &self.types);
        self.source = frame.source;
        Ok(call)
    }

    fn direct_call(
        &mut self,
        function: usize,
        result_type: usize,
        arguments: Vec<usize>,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        if let Some(identity) = self
            .function_ids
            .iter()
            .find(|identity| identity.function == function)
        {
            self.export_effects.extend(
                self.signatures[identity.runtime_signature]
                    .effects
                    .iter()
                    .cloned(),
            );
        }
        let result = self.next_value();
        let ownership = self.ownership(result_type);
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "call.direct",
            result,
            type_id: result_type,
            operands: arguments,
            ownership,
            span: runtime_span,
            value: None,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: Some(function),
            signature: None,
            static_store: None,
        });
        self.symbolic_value(
            RuntimeValue {
                id: result,
                type_id: result_type,
                meaning: RuntimeMeaning::Plain,
            },
            span,
        )
    }

    pub(crate) fn finish(
        mut self,
        value: Value,
        result_type: &Type,
    ) -> Result<RuntimeModule, Diagnostic> {
        let result = self.lower_value(&value, crate::ast::Span { start: 0, end: 0 })?;
        let expected = self.runtime_type_from_checked(result_type, &value)?;
        if result.type_id != expected {
            return Err(hir_error(
                "The residual result does not match its checked type.",
            ));
        }
        let end = self.current_block;
        self.blocks[end].terminator = Some(RuntimeTerminator::Return {
            value: result.id,
            span: self.span(crate::ast::Span { start: 0, end: 0 }),
        });
        let effects = self.capabilities.keys().cloned().collect::<Vec<_>>();
        let function_signature = self.signatures.len();
        self.signatures.push(RuntimeSignature {
            parameters: Vec::new(),
            result: expected,
            effects,
        });
        let blocks = self.take_blocks()?;
        let capabilities = std::mem::take(&mut self.capabilities)
            .into_iter()
            .map(|(name, operations)| RuntimeCapability {
                name,
                operations: {
                    let mut operations = operations
                        .into_iter()
                        .map(
                            |(name, (signature, ownership))| RuntimeCapabilityOperation {
                                name,
                                signature,
                                ownership,
                            },
                        )
                        .collect::<Vec<_>>();
                    operations.sort_by_key(|operation| operation.signature);
                    operations
                },
            })
            .collect();
        self.functions.insert(
            0,
            simplify_runtime_function(RuntimeFunction {
                id: 0,
                name: "blot$residual$blot:default".to_owned(),
                signature: function_signature,
                reuse: None,
                entry_block: 0,
                blocks,
                span: RuntimeSpan {
                    file: self.source.clone(),
                    start: 0,
                    end: 0,
                },
            }),
        );
        validate_runtime_layouts(&self.types)?;
        Ok(RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: self.source.clone(),
            types: self.types,
            signatures: self.signatures,
            static_stores: Vec::new(),
            functions: self.functions.into_values().collect(),
            capabilities,
            links: Vec::new(),
            exports: vec![RuntimeExport::Runtime {
                source_name: "default".to_owned(),
                phase: "runtime",
                wasm_name: "blot:default".to_owned(),
                function: 0,
                signature: function_signature,
                ownership: "owned",
            }],
        })
    }

    fn take_blocks(&mut self) -> Result<Vec<RuntimeBlock>, Diagnostic> {
        std::mem::take(&mut self.blocks)
            .into_iter()
            .map(|block| {
                let terminator = block.terminator.ok_or_else(|| {
                    hir_error(&format!("Residual block {} has no terminator.", block.id))
                })?;
                Ok(RuntimeBlock {
                    id: block.id,
                    parameters: block.parameters,
                    operations: block.operations,
                    terminator,
                })
            })
            .collect()
    }

    fn join_values(
        &mut self,
        consequent_block: usize,
        consequent: Value,
        alternate_block: usize,
        alternate: Value,
        span: crate::ast::Span,
    ) -> Result<(RuntimeValue, RuntimeValue), Diagnostic> {
        let runtime_and_tag = match (&consequent, &alternate) {
            (Value::Runtime(runtime), tag @ Value::Tag { .. }) => Some((
                consequent_block,
                runtime.clone(),
                alternate_block,
                tag.clone(),
                false,
            )),
            (tag @ Value::Tag { .. }, Value::Runtime(runtime)) => Some((
                alternate_block,
                runtime.clone(),
                consequent_block,
                tag.clone(),
                true,
            )),
            _ => None,
        };
        if let Some((runtime_block, runtime, tag_block, tag, reversed)) = runtime_and_tag
            && let Some((_, cases)) = self
                .sum_representation(runtime.type_id)
                .map(|(type_id, cases)| (type_id, cases.to_vec()))
        {
            let Value::Tag {
                name: tag_name,
                payload: tag_payload,
            } = &tag
            else {
                unreachable!("runtime-and-tag join contains a constructor")
            };
            if !cases.iter().any(|case_| case_.name == *tag_name) {
                let [existing_case] = cases.as_slice() else {
                    return Err(Diagnostic::new(
                        "BLOT_UNSUPPORTED_LOWERING",
                        "A conditional cannot widen a dynamic sum with more than one possible constructor.",
                        span,
                    ));
                };
                self.current_block = runtime_block;
                let existing_payload = self.sum_payload(&runtime, 0, span)?;
                let existing_tag = Value::Tag {
                    name: existing_case.name.clone(),
                    payload: if matches!(existing_payload, Value::Unit) {
                        None
                    } else {
                        Some(Box::new(existing_payload))
                    },
                };
                let tag_payload_type =
                    self.value_type(&compiler_tag_payload(tag_payload.as_deref()))?;
                let sum_type = self.sum_type(
                    &[existing_case.name.clone(), tag_name.clone()],
                    &[existing_case.payload_type, tag_payload_type],
                );
                let widened_runtime = self.lower_sum_member(&existing_tag, sum_type, span)?;
                self.current_block = tag_block;
                let lowered_tag = self.lower_sum_member(&tag, sum_type, span)?;
                return Ok(if reversed {
                    (lowered_tag, widened_runtime)
                } else {
                    (widened_runtime, lowered_tag)
                });
            }
        }
        if let Value::Runtime(consequent_runtime) = &consequent
            && matches!(alternate, Value::Tag { .. })
            && self
                .sum_representation(consequent_runtime.type_id)
                .is_some()
        {
            self.current_block = alternate_block;
            let alternate = self.lower_sum_member(&alternate, consequent_runtime.type_id, span)?;
            return Ok((consequent_runtime.clone(), alternate));
        }
        if let Value::Runtime(alternate_runtime) = &alternate
            && matches!(consequent, Value::Tag { .. })
            && self.sum_representation(alternate_runtime.type_id).is_some()
        {
            self.current_block = consequent_block;
            let consequent = self.lower_sum_member(&consequent, alternate_runtime.type_id, span)?;
            return Ok((consequent, alternate_runtime.clone()));
        }
        if matches!(
            (&consequent, &alternate),
            (
                Value::Tag {
                    name: consequent,
                    payload: None
                },
                Value::Tag {
                    name: alternate,
                    payload: None
                }
            ) if (consequent == "True" || consequent == "False")
                && (alternate == "True" || alternate == "False")
        ) {
            self.current_block = consequent_block;
            let consequent = self.lower_value(&consequent, span)?;
            self.current_block = alternate_block;
            let alternate = self.lower_value(&alternate, span)?;
            return Ok((consequent, alternate));
        }
        if let Value::Tag {
            name: consequent_name,
            payload: consequent_payload,
        } = &consequent
            && let Value::Tag {
                name: alternate_name,
                payload: alternate_payload,
            } = &alternate
            && consequent_name != alternate_name
        {
            let cases = vec![consequent_name.clone(), alternate_name.clone()];
            let consequent_payload = compiler_tag_payload(consequent_payload.as_deref());
            let alternate_payload = compiler_tag_payload(alternate_payload.as_deref());
            let consequent_payload_type = self.value_type(&consequent_payload)?;
            let alternate_payload_type = self.value_type(&alternate_payload)?;
            let sum_type =
                self.sum_type(&cases, &[consequent_payload_type, alternate_payload_type]);
            self.current_block = consequent_block;
            let consequent_payload = self.lower_value(&consequent_payload, span)?;
            let consequent = self.operation_with_case(
                "sum.make",
                sum_type,
                vec![consequent_payload.id],
                span,
                0,
            );
            self.current_block = alternate_block;
            let alternate_payload = self.lower_value(&alternate_payload, span)?;
            let alternate =
                self.operation_with_case("sum.make", sum_type, vec![alternate_payload.id], span, 1);
            let meaning = RuntimeMeaning::Sum { cases };
            return Ok((
                RuntimeValue {
                    meaning: meaning.clone(),
                    ..consequent
                },
                RuntimeValue {
                    meaning,
                    ..alternate
                },
            ));
        }
        if let Value::Runtime(consequent_runtime) = &consequent
            && !matches!(alternate, Value::Runtime(_))
        {
            self.current_block = alternate_block;
            let alternate = self.lower_value_as(&alternate, consequent_runtime.type_id, span)?;
            return Ok((consequent_runtime.clone(), alternate));
        }
        if let Value::Runtime(alternate_runtime) = &alternate
            && !matches!(consequent, Value::Runtime(_))
        {
            self.current_block = consequent_block;
            let consequent = self.lower_value_as(&consequent, alternate_runtime.type_id, span)?;
            return Ok((consequent, alternate_runtime.clone()));
        }
        self.current_block = consequent_block;
        let mut consequent = self.lower_value(&consequent, span)?;
        self.current_block = alternate_block;
        let mut alternate = self.lower_value(&alternate, span)?;
        if consequent.type_id != alternate.type_id {
            let consequent_target = match self.types[consequent.type_id] {
                RuntimeType::Indirect { target_type } => Some(target_type),
                _ => None,
            };
            let alternate_target = match self.types[alternate.type_id] {
                RuntimeType::Indirect { target_type } => Some(target_type),
                _ => None,
            };
            let consequent_unsettled = self.pending_recursive_types.contains(&consequent.type_id)
                && !self.settled_recursive_types.contains(&consequent.type_id);
            let alternate_unsettled = self.pending_recursive_types.contains(&alternate.type_id)
                && !self.settled_recursive_types.contains(&alternate.type_id);
            if consequent_target == Some(alternate.type_id) || consequent_unsettled {
                self.current_block = alternate_block;
                alternate = self.box_recursive_result(alternate, consequent.type_id, span)?;
            } else if alternate_target == Some(consequent.type_id) || alternate_unsettled {
                self.current_block = consequent_block;
                consequent = self.box_recursive_result(consequent, alternate.type_id, span)?;
            }
        }
        if consequent.type_id != alternate.type_id
            && let Some(joined_type) = self.join_runtime_type_pair(
                consequent.type_id,
                alternate.type_id,
                &mut HashSet::new(),
            )
        {
            self.current_block = consequent_block;
            consequent = self.coerce_runtime_value(&consequent, joined_type, span)?;
            self.current_block = alternate_block;
            alternate = self.coerce_runtime_value(&alternate, joined_type, span)?;
        }
        Ok((consequent, alternate))
    }

    fn lower_as(
        &mut self,
        value: Option<&Value>,
        expected: &str,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let value = value.ok_or_else(|| hir_error("A dynamic primitive omitted an operand."))?;
        let lowered = self.lower_value(value, span)?;
        let type_id = self
            .type_ids
            .get(expected)
            .copied()
            .unwrap_or_else(|| match expected {
                "signed-integer-64" => self.insert_type(expected, RuntimeType::SignedInteger64),
                "float-64" => self.insert_type(expected, RuntimeType::Float64),
                "float-32" => self.insert_type(expected, RuntimeType::Float32),
                _ => unreachable!("base residual type"),
            });
        if lowered.type_id != type_id {
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!(
                    "Dynamic primitive {} expected {expected}, found {}.",
                    self.active_primitive.as_deref().unwrap_or("<unknown>"),
                    self.type_description(&lowered)
                ),
                span,
            ));
        }
        Ok(lowered)
    }

    fn lower_typed_value(
        &mut self,
        value: &Value,
        type_: &Value,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        match (value, type_) {
            (Value::Tag { .. }, Value::Union(_)) => {
                let expected_type = self.type_from_type_value(type_)?;
                self.lower_value_as(value, expected_type, span)
            }
            (Value::Array(elements), Value::Array(element_types)) => {
                let element_type = element_types.first().ok_or_else(|| {
                    hir_error("A residual array signature omitted its element type.")
                })?;
                let element_type_id = self.type_from_type_value(element_type)?;
                let store_type = self.insert_type(
                    &format!("store:{element_type_id}"),
                    RuntimeType::Store {
                        element_type: element_type_id,
                    },
                );
                let elements = elements
                    .iter()
                    .map(|element| self.lower_typed_value(element, element_type, span))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                self.store_literal(store_type, elements, span, false)
            }
            (Value::Shape(fields), Value::Shape(field_types)) => {
                let type_id = self.type_from_type_value(type_)?;
                let RuntimeType::Product {
                    fields: runtime_fields,
                    ..
                } = self.types[type_id].clone()
                else {
                    unreachable!("shape type lowered to a non-product");
                };
                let mut operands = Vec::new();
                for field in runtime_fields {
                    let value = fields.get(&field.name).ok_or_else(|| {
                        hir_error("A residual argument omitted a signature field.")
                    })?;
                    let field_type = field_types.get(&field.name).ok_or_else(|| {
                        hir_error("A residual signature omitted an argument field.")
                    })?;
                    operands.push(self.lower_typed_value(value, field_type, span)?.id);
                }
                Ok(self.operation("product.make", type_id, operands, span, None))
            }
            _ => self.lower_value(value, span),
        }
    }

    fn lower_residual_argument(
        &mut self,
        value: &Value,
        type_: &Value,
        substitutions: &HashMap<u32, usize>,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        match (value, type_) {
            (_, Value::TypeVariable(variable)) => {
                let expected_type = substitutions.get(variable).copied().ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_RUST_INVARIANT",
                        format!(
                            "Residual argument type variable 't{variable} has no call-site representation."
                        ),
                        span,
                    )
                })?;
                self.lower_value_as(value, expected_type, span)
            }
            (Value::Shape(fields), Value::Shape(field_types)) => {
                let mut lowered_fields = Vec::new();
                for (name, field_type) in field_types {
                    let value = fields.get(name).ok_or_else(|| {
                        hir_error("A residual argument omitted a signature field.")
                    })?;
                    let lowered =
                        self.lower_residual_argument(value, field_type, substitutions, span)?;
                    lowered_fields.push((name.clone(), lowered));
                }
                lowered_fields.sort_by(|(left, _), (right, _)| left.cmp(right));
                let runtime_fields = lowered_fields
                    .iter()
                    .map(|(name, lowered)| RuntimeField {
                        name: name.clone(),
                        type_id: lowered.type_id,
                    })
                    .collect();
                let operands = lowered_fields
                    .into_iter()
                    .map(|(_, lowered)| lowered.id)
                    .collect();
                let type_id = self.insert_product_type(runtime_fields);
                Ok(self.operation("product.make", type_id, operands, span, None))
            }
            (Value::Array(elements), Value::Array(element_types)) if !elements.is_empty() => {
                let element_type = element_types.first().ok_or_else(|| {
                    hir_error("A residual array signature omitted its element type.")
                })?;
                let elements = elements
                    .iter()
                    .map(|element| {
                        self.lower_residual_argument(element, element_type, substitutions, span)
                    })
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                let element_type_id = elements
                    .first()
                    .expect("guarded non-empty residual array")
                    .type_id;
                if elements
                    .iter()
                    .any(|element| element.type_id != element_type_id)
                {
                    return Err(hir_error(
                        "A residual array argument has incompatible element representations.",
                    ));
                }
                let store_type = self.insert_type(
                    &format!("store:{element_type_id}"),
                    RuntimeType::Store {
                        element_type: element_type_id,
                    },
                );
                self.store_literal(store_type, elements, span, true)
            }
            (Value::Array(elements), expected) if elements.is_empty() => {
                if let Value::TypeVariable(variable) = expected
                    && let Some(type_id) = substitutions.get(variable).copied()
                    && matches!(self.types[type_id], RuntimeType::Store { .. })
                {
                    return Ok(self.array_operation(
                        "store.empty",
                        type_id,
                        Vec::new(),
                        span,
                        None,
                    ));
                }
                let Value::Array(_) = expected else {
                    return Err(hir_error(&format!(
                        "An empty residual array has no element representation in {}.",
                        crate::value::show(expected)
                    )));
                };
                self.lower_typed_value(value, expected, span)
            }
            (Value::DeferredScratch { .. }, expected) => {
                let mut substitutions = substitutions.clone();
                let scratch_type = self.specialized_type_from_type_value(
                    expected,
                    &mut substitutions,
                    &RepresentationFacts::default(),
                )?;
                if !matches!(self.types[scratch_type], RuntimeType::Scratch { .. }) {
                    return Err(hir_error(&format!(
                        "An empty residual Scratch has no element representation in {}.",
                        crate::value::show(expected)
                    )));
                }
                self.lower_value_as(value, scratch_type, span)
            }
            (Value::Scratch { values, .. }, expected) if values.is_empty() => {
                let mut substitutions = substitutions.clone();
                let scratch_type = self.specialized_type_from_type_value(
                    expected,
                    &mut substitutions,
                    &RepresentationFacts::default(),
                )?;
                if !matches!(self.types[scratch_type], RuntimeType::Scratch { .. }) {
                    return Err(hir_error(&format!(
                        "An empty residual Scratch has no element representation in {}.",
                        crate::value::show(expected)
                    )));
                }
                self.lower_value_as(value, scratch_type, span)
            }
            _ => self.lower_typed_value(value, type_, span),
        }
    }

    fn lower_value_as(
        &mut self,
        value: &Value,
        expected_type: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let unsettled_recursive_type = self.pending_recursive_types.contains(&expected_type)
            && !self.settled_recursive_types.contains(&expected_type);
        if unsettled_recursive_type {
            let lowered = self.lower_value(value, span)?;
            if lowered.type_id == expected_type {
                return Ok(lowered);
            }
            return self.box_recursive_result(lowered, expected_type, span);
        }
        if matches!(value, Value::Tag { .. }) && self.sum_representation(expected_type).is_some() {
            return self.lower_sum_member(value, expected_type, span);
        }
        if let Value::Runtime(runtime) = value {
            return self.coerce_runtime_value(runtime, expected_type, span);
        }
        match (value, self.types[expected_type].clone()) {
            (Value::Shape(fields), RuntimeType::Product { fields: layout, .. }) => {
                let mut operands = Vec::new();
                for field in layout {
                    let value = fields.get(&field.name).ok_or_else(|| {
                        Diagnostic::new(
                            "BLOT_RUST_INVARIANT",
                            format!(
                                "A residual argument omitted the checked field `{}`.",
                                field.name
                            ),
                            span,
                        )
                    })?;
                    operands.push(self.lower_value_as(value, field.type_id, span)?.id);
                }
                Ok(self.operation("product.make", expected_type, operands, span, None))
            }
            (Value::Array(elements), RuntimeType::Store { element_type }) => {
                let elements = elements
                    .iter()
                    .map(|element| self.lower_value_as(element, element_type, span))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                self.store_literal(expected_type, elements, span, true)
            }
            (Value::DeferredScratch { capacity }, RuntimeType::Scratch { .. }) => {
                let capacity = self.lower_as(Some(capacity), "signed-integer-64", span)?;
                Ok(self.operation(
                    "scratch.with-capacity",
                    expected_type,
                    vec![capacity.id],
                    span,
                    None,
                ))
            }
            (Value::Scratch { values, capacity }, RuntimeType::Scratch { .. })
                if values.is_empty() =>
            {
                let integer = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
                let capacity = self.constant(
                    WireConstant::SignedInteger64(capacity.to_string()),
                    integer,
                    span,
                );
                Ok(self.operation(
                    "scratch.with-capacity",
                    expected_type,
                    vec![capacity.id],
                    span,
                    None,
                ))
            }
            _ => {
                let lowered = self.lower_value(value, span)?;
                if lowered.type_id != expected_type {
                    return Err(Diagnostic::new(
                        "BLOT_RUST_INVARIANT",
                        format!(
                            "A residual argument has runtime type {} {:?}, but checking requires runtime type {} {:?}.",
                            lowered.type_id,
                            self.types[lowered.type_id],
                            expected_type,
                            self.types[expected_type],
                        ),
                        span,
                    ));
                }
                Ok(lowered)
            }
        }
    }

    fn coerce_runtime_value(
        &mut self,
        value: &RuntimeValue,
        expected_type: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        if value.type_id == expected_type {
            return Ok(value.clone());
        }
        match (
            self.types[value.type_id].clone(),
            self.types[expected_type].clone(),
        ) {
            (_, RuntimeType::Indirect { target_type }) => {
                let value = self.coerce_runtime_value(value, target_type, span)?;
                Ok(self.operation("indirect.make", expected_type, vec![value.id], span, None))
            }
            (
                RuntimeType::Product {
                    fields: source_fields,
                    ..
                },
                RuntimeType::Product {
                    fields: expected_fields,
                    ..
                },
            ) if source_fields.len() == expected_fields.len() => {
                let mut operands = Vec::with_capacity(expected_fields.len());
                for expected_field in expected_fields {
                    let (source_index, source_field) = source_fields
                        .iter()
                        .enumerate()
                        .find(|(_, field)| field.name == expected_field.name)
                        .ok_or_else(|| {
                            hir_error(&format!(
                                "A checked record representation omitted field `{}`.",
                                expected_field.name
                            ))
                        })?;
                    let projected =
                        self.project_field(value, source_index, source_field.type_id, span);
                    let coerced =
                        self.coerce_runtime_value(&projected, expected_field.type_id, span)?;
                    operands.push(coerced.id);
                }
                Ok(self.operation("product.make", expected_type, operands, span, None))
            }
            (RuntimeType::Sum { cases, .. }, _) if cases.len() == 1 => {
                let (expected_sum, expected_cases) = self
                    .sum_representation(expected_type)
                    .map(|(type_id, cases)| (type_id, cases.to_vec()))
                    .ok_or_else(|| {
                        hir_error("A checked sum representation was joined with a non-sum type.")
                    })?;
                let source_case = &cases[0];
                let expected_case = expected_cases
                    .iter()
                    .position(|case_| case_.name == source_case.name)
                    .ok_or_else(|| {
                        hir_error(&format!(
                            "Constructor `#{}` is absent from its joined runtime type.",
                            source_case.name
                        ))
                    })?;
                let payload = self.sum_payload(value, 0, span)?;
                let payload = self.lower_value_as(
                    &payload,
                    expected_cases[expected_case].payload_type,
                    span,
                )?;
                let mut widened = self.operation_with_case(
                    "sum.make",
                    expected_sum,
                    vec![payload.id],
                    span,
                    expected_case,
                );
                if expected_sum != expected_type {
                    widened = self.operation(
                        "indirect.make",
                        expected_type,
                        vec![widened.id],
                        span,
                        None,
                    );
                }
                Ok(widened)
            }
            _ => Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                format!(
                    "A residual argument has runtime type {} {:?}, but checking requires runtime type {} {:?}.",
                    value.type_id,
                    self.types[value.type_id],
                    expected_type,
                    self.types[expected_type],
                ),
                span,
            )),
        }
    }

    fn lower_value(
        &mut self,
        value: &Value,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        match value {
            Value::Runtime(value) => Ok(value.clone()),
            Value::Unit => Ok(self.constant(WireConstant::Unit, 0, span)),
            Value::Text(value) => Ok(self.constant(WireConstant::Text(value.clone()), 3, span)),
            Value::Int(value) => {
                let type_id = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
                Ok(self.constant(
                    WireConstant::SignedInteger64(value.to_string()),
                    type_id,
                    span,
                ))
            }
            Value::Float(value) => {
                let type_id = self.insert_type("float-64", RuntimeType::Float64);
                Ok(self.constant(WireConstant::Float64(*value), type_id, span))
            }
            Value::Float32(value) => {
                let type_id = self.insert_type("float-32", RuntimeType::Float32);
                Ok(self.constant(WireConstant::Float32(*value), type_id, span))
            }
            Value::Vector(lanes) => {
                let float_type = self.insert_type("float-32", RuntimeType::Float32);
                let vector_type = self.insert_type(
                    "vector:f32x4",
                    RuntimeType::Vector {
                        element: "float-32",
                        lanes: 4,
                    },
                );
                let operands = lanes
                    .iter()
                    .map(|lane| {
                        self.constant(WireConstant::Float32(*lane), float_type, span)
                            .id
                    })
                    .collect();
                Ok(self.simd_operation("make", vector_type, operands, span, None))
            }
            Value::VectorMask(lanes) => {
                let float_type = self.insert_type("float-32", RuntimeType::Float32);
                let vector_type = self.insert_type(
                    "vector:f32x4",
                    RuntimeType::Vector {
                        element: "float-32",
                        lanes: 4,
                    },
                );
                let mask_type = self.insert_type(
                    "mask:f32x4",
                    RuntimeType::Mask {
                        element: "float-32",
                        lanes: 4,
                    },
                );
                let operands = lanes
                    .iter()
                    .map(|lane| {
                        self.constant(
                            WireConstant::Float32(if *lane { 1.0 } else { 0.0 }),
                            float_type,
                            span,
                        )
                        .id
                    })
                    .collect();
                let encoded = self.simd_operation("make", vector_type, operands, span, None);
                let zero_lane = self.constant(WireConstant::Float32(0.0), float_type, span);
                let zero =
                    self.simd_operation("splat", vector_type, vec![zero_lane.id], span, None);
                Ok(self.simd_operation(
                    "not-equal",
                    mask_type,
                    vec![encoded.id, zero.id],
                    span,
                    None,
                ))
            }
            Value::IntegerVector { bits, lanes } => {
                let lane_count = u8::try_from(lanes.len()).expect("SIMD lane count fits u8");
                let vector_key = format!("vector:I{bits}x{lane_count}");
                let type_id = self.insert_type(
                    &vector_key,
                    RuntimeType::Vector {
                        element: match bits {
                            32 => "integer-32",
                            16 => "integer-16",
                            _ => "integer-8",
                        },
                        lanes: lane_count,
                    },
                );
                if *bits < 32 && lanes.iter().all(|lane| lane == &lanes[0]) {
                    let lane = self.constant(WireConstant::SignedInteger32(lanes[0]), 2, span);
                    return Ok(self.simd_operation("splat", type_id, vec![lane.id], span, None));
                }
                let operands = lanes
                    .iter()
                    .map(|lane| {
                        self.constant(WireConstant::SignedInteger32(*lane), 2, span)
                            .id
                    })
                    .collect();
                Ok(self.simd_operation("make", type_id, operands, span, None))
            }
            Value::IntegerVectorMask { bits, lanes } => {
                let lane_count = u8::try_from(lanes.len()).expect("SIMD lane count fits u8");
                let vector_key = format!("vector:I{bits}x{lane_count}");
                let vector_type = self.insert_type(
                    &vector_key,
                    RuntimeType::Vector {
                        element: match bits {
                            32 => "integer-32",
                            16 => "integer-16",
                            _ => "integer-8",
                        },
                        lanes: lane_count,
                    },
                );
                let mask_key = format!("mask:I{bits}x{lane_count}");
                let mask_type = self.insert_type(
                    &mask_key,
                    RuntimeType::Mask {
                        element: match bits {
                            32 => "integer-32",
                            16 => "integer-16",
                            _ => "integer-8",
                        },
                        lanes: lane_count,
                    },
                );
                let non_uniform = lanes.iter().any(|lane| lane != &lanes[0]);
                if non_uniform && *bits < 32 {
                    return Err(Diagnostic::new(
                        "BLOT_UNSUPPORTED_LOWERING",
                        "A non-uniform narrow SIMD mask is outside the Rust residual calculus.",
                        span,
                    ));
                }
                let encoded = if non_uniform {
                    let operands = lanes
                        .iter()
                        .map(|lane| {
                            self.constant(WireConstant::SignedInteger32(i32::from(*lane)), 2, span)
                                .id
                        })
                        .collect();
                    self.simd_operation("make", vector_type, operands, span, None)
                } else {
                    let lane =
                        self.constant(WireConstant::SignedInteger32(i32::from(lanes[0])), 2, span);
                    self.simd_operation("splat", vector_type, vec![lane.id], span, None)
                };
                let zero_lane = self.constant(WireConstant::SignedInteger32(0), 2, span);
                let zero =
                    self.simd_operation("splat", vector_type, vec![zero_lane.id], span, None);
                Ok(self.simd_operation(
                    "not-equal",
                    mask_type,
                    vec![encoded.id, zero.id],
                    span,
                    None,
                ))
            }
            Value::Tag {
                name,
                payload: None,
            } if name == "True" || name == "False" => {
                Ok(self.constant(WireConstant::Boolean(name == "True"), 1, span))
            }
            Value::Tag { name, payload } => {
                let payload = compiler_tag_payload(payload.as_deref());
                let payload_type = self.value_type(&payload)?;
                let sum_type = self.sum_type(std::slice::from_ref(name), &[payload_type]);
                let payload = self.lower_value(&payload, span)?;
                let mut tagged =
                    self.operation_with_case("sum.make", sum_type, vec![payload.id], span, 0);
                tagged.meaning = RuntimeMeaning::Sum {
                    cases: vec![name.clone()],
                };
                Ok(tagged)
            }
            Value::Shape(fields) => {
                if let Some(expected_type) = self.checked_aggregate_representations.get(value) {
                    return self.lower_value_as(value, expected_type, span);
                }
                let type_id = self.product_type(fields).map_err(|mut diagnostic| {
                    diagnostic.message = format!(
                        "{} Residual shape {} has no settled aggregate representation.",
                        diagnostic.message,
                        crate::value::show(value),
                    );
                    diagnostic
                })?;
                let mut operands = Vec::new();
                let RuntimeType::Product {
                    fields: runtime_fields,
                    ..
                } = self.types[type_id].clone()
                else {
                    unreachable!("product_type returned a non-product type");
                };
                for field in runtime_fields {
                    let value = fields
                        .get(&field.name)
                        .expect("product type contains an unknown field");
                    operands.push(self.lower_value(value, span)?.id);
                }
                Ok(self.operation("product.make", type_id, operands, span, None))
            }
            Value::Array(elements) => {
                let (store_type, element_type) = if let Some(store_type) =
                    self.checked_aggregate_representations.get(value)
                {
                    let RuntimeType::Store { element_type } = self.types[store_type] else {
                        return Err(Diagnostic::new(
                            "BLOT_RUST_INVARIANT",
                            "A checked array value has a non-Store runtime representation.",
                            span,
                        ));
                    };
                    (store_type, element_type)
                } else {
                    let first = elements.first().ok_or_else(|| {
                        hir_error("An untyped empty residual array has no element representation.")
                    })?;
                    let element_type = self.value_type(first)?;
                    let store_type = self.insert_type(
                        &format!("store:{element_type}"),
                        RuntimeType::Store { element_type },
                    );
                    (store_type, element_type)
                };
                let elements = elements
                    .iter()
                    .map(|element| self.lower_store_element(element, element_type, span))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                self.store_literal(store_type, elements, span, true)
            }
            Value::EmptyArray { element } => {
                let element_type = self.type_from_type_value(element)?;
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                let mut store =
                    self.array_operation("store.empty", store_type, Vec::new(), span, None);
                store.meaning = RuntimeMeaning::ReusableStore;
                Ok(store)
            }
            Value::Scratch { values, capacity } => {
                let first = values.first().ok_or_else(|| {
                    hir_error("An untyped empty residual Scratch has no element representation.")
                })?;
                let element_type = self.value_type(first)?;
                let scratch_type = self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                );
                let integer = self.insert_type("signed-integer-64", RuntimeType::SignedInteger64);
                let capacity = self.constant(
                    WireConstant::SignedInteger64(capacity.to_string()),
                    integer,
                    span,
                );
                let mut scratch = self.operation(
                    "scratch.with-capacity",
                    scratch_type,
                    vec![capacity.id],
                    span,
                    None,
                );
                for value in values {
                    let value = self.lower_store_element(value, element_type, span)?;
                    scratch = self.operation(
                        "scratch.push",
                        scratch_type,
                        vec![scratch.id, value.id],
                        span,
                        None,
                    );
                }
                Ok(scratch)
            }
            // A witness is element-free proof; at runtime it is erased to
            // unit, because ownership already discharged the pairing.
            Value::RegionRejoin { .. } => Ok(self.constant(WireConstant::Unit, 0, span)),
            Value::Region { store, start, end } => {
                // A comptime Region crossing into residual code materializes
                // its private backing Store once; linearity guarantees exactly
                // one consuming residual site, so no second copy can appear.
                let cells = store.borrow().clone();
                let first = cells.first().ok_or_else(|| {
                    hir_error("An empty residual Region has no element representation.")
                })?;
                let element_type = self.value_type(first)?;
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                let elements = cells
                    .iter()
                    .map(|element| self.lower_store_element(element, element_type, span))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                let runtime_store = self.store_literal(store_type, elements, span, false)?;
                let integer = self.region_integer_type();
                let start = self.constant(
                    WireConstant::SignedInteger64(start.to_string()),
                    integer,
                    span,
                );
                let end = self.constant(
                    WireConstant::SignedInteger64(end.to_string()),
                    integer,
                    span,
                );
                self.make_region(runtime_store, start, end, span)
            }
            Value::ClosureChoice { alternatives, .. } => Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                closure_choice_refusal(alternatives.len()),
                span,
            )),
            // Known deferred calls have already become ordinary control flow.
            // A deferred closure reaching value lowering escaped that
            // normalization and would require a runtime thunk convention.
            Value::Closure { deferred: true, .. } => Err(Diagnostic::new(
                "BLOT_DEFERRED_AT_RUNTIME",
                concat!(
                    "This deferred function escapes known call sites. Runtime HIR has no thunk ",
                    "value or public deferred calling convention; apply it where its source is ",
                    "known, or store an explicit nullary function instead."
                ),
                span,
            )),
            _ => Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!(
                    "{} is outside the Rust residual value calculus.",
                    crate::value::show(value)
                ),
                span,
            )),
        }
    }

    fn lower_store_element(
        &mut self,
        value: &Value,
        expected_type: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        self.lower_value_as(value, expected_type, span)
    }

    fn lower_primitive_argument(
        &mut self,
        value: &Value,
        checked_type: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let Some(checked_type) = checked_type else {
            return self.lower_value(value, span);
        };
        if !has_unresolved_representation(checked_type, &HashMap::new()) {
            let expected_type = self.type_from_type_value(checked_type)?;
            return self.lower_value_as(value, expected_type, span);
        }
        if let Some(expected_type) = self.checked_aggregate_representations.get(value) {
            return self.lower_value_as(value, expected_type, span);
        }
        self.lower_value(value, span)
    }

    pub(crate) fn append_array_element(
        &mut self,
        array: &Value,
        element: &Value,
        checked_array_type: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let (store, element) = match array {
            Value::Array(elements) => {
                let checked_store_type = match checked_array_type {
                    Some(type_) if !has_unresolved_representation(type_, &HashMap::new()) => {
                        Some(self.type_from_type_value(type_)?)
                    }
                    _ => None,
                };
                let (store_type, element) = match checked_store_type {
                    Some(store_type) => {
                        let RuntimeType::Store { element_type } = self.types[store_type] else {
                            return Err(Diagnostic::new(
                                "BLOT_RUST_INVARIANT",
                                "A checked residual array has a non-Store representation.",
                                span,
                            ));
                        };
                        (
                            store_type,
                            self.lower_store_element(element, element_type, span)?,
                        )
                    }
                    None => {
                        let element = self.lower_value(element, span)?;
                        let store_type = self.insert_type(
                            &format!("store:{}", element.type_id),
                            RuntimeType::Store {
                                element_type: element.type_id,
                            },
                        );
                        (store_type, element)
                    }
                };
                let prefix = elements
                    .iter()
                    .map(|prefix| self.lower_store_element(prefix, element.type_id, span))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                let store = self.store_literal(store_type, prefix, span, false)?;
                (store, element)
            }
            _ => {
                let store = self.lower_value(array, span)?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(Diagnostic::new(
                        "BLOT_RUST_INVARIANT",
                        "A residual array element was appended to a non-Store value.",
                        span,
                    ));
                };
                let element = self.lower_store_element(element, element_type, span)?;
                (store, element)
            }
        };
        let store = self.array_operation(
            "store.grow",
            store.type_id,
            vec![store.id, element.id],
            span,
            Some("persistent"),
        );
        Ok(Value::Runtime(store))
    }

    pub(crate) fn append_array_spread(
        &mut self,
        array: &Value,
        spread: &Value,
        checked_array_type: Option<&Value>,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let source = self.lower_value(spread, span)?;
        let RuntimeType::Store { element_type } = self.types[source.type_id] else {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                "A typechecked residual array spread lowered to a non-Store value.",
                span,
            ));
        };
        if let Some(checked_array_type) = checked_array_type
            && !has_unresolved_representation(checked_array_type, &HashMap::new())
        {
            let expected_store = self.type_from_type_value(checked_array_type)?;
            if source.type_id != expected_store {
                return Err(Diagnostic::new(
                    "BLOT_RUST_INVARIANT",
                    format!(
                        "A checked residual array spread has Store representation {}, but checking requires {}.",
                        source.type_id, expected_store
                    ),
                    span,
                ));
            }
        }
        let mut output = match array {
            Value::Array(elements) => {
                let prefix = elements
                    .iter()
                    .map(|element| self.lower_store_element(element, element_type, span))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                self.store_literal(source.type_id, prefix, span, false)?
            }
            _ => {
                let output = self.lower_value(array, span)?;
                if output.type_id != source.type_id {
                    return Err(Diagnostic::new(
                        "BLOT_RUST_INVARIANT",
                        format!(
                            "A typechecked residual array spread mixed Store representations {} and {}.",
                            output.type_id, source.type_id
                        ),
                        span,
                    ));
                }
                output
            }
        };
        let integer = self.region_integer_type();
        let start = self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let end = self.operation("store.length", integer, vec![source.id], span, None);
        output = self.append_store_range(
            &source,
            &start,
            &end,
            &output,
            StoreRangeDestination::Shared,
            span,
        )?;
        Ok(Value::Runtime(output))
    }

    fn lower_sum_member(
        &mut self,
        value: &Value,
        expected_type: usize,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let Value::Tag { name, payload } = value else {
            return Err(hir_error(
                "A sum injection received a non-constructor value.",
            ));
        };
        let (sum_type, cases) = self
            .sum_representation(expected_type)
            .map(|(sum_type, cases)| (sum_type, cases.to_vec()))
            .ok_or_else(|| hir_error("A sum injection received a non-sum runtime type."))?;
        let case = cases
            .iter()
            .position(|case_| case_.name == *name)
            .ok_or_else(|| {
                hir_error(&format!(
                    "Constructor `#{name}` is absent from its inferred sum type."
                ))
            })?;
        let payload = compiler_tag_payload(payload.as_deref());
        let lowered = self.lower_value_as(&payload, cases[case].payload_type, span)?;
        if lowered.type_id != cases[case].payload_type {
            return Err(hir_error(&format!(
                "Constructor `#{name}` has runtime payload type {}, but its inferred sum expects {}.",
                lowered.type_id, cases[case].payload_type
            )));
        }
        let mut tagged =
            self.operation_with_case("sum.make", sum_type, vec![lowered.id], span, case);
        if sum_type != expected_type {
            tagged = self.operation("indirect.make", expected_type, vec![tagged.id], span, None);
        }
        tagged.meaning = RuntimeMeaning::Sum {
            cases: cases.iter().map(|case_| case_.name.clone()).collect(),
        };
        Ok(tagged)
    }

    fn value_type(&mut self, value: &Value) -> Result<usize, Diagnostic> {
        if let Some(type_id) = self.checked_aggregate_representations.get(value) {
            return Ok(type_id);
        }
        match value {
            Value::Runtime(value) => Ok(value.type_id),
            Value::Unit => Ok(0),
            Value::Text(_) => Ok(3),
            Value::Int(_) => {
                Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64))
            }
            Value::Float(_) => Ok(self.insert_type("float-64", RuntimeType::Float64)),
            Value::Float32(_) => Ok(self.insert_type("float-32", RuntimeType::Float32)),
            Value::Vector(_) => Ok(self.insert_type(
                "vector:f32x4",
                RuntimeType::Vector {
                    element: "float-32",
                    lanes: 4,
                },
            )),
            Value::VectorMask(_) => Ok(self.insert_type(
                "mask:f32x4",
                RuntimeType::Mask {
                    element: "float-32",
                    lanes: 4,
                },
            )),
            Value::IntegerVector { bits, lanes } => {
                let vector_key = format!("vector:I{bits}x{}", lanes.len());
                Ok(self.insert_type(
                    &vector_key,
                    RuntimeType::Vector {
                        element: match bits {
                            32 => "integer-32",
                            16 => "integer-16",
                            _ => "integer-8",
                        },
                        lanes: u8::try_from(lanes.len()).expect("SIMD lane count fits u8"),
                    },
                ))
            }
            Value::IntegerVectorMask { bits, lanes } => {
                let mask_key = format!("mask:I{bits}x{}", lanes.len());
                Ok(self.insert_type(
                    &mask_key,
                    RuntimeType::Mask {
                        element: match bits {
                            32 => "integer-32",
                            16 => "integer-16",
                            _ => "integer-8",
                        },
                        lanes: u8::try_from(lanes.len()).expect("SIMD lane count fits u8"),
                    },
                ))
            }
            Value::Tag {
                name,
                payload: None,
            } if name == "True" || name == "False" => Ok(1),
            Value::Tag { name, payload } => {
                let payload_type = match payload {
                    Some(payload) => self.value_type(payload)?,
                    None => 0,
                };
                Ok(self.sum_type(std::slice::from_ref(name), &[payload_type]))
            }
            Value::Shape(fields) => self.product_type(fields),
            Value::ClosureChoice { alternatives, .. } => {
                Err(hir_error(&closure_choice_refusal(alternatives.len())))
            }
            Value::Array(elements) => {
                let element = elements.first().ok_or_else(|| {
                    hir_error("An untyped empty residual array has no element representation.")
                })?;
                let element_type = self.value_type(element)?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Value::EmptyArray { element } => {
                let element_type = self.type_from_type_value(element)?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Value::Scratch { values, .. } => {
                let element = values.first().ok_or_else(|| {
                    hir_error("An untyped empty Scratch has no element representation.")
                })?;
                let element_type = self.value_type(element)?;
                Ok(self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                ))
            }
            _ => {
                let operation = self
                    .active_primitive
                    .as_deref()
                    .unwrap_or("a residual value");
                Err(hir_error(&format!(
                    "{} has no first-order runtime type while lowering {operation}.",
                    crate::value::show(value)
                )))
            }
        }
    }

    fn type_from_type_value(&mut self, value: &Value) -> Result<usize, Diagnostic> {
        match value {
            Value::Unit | Value::Unbounded => Ok(0),
            Value::Int(_) => {
                Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64))
            }
            Value::Text(_) => Ok(3),
            Value::Float(_) => Ok(self.insert_type("float-64", RuntimeType::Float64)),
            Value::Float32(_) => Ok(self.insert_type("float-32", RuntimeType::Float32)),
            Value::Range {
                domain: Some(crate::value::Domain::Text),
                ..
            } => Ok(3),
            Value::Range {
                domain: Some(crate::value::Domain::Int),
                ..
            } => Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64)),
            Value::Range {
                domain: Some(crate::value::Domain::Float),
                ..
            } => Ok(self.insert_type("float-64", RuntimeType::Float64)),
            Value::Range {
                domain: Some(crate::value::Domain::Float32),
                ..
            } => Ok(self.insert_type("float-32", RuntimeType::Float32)),
            Value::Shape(fields) => {
                let mut runtime_fields = Vec::new();
                for (name, field) in fields {
                    runtime_fields.push(RuntimeField {
                        name: name.clone(),
                        type_id: self.type_from_type_value(field)?,
                    });
                }
                Ok(self.insert_product_type(runtime_fields))
            }
            Value::OpaqueType(name) if simd_layout(name).is_some() => {
                let layout = simd_layout(name).expect("matched SIMD type");
                Ok(self.insert_type(&layout.key(), layout.runtime_type()))
            }
            Value::Array(elements) => {
                let element = elements
                    .first()
                    .ok_or_else(|| hir_error("A residual array type omitted its element type."))?;
                let element_type = self.type_from_type_value(element)?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Value::ScratchType(element) => {
                let element_type = self.type_from_type_value(element)?;
                Ok(self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                ))
            }
            Value::Union(members) => {
                if members
                    .iter()
                    .all(|member| matches!(member, Value::Tag { .. }))
                {
                    let mut cases = Vec::new();
                    let mut payload_types = Vec::new();
                    for member in members {
                        let Value::Tag { name, payload } = member else {
                            unreachable!("all union members are tags")
                        };
                        if cases.contains(name) {
                            continue;
                        }
                        let payload = compiler_tag_payload(payload.as_deref());
                        cases.push(name.clone());
                        payload_types.push(self.type_from_type_value(&payload)?);
                    }
                    if cases.len() == 2
                        && cases.iter().any(|name| name == "False")
                        && cases.iter().any(|name| name == "True")
                        && payload_types.iter().all(|type_id| *type_id == 0)
                    {
                        return Ok(1);
                    }
                    return Ok(self.sum_type(&cases, &payload_types));
                }
                let mut members = members.iter();
                let first_member = members
                    .next()
                    .ok_or_else(|| hir_error("A residual union type has no members."))?;
                let first = self.type_from_type_value(first_member)?;
                for member in members {
                    let representation = self.type_from_type_value(member)?;
                    if representation != first {
                        return Err(hir_error(&format!(
                            "Residual union member {} has runtime type {representation}, but {} has runtime type {first}.",
                            crate::value::show(member),
                            crate::value::show(first_member),
                        )));
                    }
                }
                Ok(first)
            }
            Value::Sealed { name, inner } => {
                let representation_type = self.type_from_type_value(inner)?;
                Ok(self.insert_type(
                    &format!("sealed:{name}:{representation_type}"),
                    RuntimeType::Sealed {
                        name: name.clone(),
                        representation_type,
                    },
                ))
            }
            Value::Extended { inner, .. } => self.type_from_type_value(inner),
            _ => Err(hir_error(&format!(
                "{} is outside the Rust residual type calculus while lowering {}.",
                crate::value::show(value),
                self.active_primitive
                    .as_deref()
                    .unwrap_or("a runtime value")
            ))),
        }
    }

    fn record_runtime_substitutions(
        &mut self,
        expected: &Value,
        actual: &Value,
        substitutions: &mut HashMap<u32, usize>,
        representation_facts: &mut RepresentationFacts,
    ) -> Result<(), Diagnostic> {
        if let Ok(type_id) = self.value_type(actual) {
            representation_facts.record(expected, type_id);
            self.record_runtime_type_substitutions(expected, type_id, substitutions)?;
            return Ok(());
        }
        match expected {
            Value::TypeVariable(variable) => {
                if matches!(actual, Value::Array(elements) if elements.is_empty()) {
                    return Ok(());
                }
                let Ok(type_id) = self.value_type(actual) else {
                    return Ok(());
                };
                if let Some(previous) = substitutions.insert(*variable, type_id)
                    && previous != type_id
                {
                    return Err(hir_error(&format!(
                        "Residual type variable 't{variable} received runtime representations {previous} {:?} and {type_id} {:?}.",
                        self.types[previous], self.types[type_id]
                    )));
                }
            }
            Value::Shape(expected_fields) => {
                let Value::Shape(actual_fields) = actual else {
                    return Ok(());
                };
                for (name, expected_field) in expected_fields {
                    if let Some(actual_field) = actual_fields.get(name) {
                        self.record_runtime_substitutions(
                            expected_field,
                            actual_field,
                            substitutions,
                            representation_facts,
                        )?;
                    }
                }
            }
            Value::Array(expected_elements) => {
                let Some(expected_element) = expected_elements.first() else {
                    return Err(hir_error("A residual array type omitted its element type."));
                };
                if let Value::Array(actual_elements) = actual
                    && let Some(actual_element) = actual_elements.first()
                {
                    self.record_runtime_substitutions(
                        expected_element,
                        actual_element,
                        substitutions,
                        representation_facts,
                    )?;
                }
            }
            Value::ScratchType(expected_element) => {
                if let Value::Runtime(actual) = actual
                    && let RuntimeType::Scratch { element_type } = self.types[actual.type_id]
                {
                    representation_facts.record(expected_element, element_type);
                }
            }
            Value::Union(members) => {
                for member in members {
                    self.record_runtime_substitutions(
                        member,
                        actual,
                        substitutions,
                        representation_facts,
                    )?;
                }
            }
            Value::Extended { inner, .. }
            | Value::Sealed { inner, .. }
            | Value::Forall { body: inner, .. } => {
                self.record_runtime_substitutions(
                    inner,
                    actual,
                    substitutions,
                    representation_facts,
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    fn record_checked_runtime_substitutions(
        &mut self,
        expected: &Value,
        checked_actual: &Value,
        substitutions: &mut HashMap<u32, usize>,
        representation_facts: &mut RepresentationFacts,
    ) -> Result<(), Diagnostic> {
        if let Ok(type_id) = self.type_from_type_value(checked_actual) {
            representation_facts.record(expected, type_id);
            self.record_runtime_type_substitutions(expected, type_id, substitutions)?;
        }
        match (expected, checked_actual) {
            (Value::Shape(expected_fields), Value::Shape(actual_fields)) => {
                for (name, expected_field) in expected_fields {
                    if let Some(actual_field) = actual_fields.get(name) {
                        self.record_checked_runtime_substitutions(
                            expected_field,
                            actual_field,
                            substitutions,
                            representation_facts,
                        )?;
                    }
                }
            }
            (Value::Array(expected), Value::Array(actual)) => {
                let expected = expected
                    .first()
                    .ok_or_else(|| hir_error("A residual Array type omitted its element type."))?;
                let actual = actual.first().ok_or_else(|| {
                    hir_error("A checked residual Array type omitted its element type.")
                })?;
                self.record_checked_runtime_substitutions(
                    expected,
                    actual,
                    substitutions,
                    representation_facts,
                )?;
            }
            (Value::ScratchType(expected), Value::ScratchType(actual))
            | (Value::RegionType(expected), Value::RegionType(actual)) => {
                self.record_checked_runtime_substitutions(
                    expected,
                    actual,
                    substitutions,
                    representation_facts,
                )?;
            }
            (
                Value::Extended {
                    inner: expected, ..
                }
                | Value::Sealed {
                    inner: expected, ..
                }
                | Value::Forall { body: expected, .. },
                actual,
            ) => {
                self.record_checked_runtime_substitutions(
                    expected,
                    actual,
                    substitutions,
                    representation_facts,
                )?;
            }
            (
                expected,
                Value::Extended { inner: actual, .. } | Value::Sealed { inner: actual, .. },
            ) => {
                self.record_checked_runtime_substitutions(
                    expected,
                    actual,
                    substitutions,
                    representation_facts,
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    fn record_runtime_type_substitutions(
        &self,
        expected: &Value,
        actual_type: usize,
        substitutions: &mut HashMap<u32, usize>,
    ) -> Result<(), Diagnostic> {
        if let Value::TypeVariable(variable) = expected {
            if let Some(previous) = substitutions.insert(*variable, actual_type)
                && previous != actual_type
            {
                return Err(hir_error(&format!(
                    "Residual type variable 't{variable} received runtime representations {previous} {:?} and {actual_type} {:?}.",
                    self.types[previous], self.types[actual_type]
                )));
            }
            return Ok(());
        }
        let runtime = self.types.get(actual_type).ok_or_else(|| {
            hir_error("A residual call-site representation references an absent runtime type.")
        })?;
        match (expected, runtime) {
            (Value::Shape(expected_fields), RuntimeType::Product { fields, .. }) => {
                for (name, expected_field) in expected_fields {
                    let Some(actual_field) = fields.iter().find(|field| field.name == *name) else {
                        continue;
                    };
                    self.record_runtime_type_substitutions(
                        expected_field,
                        actual_field.type_id,
                        substitutions,
                    )?;
                }
            }
            (Value::Array(expected), RuntimeType::Store { element_type }) => {
                let expected = expected
                    .first()
                    .ok_or_else(|| hir_error("A residual Array type omitted its element type."))?;
                self.record_runtime_type_substitutions(expected, *element_type, substitutions)?;
            }
            (Value::ScratchType(expected), RuntimeType::Scratch { element_type }) => {
                self.record_runtime_type_substitutions(expected, *element_type, substitutions)?;
            }
            (Value::RegionType(expected), RuntimeType::Indirect { target_type })
            | (
                Value::Sealed {
                    inner: expected, ..
                },
                RuntimeType::Sealed {
                    representation_type: target_type,
                    ..
                },
            ) => {
                self.record_runtime_type_substitutions(expected, *target_type, substitutions)?;
            }
            (Value::Union(expected_members), RuntimeType::Sum { cases, .. }) => {
                for expected_member in expected_members {
                    let Value::Tag { name, payload } = expected_member else {
                        continue;
                    };
                    let Some(actual_case) = cases.iter().find(|case_| case_.name == *name) else {
                        continue;
                    };
                    let payload = compiler_tag_payload(payload.as_deref());
                    self.record_runtime_type_substitutions(
                        &payload,
                        actual_case.payload_type,
                        substitutions,
                    )?;
                }
            }
            (Value::Union(expected_members), _) => {
                for expected_member in expected_members {
                    self.record_runtime_type_substitutions(
                        expected_member,
                        actual_type,
                        substitutions,
                    )?;
                }
            }
            (Value::Extended { inner, .. } | Value::Forall { body: inner, .. }, _) => {
                self.record_runtime_type_substitutions(inner, actual_type, substitutions)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn specialized_type_from_type_value(
        &mut self,
        value: &Value,
        substitutions: &mut HashMap<u32, usize>,
        representation_facts: &RepresentationFacts,
    ) -> Result<usize, Diagnostic> {
        if let Some(type_id) = representation_facts.get(value) {
            return Ok(type_id);
        }
        match value {
            Value::TypeVariable(variable) => {
                substitutions.get(variable).copied().ok_or_else(|| {
                    hir_error(&format!(
                        "Residual result type variable 't{variable} has no call-site representation."
                    ))
                })
            }
            Value::Shape(fields) => {
                let runtime_fields = fields
                    .iter()
                    .map(|(name, field)| {
                        Ok(RuntimeField {
                            name: name.clone(),
                            type_id: self.specialized_type_from_type_value(
                                field,
                                substitutions,
                                representation_facts,
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                Ok(self.insert_product_type(runtime_fields))
            }
            Value::Array(elements) => {
                let element = elements
                    .first()
                    .ok_or_else(|| hir_error("A residual array type omitted its element type."))?;
                let element_type = self.specialized_type_from_type_value(
                    element,
                    substitutions,
                    representation_facts,
                )?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Value::RegionType(element) => {
                let element_type = self.specialized_type_from_type_value(
                    element,
                    substitutions,
                    representation_facts,
                )?;
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                self.region_type(store_type)
            }
            Value::ScratchType(element) => {
                let element_type = self.specialized_type_from_type_value(
                    element,
                    substitutions,
                    representation_facts,
                )?;
                Ok(self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                ))
            }
            Value::Union(members) => {
                if members
                    .iter()
                    .all(|member| matches!(member, Value::Tag { .. }))
                {
                    let mut cases = Vec::new();
                    let mut payload_types = Vec::new();
                    for member in members {
                        let Value::Tag { name, payload } = member else {
                            unreachable!("all union members are tags")
                        };
                        if cases.contains(name) {
                            continue;
                        }
                        let payload = compiler_tag_payload(payload.as_deref());
                        cases.push(name.clone());
                        payload_types.push(self.specialized_type_from_type_value(
                            &payload,
                            substitutions,
                            representation_facts,
                        )?);
                    }
                    if cases.len() == 2
                        && cases.iter().any(|name| name == "False")
                        && cases.iter().any(|name| name == "True")
                        && payload_types.iter().all(|type_id| *type_id == 0)
                    {
                        return Ok(1);
                    }
                    return Ok(self.sum_type(&cases, &payload_types));
                }
                let mut unresolved = Vec::new();
                let mut representation = None;
                let mut represented_member = None;
                for member_value in members {
                    if let Value::TypeVariable(variable) = member_value
                        && !substitutions.contains_key(variable)
                    {
                        unresolved.push(*variable);
                        continue;
                    }
                    let member_type = self.specialized_type_from_type_value(
                        member_value,
                        substitutions,
                        representation_facts,
                    )?;
                    if representation.is_some_and(|known| known != member_type) {
                        return Err(hir_error(&format!(
                            "Residual union member {} has runtime type {member_type}, but {} has runtime type {}.",
                            crate::value::show(member_value),
                            represented_member
                                .as_deref()
                                .expect("a represented union member exists"),
                            representation.expect("a union representation exists"),
                        )));
                    }
                    representation = Some(member_type);
                    represented_member = Some(crate::value::show(member_value));
                }
                let representation = representation.ok_or_else(|| {
                    hir_error("A residual union has no concrete runtime representation.")
                })?;
                for variable in unresolved {
                    substitutions.insert(variable, representation);
                }
                Ok(representation)
            }
            Value::Extended { inner, .. }
            | Value::Sealed { inner, .. }
            | Value::Forall { body: inner, .. } => {
                self.specialized_type_from_type_value(
                    inner,
                    substitutions,
                    representation_facts,
                )
            }
            _ => self.type_from_type_value(value).map_err(|mut diagnostic| {
                diagnostic.message = format!(
                    "{} While specializing {}.",
                    diagnostic.message,
                    crate::value::show(value)
                );
                diagnostic
            }),
        }
    }

    fn runtime_type_from_checked(
        &mut self,
        type_: &Type,
        value: &Value,
    ) -> Result<usize, Diagnostic> {
        if let Value::Runtime(value) = value {
            return Ok(value.type_id);
        }
        match type_ {
            Type::Unit => Ok(0),
            Type::Range {
                domain: Domain::Text,
                ..
            } => Ok(3),
            Type::Range {
                domain: Domain::Int,
                ..
            } => Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64)),
            _ => self.value_type(value),
        }
    }

    fn runtime_type_from_checked_type(&mut self, type_: &Type) -> Result<usize, Diagnostic> {
        match type_ {
            Type::Unit => Ok(0),
            Type::Range {
                domain: Domain::Int,
                ..
            } => Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64)),
            Type::Range {
                domain: Domain::Text,
                ..
            } => Ok(3),
            Type::Range {
                domain: Domain::Float,
                ..
            } => Ok(self.insert_type("float-64", RuntimeType::Float64)),
            Type::Range {
                domain: Domain::Float32,
                ..
            } => Ok(self.insert_type("float-32", RuntimeType::Float32)),
            Type::Record(fields) => {
                let mut runtime_fields = Vec::new();
                for (name, field) in fields {
                    runtime_fields.push(RuntimeField {
                        name: name.clone(),
                        type_id: self.runtime_type_from_checked_type(field)?,
                    });
                }
                Ok(self.insert_product_type(runtime_fields))
            }
            Type::Array(element) => {
                let element_type = self.runtime_type_from_checked_type(element)?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Type::Region(element) => {
                let element_type = self.runtime_type_from_checked_type(element)?;
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                self.region_type(store_type)
            }
            Type::Scratch(element) => {
                let element_type = self.runtime_type_from_checked_type(element)?;
                Ok(self.insert_type(
                    &format!("scratch:{element_type}"),
                    RuntimeType::Scratch { element_type },
                ))
            }
            Type::Variant { cases, open: false } => {
                let names = cases
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect::<Vec<_>>();
                let payloads = cases
                    .iter()
                    .map(|(_, payload)| self.runtime_type_from_checked_type(payload))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(self.sum_type(&names, &payloads))
            }
            Type::Opaque(name) if simd_layout(name).is_some() => {
                let layout = simd_layout(name).expect("matched SIMD type");
                Ok(self.insert_type(&layout.key(), layout.runtime_type()))
            }
            Type::Forall { body, .. } => self.runtime_type_from_checked_type(body),
            _ => Err(hir_error(
                "A function export does not have a concrete first-order ABI type.",
            )),
        }
    }

    fn constant(
        &mut self,
        value: WireConstant,
        type_id: usize,
        span: crate::ast::Span,
    ) -> RuntimeValue {
        let result = self.next_value();
        let ownership = self.ownership(type_id);
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "constant",
            result,
            type_id,
            operands: Vec::new(),
            ownership,
            span: runtime_span,
            value: Some(value),
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        RuntimeValue {
            id: result,
            type_id,
            meaning: RuntimeMeaning::Plain,
        }
    }

    fn operation(
        &mut self,
        kind: &'static str,
        type_id: usize,
        operands: Vec<usize>,
        span: crate::ast::Span,
        operator: Option<&'static str>,
    ) -> RuntimeValue {
        let result = self.next_value();
        let ownership = self.ownership(type_id);
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind,
            result,
            type_id,
            operands,
            ownership,
            span: runtime_span,
            value: None,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        RuntimeValue {
            id: result,
            type_id,
            meaning: RuntimeMeaning::Plain,
        }
    }

    fn array_operation(
        &mut self,
        kind: &'static str,
        type_id: usize,
        operands: Vec<usize>,
        span: crate::ast::Span,
        update: Option<&'static str>,
    ) -> RuntimeValue {
        if update == Some("owned-reuse") {
            let layout = runtime_layout_witness(&self.types, type_id)
                .expect("owned reuse requires a closed runtime layout");
            assert!(
                matches!(self.types.get(type_id), Some(RuntimeType::Store { .. })),
                "owned reuse requires a Store layout, found {}",
                layout.fingerprint
            );
        }
        let result = self.next_value();
        let ownership = self.ownership(type_id);
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind,
            result,
            type_id,
            operands,
            ownership,
            span: runtime_span,
            value: None,
            update,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        RuntimeValue {
            id: result,
            type_id,
            meaning: RuntimeMeaning::Plain,
        }
    }

    fn store_literal(
        &mut self,
        store_type: usize,
        elements: Vec<RuntimeValue>,
        span: crate::ast::Span,
        reusable: bool,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store_type] else {
            return Err(hir_error(
                "A residual Store literal has a non-Store representation.",
            ));
        };
        if elements
            .iter()
            .any(|element| element.type_id != element_type)
        {
            return Err(hir_error(
                "A residual Store literal has incompatible element representations.",
            ));
        }
        let mut store = if elements.is_empty() {
            self.array_operation("store.empty", store_type, Vec::new(), span, None)
        } else {
            self.array_operation(
                "store.literal",
                store_type,
                elements.into_iter().map(|element| element.id).collect(),
                span,
                None,
            )
        };
        if reusable {
            store.meaning = RuntimeMeaning::ReusableStore;
        }
        Ok(store)
    }

    fn simd_operation(
        &mut self,
        operator: &'static str,
        type_id: usize,
        operands: Vec<usize>,
        span: crate::ast::Span,
        lane: Option<u8>,
    ) -> RuntimeValue {
        let result = self.next_value();
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "vector",
            result,
            type_id,
            operands,
            ownership: "plain",
            span: runtime_span,
            value: None,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: Some(operator),
            conversion: None,
            lane,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        RuntimeValue {
            id: result,
            type_id,
            meaning: RuntimeMeaning::Plain,
        }
    }

    fn convert_operation(
        &mut self,
        conversion: &'static str,
        type_id: usize,
        operand: usize,
        span: crate::ast::Span,
    ) -> RuntimeValue {
        let result = self.next_value();
        let runtime_span = self.span(span);
        self.current().operations.push(RuntimeOperation {
            kind: "convert",
            result,
            type_id,
            operands: vec![operand],
            ownership: "plain",
            span: runtime_span,
            value: None,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: Some(conversion),
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        RuntimeValue {
            id: result,
            type_id,
            meaning: RuntimeMeaning::Plain,
        }
    }

    fn lower_integer32(
        &mut self,
        value: &Value,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let integer = self.lower_as(Some(value), "signed-integer-64", span)?;
        Ok(self.convert_operation(
            "signed-integer-64-to-signed-integer-32",
            2,
            integer.id,
            span,
        ))
    }

    fn operation_with_case(
        &mut self,
        kind: &'static str,
        type_id: usize,
        operands: Vec<usize>,
        span: crate::ast::Span,
        case: usize,
    ) -> RuntimeValue {
        let result = self.operation(kind, type_id, operands, span, None);
        self.current()
            .operations
            .last_mut()
            .expect("just inserted operation")
            .case = Some(case);
        result
    }

    fn sum_type(&mut self, cases: &[String], payload_types: &[usize]) -> usize {
        debug_assert_eq!(cases.len(), payload_types.len());
        let mut members = cases
            .iter()
            .cloned()
            .zip(payload_types.iter().copied())
            .collect::<Vec<_>>();
        members.sort_by_key(|(name, _)| name.clone());
        let key = format!(
            "residual-sum:{}:{}",
            members
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>()
                .join("|"),
            members
                .iter()
                .map(|(_, payload_type)| payload_type.to_string())
                .collect::<Vec<_>>()
                .join("|")
        );
        self.insert_type(
            &key,
            RuntimeType::Sum {
                name: format!("residual${}", self.types.len()),
                cases: members
                    .into_iter()
                    .map(|(name, payload_type)| RuntimeCase { name, payload_type })
                    .collect(),
            },
        )
    }

    fn region_integer_type(&mut self) -> usize {
        self.insert_type("signed-integer-64", RuntimeType::SignedInteger64)
    }

    fn region_type(&mut self, store_type: usize) -> Result<usize, Diagnostic> {
        if !matches!(self.types[store_type], RuntimeType::Store { .. }) {
            return Err(hir_error("Region backing type is not a Store."));
        }
        let key = format!("region:{store_type}");
        if let Some(existing) = self.type_ids.get(&key) {
            return Ok(*existing);
        }
        let integer = self.region_integer_type();
        Ok(self.insert_type(
            &key,
            RuntimeType::Product {
                name: format!("$region:{store_type}"),
                fields: vec![
                    RuntimeField {
                        name: "end".to_owned(),
                        type_id: integer,
                    },
                    RuntimeField {
                        name: "start".to_owned(),
                        type_id: integer,
                    },
                    RuntimeField {
                        name: "store".to_owned(),
                        type_id: store_type,
                    },
                ],
            },
        ))
    }

    fn make_region(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let type_id = self.region_type(store.type_id)?;
        Ok(self.operation(
            "product.make",
            type_id,
            vec![end.id, start.id, store.id],
            span,
            None,
        ))
    }

    fn append_store_range(
        &mut self,
        source_store: &RuntimeValue,
        start: &RuntimeValue,
        end: &RuntimeValue,
        initial: &RuntimeValue,
        destination: StoreRangeDestination,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[source_store.type_id] else {
            return Err(hir_error("Store range copy source is not a Store."));
        };
        if initial.type_id != source_store.type_id {
            return Err(hir_error("Store range copy received mismatched Stores."));
        }
        let integer = self.region_integer_type();
        let source = self.current_block;
        let header = self.block();
        self.blocks[source].terminator = Some(RuntimeTerminator::Branch {
            target: header,
            arguments: vec![start.id, initial.id],
            span: self.span(span),
        });
        let cursor = self.next_value();
        let output = self.next_value();
        let cursor_span = self.span(span);
        let output_span = self.span(span);
        self.blocks[header].parameters.push(RuntimeBlockParameter {
            value: cursor,
            type_id: integer,
            ownership: "plain",
            span: cursor_span,
        });
        self.blocks[header].parameters.push(RuntimeBlockParameter {
            value: output,
            type_id: source_store.type_id,
            ownership: "owned",
            span: output_span,
        });
        self.current_block = header;
        let has_next = self.operation("scalar", 1, vec![cursor, end.id], span, Some("less-than"));
        let body = self.block();
        let done = self.block();
        self.blocks[header].terminator = Some(RuntimeTerminator::Conditional {
            condition: has_next.id,
            consequent: body,
            consequent_arguments: Vec::new(),
            alternate: done,
            alternate_arguments: vec![output],
            span: self.span(span),
        });
        self.current_block = body;
        let element = self.operation(
            "store.read",
            element_type,
            vec![source_store.id, cursor],
            span,
            None,
        );
        let grown = self.array_operation(
            "store.grow",
            source_store.type_id,
            vec![output, element.id],
            span,
            Some(destination.update()),
        );
        let one = self.constant(WireConstant::SignedInteger64("1".to_owned()), integer, span);
        let next = self.operation("scalar", integer, vec![cursor, one.id], span, Some("add"));
        self.blocks[body].terminator = Some(RuntimeTerminator::Branch {
            target: header,
            arguments: vec![next.id, grown.id],
            span: self.span(span),
        });
        let result = self.next_value();
        let result_span = self.span(span);
        self.blocks[done].parameters.push(RuntimeBlockParameter {
            value: result,
            type_id: source_store.type_id,
            ownership: "owned",
            span: result_span,
        });
        self.current_block = done;
        Ok(RuntimeValue {
            id: result,
            type_id: source_store.type_id,
            meaning: RuntimeMeaning::Plain,
        })
    }

    fn array_take(
        &mut self,
        store: RuntimeValue,
        index: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Dynamic array take received a non-array value."));
        };
        let pair_type = self.insert_product_type(vec![
            RuntimeField {
                name: "0".to_owned(),
                type_id: element_type,
            },
            RuntimeField {
                name: "1".to_owned(),
                type_id: store.type_id,
            },
        ]);
        let selected = self.operation(
            "store.read",
            element_type,
            vec![store.id, index.id],
            span,
            None,
        );
        let integer = self.region_integer_type();
        let zero = self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let empty = self.array_operation("store.empty", store.type_id, Vec::new(), span, None);
        let before = self.append_store_range(
            &store,
            &zero,
            &index,
            &empty,
            StoreRangeDestination::Fresh,
            span,
        )?;
        let one = self.constant(WireConstant::SignedInteger64("1".to_owned()), integer, span);
        let after_start =
            self.operation("scalar", integer, vec![index.id, one.id], span, Some("add"));
        let length = self.operation("store.length", integer, vec![store.id], span, None);
        let remainder = self.append_store_range(
            &store,
            &after_start,
            &length,
            &before,
            StoreRangeDestination::Fresh,
            span,
        )?;
        Ok(self.operation(
            "product.make",
            pair_type,
            vec![selected.id, remainder.id],
            span,
            None,
        ))
    }

    fn array_split(
        &mut self,
        store: RuntimeValue,
        index: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Dynamic array split received a non-array value."));
        };
        let payload_type = self.insert_product_type(vec![
            RuntimeField {
                name: "0".to_owned(),
                type_id: store.type_id,
            },
            RuntimeField {
                name: "1".to_owned(),
                type_id: element_type,
            },
            RuntimeField {
                name: "2".to_owned(),
                type_id: store.type_id,
            },
        ]);
        let selected = self.operation(
            "store.read",
            element_type,
            vec![store.id, index.id],
            span,
            None,
        );
        let integer = self.region_integer_type();
        let zero = self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let before_empty =
            self.array_operation("store.empty", store.type_id, Vec::new(), span, None);
        let before = self.append_store_range(
            &store,
            &zero,
            &index,
            &before_empty,
            StoreRangeDestination::Fresh,
            span,
        )?;
        let one = self.constant(WireConstant::SignedInteger64("1".to_owned()), integer, span);
        let after_start =
            self.operation("scalar", integer, vec![index.id, one.id], span, Some("add"));
        let length = self.operation("store.length", integer, vec![store.id], span, None);
        let after_empty =
            self.array_operation("store.empty", store.type_id, Vec::new(), span, None);
        let after = self.append_store_range(
            &store,
            &after_start,
            &length,
            &after_empty,
            StoreRangeDestination::Fresh,
            span,
        )?;
        Ok(self.operation(
            "product.make",
            payload_type,
            vec![before.id, selected.id, after.id],
            span,
            None,
        ))
    }

    fn lower_region(
        &mut self,
        value: &Value,
        span: crate::ast::Span,
    ) -> Result<(RuntimeValue, RuntimeValue, RuntimeValue), Diagnostic> {
        let runtime = self.lower_value(value, span)?;
        let RuntimeType::Product { name, fields } = self.types[runtime.type_id].clone() else {
            let type_ = serde_json::to_string(&self.types[runtime.type_id])
                .unwrap_or_else(|_| format!("type {}", runtime.type_id));
            return Err(hir_error(&format!(
                "Region value is not a private Product: {type_}."
            )));
        };
        if !name.starts_with("$region:") {
            return Err(hir_error(
                "Region value lost its private runtime representation.",
            ));
        }
        let project = |this: &mut Self, field_name: &str| -> Result<RuntimeValue, Diagnostic> {
            let (index, field) = fields
                .iter()
                .enumerate()
                .find(|(_, field)| field.name == field_name)
                .ok_or_else(|| hir_error("Region product lost a field."))?;
            Ok(this.project_field(&runtime, index, field.type_id, span))
        };
        let store = project(self, "store")?;
        let start = project(self, "start")?;
        let end = project(self, "end")?;
        Ok((store, start, end))
    }

    fn private_store_copy(
        &mut self,
        store: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region copy source is not a Store."));
        };
        let integer = self.region_integer_type();
        let length = self.operation("store.length", integer, vec![store.id], span, None);
        let zero = self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let empty = self.operation("scalar", 1, vec![length.id, zero.id], span, Some("equal"));
        let branches = self.begin_conditional(&empty, span)?;

        self.current_block = branches.consequent;
        let empty_store = RuntimeValue {
            meaning: RuntimeMeaning::Plain,
            ..store.clone()
        };
        let empty_end = self.current_block;

        self.current_block = branches.alternate;
        let first = self.operation(
            "store.read",
            element_type,
            vec![store.id, zero.id],
            span,
            None,
        );
        // Persistent self-write is the existing copy-before-write operation.
        let copied = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, zero.id, first.id],
            span,
            Some("persistent"),
        );
        let copied_end = self.current_block;
        Ok(self.join_runtime_values(&branches, empty_end, empty_store, copied_end, copied, span))
    }

    fn region_index_in_bounds(
        &mut self,
        index: &RuntimeValue,
        start: &RuntimeValue,
        end: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let integer = self.region_integer_type();
        let length = self.operation(
            "scalar",
            integer,
            vec![end.id, start.id],
            span,
            Some("subtract"),
        );
        let zero = self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let negative = self.operation(
            "scalar",
            1,
            vec![index.id, zero.id],
            span,
            Some("less-than"),
        );
        let branches = self.begin_conditional(&negative, span)?;
        self.current_block = branches.consequent;
        let no = self.constant(WireConstant::Boolean(false), 1, span);
        let no_end = self.current_block;
        self.current_block = branches.alternate;
        let yes_or_no = self.operation(
            "scalar",
            1,
            vec![index.id, length.id],
            span,
            Some("less-than"),
        );
        let compare_end = self.current_block;
        Ok(self.join_runtime_values(&branches, no_end, no, compare_end, yes_or_no, span))
    }

    fn boolean_and(
        &mut self,
        left: &RuntimeValue,
        right: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let branches = self.begin_conditional(left, span)?;
        self.current_block = branches.consequent;
        let yes = right.clone();
        let yes_end = self.current_block;
        self.current_block = branches.alternate;
        let no = self.constant(WireConstant::Boolean(false), 1, span);
        let no_end = self.current_block;
        Ok(self.join_runtime_values(&branches, yes_end, yes, no_end, no, span))
    }

    fn region_get(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        index: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region Store projection lost its Store type."));
        };
        let cases = vec!["Some".to_owned(), "None".to_owned()];
        let sum_type = self.sum_type(&cases, &[element_type, 0]);
        let in_bounds = self.region_index_in_bounds(&index, &start, &end, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, index.id],
            span,
            Some("add"),
        );
        let value = self.operation(
            "store.read",
            element_type,
            vec![store.id, absolute.id],
            span,
            None,
        );
        let some = self.operation_with_case("sum.make", sum_type, vec![value.id], span, 0);
        let some_end = self.current_block;

        self.current_block = branches.alternate;
        let unit = self.constant(WireConstant::Unit, 0, span);
        let none = self.operation_with_case("sum.make", sum_type, vec![unit.id], span, 1);
        let none_end = self.current_block;

        let mut result = self.join_runtime_values(&branches, some_end, some, none_end, none, span);
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn region_set(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        index: RuntimeValue,
        value: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let region_type = self.region_type(store.type_id)?;
        let cases = vec!["Updated".to_owned(), "SetOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[region_type, region_type]);
        let in_bounds = self.region_index_in_bounds(&index, &start, &end, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, index.id],
            span,
            Some("add"),
        );
        let updated_store = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, absolute.id, value.id],
            span,
            Some("owned-reuse"),
        );
        let updated_region = self.make_region(updated_store, start.clone(), end.clone(), span)?;
        let updated =
            self.operation_with_case("sum.make", sum_type, vec![updated_region.id], span, 0);
        let updated_end = self.current_block;

        self.current_block = branches.alternate;
        let original = self.make_region(store, start, end, span)?;
        let failed = self.operation_with_case("sum.make", sum_type, vec![original.id], span, 1);
        let failed_end = self.current_block;

        let mut result =
            self.join_runtime_values(&branches, updated_end, updated, failed_end, failed, span);
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn region_swap(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        left: RuntimeValue,
        right: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region Store projection lost its Store type."));
        };
        let region_type = self.region_type(store.type_id)?;
        let cases = vec!["Updated".to_owned(), "SwapOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[region_type, region_type]);
        let left_ok = self.region_index_in_bounds(&left, &start, &end, span)?;
        let right_ok = self.region_index_in_bounds(&right, &start, &end, span)?;
        let in_bounds = self.boolean_and(&left_ok, &right_ok, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let left_absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, left.id],
            span,
            Some("add"),
        );
        let right_absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, right.id],
            span,
            Some("add"),
        );
        let left_value = self.operation(
            "store.read",
            element_type,
            vec![store.id, left_absolute.id],
            span,
            None,
        );
        let right_value = self.operation(
            "store.read",
            element_type,
            vec![store.id, right_absolute.id],
            span,
            None,
        );
        let first = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, left_absolute.id, right_value.id],
            span,
            Some("owned-reuse"),
        );
        let second = self.array_operation(
            "store.write",
            store.type_id,
            vec![first.id, right_absolute.id, left_value.id],
            span,
            Some("owned-reuse"),
        );
        let updated_region = self.make_region(second, start.clone(), end.clone(), span)?;
        let updated =
            self.operation_with_case("sum.make", sum_type, vec![updated_region.id], span, 0);
        let updated_end = self.current_block;

        self.current_block = branches.alternate;
        let original = self.make_region(store, start, end, span)?;
        let failed = self.operation_with_case("sum.make", sum_type, vec![original.id], span, 1);
        let failed_end = self.current_block;

        let mut result =
            self.join_runtime_values(&branches, updated_end, updated, failed_end, failed, span);
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn region_replace(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        index: RuntimeValue,
        value: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region Store projection lost its Store type."));
        };
        let region_type = self.region_type(store.type_id)?;
        let payload_type = self.insert_product_type(vec![
            RuntimeField {
                name: "0".to_owned(),
                type_id: element_type,
            },
            RuntimeField {
                name: "1".to_owned(),
                type_id: region_type,
            },
        ]);
        let cases = vec!["Replaced".to_owned(), "ReplaceOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[payload_type, payload_type]);
        let in_bounds = self.region_index_in_bounds(&index, &start, &end, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, index.id],
            span,
            Some("add"),
        );
        let displaced = self.operation(
            "store.read",
            element_type,
            vec![store.id, absolute.id],
            span,
            None,
        );
        let updated_store = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, absolute.id, value.id],
            span,
            Some("owned-reuse"),
        );
        let updated_region = self.make_region(updated_store, start.clone(), end.clone(), span)?;
        let success_payload = self.operation(
            "product.make",
            payload_type,
            vec![displaced.id, updated_region.id],
            span,
            None,
        );
        let success =
            self.operation_with_case("sum.make", sum_type, vec![success_payload.id], span, 0);
        let success_end = self.current_block;

        self.current_block = branches.alternate;
        let original = self.make_region(store, start, end, span)?;
        let failure_payload = self.operation(
            "product.make",
            payload_type,
            vec![value.id, original.id],
            span,
            None,
        );
        let failure =
            self.operation_with_case("sum.make", sum_type, vec![failure_payload.id], span, 1);
        let failure_end = self.current_block;

        let mut result =
            self.join_runtime_values(&branches, success_end, success, failure_end, failure, span);
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn split_region(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        offset: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let region_type = self.region_type(store.type_id)?;
        // The third slot is the rejoin witness: element-free proof, erased
        // to unit at runtime.
        let pair_type = self.insert_product_type(vec![
            RuntimeField {
                name: "0".to_owned(),
                type_id: region_type,
            },
            RuntimeField {
                name: "1".to_owned(),
                type_id: region_type,
            },
            RuntimeField {
                name: "2".to_owned(),
                type_id: 0,
            },
        ]);
        let cases = vec!["Split".to_owned(), "SplitOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[pair_type, region_type]);
        let meaning = RuntimeMeaning::Sum {
            cases: cases.clone(),
        };

        let failure = |this: &mut Self| -> Result<RuntimeValue, Diagnostic> {
            let original = this.make_region(store.clone(), start.clone(), end.clone(), span)?;
            let mut tagged =
                this.operation_with_case("sum.make", sum_type, vec![original.id], span, 1);
            tagged.meaning = meaning.clone();
            Ok(tagged)
        };

        let integer = self.region_integer_type();
        let zero = self.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let negative = self.operation(
            "scalar",
            1,
            vec![offset.id, zero.id],
            span,
            Some("less-than"),
        );
        let outer = self.begin_conditional(&negative, span)?;

        self.current_block = outer.consequent;
        let negative_value = failure(self)?;
        let negative_end = self.current_block;

        self.current_block = outer.alternate;
        let length = self.operation(
            "scalar",
            integer,
            vec![end.id, start.id],
            span,
            Some("subtract"),
        );
        let too_high = self.operation(
            "scalar",
            1,
            vec![length.id, offset.id],
            span,
            Some("less-than"),
        );
        let inner = self.begin_conditional(&too_high, span)?;

        self.current_block = inner.consequent;
        let high_value = failure(self)?;
        let high_end = self.current_block;

        self.current_block = inner.alternate;
        let middle = self.operation(
            "scalar",
            integer,
            vec![start.id, offset.id],
            span,
            Some("add"),
        );
        let left = self.make_region(store.clone(), start.clone(), middle.clone(), span)?;
        let right = self.make_region(store.clone(), middle, end.clone(), span)?;
        let witness = self.constant(WireConstant::Unit, 0, span);
        let pair = self.operation(
            "product.make",
            pair_type,
            vec![left.id, right.id, witness.id],
            span,
            None,
        );
        let mut success = self.operation_with_case("sum.make", sum_type, vec![pair.id], span, 0);
        success.meaning = meaning.clone();
        let success_end = self.current_block;

        let bounded =
            self.join_runtime_values(&inner, high_end, high_value, success_end, success, span);
        let bounded_end = self.current_block;
        let mut joined = self.join_runtime_values(
            &outer,
            negative_end,
            negative_value,
            bounded_end,
            bounded,
            span,
        );
        joined.meaning = meaning;
        Ok(joined)
    }

    fn product_type(&mut self, fields: &OrderedFields) -> Result<usize, Diagnostic> {
        let mut runtime_fields = Vec::new();
        for (name, value) in fields {
            runtime_fields.push(RuntimeField {
                name: name.clone(),
                type_id: self.value_type(value)?,
            });
        }
        Ok(self.insert_product_type(runtime_fields))
    }

    fn insert_product_type(&mut self, fields: Vec<RuntimeField>) -> usize {
        let mut fields = fields;
        fields.sort_by(|left, right| left.name.cmp(&right.name));
        let key = format!(
            "residual-product:{}",
            fields
                .iter()
                .map(|field| format!("{}:{}", field.name, field.type_id))
                .collect::<Vec<_>>()
                .join(",")
        );
        self.insert_type(
            &key,
            RuntimeType::Product {
                name: format!("residual${}", self.types.len()),
                fields,
            },
        )
    }

    fn symbolic_value(
        &mut self,
        mut value: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        if matches!(self.types[value.type_id], RuntimeType::Unit) {
            return Ok(Value::Unit);
        }
        if let Some((_, cases)) = self.sum_representation(value.type_id) {
            value.meaning = RuntimeMeaning::Sum {
                cases: cases.iter().map(|case_| case_.name.clone()).collect(),
            };
            return Ok(Value::Runtime(value));
        }
        let unresolved_recursive_result = self.pending_recursive_types.contains(&value.type_id)
            && !self.settled_recursive_types.contains(&value.type_id);
        if !unresolved_recursive_result {
            value = self.load_indirect(&value, span);
        }
        let RuntimeType::Product { name, fields } = self.types[value.type_id].clone() else {
            return Ok(Value::Runtime(value));
        };
        if name.starts_with("$region:") {
            return Ok(Value::Runtime(value));
        }
        let mut projected = OrderedFields::default();
        for (field_index, field) in fields.into_iter().enumerate() {
            let result = self.next_value();
            let ownership = self.ownership(field.type_id);
            let runtime_span = self.span(span);
            self.current().operations.push(RuntimeOperation {
                kind: "product.project",
                result,
                type_id: field.type_id,
                operands: vec![value.id],
                ownership,
                span: runtime_span,
                value: None,
                update: None,
                case: None,
                capability: None,
                operation: None,
                operator: None,
                conversion: None,
                lane: None,
                field: Some(field_index),
                function: None,
                signature: None,
                static_store: None,
            });
            let field_value = self.symbolic_value(
                RuntimeValue {
                    id: result,
                    type_id: field.type_id,
                    meaning: RuntimeMeaning::Plain,
                },
                span,
            )?;
            projected.insert(field.name, field_value);
        }
        Ok(Value::Shape(projected))
    }

    fn insert_type(&mut self, key: &str, type_: RuntimeType) -> usize {
        if let Some(existing) = self.type_ids.get(key) {
            return *existing;
        }
        let id = self.types.len();
        self.types.push(type_);
        self.type_ids.insert(key.to_owned(), id);
        id
    }

    fn block(&mut self) -> usize {
        let id = self.blocks.len();
        self.blocks.push(ResidualBlock {
            id,
            parameters: Vec::new(),
            operations: Vec::new(),
            terminator: None,
        });
        id
    }

    fn current(&mut self) -> &mut ResidualBlock {
        &mut self.blocks[self.current_block]
    }

    fn next_value(&mut self) -> usize {
        let value = self.next_value;
        self.next_value += 1;
        value
    }

    fn ownership(&self, type_id: usize) -> &'static str {
        match self.types[type_id] {
            RuntimeType::Text
            | RuntimeType::Store { .. }
            | RuntimeType::Scratch { .. }
            | RuntimeType::Indirect { .. }
            | RuntimeType::Product { .. }
            | RuntimeType::Sum { .. }
            | RuntimeType::Sealed { .. } => "owned",
            _ => "plain",
        }
    }

    fn span(&self, span: crate::ast::Span) -> RuntimeSpan {
        RuntimeSpan {
            file: self.source.clone(),
            start: span.start,
            end: span.end,
        }
    }
}

#[derive(Clone, Copy)]
enum ResidualResultPolicy {
    Ordinary,
    Recursive,
}

fn residual_result_requires_staging(type_: &Value, policy: ResidualResultPolicy) -> bool {
    match type_ {
        Value::Arrow { .. } | Value::Effect { .. } => true,
        Value::OpaqueType(name) => {
            matches!(policy, ResidualResultPolicy::Ordinary) || simd_layout(name).is_none()
        }
        Value::Shape(fields) => fields
            .iter()
            .any(|(_, field)| residual_result_requires_staging(field, policy)),
        Value::Array(elements) => elements
            .iter()
            .any(|element| residual_result_requires_staging(element, policy)),
        Value::Union(elements) => elements
            .iter()
            .any(|element| residual_result_requires_staging(element, policy)),
        Value::Tag { payload, .. } => payload
            .as_deref()
            .is_some_and(|payload| residual_result_requires_staging(payload, policy)),
        Value::Forall { body, .. } | Value::Extended { inner: body, .. } => {
            residual_result_requires_staging(body, policy)
        }
        Value::Sealed { inner, .. } => residual_result_requires_staging(inner, policy),
        _ => false,
    }
}

fn contains_staging_sensitive_runtime(value: &Value) -> bool {
    match value {
        Value::Closure { .. }
        | Value::ClosureChoice { .. }
        | Value::Continuation { .. }
        | Value::Deferred { .. }
        | Value::Operation { .. }
        | Value::Primitive { .. } => true,
        Value::Runtime(runtime) => matches!(
            runtime.meaning,
            RuntimeMeaning::Ordering | RuntimeMeaning::ScalarOrdering { .. }
        ),
        Value::Shape(fields) => fields
            .iter()
            .any(|(_, field)| contains_staging_sensitive_runtime(field)),
        Value::Array(elements) => elements.iter().any(contains_staging_sensitive_runtime),
        Value::Scratch { values, .. } => values.iter().any(contains_staging_sensitive_runtime),
        Value::Tag { payload, .. } => payload
            .as_deref()
            .is_some_and(contains_staging_sensitive_runtime),
        Value::Extended { inner, members } => {
            contains_staging_sensitive_runtime(inner)
                || members
                    .iter()
                    .any(|(_, member)| contains_staging_sensitive_runtime(member))
        }
        Value::Sealed { inner, .. } | Value::Forall { body: inner, .. } => {
            contains_staging_sensitive_runtime(inner)
        }
        _ => false,
    }
}

fn has_unresolved_representation(value: &Value, substitutions: &HashMap<u32, usize>) -> bool {
    match value {
        Value::TypeVariable(variable) => !substitutions.contains_key(variable),
        Value::Shape(fields) => fields
            .iter()
            .any(|(_, field)| has_unresolved_representation(field, substitutions)),
        Value::Array(elements) => elements
            .iter()
            .any(|element| has_unresolved_representation(element, substitutions)),
        Value::Union(elements) => elements
            .iter()
            .any(|element| has_unresolved_representation(element, substitutions)),
        Value::RegionType(element) | Value::ScratchType(element) => {
            has_unresolved_representation(element, substitutions)
        }
        Value::EmptyArray { element }
        | Value::Extended { inner: element, .. }
        | Value::Sealed { inner: element, .. }
        | Value::Forall { body: element, .. } => {
            has_unresolved_representation(element, substitutions)
        }
        Value::Tag { payload, .. } => payload
            .as_deref()
            .is_some_and(|payload| has_unresolved_representation(payload, substitutions)),
        Value::Range { low, high, .. } => {
            has_unresolved_representation(low, substitutions)
                || has_unresolved_representation(high, substitutions)
        }
        Value::Arrow {
            domain,
            codomain,
            effects,
            ..
        } => {
            has_unresolved_representation(domain, substitutions)
                || has_unresolved_representation(codomain, substitutions)
                || effects
                    .iter()
                    .any(|effect| has_unresolved_representation(effect, substitutions))
        }
        _ => false,
    }
}

fn compiler_tag_payload(payload: Option<&Value>) -> Value {
    let Some(value) = payload else {
        return Value::Unit;
    };
    if let Value::Union(members) = value {
        return Value::Union(
            members
                .iter()
                .map(|member| compiler_tag_payload(Some(member)))
                .collect(),
        );
    }
    if let Value::Shape(fields) = value
        && fields.len() == 1
        && let Some(value) = fields.get("value")
    {
        return value.clone();
    }
    value.clone()
}

fn input_store_reuse_witness(
    input: &Produced,
    value: &Value,
    types: &[RuntimeType],
) -> StoreReuseWitness {
    fn permits_reuse(input: Option<&Produced>) -> bool {
        match input {
            Some(
                Produced::Leaf(crate::ast::Qualifier::Linear | crate::ast::Qualifier::Affine)
                | Produced::Parameter {
                    qualifier: crate::ast::Qualifier::Linear | crate::ast::Qualifier::Affine,
                    ..
                }
                | Produced::StoreParameter { .. }
                | Produced::Store(_),
            ) => true,
            Some(Produced::Many(inputs)) => inputs.iter().any(|input| permits_reuse(Some(input))),
            _ => false,
        }
    }

    fn visit(input: Option<&Produced>, value: &Value, types: &[RuntimeType]) -> StoreReuseWitness {
        match value {
            Value::Runtime(runtime)
                if matches!(types[runtime.type_id], RuntimeType::Store { .. }) =>
            {
                if permits_reuse(input) && matches!(runtime.meaning, RuntimeMeaning::ReusableStore)
                {
                    StoreReuseWitness::Reusable
                } else {
                    StoreReuseWitness::Shared
                }
            }
            Value::Array(_) | Value::EmptyArray { .. } => {
                if matches!(value, Value::EmptyArray { .. }) || permits_reuse(input) {
                    StoreReuseWitness::Reusable
                } else {
                    StoreReuseWitness::Shared
                }
            }
            Value::Shape(fields) => StoreReuseWitness::Shape(
                fields
                    .iter()
                    .map(|(name, value)| {
                        let field_input = match input {
                            Some(Produced::Shape(inputs)) => inputs.get(name),
                            Some(Produced::Sequence(inputs)) => name
                                .parse::<usize>()
                                .ok()
                                .and_then(|index| inputs.get(index)),
                            _ => None,
                        };
                        (name.clone(), visit(field_input, value, types))
                    })
                    .collect(),
            ),
            Value::Tag { name, payload } => {
                let payload_input = match input {
                    Some(Produced::Variant(input)) => Some(input.as_ref()),
                    Some(Produced::Choice(inputs)) => {
                        inputs.get(name).and_then(|input| match input {
                            Produced::Variant(input) => Some(input.as_ref()),
                            _ => None,
                        })
                    }
                    _ => None,
                };
                StoreReuseWitness::Tag(
                    name.clone(),
                    payload
                        .as_deref()
                        .map(|payload| Box::new(visit(payload_input, payload, types))),
                )
            }
            Value::Extended { inner, .. }
            | Value::Sealed { inner, .. }
            | Value::Forall { body: inner, .. } => visit(input, inner, types),
            _ => StoreReuseWitness::None,
        }
    }

    visit(Some(input), value, types)
}

fn preserve_recursive_store_reuse(
    witness: &StoreReuseWitness,
    value: &Value,
    types: &[RuntimeType],
) -> StoreReuseWitness {
    match value {
        Value::Runtime(runtime)
            if matches!(types[runtime.type_id], RuntimeType::Store { .. })
                && matches!(runtime.meaning, RuntimeMeaning::ReusableStore) =>
        {
            StoreReuseWitness::Reusable
        }
        Value::Shape(values) => StoreReuseWitness::Shape(
            values
                .iter()
                .map(|(name, value)| {
                    let field_witness = match witness {
                        StoreReuseWitness::Shape(fields) => fields
                            .iter()
                            .find(|(field, _)| field == name)
                            .map(|(_, witness)| witness)
                            .unwrap_or(&StoreReuseWitness::None),
                        _ => &StoreReuseWitness::None,
                    };
                    (
                        name.clone(),
                        preserve_recursive_store_reuse(field_witness, value, types),
                    )
                })
                .collect(),
        ),
        Value::Tag { name, payload } => {
            let payload_witness = match witness {
                StoreReuseWitness::Tag(witness_name, Some(witness)) if witness_name == name => {
                    Some(witness.as_ref())
                }
                _ => None,
            };
            StoreReuseWitness::Tag(
                name.clone(),
                payload.as_deref().map(|payload| {
                    Box::new(preserve_recursive_store_reuse(
                        payload_witness.unwrap_or(&StoreReuseWitness::None),
                        payload,
                        types,
                    ))
                }),
            )
        }
        Value::Extended { inner, .. }
        | Value::Sealed { inner, .. }
        | Value::Forall { body: inner, .. } => {
            preserve_recursive_store_reuse(witness, inner, types)
        }
        _ => witness.clone(),
    }
}

fn runtime_store_reuse_witness(value: &Value, types: &[RuntimeType]) -> StoreReuseWitness {
    match value {
        Value::Runtime(runtime) if matches!(types[runtime.type_id], RuntimeType::Store { .. }) => {
            match runtime.meaning {
                RuntimeMeaning::DeferredStore => StoreReuseWitness::Deferred,
                RuntimeMeaning::ReusableStore => StoreReuseWitness::Reusable,
                _ => StoreReuseWitness::Shared,
            }
        }
        Value::Array(_) | Value::EmptyArray { .. } => StoreReuseWitness::Reusable,
        Value::Shape(fields) => StoreReuseWitness::Shape(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), runtime_store_reuse_witness(value, types)))
                .collect(),
        ),
        Value::Tag { name, payload } => StoreReuseWitness::Tag(
            name.clone(),
            payload
                .as_deref()
                .map(|payload| Box::new(runtime_store_reuse_witness(payload, types))),
        ),
        Value::Extended { inner, .. }
        | Value::Sealed { inner, .. }
        | Value::Forall { body: inner, .. } => runtime_store_reuse_witness(inner, types),
        _ => StoreReuseWitness::None,
    }
}

fn merge_store_reuse_witness(
    left: &StoreReuseWitness,
    right: &StoreReuseWitness,
) -> StoreReuseWitness {
    match (left, right) {
        (StoreReuseWitness::Shared, StoreReuseWitness::Shared)
        | (StoreReuseWitness::Shared, StoreReuseWitness::Reusable)
        | (StoreReuseWitness::Reusable, StoreReuseWitness::Shared)
        | (StoreReuseWitness::Shared, StoreReuseWitness::Deferred)
        | (StoreReuseWitness::Deferred, StoreReuseWitness::Shared) => StoreReuseWitness::Shared,
        (StoreReuseWitness::Reusable, StoreReuseWitness::Reusable)
        | (StoreReuseWitness::Reusable, StoreReuseWitness::Deferred)
        | (StoreReuseWitness::Deferred, StoreReuseWitness::Reusable) => StoreReuseWitness::Reusable,
        (StoreReuseWitness::Deferred, StoreReuseWitness::Deferred) => StoreReuseWitness::Deferred,
        (StoreReuseWitness::Shape(left), StoreReuseWitness::Shape(right))
            if left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|((left, _), (right, _))| left == right) =>
        {
            StoreReuseWitness::Shape(
                left.iter()
                    .zip(right)
                    .map(|((name, left), (_, right))| {
                        (name.clone(), merge_store_reuse_witness(left, right))
                    })
                    .collect(),
            )
        }
        (
            StoreReuseWitness::Tag(left_name, left_payload),
            StoreReuseWitness::Tag(right_name, right_payload),
        ) if left_name == right_name => StoreReuseWitness::Tag(
            left_name.clone(),
            match (left_payload, right_payload) {
                (Some(left), Some(right)) => Some(Box::new(merge_store_reuse_witness(left, right))),
                _ => None,
            },
        ),
        _ => StoreReuseWitness::None,
    }
}

fn settle_store_reuse_witness(
    planned: &StoreReuseWitness,
    observed: &StoreReuseWitness,
) -> StoreReuseWitness {
    match (planned, observed) {
        (StoreReuseWitness::Deferred, observed) => observed.clone(),
        (StoreReuseWitness::Shape(planned), StoreReuseWitness::Shape(observed))
            if planned.len() == observed.len()
                && planned
                    .iter()
                    .zip(observed)
                    .all(|((left, _), (right, _))| left == right) =>
        {
            StoreReuseWitness::Shape(
                planned
                    .iter()
                    .zip(observed)
                    .map(|((name, planned), (_, observed))| {
                        (name.clone(), settle_store_reuse_witness(planned, observed))
                    })
                    .collect(),
            )
        }
        (
            StoreReuseWitness::Tag(planned_name, planned_payload),
            StoreReuseWitness::Tag(observed_name, observed_payload),
        ) if planned_name == observed_name => StoreReuseWitness::Tag(
            planned_name.clone(),
            match (planned_payload, observed_payload) {
                (Some(planned), Some(observed)) => {
                    Some(Box::new(settle_store_reuse_witness(planned, observed)))
                }
                _ => None,
            },
        ),
        (planned, _) => planned.clone(),
    }
}

fn deferred_store_reuse_witness(type_id: usize, types: &[RuntimeType]) -> StoreReuseWitness {
    fn visit(
        type_id: usize,
        types: &[RuntimeType],
        active: &mut HashSet<usize>,
    ) -> StoreReuseWitness {
        if !active.insert(type_id) {
            return StoreReuseWitness::None;
        }
        let witness = match &types[type_id] {
            RuntimeType::Store { .. } => StoreReuseWitness::Deferred,
            RuntimeType::Product { fields, .. } => StoreReuseWitness::Shape(
                fields
                    .iter()
                    .map(|field| (field.name.clone(), visit(field.type_id, types, active)))
                    .collect(),
            ),
            RuntimeType::Indirect { target_type } if *target_type != 0 => {
                visit(*target_type, types, active)
            }
            RuntimeType::Sealed {
                representation_type,
                ..
            } => visit(*representation_type, types, active),
            _ => StoreReuseWitness::None,
        };
        active.remove(&type_id);
        witness
    }

    visit(type_id, types, &mut HashSet::new())
}

fn apply_store_reuse_witness(
    witness: &StoreReuseWitness,
    mut value: Value,
    types: &[RuntimeType],
) -> Value {
    match (witness, &mut value) {
        (StoreReuseWitness::Deferred, Value::Runtime(runtime))
            if matches!(types[runtime.type_id], RuntimeType::Store { .. }) =>
        {
            runtime.meaning = RuntimeMeaning::DeferredStore;
        }
        (StoreReuseWitness::Shared, Value::Runtime(runtime))
            if matches!(types[runtime.type_id], RuntimeType::Store { .. }) =>
        {
            runtime.meaning = RuntimeMeaning::SharedStore;
        }
        (StoreReuseWitness::Reusable, Value::Runtime(runtime))
            if matches!(types[runtime.type_id], RuntimeType::Store { .. }) =>
        {
            runtime.meaning = RuntimeMeaning::ReusableStore;
        }
        (StoreReuseWitness::Shape(fields), Value::Shape(values)) => {
            for (name, witness) in fields {
                if let Some(field) = values.get(name).cloned() {
                    values.insert(
                        name.clone(),
                        apply_store_reuse_witness(witness, field, types),
                    );
                }
            }
        }
        (
            StoreReuseWitness::Tag(_, Some(witness)),
            Value::Tag {
                payload: Some(payload),
                ..
            },
        ) => {
            **payload = apply_store_reuse_witness(witness, (**payload).clone(), types);
        }
        _ => {}
    }
    value
}

fn mark_reusable_stores(input: &Produced, mut value: Value, types: &[RuntimeType]) -> Value {
    match input {
        Produced::Leaf(crate::ast::Qualifier::Linear | crate::ast::Qualifier::Affine)
        | Produced::StoreParameter { .. }
        | Produced::Parameter {
            qualifier: crate::ast::Qualifier::Linear | crate::ast::Qualifier::Affine,
            ..
        } => {
            if let Value::Runtime(runtime) = &mut value
                && matches!(runtime.meaning, RuntimeMeaning::Plain)
                && matches!(types[runtime.type_id], RuntimeType::Store { .. })
            {
                runtime.meaning = RuntimeMeaning::ReusableStore;
            }
        }
        Produced::Sequence(elements) => {
            if let Value::Shape(values) = &mut value {
                for (index, input) in elements.iter().enumerate() {
                    let name = index.to_string();
                    if let Some(element) = values.get(&name).cloned() {
                        values.insert(name, mark_reusable_stores(input, element, types));
                    }
                }
            }
        }
        Produced::Shape(fields) => {
            if let Value::Shape(values) = &mut value {
                for (name, input) in fields {
                    if let Some(element) = values.get(name).cloned() {
                        values.insert(name.clone(), mark_reusable_stores(input, element, types));
                    }
                }
            }
        }
        Produced::Variant(input) => {
            if let Value::Tag {
                payload: Some(payload),
                ..
            } = &mut value
            {
                **payload = mark_reusable_stores(input, (**payload).clone(), types);
            }
        }
        _ => {}
    }
    value
}

/// Is this the kind of value a dynamic branch can only join by
/// defunctionalizing it?
fn is_function_value(value: &Value) -> bool {
    matches!(
        value,
        Value::Closure { .. } | Value::ClosureChoice { .. } | Value::Primitive { .. }
    )
}

/// The signature the checker recorded for a joined function, for the diagnostic
/// that reports an open source set. A choice reports the first signature it
/// carries: every alternative has already been joined against the others.
fn joined_signature(value: &Value) -> Option<Value> {
    match value {
        Value::Closure { signature, .. } => signature.as_deref().cloned(),
        Value::ClosureChoice { alternatives, .. } => alternatives
            .iter()
            .find_map(|alternative| alternative.signature().cloned()),
        _ => None,
    }
}

fn capture_field_name(index: usize) -> String {
    format!("capture${index}")
}

fn capture_field_index(name: &str) -> Option<usize> {
    name.strip_prefix("capture$")?.parse().ok()
}

pub(crate) fn contains_runtime(value: &Value) -> bool {
    match value {
        Value::Runtime(_) | Value::ClosureChoice { .. } => true,
        Value::Region { store, start, end } => {
            store.borrow()[*start..*end].iter().any(contains_runtime)
        }
        Value::RegionType(element) | Value::ScratchType(element) => contains_runtime(element),
        Value::Scratch { values, .. } => values.iter().any(contains_runtime),
        Value::DeferredScratch { capacity } => contains_runtime(capacity),
        Value::Shape(fields) => fields.iter().any(|(_, value)| contains_runtime(value)),
        Value::Array(elements) => elements.iter().any(contains_runtime),
        Value::Tag { payload, .. } => payload.as_deref().is_some_and(contains_runtime),
        Value::Sealed { inner, .. } | Value::Extended { inner, .. } => contains_runtime(inner),
        _ => false,
    }
}

fn contains_staged_iterator(value: &Value) -> bool {
    match value {
        Value::IndexedStep { .. } => true,
        Value::Shape(fields) => fields
            .iter()
            .any(|(_, value)| contains_staged_iterator(value)),
        Value::Array(elements) => elements.iter().any(contains_staged_iterator),
        Value::Union(elements) => elements.iter().any(contains_staged_iterator),
        Value::Tag { payload, .. } => payload.as_deref().is_some_and(contains_staged_iterator),
        Value::Extended { inner, .. } | Value::Sealed { inner, .. } => {
            contains_staged_iterator(inner)
        }
        _ => false,
    }
}

fn checked_representation_shape(value: &Value) -> Option<RepresentationShape> {
    fn shape(value: &Value) -> Option<RepresentationShape> {
        match value {
            Value::Unit | Value::Unbounded => Some(RepresentationShape::Unit),
            Value::Int(_)
            | Value::Range {
                domain: Some(crate::value::Domain::Int),
                ..
            } => Some(RepresentationShape::SignedInteger64),
            Value::Float32(_)
            | Value::Range {
                domain: Some(crate::value::Domain::Float32),
                ..
            } => Some(RepresentationShape::Float32),
            Value::Float(_)
            | Value::Range {
                domain: Some(crate::value::Domain::Float),
                ..
            } => Some(RepresentationShape::Float64),
            Value::Text(_)
            | Value::Range {
                domain: Some(crate::value::Domain::Text),
                ..
            } => Some(RepresentationShape::Text),
            Value::Vector(_) => Some(RepresentationShape::FloatVector { lanes: 4 }),
            Value::VectorMask(_) => Some(RepresentationShape::FloatMask { lanes: 4 }),
            Value::IntegerVector { bits, lanes } => Some(RepresentationShape::IntegerVector {
                bits: *bits,
                lanes: lanes.len(),
            }),
            Value::IntegerVectorMask { bits, lanes } => Some(RepresentationShape::IntegerMask {
                bits: *bits,
                lanes: lanes.len(),
            }),
            Value::Runtime(value) => Some(RepresentationShape::Runtime(value.type_id)),
            Value::Shape(fields) => Some(RepresentationShape::Shape(
                fields
                    .iter()
                    .map(|(name, value)| Some((name.clone(), shape(value)?)))
                    .collect::<Option<Vec<_>>>()?,
            )),
            Value::Array(elements) => Some(RepresentationShape::Array(Some(Box::new(shape(
                elements.first()?,
            )?)))),
            Value::RegionType(element) => {
                Some(RepresentationShape::Region(Box::new(shape(element)?)))
            }
            Value::ScratchType(element) => {
                Some(RepresentationShape::Scratch(Box::new(shape(element)?)))
            }
            Value::Tag { name, payload } => {
                let payload = match payload.as_deref() {
                    Some(payload) => Some(Box::new(shape(payload)?)),
                    None => None,
                };
                Some(RepresentationShape::Tag(name.clone(), payload))
            }
            Value::Sealed { name, inner } => Some(RepresentationShape::Sealed(
                name.clone(),
                Box::new(shape(inner)?),
            )),
            Value::Extended { inner, .. } | Value::Forall { body: inner, .. } => shape(inner),
            _ => None,
        }
    }

    let represented = match value {
        Value::Shape(_) | Value::Array(_) => true,
        Value::RegionType(element) | Value::ScratchType(element) => {
            matches!(element.as_ref(), Value::TypeVariable(_))
        }
        _ => false,
    };
    represented.then(|| shape(value)).flatten()
}

fn specialization_representation_shape(value: &Value) -> Option<RepresentationShape> {
    fn shape(value: &Value) -> RepresentationShape {
        match value {
            Value::Shape(fields) => RepresentationShape::Shape(
                fields
                    .iter()
                    .map(|(name, value)| (name.clone(), shape(value)))
                    .collect(),
            ),
            Value::Array(elements) => {
                RepresentationShape::Array(elements.first().map(|element| Box::new(shape(element))))
            }
            Value::RegionType(element) => RepresentationShape::Region(Box::new(shape(element))),
            Value::ScratchType(element) => RepresentationShape::Scratch(Box::new(shape(element))),
            Value::Tag { name, payload } => RepresentationShape::Tag(
                name.clone(),
                payload.as_deref().map(|payload| Box::new(shape(payload))),
            ),
            Value::Extended { inner, .. }
            | Value::Sealed { inner, .. }
            | Value::Forall { body: inner, .. } => shape(inner),
            _ => RepresentationShape::Unknown,
        }
    }

    let represented = match value {
        Value::Shape(_) | Value::Array(_) => true,
        Value::RegionType(element) | Value::ScratchType(element) => {
            matches!(element.as_ref(), Value::TypeVariable(_))
        }
        _ => false,
    };
    represented.then(|| shape(value))
}

fn collect_fields(
    context: &Rc<Context>,
    fields: &OrderedFields,
    visited: &mut HashSet<(String, u32, usize)>,
    captured: &mut BTreeMap<(usize, usize), RuntimeValue>,
    requires_staging: &mut bool,
) -> Result<(), Diagnostic> {
    for (_, value) in fields {
        collect_value(context, value, visited, captured, requires_staging)?;
    }
    Ok(())
}

fn collect_closure(
    context: &Rc<Context>,
    closure: LexicalClosure<'_>,
    visited: &mut HashSet<(String, u32, usize)>,
    captured: &mut BTreeMap<(usize, usize), RuntimeValue>,
    requires_staging: &mut bool,
) -> Result<(), Diagnostic> {
    let identity = (
        closure.module.to_owned(),
        closure.body.0,
        Rc::as_ptr(closure.environment) as usize,
    );
    if !visited.insert(identity) {
        return Ok(());
    }
    for name in closure_free_names(
        context,
        closure.module,
        closure.parameter,
        closure.body,
        closure.self_name,
    )? {
        if let Some(value) = lookup(closure.environment, &name) {
            collect_value(context, &value, visited, captured, requires_staging)?;
        }
    }
    Ok(())
}

fn collect_value(
    context: &Rc<Context>,
    value: &Value,
    visited: &mut HashSet<(String, u32, usize)>,
    captured: &mut BTreeMap<(usize, usize), RuntimeValue>,
    requires_staging: &mut bool,
) -> Result<(), Diagnostic> {
    match value {
        // A suspension lives only between a deferred call and the read that
        // demands it, so it is never a captured runtime value.
        Value::Deferred { .. } => *requires_staging = true,
        Value::Runtime(runtime) => {
            if matches!(
                runtime.meaning,
                RuntimeMeaning::Ordering | RuntimeMeaning::ScalarOrdering { .. }
            ) {
                *requires_staging = true;
            }
            captured
                .entry((runtime.id, runtime.type_id))
                .or_insert_with(|| runtime.clone());
        }
        Value::Shape(fields) => {
            collect_fields(context, fields, visited, captured, requires_staging)?
        }
        Value::Array(elements) => {
            for element in elements {
                collect_value(context, element, visited, captured, requires_staging)?;
            }
        }
        Value::IndexedStep { elements } => {
            for element in elements {
                collect_value(context, element, visited, captured, requires_staging)?;
            }
        }
        Value::Union(elements) => {
            for element in elements {
                collect_value(context, element, visited, captured, requires_staging)?;
            }
        }
        Value::RegionType(element) | Value::ScratchType(element) => {
            collect_value(context, element, visited, captured, requires_staging)?;
        }
        Value::DeferredScratch { capacity } => {
            collect_value(context, capacity, visited, captured, requires_staging)?;
        }
        Value::Scratch { values, .. } => {
            for element in values {
                collect_value(context, element, visited, captured, requires_staging)?;
            }
        }
        Value::Region { store, start, end } => {
            let cells = store.borrow();
            for element in &cells[*start..*end] {
                collect_value(context, element, visited, captured, requires_staging)?;
            }
        }
        // A witness names no elements; there is nothing to capture.
        Value::RegionRejoin { .. } => {}
        Value::Tag { payload, .. } => {
            if let Some(payload) = payload {
                collect_value(context, payload, visited, captured, requires_staging)?;
            }
        }
        Value::Closure {
            module,
            parameter,
            body,
            environment,
            self_name,
            ..
        } => collect_closure(
            context,
            LexicalClosure {
                module,
                parameter: *parameter,
                body: *body,
                environment,
                self_name: self_name.as_deref(),
            },
            visited,
            captured,
            requires_staging,
        )?,
        Value::Primitive { applied, .. } => {
            for argument in applied {
                collect_value(context, argument, visited, captured, requires_staging)?;
            }
        }
        Value::Range { low, high, .. } => {
            collect_value(context, low, visited, captured, requires_staging)?;
            collect_value(context, high, visited, captured, requires_staging)?;
        }
        Value::Arrow {
            domain,
            codomain,
            effects,
            ..
        } => {
            collect_value(context, domain, visited, captured, requires_staging)?;
            collect_value(context, codomain, visited, captured, requires_staging)?;
            for effect in effects {
                collect_value(context, effect, visited, captured, requires_staging)?;
            }
        }
        Value::Forall { body, .. }
        | Value::Operation { effect: body, .. }
        | Value::Sealed { inner: body, .. } => {
            collect_value(context, body, visited, captured, requires_staging)?;
        }
        Value::Effect { operations, .. } => {
            collect_fields(context, operations, visited, captured, requires_staging)?;
        }
        Value::Extended { inner, members } => {
            collect_value(context, inner, visited, captured, requires_staging)?;
            collect_fields(context, members, visited, captured, requires_staging)?;
        }
        Value::ClosureChoice {
            selector,
            alternatives,
        } => {
            captured
                .entry((selector.id, selector.type_id))
                .or_insert_with(|| selector.clone());
            for alternative in alternatives.iter() {
                for capture in &alternative.captures {
                    captured
                        .entry((capture.id, capture.type_id))
                        .or_insert_with(|| capture.clone());
                }
            }
        }
        Value::Int(_)
        | Value::Float(_)
        | Value::Float32(_)
        | Value::Vector(_)
        | Value::VectorMask(_)
        | Value::IntegerVector { .. }
        | Value::IntegerVectorMask { .. }
        | Value::Text(_)
        | Value::Unit
        | Value::EmptyArray { .. }
        | Value::ModuleClosure { .. }
        | Value::Unbounded
        | Value::TypeVariable(_)
        | Value::OpaqueType(_)
        | Value::Continuation { .. } => {}
    }
    Ok(())
}

fn runtime_capture_plan(
    context: &Rc<Context>,
    closure: LexicalClosure<'_>,
) -> Result<RuntimeCapturePlan, Diagnostic> {
    let mut captured = BTreeMap::new();
    let mut requires_staging = false;
    collect_closure(
        context,
        closure,
        &mut HashSet::new(),
        &mut captured,
        &mut requires_staging,
    )?;
    Ok(RuntimeCapturePlan {
        values: captured.into_values().collect(),
        requires_staging,
    })
}

/// The runtime values an already-applied value carries, in the same order
/// relation `runtime_captures` uses. A partially applied primitive closes over
/// its arguments rather than over a lexical environment.
fn value_runtime_captures(
    context: &Rc<Context>,
    value: &Value,
) -> Result<Vec<RuntimeValue>, Diagnostic> {
    let mut captured = BTreeMap::new();
    let mut requires_staging = false;
    collect_value(
        context,
        value,
        &mut HashSet::new(),
        &mut captured,
        &mut requires_staging,
    )?;
    Ok(captured.into_values().collect())
}

fn replace_closure_environment(
    context: &Rc<Context>,
    closure: LexicalClosure<'_>,
    replacements: &HashMap<(usize, usize), RuntimeValue>,
    replaced: &mut HashMap<(String, u32, usize), Environment>,
) -> Result<Environment, Diagnostic> {
    let identity = (
        closure.module.to_owned(),
        closure.body.0,
        Rc::as_ptr(closure.environment) as usize,
    );
    if let Some(environment) = replaced.get(&identity) {
        return Ok(environment.clone());
    }
    let (result, result_recursive_bindings) = if closure.environment.recursive_bindings.is_some() {
        let (environment, bindings) = recursive_env(Some(closure.environment.clone()));
        (environment, Some(bindings))
    } else {
        (child_env(Some(closure.environment.clone())), None)
    };
    replaced.insert(identity, result.clone());
    if let (Some(source_bindings), Some(result_bindings)) = (
        closure.environment.recursive_bindings.as_ref(),
        result_recursive_bindings,
    ) {
        let members = source_bindings.values();
        for (_, member) in &members {
            let Value::Closure {
                module,
                body,
                environment,
                ..
            } = member
            else {
                unreachable!("recursive groups contain only closure templates")
            };
            replaced.insert(
                (
                    module.as_ref().clone(),
                    body.0,
                    Rc::as_ptr(environment) as usize,
                ),
                result.clone(),
            );
        }
        for (name, member) in &members {
            let mut member = member.clone();
            let Value::Closure { environment, .. } = &mut member else {
                unreachable!("recursive groups contain only closure templates")
            };
            *environment = result.clone();
            result_bindings
                .insert(name.clone(), member)
                .expect("recursive groups contain only closure templates");
        }
        for (_, member) in members {
            let Value::Closure {
                module,
                parameter,
                body,
                environment,
                self_name,
                ..
            } = member
            else {
                unreachable!("recursive groups contain only closure templates")
            };
            for name in closure_free_names(context, &module, parameter, body, self_name.as_deref())?
            {
                if source_bindings.contains(&name) || result.names.borrow().contains_key(&name) {
                    continue;
                }
                if let Some(value) = lookup(&environment, &name) {
                    let value = replace_value(context, &value, replacements, replaced)?;
                    result.names.borrow_mut().insert(name, value);
                }
            }
        }
        return Ok(result);
    }
    for name in closure_free_names(
        context,
        closure.module,
        closure.parameter,
        closure.body,
        closure.self_name,
    )? {
        if let Some(value) = lookup(closure.environment, &name) {
            result.names.borrow_mut().insert(
                name,
                replace_value(context, &value, replacements, replaced)?,
            );
        }
    }
    Ok(result)
}

fn replace_fields(
    context: &Rc<Context>,
    fields: &OrderedFields,
    replacements: &HashMap<(usize, usize), RuntimeValue>,
    replaced: &mut HashMap<(String, u32, usize), Environment>,
) -> Result<OrderedFields, Diagnostic> {
    fields
        .iter()
        .map(|(name, value)| {
            Ok((
                name.clone(),
                replace_value(context, value, replacements, replaced)?,
            ))
        })
        .collect()
}

fn replace_value(
    context: &Rc<Context>,
    value: &Value,
    replacements: &HashMap<(usize, usize), RuntimeValue>,
    replaced: &mut HashMap<(String, u32, usize), Environment>,
) -> Result<Value, Diagnostic> {
    let mut result = value.clone();
    match &mut result {
        Value::Deferred { .. } => {}
        Value::Runtime(runtime) => {
            if let Some(replacement) = replacements.get(&(runtime.id, runtime.type_id)) {
                *runtime = replacement.clone();
            }
        }
        Value::Shape(fields) => {
            *fields = replace_fields(context, fields, replacements, replaced)?;
        }
        Value::Array(elements) => {
            for element in elements {
                *element = replace_value(context, element, replacements, replaced)?;
            }
        }
        Value::IndexedStep { elements } => {
            for element in elements {
                *element = replace_value(context, element, replacements, replaced)?;
            }
        }
        Value::Union(elements) => {
            for element in elements {
                *element = replace_value(context, element, replacements, replaced)?;
            }
        }
        Value::RegionType(element) | Value::ScratchType(element) => {
            **element = replace_value(context, element, replacements, replaced)?;
        }
        Value::DeferredScratch { capacity } => {
            **capacity = replace_value(context, capacity, replacements, replaced)?;
        }
        Value::Scratch { values, .. } => {
            for element in values {
                *element = replace_value(context, element, replacements, replaced)?;
            }
        }
        Value::Region { store, start, end } => {
            let cells = store.borrow();
            let mut replaced_cells = cells.clone();
            drop(cells);
            for element in &mut replaced_cells[*start..*end] {
                *element = replace_value(context, element, replacements, replaced)?;
            }
            *store = Rc::new(std::cell::RefCell::new(replaced_cells));
        }
        Value::RegionRejoin { .. } => {}
        Value::Tag { payload, .. } => {
            if let Some(payload) = payload {
                **payload = replace_value(context, payload, replacements, replaced)?;
            }
        }
        Value::Closure {
            module,
            parameter,
            body,
            environment,
            self_name,
            ..
        } => {
            *environment = replace_closure_environment(
                context,
                LexicalClosure {
                    module,
                    parameter: *parameter,
                    body: *body,
                    environment,
                    self_name: self_name.as_deref(),
                },
                replacements,
                replaced,
            )?;
        }
        Value::Primitive { applied, .. } => {
            for argument in applied {
                *argument = replace_value(context, argument, replacements, replaced)?;
            }
        }
        Value::Range { low, high, .. } => {
            **low = replace_value(context, low, replacements, replaced)?;
            **high = replace_value(context, high, replacements, replaced)?;
        }
        Value::Arrow {
            domain,
            codomain,
            effects,
            ..
        } => {
            **domain = replace_value(context, domain, replacements, replaced)?;
            **codomain = replace_value(context, codomain, replacements, replaced)?;
            for effect in effects {
                *effect = replace_value(context, effect, replacements, replaced)?;
            }
        }
        Value::Forall { body, .. }
        | Value::Operation { effect: body, .. }
        | Value::Sealed { inner: body, .. } => {
            **body = replace_value(context, body, replacements, replaced)?;
        }
        Value::Effect { operations, .. } => {
            *operations = replace_fields(context, operations, replacements, replaced)?;
        }
        Value::Extended { inner, members } => {
            **inner = replace_value(context, inner, replacements, replaced)?;
            *members = replace_fields(context, members, replacements, replaced)?;
        }
        Value::ClosureChoice {
            selector,
            alternatives,
        } => {
            if let Some(replacement) = replacements.get(&(selector.id, selector.type_id)) {
                *selector = replacement.clone();
            }
            let mut replaced_alternatives = Vec::with_capacity(alternatives.len());
            for alternative in alternatives.iter() {
                let mut alternative = alternative.clone();
                match &mut alternative.source {
                    ChoiceSource::Lambda {
                        module,
                        parameter,
                        body,
                        environment,
                        self_name,
                        ..
                    } => {
                        *environment = replace_closure_environment(
                            context,
                            LexicalClosure {
                                module,
                                parameter: *parameter,
                                body: *body,
                                environment: &environment.clone(),
                                self_name: self_name.as_deref(),
                            },
                            replacements,
                            replaced,
                        )?;
                    }
                    ChoiceSource::Primitive { applied, .. } => {
                        for argument in applied {
                            *argument = replace_value(context, argument, replacements, replaced)?;
                        }
                    }
                }
                for capture in &mut alternative.captures {
                    if let Some(replacement) = replacements.get(&(capture.id, capture.type_id)) {
                        *capture = replacement.clone();
                    }
                }
                replaced_alternatives.push(alternative);
            }
            *alternatives = Rc::new(replaced_alternatives);
        }
        Value::Int(_)
        | Value::Float(_)
        | Value::Float32(_)
        | Value::Vector(_)
        | Value::VectorMask(_)
        | Value::IntegerVector { .. }
        | Value::IntegerVectorMask { .. }
        | Value::Text(_)
        | Value::Unit
        | Value::EmptyArray { .. }
        | Value::ModuleClosure { .. }
        | Value::Unbounded
        | Value::TypeVariable(_)
        | Value::OpaqueType(_)
        | Value::Continuation { .. } => {}
    }
    Ok(result)
}

/// Rebuild a closure's captured environment with the given runtime values
/// substituted for the ones it closed over.
fn replace_environment_runtime(
    context: &Rc<Context>,
    closure: LexicalClosure<'_>,
    replacements: &HashMap<(usize, usize), RuntimeValue>,
) -> Result<Environment, Diagnostic> {
    replace_closure_environment(context, closure, replacements, &mut HashMap::new())
}

/// The same substitution over a value that is not a lexical closure.
fn replace_runtime_in_value(
    context: &Rc<Context>,
    value: &Value,
    replacements: &HashMap<(usize, usize), RuntimeValue>,
) -> Result<Value, Diagnostic> {
    replace_value(context, value, replacements, &mut HashMap::new())
}

fn runtime_effect_name(value: &Value) -> Option<String> {
    let Value::Effect { name, .. } = value else {
        return None;
    };
    Some(name.clone())
}

#[derive(Eq, Hash, PartialEq)]
enum StaticWireKey {
    Unit,
    Integer32(i32),
    SignedInteger64(String),
    Float32(u32),
    Float64(u64),
    Boolean(bool),
}

fn optimize_runtime_module(
    module: &mut RuntimeModule,
    development_units: Option<&HashSet<String>>,
) -> Result<(), Diagnostic> {
    compact_static_stores(module)?;
    for function in &mut module.functions {
        fold_representation_roundtrips(function);
        fold_store_field_reads(function);
        eliminate_dead_pure_operations(function);
    }
    module.functions = std::mem::take(&mut module.functions)
        .into_iter()
        .map(simplify_runtime_function)
        .collect();
    for function in &mut module.functions {
        fold_representation_roundtrips(function);
        eliminate_dead_pure_operations(function);
    }
    deduplicate_runtime_types(module);
    for function in &mut module.functions {
        fold_representation_roundtrips(function);
        eliminate_dead_pure_operations(function);
    }
    deduplicate_runtime_signatures(module);
    deduplicate_runtime_functions(module, development_units)?;
    validate_runtime_layouts(&module.types)
}

fn fold_store_field_reads(function: &mut RuntimeFunction) {
    let definitions = function
        .blocks
        .iter()
        .flat_map(|block| &block.operations)
        .map(|operation| (operation.result, operation.clone()))
        .collect::<HashMap<_, _>>();
    for operation in function
        .blocks
        .iter_mut()
        .flat_map(|block| &mut block.operations)
    {
        if operation.kind != "product.project" {
            continue;
        }
        let Some(source) = operation
            .operands
            .first()
            .and_then(|operand| definitions.get(operand))
        else {
            continue;
        };
        if source.kind != "store.read" {
            continue;
        }
        operation.kind = "store.read.field";
        operation.operands.clone_from(&source.operands);
    }
}

fn compact_static_stores(module: &mut RuntimeModule) -> Result<(), Diagnostic> {
    let mut store_ids = HashMap::<(usize, Vec<StaticWireKey>), usize>::new();
    for (store_id, store) in module.static_stores.iter().enumerate() {
        let Some(key) = static_store_key(store.element_type, &store.values) else {
            return Err(hir_error(
                "Runtime HIR contains a non-scalar static Store literal.",
            ));
        };
        store_ids.insert(key, store_id);
    }
    for function in &mut module.functions {
        let definitions = function
            .blocks
            .iter()
            .flat_map(|block| block.operations.iter())
            .map(|operation| {
                (
                    operation.result,
                    (operation.type_id, operation.value.clone()),
                )
            })
            .collect::<HashMap<_, _>>();
        for operation in function
            .blocks
            .iter_mut()
            .flat_map(|block| &mut block.operations)
        {
            if operation.kind != "store.literal" || operation.static_store.is_some() {
                continue;
            }
            let RuntimeType::Store { element_type } = module
                .types
                .get(operation.type_id)
                .ok_or_else(|| hir_error("A Store literal lost its runtime type."))?
            else {
                return Err(hir_error(
                    "A Store literal has a non-Store runtime representation.",
                ));
            };
            let mut values = Vec::with_capacity(operation.operands.len());
            for operand in &operation.operands {
                let Some((type_id, Some(value))) = definitions.get(operand) else {
                    values.clear();
                    break;
                };
                if type_id != element_type || static_wire_key(value).is_none() {
                    values.clear();
                    break;
                }
                values.push(value.clone());
            }
            if values.len() != operation.operands.len() {
                continue;
            }
            let key = static_store_key(*element_type, &values)
                .expect("static Store values were checked while collecting them");
            let store_id = if let Some(store_id) = store_ids.get(&key) {
                *store_id
            } else {
                let store_id = module.static_stores.len();
                module.static_stores.push(RuntimeStaticStore {
                    element_type: *element_type,
                    values,
                });
                store_ids.insert(key, store_id);
                store_id
            };
            operation.operands.clear();
            operation.static_store = Some(store_id);
        }
    }
    Ok(())
}

fn static_store_key(
    element_type: usize,
    values: &[WireConstant],
) -> Option<(usize, Vec<StaticWireKey>)> {
    values
        .iter()
        .map(static_wire_key)
        .collect::<Option<Vec<_>>>()
        .map(|values| (element_type, values))
}

fn static_wire_key(value: &WireConstant) -> Option<StaticWireKey> {
    match value {
        WireConstant::Unit => Some(StaticWireKey::Unit),
        WireConstant::SignedInteger32(value) => Some(StaticWireKey::Integer32(*value)),
        WireConstant::SignedInteger64(value) => Some(StaticWireKey::SignedInteger64(value.clone())),
        WireConstant::Float32(value) => Some(StaticWireKey::Float32(value.to_bits())),
        WireConstant::Float64(value) => Some(StaticWireKey::Float64(value.to_bits())),
        WireConstant::Boolean(value) => Some(StaticWireKey::Boolean(*value)),
        WireConstant::Text(_) => None,
    }
}

fn eliminate_dead_pure_operations(function: &mut RuntimeFunction) {
    let definitions = function
        .blocks
        .iter()
        .flat_map(|block| &block.operations)
        .map(|operation| (operation.result, operation))
        .collect::<HashMap<_, _>>();
    let mut uses = HashMap::<usize, usize>::new();
    for block in &function.blocks {
        for operation in &block.operations {
            for operand in &operation.operands {
                *uses.entry(*operand).or_default() += 1;
            }
        }
        for value in terminator_runtime_values(&block.terminator) {
            *uses.entry(value).or_default() += 1;
        }
    }
    let mut pending = definitions
        .values()
        .filter(|operation| {
            uses.get(&operation.result).copied().unwrap_or(0) == 0
                && discardable_runtime_operation(operation)
        })
        .map(|operation| operation.result)
        .collect::<VecDeque<_>>();
    let mut dead = HashSet::new();
    while let Some(value) = pending.pop_front() {
        if !dead.insert(value) {
            continue;
        }
        #[cfg(test)]
        RUNTIME_DEAD_OPERATION_VISITS.with(|visits| visits.set(visits.get() + 1));
        let operation = definitions[&value];
        for operand in &operation.operands {
            let count = uses
                .get_mut(operand)
                .expect("a runtime operand has a use count");
            *count -= 1;
            if *count == 0
                && definitions
                    .get(operand)
                    .is_some_and(|definition| discardable_runtime_operation(definition))
            {
                pending.push_back(*operand);
            }
        }
    }
    if dead.is_empty() {
        return;
    }
    for block in &mut function.blocks {
        block
            .operations
            .retain(|operation| !dead.contains(&operation.result));
    }
}

fn fold_representation_roundtrips(function: &mut RuntimeFunction) {
    let definitions = function
        .blocks
        .iter()
        .flat_map(|block| &block.operations)
        .map(|operation| (operation.result, operation.clone()))
        .collect::<HashMap<_, _>>();
    let mut value_types = function
        .blocks
        .iter()
        .flat_map(|block| &block.parameters)
        .map(|parameter| (parameter.value, parameter.type_id))
        .collect::<HashMap<_, _>>();
    value_types.extend(
        definitions
            .values()
            .map(|operation| (operation.result, operation.type_id)),
    );
    let mut consumers = HashMap::<usize, Vec<usize>>::new();
    for operation in definitions.values() {
        for operand in &operation.operands {
            consumers
                .entry(*operand)
                .or_default()
                .push(operation.result);
        }
    }
    let mut aliases = HashMap::new();
    let mut roundtrip_allocations = HashSet::new();
    let mut pending = definitions.keys().copied().collect::<VecDeque<_>>();
    let mut queued = definitions.keys().copied().collect::<HashSet<_>>();
    while let Some(result) = pending.pop_front() {
        queued.remove(&result);
        if aliases.contains_key(&result) {
            continue;
        }
        let operation = &definitions[&result];
        let candidate = match operation.kind {
            "indirect.load" | "indirect.make" => operation
                .operands
                .first()
                .map(|operand| resolve_runtime_alias(*operand, &mut aliases))
                .and_then(|operand| {
                    let source = definitions.get(&operand)?;
                    let inverse = matches!(
                        (operation.kind, source.kind),
                        ("indirect.load", "indirect.make") | ("indirect.make", "indirect.load")
                    );
                    if !inverse {
                        return None;
                    }
                    if operation.kind == "indirect.load" && source.kind == "indirect.make" {
                        roundtrip_allocations.insert(source.result);
                    }
                    Some(resolve_runtime_alias(source.operands[0], &mut aliases))
                }),
            "product.project" => operation
                .operands
                .first()
                .map(|operand| resolve_runtime_alias(*operand, &mut aliases))
                .and_then(|operand| definitions.get(&operand))
                .filter(|source| source.kind == "product.make")
                .and_then(|source| operation.field.and_then(|field| source.operands.get(field)))
                .map(|value| resolve_runtime_alias(*value, &mut aliases)),
            "product.make" if !operation.operands.is_empty() => {
                let mut source = None;
                let mut complete = true;
                for (field, operand) in operation.operands.iter().enumerate() {
                    let Some(projection) = definitions.get(operand) else {
                        complete = false;
                        break;
                    };
                    if projection.kind != "product.project" || projection.field != Some(field) {
                        complete = false;
                        break;
                    }
                    let projected = resolve_runtime_alias(projection.operands[0], &mut aliases);
                    if source.is_some_and(|source| source != projected) {
                        complete = false;
                        break;
                    }
                    source = Some(projected);
                }
                complete.then_some(source).flatten()
            }
            _ => None,
        };
        let Some(candidate) = candidate else {
            continue;
        };
        if candidate == operation.result || value_types.get(&candidate) != Some(&operation.type_id)
        {
            continue;
        }
        aliases.insert(operation.result, candidate);
        for consumer in consumers.get(&operation.result).into_iter().flatten() {
            if queued.insert(*consumer) {
                pending.push_back(*consumer);
            }
        }
    }
    if aliases.is_empty() {
        return;
    }
    for block in &mut function.blocks {
        for operation in &mut block.operations {
            for operand in &mut operation.operands {
                *operand = resolve_runtime_alias(*operand, &mut aliases);
            }
        }
        match &mut block.terminator {
            RuntimeTerminator::Branch { arguments, .. } => {
                for argument in arguments {
                    *argument = resolve_runtime_alias(*argument, &mut aliases);
                }
            }
            RuntimeTerminator::Conditional {
                condition,
                consequent_arguments,
                alternate_arguments,
                ..
            } => {
                *condition = resolve_runtime_alias(*condition, &mut aliases);
                for argument in consequent_arguments
                    .iter_mut()
                    .chain(alternate_arguments.iter_mut())
                {
                    *argument = resolve_runtime_alias(*argument, &mut aliases);
                }
            }
            RuntimeTerminator::Switch { selector, .. } => {
                *selector = resolve_runtime_alias(*selector, &mut aliases);
            }
            RuntimeTerminator::Return { value, .. } => {
                *value = resolve_runtime_alias(*value, &mut aliases);
            }
            RuntimeTerminator::Trap { .. } => {}
        }
        block
            .operations
            .retain(|operation| !aliases.contains_key(&operation.result));
    }
    let mut used = HashSet::new();
    for block in &function.blocks {
        for operation in &block.operations {
            used.extend(operation.operands.iter().copied());
        }
        used.extend(terminator_runtime_values(&block.terminator));
    }
    for block in &mut function.blocks {
        block.operations.retain(|operation| {
            !roundtrip_allocations.contains(&operation.result) || used.contains(&operation.result)
        });
    }
    fold_representation_roundtrips(function);
}

fn terminator_runtime_values(terminator: &RuntimeTerminator) -> Vec<usize> {
    match terminator {
        RuntimeTerminator::Branch { arguments, .. } => arguments.clone(),
        RuntimeTerminator::Conditional {
            condition,
            consequent_arguments,
            alternate_arguments,
            ..
        } => std::iter::once(*condition)
            .chain(consequent_arguments.iter().copied())
            .chain(alternate_arguments.iter().copied())
            .collect(),
        RuntimeTerminator::Switch { selector, .. } => vec![*selector],
        RuntimeTerminator::Return { value, .. } => vec![*value],
        RuntimeTerminator::Trap { .. } => Vec::new(),
    }
}

fn resolve_runtime_alias(mut value: usize, aliases: &mut HashMap<usize, usize>) -> usize {
    let mut path = Vec::new();
    let mut visited = HashSet::new();
    while let Some(next) = aliases.get(&value).copied() {
        assert!(
            visited.insert(value),
            "runtime representation aliases form a cycle at value {value}"
        );
        path.push(value);
        value = next;
    }
    for alias in path {
        aliases.insert(alias, value);
    }
    value
}

fn discardable_runtime_operation(operation: &RuntimeOperation) -> bool {
    match operation.kind {
        "constant" | "scalar.unary" | "vector" | "product.make" | "product.project"
        | "sum.make" | "sum.tag" | "sum.payload" | "indirect.load" | "store.length"
        | "store.read" | "store.read.field" | "seal.wrap" | "seal.unwrap" | "resource.move"
        | "resource.borrow" | "resource.freeze" => true,
        "scalar" => !matches!(operation.operator, Some("divide" | "remainder")),
        "convert" => operation.conversion != Some("float-64-to-signed-integer-64"),
        _ => false,
    }
}

fn deduplicate_runtime_types(module: &mut RuntimeModule) {
    if module.types.is_empty() {
        return;
    }
    let mut shapes = HashMap::<RuntimeTypeShape, usize>::new();
    let mut children = Vec::with_capacity(module.types.len());
    let mut classes = Vec::with_capacity(module.types.len());
    let mut partitions = Vec::<Vec<usize>>::new();
    for (type_id, type_) in module.types.iter().enumerate() {
        let (shape, type_children) = runtime_type_shape(type_);
        assert!(
            type_children
                .iter()
                .all(|child| *child < module.types.len()),
            "runtime type {type_id} references an absent child"
        );
        let next_class = shapes.len();
        let class = *shapes.entry(shape).or_insert(next_class);
        if class == partitions.len() {
            partitions.push(Vec::new());
        }
        partitions[class].push(type_id);
        classes.push(class);
        children.push(type_children);
    }
    let mut predecessors = vec![Vec::<(usize, usize)>::new(); module.types.len()];
    for (parent, type_children) in children.iter().enumerate() {
        for (position, child) in type_children.iter().copied().enumerate() {
            predecessors[child].push((parent, position));
        }
    }
    refine_indexed_partitions(&mut partitions, &mut classes, &predecessors);

    let mut class_ids = HashMap::new();
    let mut remap = Vec::with_capacity(module.types.len());
    let mut types = Vec::new();
    for (type_id, type_) in module.types.iter().enumerate() {
        let class = classes[type_id];
        let compact = if let Some(compact) = class_ids.get(&class) {
            *compact
        } else {
            let compact = types.len();
            class_ids.insert(class, compact);
            types.push(type_.clone());
            compact
        };
        remap.push(compact);
    }
    if types.len() == module.types.len() {
        return;
    }
    for type_ in &mut types {
        remap_runtime_type(type_, &remap);
    }
    for signature in &mut module.signatures {
        for parameter in &mut signature.parameters {
            *parameter = remap[*parameter];
        }
        signature.result = remap[signature.result];
    }
    for store in &mut module.static_stores {
        store.element_type = remap[store.element_type];
    }
    for function in &mut module.functions {
        for block in &mut function.blocks {
            for parameter in &mut block.parameters {
                parameter.type_id = remap[parameter.type_id];
            }
            for operation in &mut block.operations {
                operation.type_id = remap[operation.type_id];
            }
        }
    }
    module.types = types;
}

#[derive(Eq, Hash, PartialEq)]
enum RuntimeTypeShape {
    Unit,
    Integer32,
    SignedInteger64,
    Float32,
    Float64,
    Boolean,
    Text,
    Vector(&'static str, u8),
    Mask(&'static str, u8),
    Store,
    Scratch,
    Indirect,
    Product(String, Vec<String>),
    Sum(String, Vec<String>),
    Sealed(String),
}

fn runtime_type_shape(type_: &RuntimeType) -> (RuntimeTypeShape, Vec<usize>) {
    match type_ {
        RuntimeType::Unit => (RuntimeTypeShape::Unit, Vec::new()),
        RuntimeType::Integer32 => (RuntimeTypeShape::Integer32, Vec::new()),
        RuntimeType::SignedInteger64 => (RuntimeTypeShape::SignedInteger64, Vec::new()),
        RuntimeType::Float32 => (RuntimeTypeShape::Float32, Vec::new()),
        RuntimeType::Float64 => (RuntimeTypeShape::Float64, Vec::new()),
        RuntimeType::Boolean => (RuntimeTypeShape::Boolean, Vec::new()),
        RuntimeType::Text => (RuntimeTypeShape::Text, Vec::new()),
        RuntimeType::Vector { element, lanes } => {
            (RuntimeTypeShape::Vector(element, *lanes), Vec::new())
        }
        RuntimeType::Mask { element, lanes } => {
            (RuntimeTypeShape::Mask(element, *lanes), Vec::new())
        }
        RuntimeType::Store { element_type } => (RuntimeTypeShape::Store, vec![*element_type]),
        RuntimeType::Scratch { element_type } => (RuntimeTypeShape::Scratch, vec![*element_type]),
        RuntimeType::Indirect { target_type } => (RuntimeTypeShape::Indirect, vec![*target_type]),
        RuntimeType::Product { name, fields } => (
            RuntimeTypeShape::Product(
                name.clone(),
                fields.iter().map(|field| field.name.clone()).collect(),
            ),
            fields.iter().map(|field| field.type_id).collect(),
        ),
        RuntimeType::Sum { name, cases } => (
            RuntimeTypeShape::Sum(
                name.clone(),
                cases.iter().map(|case_| case_.name.clone()).collect(),
            ),
            cases.iter().map(|case_| case_.payload_type).collect(),
        ),
        RuntimeType::Sealed {
            name,
            representation_type,
        } => (
            RuntimeTypeShape::Sealed(name.clone()),
            vec![*representation_type],
        ),
    }
}

fn remap_runtime_type(type_: &mut RuntimeType, remap: &[usize]) {
    match type_ {
        RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } => {
            *element_type = remap[*element_type];
        }
        RuntimeType::Indirect { target_type } => {
            *target_type = remap[*target_type];
        }
        RuntimeType::Product { fields, .. } => {
            for field in fields {
                field.type_id = remap[field.type_id];
            }
        }
        RuntimeType::Sum { cases, .. } => {
            for case_ in cases {
                case_.payload_type = remap[case_.payload_type];
            }
        }
        RuntimeType::Sealed {
            representation_type,
            ..
        } => {
            *representation_type = remap[*representation_type];
        }
        RuntimeType::Unit
        | RuntimeType::Integer32
        | RuntimeType::SignedInteger64
        | RuntimeType::Float32
        | RuntimeType::Float64
        | RuntimeType::Boolean
        | RuntimeType::Text
        | RuntimeType::Vector { .. }
        | RuntimeType::Mask { .. } => {}
    }
}

fn deduplicate_runtime_signatures(module: &mut RuntimeModule) {
    let mut ids = HashMap::new();
    let mut remap = Vec::with_capacity(module.signatures.len());
    let mut signatures = Vec::new();
    for signature in &module.signatures {
        let signature_id = if let Some(signature_id) = ids.get(signature) {
            *signature_id
        } else {
            let signature_id = signatures.len();
            ids.insert(signature.clone(), signature_id);
            signatures.push(signature.clone());
            signature_id
        };
        remap.push(signature_id);
    }
    for function in &mut module.functions {
        function.signature = remap[function.signature];
        for operation in function
            .blocks
            .iter_mut()
            .flat_map(|block| &mut block.operations)
        {
            if let Some(signature) = &mut operation.signature {
                *signature = remap[*signature];
            }
        }
    }
    for capability in &mut module.capabilities {
        for operation in &mut capability.operations {
            operation.signature = remap[operation.signature];
        }
    }
    for link in &mut module.links {
        link.signature = remap[link.signature];
    }
    for exported in &mut module.exports {
        if let RuntimeExport::Runtime { signature, .. } = exported {
            *signature = remap[*signature];
        }
    }
    module.signatures = signatures;
}

fn deduplicate_runtime_functions(
    module: &mut RuntimeModule,
    development_units: Option<&HashSet<String>>,
) -> Result<(), Diagnostic> {
    if module.functions.is_empty() {
        return Ok(());
    }
    let function_indices = module
        .functions
        .iter()
        .enumerate()
        .map(|(index, function)| (function.id, index))
        .collect::<HashMap<_, _>>();
    let mut body_classes = HashMap::<(Option<&str>, Vec<u8>), usize>::new();
    let mut canonical_calls = Vec::with_capacity(module.functions.len());
    let mut classes = Vec::with_capacity(module.functions.len());
    let mut partitions = Vec::<Vec<usize>>::new();
    for (function_index, function) in module.functions.iter().enumerate() {
        let (body, calls) = canonical_runtime_function_shape(function, &function_indices)?;
        let development_unit = development_units
            .filter(|units| units.contains(&function.span.file))
            .map(|_| function.span.file.as_str());
        let next_class = body_classes.len();
        let class = *body_classes
            .entry((development_unit, body))
            .or_insert(next_class);
        if class == partitions.len() {
            partitions.push(Vec::new());
        }
        partitions[class].push(function_index);
        classes.push(class);
        canonical_calls.push(calls);
    }
    let mut predecessors = vec![Vec::<(usize, usize)>::new(); module.functions.len()];
    for (caller, targets) in canonical_calls.iter().enumerate() {
        for (position, target) in targets.iter().copied().enumerate() {
            predecessors[target].push((caller, position));
        }
    }
    refine_indexed_partitions(&mut partitions, &mut classes, &predecessors);

    let mut class_ids = HashMap::new();
    let mut function_ids = HashMap::new();
    let mut functions = Vec::new();
    for (function_index, function) in module.functions.iter().enumerate() {
        let class = classes[function_index];
        let function_id = if let Some(function_id) = class_ids.get(&class) {
            *function_id
        } else {
            let function_id = functions.len();
            class_ids.insert(class, function_id);
            functions.push(function.clone());
            function_id
        };
        function_ids.insert(function.id, function_id);
    }
    for (function_id, function) in functions.iter_mut().enumerate() {
        function.id = function_id;
        for operation in function
            .blocks
            .iter_mut()
            .flat_map(|block| &mut block.operations)
        {
            if let Some(target) = &mut operation.function {
                *target = *function_ids.get(target).ok_or_else(|| {
                    hir_error("A direct call references an unknown residual function.")
                })?;
            }
        }
    }
    for exported in &mut module.exports {
        if let RuntimeExport::Runtime { function, .. } = exported {
            *function = *function_ids
                .get(function)
                .ok_or_else(|| hir_error("A runtime export references an unknown function."))?;
        }
    }
    module.functions = functions;
    Ok(())
}

fn refine_indexed_partitions(
    partitions: &mut Vec<Vec<usize>>,
    classes: &mut [usize],
    predecessors: &[Vec<(usize, usize)>],
) {
    let mut queued = vec![true; partitions.len()];
    let mut pending = (0..partitions.len()).collect::<VecDeque<_>>();
    while let Some(splitter) = pending.pop_front() {
        queued[splitter] = false;
        let splitter_members = partitions[splitter].clone();
        let mut by_position = HashMap::<usize, Vec<usize>>::new();
        for target in splitter_members {
            for (caller, position) in &predecessors[target] {
                #[cfg(test)]
                RUNTIME_FUNCTION_REFINEMENT_EDGES.with(|visits| visits.set(visits.get() + 1));
                by_position.entry(*position).or_default().push(*caller);
            }
        }
        for callers in by_position.into_values() {
            let mut by_partition = HashMap::<usize, Vec<usize>>::new();
            for caller in callers {
                by_partition
                    .entry(classes[caller])
                    .or_default()
                    .push(caller);
            }
            for (partition, mut selected) in by_partition {
                selected.sort_unstable();
                selected.dedup();
                if selected.len() == partitions[partition].len() {
                    continue;
                }
                let selected = selected.into_iter().collect::<HashSet<_>>();
                let (inside, outside): (Vec<_>, Vec<_>) = partitions[partition]
                    .iter()
                    .copied()
                    .partition(|function| selected.contains(function));
                let (retained, moved) = if queued[partition] || outside.len() >= inside.len() {
                    (outside, inside)
                } else {
                    (inside, outside)
                };
                partitions[partition] = retained;
                let new_partition = partitions.len();
                for function in &moved {
                    classes[*function] = new_partition;
                }
                partitions.push(moved);
                queued.push(true);
                pending.push_back(new_partition);
            }
        }
    }
}

fn canonical_runtime_function_shape(
    function: &RuntimeFunction,
    function_indices: &HashMap<usize, usize>,
) -> Result<(Vec<u8>, Vec<usize>), Diagnostic> {
    #[cfg(test)]
    RUNTIME_FUNCTION_KEY_VISITS.with(|visits| visits.set(visits.get() + 1));
    let blocks = function
        .blocks
        .iter()
        .map(|block| (block.id, block))
        .collect::<HashMap<_, _>>();
    let mut block_ids = HashMap::new();
    let mut pending = VecDeque::from([function.entry_block]);
    while let Some(block_id) = pending.pop_front() {
        if block_ids.contains_key(&block_id) {
            continue;
        }
        let block = blocks
            .get(&block_id)
            .ok_or_else(|| hir_error("A residual function targets an unknown block."))?;
        block_ids.insert(block_id, block_ids.len());
        match &block.terminator {
            RuntimeTerminator::Branch { target, .. } => pending.push_back(*target),
            RuntimeTerminator::Conditional {
                consequent,
                alternate,
                ..
            } => {
                pending.push_back(*consequent);
                pending.push_back(*alternate);
            }
            RuntimeTerminator::Switch {
                cases, fallback, ..
            } => {
                pending.extend(cases.iter().map(|case| case.target));
                pending.push_back(*fallback);
            }
            RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => {}
        }
    }
    if block_ids.len() != function.blocks.len() {
        return Err(hir_error(
            "A residual function retained an unreachable block during interning.",
        ));
    }

    let mut canonical = function.clone();
    canonical.id = 0;
    canonical.name.clear();
    canonical.entry_block = 0;
    canonical.span = RuntimeSpan {
        file: String::new(),
        start: 0,
        end: 0,
    };
    canonical.blocks.sort_by_key(|block| block_ids[&block.id]);
    let mut value_ids = HashMap::new();
    for block in &canonical.blocks {
        for parameter in &block.parameters {
            let value_id = value_ids.len();
            if value_ids.insert(parameter.value, value_id).is_some() {
                return Err(hir_error(
                    "A residual function defines one value more than once.",
                ));
            }
        }
        for operation in &block.operations {
            let value_id = value_ids.len();
            if value_ids.insert(operation.result, value_id).is_some() {
                return Err(hir_error(
                    "A residual function defines one value more than once.",
                ));
            }
        }
    }
    let remap_value = |value: usize| {
        value_ids
            .get(&value)
            .copied()
            .ok_or_else(|| hir_error("A residual function uses an undefined value."))
    };
    let mut calls = Vec::new();
    for block in &mut canonical.blocks {
        block.id = block_ids[&block.id];
        for parameter in &mut block.parameters {
            parameter.value = remap_value(parameter.value)?;
            parameter.span = RuntimeSpan {
                file: String::new(),
                start: 0,
                end: 0,
            };
        }
        for operation in &mut block.operations {
            operation.result = remap_value(operation.result)?;
            for operand in &mut operation.operands {
                *operand = remap_value(*operand)?;
            }
            if let Some(target) = &mut operation.function {
                calls.push(*function_indices.get(target).ok_or_else(|| {
                    hir_error("A direct call references an unknown residual function.")
                })?);
                *target = 0;
            }
            operation.span = RuntimeSpan {
                file: String::new(),
                start: 0,
                end: 0,
            };
        }
        match &mut block.terminator {
            RuntimeTerminator::Branch {
                target,
                arguments,
                span,
            } => {
                *target = block_ids[target];
                for argument in arguments {
                    *argument = remap_value(*argument)?;
                }
                *span = RuntimeSpan {
                    file: String::new(),
                    start: 0,
                    end: 0,
                };
            }
            RuntimeTerminator::Conditional {
                condition,
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                span,
            } => {
                *condition = remap_value(*condition)?;
                *consequent = block_ids[consequent];
                *alternate = block_ids[alternate];
                for argument in consequent_arguments
                    .iter_mut()
                    .chain(alternate_arguments.iter_mut())
                {
                    *argument = remap_value(*argument)?;
                }
                *span = RuntimeSpan {
                    file: String::new(),
                    start: 0,
                    end: 0,
                };
            }
            RuntimeTerminator::Switch {
                selector,
                cases,
                fallback,
                span,
            } => {
                *selector = remap_value(*selector)?;
                for case in cases {
                    case.target = block_ids[&case.target];
                }
                *fallback = block_ids[fallback];
                *span = RuntimeSpan {
                    file: String::new(),
                    start: 0,
                    end: 0,
                };
            }
            RuntimeTerminator::Return { value, span } => {
                *value = remap_value(*value)?;
                *span = RuntimeSpan {
                    file: String::new(),
                    start: 0,
                    end: 0,
                };
            }
            RuntimeTerminator::Trap { span, .. } => {
                *span = RuntimeSpan {
                    file: String::new(),
                    start: 0,
                    end: 0,
                };
            }
        }
    }
    let body = rmp_serde::to_vec(&canonical).map_err(|error| {
        hir_error(&format!(
            "A residual function could not be interned: {error}"
        ))
    })?;
    Ok((body, calls))
}

#[cfg(test)]
thread_local! {
    static RUNTIME_FUNCTION_KEY_VISITS: std::cell::Cell<usize> = const {
        std::cell::Cell::new(0)
    };
    static RUNTIME_FUNCTION_REFINEMENT_EDGES: std::cell::Cell<usize> = const {
        std::cell::Cell::new(0)
    };
    static RUNTIME_DEAD_OPERATION_VISITS: std::cell::Cell<usize> = const {
        std::cell::Cell::new(0)
    };
}

fn simplify_runtime_function(mut function: RuntimeFunction) -> RuntimeFunction {
    recover_direct_tail_calls(&mut function);
    loop {
        fold_boolean_branch_roundtrips(&mut function);
        fold_known_sum_switches(&mut function);
        remove_unused_block_parameters(&mut function);
        let forwarding = function
            .blocks
            .iter()
            .filter_map(|block| {
                if block.id == function.entry_block || !block.operations.is_empty() {
                    return None;
                }
                let RuntimeTerminator::Branch {
                    target, arguments, ..
                } = &block.terminator
                else {
                    return None;
                };
                let forwards_parameters = block
                    .parameters
                    .iter()
                    .map(|parameter| parameter.value)
                    .eq(arguments.iter().copied());
                forwards_parameters.then_some((block.id, *target))
            })
            .collect::<BTreeMap<_, _>>();
        let resolve = |mut target: usize| {
            let mut visited = BTreeSet::new();
            while let Some(next) = forwarding.get(&target) {
                if !visited.insert(target) {
                    break;
                }
                target = *next;
            }
            target
        };
        let mut reachable = BTreeSet::new();
        let mut pending = vec![function.entry_block];
        while let Some(block_id) = pending.pop() {
            let block_id = resolve(block_id);
            if !reachable.insert(block_id) {
                continue;
            }
            let block = &function.blocks[block_id];
            match &block.terminator {
                RuntimeTerminator::Branch { target, .. } => pending.push(*target),
                RuntimeTerminator::Conditional {
                    consequent,
                    alternate,
                    ..
                } => {
                    pending.push(*consequent);
                    pending.push(*alternate);
                }
                RuntimeTerminator::Switch {
                    cases, fallback, ..
                } => {
                    pending.extend(cases.iter().map(|case| case.target));
                    pending.push(*fallback);
                }
                RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => {}
            }
        }
        if forwarding.is_empty() && reachable.len() == function.blocks.len() {
            return function;
        }
        function
            .blocks
            .retain(|block| reachable.contains(&block.id) && !forwarding.contains_key(&block.id));
        let block_ids = function
            .blocks
            .iter()
            .enumerate()
            .map(|(index, block)| (block.id, index))
            .collect::<BTreeMap<_, _>>();
        for block in &mut function.blocks {
            block.id = block_ids[&block.id];
            match &mut block.terminator {
                RuntimeTerminator::Branch { target, .. } => {
                    *target = block_ids[&resolve(*target)];
                }
                RuntimeTerminator::Conditional {
                    consequent,
                    alternate,
                    ..
                } => {
                    *consequent = block_ids[&resolve(*consequent)];
                    *alternate = block_ids[&resolve(*alternate)];
                }
                RuntimeTerminator::Switch {
                    cases, fallback, ..
                } => {
                    for case in cases {
                        case.target = block_ids[&resolve(case.target)];
                    }
                    *fallback = block_ids[&resolve(*fallback)];
                }
                RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => {}
            }
        }
        function.entry_block = block_ids[&function.entry_block];
    }
}

fn remove_unused_block_parameters(function: &mut RuntimeFunction) {
    let mut live_values = HashSet::new();
    let mut incoming_arguments = HashMap::<usize, Vec<usize>>::new();
    let parameters = function
        .blocks
        .iter()
        .map(|block| (block.id, block.parameters.as_slice()))
        .collect::<HashMap<_, _>>();
    for block in &function.blocks {
        for operation in &block.operations {
            live_values.extend(operation.operands.iter().copied());
        }
        match &block.terminator {
            RuntimeTerminator::Branch {
                target, arguments, ..
            } => record_block_argument_dependencies(
                *target,
                arguments,
                &parameters,
                &mut incoming_arguments,
            ),
            RuntimeTerminator::Conditional {
                condition,
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                ..
            } => {
                live_values.insert(*condition);
                record_block_argument_dependencies(
                    *consequent,
                    consequent_arguments,
                    &parameters,
                    &mut incoming_arguments,
                );
                record_block_argument_dependencies(
                    *alternate,
                    alternate_arguments,
                    &parameters,
                    &mut incoming_arguments,
                );
            }
            RuntimeTerminator::Switch { selector, .. } => {
                live_values.insert(*selector);
            }
            RuntimeTerminator::Return { value, .. } => {
                live_values.insert(*value);
            }
            RuntimeTerminator::Trap { .. } => {}
        }
    }
    let mut pending = live_values.iter().copied().collect::<VecDeque<_>>();
    while let Some(value) = pending.pop_front() {
        for argument in incoming_arguments.get(&value).into_iter().flatten() {
            if live_values.insert(*argument) {
                pending.push_back(*argument);
            }
        }
    }
    let removed = function
        .blocks
        .iter()
        .filter(|block| block.id != function.entry_block)
        .filter_map(|block| {
            let indices = block
                .parameters
                .iter()
                .enumerate()
                .filter_map(|(index, parameter)| {
                    (!live_values.contains(&parameter.value)).then_some(index)
                })
                .collect::<BTreeSet<_>>();
            (!indices.is_empty()).then_some((block.id, indices))
        })
        .collect::<HashMap<_, _>>();
    if removed.is_empty() {
        return;
    }
    for block in &mut function.blocks {
        if let Some(indices) = removed.get(&block.id) {
            let mut index = 0;
            block.parameters.retain(|_| {
                let keep = !indices.contains(&index);
                index += 1;
                keep
            });
        }
        match &mut block.terminator {
            RuntimeTerminator::Branch {
                target, arguments, ..
            } => {
                if let Some(indices) = removed.get(target) {
                    let mut index = 0;
                    arguments.retain(|_| {
                        let keep = !indices.contains(&index);
                        index += 1;
                        keep
                    });
                }
            }
            RuntimeTerminator::Conditional {
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                ..
            } => {
                if let Some(indices) = removed.get(consequent) {
                    let mut index = 0;
                    consequent_arguments.retain(|_| {
                        let keep = !indices.contains(&index);
                        index += 1;
                        keep
                    });
                }
                if let Some(indices) = removed.get(alternate) {
                    let mut index = 0;
                    alternate_arguments.retain(|_| {
                        let keep = !indices.contains(&index);
                        index += 1;
                        keep
                    });
                }
            }
            RuntimeTerminator::Switch { .. }
            | RuntimeTerminator::Return { .. }
            | RuntimeTerminator::Trap { .. } => {}
        }
    }
}

fn record_block_argument_dependencies(
    target: usize,
    arguments: &[usize],
    parameters: &HashMap<usize, &[RuntimeBlockParameter]>,
    incoming_arguments: &mut HashMap<usize, Vec<usize>>,
) {
    let parameters = parameters
        .get(&target)
        .unwrap_or_else(|| panic!("residual branch target block {target} is absent"));
    assert_eq!(
        parameters.len(),
        arguments.len(),
        "residual branch to block {target} has {} arguments for {} parameters",
        arguments.len(),
        parameters.len(),
    );
    for (parameter, argument) in parameters.iter().zip(arguments) {
        incoming_arguments
            .entry(parameter.value)
            .or_default()
            .push(*argument);
    }
}

fn fold_boolean_branch_roundtrips(function: &mut RuntimeFunction) {
    let mut predecessors = HashMap::<usize, Vec<usize>>::new();
    for block in &function.blocks {
        for target in runtime_terminator_targets(&block.terminator) {
            predecessors.entry(target).or_default().push(block.id);
        }
    }
    let mut pending = function
        .blocks
        .iter()
        .map(|block| block.id)
        .collect::<VecDeque<_>>();
    let mut queued = function
        .blocks
        .iter()
        .map(|block| block.id)
        .collect::<HashSet<_>>();
    while let Some(block_id) = pending.pop_front() {
        queued.remove(&block_id);
        let replacement = folded_boolean_terminator(function, &function.blocks[block_id]);
        if let Some(terminator) = replacement {
            for target in runtime_terminator_targets(&terminator) {
                predecessors.entry(target).or_default().push(block_id);
            }
            function.blocks[block_id].terminator = terminator;
            for dependent in
                std::iter::once(&block_id).chain(predecessors.get(&block_id).into_iter().flatten())
            {
                if queued.insert(*dependent) {
                    pending.push_back(*dependent);
                }
            }
        }
    }
}

fn runtime_terminator_targets(terminator: &RuntimeTerminator) -> Vec<usize> {
    match terminator {
        RuntimeTerminator::Branch { target, .. } => vec![*target],
        RuntimeTerminator::Conditional {
            consequent,
            alternate,
            ..
        } => vec![*consequent, *alternate],
        RuntimeTerminator::Switch {
            cases, fallback, ..
        } => cases
            .iter()
            .map(|case_| case_.target)
            .chain(std::iter::once(*fallback))
            .collect(),
        RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => Vec::new(),
    }
}

fn folded_boolean_terminator(
    function: &RuntimeFunction,
    block: &RuntimeBlock,
) -> Option<RuntimeTerminator> {
    let RuntimeTerminator::Conditional {
        condition,
        consequent,
        consequent_arguments,
        alternate,
        alternate_arguments,
        span,
    } = &block.terminator
    else {
        return None;
    };
    if !consequent_arguments.is_empty() || !alternate_arguments.is_empty() {
        return None;
    }
    let (consequent_value, consequent_join) = branch_boolean(function, *consequent)?;
    let (alternate_value, alternate_join) = branch_boolean(function, *alternate)?;
    if consequent_join != alternate_join || consequent_value == alternate_value {
        return None;
    }
    let join = function.blocks.get(consequent_join)?;
    if join.parameters.len() != 1 || !join.operations.is_empty() {
        return None;
    }
    let RuntimeTerminator::Conditional {
        condition: joined_condition,
        consequent: joined_consequent,
        consequent_arguments: joined_consequent_arguments,
        alternate: joined_alternate,
        alternate_arguments: joined_alternate_arguments,
        ..
    } = &join.terminator
    else {
        return None;
    };
    if *joined_condition != join.parameters[0].value {
        return None;
    }
    let (consequent, consequent_arguments, alternate, alternate_arguments) = if consequent_value {
        (
            *joined_consequent,
            joined_consequent_arguments.clone(),
            *joined_alternate,
            joined_alternate_arguments.clone(),
        )
    } else {
        (
            *joined_alternate,
            joined_alternate_arguments.clone(),
            *joined_consequent,
            joined_consequent_arguments.clone(),
        )
    };
    Some(RuntimeTerminator::Conditional {
        condition: *condition,
        consequent,
        consequent_arguments,
        alternate,
        alternate_arguments,
        span: span.clone(),
    })
}

fn branch_boolean(function: &RuntimeFunction, block_id: usize) -> Option<(bool, usize)> {
    let block = function.blocks.get(block_id)?;
    let [operation] = block.operations.as_slice() else {
        return None;
    };
    if operation.kind != "constant" {
        return None;
    }
    let Some(WireConstant::Boolean(value)) = operation.value else {
        return None;
    };
    let RuntimeTerminator::Branch {
        target, arguments, ..
    } = &block.terminator
    else {
        return None;
    };
    if arguments.as_slice() != [operation.result] {
        return None;
    }
    Some((value, *target))
}

struct SumDispatchFold {
    targets: Vec<usize>,
    predecessors: Vec<SumDispatchPredecessor>,
}

struct SumDispatchTarget {
    sum_case: usize,
    block: usize,
}

struct SumDispatchPredecessor {
    block: usize,
    target: usize,
    payload: usize,
}

struct SumFoldFacts {
    incoming: Vec<usize>,
    branch_predecessors: Vec<Vec<usize>>,
    value_uses: HashMap<usize, usize>,
}

impl SumFoldFacts {
    fn new(function: &RuntimeFunction) -> Self {
        let mut facts = Self {
            incoming: vec![0; function.blocks.len()],
            branch_predecessors: vec![Vec::new(); function.blocks.len()],
            value_uses: HashMap::new(),
        };
        for block in &function.blocks {
            for operation in &block.operations {
                facts.add_operation(operation);
            }
            facts.add_terminator(block.id, &block.terminator);
        }
        facts
    }

    fn add_operation(&mut self, operation: &RuntimeOperation) {
        for operand in &operation.operands {
            *self.value_uses.entry(*operand).or_default() += 1;
        }
    }

    fn remove_operation(&mut self, operation: &RuntimeOperation) {
        for operand in &operation.operands {
            self.remove_value_use(*operand);
        }
    }

    fn add_terminator(&mut self, block: usize, terminator: &RuntimeTerminator) {
        match terminator {
            RuntimeTerminator::Branch {
                target, arguments, ..
            } => {
                self.add_incoming(*target);
                self.branch_predecessors[*target].push(block);
                for argument in arguments {
                    *self.value_uses.entry(*argument).or_default() += 1;
                }
            }
            RuntimeTerminator::Conditional {
                condition,
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                ..
            } => {
                *self.value_uses.entry(*condition).or_default() += 1;
                self.add_incoming(*consequent);
                self.add_incoming(*alternate);
                for argument in consequent_arguments.iter().chain(alternate_arguments) {
                    *self.value_uses.entry(*argument).or_default() += 1;
                }
            }
            RuntimeTerminator::Switch {
                selector,
                cases,
                fallback,
                ..
            } => {
                *self.value_uses.entry(*selector).or_default() += 1;
                for case in cases {
                    self.add_incoming(case.target);
                }
                self.add_incoming(*fallback);
            }
            RuntimeTerminator::Return { value, .. } => {
                *self.value_uses.entry(*value).or_default() += 1;
            }
            RuntimeTerminator::Trap { .. } => {}
        }
    }

    fn remove_terminator(&mut self, block: usize, terminator: &RuntimeTerminator) {
        match terminator {
            RuntimeTerminator::Branch {
                target, arguments, ..
            } => {
                self.remove_incoming(*target);
                let predecessors = &mut self.branch_predecessors[*target];
                let index = predecessors
                    .iter()
                    .position(|predecessor| *predecessor == block)
                    .unwrap_or_else(|| {
                        panic!("residual branch from block {block} to block {target} is unindexed")
                    });
                predecessors.swap_remove(index);
                for argument in arguments {
                    self.remove_value_use(*argument);
                }
            }
            RuntimeTerminator::Conditional {
                condition,
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                ..
            } => {
                self.remove_value_use(*condition);
                self.remove_incoming(*consequent);
                self.remove_incoming(*alternate);
                for argument in consequent_arguments.iter().chain(alternate_arguments) {
                    self.remove_value_use(*argument);
                }
            }
            RuntimeTerminator::Switch {
                selector,
                cases,
                fallback,
                ..
            } => {
                self.remove_value_use(*selector);
                for case in cases {
                    self.remove_incoming(case.target);
                }
                self.remove_incoming(*fallback);
            }
            RuntimeTerminator::Return { value, .. } => self.remove_value_use(*value),
            RuntimeTerminator::Trap { .. } => {}
        }
    }

    fn add_incoming(&mut self, block: usize) {
        self.incoming[block] += 1;
    }

    fn remove_incoming(&mut self, block: usize) {
        self.incoming[block] = self.incoming[block]
            .checked_sub(1)
            .unwrap_or_else(|| panic!("residual block {block} has an unindexed incoming edge"));
    }

    fn remove_value_use(&mut self, value: usize) {
        let uses = self
            .value_uses
            .get_mut(&value)
            .unwrap_or_else(|| panic!("residual value {value} has an unindexed use"));
        *uses = uses
            .checked_sub(1)
            .unwrap_or_else(|| panic!("residual value {value} has an unindexed use"));
        if *uses == 0 {
            self.value_uses.remove(&value);
        }
    }
}

fn fold_known_sum_switches(function: &mut RuntimeFunction) {
    let mut facts = SumFoldFacts::new(function);
    let mut pending = function
        .blocks
        .iter()
        .map(|block| block.id)
        .collect::<VecDeque<_>>();
    let mut queued = function
        .blocks
        .iter()
        .map(|block| block.id)
        .collect::<HashSet<_>>();
    while let Some(join) = pending.pop_front() {
        queued.remove(&join);
        let Some(fold) = known_sum_switch_fold(function, &function.blocks[join], &facts) else {
            continue;
        };
        let mut affected = fold.targets.clone();
        affected.extend(
            fold.predecessors
                .iter()
                .map(|predecessor| predecessor.block),
        );
        for target in fold.targets {
            let payload = function.blocks[target].operations.remove(0);
            facts.remove_operation(&payload);
            function.blocks[target]
                .parameters
                .push(RuntimeBlockParameter {
                    value: payload.result,
                    type_id: payload.type_id,
                    ownership: payload.ownership,
                    span: payload.span,
                });
        }
        for predecessor in fold.predecessors {
            let constructor = function.blocks[predecessor.block]
                .operations
                .pop()
                .expect("known sum predecessor lost its constructor");
            facts.remove_operation(&constructor);
            let old_terminator = function.blocks[predecessor.block].terminator.clone();
            let RuntimeTerminator::Branch { span, .. } = &old_terminator else {
                unreachable!();
            };
            facts.remove_terminator(predecessor.block, &old_terminator);
            let new_terminator = RuntimeTerminator::Branch {
                target: predecessor.target,
                arguments: vec![predecessor.payload],
                span: span.clone(),
            };
            facts.add_terminator(predecessor.block, &new_terminator);
            function.blocks[predecessor.block].terminator = new_terminator;
        }
        for block in affected {
            if queued.insert(block) {
                pending.push_back(block);
            }
        }
    }
}

fn known_sum_switch_fold(
    function: &RuntimeFunction,
    join: &RuntimeBlock,
    facts: &SumFoldFacts,
) -> Option<SumDispatchFold> {
    if join.id == function.entry_block {
        return None;
    }
    let [parameter] = join.parameters.as_slice() else {
        return None;
    };
    let [tag] = join.operations.as_slice() else {
        return None;
    };
    if tag.kind != "sum.tag" || tag.operands.as_slice() != [parameter.value] {
        return None;
    }
    let RuntimeTerminator::Switch {
        selector,
        cases,
        fallback,
        ..
    } = &join.terminator
    else {
        return None;
    };
    if *selector != tag.result {
        return None;
    }

    let mut targets = Vec::new();
    for case in cases {
        let WireConstant::SignedInteger32(sum_case) = &case.value else {
            return None;
        };
        let sum_case = usize::try_from(*sum_case).ok()?;
        targets.push(SumDispatchTarget {
            sum_case,
            block: case.target,
        });
    }
    let fallback_payload = function.blocks.get(*fallback)?.operations.first()?;
    let fallback_case = fallback_payload.case?;
    targets.push(SumDispatchTarget {
        sum_case: fallback_case,
        block: *fallback,
    });
    if targets.iter().enumerate().any(|(index, target)| {
        targets[..index]
            .iter()
            .any(|previous| previous.sum_case == target.sum_case || previous.block == target.block)
    }) {
        return None;
    }
    for target in &targets {
        let block = function.blocks.get(target.block)?;
        let payload = block.operations.first()?;
        if target.block == function.entry_block
            || !block.parameters.is_empty()
            || payload.kind != "sum.payload"
            || payload.operands.as_slice() != [parameter.value]
            || payload.case != Some(target.sum_case)
        {
            return None;
        }
    }
    if targets
        .iter()
        .any(|target| facts.incoming[target.block] != 1)
    {
        return None;
    }
    // A defunctionalized function choice can inspect the joined sum again after
    // this dispatch. Remove it only when the tag and arm payloads are its only
    // readers.
    if facts.value_uses.get(&parameter.value).copied().unwrap_or(0) != targets.len() + 1 {
        return None;
    }
    let mut predecessors = Vec::new();
    let branch_predecessors = &facts.branch_predecessors[join.id];
    if facts.incoming[join.id] != branch_predecessors.len() {
        return None;
    }
    for block_id in branch_predecessors {
        let block = &function.blocks[*block_id];
        let RuntimeTerminator::Branch { arguments, .. } = &block.terminator else {
            unreachable!();
        };
        let [sum] = arguments.as_slice() else {
            return None;
        };
        let operation = block.operations.last()?;
        let [payload] = operation.operands.as_slice() else {
            return None;
        };
        if operation.kind != "sum.make" || operation.result != *sum {
            return None;
        }
        let sum_case = operation.case?;
        let target = targets
            .iter()
            .find(|target| target.sum_case == sum_case)?
            .block;
        predecessors.push(SumDispatchPredecessor {
            block: block.id,
            target,
            payload: *payload,
        });
    }
    if predecessors.is_empty() {
        return None;
    }
    Some(SumDispatchFold {
        targets: targets.into_iter().map(|target| target.block).collect(),
        predecessors,
    })
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct TailDemand {
    value: usize,
    sum_case: Option<usize>,
}

fn recover_direct_tail_calls(function: &mut RuntimeFunction) {
    let mut incoming = HashMap::<usize, Vec<usize>>::new();
    for block in &function.blocks {
        match &block.terminator {
            RuntimeTerminator::Branch {
                target, arguments, ..
            } => record_incoming_arguments(function, *target, arguments, &mut incoming),
            RuntimeTerminator::Conditional {
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                ..
            } => {
                record_incoming_arguments(
                    function,
                    *consequent,
                    consequent_arguments,
                    &mut incoming,
                );
                record_incoming_arguments(function, *alternate, alternate_arguments, &mut incoming);
            }
            RuntimeTerminator::Switch { .. } => {}
            RuntimeTerminator::Return { .. } | RuntimeTerminator::Trap { .. } => {}
        }
    }
    let definitions = function
        .blocks
        .iter()
        .flat_map(|block| {
            block
                .operations
                .iter()
                .map(|operation| (operation.result, operation))
        })
        .collect::<HashMap<_, _>>();
    let value_types = function
        .blocks
        .iter()
        .flat_map(|block| {
            block
                .parameters
                .iter()
                .map(|parameter| (parameter.value, parameter.type_id))
                .chain(
                    block
                        .operations
                        .iter()
                        .map(|operation| (operation.result, operation.type_id)),
                )
        })
        .collect::<HashMap<_, _>>();
    let product_aliases = definitions
        .values()
        .filter_map(|operation| {
            product_eta_source(operation, &definitions, &value_types)
                .map(|source| (operation.result, source))
        })
        .collect::<HashMap<_, _>>();
    let mut pending = function
        .blocks
        .iter()
        .filter_map(|block| match block.terminator {
            RuntimeTerminator::Return { value, .. } => Some(TailDemand {
                value,
                sum_case: None,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut demands = HashSet::new();
    let mut tail_calls = HashSet::new();
    while let Some(demand) = pending.pop() {
        if !demands.insert(demand) {
            continue;
        }
        if demand.sum_case.is_none()
            && let Some(source) = product_aliases.get(&demand.value)
        {
            pending.push(TailDemand {
                value: *source,
                sum_case: None,
            });
            continue;
        }
        if let Some(arguments) = incoming.get(&demand.value) {
            pending.extend(arguments.iter().map(|argument| TailDemand {
                value: *argument,
                sum_case: demand.sum_case,
            }));
            continue;
        }
        let Some(operation) = definitions.get(&demand.value) else {
            continue;
        };
        match (demand.sum_case, operation.kind) {
            (None, "indirect.load" | "indirect.make") => {
                if let Some(value) = operation.operands.first() {
                    pending.push(TailDemand {
                        value: *value,
                        sum_case: None,
                    });
                }
            }
            (None, "sum.payload") => {
                if let (Some(value), Some(sum_case)) = (operation.operands.first(), operation.case)
                {
                    pending.push(TailDemand {
                        value: *value,
                        sum_case: Some(sum_case),
                    });
                }
            }
            (None, "call.direct") if operation.function == Some(function.id) => {
                tail_calls.insert(operation.result);
            }
            (Some(sum_case), "sum.make") if operation.case == Some(sum_case) => {
                if let Some(value) = operation.operands.first() {
                    pending.push(TailDemand {
                        value: *value,
                        sum_case: None,
                    });
                }
            }
            _ => {}
        }
    }
    if tail_calls.is_empty() {
        return;
    }
    for block in &mut function.blocks {
        let Some(call_index) = block.operations.iter().rposition(|operation| {
            operation.kind == "call.direct"
                && operation.function == Some(function.id)
                && tail_calls.contains(&operation.result)
        }) else {
            continue;
        };
        if !tail_call_suffix_returns(&block.operations, call_index, &block.terminator) {
            continue;
        }
        let call = block.operations[call_index].clone();
        block.operations.truncate(call_index);
        block.terminator = RuntimeTerminator::Branch {
            target: function.entry_block,
            arguments: call.operands,
            span: call.span,
        };
    }
}

fn product_eta_source(
    operation: &RuntimeOperation,
    definitions: &HashMap<usize, &RuntimeOperation>,
    value_types: &HashMap<usize, usize>,
) -> Option<usize> {
    if operation.kind != "product.make" || operation.operands.is_empty() {
        return None;
    }
    let mut source = None;
    for (field, operand) in operation.operands.iter().enumerate() {
        let projection = definitions.get(operand)?;
        if projection.kind != "product.project" || projection.field != Some(field) {
            return None;
        }
        let projected = *projection.operands.first()?;
        if let Some(source) = source {
            if source != projected {
                return None;
            }
        } else {
            source = Some(projected);
        }
    }
    let source = source?;
    if value_types.get(&source) != Some(&operation.type_id) {
        return None;
    }
    Some(source)
}

fn record_incoming_arguments(
    function: &RuntimeFunction,
    target: usize,
    arguments: &[usize],
    incoming: &mut HashMap<usize, Vec<usize>>,
) {
    let block = function
        .blocks
        .iter()
        .find(|block| block.id == target)
        .unwrap_or_else(|| panic!("tail-call recovery target block {target} is absent"));
    assert_eq!(
        block.parameters.len(),
        arguments.len(),
        "tail-call recovery branch to block {target} has {} arguments for {} parameters",
        arguments.len(),
        block.parameters.len(),
    );
    for (parameter, argument) in block.parameters.iter().zip(arguments) {
        incoming.entry(parameter.value).or_default().push(*argument);
    }
}

fn tail_call_suffix_returns(
    operations: &[RuntimeOperation],
    call_index: usize,
    terminator: &RuntimeTerminator,
) -> bool {
    let administrative_suffix = operations[call_index + 1..].iter().all(|operation| {
        matches!(
            operation.kind,
            "indirect.make" | "product.make" | "product.project" | "sum.make"
        )
    });
    if !administrative_suffix {
        return false;
    }
    match terminator {
        RuntimeTerminator::Return { .. } => true,
        RuntimeTerminator::Branch { arguments, .. } => arguments.len() == 1,
        RuntimeTerminator::Conditional { .. }
        | RuntimeTerminator::Switch { .. }
        | RuntimeTerminator::Trap { .. } => false,
    }
}

fn merge_meaning(left: &RuntimeMeaning, right: &RuntimeMeaning) -> RuntimeMeaning {
    match (left, right) {
        (RuntimeMeaning::SharedStore, _) | (_, RuntimeMeaning::SharedStore) => {
            RuntimeMeaning::SharedStore
        }
        (RuntimeMeaning::DeferredStore, RuntimeMeaning::DeferredStore) => {
            RuntimeMeaning::DeferredStore
        }
        (RuntimeMeaning::DeferredStore, RuntimeMeaning::ReusableStore)
        | (RuntimeMeaning::ReusableStore, RuntimeMeaning::DeferredStore) => {
            RuntimeMeaning::ReusableStore
        }
        (RuntimeMeaning::ReusableStore, RuntimeMeaning::ReusableStore) => {
            RuntimeMeaning::ReusableStore
        }
        (RuntimeMeaning::Sum { cases: left }, RuntimeMeaning::Sum { cases: right })
            if left == right =>
        {
            RuntimeMeaning::Sum {
                cases: left.clone(),
            }
        }
        _ => RuntimeMeaning::Plain,
    }
}

fn value_at_pattern(
    module: &crate::ast::Module,
    pattern: crate::ast::PatternId,
    target: crate::ast::PatternId,
    value: &Value,
) -> Option<Value> {
    if pattern == target {
        return Some(value.clone());
    }
    match &module.arena.patterns[pattern.0 as usize] {
        crate::ast::Pattern::Tuple { elements, .. } => {
            let values = as_tuple(value, elements.len())?;
            elements
                .iter()
                .zip(values)
                .find_map(|(pattern, value)| value_at_pattern(module, *pattern, target, &value))
        }
        crate::ast::Pattern::Array { elements, .. } => {
            let values = match value {
                Value::Array(values) => values.as_slice(),
                Value::EmptyArray { .. } => &[],
                _ => return None,
            };
            elements
                .iter()
                .zip(values)
                .find_map(|(pattern, value)| value_at_pattern(module, *pattern, target, value))
        }
        crate::ast::Pattern::Constructor { payload, .. } => {
            let pattern = payload.as_ref()?;
            let Value::Tag {
                payload: Some(value),
                ..
            } = value
            else {
                return None;
            };
            value_at_pattern(module, *pattern, target, value)
        }
        crate::ast::Pattern::Shape { fields, .. } => {
            let Value::Shape(values) = value else {
                return None;
            };
            fields.iter().find_map(|field| {
                values
                    .get(&field.name)
                    .and_then(|value| value_at_pattern(module, field.pattern, target, value))
            })
        }
        crate::ast::Pattern::Name { .. }
        | crate::ast::Pattern::Wildcard { .. }
        | crate::ast::Pattern::Pin { .. }
        | crate::ast::Pattern::Int { .. }
        | crate::ast::Pattern::Float { .. }
        | crate::ast::Pattern::Text { .. }
        | crate::ast::Pattern::Unit { .. } => None,
    }
}

fn runtime_type_at_pattern(
    module: &crate::ast::Module,
    pattern: crate::ast::PatternId,
    target: crate::ast::PatternId,
    type_id: usize,
    types: &[RuntimeType],
) -> Option<usize> {
    if pattern == target {
        return Some(type_id);
    }
    match &module.arena.patterns[pattern.0 as usize] {
        crate::ast::Pattern::Tuple { elements, .. } => {
            let RuntimeType::Product { fields, .. } = types.get(type_id)? else {
                return None;
            };
            elements.iter().enumerate().find_map(|(index, pattern)| {
                let field = fields
                    .iter()
                    .find(|field| field.name == index.to_string())?;
                runtime_type_at_pattern(module, *pattern, target, field.type_id, types)
            })
        }
        crate::ast::Pattern::Array { elements, .. } => {
            let RuntimeType::Store { element_type } = types.get(type_id)? else {
                return None;
            };
            elements.iter().find_map(|pattern| {
                runtime_type_at_pattern(module, *pattern, target, *element_type, types)
            })
        }
        crate::ast::Pattern::Constructor { name, payload, .. } => {
            let pattern = payload.as_ref()?;
            let RuntimeType::Sum { cases, .. } = types.get(type_id)? else {
                return None;
            };
            let case = cases.iter().find(|case_| case_.name == *name)?;
            runtime_type_at_pattern(module, *pattern, target, case.payload_type, types)
        }
        crate::ast::Pattern::Shape { fields, .. } => {
            let RuntimeType::Product {
                fields: runtime_fields,
                ..
            } = types.get(type_id)?
            else {
                return None;
            };
            fields.iter().find_map(|field| {
                let runtime_field = runtime_fields
                    .iter()
                    .find(|runtime_field| runtime_field.name == field.name)?;
                runtime_type_at_pattern(module, field.pattern, target, runtime_field.type_id, types)
            })
        }
        crate::ast::Pattern::Name { .. }
        | crate::ast::Pattern::Wildcard { .. }
        | crate::ast::Pattern::Pin { .. }
        | crate::ast::Pattern::Int { .. }
        | crate::ast::Pattern::Float { .. }
        | crate::ast::Pattern::Text { .. }
        | crate::ast::Pattern::Unit { .. } => None,
    }
}

fn runtime_type_at_path(
    mut type_id: usize,
    path: &[String],
    types: &[RuntimeType],
) -> Option<usize> {
    for name in path {
        let RuntimeType::Product { fields, .. } = types.get(type_id)? else {
            return None;
        };
        type_id = fields.iter().find(|field| field.name == *name)?.type_id;
    }
    Some(type_id)
}

#[derive(Clone)]
struct HostCall {
    capability: String,
    operation: String,
    argument: Value,
    ownership: RuntimeOperationOwnership,
}

struct RuntimeValueExport {
    name: String,
    value: Value,
    type_: Type,
}

struct StagedExport {
    name: String,
    runtime: Option<(Value, Type)>,
}

pub fn elaborate(
    context: Rc<Context>,
    path: &str,
    checked: CheckedModule,
) -> Result<RuntimeModule, Diagnostic> {
    let mut module = elaborate_common(context, path, checked, None)?;
    optimize_runtime_module(&mut module, None)?;
    Ok(module)
}

pub(crate) fn elaborate_development(
    context: Rc<Context>,
    path: &str,
    checked: CheckedModule,
    units: HashSet<String>,
) -> Result<RuntimeModule, Diagnostic> {
    let units = Rc::new(units);
    let mut module = elaborate_common(context, path, checked, Some(units.clone()))?;
    optimize_runtime_module(&mut module, Some(units.as_ref()))?;
    Ok(module)
}

fn elaborate_common(
    context: Rc<Context>,
    path: &str,
    checked: CheckedModule,
    development_units: Option<Rc<HashSet<String>>>,
) -> Result<RuntimeModule, Diagnostic> {
    let (result_is_shape, result_span) = {
        let modules = context.modules.borrow();
        let loaded = modules
            .get(path)
            .ok_or_else(|| hir_error("Runtime HIR elaboration lost its root module."))?;
        (
            matches!(
                loaded.module.arena.expressions[loaded.module.result.0 as usize],
                crate::ast::Expression::Shape { .. }
            ),
            loaded.module.arena.expression_span(loaded.module.result),
        )
    };
    let argument = module_argument(&checked.parameter)?;
    let computation = evaluate_checked_module(
        context.clone(),
        path,
        &checked,
        argument,
        Runtime::new(Phase::Runtime, path.to_owned()),
    );
    let (value, host_calls) = match complete_host_calls(computation) {
        Ok(completed) => completed,
        Err(error) if error.code == "BLOT_DYNAMIC_HOST_RESULT" && !result_is_shape => {
            return prepare_residual(context, path, checked, development_units);
        }
        Err(error) => return Err(error),
    };
    let staged = staged_exports(value, checked.result, result_is_shape)?;
    let runtime_export_count = staged
        .iter()
        .filter(|exported| exported.runtime.is_some())
        .count();
    if !host_calls.is_empty() && runtime_export_count > 1 {
        return Err(Diagnostic::new(
            "BLOT_TARGET_REFUSAL",
            "An effectful module top level cannot be replayed across multiple runtime fields; return one runtime value or move the effect into a returned function.",
            result_span,
        ));
    }
    if staged.iter().all(|exported| exported.runtime.is_none()) {
        return Err(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A compiled module needs at least one runtime export.",
            crate::ast::Span { start: 0, end: 0 },
        ));
    }
    prepare_exports(context, path, staged, host_calls, development_units)
}

fn prepare_exports(
    context: Rc<Context>,
    path: &str,
    staged: Vec<StagedExport>,
    host_calls: Vec<HostCall>,
    development_units: Option<Rc<HashSet<String>>>,
) -> Result<RuntimeModule, Diagnostic> {
    let mut value_exports = Vec::new();
    let mut function_exports = Vec::new();
    for exported in staged {
        match &exported.runtime {
            Some((_, Type::Function { .. })) => function_exports.push(exported),
            _ => value_exports.push(exported),
        }
    }
    if function_exports.is_empty() {
        return HirBuilder::new(path).build(value_exports, host_calls);
    }

    let mut modules = Vec::new();
    if !value_exports.is_empty() {
        modules.push(HirBuilder::new(path).build(value_exports, host_calls)?);
    }
    let trace = Rc::new(std::cell::RefCell::new(match development_units {
        Some(units) => ResidualTrace::development(path, units),
        None => ResidualTrace::new(path),
    }));
    for (index, exported) in function_exports.into_iter().enumerate() {
        if index > 0 {
            trace.borrow_mut().begin_function_export()?;
        }
        prepare_function_export(context.clone(), path, exported, &trace)?;
    }
    let trace = Rc::try_unwrap(trace)
        .map_err(|_| hir_error("Function exports left live residual evaluator references."))?
        .into_inner();
    modules.push(trace.finish_module()?);
    merge_runtime_modules(path, modules)
}

fn prepare_function_export(
    context: Rc<Context>,
    path: &str,
    exported: StagedExport,
    trace: &Rc<std::cell::RefCell<ResidualTrace>>,
) -> Result<(), Diagnostic> {
    let Some((mut function, mut type_)) = exported.runtime else {
        return Err(hir_error("A function export lost its runtime value."));
    };
    let reuse_assertion = match &function {
        Value::Closure {
            module,
            reuse_assertion,
            ..
        } => Some((
            reuse_assertion.is_some(),
            RuntimeSpan {
                file: module.as_ref().clone(),
                start: reuse_assertion.map_or(0, |span| span.start),
                end: reuse_assertion.map_or(0, |span| span.end),
            },
        )),
        _ => None,
    };
    let (reuse, function_span) = reuse_assertion.unwrap_or((
        false,
        RuntimeSpan {
            file: path.to_owned(),
            start: 0,
            end: 0,
        },
    ));
    let runtime = Runtime::residual(Phase::Runtime, path.to_owned(), trace.clone());
    let mut parameter_types = Vec::new();
    while let Type::Function {
        deferred,
        parameter,
        result,
        ..
    } = type_
    {
        if deferred {
            let (source, expression) = match &function {
                Value::Closure { module, body, .. } => (module.as_str(), *body),
                _ => {
                    let loaded = context.modules.borrow().get(path).cloned().ok_or_else(|| {
                        hir_error("A deferred export lost its loaded source module.")
                    })?;
                    (path, loaded.module.result)
                }
            };
            let loaded = context
                .modules
                .borrow()
                .get(source)
                .cloned()
                .ok_or_else(|| hir_error("A deferred export lost its defining module."))?;
            let span = loaded.module.arena.expression_span(expression);
            return Err(Diagnostic::new(
                "BLOT_DEFERRED_AT_RUNTIME",
                concat!(
                    "This deferred function crosses the public runtime ABI. Apply it inside ",
                    "Blot where demand can become control flow, or export an explicit strict ",
                    "or nullary function instead."
                ),
                span,
            ));
        }
        let (argument, parameter_type) = trace
            .borrow_mut()
            .export_parameter(&parameter, crate::ast::Span { start: 0, end: 0 })?;
        let input = match &function {
            Value::Closure { module, body, .. } => context
                .ownership_contracts
                .borrow()
                .get(module, body)
                .map(|contract| contract.input.clone())
                .unwrap_or(Produced::None),
            _ => Produced::None,
        };
        let argument = {
            let trace = trace.borrow();
            mark_reusable_stores(&input, argument, &trace.types)
        };
        let (application_module, application_expression) =
            match &function {
                Value::Closure { module, body, .. } => (module.as_str(), *body),
                _ => {
                    let loaded =
                        context.modules.borrow().get(path).cloned().ok_or_else(|| {
                            hir_error("A function export lost its source module.")
                        })?;
                    (path, loaded.module.result)
                }
            };
        let application =
            ApplicationSite::for_expression(&context, application_module, application_expression)?
                .compiler(CompilerApplication::RuntimeExportParameter(
                    parameter_types.len() as u32,
                ));
        parameter_types.push(parameter_type);
        function = complete_residual_host_calls(
            crate::eval::apply(
                context.clone(),
                function,
                argument,
                crate::ast::Span { start: 0, end: 0 },
                runtime.clone(),
                application,
            ),
            trace,
        )?;
        type_ = Rc::unwrap_or_clone(result);
    }
    drop(runtime);
    trace.borrow_mut().finish_function_export(
        exported.name,
        function,
        parameter_types,
        &type_,
        reuse,
        function_span,
    )
}

fn merge_runtime_modules(
    source: &str,
    modules: Vec<RuntimeModule>,
) -> Result<RuntimeModule, Diagnostic> {
    if modules.len() == 1 {
        return modules
            .into_iter()
            .next()
            .ok_or_else(|| hir_error("A runtime module merge lost its input."));
    }
    let mut types = Vec::new();
    let mut signatures = Vec::new();
    let mut functions = Vec::new();
    let mut capabilities = Vec::new();
    let mut links = Vec::new();
    let mut exports = Vec::new();
    for module in modules {
        let type_offset = types.len();
        let signature_offset = signatures.len();
        let function_offset = functions.len();
        for mut type_ in module.types {
            match &mut type_ {
                RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } => {
                    *element_type += type_offset;
                }
                RuntimeType::Indirect { target_type } => *target_type += type_offset,
                RuntimeType::Product { fields, .. } => {
                    for field in fields {
                        field.type_id += type_offset;
                    }
                }
                RuntimeType::Sum { cases, .. } => {
                    for case_ in cases {
                        case_.payload_type += type_offset;
                    }
                }
                RuntimeType::Sealed {
                    representation_type,
                    ..
                } => *representation_type += type_offset,
                _ => {}
            }
            types.push(type_);
        }
        for mut signature in module.signatures {
            for parameter in &mut signature.parameters {
                *parameter += type_offset;
            }
            signature.result += type_offset;
            signatures.push(signature);
        }
        for mut function in module.functions {
            function.id += function_offset;
            function.signature += signature_offset;
            for block in &mut function.blocks {
                for parameter in &mut block.parameters {
                    parameter.type_id += type_offset;
                }
                for operation in &mut block.operations {
                    operation.type_id += type_offset;
                    if let Some(target) = &mut operation.function {
                        *target += function_offset;
                    }
                    if let Some(signature) = &mut operation.signature {
                        *signature += signature_offset;
                    }
                }
            }
            functions.push(function);
        }
        for mut capability in module.capabilities {
            for operation in &mut capability.operations {
                operation.signature += signature_offset;
            }
            capabilities.push(capability);
        }
        for mut link in module.links {
            link.signature += signature_offset;
            links.push(link);
        }
        for mut exported in module.exports {
            if let RuntimeExport::Runtime {
                function,
                signature,
                ..
            } = &mut exported
            {
                *function += function_offset;
                *signature += signature_offset;
            }
            exports.push(exported);
        }
    }
    validate_runtime_layouts(&types)?;
    Ok(RuntimeModule {
        format: "blot-runtime-hir",
        schema_version: RUNTIME_HIR_SCHEMA,
        source: source.to_owned(),
        types,
        signatures,
        static_stores: Vec::new(),
        functions,
        capabilities,
        links,
        exports,
    })
}

fn prepare_residual(
    context: Rc<Context>,
    path: &str,
    checked: CheckedModule,
    development_units: Option<Rc<HashSet<String>>>,
) -> Result<RuntimeModule, Diagnostic> {
    let trace = Rc::new(std::cell::RefCell::new(match development_units {
        Some(units) => ResidualTrace::development(path, units),
        None => ResidualTrace::new(path),
    }));
    let argument = module_argument(&checked.parameter)?;
    let computation = evaluate_checked_module(
        context,
        path,
        &checked,
        argument,
        Runtime::residual(Phase::Runtime, path.to_owned(), trace.clone()),
    );
    let value = complete_residual_host_calls(computation, &trace)?;
    let trace = Rc::try_unwrap(trace)
        .map_err(|_| hir_error("The Rust residual trace still has live evaluator references."))?
        .into_inner();
    trace.finish(value, &checked.result)
}

fn evaluate_checked_module(
    context: Rc<Context>,
    path: &str,
    checked: &CheckedModule,
    argument: Value,
    runtime: Runtime,
) -> Computation {
    if checked.parameter.is_none()
        && let Some(environment) = &checked.evaluated
    {
        let result = context
            .modules
            .borrow()
            .get(path)
            .map(|loaded| loaded.module.result);
        let Some(result) = result else {
            return Computation::error(Diagnostic::new(
                "BLOT_UNRESOLVED_IMPORT",
                format!("Module `{path}` was not loaded."),
                crate::ast::Span { start: 0, end: 0 },
            ));
        };
        return evaluate_expression(
            context,
            Rc::new(path.to_owned()),
            result,
            environment.clone(),
            runtime,
        );
    }
    evaluate_module(context, path.to_owned(), argument, runtime)
}

fn complete_residual_host_calls(
    mut computation: Computation,
    trace: &Rc<std::cell::RefCell<ResidualTrace>>,
) -> Result<Value, Diagnostic> {
    loop {
        match computation {
            Computation::Done(result) => return result,
            Computation::Step(step) => computation = step.advance(),
            Computation::Perform { request, resume } => {
                if !request.host {
                    return Err(Diagnostic::new(
                        "BLOT_UNHANDLED_EFFECT",
                        format!(
                            "Nothing handles `{}.{}` at the module boundary.",
                            request.effect_name, request.operation
                        ),
                        request.span,
                    ));
                }
                let result = trace.borrow_mut().host_call(
                    request.effect_name,
                    request.operation,
                    &request.argument,
                    &request.result_type,
                    &request.operation_ownership,
                    request.span,
                )?;
                computation = resume.advance(result);
            }
        }
    }
}

fn module_argument(parameter: &Option<Type>) -> Result<Value, Diagnostic> {
    let Some(parameter) = parameter else {
        return Ok(Value::Unit);
    };
    let Type::Record(fields) = parameter else {
        return Err(hir_error(
            "The module input must be a record of capabilities.",
        ));
    };
    let mut operations = OrderedFields::default();
    for (name, signature) in fields {
        let Type::Function {
            parameter, result, ..
        } = signature
        else {
            return Err(hir_error(&format!(
                "The module capability `{name}` is not a function."
            )));
        };
        operations.insert(
            name.clone(),
            Value::Arrow {
                deferred: false,
                domain: Box::new(type_value(parameter)),
                codomain: Box::new(type_value(result)),
                effects: Vec::new(),
                effect_tail: None,
            },
        );
    }
    let effect = Value::Effect {
        id: u32::MAX,
        name: "Init".to_owned(),
        operation_ownership: operations
            .keys()
            .map(|name| (name.clone(), EffectOperationOwnership::unrestricted()))
            .collect(),
        operations,
        host: true,
    };
    let Value::Effect { operations, .. } = &effect else {
        unreachable!();
    };
    Ok(Value::Shape(
        operations
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    Value::Operation {
                        effect: Box::new(effect.clone()),
                        name: name.clone(),
                    },
                )
            })
            .collect(),
    ))
}

fn type_value(type_: &Type) -> Value {
    match type_ {
        Type::Variable(_) | Type::Rigid(_) | Type::Top | Type::Bottom => Value::Unbounded,
        Type::Forall { variables, body } => {
            variables
                .iter()
                .rev()
                .fold(type_value(body), |body, variable| Value::Forall {
                    variable: *variable,
                    body: Box::new(body),
                })
        }
        Type::Range { domain, low, high } => {
            let bound = |bound: &Option<Scalar>| match bound {
                Some(Scalar::Int(value)) => Value::Int(value.clone()),
                Some(Scalar::Text(value)) => Value::Text(value.clone()),
                None => Value::Unbounded,
            };
            let domain = match domain {
                Domain::Int => crate::value::Domain::Int,
                Domain::Text => crate::value::Domain::Text,
                Domain::Float => crate::value::Domain::Float,
                Domain::Float32 => crate::value::Domain::Float32,
            };
            Value::Range {
                low: Box::new(bound(low)),
                high: Box::new(bound(high)),
                domain: Some(domain),
            }
        }
        Type::Unit => Value::Unit,
        Type::Function {
            parameter, result, ..
        } => Value::Arrow {
            deferred: false,
            domain: Box::new(type_value(parameter)),
            codomain: Box::new(type_value(result)),
            effects: Vec::new(),
            effect_tail: None,
        },
        Type::Record(fields) => Value::Shape(
            fields
                .iter()
                .map(|(name, type_)| (name.clone(), type_value(type_)))
                .collect(),
        ),
        Type::RecordUpdate { base, fields } => {
            let updated =
                crate::typecheck::record_update_type(base.as_ref().clone(), fields.clone());
            if matches!(updated, Type::RecordUpdate { .. }) {
                Value::Unbounded
            } else {
                type_value(&updated)
            }
        }
        Type::Array(element) => Value::Array(vec![type_value(element)].into()),
        Type::Region(element) => Value::RegionType(Box::new(type_value(element))),
        Type::Scratch(element) => Value::ScratchType(Box::new(type_value(element))),
        Type::Variant { cases, .. } => Value::Union(
            cases
                .iter()
                .map(|(name, payload)| Value::Tag {
                    name: name.clone(),
                    payload: if matches!(payload, Type::Unit) {
                        None
                    } else {
                        Some(Box::new(type_value(payload)))
                    },
                })
                .collect(),
        ),
        Type::Union(members) => Value::Union(members.iter().map(type_value).collect()),
        Type::Opaque(name) => Value::OpaqueType(name.clone()),
        Type::Effects(_) | Type::OpenEffects { .. } => Value::Unit,
    }
}

fn complete_host_calls(mut computation: Computation) -> Result<(Value, Vec<HostCall>), Diagnostic> {
    let mut calls = Vec::new();
    loop {
        match computation {
            Computation::Done(result) => return result.map(|value| (value, calls)),
            Computation::Step(step) => computation = step.advance(),
            Computation::Perform { request, resume } => {
                if !request.host {
                    return Err(Diagnostic::new(
                        "BLOT_UNHANDLED_EFFECT",
                        format!(
                            "Nothing handles `{}.{}` at the module boundary.",
                            request.effect_name, request.operation
                        ),
                        request.span,
                    ));
                }
                if !matches!(
                    request.result_type,
                    Value::Unit | Value::Unbounded | Value::TypeVariable(_)
                ) {
                    return Err(Diagnostic::new(
                        "BLOT_DYNAMIC_HOST_RESULT",
                        format!(
                            "The staged host call `{}.{}` must return Unit.",
                            request.effect_name, request.operation
                        ),
                        request.span,
                    ));
                }
                calls.push(HostCall {
                    capability: request.effect_name,
                    operation: request.operation,
                    argument: request.argument,
                    ownership: runtime_operation_ownership(&request.operation_ownership),
                });
                computation = resume.advance(Value::Unit);
            }
        }
    }
}

fn staged_exports(
    value: Value,
    type_: Type,
    result_is_shape: bool,
) -> Result<Vec<StagedExport>, Diagnostic> {
    if result_is_shape && let Value::Shape(fields) = value {
        let Type::Record(types) = type_ else {
            return Err(hir_error(
                "The inferred module result does not match its record value.",
            ));
        };
        return fields
            .into_iter()
            .map(|(name, value)| {
                if compile_time_only(&value) {
                    return Ok(StagedExport {
                        name,
                        runtime: None,
                    });
                }
                let type_ = types.get(&name).cloned().ok_or_else(|| {
                    hir_error(&format!(
                        "The inferred module result omitted export `{name}`."
                    ))
                })?;
                Ok(StagedExport {
                    name,
                    runtime: Some((value, type_)),
                })
            })
            .collect();
    }
    if compile_time_only(&value) {
        return Ok(vec![StagedExport {
            name: "default".to_owned(),
            runtime: None,
        }]);
    }
    Ok(vec![StagedExport {
        name: "default".to_owned(),
        runtime: Some((value, type_)),
    }])
}

fn compile_time_only(value: &Value) -> bool {
    match value {
        Value::OpaqueType(_)
        | Value::Range { .. }
        | Value::Union(_)
        | Value::Unbounded
        | Value::Arrow { .. }
        | Value::TypeVariable(_)
        | Value::Forall { .. }
        | Value::Effect { .. }
        | Value::Extended { .. } => true,
        Value::Sealed { inner, .. } => compile_time_only(inner),
        Value::Shape(fields) => fields.iter().all(|(_, value)| compile_time_only(value)),
        Value::Array(elements) => elements.iter().all(compile_time_only),
        _ => false,
    }
}

struct HirBuilder {
    source: String,
    span: RuntimeSpan,
    types: Vec<RuntimeType>,
    type_ids: HashMap<String, usize>,
    signatures: Vec<RuntimeSignature>,
    capability_signatures:
        BTreeMap<String, BTreeMap<String, (usize, String, RuntimeOperationOwnership)>>,
    next_value: usize,
}

impl HirBuilder {
    fn new(source: &str) -> Self {
        let mut builder = Self {
            source: source.to_owned(),
            span: RuntimeSpan {
                file: source.to_owned(),
                start: 0,
                end: 0,
            },
            types: Vec::new(),
            type_ids: HashMap::new(),
            signatures: Vec::new(),
            capability_signatures: BTreeMap::new(),
            next_value: 0,
        };
        builder.insert_type("unit".to_owned(), RuntimeType::Unit);
        builder
    }

    fn build(
        mut self,
        staged: Vec<StagedExport>,
        host_calls: Vec<HostCall>,
    ) -> Result<RuntimeModule, Diagnostic> {
        let mut functions = Vec::new();
        let mut exports = Vec::new();
        for exported in staged {
            let Some((value, type_)) = exported.runtime else {
                exports.push(RuntimeExport::Comptime {
                    source_name: exported.name,
                    phase: "comptime",
                });
                continue;
            };
            let runtime_export = RuntimeValueExport {
                name: exported.name,
                value,
                type_,
            };
            let function_id = functions.len();
            let function = self.function(&runtime_export, &host_calls, function_id)?;
            exports.push(RuntimeExport::Runtime {
                source_name: runtime_export.name.clone(),
                phase: "runtime",
                wasm_name: format!("blot:{}", runtime_export.name),
                function: function_id,
                signature: function.signature,
                ownership: "owned",
            });
            functions.push(function);
        }
        let capabilities = self
            .capability_signatures
            .into_iter()
            .map(|(name, operations)| RuntimeCapability {
                name,
                operations: operations
                    .into_iter()
                    .map(
                        |(name, (signature, _, ownership))| RuntimeCapabilityOperation {
                            name,
                            signature,
                            ownership,
                        },
                    )
                    .collect(),
            })
            .collect();
        validate_runtime_layouts(&self.types)?;
        Ok(RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: self.source,
            types: self.types,
            signatures: self.signatures,
            static_stores: Vec::new(),
            functions,
            capabilities,
            links: Vec::new(),
            exports,
        })
    }

    fn function(
        &mut self,
        exported: &RuntimeValueExport,
        host_calls: &[HostCall],
        id: usize,
    ) -> Result<RuntimeFunction, Diagnostic> {
        self.next_value = 0;
        let result_type = self.runtime_type(&exported.type_, &exported.value)?;
        let effects = host_calls
            .iter()
            .map(|call| call.capability.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let signature = self.signatures.len();
        self.signatures.push(RuntimeSignature {
            parameters: Vec::new(),
            result: result_type,
            effects,
        });
        let mut operations = Vec::new();
        for call in host_calls {
            self.host_call(call, &mut operations)?;
        }
        let result = self.value(&exported.value, &exported.type_, &mut operations)?;
        Ok(RuntimeFunction {
            id,
            name: format!("blot$constant${}", exported.name),
            signature,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: Vec::new(),
                operations,
                terminator: RuntimeTerminator::Return {
                    value: result,
                    span: self.span.clone(),
                },
            }],
            span: self.span.clone(),
        })
    }

    fn runtime_type(&mut self, type_: &Type, value: &Value) -> Result<usize, Diagnostic> {
        match type_ {
            Type::Range { domain, .. } => match domain {
                Domain::Int => {
                    Ok(self
                        .insert_type("signed-integer-64".to_owned(), RuntimeType::SignedInteger64))
                }
                Domain::Text => Ok(self.insert_type("text".to_owned(), RuntimeType::Text)),
                Domain::Float => Ok(self.insert_type("float-64".to_owned(), RuntimeType::Float64)),
                Domain::Float32 => {
                    Ok(self.insert_type("float-32".to_owned(), RuntimeType::Float32))
                }
            },
            Type::Unit => Ok(0),
            Type::Record(fields) => {
                let Value::Shape(values) = value else {
                    return Err(self.mismatch(value, "record"));
                };
                let mut runtime_fields = Vec::new();
                for (name, field_type) in fields {
                    let field_value = values
                        .get(name)
                        .ok_or_else(|| self.mismatch(value, "record"))?;
                    runtime_fields.push(RuntimeField {
                        name: name.clone(),
                        type_id: self.runtime_type(field_type, field_value)?,
                    });
                }
                let key = format!(
                    "product:{}",
                    runtime_fields
                        .iter()
                        .map(|field| format!("{}:{}", field.name, field.type_id))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let tuple = runtime_fields
                    .iter()
                    .enumerate()
                    .all(|(index, field)| field.name == index.to_string());
                let name = if tuple {
                    format!("Tuple{}", runtime_fields.len())
                } else {
                    format!("RustShape{}", self.types.len())
                };
                Ok(self.insert_type(
                    key,
                    RuntimeType::Product {
                        name,
                        fields: runtime_fields,
                    },
                ))
            }
            Type::RecordUpdate { base, fields } => {
                let updated =
                    crate::typecheck::record_update_type(base.as_ref().clone(), fields.clone());
                if matches!(updated, Type::RecordUpdate { .. }) {
                    return Err(hir_error(
                        "A record update type must be resolved before it reaches the runtime boundary.",
                    ));
                }
                self.runtime_type(&updated, value)
            }
            Type::Region(_) => Err(hir_error(
                "A live Region is compiler-private and cannot cross the runtime export boundary.",
            )),
            Type::Scratch(_) => Err(hir_error(
                "A live Scratch is compiler-private and cannot cross the runtime export boundary.",
            )),
            Type::Opaque(name) if name == "Rejoin" => Err(hir_error(
                "A live Region rejoin witness is compiler-private and cannot cross the runtime export boundary.",
            )),
            Type::Array(element) => {
                let (elements, element_value) = match value {
                    Value::Array(elements) => (
                        elements.as_slice(),
                        elements.first().unwrap_or(&Value::Unit),
                    ),
                    Value::EmptyArray { element } => (&[] as &[Value], element.as_ref()),
                    _ => return Err(self.mismatch(value, "array")),
                };
                let element_type =
                    if elements.is_empty() && matches!(element.as_ref(), Type::Bottom) {
                        0
                    } else {
                        self.runtime_type(element, element_value)?
                    };
                Ok(self.insert_type(
                    format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Type::Variant { cases, .. } => {
                if cases
                    .iter()
                    .all(|(name, _)| name == "True" || name == "False")
                {
                    return Ok(self.insert_type("boolean".to_owned(), RuntimeType::Boolean));
                }
                let Value::Tag { name, payload } = value else {
                    return Err(self.mismatch(value, "variant"));
                };
                let mut cases = cases.to_vec();
                if !cases.iter().any(|(candidate, _)| candidate == name) {
                    cases.push((
                        name.clone(),
                        payload
                            .as_deref()
                            .map(type_from_value)
                            .unwrap_or(Type::Unit),
                    ));
                }
                let mut runtime_cases = Vec::new();
                for (case_name, payload_type) in &cases {
                    let unit = Value::Unit;
                    let representative;
                    let payload_value = if case_name == name {
                        payload.as_deref().unwrap_or(&unit)
                    } else {
                        representative = representative_value(payload_type);
                        representative.as_ref().unwrap_or(&unit)
                    };
                    runtime_cases.push(RuntimeCase {
                        name: case_name.clone(),
                        payload_type: self.runtime_type(payload_type, payload_value)?,
                    });
                }
                let key = format!(
                    "sum:{}",
                    runtime_cases
                        .iter()
                        .map(|case_| format!("{}:{}", case_.name, case_.payload_type))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                Ok(self.insert_type(
                    key,
                    RuntimeType::Sum {
                        name: format!("RustSum{}", self.types.len()),
                        cases: runtime_cases,
                    },
                ))
            }
            Type::Opaque(name) if simd_layout(name).is_some() => {
                let layout = simd_layout(name).expect("matched SIMD type");
                Ok(self.insert_type(layout.key(), layout.runtime_type()))
            }
            Type::Opaque(name) if sealed_type_name(name).is_some() => {
                let (seal_name, inner) = if let Value::Sealed { name, inner } = value {
                    (name.clone(), inner.as_ref())
                } else {
                    (
                        sealed_type_name(name)
                            .expect("matched sealed type")
                            .to_owned(),
                        value,
                    )
                };
                let representation = type_from_value(inner);
                let representation_type = self.runtime_type(&representation, inner)?;
                Ok(self.insert_type(
                    format!("sealed:{seal_name}:{representation_type}"),
                    RuntimeType::Sealed {
                        name: seal_name,
                        representation_type,
                    },
                ))
            }
            Type::Union(members) => {
                let all_variants = members
                    .iter()
                    .all(|member| matches!(member, Type::Variant { .. } | Type::Bottom));
                if all_variants {
                    let mut cases: Vec<(String, Type)> = Vec::new();
                    for member in members {
                        let Type::Variant { cases: variant, .. } = member else {
                            continue;
                        };
                        for (name, payload) in variant {
                            if !cases.iter().any(|(candidate, _)| candidate == name) {
                                cases.push((name.clone(), payload.clone()));
                            }
                        }
                    }
                    if !cases.is_empty() {
                        return self.runtime_type(
                            &Type::Variant {
                                cases: cases.into(),
                                open: false,
                            },
                            value,
                        );
                    }
                }
                self.runtime_type(&type_from_value(value), value)
            }
            Type::Bottom => self.runtime_type(&type_from_value(value), value),
            Type::Variable(_)
            | Type::Rigid(_)
            | Type::Forall { .. }
            | Type::Function { .. }
            | Type::Effects(_)
            | Type::OpenEffects { .. }
            | Type::Opaque(_)
            | Type::Top => Err(hir_error(&format!(
                "The runtime value cannot cross the boundary as {:?}.",
                type_name(type_)
            ))),
        }
    }

    fn value(
        &mut self,
        value: &Value,
        type_: &Type,
        operations: &mut Vec<RuntimeOperation>,
    ) -> Result<usize, Diagnostic> {
        if matches!(type_, Type::Bottom) {
            return self.value(value, &type_from_value(value), operations);
        }
        if let Type::Union(members) = type_ {
            if let Value::Tag { .. } = value {
                let mut cases: Vec<(String, Type)> = Vec::new();
                for member in members {
                    let Type::Variant { cases: variant, .. } = member else {
                        continue;
                    };
                    for (name, payload) in variant {
                        if !cases.iter().any(|(candidate, _)| candidate == name) {
                            cases.push((name.clone(), payload.clone()));
                        }
                    }
                }
                if !cases.is_empty() {
                    return self.value(
                        value,
                        &Type::Variant {
                            cases: cases.into(),
                            open: false,
                        },
                        operations,
                    );
                }
            }
            return self.value(value, &type_from_value(value), operations);
        }
        let type_id = self.runtime_type(type_, value)?;
        match value {
            Value::Unit => Ok(self.constant(WireConstant::Unit, type_id, "plain", operations)),
            Value::Int(value) => Ok(self.constant(
                WireConstant::SignedInteger64(value.to_string()),
                type_id,
                "plain",
                operations,
            )),
            Value::Float(value) => {
                Ok(self.constant(WireConstant::Float64(*value), type_id, "plain", operations))
            }
            Value::Float32(value) => {
                Ok(self.constant(WireConstant::Float32(*value), type_id, "plain", operations))
            }
            Value::Text(value) => Ok(self.constant(
                WireConstant::Text(value.clone()),
                type_id,
                "owned",
                operations,
            )),
            Value::Tag { name, payload }
                if (name == "True" || name == "False") && payload.is_none() =>
            {
                Ok(self.constant(
                    WireConstant::Boolean(name == "True"),
                    type_id,
                    "plain",
                    operations,
                ))
            }
            Value::Shape(fields) => {
                let Type::Record(types) = type_ else {
                    return Err(self.mismatch(value, "record"));
                };
                let mut operands = Vec::new();
                for (name, field_type) in types {
                    let field = fields
                        .get(name)
                        .ok_or_else(|| self.mismatch(value, "record"))?;
                    operands.push(self.value(field, field_type, operations)?);
                }
                Ok(self.operation("product.make", type_id, operands, "owned", operations))
            }
            Value::Array(elements) => {
                let Type::Array(element_type) = type_ else {
                    return Err(self.mismatch(value, "array"));
                };
                if elements.is_empty() {
                    return Ok(self.operation(
                        "store.empty",
                        type_id,
                        Vec::new(),
                        "owned",
                        operations,
                    ));
                }
                let elements = elements
                    .iter()
                    .map(|element| self.value(element, element_type, operations))
                    .collect::<Result<Vec<_>, Diagnostic>>()?;
                Ok(self.operation("store.literal", type_id, elements, "owned", operations))
            }
            Value::EmptyArray { .. } => {
                let Type::Array(_) = type_ else {
                    return Err(self.mismatch(value, "array"));
                };
                Ok(self.operation("store.empty", type_id, Vec::new(), "owned", operations))
            }
            Value::Tag { name, payload } => {
                let Type::Variant { cases, .. } = type_ else {
                    return Err(self.mismatch(value, "variant"));
                };
                let RuntimeType::Sum {
                    cases: runtime_cases,
                    ..
                } = &self.types[type_id]
                else {
                    return Err(self.mismatch(value, "variant"));
                };
                let case = runtime_cases
                    .iter()
                    .position(|candidate| &candidate.name == name)
                    .ok_or_else(|| self.mismatch(value, "variant"))?;
                let inferred_payload = cases.get(name).cloned();
                let unit = Value::Unit;
                let payload_value = payload.as_deref().unwrap_or(&unit);
                let payload_type =
                    inferred_payload.unwrap_or_else(|| type_from_value(payload_value));
                let payload = self.value(payload_value, &payload_type, operations)?;
                let result = self.next_value();
                operations.push(RuntimeOperation {
                    kind: "sum.make",
                    result,
                    type_id,
                    operands: vec![payload],
                    ownership: "owned",
                    span: self.span.clone(),
                    value: None,
                    update: None,
                    case: Some(case),
                    capability: None,
                    operation: None,
                    operator: None,
                    conversion: None,
                    lane: None,
                    field: None,
                    function: None,
                    signature: None,
                    static_store: None,
                });
                Ok(result)
            }
            Value::Sealed { inner, .. } => {
                let inner_type = type_from_value(inner);
                let inner = self.value(inner, &inner_type, operations)?;
                Ok(self.operation("seal.wrap", type_id, vec![inner], "owned", operations))
            }
            value if matches!(type_, Type::Opaque(name) if sealed_type_name(name).is_some()) => {
                let inner_type = type_from_value(value);
                let inner = self.value(value, &inner_type, operations)?;
                Ok(self.operation("seal.wrap", type_id, vec![inner], "owned", operations))
            }
            _ => Err(self.mismatch(value, "first-order runtime value")),
        }
    }

    fn host_call(
        &mut self,
        call: &HostCall,
        operations: &mut Vec<RuntimeOperation>,
    ) -> Result<(), Diagnostic> {
        let argument_type = type_from_value(&call.argument);
        let parameter_type = self.runtime_type(&argument_type, &call.argument)?;
        let parameter_key = format!("{parameter_type}");
        let unit_type = 0;
        let capability = self
            .capability_signatures
            .entry(call.capability.clone())
            .or_default();
        let signature = if let Some((signature, existing_key, existing_ownership)) =
            capability.get(&call.operation)
        {
            if existing_key != &parameter_key || existing_ownership != &call.ownership {
                return Err(hir_error(&format!(
                    "Host operation {}.{} has inconsistent argument types or ownership contracts.",
                    call.capability, call.operation
                )));
            }
            *signature
        } else {
            let signature = self.signatures.len();
            self.signatures.push(RuntimeSignature {
                parameters: vec![parameter_type],
                result: unit_type,
                effects: vec![call.capability.clone()],
            });
            capability.insert(
                call.operation.clone(),
                (signature, parameter_key, call.ownership.clone()),
            );
            signature
        };
        let _ = signature;
        let argument = self.value(&call.argument, &argument_type, operations)?;
        let result = self.next_value();
        operations.push(RuntimeOperation {
            kind: "host.call",
            result,
            type_id: unit_type,
            operands: vec![argument],
            ownership: "plain",
            span: self.span.clone(),
            value: None,
            update: None,
            case: None,
            capability: Some(call.capability.clone()),
            operation: Some(call.operation.clone()),
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        Ok(())
    }

    fn constant(
        &mut self,
        value: WireConstant,
        type_id: usize,
        ownership: &'static str,
        operations: &mut Vec<RuntimeOperation>,
    ) -> usize {
        let result = self.next_value();
        operations.push(RuntimeOperation {
            kind: "constant",
            result,
            type_id,
            operands: Vec::new(),
            ownership,
            span: self.span.clone(),
            value: Some(value),
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        result
    }

    fn operation(
        &mut self,
        kind: &'static str,
        type_id: usize,
        operands: Vec<usize>,
        ownership: &'static str,
        operations: &mut Vec<RuntimeOperation>,
    ) -> usize {
        let result = self.next_value();
        operations.push(RuntimeOperation {
            kind,
            result,
            type_id,
            operands,
            ownership,
            span: self.span.clone(),
            value: None,
            update: None,
            case: None,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        });
        result
    }

    fn insert_type(&mut self, key: String, type_: RuntimeType) -> usize {
        if let Some(existing) = self.type_ids.get(&key) {
            return *existing;
        }
        let id = self.types.len();
        self.types.push(type_);
        self.type_ids.insert(key, id);
        id
    }

    fn next_value(&mut self) -> usize {
        let value = self.next_value;
        self.next_value += 1;
        value
    }

    fn mismatch(&self, value: &Value, expected: &str) -> Diagnostic {
        hir_error(&format!(
            "The staged {} does not inhabit its inferred {expected} type.",
            crate::value::show(value)
        ))
    }
}

fn type_from_value(value: &Value) -> Type {
    match value {
        Value::Int(value) => Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(value.clone())),
            high: Some(Scalar::Int(value.clone())),
        },
        Value::Float(_) => Type::Range {
            domain: Domain::Float,
            low: None,
            high: None,
        },
        Value::Float32(_) => Type::Range {
            domain: Domain::Float32,
            low: None,
            high: None,
        },
        Value::Text(value) => Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(value.clone())),
            high: Some(Scalar::Text(value.clone())),
        },
        Value::Unit => Type::Unit,
        Value::Shape(fields) => Type::Record(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), type_from_value(value)))
                .collect(),
        ),
        Value::Array(elements) => Type::Array(Rc::new(
            elements
                .first()
                .map(type_from_value)
                .unwrap_or(Type::Bottom),
        )),
        Value::EmptyArray { .. } => Type::Array(Rc::new(Type::Bottom)),
        Value::Scratch { values, .. } => Type::Scratch(Rc::new(
            values.first().map(type_from_value).unwrap_or(Type::Bottom),
        )),
        Value::Tag { name, payload } => Type::Variant {
            cases: vec![(
                name.clone(),
                payload
                    .as_deref()
                    .map(type_from_value)
                    .unwrap_or(Type::Unit),
            )]
            .into(),
            open: false,
        },
        Value::Sealed { name, inner } => sealed_type(name, &type_from_value(inner))
            .expect("a runtime sealed value has a closed carrier type"),
        Value::Vector(_) => Type::Opaque("F32x4".to_owned()),
        Value::VectorMask(_) => Type::Opaque("F32x4Mask".to_owned()),
        Value::IntegerVector { bits, lanes } => Type::Opaque(format!("I{bits}x{}", lanes.len())),
        Value::IntegerVectorMask { bits, lanes } => {
            Type::Opaque(format!("I{bits}x{}Mask", lanes.len()))
        }
        _ => Type::Top,
    }
}

fn representative_value(type_: &Type) -> Option<Value> {
    match type_ {
        Type::Unit => Some(Value::Unit),
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(value)),
            ..
        } => Some(Value::Int(value.clone())),
        Type::Range {
            domain: Domain::Int,
            ..
        } => Some(Value::Int(0.into())),
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(value)),
            ..
        } => Some(Value::Text(value.clone())),
        Type::Range {
            domain: Domain::Text,
            ..
        } => Some(Value::Text(String::new())),
        Type::Range {
            domain: Domain::Float,
            ..
        } => Some(Value::Float(0.0)),
        Type::Range {
            domain: Domain::Float32,
            ..
        } => Some(Value::Float32(0.0)),
        Type::Record(fields) => Some(Value::Shape(
            fields
                .iter()
                .map(|(name, type_)| Some((name.clone(), representative_value(type_)?)))
                .collect::<Option<Vec<_>>>()?
                .into_iter()
                .collect(),
        )),
        Type::Array(_) => Some(Value::Array(Vec::new().into())),
        Type::Variant { cases, .. } => {
            let (name, payload) = cases.first()?;
            Some(Value::Tag {
                name: name.clone(),
                payload: if matches!(payload, Type::Unit) {
                    None
                } else {
                    Some(Box::new(representative_value(payload)?))
                },
            })
        }
        Type::Opaque(name) if name == "F32x4" => Some(Value::Vector([0.0; 4])),
        Type::Opaque(name) if name == "F32x4Mask" => Some(Value::VectorMask([false; 4])),
        Type::Opaque(name) if name == "I32x4" => Some(Value::IntegerVector {
            bits: 32,
            lanes: vec![0; 4],
        }),
        Type::Opaque(name) if name == "I16x8" => Some(Value::IntegerVector {
            bits: 16,
            lanes: vec![0; 8],
        }),
        Type::Opaque(name) if name == "I8x16" => Some(Value::IntegerVector {
            bits: 8,
            lanes: vec![0; 16],
        }),
        Type::Opaque(name) if name == "I32x4Mask" => Some(Value::IntegerVectorMask {
            bits: 32,
            lanes: vec![false; 4],
        }),
        Type::Opaque(name) if name == "I16x8Mask" => Some(Value::IntegerVectorMask {
            bits: 16,
            lanes: vec![false; 8],
        }),
        Type::Opaque(name) if name == "I8x16Mask" => Some(Value::IntegerVectorMask {
            bits: 8,
            lanes: vec![false; 16],
        }),
        _ => None,
    }
}

fn type_name(type_: &Type) -> &'static str {
    match type_ {
        Type::Variable(_) => "type variable",
        Type::Rigid(_) => "rigid type variable",
        Type::Forall { .. } => "polymorphic type",
        Type::Function { .. } => "function",
        Type::Effects(_) => "effect row",
        Type::Opaque(_) => "opaque type",
        Type::Top => "top",
        Type::Bottom => "bottom",
        _ => "runtime type",
    }
}

/// What ABI 2 says about the private function-choice layout. The tag and its
/// capture product are Runtime HIR's own bookkeeping: they name compiler-local
/// closure sources, so no caller could read one even if it were exported.
fn closure_choice_refusal(alternatives: usize) -> String {
    format!(
        "A function choice over {alternatives} closure sources is a private Runtime HIR layout. Blot Core Wasm ABI 2 has no representation for it, so it cannot cross a runtime boundary; apply the function inside the program instead."
    )
}

fn hir_error(message: &str) -> Diagnostic {
    Diagnostic::new(
        "BLOT_UNSUPPORTED_LOWERING",
        message,
        crate::ast::Span { start: 0, end: 0 },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_sum_tags_use_the_runtime_type_constructor_set() {
        let mut trace = ResidualTrace::new("sum-meaning-test.blot");
        let sum_type = trace.sum_type(&["Left".to_owned(), "Right".to_owned()], &[0, 0]);
        let target = RuntimeValue {
            id: 0,
            type_id: sum_type,
            meaning: RuntimeMeaning::Plain,
        };

        let tag = trace
            .sum_tag(&target, crate::ast::Span { start: 0, end: 0 })
            .expect("a typed runtime sum should expose its constructor tag");

        assert_eq!(tag.type_id, 2);
        assert_eq!(trace.blocks[0].operations[0].kind, "sum.tag");
    }

    #[test]
    fn residual_sum_types_are_canonical_by_constructor_name() {
        let mut trace = ResidualTrace::new("sum-order-test.blot");
        let some_then_none = trace.sum_type(&["Some".to_owned(), "None".to_owned()], &[4, 0]);
        let none_then_some = trace.sum_type(&["None".to_owned(), "Some".to_owned()], &[0, 4]);

        assert_eq!(some_then_none, none_then_some);
        let RuntimeType::Sum { cases, .. } = &trace.types[some_then_none] else {
            panic!("residual sum should use a sum representation");
        };
        assert_eq!(cases[0].name, "None");
        assert_eq!(cases[0].payload_type, 0);
        assert_eq!(cases[1].name, "Some");
        assert_eq!(cases[1].payload_type, 4);
    }

    #[test]
    fn online_aggregate_representations_distinguish_runtime_leaf_types() {
        let store_then_integer = Value::Shape(OrderedFields::from([
            (
                "0".to_owned(),
                Value::Runtime(RuntimeValue {
                    id: 1,
                    type_id: 6,
                    meaning: RuntimeMeaning::Plain,
                }),
            ),
            (
                "1".to_owned(),
                Value::Runtime(RuntimeValue {
                    id: 2,
                    type_id: 4,
                    meaning: RuntimeMeaning::Plain,
                }),
            ),
        ]));
        let integer_pair = Value::Shape(OrderedFields::from([
            (
                "0".to_owned(),
                Value::Runtime(RuntimeValue {
                    id: 3,
                    type_id: 4,
                    meaning: RuntimeMeaning::Plain,
                }),
            ),
            (
                "1".to_owned(),
                Value::Runtime(RuntimeValue {
                    id: 4,
                    type_id: 4,
                    meaning: RuntimeMeaning::Plain,
                }),
            ),
        ]));
        let mut representations = CheckedAggregateRepresentations::default();
        representations.record(&store_then_integer, 8);

        assert_eq!(representations.get(&integer_pair), None);
    }

    #[test]
    fn online_aggregate_representations_distinguish_static_leaf_types() {
        let integer = Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            Value::Int(0.into()),
        )]));
        let float = Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            Value::Float(0.0),
        )]));
        let mut representations = CheckedAggregateRepresentations::default();
        representations.record(&integer, 4);

        assert_eq!(representations.get(&float), None);
    }

    #[test]
    fn dead_total_operations_are_removed_without_erasing_traps() {
        let mut total = operation("product.project", 1, vec![0], None, None);
        total.field = Some(0);
        let mut trapping = operation("scalar", 2, vec![0, 0], None, None);
        trapping.operator = Some("divide");
        let mut function = RuntimeFunction {
            id: 0,
            name: "dead-operation-test".to_owned(),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0)],
                operations: vec![total, trapping],
                terminator: RuntimeTerminator::Return {
                    value: 0,
                    span: span(),
                },
            }],
            span: span(),
        };

        eliminate_dead_pure_operations(&mut function);

        assert_eq!(function.blocks[0].operations.len(), 1);
        assert_eq!(function.blocks[0].operations[0].operator, Some("divide"));
    }

    #[test]
    fn dead_pure_operation_chain_is_eliminated_once_per_definition() {
        const OPERATION_COUNT: usize = 4_096;
        let operations = (1..=OPERATION_COUNT)
            .map(|result| {
                operation(
                    "scalar.unary",
                    result,
                    vec![result.saturating_sub(1)],
                    None,
                    None,
                )
            })
            .collect();
        let mut function = RuntimeFunction {
            id: 0,
            name: "dead-operation-chain-test".to_owned(),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0)],
                operations,
                terminator: RuntimeTerminator::Return {
                    value: 0,
                    span: span(),
                },
            }],
            span: span(),
        };
        RUNTIME_DEAD_OPERATION_VISITS.with(|visits| visits.set(0));

        eliminate_dead_pure_operations(&mut function);

        assert!(function.blocks[0].operations.is_empty());
        assert_eq!(
            RUNTIME_DEAD_OPERATION_VISITS.with(std::cell::Cell::get),
            OPERATION_COUNT
        );
    }

    #[test]
    fn duplicate_runtime_type_chains_are_partitioned_in_one_pass() {
        const DEPTH: usize = 256;
        let mut types = vec![RuntimeType::Unit, RuntimeType::Unit];
        let mut left = 0;
        let mut right = 1;
        for _ in 0..DEPTH {
            left = types.len();
            types.push(RuntimeType::Store {
                element_type: left - 2,
            });
            right = types.len();
            types.push(RuntimeType::Store {
                element_type: right - 2,
            });
        }
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "runtime-type-chain-test.blot".to_owned(),
            types,
            signatures: Vec::new(),
            static_stores: Vec::new(),
            functions: Vec::new(),
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        deduplicate_runtime_types(&mut module);

        assert_eq!(module.types.len(), DEPTH + 1);
        assert_eq!(left, DEPTH * 2);
        assert_eq!(right, DEPTH * 2 + 1);
    }

    #[test]
    fn residual_function_store_reuse_requires_caller_provenance() {
        let mut trace = ResidualTrace::new("store-reuse-provenance-test.blot");
        let integer = trace.region_integer_type();
        let store_type = trace.insert_type(
            "store-reuse-provenance",
            RuntimeType::Store {
                element_type: integer,
            },
        );
        let input = Produced::StoreParameter {
            source: crate::ast::PatternId(0),
            path: Vec::new(),
            elements_shareable: true,
            access: crate::ownership::StoreAccess::Shared,
        };
        let runtime_value = |id, meaning| {
            Value::Runtime(RuntimeValue {
                id,
                type_id: store_type,
                meaning,
            })
        };
        let shared = runtime_value(1, RuntimeMeaning::Plain);
        let reusable = runtime_value(2, RuntimeMeaning::ReusableStore);
        let shared_witness = input_store_reuse_witness(&input, &shared, &trace.types);
        let reusable_witness = input_store_reuse_witness(&input, &reusable, &trace.types);
        assert_ne!(shared_witness, reusable_witness);

        for (source, witness, expected) in [
            (shared, shared_witness, RuntimeMeaning::SharedStore),
            (reusable, reusable_witness, RuntimeMeaning::ReusableStore),
        ] {
            let parameter = apply_store_reuse_witness(&witness, source, &trace.types);
            let owned = trace
                .primitive(
                    "@linear.own",
                    &[parameter],
                    &[],
                    None,
                    crate::ast::Span { start: 0, end: 0 },
                )
                .expect("ownership marker should lower")
                .expect("ownership marker should remain residual");
            let Value::Runtime(owned) = owned else {
                panic!("ownership marker should preserve the Store value")
            };
            assert_eq!(owned.meaning, expected);
        }

        assert_eq!(
            merge_meaning(&RuntimeMeaning::SharedStore, &RuntimeMeaning::ReusableStore,),
            RuntimeMeaning::SharedStore,
        );
    }

    #[test]
    fn persistent_store_growth_produces_a_reusable_store() {
        let mut trace = ResidualTrace::new("persistent-store-result-test.blot");
        let integer = trace.region_integer_type();
        let store_type = trace.insert_type(
            "persistent-store-result",
            RuntimeType::Store {
                element_type: integer,
            },
        );
        let shared = Value::Runtime(RuntimeValue {
            id: 0,
            type_id: store_type,
            meaning: RuntimeMeaning::SharedStore,
        });

        let result = trace
            .primitive(
                "@array.push",
                &[shared, Value::Int(1.into())],
                &[None, None],
                None,
                crate::ast::Span { start: 0, end: 0 },
            )
            .expect("persistent Store growth should lower")
            .expect("persistent Store growth should remain residual");

        let Value::Runtime(result) = result else {
            panic!("persistent Store growth should produce a runtime Store")
        };
        assert_eq!(result.meaning, RuntimeMeaning::ReusableStore);
        let growth = trace.blocks[0]
            .operations
            .last()
            .expect("persistent Store growth should emit an operation");
        assert_eq!(growth.kind, "store.grow");
        assert_eq!(growth.update, Some("persistent"));
    }

    #[test]
    fn online_aggregate_representations_distinguish_float_and_integer_simd() {
        let float_vector = Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            Value::Vector([0.0; 4]),
        )]));
        let integer_vector = Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            Value::IntegerVector {
                bits: 32,
                lanes: vec![0; 4],
            },
        )]));
        let mut representations = CheckedAggregateRepresentations::default();
        representations.record(&float_vector, 4);

        assert_eq!(representations.get(&integer_vector), None);

        let float_mask = Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            Value::VectorMask([false; 4]),
        )]));
        let integer_mask = Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            Value::IntegerVectorMask {
                bits: 32,
                lanes: vec![false; 4],
            },
        )]));
        let mut representations = CheckedAggregateRepresentations::default();
        representations.record(&float_mask, 4);

        assert_eq!(representations.get(&integer_mask), None);
    }

    #[test]
    fn float_ordering_guards_trap_unordered_values() {
        let mut trace = ResidualTrace::new("nan-test.blot");
        trace
            .trap_if_nan(11, "@float.cmp", crate::ast::Span { start: 3, end: 7 })
            .expect("a float NaN guard should lower");

        assert_eq!(trace.blocks.len(), 4);
        assert_eq!(trace.blocks[0].operations.len(), 1);
        assert_eq!(trace.blocks[0].operations[0].kind, "scalar");
        assert_eq!(trace.blocks[0].operations[0].operands, [11, 11]);
        assert_eq!(trace.blocks[0].operations[0].operator, Some("not-equal"));
        let Some(RuntimeTerminator::Conditional {
            consequent,
            alternate,
            ..
        }) = &trace.blocks[0].terminator
        else {
            panic!("the NaN check did not branch");
        };
        assert_eq!((*consequent, *alternate), (1, 2));
        let Some(RuntimeTerminator::Trap { message, .. }) = &trace.blocks[1].terminator else {
            panic!("the unordered branch did not trap");
        };
        assert!(message.starts_with("@float.cmp cannot order NaN"));
        let Some(RuntimeTerminator::Branch { target, .. }) = &trace.blocks[2].terminator else {
            panic!("the ordered branch did not rejoin");
        };
        assert_eq!(*target, 3);
        assert_eq!(trace.current_block, 3);
    }

    #[test]
    fn runtime_store_layout_witness_is_closed_and_deterministic() {
        let types = vec![
            RuntimeType::SignedInteger64,
            RuntimeType::Store { element_type: 0 },
        ];
        let layout = runtime_layout_witness(&types, 1).expect("Store layout");
        assert_eq!(layout.size, 8);
        assert_eq!(layout.alignment, 4);
        assert_eq!(layout.fingerprint, "store(signed-integer-64;stride=8)");
    }

    #[test]
    fn runtime_scratch_layout_witness_is_closed_and_deterministic() {
        let types = vec![
            RuntimeType::SignedInteger64,
            RuntimeType::Scratch { element_type: 0 },
        ];
        let layout = runtime_layout_witness(&types, 1).expect("Scratch layout");
        assert_eq!(layout.size, 12);
        assert_eq!(layout.alignment, 4);
        assert_eq!(layout.fingerprint, "scratch(signed-integer-64;stride=8)");
    }

    #[test]
    fn dynamic_array_decomposition_uses_generic_store_control_flow() {
        let mut trace = ResidualTrace::new("array-decomposition-test.blot");
        let span = crate::ast::Span { start: 3, end: 7 };
        let integer = trace.region_integer_type();
        let store_type = trace.insert_type(
            "test-integer-store",
            RuntimeType::Store {
                element_type: integer,
            },
        );
        let store = trace.array_operation("store.empty", store_type, Vec::new(), span, None);
        let index = trace.constant(WireConstant::SignedInteger64("0".to_owned()), integer, span);
        let taken = trace
            .primitive(
                "@array.take",
                &[Value::Runtime(store.clone()), Value::Runtime(index.clone())],
                &[None, None],
                None,
                span,
            )
            .expect("dynamic take should lower")
            .expect("dynamic take should remain residual");
        let split = trace
            .primitive(
                "@array.split",
                &[Value::Runtime(store), Value::Runtime(index)],
                &[None, None],
                None,
                span,
            )
            .expect("dynamic split should lower")
            .expect("dynamic split should remain residual");

        assert!(matches!(taken, Value::Shape(ref fields) if fields.len() == 2));
        assert!(matches!(split, Value::Shape(ref fields) if fields.len() == 3));
        let kinds = trace
            .blocks
            .iter()
            .flat_map(|block| block.operations.iter().map(|operation| operation.kind))
            .collect::<Vec<_>>();
        assert!(kinds.contains(&"store.length"));
        assert!(kinds.contains(&"store.read"));
        assert!(kinds.contains(&"store.grow"));
        assert!(kinds.contains(&"product.project"));
        assert!(
            !kinds
                .iter()
                .any(|kind| kind.contains("take") || kind.contains("split"))
        );
        assert!(
            trace
                .blocks
                .iter()
                .flat_map(|block| &block.operations)
                .filter(|operation| operation.kind == "store.grow")
                .all(|operation| operation.update == Some("owned-reuse"))
        );
    }

    #[test]
    fn runtime_array_spreads_copy_empty_one_and_many_stores_in_source_order() {
        let mut trace = ResidualTrace::new("array-spread-test.blot");
        let span = crate::ast::Span { start: 3, end: 7 };
        let integer = trace.region_integer_type();
        let store_type = trace.insert_type(
            "spread-integer-store",
            RuntimeType::Store {
                element_type: integer,
            },
        );
        let empty = trace.array_operation("store.empty", store_type, Vec::new(), span, None);
        let mut one = trace.array_operation("store.empty", store_type, Vec::new(), span, None);
        let twenty = trace.constant(
            WireConstant::SignedInteger64("20".to_owned()),
            integer,
            span,
        );
        one = trace.array_operation(
            "store.grow",
            store_type,
            vec![one.id, twenty.id],
            span,
            Some("persistent"),
        );
        let mut many = trace.array_operation("store.empty", store_type, Vec::new(), span, None);
        for value in ["30", "40"] {
            let value = trace.constant(
                WireConstant::SignedInteger64(value.to_owned()),
                integer,
                span,
            );
            many = trace.array_operation(
                "store.grow",
                store_type,
                vec![many.id, value.id],
                span,
                Some("persistent"),
            );
        }
        let source_ids = [one.id, empty.id, many.id];
        let mut combined = trace
            .append_array_spread(
                &Value::Array(vec![Value::Int(10.into())].into()),
                &Value::Runtime(one),
                None,
                span,
            )
            .expect("a static prefix and one-element spread should lower");
        combined = trace
            .append_array_element(&combined, &Value::Int(25.into()), None, span)
            .expect("an element between spreads should lower");
        combined = trace
            .append_array_spread(&combined, &Value::Runtime(empty), None, span)
            .expect("an empty spread should lower");
        combined = trace
            .append_array_spread(&combined, &Value::Runtime(many), None, span)
            .expect("a later many-element spread should lower");
        trace
            .append_array_element(&combined, &Value::Int(50.into()), None, span)
            .expect("a static suffix should lower");

        let copied_sources = trace
            .blocks
            .iter()
            .flat_map(|block| &block.operations)
            .filter(|operation| operation.kind == "store.read")
            .map(|operation| operation.operands[0])
            .collect::<Vec<_>>();
        assert_eq!(copied_sources, source_ids);
        let copied_source_ids = source_ids.into_iter().collect::<HashSet<_>>();
        for operation in trace
            .blocks
            .iter()
            .flat_map(|block| &block.operations)
            .filter(|operation| operation.kind == "store.grow")
        {
            assert_eq!(operation.update, Some("persistent"));
            assert!(!copied_source_ids.contains(&operation.operands[0]));
        }
    }

    #[test]
    fn normalized_equivalent_functions_share_one_runtime_body() {
        let body = |id, name: &str, value| RuntimeFunction {
            id,
            name: name.to_owned(),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: vec![parameter(value)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Return {
                    value,
                    span: span(),
                },
            }],
            span: span(),
        };
        let caller = RuntimeFunction {
            id: 12,
            name: "caller".to_owned(),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: vec![parameter(20)],
                operations: vec![operation("call.direct", 21, vec![20], Some(9), None)],
                terminator: RuntimeTerminator::Return {
                    value: 21,
                    span: span(),
                },
            }],
            span: span(),
        };
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "function-interning-test.blot".to_owned(),
            types: vec![RuntimeType::Unit],
            signatures: vec![RuntimeSignature {
                parameters: vec![0],
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions: vec![body(4, "first", 10), body(9, "second", 70), caller],
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: vec![RuntimeExport::Runtime {
                source_name: "default".to_owned(),
                phase: "runtime",
                wasm_name: "blot:default".to_owned(),
                function: 9,
                signature: 0,
                ownership: "plain",
            }],
        };

        optimize_runtime_module(&mut module, None).expect("equivalent functions should intern");

        assert_eq!(module.functions.len(), 2);
        assert_eq!(module.functions[0].id, 0);
        assert_eq!(
            module.functions[1].blocks[0].operations[0].function,
            Some(0)
        );
        let RuntimeExport::Runtime { function, .. } = &module.exports[0] else {
            panic!("runtime export changed phase");
        };
        assert_eq!(*function, 0);
    }

    #[test]
    fn acyclic_function_interning_visits_each_body_once() {
        const CHAIN_LENGTH: usize = 256;
        let leaf = |id, message: &str| RuntimeFunction {
            id,
            name: format!("leaf-{id}"),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: Vec::new(),
                operations: Vec::new(),
                terminator: RuntimeTerminator::Trap {
                    message: message.to_owned(),
                    span: span(),
                },
            }],
            span: span(),
        };
        let caller = |id, target| {
            let parameter_value = id * 2;
            let result = parameter_value + 1;
            RuntimeFunction {
                id,
                name: format!("caller-{id}"),
                signature: 0,
                reuse: None,
                entry_block: 0,
                blocks: vec![RuntimeBlock {
                    id: 0,
                    parameters: vec![parameter(parameter_value)],
                    operations: vec![operation(
                        "call.direct",
                        result,
                        vec![parameter_value],
                        Some(target),
                        None,
                    )],
                    terminator: RuntimeTerminator::Return {
                        value: result,
                        span: span(),
                    },
                }],
                span: span(),
            }
        };
        let mut functions = vec![leaf(0, "left"), leaf(1, "right")];
        let mut left = 0;
        let mut right = 1;
        for _ in 0..CHAIN_LENGTH {
            let left_caller = functions.len();
            functions.push(caller(left_caller, left));
            left = left_caller;
            let right_caller = functions.len();
            functions.push(caller(right_caller, right));
            right = right_caller;
        }
        let function_count = functions.len();
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "acyclic-function-interning-test.blot".to_owned(),
            types: vec![RuntimeType::Unit],
            signatures: vec![RuntimeSignature {
                parameters: vec![0],
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions,
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };
        RUNTIME_FUNCTION_KEY_VISITS.with(|visits| visits.set(0));

        deduplicate_runtime_functions(&mut module, None).expect("acyclic functions should intern");

        let visits = RUNTIME_FUNCTION_KEY_VISITS.with(std::cell::Cell::get);
        assert_eq!(visits, function_count);
        assert_eq!(module.functions.len(), function_count);
    }

    #[test]
    fn recursive_function_interning_refines_a_marked_cycle_linearly() {
        const FUNCTION_COUNT: usize = 256;
        let functions = (0..FUNCTION_COUNT)
            .map(|id| {
                let parameter_value = id * 2;
                let result = parameter_value + 1;
                let terminator = if id == 0 {
                    RuntimeTerminator::Trap {
                        message: "marked cycle function".to_owned(),
                        span: span(),
                    }
                } else {
                    RuntimeTerminator::Return {
                        value: result,
                        span: span(),
                    }
                };
                RuntimeFunction {
                    id,
                    name: format!("recursive-cycle-{id}"),
                    signature: 0,
                    reuse: None,
                    entry_block: 0,
                    blocks: vec![RuntimeBlock {
                        id: 0,
                        parameters: vec![parameter(parameter_value)],
                        operations: vec![operation(
                            "call.direct",
                            result,
                            vec![parameter_value],
                            Some((id + 1) % FUNCTION_COUNT),
                            None,
                        )],
                        terminator,
                    }],
                    span: span(),
                }
            })
            .collect();
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "recursive-function-scaling-test.blot".to_owned(),
            types: vec![RuntimeType::Unit],
            signatures: vec![RuntimeSignature {
                parameters: vec![0],
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions,
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };
        RUNTIME_FUNCTION_KEY_VISITS.with(|visits| visits.set(0));
        RUNTIME_FUNCTION_REFINEMENT_EDGES.with(|visits| visits.set(0));

        deduplicate_runtime_functions(&mut module, None).expect("recursive cycle should intern");

        let key_visits = RUNTIME_FUNCTION_KEY_VISITS.with(std::cell::Cell::get);
        let refinement_edges = RUNTIME_FUNCTION_REFINEMENT_EDGES.with(std::cell::Cell::get);
        assert_eq!(key_visits, FUNCTION_COUNT);
        assert!(
            refinement_edges <= FUNCTION_COUNT * 3,
            "marked cycle examined {refinement_edges} call edges"
        );
        assert_eq!(module.functions.len(), FUNCTION_COUNT);
    }

    #[test]
    fn equivalent_recursive_functions_share_one_runtime_body() {
        let recursive = |id, target| RuntimeFunction {
            id,
            name: format!("recursive-{id}"),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: vec![parameter(id + 10)],
                operations: vec![operation(
                    "call.direct",
                    id + 20,
                    vec![id + 10],
                    Some(target),
                    None,
                )],
                terminator: RuntimeTerminator::Return {
                    value: id + 20,
                    span: span(),
                },
            }],
            span: span(),
        };
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "recursive-function-interning-test.blot".to_owned(),
            types: vec![RuntimeType::Unit],
            signatures: vec![RuntimeSignature {
                parameters: vec![0],
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions: vec![recursive(0, 1), recursive(1, 0)],
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        deduplicate_runtime_functions(&mut module, None)
            .expect("recursive functions should intern");

        assert_eq!(module.functions.len(), 1);
        assert_eq!(
            module.functions[0].blocks[0].operations[0].function,
            Some(0)
        );
    }

    #[test]
    fn functions_with_distinct_traps_keep_distinct_runtime_bodies() {
        let body = |id, message: &str| RuntimeFunction {
            id,
            name: format!("trap-{id}"),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks: vec![RuntimeBlock {
                id: 0,
                parameters: vec![parameter(id + 10)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Trap {
                    message: message.to_owned(),
                    span: span(),
                },
            }],
            span: span(),
        };
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "trap-interning-test.blot".to_owned(),
            types: vec![RuntimeType::Unit],
            signatures: vec![RuntimeSignature {
                parameters: vec![0],
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions: vec![body(0, "first trap"), body(1, "second trap")],
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        optimize_runtime_module(&mut module, None).expect("distinct traps should normalize");

        assert_eq!(module.functions.len(), 2);
    }

    #[test]
    fn functions_with_distinct_nonfinite_constants_keep_distinct_runtime_bodies() {
        let body = |id, value| {
            let result = id + 10;
            RuntimeFunction {
                id,
                name: format!("float-{id}"),
                signature: 0,
                reuse: None,
                entry_block: 0,
                blocks: vec![RuntimeBlock {
                    id: 0,
                    parameters: Vec::new(),
                    operations: vec![RuntimeOperation {
                        value: Some(WireConstant::Float64(value)),
                        ..operation("constant", result, Vec::new(), None, None)
                    }],
                    terminator: RuntimeTerminator::Return {
                        value: result,
                        span: span(),
                    },
                }],
                span: span(),
            }
        };
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "float-function-interning-test.blot".to_owned(),
            types: vec![RuntimeType::Float64],
            signatures: vec![RuntimeSignature {
                parameters: Vec::new(),
                result: 0,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions: vec![body(0, f64::NAN), body(1, f64::INFINITY)],
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        optimize_runtime_module(&mut module, None).expect("float functions should normalize");

        assert_eq!(module.functions.len(), 2);
    }

    #[test]
    fn dead_loop_carried_parameter_and_incoming_arguments_are_removed() {
        let mut function = runtime_function(vec![
            RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0), parameter(9)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Branch {
                    target: 1,
                    arguments: vec![0, 9],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 1,
                parameters: vec![parameter(1), parameter(2)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Conditional {
                    condition: 1,
                    consequent: 1,
                    consequent_arguments: vec![1, 2],
                    alternate: 2,
                    alternate_arguments: vec![1],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 2,
                parameters: vec![parameter(3)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Return {
                    value: 3,
                    span: span(),
                },
            },
        ]);

        remove_unused_block_parameters(&mut function);

        assert_eq!(function.blocks[1].parameters.len(), 1);
        let RuntimeTerminator::Branch { arguments, .. } = &function.blocks[0].terminator else {
            panic!("entry branch changed shape");
        };
        assert_eq!(arguments, &[0]);
        let RuntimeTerminator::Conditional {
            consequent_arguments,
            ..
        } = &function.blocks[1].terminator
        else {
            panic!("loop branch changed shape");
        };
        assert_eq!(consequent_arguments, &[1]);
    }

    #[test]
    fn inverse_indirect_operations_cancel() {
        let mut indirect_make = operation("indirect.make", 1, vec![0], None, None);
        indirect_make.type_id = 1;
        let mut function = runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: vec![parameter(0)],
            operations: vec![
                indirect_make,
                operation("indirect.load", 2, vec![1], None, None),
            ],
            terminator: RuntimeTerminator::Return {
                value: 2,
                span: span(),
            },
        }]);

        fold_representation_roundtrips(&mut function);
        eliminate_dead_pure_operations(&mut function);

        assert!(function.blocks[0].operations.is_empty());
        let RuntimeTerminator::Return { value, .. } = function.blocks[0].terminator else {
            panic!("roundtrip return changed shape");
        };
        assert_eq!(value, 0);
    }

    #[test]
    fn inverse_indirect_operations_cancel_after_product_aliases() {
        let mut call = operation("call.direct", 1, Vec::new(), Some(4), None);
        call.type_id = 11;
        let mut load = operation("indirect.load", 2, vec![1], None, None);
        load.type_id = 12;
        let product = product_operation("product.make", 3, 13, vec![2], None);
        let projection = product_operation("product.project", 4, 12, vec![3], Some(0));
        let mut make = operation("indirect.make", 5, vec![4], None, None);
        make.type_id = 11;
        let mut function = runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: Vec::new(),
            operations: vec![call, load, product, projection, make],
            terminator: RuntimeTerminator::Return {
                value: 5,
                span: span(),
            },
        }]);

        fold_representation_roundtrips(&mut function);
        eliminate_dead_pure_operations(&mut function);

        assert_eq!(function.blocks[0].operations.len(), 1);
        assert_eq!(function.blocks[0].operations[0].kind, "call.direct");
        let RuntimeTerminator::Return { value, .. } = function.blocks[0].terminator else {
            panic!("roundtrip return changed shape");
        };
        assert_eq!(value, 1);
    }

    #[test]
    fn inverse_indirect_operations_cancel_after_type_deduplication() {
        let mut source = operation("opaque", 1, Vec::new(), None, None);
        source.type_id = 2;
        let mut load = operation("indirect.load", 2, vec![1], None, None);
        load.type_id = 0;
        let mut make = operation("indirect.make", 3, vec![2], None, None);
        make.type_id = 3;
        let function = runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: Vec::new(),
            operations: vec![source, load, make],
            terminator: RuntimeTerminator::Return {
                value: 3,
                span: span(),
            },
        }]);
        let mut module = RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: RUNTIME_HIR_SCHEMA,
            source: "roundtrip-after-type-deduplication.blot".to_owned(),
            types: vec![
                RuntimeType::Unit,
                RuntimeType::Unit,
                RuntimeType::Indirect { target_type: 0 },
                RuntimeType::Indirect { target_type: 1 },
            ],
            signatures: vec![RuntimeSignature {
                parameters: Vec::new(),
                result: 3,
                effects: Vec::new(),
            }],
            static_stores: Vec::new(),
            functions: vec![function],
            capabilities: Vec::new(),
            links: Vec::new(),
            exports: Vec::new(),
        };

        optimize_runtime_module(&mut module, None).expect("runtime module should normalize");

        assert_eq!(module.functions[0].blocks[0].operations.len(), 1);
        assert_eq!(module.functions[0].blocks[0].operations[0].kind, "opaque");
        let RuntimeTerminator::Return { value, .. } = module.functions[0].blocks[0].terminator
        else {
            panic!("roundtrip return changed shape");
        };
        assert_eq!(value, 1);
    }

    #[test]
    fn unused_indirect_allocation_is_not_dead_code() {
        let mut indirect_make = operation("indirect.make", 1, vec![0], None, None);
        indirect_make.type_id = 1;
        let mut function = runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: vec![parameter(0)],
            operations: vec![indirect_make],
            terminator: RuntimeTerminator::Return {
                value: 0,
                span: span(),
            },
        }]);

        eliminate_dead_pure_operations(&mut function);

        assert_eq!(function.blocks[0].operations.len(), 1);
    }

    #[test]
    fn store_product_projection_reads_only_the_requested_field() {
        let mut read = operation("store.read", 2, vec![0, 1], None, None);
        read.type_id = 4;
        let projection = product_operation("product.project", 3, 1, vec![2], Some(1));
        let mut function = runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: vec![parameter(0), parameter(1)],
            operations: vec![read, projection],
            terminator: RuntimeTerminator::Return {
                value: 3,
                span: span(),
            },
        }]);

        fold_store_field_reads(&mut function);
        eliminate_dead_pure_operations(&mut function);

        let [field_read] = function.blocks[0].operations.as_slice() else {
            panic!("the full Store read was not eliminated");
        };
        assert_eq!(field_read.kind, "store.read.field");
        assert_eq!(field_read.operands, [0, 1]);
        assert_eq!(field_read.field, Some(1));
    }

    #[test]
    fn direct_self_call_return_becomes_entry_back_edge() {
        let mut function = runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: vec![parameter(0)],
            operations: vec![operation("call.direct", 1, vec![0], Some(7), None)],
            terminator: RuntimeTerminator::Return {
                value: 1,
                span: span(),
            },
        }]);

        recover_direct_tail_calls(&mut function);

        assert!(function.blocks[0].operations.is_empty());
        let RuntimeTerminator::Branch {
            target, arguments, ..
        } = &function.blocks[0].terminator
        else {
            panic!("tail call did not become a branch");
        };
        assert_eq!(*target, 0);
        assert_eq!(arguments, &[0]);
    }

    #[test]
    fn returned_private_sum_payload_becomes_entry_back_edge() {
        let mut function = runtime_function(vec![
            RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0)],
                operations: vec![
                    operation("call.direct", 1, vec![0], Some(7), None),
                    operation("sum.make", 2, vec![1], None, Some(1)),
                ],
                terminator: RuntimeTerminator::Branch {
                    target: 1,
                    arguments: vec![2],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 1,
                parameters: vec![parameter(3)],
                operations: vec![operation("sum.payload", 4, vec![3], None, Some(1))],
                terminator: RuntimeTerminator::Return {
                    value: 4,
                    span: span(),
                },
            },
        ]);

        recover_direct_tail_calls(&mut function);

        assert!(function.blocks[0].operations.is_empty());
        let RuntimeTerminator::Branch {
            target, arguments, ..
        } = &function.blocks[0].terminator
        else {
            panic!("wrapped tail call did not become a branch");
        };
        assert_eq!(*target, 0);
        assert_eq!(arguments, &[0]);
    }

    #[test]
    fn reconstructed_product_return_becomes_entry_back_edge() {
        let mut function = runtime_function(vec![
            RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0)],
                operations: vec![
                    RuntimeOperation {
                        type_id: 1,
                        ..operation("call.direct", 1, vec![0], Some(7), None)
                    },
                    product_operation("product.project", 2, 1, vec![1], Some(0)),
                    product_operation("product.project", 3, 1, vec![1], Some(1)),
                    product_operation("product.make", 4, 1, vec![2, 3], None),
                ],
                terminator: RuntimeTerminator::Branch {
                    target: 1,
                    arguments: vec![4],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 1,
                parameters: vec![product_parameter(5)],
                operations: vec![
                    product_operation("product.project", 6, 1, vec![5], Some(0)),
                    product_operation("product.project", 7, 1, vec![5], Some(1)),
                    product_operation("product.make", 8, 1, vec![6, 7], None),
                ],
                terminator: RuntimeTerminator::Return {
                    value: 8,
                    span: span(),
                },
            },
        ]);

        recover_direct_tail_calls(&mut function);

        assert!(function.blocks[0].operations.is_empty());
        let RuntimeTerminator::Branch {
            target, arguments, ..
        } = &function.blocks[0].terminator
        else {
            panic!("reconstructed product tail call did not become a branch");
        };
        assert_eq!(*target, 0);
        assert_eq!(arguments, &[0]);
    }

    #[test]
    fn work_after_self_call_keeps_the_call() {
        let function = simplify_runtime_function(runtime_function(vec![RuntimeBlock {
            id: 0,
            parameters: vec![parameter(0)],
            operations: vec![
                operation("call.direct", 1, vec![0], Some(7), None),
                operation("scalar", 2, vec![1, 0], None, None),
            ],
            terminator: RuntimeTerminator::Return {
                value: 2,
                span: span(),
            },
        }]));

        assert_eq!(function.blocks[0].operations.len(), 2);
        assert_eq!(function.blocks[0].operations[0].kind, "call.direct");
    }

    #[test]
    fn boolean_branch_roundtrip_becomes_direct_control_flow() {
        let function = simplify_runtime_function(runtime_function(vec![
            RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Conditional {
                    condition: 0,
                    consequent: 1,
                    consequent_arguments: Vec::new(),
                    alternate: 2,
                    alternate_arguments: Vec::new(),
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 1,
                parameters: Vec::new(),
                operations: vec![boolean_constant(1, false)],
                terminator: RuntimeTerminator::Branch {
                    target: 3,
                    arguments: vec![1],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 2,
                parameters: Vec::new(),
                operations: vec![boolean_constant(2, true)],
                terminator: RuntimeTerminator::Branch {
                    target: 3,
                    arguments: vec![2],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 3,
                parameters: vec![parameter(3)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Conditional {
                    condition: 3,
                    consequent: 4,
                    consequent_arguments: Vec::new(),
                    alternate: 5,
                    alternate_arguments: Vec::new(),
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 4,
                parameters: Vec::new(),
                operations: Vec::new(),
                terminator: RuntimeTerminator::Return {
                    value: 0,
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 5,
                parameters: Vec::new(),
                operations: Vec::new(),
                terminator: RuntimeTerminator::Return {
                    value: 0,
                    span: span(),
                },
            },
        ]));

        assert_eq!(function.blocks.len(), 3);
        let RuntimeTerminator::Conditional {
            condition,
            consequent,
            alternate,
            ..
        } = function.blocks[0].terminator
        else {
            panic!("boolean roundtrip did not become a direct conditional");
        };
        assert_eq!(condition, 0);
        assert_eq!(consequent, 2);
        assert_eq!(alternate, 1);
    }

    #[test]
    fn known_sum_constructors_bypass_switch_dispatch() {
        let function = simplify_runtime_function(known_sum_switch_function());

        assert_eq!(function.blocks.len(), 7);
        for (block, target, parameter) in [(1, 4, 8), (2, 5, 9), (3, 6, 10)] {
            assert!(function.blocks[block].operations.is_empty());
            let RuntimeTerminator::Branch {
                target: actual_target,
                arguments,
                ..
            } = &function.blocks[block].terminator
            else {
                panic!("known sum constructor did not bypass switch dispatch");
            };
            assert_eq!(*actual_target, target);
            assert_eq!(arguments, &[0]);
            assert_eq!(function.blocks[target].parameters[0].value, parameter);
        }
    }

    #[test]
    fn sum_switch_with_another_reader_is_not_folded() {
        let mut function = known_sum_switch_function();
        function.blocks[5]
            .operations
            .push(operation("sum.tag", 11, vec![4], None, None));

        let facts = SumFoldFacts::new(&function);
        assert!(known_sum_switch_fold(&function, &function.blocks[4], &facts).is_none());
    }

    #[test]
    fn sum_switch_with_a_shared_target_is_not_folded() {
        let mut function = known_sum_switch_function();
        let RuntimeTerminator::Switch { fallback, .. } = &mut function.blocks[4].terminator else {
            unreachable!();
        };
        *fallback = 6;

        let facts = SumFoldFacts::new(&function);
        assert!(known_sum_switch_fold(&function, &function.blocks[4], &facts).is_none());
    }

    #[test]
    fn sum_switch_with_an_invalid_constructor_tag_is_not_folded() {
        let mut function = known_sum_switch_function();
        let RuntimeTerminator::Switch { cases, .. } = &mut function.blocks[4].terminator else {
            unreachable!();
        };
        cases[0].value = WireConstant::SignedInteger32(-1);

        let facts = SumFoldFacts::new(&function);
        assert!(known_sum_switch_fold(&function, &function.blocks[4], &facts).is_none());
    }

    #[test]
    fn sum_switch_with_an_indirect_incoming_edge_is_not_folded() {
        let mut function = known_sum_switch_function();
        let RuntimeTerminator::Switch { cases, .. } = &mut function.blocks[0].terminator else {
            unreachable!();
        };
        cases[0].target = 4;

        let facts = SumFoldFacts::new(&function);
        assert!(known_sum_switch_fold(&function, &function.blocks[4], &facts).is_none());
    }

    fn known_sum_switch_function() -> RuntimeFunction {
        runtime_function(vec![
            RuntimeBlock {
                id: 0,
                parameters: vec![parameter(0)],
                operations: Vec::new(),
                terminator: RuntimeTerminator::Switch {
                    selector: 0,
                    cases: vec![
                        RuntimeSwitchCase {
                            value: WireConstant::SignedInteger32(0),
                            target: 1,
                        },
                        RuntimeSwitchCase {
                            value: WireConstant::SignedInteger32(1),
                            target: 2,
                        },
                    ],
                    fallback: 3,
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 1,
                parameters: Vec::new(),
                operations: vec![operation("sum.make", 1, vec![0], None, Some(0))],
                terminator: RuntimeTerminator::Branch {
                    target: 4,
                    arguments: vec![1],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 2,
                parameters: Vec::new(),
                operations: vec![operation("sum.make", 2, vec![0], None, Some(1))],
                terminator: RuntimeTerminator::Branch {
                    target: 4,
                    arguments: vec![2],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 3,
                parameters: Vec::new(),
                operations: vec![operation("sum.make", 3, vec![0], None, Some(2))],
                terminator: RuntimeTerminator::Branch {
                    target: 4,
                    arguments: vec![3],
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 4,
                parameters: vec![parameter(4)],
                operations: vec![operation("sum.tag", 5, vec![4], None, None)],
                terminator: RuntimeTerminator::Switch {
                    selector: 5,
                    cases: vec![
                        RuntimeSwitchCase {
                            value: WireConstant::SignedInteger32(0),
                            target: 5,
                        },
                        RuntimeSwitchCase {
                            value: WireConstant::SignedInteger32(1),
                            target: 6,
                        },
                    ],
                    fallback: 7,
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 5,
                parameters: Vec::new(),
                operations: vec![operation("sum.payload", 8, vec![4], None, Some(0))],
                terminator: RuntimeTerminator::Return {
                    value: 8,
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 6,
                parameters: Vec::new(),
                operations: vec![operation("sum.payload", 9, vec![4], None, Some(1))],
                terminator: RuntimeTerminator::Return {
                    value: 9,
                    span: span(),
                },
            },
            RuntimeBlock {
                id: 7,
                parameters: Vec::new(),
                operations: vec![operation("sum.payload", 10, vec![4], None, Some(2))],
                terminator: RuntimeTerminator::Return {
                    value: 10,
                    span: span(),
                },
            },
        ])
    }

    fn runtime_function(blocks: Vec<RuntimeBlock>) -> RuntimeFunction {
        RuntimeFunction {
            id: 7,
            name: "tail-test".to_owned(),
            signature: 0,
            reuse: None,
            entry_block: 0,
            blocks,
            span: span(),
        }
    }

    fn parameter(value: usize) -> RuntimeBlockParameter {
        RuntimeBlockParameter {
            value,
            type_id: 0,
            ownership: "plain",
            span: span(),
        }
    }

    fn product_parameter(value: usize) -> RuntimeBlockParameter {
        RuntimeBlockParameter {
            value,
            type_id: 1,
            ownership: "owned",
            span: span(),
        }
    }

    fn operation(
        kind: &'static str,
        result: usize,
        operands: Vec<usize>,
        function: Option<usize>,
        case: Option<usize>,
    ) -> RuntimeOperation {
        RuntimeOperation {
            kind,
            result,
            type_id: 0,
            operands,
            ownership: "plain",
            span: span(),
            value: None,
            update: None,
            case,
            capability: None,
            operation: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function,
            signature: None,
            static_store: None,
        }
    }

    fn product_operation(
        kind: &'static str,
        result: usize,
        type_id: usize,
        operands: Vec<usize>,
        field: Option<usize>,
    ) -> RuntimeOperation {
        RuntimeOperation {
            field,
            type_id,
            ..operation(kind, result, operands, None, None)
        }
    }

    fn boolean_constant(result: usize, value: bool) -> RuntimeOperation {
        RuntimeOperation {
            value: Some(WireConstant::Boolean(value)),
            ..operation("constant", result, Vec::new(), None, None)
        }
    }

    fn span() -> RuntimeSpan {
        RuntimeSpan {
            file: "tail-test.blot".to_owned(),
            start: 0,
            end: 0,
        }
    }
}
