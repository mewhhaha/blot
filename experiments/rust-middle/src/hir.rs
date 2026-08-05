use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use serde::Serialize;

use crate::diagnostic::Diagnostic;
use crate::eval::{Computation, Context, Phase, Runtime, evaluate_expression, evaluate_module};
use crate::typecheck::{CheckedModule, Domain, Scalar, Type};
use crate::value::{OrderedFields, RuntimeMeaning, RuntimeValue, Value};

#[derive(Clone, Serialize)]
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

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeField {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) type_id: usize,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeCase {
    pub(crate) name: String,
    #[serde(rename = "payloadType")]
    pub(crate) payload_type: usize,
}

#[derive(Clone, Serialize)]
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
}

#[derive(Clone, Serialize)]
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
    Return {
        value: usize,
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
    #[serde(rename = "entryBlock")]
    pub(crate) entry_block: usize,
    pub(crate) blocks: Vec<RuntimeBlock>,
    pub(crate) span: RuntimeSpan,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeCapabilityOperation {
    pub(crate) name: String,
    pub(crate) signature: usize,
}

#[derive(Clone, Serialize)]
pub(crate) struct RuntimeCapability {
    pub(crate) name: String,
    pub(crate) operations: Vec<RuntimeCapabilityOperation>,
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
    pub(crate) functions: Vec<RuntimeFunction>,
    pub(crate) capabilities: Vec<RuntimeCapability>,
    pub(crate) exports: Vec<RuntimeExport>,
}

pub(crate) struct ResidualTrace {
    source: String,
    types: Vec<RuntimeType>,
    type_ids: HashMap<String, usize>,
    signatures: Vec<RuntimeSignature>,
    capabilities: BTreeMap<String, BTreeMap<String, usize>>,
    blocks: Vec<ResidualBlock>,
    current_block: usize,
    next_value: usize,
    active_primitive: Option<String>,
}

fn integer_simd_layout(name: &str) -> (&'static str, u8) {
    match name {
        "I32x4" => ("integer-32", 4),
        "I16x8" => ("integer-16", 8),
        "I8x16" => ("integer-8", 16),
        _ => unreachable!("validated integer SIMD type {name}"),
    }
}

struct ResidualBlock {
    id: usize,
    parameters: Vec<RuntimeBlockParameter>,
    operations: Vec<RuntimeOperation>,
    terminator: Option<RuntimeTerminator>,
}

pub(crate) struct ResidualBranches {
    pub(crate) consequent: usize,
    pub(crate) alternate: usize,
    pub(crate) join: usize,
}

impl ResidualTrace {
    pub(crate) fn new(source: &str) -> Self {
        let mut trace = Self {
            source: source.to_owned(),
            types: Vec::new(),
            type_ids: HashMap::new(),
            signatures: Vec::new(),
            capabilities: BTreeMap::new(),
            blocks: Vec::new(),
            current_block: 0,
            next_value: 0,
            active_primitive: None,
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
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let argument = self.lower_value(argument, span)?;
        let result_type = self.type_from_type_value(result_type)?;
        let parameter_type = argument.type_id;
        let signature = self.signatures.len();
        let operations = self.capabilities.entry(capability.clone()).or_default();
        if let Some(existing) = operations.get(&operation) {
            let declared = &self.signatures[*existing];
            if declared.parameters != [parameter_type] || declared.result != result_type {
                return Err(hir_error(&format!(
                    "Host operation `{capability}.{operation}` was used with incompatible signatures."
                )));
            }
        } else {
            self.signatures.push(RuntimeSignature {
                parameters: vec![parameter_type],
                result: result_type,
                effects: vec![capability.clone()],
            });
            operations.insert(operation.clone(), signature);
        }
        let result = self.next_value();
        let ownership = self.ownership(result_type);
        let operation_signature = *self.capabilities[&capability]
            .get(&operation)
            .expect("inserted host operation");
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

    pub(crate) fn primitive(
        &mut self,
        name: &str,
        arguments: &[Value],
        span: crate::ast::Span,
    ) -> Result<Option<Value>, Diagnostic> {
        if !arguments.iter().any(contains_runtime) {
            return Ok(None);
        }
        self.active_primitive = Some(name.to_owned());
        if matches!(
            name,
            "@type.seal"
                | "@type.open"
                | "@type.attach"
                | "@shape.get"
                | "@shape.set"
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
        let value = match name {
            "@text.concat" => {
                let left = self.lower_as(arguments.first(), "text", span)?;
                let right = self.lower_as(arguments.get(1), "text", span)?;
                self.operation("text.append", 3, vec![left.id, right.id], span, None)
            }
            "@text.cmp" => {
                let left = self.lower_as(arguments.first(), "text", span)?;
                let right = self.lower_as(arguments.get(1), "text", span)?;
                let mut result =
                    self.operation("text.compare", 2, vec![left.id, right.id], span, None);
                result.meaning = RuntimeMeaning::Ordering;
                result
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
                    meaning: RuntimeMeaning::IntegerOrdering { right: right.id },
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
            RuntimeMeaning::IntegerOrdering { right } => (right, target.type_id),
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
        let RuntimeType::Sum { cases, .. } = &self.types[value.type_id] else {
            return None;
        };
        Some(cases.iter().map(|case_| case_.name.clone()).collect())
    }

    pub(crate) fn type_name(&self, value: &RuntimeValue) -> &'static str {
        match self.types[value.type_id] {
            RuntimeType::Unit => "Unit",
            RuntimeType::Boolean => "Bool",
            RuntimeType::Integer32 => "I32",
            RuntimeType::SignedInteger64 => "Int",
            RuntimeType::Float32 => "F32",
            RuntimeType::Float64 => "F64",
            RuntimeType::Text => "Str",
            RuntimeType::Vector { .. } => "Vector",
            RuntimeType::Mask { .. } => "Mask",
            RuntimeType::Store { .. } => "Store",
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

    pub(crate) fn integer_equal(
        &mut self,
        target: &RuntimeValue,
        expected: &Value,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        if !self.is_integer(target) {
            return Err(hir_error(
                "A dynamic integer case has a non-integer target.",
            ));
        }
        let expected = self.lower_as(Some(expected), "signed-integer-64", span)?;
        Ok(self.operation(
            "scalar",
            1,
            vec![target.id, expected.id],
            span,
            Some("equal"),
        ))
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

    pub(crate) fn select_block(&mut self, block: usize) {
        self.current_block = block;
    }

    pub(crate) fn current_block(&self) -> usize {
        self.current_block
    }

    pub(crate) fn join_conditional(
        &mut self,
        branches: ResidualBranches,
        consequent_end: usize,
        consequent: Value,
        alternate_end: usize,
        alternate: Value,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let (consequent, alternate) =
            self.join_values(consequent_end, consequent, alternate_end, alternate, span)?;
        if consequent.type_id != alternate.type_id {
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "Dynamic branches return incompatible runtime types.",
                span,
            ));
        }
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
        let joined = RuntimeValue {
            id: joined,
            type_id: consequent.type_id,
            meaning,
        };
        self.symbolic_value(joined, span)
    }

    pub(crate) fn sum_condition(
        &mut self,
        target: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeMeaning::Sum { cases } = &target.meaning else {
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "A dynamic sum case lost its constructor set.",
                span,
            ));
        };
        if cases.len() != 2 {
            return Err(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "The Rust residual calculus currently lowers binary sums.",
                span,
            ));
        }
        let tag = self.operation("sum.tag", 2, vec![target.id], span, None);
        let first = self.constant(WireConstant::SignedInteger32(0), 2, span);
        Ok(self.operation("scalar", 1, vec![tag.id, first.id], span, Some("equal")))
    }

    pub(crate) fn sum_payload(
        &mut self,
        target: &RuntimeValue,
        case: usize,
        span: crate::ast::Span,
    ) -> Result<Value, Diagnostic> {
        let RuntimeType::Sum { cases, .. } = &self.types[target.type_id] else {
            return Err(hir_error("A dynamic sum value has a non-sum runtime type."));
        };
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
            operands: vec![target.id],
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
        });
        if payload_type == 0 {
            return Ok(Value::Unit);
        }
        Ok(Value::Runtime(RuntimeValue {
            id: result,
            type_id: payload_type,
            meaning: RuntimeMeaning::Plain,
        }))
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
        let capabilities = self
            .capabilities
            .into_iter()
            .map(|(name, operations)| RuntimeCapability {
                name,
                operations: {
                    let mut operations = operations
                        .into_iter()
                        .map(|(name, signature)| RuntimeCapabilityOperation { name, signature })
                        .collect::<Vec<_>>();
                    operations.sort_by_key(|operation| operation.signature);
                    operations
                },
            })
            .collect();
        let blocks = self
            .blocks
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
            .collect::<Result<Vec<_>, Diagnostic>>()?;
        Ok(RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: 1,
            source: self.source.clone(),
            types: self.types,
            signatures: self.signatures,
            functions: vec![RuntimeFunction {
                id: 0,
                name: "blot$residual$blot:default".to_owned(),
                signature: function_signature,
                entry_block: 0,
                blocks,
                span: RuntimeSpan {
                    file: self.source.clone(),
                    start: 0,
                    end: 0,
                },
            }],
            capabilities,
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

    fn join_values(
        &mut self,
        consequent_block: usize,
        consequent: Value,
        alternate_block: usize,
        alternate: Value,
        span: crate::ast::Span,
    ) -> Result<(RuntimeValue, RuntimeValue), Diagnostic> {
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
        self.current_block = consequent_block;
        let consequent = self.lower_value(&consequent, span)?;
        self.current_block = alternate_block;
        let alternate = self.lower_value(&alternate, span)?;
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
        let type_id = self.type_ids.get(expected).copied().unwrap_or_else(|| {
            if expected == "signed-integer-64" {
                self.insert_type(expected, RuntimeType::SignedInteger64)
            } else {
                unreachable!("base residual type")
            }
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
                let type_id = self.product_type(fields)?;
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

    fn value_type(&mut self, value: &Value) -> Result<usize, Diagnostic> {
        match value {
            Value::Runtime(value) => Ok(value.type_id),
            Value::Unit => Ok(0),
            Value::Text(_) => Ok(3),
            Value::Int(_) => {
                Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64))
            }
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
            Value::Shape(fields) => self.product_type(fields),
            _ => Err(hir_error(
                "A residual value has no first-order runtime type.",
            )),
        }
    }

    fn type_from_type_value(&mut self, value: &Value) -> Result<usize, Diagnostic> {
        match value {
            Value::Unit | Value::Unbounded | Value::TypeVariable(_) => Ok(0),
            Value::Range {
                domain: Some(crate::value::Domain::Text),
                ..
            } => Ok(3),
            Value::Range {
                domain: Some(crate::value::Domain::Int),
                ..
            } => Ok(self.insert_type("signed-integer-64", RuntimeType::SignedInteger64)),
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
            _ => Err(hir_error(
                "A host result type is outside the Rust residual calculus.",
            )),
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
        });
        RuntimeValue {
            id: result,
            type_id,
            meaning: RuntimeMeaning::Plain,
        }
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
        let key = format!(
            "residual-sum:{}:{}",
            cases.join("|"),
            payload_types
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join("|")
        );
        self.insert_type(
            &key,
            RuntimeType::Sum {
                name: format!("residual${}", self.types.len()),
                cases: cases
                    .iter()
                    .zip(payload_types)
                    .map(|(name, payload_type)| RuntimeCase {
                        name: name.clone(),
                        payload_type: *payload_type,
                    })
                    .collect(),
            },
        )
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
        if let RuntimeType::Sum { cases, .. } = &self.types[value.type_id] {
            value.meaning = RuntimeMeaning::Sum {
                cases: cases.iter().map(|case_| case_.name.clone()).collect(),
            };
            return Ok(Value::Runtime(value));
        }
        let RuntimeType::Product { fields, .. } = self.types[value.type_id].clone() else {
            return Ok(Value::Runtime(value));
        };
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
            });
            projected.insert(
                field.name,
                Value::Runtime(RuntimeValue {
                    id: result,
                    type_id: field.type_id,
                    meaning: RuntimeMeaning::Plain,
                }),
            );
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

fn compiler_tag_payload(payload: Option<&Value>) -> Value {
    let Some(value) = payload else {
        return Value::Unit;
    };
    if let Value::Shape(fields) = value
        && fields.len() == 1
        && let Some(value) = fields.get("value")
    {
        return value.clone();
    }
    value.clone()
}

fn contains_runtime(value: &Value) -> bool {
    match value {
        Value::Runtime(_) => true,
        Value::Shape(fields) => fields.iter().any(|(_, value)| contains_runtime(value)),
        Value::Array(elements) => elements.iter().any(contains_runtime),
        Value::Tag { payload, .. } => payload.as_deref().is_some_and(contains_runtime),
        Value::Sealed { inner, .. } | Value::Extended { inner, .. } => contains_runtime(inner),
        _ => false,
    }
}

fn merge_meaning(left: &RuntimeMeaning, right: &RuntimeMeaning) -> RuntimeMeaning {
    match (left, right) {
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

struct HostCall {
    capability: String,
    operation: String,
    argument: Value,
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
    let result_is_shape = context.modules.borrow().get(path).is_some_and(|loaded| {
        matches!(
            loaded.module.arena.expressions[loaded.module.result.0 as usize],
            crate::ast::Expression::Shape { .. }
        )
    });
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
        Err(error)
            if error.code == "BLOT_DYNAMIC_HOST_RESULT"
                && !result_is_shape
                && checked.parameter.is_none() =>
        {
            return prepare_residual(context, path, checked);
        }
        Err(error) => return Err(error),
    };
    let staged = staged_exports(value, checked.result, result_is_shape)?;
    if staged.iter().all(|exported| exported.runtime.is_none()) {
        return Err(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A compiled module needs at least one runtime export.",
            crate::ast::Span { start: 0, end: 0 },
        ));
    }
    HirBuilder::new(path).build(staged, host_calls)
}

fn prepare_residual(
    context: Rc<Context>,
    path: &str,
    checked: CheckedModule,
) -> Result<RuntimeModule, Diagnostic> {
    if let Some(span) = context.modules.borrow().get(path).and_then(|loaded| {
        loaded
            .module
            .arena
            .expressions
            .iter()
            .find_map(|expression| {
                if let crate::ast::Expression::Rec { span, .. } = expression {
                    Some(*span)
                } else {
                    None
                }
            })
    }) {
        return Err(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "`rec` is outside the Rust residual Runtime-HIR calculus.",
            span,
        ));
    }
    let trace = Rc::new(std::cell::RefCell::new(ResidualTrace::new(path)));
    let computation = evaluate_checked_module(
        context,
        path,
        &checked,
        Value::Unit,
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
            path.to_owned(),
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
                    request.span,
                )?;
                computation = resume(result);
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
            "The module parameter must be a record of capabilities.",
        ));
    };
    let mut operations = OrderedFields::default();
    for (name, signature) in fields {
        let Type::Function { .. } = signature else {
            return Err(hir_error(&format!(
                "The module capability `{name}` is not a function."
            )));
        };
        operations.insert(
            name.clone(),
            Value::Arrow {
                domain: Box::new(Value::Unbounded),
                codomain: Box::new(Value::Unit),
                effects: Vec::new(),
            },
        );
    }
    let effect = Value::Effect {
        id: u32::MAX,
        name: "Init".to_owned(),
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

fn complete_host_calls(mut computation: Computation) -> Result<(Value, Vec<HostCall>), Diagnostic> {
    let mut calls = Vec::new();
    loop {
        match computation {
            Computation::Done(result) => return result.map(|value| (value, calls)),
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
                });
                computation = resume(Value::Unit);
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
                let type_ = types
                    .iter()
                    .find_map(|(candidate, type_)| {
                        if candidate == &name {
                            Some(type_.clone())
                        } else {
                            None
                        }
                    })
                    .ok_or_else(|| {
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
    capability_signatures: BTreeMap<String, BTreeMap<String, (usize, String)>>,
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
                    .map(|(name, (signature, _))| RuntimeCapabilityOperation { name, signature })
                    .collect(),
            })
            .collect();
        Ok(RuntimeModule {
            format: "blot-runtime-hir",
            schema_version: 1,
            source: self.source,
            types: self.types,
            signatures: self.signatures,
            functions,
            capabilities,
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
            Type::Array(element) => {
                let Value::Array(elements) = value else {
                    return Err(self.mismatch(value, "array"));
                };
                let element_value = elements.first().unwrap_or(&Value::Unit);
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
                let mut cases = cases.clone();
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
            Type::Opaque(name) if name == "F32x4" => Ok(self.insert_type(
                "vector:f32x4".to_owned(),
                RuntimeType::Vector {
                    element: "float-32",
                    lanes: 4,
                },
            )),
            Type::Opaque(name) if name == "F32x4Mask" => Ok(self.insert_type(
                "mask:f32x4".to_owned(),
                RuntimeType::Mask {
                    element: "float-32",
                    lanes: 4,
                },
            )),
            Type::Opaque(name) if matches!(name.as_str(), "I32x4" | "I16x8" | "I8x16") => {
                let (element, lanes) = integer_simd_layout(name);
                Ok(self.insert_type(
                    format!("vector:{name}"),
                    RuntimeType::Vector { element, lanes },
                ))
            }
            Type::Opaque(name)
                if matches!(name.as_str(), "I32x4Mask" | "I16x8Mask" | "I8x16Mask") =>
            {
                let vector_name = name.strip_suffix("Mask").expect("matched mask name");
                let (element, lanes) = integer_simd_layout(vector_name);
                Ok(self.insert_type(
                    format!("mask:{vector_name}"),
                    RuntimeType::Mask { element, lanes },
                ))
            }
            Type::Opaque(name) if name.starts_with("Sealed:") => {
                let (seal_name, inner) = if let Value::Sealed { name, inner } = value {
                    (name.clone(), inner.as_ref())
                } else {
                    (
                        name.strip_prefix("Sealed:").unwrap_or(name).to_owned(),
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
                        return self.runtime_type(&Type::Variant { cases, open: false }, value);
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
                    return self.value(value, &Type::Variant { cases, open: false }, operations);
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
                let integer_type =
                    self.insert_type("signed-integer-64".to_owned(), RuntimeType::SignedInteger64);
                let length = self.constant(
                    WireConstant::SignedInteger64(elements.len().to_string()),
                    integer_type,
                    "plain",
                    operations,
                );
                let first = self.value(&elements[0], element_type, operations)?;
                let mut store = self.operation(
                    "store.new",
                    type_id,
                    vec![length, first],
                    "owned",
                    operations,
                );
                for (index, element) in elements.iter().enumerate().skip(1) {
                    let position = self.constant(
                        WireConstant::SignedInteger64(index.to_string()),
                        integer_type,
                        "plain",
                        operations,
                    );
                    let element = self.value(element, element_type, operations)?;
                    let result = self.next_value();
                    operations.push(RuntimeOperation {
                        kind: "store.write",
                        result,
                        type_id,
                        operands: vec![store, position, element],
                        ownership: "owned",
                        span: self.span.clone(),
                        value: None,
                        update: Some("owned-reuse"),
                        case: None,
                        capability: None,
                        operation: None,
                        operator: None,
                        conversion: None,
                        lane: None,
                        field: None,
                    });
                    store = result;
                }
                Ok(store)
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
                let inferred_payload = cases.iter().find_map(|(candidate, payload)| {
                    if candidate == name {
                        Some(payload.clone())
                    } else {
                        None
                    }
                });
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
                });
                Ok(result)
            }
            Value::Sealed { inner, .. } => {
                let inner_type = type_from_value(inner);
                let inner = self.value(inner, &inner_type, operations)?;
                Ok(self.operation("seal.wrap", type_id, vec![inner], "owned", operations))
            }
            value if matches!(type_, Type::Opaque(name) if name.starts_with("Sealed:")) => {
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
        let signature = if let Some((signature, existing_key)) = capability.get(&call.operation) {
            if existing_key != &parameter_key {
                return Err(hir_error(&format!(
                    "Host operation {}.{} has inconsistent argument types.",
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
            capability.insert(call.operation.clone(), (signature, parameter_key));
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
        Value::Array(elements) => Type::Array(Box::new(
            elements
                .first()
                .map(type_from_value)
                .unwrap_or(Type::Bottom),
        )),
        Value::Tag { name, payload } => Type::Variant {
            cases: vec![(
                name.clone(),
                payload
                    .as_deref()
                    .map(type_from_value)
                    .unwrap_or(Type::Unit),
            )],
            open: false,
        },
        Value::Sealed { name, .. } => Type::Opaque(format!("Sealed:{name}")),
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
        Type::Array(_) => Some(Value::Array(Vec::new())),
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

fn hir_error(message: &str) -> Diagnostic {
    Diagnostic::new(
        "BLOT_UNSUPPORTED_LOWERING",
        message,
        crate::ast::Span { start: 0, end: 0 },
    )
}
