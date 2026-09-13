use super::*;

#[derive(Clone, Copy)]
pub(super) struct ValueAdapters {
    pub lower: u32,
    pub upper: u32,
    pub read: u32,
    pub write: u32,
}

pub(super) struct CanonicalAdapters {
    pub types: BTreeMap<usize, ValueAdapters>,
}

impl CanonicalAdapters {
    pub(super) fn declare(
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        types: &mut FunctionTypes,
        functions: &mut FunctionSection,
        imports: u32,
    ) -> Result<Self, String> {
        let mut signatures = BTreeSet::new();
        for exported in &module.exports {
            if let RuntimeExport::Runtime { signature, .. } = exported {
                signatures.insert(*signature);
            }
        }
        for capability in &module.capabilities {
            signatures.extend(
                capability
                    .operations
                    .iter()
                    .map(|operation| operation.signature),
            );
        }
        signatures.extend(module.links.iter().map(|link| link.signature));
        let mut pending = Vec::new();
        for (type_id, type_) in module.types.iter().enumerate() {
            if let RuntimeType::Callback { signature, .. } = type_ {
                signatures.insert(*signature);
                pending.push(type_id);
            }
        }
        for signature in signatures {
            let signature = &module.signatures[signature];
            pending.extend(signature.parameters.iter().copied());
            pending.push(signature.result);
        }
        let mut demanded = BTreeSet::new();
        while let Some(type_id) = pending.pop() {
            if !demanded.insert(type_id) {
                continue;
            }
            // The public layout closure owns target refusal. Resource payloads
            // describe host values; their bits never enter this traversal.
            canonical_type(module, type_id, &mut Vec::new())?;
            match &module.types[type_id] {
                RuntimeType::Store { element_type } => pending.push(*element_type),
                RuntimeType::Product { fields, .. } => {
                    pending.extend(fields.iter().map(|field| field.type_id));
                }
                RuntimeType::Sum { cases, .. } => {
                    pending.extend(cases.iter().map(|case| case.payload_type));
                }
                RuntimeType::Sealed {
                    representation_type,
                    ..
                } => pending.push(*representation_type),
                RuntimeType::Callback {
                    environment_type, ..
                } => pending.push(*environment_type),
                _ => {}
            }
        }
        let mut adapters = BTreeMap::new();
        for type_id in demanded {
            let lanes = layouts.flattened(module, type_id)?.to_vec();
            let lower = imports + functions.len();
            functions.function(types.intern(vec![ValType::I32], lanes.clone()));
            let mut parameters = vec![ValType::I32];
            parameters.extend(lanes);
            let upper = imports + functions.len();
            functions.function(types.intern(parameters, Vec::new()));
            let public_lanes = flattened_type(&canonical_type(module, type_id, &mut Vec::new())?);
            let read = imports + functions.len();
            functions.function(types.intern(vec![ValType::I32], public_lanes.clone()));
            let mut write_parameters = vec![ValType::I32];
            write_parameters.extend(public_lanes);
            let write = imports + functions.len();
            functions.function(types.intern(write_parameters, Vec::new()));
            adapters.insert(
                type_id,
                ValueAdapters {
                    lower,
                    upper,
                    read,
                    write,
                },
            );
        }
        Ok(Self { types: adapters })
    }

    pub(super) fn emit(
        &self,
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        allocator: allocation::Functions,
        _globals: allocation::Globals,
        code: &mut CodeSection,
        hints: &mut BranchHints,
    ) -> Result<(), String> {
        for (type_id, adapters) in &self.types {
            append_code_function(
                code,
                hints,
                adapters.lower,
                self.lower(module, layouts, allocator, *type_id)?,
            )?;
            append_code_function(
                code,
                hints,
                adapters.upper,
                self.upper(module, layouts, allocator, *type_id)?,
            )?;
            let public = canonical_type(module, *type_id, &mut Vec::new())?;
            let lanes = flattened_type(&public);
            let values = (1..1 + lanes.len() as u32).collect::<Vec<_>>();
            let mut read = Function::new(compact_local_declarations(&lanes));
            let mut ins = read.instructions();
            emit_load_canonical_result(&mut ins, &public, &values, 0, 0)?;
            emit_local_values(&mut ins, &values);
            ins.end();
            append_code_function(code, hints, adapters.read, read)?;
            let mut write = Function::new([]);
            let mut consumed = 0;
            emit_store_canonical_result(
                &mut write.instructions(),
                &public,
                &values,
                &mut consumed,
                0,
                0,
            )?;
            write.instructions().end();
            append_code_function(code, hints, adapters.write, write)?;
        }
        Ok(())
    }

    fn lower(
        &self,
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        allocator: allocation::Functions,
        type_id: usize,
    ) -> Result<Function, String> {
        let lanes = layouts.flattened(module, type_id)?;
        let result = (1..1 + lanes.len() as u32).collect::<Vec<_>>();
        let scratch = 1 + lanes.len() as u32;
        let child_start = scratch + 4;
        let mut local_types = lanes.to_vec();
        local_types.extend([ValType::I32; 4]);
        if let RuntimeType::Store { element_type } = &module.types[type_id] {
            local_types.extend_from_slice(layouts.flattened(module, *element_type)?);
        }
        let mut body = Function::new(compact_local_declarations(&local_types));
        let mut ins = body.instructions();
        let public = canonical_type(module, type_id, &mut Vec::new())?;
        match (&module.types[type_id], &public) {
            (RuntimeType::Text, AbiType::Text) => {
                ins.local_get(0)
                    .i32_load(mem(0))
                    .local_set(scratch)
                    .local_get(0)
                    .i32_load(mem(4))
                    .local_set(result[1]);
                allocate(
                    &mut ins,
                    allocator,
                    result[1],
                    1,
                    result[0],
                    AllocationResult::Private,
                );
                ins.local_get(result[0])
                    .local_set(result[2])
                    .local_get(result[0])
                    .local_get(scratch)
                    .local_get(result[1])
                    .memory_copy(0, 0);
            }
            (RuntimeType::Store { element_type }, AbiType::Array { element }) => {
                let private_element = internal_memory_type(module, *element_type)?;
                let private_layout = memory_layout(&private_element);
                let public_layout = memory_layout(element);
                let child = (child_start
                    ..child_start + layouts.flattened(module, *element_type)?.len() as u32)
                    .collect::<Vec<_>>();
                let source = scratch;
                let index = scratch + 1;
                let destination = scratch + 2;
                let size = scratch + 3;
                ins.local_get(0)
                    .i32_load(mem(0))
                    .local_set(source)
                    .local_get(0)
                    .i32_load(mem(4))
                    .local_set(result[1]);
                byte_size(&mut ins, result[1], private_layout.size, size);
                allocate(
                    &mut ins,
                    allocator,
                    size,
                    private_layout.alignment,
                    result[0],
                    AllocationResult::Private,
                );
                ins.local_get(result[0]).local_set(result[2]);
                if private_layout.size != 0 || public_layout.size != 0 {
                    ins.i32_const(0)
                        .local_set(index)
                        .block(BlockType::Empty)
                        .loop_(BlockType::Empty)
                        .local_get(index)
                        .local_get(result[1])
                        .i32_ge_u()
                        .br_if(1)
                        .local_get(source)
                        .local_get(index)
                        .i32_const(public_layout.size as i32)
                        .i32_mul()
                        .i32_add()
                        .call(self.types[element_type].lower);
                    set_results(&mut ins, &child);
                    ins.local_get(result[0])
                        .local_get(index)
                        .i32_const(private_layout.size as i32)
                        .i32_mul()
                        .i32_add()
                        .local_set(destination);
                    let mut consumed = 0;
                    emit_store_canonical_result(
                        &mut ins,
                        &private_element,
                        &child,
                        &mut consumed,
                        destination,
                        0,
                    )?;
                    assert_eq!(
                        consumed,
                        child.len(),
                        "private array element layout consumes every lane"
                    );
                    ins.local_get(index)
                        .i32_const(1)
                        .i32_add()
                        .local_set(index)
                        .br(0)
                        .end()
                        .end();
                }
                // Every child result transfers into its initialized container slot.
                ins.local_get(result[2])
                    .i32_const(allocation::ELEMENTS as i32)
                    .i32_const(*element_type as i32)
                    .local_get(result[1])
                    .call(allocator.set_layout);
            }
            (
                RuntimeType::Product { fields, .. },
                AbiType::Record {
                    fields: public_fields,
                },
            ) => {
                let public_fields = record_layout(public_fields);
                let mut offset = 0;
                for field in fields {
                    let public_field = public_fields
                        .iter()
                        .find(|candidate| candidate.name == field.name)
                        .ok_or_else(|| format!("canonical record omitted field {}", field.name))?;
                    let width = layouts.flattened(module, field.type_id)?.len();
                    ins.local_get(0)
                        .i32_const(public_field.offset as i32)
                        .i32_add()
                        .call(self.types[&field.type_id].lower);
                    set_results(&mut ins, &result[offset..offset + width]);
                    offset += width;
                }
            }
            (
                RuntimeType::Sum { cases, .. },
                AbiType::Variant {
                    cases: public_cases,
                },
            ) => {
                let layout = variant_layout(public_cases);
                load_tag(&mut ins, 0, layout.discriminant_size);
                ins.local_set(scratch);
                for (runtime_index, case) in cases.iter().enumerate() {
                    let public_index = public_cases
                        .iter()
                        .position(|candidate| candidate.name == case.name)
                        .ok_or_else(|| format!("canonical variant omitted case {}", case.name))?;
                    ins.local_get(scratch)
                        .i32_const(public_index as i32)
                        .i32_eq()
                        .if_(BlockType::Empty)
                        .i32_const(runtime_index as i32)
                        .local_set(result[0])
                        .local_get(0)
                        .i32_const(layout.payload_offset as i32)
                        .i32_add()
                        .call(self.types[&case.payload_type].lower);
                    let payload_lanes = layouts.flattened(module, case.payload_type)?;
                    for (index, lane) in payload_lanes.iter().enumerate().rev() {
                        emit_lane_conversion(&mut ins, *lane, lanes[index + 1])?;
                        ins.local_set(result[index + 1]);
                    }
                    emit_local_values(&mut ins, &result);
                    ins.return_().end();
                }
                ins.unreachable();
            }
            (
                RuntimeType::Sealed {
                    representation_type,
                    ..
                },
                AbiType::Sealed { .. },
            ) => {
                ins.local_get(0).call(self.types[representation_type].lower);
                set_results(&mut ins, &result);
            }
            (
                RuntimeType::Callback {
                    environment_type, ..
                },
                AbiType::Callback { .. },
            ) => {
                ins.local_get(0).call(self.types[environment_type].lower);
                set_results(&mut ins, &result);
            }
            (
                RuntimeType::Unit
                | RuntimeType::SignedInteger64
                | RuntimeType::Resource { .. }
                | RuntimeType::Float32
                | RuntimeType::Float64
                | RuntimeType::Boolean,
                _,
            ) => {
                let consumed = emit_load_canonical_result(&mut ins, &public, &result, 0, 0)?;
                assert_eq!(
                    consumed,
                    result.len(),
                    "canonical scalar consumes every lane"
                );
            }
            _ => {
                return Err(format!(
                    "{}: unsupported canonical lower type {type_id}",
                    module.source
                ));
            }
        }
        emit_local_values(&mut ins, &result);
        ins.end();
        Ok(body)
    }

    fn upper(
        &self,
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        allocator: allocation::Functions,
        type_id: usize,
    ) -> Result<Function, String> {
        let lanes = layouts.flattened(module, type_id)?;
        let source = (1..1 + lanes.len() as u32).collect::<Vec<_>>();
        let scratch = 1 + lanes.len() as u32;
        let child_start = scratch + 4;
        let mut local_types = vec![ValType::I32; 4];
        if let RuntimeType::Store { element_type } = &module.types[type_id] {
            local_types.extend_from_slice(layouts.flattened(module, *element_type)?);
        }
        let mut body = Function::new(compact_local_declarations(&local_types));
        let mut ins = body.instructions();
        let public = canonical_type(module, type_id, &mut Vec::new())?;
        match (&module.types[type_id], &public) {
            (RuntimeType::Text, AbiType::Text) => {
                allocate(
                    &mut ins,
                    allocator,
                    source[1],
                    1,
                    scratch,
                    AllocationResult::Canonical,
                );
                ins.local_get(scratch)
                    .local_get(source[0])
                    .local_get(source[1])
                    .memory_copy(0, 0)
                    .local_get(0)
                    .local_get(scratch)
                    .i32_store(mem(0))
                    .local_get(0)
                    .local_get(source[1])
                    .i32_store(mem(4));
            }
            (RuntimeType::Store { element_type }, AbiType::Array { element }) => {
                let private_element = internal_memory_type(module, *element_type)?;
                let private_layout = memory_layout(&private_element);
                let public_layout = memory_layout(element);
                let child = (child_start
                    ..child_start + layouts.flattened(module, *element_type)?.len() as u32)
                    .collect::<Vec<_>>();
                let destination = scratch;
                let index = scratch + 1;
                let private_pointer = scratch + 2;
                let size = scratch + 3;
                byte_size(&mut ins, source[1], public_layout.size, size);
                allocate(
                    &mut ins,
                    allocator,
                    size,
                    public_layout.alignment,
                    destination,
                    AllocationResult::Canonical,
                );
                ins.local_get(0)
                    .local_get(destination)
                    .i32_store(mem(0))
                    .local_get(0)
                    .local_get(source[1])
                    .i32_store(mem(4));
                if private_layout.size != 0 || public_layout.size != 0 {
                    ins.i32_const(0)
                        .local_set(index)
                        .block(BlockType::Empty)
                        .loop_(BlockType::Empty)
                        .local_get(index)
                        .local_get(source[1])
                        .i32_ge_u()
                        .br_if(1)
                        .local_get(source[0])
                        .local_get(index)
                        .i32_const(private_layout.size as i32)
                        .i32_mul()
                        .i32_add()
                        .local_set(private_pointer);
                    let consumed = emit_load_canonical_result(
                        &mut ins,
                        &private_element,
                        &child,
                        private_pointer,
                        0,
                    )?;
                    assert_eq!(
                        consumed,
                        child.len(),
                        "private array element layout produces every lane"
                    );
                    ins.local_get(destination)
                        .local_get(index)
                        .i32_const(public_layout.size as i32)
                        .i32_mul()
                        .i32_add();
                    emit_local_values(&mut ins, &child);
                    ins.call(self.types[element_type].upper)
                        .local_get(index)
                        .i32_const(1)
                        .i32_add()
                        .local_set(index)
                        .br(0)
                        .end()
                        .end();
                }
            }
            (
                RuntimeType::Product { fields, .. },
                AbiType::Record {
                    fields: public_fields,
                },
            ) => {
                let public_fields = record_layout(public_fields);
                let mut offset = 0;
                for field in fields {
                    let public_field = public_fields
                        .iter()
                        .find(|candidate| candidate.name == field.name)
                        .ok_or_else(|| format!("canonical record omitted field {}", field.name))?;
                    let width = layouts.flattened(module, field.type_id)?.len();
                    ins.local_get(0)
                        .i32_const(public_field.offset as i32)
                        .i32_add();
                    emit_local_values(&mut ins, &source[offset..offset + width]);
                    ins.call(self.types[&field.type_id].upper);
                    offset += width;
                }
            }
            (
                RuntimeType::Sum { cases, .. },
                AbiType::Variant {
                    cases: public_cases,
                },
            ) => {
                let layout = variant_layout(public_cases);
                for (runtime_index, case) in cases.iter().enumerate() {
                    let public_index = public_cases
                        .iter()
                        .position(|candidate| candidate.name == case.name)
                        .ok_or_else(|| format!("canonical variant omitted case {}", case.name))?;
                    ins.local_get(source[0])
                        .i32_const(runtime_index as i32)
                        .i32_eq()
                        .if_(BlockType::Empty);
                    store_tag(&mut ins, 0, layout.discriminant_size, public_index as u32);
                    ins.local_get(0)
                        .i32_const(layout.payload_offset as i32)
                        .i32_add();
                    let payload_lanes = layouts.flattened(module, case.payload_type)?;
                    for (index, lane) in payload_lanes.iter().enumerate() {
                        ins.local_get(source[index + 1]);
                        emit_lane_conversion(&mut ins, lanes[index + 1], *lane)?;
                    }
                    ins.call(self.types[&case.payload_type].upper)
                        .return_()
                        .end();
                }
                ins.unreachable();
            }
            (
                RuntimeType::Sealed {
                    representation_type,
                    ..
                },
                AbiType::Sealed { .. },
            ) => {
                ins.local_get(0);
                emit_local_values(&mut ins, &source);
                ins.call(self.types[representation_type].upper);
            }
            (
                RuntimeType::Callback {
                    environment_type, ..
                },
                AbiType::Callback { .. },
            ) => {
                ins.local_get(0);
                emit_local_values(&mut ins, &source);
                ins.call(self.types[environment_type].upper);
            }
            (
                RuntimeType::Unit
                | RuntimeType::SignedInteger64
                | RuntimeType::Resource { .. }
                | RuntimeType::Float32
                | RuntimeType::Float64
                | RuntimeType::Boolean,
                _,
            ) => {
                let mut consumed = 0;
                emit_store_canonical_result(&mut ins, &public, &source, &mut consumed, 0, 0)?;
                assert_eq!(consumed, source.len(), "canonical scalar stores every lane");
            }
            _ => {
                return Err(format!(
                    "{}: unsupported canonical upper type {type_id}",
                    module.source
                ));
            }
        }
        ins.end();
        Ok(body)
    }
}

fn mem(offset: u32) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

#[derive(Clone, Copy)]
enum AllocationResult {
    Private,
    Canonical,
}

fn allocate(
    ins: &mut InstructionSink<'_>,
    allocator: allocation::Functions,
    size: u32,
    alignment: u32,
    result: u32,
    ownership: AllocationResult,
) {
    ins.i32_const(0)
        .i32_const(0)
        .i32_const(alignment as i32)
        .local_get(size)
        .call(allocator.alloc)
        .local_set(result);
    match ownership {
        AllocationResult::Private => {
            ins.local_get(result).call(allocator.claim);
        }
        AllocationResult::Canonical => {
            ins.local_get(result)
                .if_(BlockType::Empty)
                .local_get(result)
                .call(allocator.temporary)
                .end();
        }
    }
}

fn byte_size(ins: &mut InstructionSink<'_>, count: u32, stride: u32, result: u32) {
    if stride == 0 {
        ins.i32_const(0).local_set(result);
        return;
    }
    ins.local_get(count)
        .i32_const((u32::MAX / stride) as i32)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(count)
        .i32_const(stride as i32)
        .i32_mul()
        .local_set(result);
}

fn set_results(ins: &mut InstructionSink<'_>, results: &[u32]) {
    for result in results.iter().rev() {
        ins.local_set(*result);
    }
}

fn load_tag(ins: &mut InstructionSink<'_>, pointer: u32, width: u32) {
    ins.local_get(pointer);
    let argument = wasm_encoder::MemArg {
        offset: 0,
        align: width.trailing_zeros(),
        memory_index: 0,
    };
    match width {
        1 => {
            ins.i32_load8_u(argument);
        }
        2 => {
            ins.i32_load16_u(argument);
        }
        4 => {
            ins.i32_load(argument);
        }
        _ => unreachable!("canonical discriminant width"),
    }
}

fn store_tag(ins: &mut InstructionSink<'_>, pointer: u32, width: u32, tag: u32) {
    ins.local_get(pointer).i32_const(tag as i32);
    let argument = wasm_encoder::MemArg {
        offset: 0,
        align: width.trailing_zeros(),
        memory_index: 0,
    };
    match width {
        1 => {
            ins.i32_store8(argument);
        }
        2 => {
            ins.i32_store16(argument);
        }
        4 => {
            ins.i32_store(argument);
        }
        _ => unreachable!("canonical discriminant width"),
    }
}

#[cfg(test)]
#[path = "canonical_tests.rs"]
mod tests;
