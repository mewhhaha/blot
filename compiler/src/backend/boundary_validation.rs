use super::*;

pub(super) fn function(module: &RuntimeModule, index: u32, utf8: u32) -> Result<Function, String> {
    let mut required = BTreeSet::new();
    let mut pending = module
        .capabilities
        .iter()
        .flat_map(|capability| &capability.operations)
        .flat_map(|operation| {
            let signature = &module.signatures[operation.signature];
            signature
                .parameters
                .iter()
                .copied()
                .chain([signature.result])
        })
        .collect::<Vec<_>>();
    while let Some(type_id) = pending.pop() {
        if !required.insert(type_id) {
            continue;
        }
        match &module.types[type_id] {
            RuntimeType::Product { fields, .. } => {
                pending.extend(fields.iter().map(|field| field.type_id))
            }
            RuntimeType::Sum { cases, .. } => {
                pending.extend(cases.iter().map(|case| case.payload_type))
            }
            RuntimeType::Store { element_type } => pending.push(*element_type),
            RuntimeType::Callback {
                environment_type, ..
            } => pending.push(*environment_type),
            RuntimeType::Sealed {
                representation_type,
                ..
            } => pending.push(*representation_type),
            _ => {}
        }
    }
    let mut body = Function::new([(4, ValType::I32)]);
    let mut ins = body.instructions();
    for type_id in required {
        let canonical = canonical_type(module, type_id, &mut Vec::new())?;
        let layout = memory_layout(&canonical);
        ins.local_get(1)
            .i32_const(type_id as i32)
            .i32_eq()
            .if_(BlockType::Empty);
        ins.i32_const(1).local_set(3);
        extent(&mut ins, 0, 3, layout.size, layout.alignment);
        match (&module.types[type_id], &canonical) {
            (
                _,
                AbiType::Unit
                | AbiType::SignedInteger64
                | AbiType::Float32
                | AbiType::Float64
                | AbiType::Resource { .. },
            ) => {}
            (_, AbiType::Boolean) => {
                ins.local_get(0)
                    .i32_load8_u(mem(0))
                    .i32_const(1)
                    .i32_gt_u()
                    .if_(BlockType::Empty)
                    .unreachable()
                    .end();
            }
            (_, AbiType::Text) => {
                ins.local_get(0)
                    .i32_load(mem(0))
                    .local_set(2)
                    .local_get(0)
                    .i32_load(mem(4))
                    .local_set(3);
                extent(&mut ins, 2, 3, 1, 1);
                ins.local_get(2).local_get(3).call(utf8);
            }
            (RuntimeType::Store { element_type }, AbiType::Array { element }) => {
                let element_layout = memory_layout(element);
                ins.local_get(0)
                    .i32_load(mem(0))
                    .local_set(2)
                    .local_get(0)
                    .i32_load(mem(4))
                    .local_set(3);
                extent(
                    &mut ins,
                    2,
                    3,
                    element_layout.size,
                    element_layout.alignment,
                );
                if element_layout.size > 0 {
                    ins.i32_const(0)
                        .local_set(4)
                        .block(BlockType::Empty)
                        .loop_(BlockType::Empty)
                        .local_get(4)
                        .local_get(3)
                        .i32_ge_u()
                        .br_if(1)
                        .local_get(2)
                        .local_get(4)
                        .i32_const(element_layout.size as i32)
                        .i32_mul()
                        .i32_add()
                        .i32_const(*element_type as i32)
                        .call(index)
                        .local_get(4)
                        .i32_const(1)
                        .i32_add()
                        .local_set(4)
                        .br(0)
                        .end()
                        .end();
                }
            }
            (RuntimeType::Product { fields, .. }, AbiType::Record { fields: public }) => {
                for field in record_layout(public) {
                    let runtime = fields
                        .iter()
                        .find(|candidate| candidate.name == field.name)
                        .expect("canonical field has a checked runtime type");
                    ins.local_get(0)
                        .i32_const(field.offset as i32)
                        .i32_add()
                        .i32_const(runtime.type_id as i32)
                        .call(index);
                }
            }
            (RuntimeType::Sum { cases, .. }, AbiType::Variant { cases: public }) => {
                let layout = variant_layout(public);
                ins.local_get(0);
                match layout.discriminant_size {
                    1 => {
                        ins.i32_load8_u(mem(0));
                    }
                    2 => {
                        ins.i32_load16_u(mem(0));
                    }
                    4 => {
                        ins.i32_load(mem(0));
                    }
                    _ => unreachable!("canonical discriminant width"),
                }
                ins.local_tee(5)
                    .i32_const(public.len() as i32)
                    .i32_ge_u()
                    .if_(BlockType::Empty)
                    .unreachable()
                    .end();
                for (tag, case) in public.iter().enumerate() {
                    if case.payload.is_none() {
                        continue;
                    }
                    let runtime = cases
                        .iter()
                        .find(|candidate| candidate.name == case.name)
                        .expect("canonical case has a checked runtime type");
                    ins.local_get(5)
                        .i32_const(tag as i32)
                        .i32_eq()
                        .if_(BlockType::Empty)
                        .local_get(0)
                        .i32_const(layout.payload_offset as i32)
                        .i32_add()
                        .i32_const(runtime.payload_type as i32)
                        .call(index)
                        .end();
                }
            }
            (
                RuntimeType::Sealed {
                    representation_type,
                    ..
                },
                AbiType::Sealed { .. },
            )
            | (
                RuntimeType::Callback {
                    environment_type: representation_type,
                    ..
                },
                AbiType::Callback { .. },
            ) => {
                ins.local_get(0)
                    .i32_const(*representation_type as i32)
                    .call(index);
            }
            _ => {
                return Err(format!(
                    "canonical validation has no rule for type {type_id}"
                ));
            }
        }
        ins.return_().end();
    }
    ins.unreachable().end();
    Ok(body)
}

fn mem(offset: u64) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset,
        align: 0,
        memory_index: 0,
    }
}

fn extent(ins: &mut InstructionSink<'_>, pointer: u32, length: u32, stride: u32, alignment: u32) {
    if stride == 0 {
        return;
    }
    ins.local_get(length)
        .if_(BlockType::Empty)
        .local_get(pointer)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(pointer)
        .i32_const(alignment as i32 - 1)
        .i32_and()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(pointer)
        .i64_extend_i32_u()
        .local_get(length)
        .i64_extend_i32_u()
        .i64_const(i64::from(stride))
        .i64_mul()
        .i64_add()
        .memory_size(0)
        .i64_extend_i32_u()
        .i64_const(16)
        .i64_shl()
        .i64_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .end();
}
