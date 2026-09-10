use super::*;

pub(super) fn validate_tables(graph: &Graph, module: &Tables<'_>) -> Result<(), String> {
    let require_type = |id: usize| {
        if id < module.types.len() {
            Ok(())
        } else {
            Err(format!("absent representation {id}"))
        }
    };
    for (index, representation) in module.types.iter().enumerate() {
        match representation {
            RuntimeType::Resource { payload_type, .. } => require_type(*payload_type)?,
            RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } => {
                require_type(*element_type)?
            }
            RuntimeType::Indirect { target_type } => require_type(*target_type)?,
            RuntimeType::Sealed {
                representation_type,
                ..
            } => require_type(*representation_type)?,
            RuntimeType::Product { fields, .. } => {
                let mut names = BTreeSet::new();
                for field in fields {
                    require_type(field.type_id)?;
                    if !names.insert(&field.name) {
                        return Err(format!("product {index} repeats a field"));
                    }
                }
            }
            RuntimeType::Sum { cases, .. } => {
                let mut names = BTreeSet::new();
                for case in cases {
                    require_type(case.payload_type)?;
                    if !names.insert(&case.name) {
                        return Err(format!("sum {index} repeats a case"));
                    }
                }
            }
            RuntimeType::Callback {
                function,
                signature,
                environment_type,
            } => {
                require_type(*environment_type)?;
                let target = graph
                    .functions
                    .get(*function)
                    .ok_or("callback has an absent function")?;
                if target.signature.0 != *signature {
                    return Err("callback changed its function signature".to_owned());
                }
                let contract = module
                    .signatures
                    .get(*signature)
                    .ok_or("callback has an absent signature")?;
                let RuntimeType::Product { fields, .. } = &module.types[*environment_type] else {
                    return Err("callback environment is not a product".to_owned());
                };
                if contract.parameters.is_empty()
                    || fields.iter().map(|field| field.type_id).ne(contract
                        .parameters
                        .iter()
                        .skip(1)
                        .copied())
                {
                    return Err(
                        "callback environment disagrees with its captured parameters".to_owned(),
                    );
                }
                if !target.framed {
                    return Err("callback function has no frame".to_owned());
                }
            }
            _ => {}
        }
    }
    for signature in module.signatures {
        for type_id in signature
            .parameters
            .iter()
            .chain(std::iter::once(&signature.result))
        {
            require_type(*type_id)?;
        }
    }
    for store in module.static_stores {
        require_type(store.element_type)?;
        if !store
            .values
            .iter()
            .all(|value| constant_matches(value, &module.types[store.element_type]))
        {
            return Err("static Store constant disagrees with its element type".to_owned());
        }
    }
    Ok(())
}

pub(super) fn validate_instruction(
    instruction: &Instruction,
    available: &BTreeMap<ValueId, TypeId>,
    function: &Function,
    module: &Tables<'_>,
) -> Result<(), String> {
    let operands = instruction
        .operands
        .iter()
        .map(|value| available[value].0)
        .collect::<Vec<_>>();
    if instruction_matches(module, instruction, &operands, function) {
        Ok(())
    } else {
        Err(format!(
            "{} instruction value {} has incompatible operands or metadata: operator {:?}, result {:?}, operands {:?}, static Store {:?}",
            instruction.operation.kind,
            instruction.definition.value,
            instruction.operation.operator,
            module.types[instruction.definition.type_id.0],
            operands
                .iter()
                .map(|type_id| &module.types[*type_id])
                .collect::<Vec<_>>(),
            instruction.operation.static_store,
        ))
    }
}

pub(crate) fn constant_matches(value: &WireConstant, type_: &RuntimeType) -> bool {
    match (value, type_) {
        (WireConstant::Unit, RuntimeType::Unit)
        | (WireConstant::Boolean(_), RuntimeType::Boolean)
        | (WireConstant::SignedInteger32(_), RuntimeType::Integer32)
        | (WireConstant::Float32(_), RuntimeType::Float32)
        | (WireConstant::Float64(_), RuntimeType::Float64)
        | (WireConstant::Text(_), RuntimeType::Text) => true,
        (WireConstant::SignedInteger64(value), RuntimeType::SignedInteger64) => {
            value.parse::<i64>().is_ok()
        }
        _ => false,
    }
}

fn instruction_matches(
    module: &Tables<'_>,
    instruction: &crate::continuation::Instruction,
    operands: &[usize],
    function: &Function,
) -> bool {
    let operation = &instruction.operation;
    let result_id = instruction.definition.type_id.0;
    let result = &module.types[result_id];
    let types = operands
        .iter()
        .map(|id| &module.types[*id])
        .collect::<Vec<_>>();
    if operation.value.is_some() && operation.kind != "constant"
        || operation.case.is_some() && !matches!(operation.kind, "sum.make" | "sum.payload")
        || operation.field.is_some()
            && !matches!(operation.kind, "product.project" | "store.read.field")
        || operation.operator.is_some()
            && !matches!(operation.kind, "scalar" | "scalar.unary" | "vector")
        || operation.conversion.is_some() && operation.kind != "convert"
        || operation.update.is_some() && !matches!(operation.kind, "store.write" | "store.grow")
        || operation.static_store.is_some() && operation.kind != "store.literal"
        || operation.lane.is_some()
            && !(operation.kind == "vector"
                && matches!(operation.operator, Some("extract" | "replace")))
        || operation.function.is_some() && operation.kind != "callback.make"
        || operation.signature.is_some() && operation.kind != "callback.make"
    {
        return false;
    }
    match operation.kind {
        "constant" => {
            operands.is_empty()
                && operation
                    .value
                    .as_ref()
                    .is_some_and(|value| constant_matches(value, result))
        }
        "scalar" => {
            if operands.len() != 2
                || operands[0] != operands[1]
                || !matches!(
                    types[0],
                    RuntimeType::Integer32
                        | RuntimeType::SignedInteger64
                        | RuntimeType::Float32
                        | RuntimeType::Float64
                        | RuntimeType::Boolean
                )
            {
                return false;
            }
            match operation.operator {
                Some(
                    "equal"
                    | "not-equal"
                    | "less-than"
                    | "less-than-or-equal"
                    | "greater-than"
                    | "greater-than-or-equal",
                ) => *result == RuntimeType::Boolean,
                Some("add" | "subtract" | "multiply" | "divide" | "remainder") => {
                    result_id == operands[0] && *result != RuntimeType::Boolean
                }
                _ => false,
            }
        }
        "scalar.unary" => {
            operands.len() == 1
                && operands[0] == result_id
                && matches!(
                    (result, operation.operator),
                    (RuntimeType::Float32 | RuntimeType::Float64, Some("negate"))
                        | (RuntimeType::Float32, Some("square-root"))
                )
        }
        "convert" => {
            let [operand] = types.as_slice() else {
                return false;
            };
            let conversion = match (*operand, result) {
                (RuntimeType::Float32, RuntimeType::Float64) => "float-32-to-float-64",
                (RuntimeType::Float64, RuntimeType::Float32) => "float-64-to-float-32",
                (RuntimeType::Float64, RuntimeType::SignedInteger64) => {
                    "float-64-to-signed-integer-64"
                }
                (RuntimeType::Integer32, RuntimeType::SignedInteger64) => {
                    "signed-integer-32-to-signed-integer-64"
                }
                (RuntimeType::SignedInteger64, RuntimeType::Integer32) => {
                    "signed-integer-64-to-signed-integer-32"
                }
                (RuntimeType::SignedInteger64, RuntimeType::Float32) => {
                    "signed-integer-64-to-float-32"
                }
                (RuntimeType::SignedInteger64, RuntimeType::Float64) => {
                    "signed-integer-64-to-float-64"
                }
                _ => return false,
            };
            operation.conversion == Some(conversion)
        }
        "product.make" => {
            matches!(result, RuntimeType::Product { fields, .. } if fields.iter().map(|field| field.type_id).eq(operands.iter().copied()))
        }
        "product.project" => {
            matches!(types.as_slice(), [RuntimeType::Product { fields, .. }] if operation.field.and_then(|field| fields.get(field)).is_some_and(|field| field.type_id == result_id))
        }
        "sum.make" => {
            let RuntimeType::Sum { cases, .. } = result else {
                return false;
            };
            let Some(case) = operation.case.and_then(|case| cases.get(case)) else {
                return false;
            };
            operands == [case.payload_type]
        }
        "sum.tag" => {
            *result == RuntimeType::Integer32
                && matches!(types.as_slice(), [RuntimeType::Sum { .. }])
        }
        "sum.payload" => {
            matches!(types.as_slice(), [RuntimeType::Sum { cases, .. }] if operation.case.and_then(|case| cases.get(case)).is_some_and(|case| case.payload_type == result_id))
        }
        "indirect.make" => {
            matches!(result, RuntimeType::Indirect { target_type } if operands == [*target_type])
        }
        "indirect.load" => {
            matches!(types.as_slice(), [RuntimeType::Indirect { target_type }] if *target_type == result_id)
        }
        "store.empty" => operands.is_empty() && matches!(result, RuntimeType::Store { .. }),
        "store.literal" => {
            let RuntimeType::Store { element_type } = result else {
                return false;
            };
            if let Some(store) = operation.static_store {
                operands.is_empty()
                    && module
                        .static_stores
                        .get(store)
                        .is_some_and(|store| store.element_type == *element_type)
            } else {
                operands.iter().all(|type_id| type_id == element_type)
            }
        }
        "store.new" => {
            matches!(result, RuntimeType::Store { element_type } if operands.len() == 2 && *types[0] == RuntimeType::SignedInteger64 && operands[1] == *element_type)
        }
        "store.length" => {
            *result == RuntimeType::SignedInteger64
                && matches!(types.as_slice(), [RuntimeType::Store { .. }])
        }
        "store.read" => {
            matches!(types.as_slice(), [RuntimeType::Store { element_type }, RuntimeType::SignedInteger64] if *element_type == result_id)
        }
        "store.read.field" => {
            let [
                RuntimeType::Store { element_type },
                RuntimeType::SignedInteger64,
            ] = types.as_slice()
            else {
                return false;
            };
            matches!(&module.types[*element_type], RuntimeType::Product { fields, .. } if operation.field.and_then(|field| fields.get(field)).is_some_and(|field| field.type_id == result_id))
        }
        "store.write" | "store.grow" => {
            let RuntimeType::Store { element_type } = result else {
                return false;
            };
            if !matches!(operation.update, Some("owned-reuse" | "persistent")) {
                return false;
            }
            if operation.update == Some("owned-reuse")
                && instruction.definition.ownership != "owned"
            {
                return false;
            }
            if operation.kind == "store.grow" {
                operands == [result_id, *element_type]
            } else {
                operands.len() == 3
                    && operands[0] == result_id
                    && *types[1] == RuntimeType::SignedInteger64
                    && operands[2] == *element_type
            }
        }
        "scratch.with-capacity" => {
            matches!(result, RuntimeType::Scratch { .. })
                && matches!(types.as_slice(), [RuntimeType::SignedInteger64])
        }
        "scratch.push" => {
            matches!(result, RuntimeType::Scratch { element_type } if operands == [result_id, *element_type])
        }
        "scratch.finish" => {
            matches!((types.as_slice(), result), ([RuntimeType::Scratch { element_type: source }], RuntimeType::Store { element_type: target }) if source == target)
        }
        "scratch.recycle" => {
            matches!((types.as_slice(), result), ([RuntimeType::Store { element_type: source }], RuntimeType::Scratch { element_type: target }) if source == target)
        }
        "seal.wrap" => {
            matches!(result, RuntimeType::Sealed { representation_type, .. } if operands == [*representation_type])
        }
        "seal.unwrap" => {
            matches!(types.as_slice(), [RuntimeType::Sealed { representation_type, .. }] if *representation_type == result_id)
        }
        "callback.make" => {
            matches!(result, RuntimeType::Callback { function, signature, environment_type } if operands == [*environment_type] && operation.function == Some(FunctionId(*function)) && operation.signature.is_none_or(|actual| actual.0 == *signature))
        }
        "resource.move" | "resource.borrow" | "resource.freeze" => {
            matches!(result, RuntimeType::Resource { .. }) && operands == [result_id]
        }
        "vector" => vector_matches(module, instruction, operands, function),
        "text.append" => {
            *result == RuntimeType::Text
                && matches!(types.as_slice(), [RuntimeType::Text, RuntimeType::Text])
        }
        "text.join" => {
            *result == RuntimeType::Text
                && matches!(types.as_slice(), [RuntimeType::Store { element_type }] if module.types[*element_type] == RuntimeType::Text)
        }
        "text.length" => {
            *result == RuntimeType::SignedInteger64
                && matches!(types.as_slice(), [RuntimeType::Text])
        }
        "text.scalar-at" => {
            *result == RuntimeType::Text
                && matches!(
                    types.as_slice(),
                    [RuntimeType::Text, RuntimeType::SignedInteger64]
                )
        }
        "text.next-byte" => {
            if !matches!(
                types.as_slice(),
                [RuntimeType::Text, RuntimeType::SignedInteger64]
            ) {
                return false;
            }
            let RuntimeType::Sum { cases, .. } = result else {
                return false;
            };
            if cases.len() != 2
                || cases[0].name != "None"
                || cases[1].name != "Some"
                || module.types[cases[0].payload_type] != RuntimeType::Unit
            {
                return false;
            }
            matches!(&module.types[cases[1].payload_type], RuntimeType::Product { fields, .. } if fields.len() == 2 && fields[0].name == "0" && fields[1].name == "1" && module.types[fields[0].type_id] == RuntimeType::Text && module.types[fields[1].type_id] == RuntimeType::SignedInteger64)
        }
        "text.slice" => {
            *result == RuntimeType::Text
                && matches!(
                    types.as_slice(),
                    [
                        RuntimeType::Text,
                        RuntimeType::SignedInteger64,
                        RuntimeType::SignedInteger64
                    ]
                )
        }
        "text.find-from" => {
            *result == RuntimeType::SignedInteger64
                && matches!(
                    types.as_slice(),
                    [
                        RuntimeType::Text,
                        RuntimeType::Text,
                        RuntimeType::SignedInteger64
                    ]
                )
        }
        "text.compare" => {
            *result == RuntimeType::Integer32
                && matches!(types.as_slice(), [RuntimeType::Text, RuntimeType::Text])
        }
        "text.contains" => {
            *result == RuntimeType::Boolean
                && matches!(types.as_slice(), [RuntimeType::Text, RuntimeType::Text])
        }
        "text.from-i64" => {
            *result == RuntimeType::Text
                && matches!(types.as_slice(), [RuntimeType::SignedInteger64])
        }
        _ => false,
    }
}
fn vector_matches(
    module: &Tables<'_>,
    instruction: &Instruction,
    operands: &[usize],
    function: &Function,
) -> bool {
    let operation = &instruction.operation;
    let result = &module.types[instruction.definition.type_id.0];
    let types = operands
        .iter()
        .map(|id| &module.types[*id])
        .collect::<Vec<_>>();
    let shape = match result {
        RuntimeType::Vector { element, lanes } | RuntimeType::Mask { element, lanes } => {
            Some((*element, *lanes))
        }
        _ => types.first().and_then(|type_| match type_ {
            RuntimeType::Vector { element, lanes } | RuntimeType::Mask { element, lanes } => {
                Some((*element, *lanes))
            }
            _ => None,
        }),
    };
    let Some((element, lanes)) = shape else {
        return false;
    };
    if !matches!(
        (element, lanes),
        ("float-32", 4) | ("integer-32", 4) | ("integer-16", 8) | ("integer-8", 16)
    ) {
        return false;
    }
    let vector = RuntimeType::Vector { element, lanes };
    let mask = RuntimeType::Mask { element, lanes };
    let scalar = if element == "float-32" {
        RuntimeType::Float32
    } else {
        RuntimeType::Integer32
    };
    let lane_valid = operation.lane.is_some_and(|lane| lane < lanes);
    match operation.operator {
        Some("make") => {
            lanes == 4
                && *result == vector
                && types.len() == usize::from(lanes)
                && types.iter().all(|type_| **type_ == scalar)
        }
        Some("splat") => *result == vector && types == [&scalar],
        Some("extract") => lanes == 4 && *result == scalar && types == [&vector] && lane_valid,
        Some("replace") => {
            element == "integer-32"
                && *result == vector
                && types == [&vector, &scalar]
                && lane_valid
        }
        Some("add" | "subtract" | "multiply") => *result == vector && types == [&vector, &vector],
        Some("divide") => element == "float-32" && *result == vector && types == [&vector, &vector],
        Some("equal") => *result == mask && types == [&vector, &vector],
        Some("less-than") => {
            element == "float-32" && *result == mask && types == [&vector, &vector]
        }
        Some(
            "not-equal"
            | "less-than-signed"
            | "less-than-unsigned"
            | "greater-than-signed"
            | "greater-than-unsigned"
            | "less-than-or-equal-signed"
            | "less-than-or-equal-unsigned"
            | "greater-than-or-equal-signed"
            | "greater-than-or-equal-unsigned",
        ) => element != "float-32" && *result == mask && types == [&vector, &vector],
        Some("bit-and" | "bit-or" | "bit-xor") => {
            element != "float-32"
                && (*result == vector || *result == mask)
                && types == [result, result]
        }
        Some("bit-not") => {
            element != "float-32" && (*result == vector || *result == mask) && types == [result]
        }
        Some("shift-left" | "shift-right-signed" | "shift-right-unsigned") => {
            element != "float-32"
                && *result == vector
                && types == [&vector, &RuntimeType::Integer32]
        }
        Some("minimum-signed" | "minimum-unsigned" | "maximum-signed" | "maximum-unsigned") => {
            element != "float-32" && *result == vector && types == [&vector, &vector]
        }
        Some("select") => *result == vector && types == [&mask, &vector, &vector],
        Some("mask-bitmask") => {
            element != "float-32" && *result == RuntimeType::Integer32 && types == [&mask]
        }
        Some("mask-all" | "mask-any") => *result == RuntimeType::Integer32 && types == [&mask],
        Some("sum") => element == "float-32" && *result == scalar && types == [&vector],
        Some("shuffle") => {
            if element != "float-32"
                || *result != vector
                || types
                    != [
                        &vector,
                        &vector,
                        &RuntimeType::Integer32,
                        &RuntimeType::Integer32,
                        &RuntimeType::Integer32,
                        &RuntimeType::Integer32,
                    ]
            {
                return false;
            }
            instruction.operands[2..].iter().all(|selector| {
                function
                    .continuations
                    .iter()
                    .flat_map(|continuation| &continuation.instructions)
                    .find(|candidate| candidate.definition.value == *selector)
                    .is_some_and(|candidate| {
                        candidate.operation.kind == "constant"
                            && matches!(
                                candidate.operation.value,
                                Some(WireConstant::SignedInteger32(0..=7))
                            )
                    })
            })
        }
        _ => false,
    }
}
