use num_bigint::BigInt;
use num_traits::{ToPrimitive, Zero};

use crate::ast::Span;
use crate::diagnostic::Diagnostic;
use crate::eval::Phase;
use crate::value::{
    Domain, OrderedFields, Value, attach_signature, boolean, closure_signature, equal, show,
    substitute_type_variable, tuple,
};

const F32X4: &str = "F32x4";
const F32X4_MASK: &str = "F32x4Mask";
const I32X4: &str = "I32x4";
const I32X4_MASK: &str = "I32x4Mask";
const I16X8: &str = "I16x8";
const I16X8_MASK: &str = "I16x8Mask";
const I8X16: &str = "I8x16";
const I8X16_MASK: &str = "I8x16Mask";

pub fn constant(name: &str) -> Option<Value> {
    match name {
        "@type.unbounded" => Some(Value::Unbounded),
        "@type.unit" => Some(Value::Unit),
        "@type.int" => Some(Value::Range {
            low: Box::new(Value::Int(-(BigInt::from(1_u64) << 63_usize))),
            high: Box::new(Value::Int((BigInt::from(1_u64) << 63_usize) - 1)),
            domain: Some(Domain::Int),
        }),
        "@type.text" => Some(Value::Range {
            low: Box::new(Value::Unbounded),
            high: Box::new(Value::Unbounded),
            domain: Some(Domain::Text),
        }),
        "@type.float" => Some(Value::Range {
            low: Box::new(Value::Unbounded),
            high: Box::new(Value::Unbounded),
            domain: Some(Domain::Float),
        }),
        "@type.float32" => Some(Value::Range {
            low: Box::new(Value::Unbounded),
            high: Box::new(Value::Unbounded),
            domain: Some(Domain::Float32),
        }),
        "@type.f32x4" => Some(Value::OpaqueType(F32X4.to_owned())),
        "@type.f32x4_mask" => Some(Value::OpaqueType(F32X4_MASK.to_owned())),
        "@type.i32x4" => Some(Value::OpaqueType(I32X4.to_owned())),
        "@type.i32x4_mask" => Some(Value::OpaqueType(I32X4_MASK.to_owned())),
        "@type.i16x8" => Some(Value::OpaqueType(I16X8.to_owned())),
        "@type.i16x8_mask" => Some(Value::OpaqueType(I16X8_MASK.to_owned())),
        "@type.i8x16" => Some(Value::OpaqueType(I8X16.to_owned())),
        "@type.i8x16_mask" => Some(Value::OpaqueType(I8X16_MASK.to_owned())),
        "@region.rejoin" => Some(Value::OpaqueType("Rejoin".to_owned())),
        "@shape.empty" => Some(Value::Shape(OrderedFields::default())),
        "@array.empty" => Some(Value::Array(Vec::new())),
        _ => None,
    }
}

pub fn primitive_arity(name: &str) -> Option<usize> {
    if let Some(arity) = simd_arity(name) {
        return Some(arity);
    }
    let arity = match name {
        "@effect" | "@effect.host" | "@forall" | "@handle" | "@import" => 1,
        "@include" => 2,
        "@continuation.cancel"
        | "@type.of"
        | "@type.open"
        | "@type.reflect"
        | "@type.members"
        | "@type.union_of"
        | "@fail"
        | "@shape.names"
        | "@array.len"
        | "@array.copy"
        | "@array.indexed"
        | "@region.type"
        | "@region.copy"
        | "@region.length"
        | "@region.freeze"
        | "@scratch.type"
        | "@scratch.with_capacity"
        | "@scratch.finish"
        | "@scratch.recycle"
        | "@int.neg"
        | "@text.len"
        | "@text.of_int"
        | "@linear.own"
        | "@linear.maybe"
        | "@linear.borrow"
        | "@linear.freeze"
        | "@assert.reuse"
        | "@float.neg"
        | "@float.is_nan"
        | "@float.of_int"
        | "@int.of_float"
        | "@f32.neg"
        | "@f32.sqrt"
        | "@f32.is_nan"
        | "@f32.of_float"
        | "@f32.of_int"
        | "@float.of_f32"
        | "@f32x4.splat"
        | "@f32x4.sum"
        | "@f32x4.x"
        | "@f32x4.y"
        | "@f32x4.z"
        | "@f32x4.w"
        | "@branch.likely"
        | "@branch.unlikely"
        | "@type.probe"
        | "@panic" => 1,
        "@type.range"
        | "@type.union"
        | "@type.intersect"
        | "@type.diff"
        | "@type.arrow"
        | "@type.deferred_arrow"
        | "@type.performs"
        | "@type.refine"
        | "@type.equal"
        | "@type.instantiate"
        | "@type.seal"
        | "@satisfies"
        | "@shape.get"
        | "@shape.update"
        | "@shape.remove"
        | "@shape.has"
        | "@array.get"
        | "@array.push"
        | "@array.take"
        | "@array.split"
        | "@region.get"
        | "@region.split"
        | "@region.reassociate_left"
        | "@region.reassociate_right"
        | "@scratch.push"
        | "@int.add"
        | "@int.sub"
        | "@int.mul"
        | "@int.div"
        | "@int.rem"
        | "@int.cmp"
        | "@text.concat"
        | "@text.cmp"
        | "@text.contains"
        | "@text.scalar_at"
        | "@json.parse"
        | "@float.add"
        | "@float.sub"
        | "@float.mul"
        | "@float.div"
        | "@float.rem"
        | "@float.cmp"
        | "@f32.add"
        | "@f32.sub"
        | "@f32.mul"
        | "@f32.div"
        | "@f32.cmp"
        | "@f32x4.add"
        | "@f32x4.sub"
        | "@f32x4.mul"
        | "@f32x4.div"
        | "@f32x4.eq"
        | "@f32x4.less" => 2,
        "@type.attach" | "@shape.set" | "@array.set" | "@region.set" | "@region.replace"
        | "@region.swap" | "@region.join" | "@text.slice" | "@text.find_from" | "@f32x4.select" => {
            3
        }
        "@f32x4.of" => 4,
        "@f32x4.shuffle" => 6,
        _ => return None,
    };
    Some(arity)
}

fn simd_arity(name: &str) -> Option<usize> {
    let (prefix, operation) = name.strip_prefix('@')?.split_once('.')?;
    let operation = operation.strip_suffix("_wrapping").unwrap_or(operation);
    if !matches!(prefix, "f32x4" | "i32x4" | "i16x8" | "i8x16") {
        return None;
    }
    if operation == "of" {
        return (prefix == "i32x4").then_some(4);
    }
    if matches!(operation, "select") {
        return Some(3);
    }
    if operation.starts_with("with_lane") {
        return Some(2);
    }
    if operation == "lane" {
        return (prefix == "i32x4").then_some(2);
    }
    if operation.starts_with("lane") {
        return Some(1);
    }
    if matches!(
        operation,
        "splat"
            | "abs"
            | "neg"
            | "sqrt"
            | "ceil"
            | "floor"
            | "trunc"
            | "nearest"
            | "not"
            | "mask_bitmask"
            | "mask_all"
            | "mask_any"
            | "convert_i32_s"
            | "convert_i32_u"
            | "trunc_sat_f32_s"
            | "trunc_sat_f32_u"
    ) {
        return Some(1);
    }
    if matches!(
        operation,
        "add"
            | "sub"
            | "mul"
            | "div"
            | "and"
            | "or"
            | "xor"
            | "shl"
            | "shr_s"
            | "shr_u"
            | "eq"
            | "ne"
            | "less"
            | "le"
            | "gt"
            | "ge"
            | "lt_s"
            | "lt_u"
            | "gt_s"
            | "gt_u"
            | "le_s"
            | "le_u"
            | "ge_s"
            | "ge_u"
            | "min"
            | "max"
            | "pmin"
            | "pmax"
            | "min_s"
            | "min_u"
            | "max_s"
            | "max_u"
    ) {
        if prefix == "i8x16" && operation == "mul" {
            return None;
        }
        return Some(2);
    }
    None
}

pub fn run_primitive(
    name: &str,
    arguments: Vec<Value>,
    span: Span,
    phase: Phase,
) -> Result<Value, Diagnostic> {
    if let Some(result) = run_integer_simd(name, &arguments, span) {
        return result;
    }
    match name {
        "@continuation.cancel" => cancel(&arguments[0], span),
        "@type.range" => Ok(Value::Range {
            low: Box::new(arguments[0].clone()),
            high: Box::new(arguments[1].clone()),
            domain: None,
        }),
        "@type.union" => Ok(union(arguments[0].clone(), arguments[1].clone())),
        "@type.intersect" => intersect(&arguments[0], &arguments[1], span),
        "@type.diff" => difference(&arguments[0], &arguments[1], span),
        "@type.arrow" => Ok(Value::Arrow {
            deferred: false,
            domain: Box::new(arguments[0].clone()),
            codomain: Box::new(arguments[1].clone()),
            effects: Vec::new(),
            effect_tail: None,
        }),
        "@type.deferred_arrow" => Ok(Value::Arrow {
            deferred: true,
            domain: Box::new(arguments[0].clone()),
            codomain: Box::new(arguments[1].clone()),
            effects: Vec::new(),
            effect_tail: None,
        }),
        "@type.performs" => performs(&arguments[0], &arguments[1], span),
        "@type.of" => Ok(type_of(&arguments[0])),
        "@type.seal" => Ok(Value::Sealed {
            name: text(&arguments[0], span, name)?.to_owned(),
            inner: Box::new(arguments[1].clone()),
        }),
        "@type.open" => match &arguments[0] {
            Value::Sealed { inner, .. } => Ok((**inner).clone()),
            value => Err(type_error(name, "a sealed value", value, span)),
        },
        "@fail" => Err(Diagnostic::new(
            "BLOT_REFUSED",
            match &arguments[0] {
                Value::Text(message) => message.clone(),
                value => show(value),
            },
            span,
        )),
        "@type.reflect" => Ok(reflect(&arguments[0])),
        "@type.equal" => Ok(boolean(equal(&arguments[0], &arguments[1]))),
        "@type.instantiate" => {
            let Value::Forall { variable, body } = &arguments[0] else {
                return Err(Diagnostic::new(
                    "BLOT_TYPE_INSTANTIATE",
                    format!(
                        "@type.instantiate needs an outer quantified type, found {}.",
                        show(&arguments[0])
                    ),
                    span,
                ));
            };
            substitute_type_variable(body, *variable, &arguments[1]).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_TYPE_INSTANTIATE",
                    format!(
                        "{} cannot instantiate an effect-row variable.",
                        show(&arguments[1])
                    ),
                    span,
                )
            })
        }
        "@type.probe" => {
            let Value::Forall { variable, body } = &arguments[0] else {
                return Err(Diagnostic::new(
                    "BLOT_TYPE_INSTANTIATE",
                    format!(
                        "@type.probe needs an outer quantified type, found {}.",
                        show(&arguments[0])
                    ),
                    span,
                ));
            };
            // Probe ordinary binders with Unit and effect-row binders with the
            // empty row. Both witnesses are closed, so source never observes a
            // binder identity or an open quantified body.
            substitute_type_variable(body, *variable, &Value::Unit)
                .or_else(|| substitute_type_variable(body, *variable, &Value::Array(Vec::new())))
                .ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_TYPE_INSTANTIATE",
                        "The quantified type has no kind-correct closed probe.",
                        span,
                    )
                })
        }
        "@type.attach" => attach(arguments, span),
        "@type.members" => match &arguments[0] {
            Value::Extended { members, .. } => Ok(Value::Shape(members.clone())),
            _ => Ok(Value::Shape(OrderedFields::default())),
        },
        "@type.union_of" => {
            let values = array(&arguments[0], span, name)?;
            let Some(first) = values.first().cloned() else {
                return Err(Diagnostic::new(
                    "BLOT_EMPTY_TYPE",
                    "@type.union_of has nothing to union.",
                    span,
                ));
            };
            Ok(values.iter().skip(1).cloned().fold(first, union))
        }
        // Type checking owns this judgment. Evaluation preserves the checked
        // subject instead of losing inferred evidence by checking it again.
        "@satisfies" => {
            let mut subject = arguments[0].clone();
            attach_signature(&mut subject, &arguments[1]);
            Ok(subject)
        }
        "@shape.get" => {
            let fields = shape(&arguments[0], span, name)?;
            let key = text(&arguments[1], span, name)?;
            fields
                .get(key)
                .cloned()
                .ok_or_else(|| Diagnostic::new("BLOT_NO_FIELD", format!("No field `{key}`."), span))
        }
        "@shape.set" => {
            let mut fields = shape(&arguments[0], span, name)?.clone();
            fields.insert(
                text(&arguments[1], span, name)?.to_owned(),
                arguments[2].clone(),
            );
            Ok(Value::Shape(fields))
        }
        "@shape.update" => {
            let mut fields = shape(&arguments[0], span, name)?.clone();
            for (field, value) in shape(&arguments[1], span, name)? {
                fields.insert(field.clone(), value.clone());
            }
            Ok(Value::Shape(fields))
        }
        "@shape.remove" => {
            let mut fields = shape(&arguments[0], span, name)?.clone();
            fields.remove(text(&arguments[1], span, name)?);
            Ok(Value::Shape(fields))
        }
        "@shape.names" => Ok(Value::Array(
            shape(&arguments[0], span, name)?
                .keys()
                .cloned()
                .map(Value::Text)
                .collect(),
        )),
        "@shape.has" => Ok(boolean(
            shape(&arguments[0], span, name)?.contains_key(text(&arguments[1], span, name)?),
        )),
        "@region.type" => Ok(Value::RegionType(Box::new(arguments[0].clone()))),
        "@scratch.type" => Ok(Value::ScratchType(Box::new(arguments[0].clone()))),
        "@scratch.with_capacity" => {
            let capacity = integer(&arguments[0], span, name)?
                .to_usize()
                .ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_SCRATCH_CAPACITY",
                        "Scratch capacity must be a non-negative machine-sized integer.",
                        span,
                    )
                })?;
            Ok(Value::Scratch {
                values: Vec::new(),
                capacity,
            })
        }
        "@scratch.push" => {
            let Value::Scratch { values, capacity } = &arguments[0] else {
                return Err(type_error(name, "an owned Scratch", &arguments[0], span));
            };
            let mut values = values.clone();
            values.push(arguments[1].clone());
            let capacity = if values.len() <= *capacity {
                *capacity
            } else {
                capacity.saturating_mul(2).max(1).max(values.len())
            };
            Ok(Value::Scratch { values, capacity })
        }
        "@scratch.finish" => {
            let Value::Scratch { values, .. } = &arguments[0] else {
                return Err(type_error(name, "an owned Scratch", &arguments[0], span));
            };
            Ok(Value::Array(values.clone()))
        }
        "@scratch.recycle" => {
            let values = array(&arguments[0], span, name)?;
            Ok(Value::Scratch {
                values: Vec::new(),
                capacity: values.len(),
            })
        }
        "@region.copy" => {
            let values = array(&arguments[0], span, name)?.to_vec();
            let length = values.len();
            Ok(Value::Region {
                store: std::rc::Rc::new(std::cell::RefCell::new(values)),
                start: 0,
                end: length,
            })
        }
        "@region.length" => {
            let (_, start, end) = region(&arguments[0], span, name)?;
            Ok(Value::Int(BigInt::from(end - start)))
        }
        "@region.get" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let Some(relative) = region_index(&arguments[1], end - start, span, name)? else {
                return Ok(Value::Tag {
                    name: "None".to_owned(),
                    payload: None,
                });
            };
            let value = store.borrow()[start + relative].clone();
            Ok(Value::Tag {
                name: "Some".to_owned(),
                payload: Some(Box::new(value)),
            })
        }
        "@region.set" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let Some(relative) = region_index(&arguments[1], end - start, span, name)? else {
                return Ok(Value::Tag {
                    name: "SetOutOfBounds".to_owned(),
                    payload: Some(Box::new(arguments[0].clone())),
                });
            };
            store.borrow_mut()[start + relative] = arguments[2].clone();
            Ok(Value::Tag {
                name: "Updated".to_owned(),
                payload: Some(Box::new(arguments[0].clone())),
            })
        }
        "@region.replace" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let Some(relative) = region_index(&arguments[1], end - start, span, name)? else {
                return Ok(Value::Tag {
                    name: "ReplaceOutOfBounds".to_owned(),
                    payload: Some(Box::new(tuple(vec![
                        arguments[2].clone(),
                        arguments[0].clone(),
                    ]))),
                });
            };
            let displaced = std::mem::replace(
                &mut store.borrow_mut()[start + relative],
                arguments[2].clone(),
            );
            Ok(Value::Tag {
                name: "Replaced".to_owned(),
                payload: Some(Box::new(tuple(vec![displaced, arguments[0].clone()]))),
            })
        }
        "@region.swap" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let length = end - start;
            let left = region_index(&arguments[1], length, span, name)?;
            let right = region_index(&arguments[2], length, span, name)?;
            let (Some(left), Some(right)) = (left, right) else {
                return Ok(Value::Tag {
                    name: "SwapOutOfBounds".to_owned(),
                    payload: Some(Box::new(arguments[0].clone())),
                });
            };
            store.borrow_mut().swap(start + left, start + right);
            Ok(Value::Tag {
                name: "Updated".to_owned(),
                payload: Some(Box::new(arguments[0].clone())),
            })
        }
        "@region.split" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let Some(offset) = region_split_offset(&arguments[1], end - start, span, name)? else {
                return Ok(Value::Tag {
                    name: "SplitOutOfBounds".to_owned(),
                    payload: Some(Box::new(arguments[0].clone())),
                });
            };
            let middle = start + offset;
            Ok(Value::Tag {
                name: "Split".to_owned(),
                payload: Some(Box::new(tuple(vec![
                    Value::Region {
                        store: store.clone(),
                        start,
                        end: middle,
                    },
                    Value::Region {
                        store: store.clone(),
                        start: middle,
                        end,
                    },
                    Value::RegionRejoin {
                        store,
                        start,
                        middle,
                        end,
                    },
                ]))),
            })
        }
        "@region.join" => {
            let Value::RegionRejoin {
                store: witness_store,
                start: witness_start,
                middle: witness_middle,
                end: witness_end,
            } = &arguments[0]
            else {
                return Err(type_error(name, "a rejoin witness", &arguments[0], span));
            };
            let (left_store, left_start, left_end) = region(&arguments[1], span, name)?;
            let (right_store, right_start, right_end) = region(&arguments[2], span, name)?;
            let paired = std::rc::Rc::ptr_eq(witness_store, &left_store)
                && std::rc::Rc::ptr_eq(witness_store, &right_store)
                && *witness_start == left_start
                && *witness_middle == left_end
                && *witness_middle == right_start
                && *witness_end == right_end;
            if !paired {
                return Err(Diagnostic::new(
                    "BLOT_REGION_JOIN_UNPROVED",
                    "Region join requires the witness minted with these two parts.",
                    span,
                ));
            }
            Ok(Value::Region {
                store: left_store,
                start: left_start,
                end: right_end,
            })
        }
        "@region.reassociate_left" | "@region.reassociate_right" => {
            let Value::RegionRejoin {
                store: outer_store,
                start: outer_start,
                middle: outer_middle,
                end: outer_end,
            } = &arguments[0]
            else {
                return Err(type_error(name, "a rejoin witness", &arguments[0], span));
            };
            let Value::RegionRejoin {
                store: inner_store,
                start: inner_start,
                middle: inner_middle,
                end: inner_end,
            } = &arguments[1]
            else {
                return Err(type_error(name, "a rejoin witness", &arguments[1], span));
            };
            let left = name == "@region.reassociate_left";
            let nested = std::rc::Rc::ptr_eq(outer_store, inner_store)
                && if left {
                    *outer_middle == *inner_start && *outer_end == *inner_end
                } else {
                    *outer_start == *inner_start && *outer_middle == *inner_end
                };
            if !nested {
                return Err(Diagnostic::new(
                    "BLOT_REGION_REASSOCIATE_UNPROVED",
                    "Region witness reassociation requires an exact nested split proof.",
                    span,
                ));
            }
            if left {
                return Ok(tuple(vec![
                    Value::RegionRejoin {
                        store: outer_store.clone(),
                        start: *outer_start,
                        middle: *inner_middle,
                        end: *outer_end,
                    },
                    Value::RegionRejoin {
                        store: outer_store.clone(),
                        start: *outer_start,
                        middle: *outer_middle,
                        end: *inner_middle,
                    },
                ]));
            }
            Ok(tuple(vec![
                Value::RegionRejoin {
                    store: outer_store.clone(),
                    start: *outer_start,
                    middle: *inner_middle,
                    end: *outer_end,
                },
                Value::RegionRejoin {
                    store: outer_store.clone(),
                    start: *inner_middle,
                    middle: *outer_middle,
                    end: *outer_end,
                },
            ]))
        }
        "@region.freeze" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let values = store.borrow();
            if start != 0 || end != values.len() {
                return Err(Diagnostic::new(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region can be frozen.",
                    span,
                ));
            }
            Ok(Value::Array(values.clone()))
        }
        "@array.len" => Ok(Value::Int(BigInt::from(
            array(&arguments[0], span, name)?.len(),
        ))),
        "@array.copy" => Ok(Value::Array(array(&arguments[0], span, name)?.to_vec())),
        "@array.get" => {
            let values = array(&arguments[0], span, name)?;
            let index = index(&arguments[1], span, name)?;
            values
                .get(index)
                .cloned()
                .ok_or_else(|| out_of_bounds(index, values.len(), span))
        }
        "@array.set" => {
            let mut values = array(&arguments[0], span, name)?.to_vec();
            let index = index(&arguments[1], span, name)?;
            let Some(slot) = values.get_mut(index) else {
                return Err(out_of_bounds(index, values.len(), span));
            };
            *slot = arguments[2].clone();
            Ok(Value::Array(values))
        }
        "@array.push" => {
            let mut values = array(&arguments[0], span, name)?.to_vec();
            values.push(arguments[1].clone());
            Ok(Value::Array(values))
        }
        "@array.indexed" => Ok(Value::Shape(OrderedFields::from([
            ("state".to_owned(), Value::Int(BigInt::zero())),
            (
                "step".to_owned(),
                Value::IndexedStep {
                    elements: array(&arguments[0], span, name)?.to_vec(),
                },
            ),
        ]))),
        "@array.take" => take(arguments, span),
        "@array.split" => split(arguments, span),
        "@int.add" => integer_binary(arguments, span, phase, name, |left, right| left + right),
        "@int.sub" => integer_binary(arguments, span, phase, name, |left, right| left - right),
        "@int.mul" => integer_binary(arguments, span, phase, name, |left, right| left * right),
        "@int.div" => integer_divide(arguments, span, phase, false),
        "@int.rem" => integer_divide(arguments, span, phase, true),
        "@int.neg" => integer_result(
            -integer(&arguments[0], span, name)?.clone(),
            span,
            phase,
            name,
        ),
        "@int.cmp" => Ok(ordering(integer(&arguments[0], span, name)?.cmp(integer(
            &arguments[1],
            span,
            name,
        )?))),
        "@text.concat" => Ok(Value::Text(format!(
            "{}{}",
            text(&arguments[0], span, name)?,
            text(&arguments[1], span, name)?
        ))),
        "@text.len" => Ok(Value::Int(BigInt::from(
            text(&arguments[0], span, name)?.chars().count(),
        ))),
        "@text.scalar_at" => {
            let source = text(&arguments[0], span, name)?;
            let index = text_index(&arguments[1], span, name)?;
            source
                .chars()
                .nth(index)
                .map(|scalar| Value::Text(scalar.to_string()))
                .ok_or_else(|| text_bounds_error(name, span))
        }
        "@text.slice" => {
            let source = text(&arguments[0], span, name)?;
            let start = text_index(&arguments[1], span, name)?;
            let end = text_index(&arguments[2], span, name)?;
            let count = source.chars().count();
            if start > end || end > count {
                return Err(text_bounds_error(name, span));
            }
            Ok(Value::Text(
                source.chars().skip(start).take(end - start).collect(),
            ))
        }
        "@text.find_from" => {
            let source = text(&arguments[0], span, name)?;
            let query = text(&arguments[1], span, name)?;
            let start = text_index(&arguments[2], span, name)?;
            let count = source.chars().count();
            let Some(start_byte) = source
                .char_indices()
                .nth(start)
                .map(|(byte, _)| byte)
                .or_else(|| (start == count).then_some(source.len()))
            else {
                return Ok(Value::Int(BigInt::from(-1)));
            };
            let found = source[start_byte..]
                .find(query)
                .map(|relative| start + source[start_byte..start_byte + relative].chars().count());
            Ok(Value::Int(BigInt::from(
                found
                    .and_then(|index| i64::try_from(index).ok())
                    .unwrap_or(-1),
            )))
        }
        "@text.cmp" => Ok(ordering(text(&arguments[0], span, name)?.cmp(text(
            &arguments[1],
            span,
            name,
        )?))),
        "@text.contains" => Ok(boolean(text(&arguments[0], span, name)?.contains(text(
            &arguments[1],
            span,
            name,
        )?))),
        "@text.of_int" => Ok(Value::Text(integer(&arguments[0], span, name)?.to_string())),
        "@json.parse" => parse_json(arguments, span, phase),
        "@assert.reuse" => {
            let mut value = arguments[0].clone();
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
            Ok(value)
        }
        "@linear.own" | "@linear.maybe" | "@linear.borrow" | "@linear.freeze"
        | "@branch.likely" | "@branch.unlikely" => Ok(arguments[0].clone()),
        "@float.add" => float_binary(arguments, span, name, |left, right| left + right),
        "@float.sub" => float_binary(arguments, span, name, |left, right| left - right),
        "@float.mul" => float_binary(arguments, span, name, |left, right| left * right),
        "@float.div" => float_binary(arguments, span, name, |left, right| left / right),
        "@float.rem" => float_binary(arguments, span, name, |left, right| left % right),
        "@float.neg" => Ok(Value::Float(-float(&arguments[0], span, name)?)),
        "@float.is_nan" => Ok(boolean(float(&arguments[0], span, name)?.is_nan())),
        "@float.cmp" => float_ordering(
            float(&arguments[0], span, name)?,
            float(&arguments[1], span, name)?,
            span,
            name,
        ),
        "@float.of_int" => Ok(Value::Float(
            integer(&arguments[0], span, name)?
                .to_f64()
                .unwrap_or_else(|| {
                    if integer(&arguments[0], span, name)
                        .is_ok_and(|value| value.sign() == num_bigint::Sign::Minus)
                    {
                        f64::NEG_INFINITY
                    } else {
                        f64::INFINITY
                    }
                }),
        )),
        "@int.of_float" => {
            let value = float(&arguments[0], span, name)?;
            if !value.is_finite()
                || value.trunc() < i64::MIN as f64
                || value.trunc() > i64::MAX as f64
            {
                return Err(Diagnostic::new(
                    "BLOT_INTEGER_OVERFLOW",
                    format!("{name} cannot represent {value} as signed i64."),
                    span,
                ));
            }
            Ok(Value::Int(BigInt::from(value.trunc() as i64)))
        }
        "@f32.add" => float32_binary(arguments, span, name, |left, right| left + right),
        "@f32.sub" => float32_binary(arguments, span, name, |left, right| left - right),
        "@f32.mul" => float32_binary(arguments, span, name, |left, right| left * right),
        "@f32.div" => float32_binary(arguments, span, name, |left, right| left / right),
        "@f32.neg" => Ok(Value::Float32(-float32(&arguments[0], span, name)?)),
        "@f32.sqrt" => Ok(Value::Float32(float32(&arguments[0], span, name)?.sqrt())),
        "@f32.is_nan" => Ok(boolean(float32(&arguments[0], span, name)?.is_nan())),
        "@f32.cmp" => float_ordering(
            f64::from(float32(&arguments[0], span, name)?),
            f64::from(float32(&arguments[1], span, name)?),
            span,
            name,
        ),
        "@f32.of_float" => Ok(Value::Float32(float(&arguments[0], span, name)? as f32)),
        "@f32.of_int" => {
            let value = integer(&arguments[0], span, name)?;
            let converted = value.to_f32().unwrap_or_else(|| {
                if value.sign() == num_bigint::Sign::Minus {
                    f32::NEG_INFINITY
                } else {
                    f32::INFINITY
                }
            });
            Ok(Value::Float32(converted))
        }
        "@float.of_f32" => Ok(Value::Float(f64::from(float32(&arguments[0], span, name)?))),
        "@f32x4.of" => Ok(Value::Vector([
            float32(&arguments[0], span, name)?,
            float32(&arguments[1], span, name)?,
            float32(&arguments[2], span, name)?,
            float32(&arguments[3], span, name)?,
        ])),
        "@f32x4.splat" => Ok(Value::Vector([float32(&arguments[0], span, name)?; 4])),
        "@f32x4.add" => vector_binary(arguments, span, name, |left, right| left + right),
        "@f32x4.sub" => vector_binary(arguments, span, name, |left, right| left - right),
        "@f32x4.mul" => vector_binary(arguments, span, name, |left, right| left * right),
        "@f32x4.div" => vector_binary(arguments, span, name, |left, right| left / right),
        "@f32x4.eq" => vector_compare(arguments, span, name, |left, right| left == right),
        "@f32x4.less" => vector_compare(arguments, span, name, |left, right| left < right),
        "@f32x4.select" => vector_select(arguments, span),
        "@f32x4.shuffle" => vector_shuffle(arguments, span),
        "@f32x4.mask_all" => Ok(Value::Int(BigInt::from(
            vector_mask(&arguments[0], span, name)?
                .iter()
                .all(|lane| *lane),
        ))),
        "@f32x4.mask_any" => Ok(Value::Int(BigInt::from(
            vector_mask(&arguments[0], span, name)?
                .iter()
                .any(|lane| *lane),
        ))),
        "@f32x4.sum" => Ok(Value::Float32(
            vector(&arguments[0], span, name)?.iter().copied().sum(),
        )),
        "@f32x4.x" => vector_lane(&arguments[0], 0, span, name),
        "@f32x4.y" => vector_lane(&arguments[0], 1, span, name),
        "@f32x4.z" => vector_lane(&arguments[0], 2, span, name),
        "@f32x4.w" => vector_lane(&arguments[0], 3, span, name),
        "@panic" => Err(Diagnostic::new(
            "BLOT_PANIC",
            match &arguments[0] {
                Value::Text(message) => message.clone(),
                value => show(value),
            },
            span,
        )),
        _ => Err(Diagnostic::new(
            "BLOT_UNKNOWN_PRIMITIVE",
            format!("`{name}` is not implemented by the Rust middle."),
            span,
        )),
    }
}

fn run_integer_simd(
    name: &str,
    arguments: &[Value],
    span: Span,
) -> Option<Result<Value, Diagnostic>> {
    let (prefix, operation) = name.strip_prefix('@')?.split_once('.')?;
    let operation = operation.strip_suffix("_wrapping").unwrap_or(operation);
    let (bits, lane_count) = match prefix {
        "i32x4" => (32_u8, 4_usize),
        "i16x8" => (16_u8, 8_usize),
        "i8x16" => (8_u8, 16_usize),
        _ => return None,
    };
    let result = (|| {
        if operation == "of" {
            let lanes = arguments
                .iter()
                .map(|value| integer(value, span, name).map(|lane| wrap_lane(lane, bits)))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Value::IntegerVector { bits, lanes });
        }
        if operation == "splat" {
            let lane = wrap_lane(integer(&arguments[0], span, name)?, bits);
            return Ok(Value::IntegerVector {
                bits,
                lanes: vec![lane; lane_count],
            });
        }
        if operation == "lane" && prefix == "i32x4" {
            let lane = integer(&arguments[1], span, name)?;
            let index = usize::try_from(lane).map_err(|_| {
                Diagnostic::new(
                    "BLOT_SIMD_IMMEDIATE_RANGE",
                    "An I32x4 lane selector must be in 0..3.",
                    span,
                )
            })?;
            if index > 3 {
                return Err(Diagnostic::new(
                    "BLOT_SIMD_IMMEDIATE_RANGE",
                    format!("I32x4 lane {index} is outside 0..3."),
                    span,
                ));
            }
            let lanes = integer_vector(&arguments[0], bits, span, name)?;
            return Ok(Value::Int(BigInt::from(lanes[index])));
        }
        if let Some(lane) = operation.strip_prefix("lane") {
            let index = lane.parse::<usize>().map_err(|_| {
                Diagnostic::new("BLOT_TYPE", format!("{name} has an invalid lane."), span)
            })?;
            let lanes = integer_vector(&arguments[0], bits, span, name)?;
            return Ok(Value::Int(BigInt::from(lanes[index])));
        }
        if let Some(lane) = operation.strip_prefix("with_lane") {
            let index = lane.parse::<usize>().map_err(|_| {
                Diagnostic::new("BLOT_TYPE", format!("{name} has an invalid lane."), span)
            })?;
            let mut lanes = integer_vector(&arguments[0], bits, span, name)?.to_vec();
            lanes[index] = wrap_lane(integer(&arguments[1], span, name)?, bits);
            return Ok(Value::IntegerVector { bits, lanes });
        }
        if operation.starts_with("mask_") {
            let lanes = integer_mask(&arguments[0], bits, span, name)?;
            let answer = match operation {
                "mask_bitmask" => lanes.iter().enumerate().fold(0_i64, |mask, (index, lane)| {
                    if *lane { mask | (1_i64 << index) } else { mask }
                }),
                "mask_all" => i64::from(lanes.iter().all(|lane| *lane)),
                "mask_any" => i64::from(lanes.iter().any(|lane| *lane)),
                _ => return Err(Diagnostic::new("BLOT_UNKNOWN_PRIMITIVE", name, span)),
            };
            return Ok(Value::Int(BigInt::from(answer)));
        }
        if operation == "select" {
            let selected = integer_mask(&arguments[0], bits, span, name)?;
            let when_true = integer_vector(&arguments[1], bits, span, name)?;
            let when_false = integer_vector(&arguments[2], bits, span, name)?;
            let lanes = selected
                .iter()
                .enumerate()
                .map(|(index, lane)| {
                    if *lane {
                        when_true[index]
                    } else {
                        when_false[index]
                    }
                })
                .collect();
            return Ok(Value::IntegerVector { bits, lanes });
        }
        if operation == "not" {
            let lanes = integer_vector(&arguments[0], bits, span, name)?
                .iter()
                .map(|lane| wrap_i64(!i64::from(*lane), bits))
                .collect();
            return Ok(Value::IntegerVector { bits, lanes });
        }
        if matches!(operation, "shl" | "shr_s" | "shr_u") {
            let lanes = integer_vector(&arguments[0], bits, span, name)?;
            let shift =
                integer(&arguments[1], span, name)?.to_u32().unwrap_or(0) & (u32::from(bits) - 1);
            let lanes = lanes
                .iter()
                .map(|lane| match operation {
                    "shl" => wrap_i64(i64::from(*lane) << shift, bits),
                    "shr_s" => wrap_i64(i64::from(*lane) >> shift, bits),
                    "shr_u" => wrap_i64(i64::from(unsigned_lane(*lane, bits) >> shift), bits),
                    _ => unreachable!(),
                })
                .collect();
            return Ok(Value::IntegerVector { bits, lanes });
        }
        let left = integer_vector(&arguments[0], bits, span, name)?;
        let right = integer_vector(&arguments[1], bits, span, name)?;
        if matches!(
            operation,
            "eq" | "ne" | "lt_s" | "lt_u" | "gt_s" | "gt_u" | "le_s" | "le_u" | "ge_s" | "ge_u"
        ) {
            let lanes = left
                .iter()
                .zip(right)
                .map(|(left, right)| match operation {
                    "eq" => left == right,
                    "ne" => left != right,
                    "lt_s" => left < right,
                    "lt_u" => unsigned_lane(*left, bits) < unsigned_lane(*right, bits),
                    "gt_s" => left > right,
                    "gt_u" => unsigned_lane(*left, bits) > unsigned_lane(*right, bits),
                    "le_s" => left <= right,
                    "le_u" => unsigned_lane(*left, bits) <= unsigned_lane(*right, bits),
                    "ge_s" => left >= right,
                    "ge_u" => unsigned_lane(*left, bits) >= unsigned_lane(*right, bits),
                    _ => unreachable!(),
                })
                .collect();
            return Ok(Value::IntegerVectorMask { bits, lanes });
        }
        if !matches!(
            operation,
            "add" | "sub" | "mul" | "and" | "or" | "xor" | "min_s" | "min_u" | "max_s" | "max_u"
        ) {
            return Err(Diagnostic::new(
                "BLOT_UNKNOWN_PRIMITIVE",
                format!("`{name}` is not implemented by the Rust middle."),
                span,
            ));
        }
        let lanes = left
            .iter()
            .zip(right)
            .map(|(left, right)| {
                let lane = match operation {
                    "add" => i64::from(*left) + i64::from(*right),
                    "sub" => i64::from(*left) - i64::from(*right),
                    "mul" => i64::from(*left) * i64::from(*right),
                    "and" => i64::from(*left & *right),
                    "or" => i64::from(*left | *right),
                    "xor" => i64::from(*left ^ *right),
                    "min_s" => i64::from((*left).min(*right)),
                    "max_s" => i64::from((*left).max(*right)),
                    "min_u" => i64::from(
                        if unsigned_lane(*left, bits) < unsigned_lane(*right, bits) {
                            *left
                        } else {
                            *right
                        },
                    ),
                    "max_u" => i64::from(
                        if unsigned_lane(*left, bits) > unsigned_lane(*right, bits) {
                            *left
                        } else {
                            *right
                        },
                    ),
                    _ => unreachable!(),
                };
                wrap_i64(lane, bits)
            })
            .collect();
        Ok(Value::IntegerVector { bits, lanes })
    })();
    Some(result)
}

fn integer_vector<'a>(
    value: &'a Value,
    bits: u8,
    span: Span,
    operation: &str,
) -> Result<&'a [i32], Diagnostic> {
    if let Value::IntegerVector { bits: found, lanes } = value
        && *found == bits
    {
        return Ok(lanes);
    }
    Err(type_error(
        operation,
        "the matching integer vector",
        value,
        span,
    ))
}

fn integer_mask<'a>(
    value: &'a Value,
    bits: u8,
    span: Span,
    operation: &str,
) -> Result<&'a [bool], Diagnostic> {
    if let Value::IntegerVectorMask { bits: found, lanes } = value
        && *found == bits
    {
        return Ok(lanes);
    }
    Err(type_error(
        operation,
        "the matching integer vector mask",
        value,
        span,
    ))
}

fn wrap_lane(value: &BigInt, bits: u8) -> i32 {
    let modulus = BigInt::from(1_u8) << usize::from(bits);
    let sign = &modulus >> 1_usize;
    let mut wrapped = value % &modulus;
    if wrapped.sign() == num_bigint::Sign::Minus {
        wrapped += &modulus;
    }
    if wrapped >= sign {
        wrapped -= modulus;
    }
    wrapped.to_i32().expect("lane is within signed i32")
}

fn wrap_i64(value: i64, bits: u8) -> i32 {
    if bits == 32 {
        return value as i32;
    }
    let shift = 32 - u32::from(bits);
    ((value as i32) << shift) >> shift
}

fn unsigned_lane(value: i32, bits: u8) -> u32 {
    if bits == 32 {
        return value as u32;
    }
    (value as u32) & ((1_u32 << bits) - 1)
}

fn type_error(what: &str, expected: &str, value: &Value, span: Span) -> Diagnostic {
    Diagnostic::new(
        "BLOT_TYPE",
        format!("{what} expects {expected}, found {}.", show(value)),
        span,
    )
}

fn integer<'a>(value: &'a Value, span: Span, what: &str) -> Result<&'a BigInt, Diagnostic> {
    match value {
        Value::Int(value) => Ok(value),
        _ => Err(type_error(what, "an integer", value, span)),
    }
}

fn float(value: &Value, span: Span, what: &str) -> Result<f64, Diagnostic> {
    match value {
        Value::Float(value) => Ok(*value),
        _ => Err(type_error(what, "a float", value, span)),
    }
}

fn float32(value: &Value, span: Span, what: &str) -> Result<f32, Diagnostic> {
    match value {
        Value::Float32(value) => Ok(*value),
        _ => Err(type_error(what, "an F32", value, span)),
    }
}

fn text<'a>(value: &'a Value, span: Span, what: &str) -> Result<&'a str, Diagnostic> {
    match value {
        Value::Text(value) => Ok(value),
        _ => Err(type_error(what, "text", value, span)),
    }
}

fn text_index(value: &Value, span: Span, primitive: &str) -> Result<usize, Diagnostic> {
    integer(value, span, primitive)?
        .to_usize()
        .ok_or_else(|| text_bounds_error(primitive, span))
}

fn text_bounds_error(primitive: &str, span: Span) -> Diagnostic {
    Diagnostic::new(
        "BLOT_TEXT_BOUNDS",
        format!("`{primitive}` received invalid Unicode scalar bounds."),
        span,
    )
}

fn shape<'a>(value: &'a Value, span: Span, what: &str) -> Result<&'a OrderedFields, Diagnostic> {
    match value {
        Value::Shape(fields) => Ok(fields),
        _ => Err(type_error(what, "a shape", value, span)),
    }
}

fn array<'a>(value: &'a Value, span: Span, what: &str) -> Result<&'a [Value], Diagnostic> {
    match value {
        Value::Array(values) => Ok(values),
        Value::EmptyArray { .. } => Ok(&[]),
        _ => Err(type_error(what, "an array", value, span)),
    }
}

fn region(
    value: &Value,
    span: Span,
    what: &str,
) -> Result<(crate::value::RegionStore, usize, usize), Diagnostic> {
    match value {
        Value::Region { store, start, end } => Ok((store.clone(), *start, *end)),
        _ => Err(type_error(what, "an owned Region", value, span)),
    }
}

fn vector(value: &Value, span: Span, what: &str) -> Result<[f32; 4], Diagnostic> {
    match value {
        Value::Vector(lanes) => Ok(*lanes),
        _ => Err(type_error(what, "an F32x4", value, span)),
    }
}

fn vector_mask(value: &Value, span: Span, what: &str) -> Result<[bool; 4], Diagnostic> {
    match value {
        Value::VectorMask(lanes) => Ok(*lanes),
        _ => Err(type_error(what, "an F32x4Mask", value, span)),
    }
}

fn index(value: &Value, span: Span, what: &str) -> Result<usize, Diagnostic> {
    integer(value, span, what)?.to_usize().ok_or_else(|| {
        Diagnostic::new(
            "BLOT_OUT_OF_BOUNDS",
            format!(
                "{what} index {} is not a non-negative machine index.",
                show(value)
            ),
            span,
        )
    })
}

fn region_index(
    value: &Value,
    length: usize,
    span: Span,
    what: &str,
) -> Result<Option<usize>, Diagnostic> {
    let index = integer(value, span, what)?;
    let Some(index) = index.to_usize() else {
        return Ok(None);
    };
    Ok((index < length).then_some(index))
}

fn region_split_offset(
    value: &Value,
    length: usize,
    span: Span,
    what: &str,
) -> Result<Option<usize>, Diagnostic> {
    let index = integer(value, span, what)?;
    let Some(index) = index.to_usize() else {
        return Ok(None);
    };
    Ok((index <= length).then_some(index))
}

fn out_of_bounds(index: usize, length: usize, span: Span) -> Diagnostic {
    Diagnostic::new(
        "BLOT_OUT_OF_BOUNDS",
        format!("Index {index} is outside an array of {length}."),
        span,
    )
}

fn integer_result(
    value: BigInt,
    span: Span,
    phase: Phase,
    operation: &str,
) -> Result<Value, Diagnostic> {
    let low = -(BigInt::from(1_u64) << 63_usize);
    let high = (BigInt::from(1_u64) << 63_usize) - 1;
    if phase == Phase::Runtime && (value < low || value > high) {
        return Err(Diagnostic::new(
            "BLOT_INTEGER_OVERFLOW",
            format!("{operation} produced {value}, outside signed i64."),
            span,
        ));
    }
    Ok(Value::Int(value))
}

fn integer_binary(
    arguments: Vec<Value>,
    span: Span,
    phase: Phase,
    operation: &str,
    apply: impl FnOnce(BigInt, BigInt) -> BigInt,
) -> Result<Value, Diagnostic> {
    integer_result(
        apply(
            integer(&arguments[0], span, operation)?.clone(),
            integer(&arguments[1], span, operation)?.clone(),
        ),
        span,
        phase,
        operation,
    )
}

fn integer_divide(
    arguments: Vec<Value>,
    span: Span,
    phase: Phase,
    remainder: bool,
) -> Result<Value, Diagnostic> {
    let divisor = integer(
        &arguments[1],
        span,
        if remainder { "@int.rem" } else { "@int.div" },
    )?;
    if divisor.is_zero() {
        return Err(Diagnostic::new(
            "BLOT_DIVIDE_BY_ZERO",
            if remainder {
                "Remainder by zero."
            } else {
                "Division by zero."
            },
            span,
        ));
    }
    let dividend = integer(
        &arguments[0],
        span,
        if remainder { "@int.rem" } else { "@int.div" },
    )?;
    let result = if remainder {
        dividend % divisor
    } else {
        dividend / divisor
    };
    integer_result(
        result,
        span,
        phase,
        if remainder { "@int.rem" } else { "@int.div" },
    )
}

fn ordering(ordering: std::cmp::Ordering) -> Value {
    Value::Tag {
        name: match ordering {
            std::cmp::Ordering::Less => "Less",
            std::cmp::Ordering::Equal => "Equal",
            std::cmp::Ordering::Greater => "Greater",
        }
        .to_owned(),
        payload: None,
    }
}

fn float_ordering(left: f64, right: f64, span: Span, operation: &str) -> Result<Value, Diagnostic> {
    if left.is_nan() || right.is_nan() {
        return Err(Diagnostic::new(
            "BLOT_UNORDERED",
            format!("{operation} cannot order NaN. Test for it before comparing."),
            span,
        ));
    }
    Ok(if left < right {
        ordering(std::cmp::Ordering::Less)
    } else if left > right {
        ordering(std::cmp::Ordering::Greater)
    } else {
        ordering(std::cmp::Ordering::Equal)
    })
}

fn float_binary(
    arguments: Vec<Value>,
    span: Span,
    operation: &str,
    apply: impl FnOnce(f64, f64) -> f64,
) -> Result<Value, Diagnostic> {
    Ok(Value::Float(apply(
        float(&arguments[0], span, operation)?,
        float(&arguments[1], span, operation)?,
    )))
}

fn float32_binary(
    arguments: Vec<Value>,
    span: Span,
    operation: &str,
    apply: impl FnOnce(f32, f32) -> f32,
) -> Result<Value, Diagnostic> {
    Ok(Value::Float32(apply(
        float32(&arguments[0], span, operation)?,
        float32(&arguments[1], span, operation)?,
    )))
}

fn vector_binary(
    arguments: Vec<Value>,
    span: Span,
    operation: &str,
    apply: impl Fn(f32, f32) -> f32,
) -> Result<Value, Diagnostic> {
    let left = vector(&arguments[0], span, operation)?;
    let right = vector(&arguments[1], span, operation)?;
    Ok(Value::Vector(std::array::from_fn(|index| {
        apply(left[index], right[index])
    })))
}

fn vector_compare(
    arguments: Vec<Value>,
    span: Span,
    operation: &str,
    apply: impl Fn(f32, f32) -> bool,
) -> Result<Value, Diagnostic> {
    let left = vector(&arguments[0], span, operation)?;
    let right = vector(&arguments[1], span, operation)?;
    Ok(Value::VectorMask(std::array::from_fn(|index| {
        apply(left[index], right[index])
    })))
}

fn vector_select(arguments: Vec<Value>, span: Span) -> Result<Value, Diagnostic> {
    let mask = vector_mask(&arguments[0], span, "@f32x4.select")?;
    let when_true = vector(&arguments[1], span, "@f32x4.select")?;
    let when_false = vector(&arguments[2], span, "@f32x4.select")?;
    Ok(Value::Vector(std::array::from_fn(|index| {
        if mask[index] {
            when_true[index]
        } else {
            when_false[index]
        }
    })))
}

fn vector_lane(
    value: &Value,
    lane: usize,
    span: Span,
    operation: &str,
) -> Result<Value, Diagnostic> {
    Ok(Value::Float32(vector(value, span, operation)?[lane]))
}

fn vector_shuffle(arguments: Vec<Value>, span: Span) -> Result<Value, Diagnostic> {
    let left = vector(&arguments[0], span, "@f32x4.shuffle")?;
    let right = vector(&arguments[1], span, "@f32x4.shuffle")?;
    let lanes = [
        left[0], left[1], left[2], left[3], right[0], right[1], right[2], right[3],
    ];
    let mut selected = [0.0_f32; 4];
    for index in 0..4 {
        let lane = integer(&arguments[index + 2], span, "@f32x4.shuffle")?
            .to_usize()
            .filter(|lane| *lane < lanes.len())
            .ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_TYPE",
                    format!(
                        "@f32x4.shuffle expects lane selectors within 0..7, found {}.",
                        show(&arguments[index + 2])
                    ),
                    span,
                )
            })?;
        selected[index] = lanes[lane];
    }
    Ok(Value::Vector(selected))
}

fn union(left: Value, right: Value) -> Value {
    let mut members = Vec::new();
    fn add(members: &mut Vec<Value>, value: Value) {
        if let Value::Extended { inner, .. } = value {
            add(members, *inner);
            return;
        }
        if let Value::Union(nested) = value {
            for value in nested {
                add(members, value);
            }
        } else if !members.iter().any(|member| equal(member, &value)) {
            members.push(value);
        }
    }
    add(&mut members, left);
    add(&mut members, right);
    if members.len() == 1 {
        members.remove(0)
    } else {
        Value::Union(members)
    }
}

fn intersect(left: &Value, right: &Value, span: Span) -> Result<Value, Diagnostic> {
    let left = transparent_type(left);
    let right = transparent_type(right);
    let left = match left {
        Value::Union(values) => values.clone(),
        value => vec![value.clone()],
    };
    let right = match right {
        Value::Union(values) => values.clone(),
        value => vec![value.clone()],
    };
    let mut kept = Vec::new();
    for left in left {
        for right in &right {
            let overlap = if equal(&left, right)
                || matches!(right, Value::Range { .. }) && inhabits(&left, right)
            {
                Some(left.clone())
            } else if matches!(left, Value::Range { .. }) && inhabits(right, &left) {
                Some(right.clone())
            } else {
                None
            };
            if let Some(value) = overlap
                && !kept.iter().any(|seen| equal(seen, &value))
            {
                kept.push(value);
            }
        }
    }
    let Some(first) = kept.first().cloned() else {
        return Err(Diagnostic::new(
            "BLOT_EMPTY_TYPE",
            "The intersection is empty.",
            span,
        ));
    };
    Ok(kept.into_iter().skip(1).fold(first, union))
}

fn difference(left: &Value, right: &Value, span: Span) -> Result<Value, Diagnostic> {
    let left = transparent_type(left);
    let right = transparent_type(right);
    if equal(left, right) {
        return Err(Diagnostic::new(
            "BLOT_EMPTY_TYPE",
            "The difference is empty.",
            span,
        ));
    }
    if let Value::Union(values) = left {
        let kept: Vec<Value> = values
            .iter()
            .filter(|value| !equal(value, right))
            .cloned()
            .collect();
        let Some(first) = kept.first().cloned() else {
            return Err(Diagnostic::new(
                "BLOT_EMPTY_TYPE",
                "The difference is empty.",
                span,
            ));
        };
        return Ok(kept.into_iter().skip(1).fold(first, union));
    }
    if let (Value::Range { low, high, domain }, Value::Int(point)) = (left, right)
        && inhabits(right, left)
    {
        let mut pieces = Vec::new();
        let below = Value::Int(point - 1);
        let above = Value::Int(point + 1);
        if matches!(**low, Value::Unbounded)
            || compare(&below, low).is_some_and(|order| order != std::cmp::Ordering::Less)
        {
            pieces.push(Value::Range {
                low: low.clone(),
                high: Box::new(below),
                domain: *domain,
            });
        }
        if matches!(**high, Value::Unbounded)
            || compare(&above, high).is_some_and(|order| order != std::cmp::Ordering::Greater)
        {
            pieces.push(Value::Range {
                low: Box::new(above),
                high: high.clone(),
                domain: *domain,
            });
        }
        let Some(first) = pieces.first().cloned() else {
            return Err(Diagnostic::new(
                "BLOT_EMPTY_TYPE",
                "The difference is empty.",
                span,
            ));
        };
        return Ok(pieces.into_iter().skip(1).fold(first, union));
    }
    Ok(left.clone())
}

fn transparent_type(mut value: &Value) -> &Value {
    while let Value::Extended { inner, .. } = value {
        value = inner;
    }
    value
}

fn compare(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::Int(left), Value::Int(right)) => Some(left.cmp(right)),
        (Value::Text(left), Value::Text(right)) => Some(left.chars().cmp(right.chars())),
        _ => None,
    }
}

fn inhabits(value: &Value, type_: &Value) -> bool {
    match type_ {
        Value::Extended { inner, .. } => inhabits(value, inner),
        Value::Unbounded => true,
        Value::Union(members) => members.iter().any(|member| inhabits(value, member)),
        Value::OpaqueType(name) if name == F32X4 => matches!(value, Value::Vector(_)),
        Value::OpaqueType(name) if name == F32X4_MASK => matches!(value, Value::VectorMask(_)),
        Value::OpaqueType(name) if name == I32X4 => {
            matches!(value, Value::IntegerVector { bits: 32, lanes } if lanes.len() == 4)
        }
        Value::OpaqueType(name) if name == I32X4_MASK => {
            matches!(value, Value::IntegerVectorMask { bits: 32, lanes } if lanes.len() == 4)
        }
        Value::OpaqueType(name) if name == I16X8 => {
            matches!(value, Value::IntegerVector { bits: 16, lanes } if lanes.len() == 8)
        }
        Value::OpaqueType(name) if name == I16X8_MASK => {
            matches!(value, Value::IntegerVectorMask { bits: 16, lanes } if lanes.len() == 8)
        }
        Value::OpaqueType(name) if name == I8X16 => {
            matches!(value, Value::IntegerVector { bits: 8, lanes } if lanes.len() == 16)
        }
        Value::OpaqueType(name) if name == I8X16_MASK => {
            matches!(value, Value::IntegerVectorMask { bits: 8, lanes } if lanes.len() == 16)
        }
        Value::Range { low, high, .. } => {
            let above = matches!(**low, Value::Unbounded)
                || compare(value, low).is_some_and(|order| order != std::cmp::Ordering::Less);
            let below = matches!(**high, Value::Unbounded)
                || compare(value, high).is_some_and(|order| order != std::cmp::Ordering::Greater);
            above && below
        }
        Value::Shape(required) => {
            let Value::Shape(fields) = value else {
                return false;
            };
            required
                .iter()
                .all(|(name, type_)| fields.get(name).is_some_and(|value| inhabits(value, type_)))
        }
        Value::Array(types) => {
            let values = match value {
                Value::Array(values) => values.as_slice(),
                Value::EmptyArray { .. } => &[],
                _ => return false,
            };
            values
                .iter()
                .all(|value| types.iter().any(|type_| inhabits(value, type_)))
        }
        Value::Tag { name, payload } => {
            let Value::Tag {
                name: value_name,
                payload: value_payload,
            } = value
            else {
                return false;
            };
            name == value_name
                && match (payload, value_payload) {
                    (None, None) => true,
                    (Some(type_), Some(value)) => inhabits(value, type_),
                    _ => false,
                }
        }
        _ => equal(value, type_),
    }
}

fn type_of(value: &Value) -> Value {
    if let Some(signature) = closure_signature(value) {
        return signature;
    }
    match value {
        Value::Extended { inner, .. } => type_of(inner),
        Value::Shape(fields) => Value::Shape(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), type_of(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(type_of).collect()),
        Value::EmptyArray { element } => Value::Array(vec![(**element).clone()]),
        Value::Tag {
            name,
            payload: Some(payload),
        } => Value::Tag {
            name: name.clone(),
            payload: Some(Box::new(type_of(payload))),
        },
        value => value.clone(),
    }
}

fn reflect(value: &Value) -> Value {
    let tagged = |name: &str, payload: Value| Value::Tag {
        name: name.to_owned(),
        payload: Some(Box::new(payload)),
    };
    let bare = |name: &str| Value::Tag {
        name: name.to_owned(),
        payload: None,
    };
    match value {
        Value::Extended { inner, .. } => reflect(inner),
        Value::Int(_) => tagged("Int", value.clone()),
        Value::Text(_) => tagged("Text", value.clone()),
        Value::Unit => bare("Unit"),
        Value::Unbounded => bare("Unbounded"),
        Value::Tag { name, payload } => tagged(
            "Tag",
            Value::Shape(OrderedFields::from([
                ("name".to_owned(), Value::Text(name.clone())),
                (
                    "payload".to_owned(),
                    match payload {
                        Some(payload) => tagged("Some", (**payload).clone()),
                        None => bare("None"),
                    },
                ),
            ])),
        ),
        Value::Range { low, high, domain } => tagged(
            "Range",
            Value::Shape(OrderedFields::from([
                ("low".to_owned(), (**low).clone()),
                ("high".to_owned(), (**high).clone()),
                (
                    "domain".to_owned(),
                    bare(match domain.unwrap_or(Domain::Int) {
                        Domain::Int => "Int",
                        Domain::Text => "Text",
                        Domain::Float => "F64",
                        Domain::Float32 => "F32",
                    }),
                ),
            ])),
        ),
        Value::Union(members) => tagged("Union", Value::Array(members.clone())),
        Value::Shape(_) => tagged("Shape", value.clone()),
        Value::Array(_) | Value::EmptyArray { .. } => tagged("Array", value.clone()),
        Value::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => {
            let mut reflected_effects = effects.clone();
            if let Some(tail) = effect_tail {
                reflected_effects.push(Value::TypeVariable(*tail));
            }
            tagged(
                "Arrow",
                Value::Shape(OrderedFields::from([
                    (
                        "deferred".to_owned(),
                        bare(if *deferred { "True" } else { "False" }),
                    ),
                    ("domain".to_owned(), (**domain).clone()),
                    ("codomain".to_owned(), (**codomain).clone()),
                    ("effects".to_owned(), Value::Array(reflected_effects)),
                ])),
            )
        }
        Value::Forall { .. } => bare("Forall"),
        Value::Sealed { name, inner } => tagged(
            "Sealed",
            Value::Shape(OrderedFields::from([
                ("name".to_owned(), Value::Text(name.clone())),
                ("inner".to_owned(), (**inner).clone()),
            ])),
        ),
        _ => bare("Opaque"),
    }
}

fn performs(arrow: &Value, effects: &Value, span: Span) -> Result<Value, Diagnostic> {
    let Value::Array(members) = effects else {
        return Err(type_error("~", "an effect row", effects, span));
    };
    if !matches!(arrow, Value::Arrow { .. }) {
        return Err(type_error("~", "a function type", arrow, span));
    }

    let mut row = Vec::new();
    let mut tail = None;
    for (index, effect) in members.iter().enumerate() {
        if let Value::TypeVariable(id) = effect {
            if tail.is_some() || index + 1 != members.len() {
                return Err(Diagnostic::new(
                    "BLOT_TYPE",
                    "An effect-row tail is written once and must be the final row member.",
                    span,
                ));
            }
            tail = Some(*id);
            continue;
        }
        if !matches!(effect, Value::Effect { .. }) {
            return Err(type_error("~", "effects", effect, span));
        }
        if !row.iter().any(|seen| crate::value::equal(seen, effect)) {
            row.push(effect.clone());
        }
    }

    if let Some(attached) = attach_effects(arrow, &row, tail) {
        return Ok(attached);
    }
    Err(Diagnostic::new(
        "BLOT_TYPE",
        "Every arrow already has an effect row.",
        span,
    ))
}

fn attach_effects(arrow: &Value, effects: &[Value], tail: Option<u32>) -> Option<Value> {
    let Value::Arrow {
        deferred,
        domain,
        codomain,
        effects: existing,
        effect_tail: existing_tail,
    } = arrow
    else {
        return None;
    };
    if let Some(codomain) = attach_effects(codomain, effects, tail) {
        return Some(Value::Arrow {
            deferred: *deferred,
            domain: domain.clone(),
            codomain: Box::new(codomain),
            effects: existing.clone(),
            effect_tail: *existing_tail,
        });
    }
    if !existing.is_empty() || existing_tail.is_some() {
        return None;
    }
    Some(Value::Arrow {
        deferred: *deferred,
        domain: domain.clone(),
        codomain: codomain.clone(),
        effects: effects.to_vec(),
        effect_tail: tail,
    })
}

fn attach(arguments: Vec<Value>, span: Span) -> Result<Value, Diagnostic> {
    let key = text(&arguments[1], span, "@type.attach")?.to_owned();
    let (inner, mut members) = match arguments[0].clone() {
        Value::Extended { inner, members } => (inner, members),
        value => (Box::new(value), OrderedFields::default()),
    };
    if members.contains_key(&key) {
        return Err(Diagnostic::new(
            "BLOT_DUPLICATE_MEMBER",
            format!("`{key}` is already a member."),
            span,
        ));
    }
    members.insert(key, arguments[2].clone());
    Ok(Value::Extended { inner, members })
}

fn cancel(value: &Value, span: Span) -> Result<Value, Diagnostic> {
    let Value::Continuation { used, resume } = value else {
        return Err(type_error(
            "Continuation.cancel",
            "a continuation",
            value,
            span,
        ));
    };
    if *used.borrow() {
        return Err(Diagnostic::new(
            "BLOT_RESUME_TWICE",
            "This continuation has already been resumed or cancelled.",
            span,
        ));
    }
    *used.borrow_mut() = true;
    resume.borrow_mut().take();
    Ok(Value::Unit)
}

fn take(arguments: Vec<Value>, span: Span) -> Result<Value, Diagnostic> {
    let values = array(&arguments[0], span, "@array.take")?;
    let index = index(&arguments[1], span, "@array.take")?;
    let Some(value) = values.get(index).cloned() else {
        return Err(out_of_bounds(index, values.len(), span));
    };
    let remaining = values
        .iter()
        .enumerate()
        .filter(|(candidate, _)| *candidate != index)
        .map(|(_, value)| value.clone())
        .collect();
    Ok(tuple(vec![value, Value::Array(remaining)]))
}

fn split(arguments: Vec<Value>, span: Span) -> Result<Value, Diagnostic> {
    let values = array(&arguments[0], span, "@array.split")?;
    let index = index(&arguments[1], span, "@array.split")?;
    let Some(value) = values.get(index).cloned() else {
        return Err(out_of_bounds(index, values.len(), span));
    };
    Ok(tuple(vec![
        Value::Array(values[..index].to_vec()),
        value,
        Value::Array(values[index + 1..].to_vec()),
    ]))
}

fn parse_json(arguments: Vec<Value>, span: Span, phase: Phase) -> Result<Value, Diagnostic> {
    if phase != Phase::Comptime {
        return Err(Diagnostic::new(
            "BLOT_JSON_NOT_COMPTIME",
            "`@json.parse` can only be evaluated at compile time.",
            span,
        ));
    }
    let Value::Tag {
        name: mode,
        payload: None,
    } = &arguments[0]
    else {
        return Err(type_error(
            "@json.parse",
            "#Widen or #Exact",
            &arguments[0],
            span,
        ));
    };
    if mode != "Widen" && mode != "Exact" {
        return Err(type_error(
            "@json.parse",
            "#Widen or #Exact",
            &arguments[0],
            span,
        ));
    }
    let source = shape(&arguments[1], span, "@json.parse")?;
    let source_text = source.get("text").ok_or_else(|| {
        Diagnostic::new(
            "BLOT_TYPE",
            "`@json.parse` source has no `.text` field.",
            span,
        )
    })?;
    let json = text(source_text, span, "@json.parse")?;
    let parsed: serde_json::Value = serde_json::from_str(json).map_err(|error| {
        Diagnostic::new("BLOT_JSON_PARSE", format!("Invalid JSON: {error}."), span)
    })?;
    json_to_value(parsed, span)
}

fn json_to_value(value: serde_json::Value, span: Span) -> Result<Value, Diagnostic> {
    match value {
        serde_json::Value::Null => Ok(Value::Unit),
        serde_json::Value::Bool(value) => Ok(boolean(value)),
        serde_json::Value::String(value) => Ok(Value::Text(value)),
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(|value| json_to_value(value, span))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        serde_json::Value::Object(fields) => fields
            .into_iter()
            .map(|(name, value)| json_to_value(value, span).map(|value| (name, value)))
            .collect::<Result<OrderedFields, _>>()
            .map(Value::Shape),
        serde_json::Value::Number(number) => {
            let spelling = number.to_string();
            if !spelling.contains('.') && !spelling.contains('e') && !spelling.contains('E') {
                let value = spelling.parse::<BigInt>().map_err(|error| {
                    Diagnostic::new(
                        "BLOT_JSON_NUMBER",
                        format!("JSON integer {spelling} is not representable: {error}."),
                        span,
                    )
                })?;
                return Ok(Value::Int(value));
            }
            let value = number.as_f64().ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_JSON_NUMBER",
                    format!("JSON number {spelling} is not a finite F64."),
                    span,
                )
            })?;
            Ok(Value::Float(value))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_ordering_refuses_nan() {
        for operation in ["@float.cmp", "@f32.cmp"] {
            let error = float_ordering(f64::NAN, 0.0, Span { start: 1, end: 2 }, operation)
                .expect_err("NaN has no ordering");
            assert_eq!(error.code, "BLOT_UNORDERED");
            assert!(error.message.starts_with(operation));
        }
    }

    #[test]
    fn scalar_float32_primitives_round_at_the_operation() {
        let span = Span { start: 1, end: 2 };
        let converted = run_primitive(
            "@f32.of_int",
            vec![Value::Int(BigInt::from(16_777_217))],
            span,
            Phase::Comptime,
        )
        .expect("integer converts to F32");
        assert!(matches!(converted, Value::Float32(value) if value == 16_777_216.0));

        let root = run_primitive(
            "@f32.sqrt",
            vec![Value::Float32(9.0)],
            span,
            Phase::Comptime,
        )
        .expect("F32 square root evaluates");
        assert!(matches!(root, Value::Float32(value) if value == 3.0));
    }

    #[test]
    fn scratch_tracks_initialized_prefix_and_geometric_capacity() {
        let span = Span { start: 1, end: 2 };
        let mut scratch = run_primitive(
            "@scratch.with_capacity",
            vec![Value::Int(BigInt::from(1))],
            span,
            Phase::Comptime,
        )
        .expect("Scratch capacity is valid");
        for value in [1, 2, 3] {
            scratch = run_primitive(
                "@scratch.push",
                vec![scratch, Value::Int(BigInt::from(value))],
                span,
                Phase::Comptime,
            )
            .expect("Scratch push succeeds");
        }
        assert!(matches!(
            &scratch,
            Value::Scratch { values, capacity }
                if values.len() == 3 && *capacity == 4
        ));
        let finished = run_primitive("@scratch.finish", vec![scratch], span, Phase::Comptime)
            .expect("Scratch finish succeeds");
        assert!(matches!(&finished, Value::Array(values) if values.len() == 3));
        let recycled = run_primitive("@scratch.recycle", vec![finished], span, Phase::Comptime)
            .expect("Array recycle succeeds");
        assert!(matches!(
            recycled,
            Value::Scratch { values, capacity }
                if values.is_empty() && capacity == 3
        ));
    }
}
