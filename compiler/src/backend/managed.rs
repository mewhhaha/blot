use super::*;

#[derive(Clone, Copy)]
pub(super) struct ValueFunctions {
    pub owns_memory: bool,
    pub retain: u32,
    pub release: u32,
    pub claim: u32,
    pub retain_stored: u32,
    pub release_stored: u32,
    pub retain_range: u32,
    pub release_range: u32,
}

pub(super) struct ManagedValues {
    pub values: BTreeMap<usize, ValueFunctions>,
    pub drop_children: u32,
    empty: BTreeSet<u32>,
    children: BTreeMap<usize, u32>,
}

impl ManagedValues {
    pub(super) fn declare(
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        types: &mut FunctionTypes,
        functions: &mut FunctionSection,
        imports: u32,
    ) -> Result<Self, String> {
        let mut demanded = BTreeSet::new();
        let mut pending = module
            .functions
            .iter()
            .flat_map(|function| &function.continuations)
            .flat_map(|continuation| {
                continuation
                    .parameters
                    .iter()
                    .chain(&continuation.captures)
                    .chain(
                        continuation
                            .instructions
                            .iter()
                            .map(|instruction| &instruction.definition),
                    )
            })
            .map(|definition| definition.type_id.0)
            .collect::<Vec<_>>();
        let mut stored = BTreeSet::new();
        while let Some(type_id) = pending.pop() {
            if !demanded.insert(type_id) {
                continue;
            }
            match &module.types[type_id] {
                RuntimeType::Store { element_type } | RuntimeType::Scratch { element_type } => {
                    stored.insert(*element_type);
                    pending.push(*element_type);
                }
                RuntimeType::Indirect { target_type } => {
                    stored.insert(*target_type);
                    pending.push(*target_type);
                }
                RuntimeType::Product { fields, .. } => {
                    pending.extend(fields.iter().map(|field| field.type_id))
                }
                RuntimeType::Sum { cases, .. } => {
                    pending.extend(cases.iter().map(|case| case.payload_type))
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
        let mut owns_memory = vec![false; module.types.len()];
        let mut dependents = vec![Vec::new(); module.types.len()];
        let mut owners = Vec::new();
        for type_id in &demanded {
            match &module.types[*type_id] {
                RuntimeType::Text
                | RuntimeType::Store { .. }
                | RuntimeType::Scratch { .. }
                | RuntimeType::Indirect { .. } => {
                    owns_memory[*type_id] = true;
                    owners.push(*type_id);
                }
                RuntimeType::Product { fields, .. } => {
                    for field in fields {
                        dependents[field.type_id].push(*type_id);
                    }
                }
                RuntimeType::Sum { cases, .. } => {
                    for case in cases {
                        dependents[case.payload_type].push(*type_id);
                    }
                }
                RuntimeType::Sealed {
                    representation_type,
                    ..
                } => dependents[*representation_type].push(*type_id),
                RuntimeType::Callback {
                    environment_type, ..
                } => dependents[*environment_type].push(*type_id),
                _ => {}
            }
        }
        while let Some(type_id) = owners.pop() {
            for parent in &dependents[type_id] {
                if !owns_memory[*parent] {
                    owns_memory[*parent] = true;
                    owners.push(*parent);
                }
            }
        }
        let pointer = types.intern(vec![ValType::I32], Vec::new());
        let range = types.intern(vec![ValType::I32, ValType::I32], Vec::new());
        let mut empty_signatures = BTreeMap::new();
        for type_id in &demanded {
            if owns_memory[*type_id] {
                continue;
            }
            let value = types.intern(layouts.flattened(module, *type_id)?.to_vec(), Vec::new());
            for signature in [value, pointer, range] {
                empty_signatures.entry(signature).or_insert_with(|| {
                    let index = imports + functions.len();
                    functions.function(signature);
                    index
                });
            }
        }
        let mut values = BTreeMap::new();
        for type_id in demanded {
            let signature = types.intern(layouts.flattened(module, type_id)?.to_vec(), Vec::new());
            if !owns_memory[type_id] {
                let value = empty_signatures[&signature];
                let stored = empty_signatures[&pointer];
                let range = empty_signatures[&range];
                values.insert(
                    type_id,
                    ValueFunctions {
                        owns_memory: false,
                        retain: value,
                        release: value,
                        claim: value,
                        retain_stored: stored,
                        release_stored: stored,
                        retain_range: range,
                        release_range: range,
                    },
                );
                continue;
            }
            let first = imports + functions.len();
            for _ in 0..3 {
                functions.function(signature);
            }
            functions.function(pointer);
            functions.function(pointer);
            functions.function(range);
            functions.function(range);
            values.insert(
                type_id,
                ValueFunctions {
                    owns_memory: owns_memory[type_id],
                    retain: first,
                    release: first + 1,
                    claim: first + 2,
                    retain_stored: first + 3,
                    release_stored: first + 4,
                    retain_range: first + 5,
                    release_range: first + 6,
                },
            );
        }
        let mut children = BTreeMap::new();
        for type_id in stored {
            if !owns_memory[type_id] {
                children.insert(type_id, empty_signatures[&pointer]);
                continue;
            }
            children.insert(type_id, imports + functions.len());
            functions.function(pointer);
        }
        let drop_children = imports + functions.len();
        functions.function(pointer);
        Ok(Self {
            values,
            drop_children,
            empty: empty_signatures.into_values().collect(),
            children,
        })
    }

    pub(super) fn emit(
        &self,
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        allocator: allocation::Functions,
        code: &mut CodeSection,
        hints: &mut BranchHints,
    ) -> Result<(), String> {
        for index in &self.empty {
            let mut body = Function::new([]);
            body.instructions().end();
            append_code_function(code, hints, *index, body)?;
        }
        for (type_id, value) in &self.values {
            if !value.owns_memory {
                continue;
            }
            for (mode, index) in [
                (Mode::Retain, value.retain),
                (Mode::Release, value.release),
                (Mode::Claim, value.claim),
            ] {
                let mut body = Function::new([]);
                self.emit_value(
                    &mut body.instructions(),
                    module,
                    layouts,
                    *type_id,
                    mode,
                    allocator,
                )?;
                body.instructions().end();
                append_code_function(code, hints, index, body)?;
            }
            let lanes = layouts.flattened(module, *type_id)?;
            let private = internal_memory_type(module, *type_id)?;
            let values = (1..1 + lanes.len() as u32).collect::<Vec<_>>();
            for (index, operation) in [
                (value.retain_stored, value.retain),
                (value.release_stored, value.release),
            ] {
                let mut body = Function::new(compact_local_declarations(lanes));
                let mut ins = body.instructions();
                emit_load_canonical_result(&mut ins, &private, &values, 0, 0)?;
                emit_local_values(&mut ins, &values);
                ins.call(operation).end();
                append_code_function(code, hints, index, body)?;
            }
            let stride = memory_layout(&private).size;
            for (index, operation) in [
                (value.retain_range, value.retain_stored),
                (value.release_range, value.release_stored),
            ] {
                let mut body = Function::new([(1, ValType::I32)]);
                let mut ins = body.instructions();
                ins.block(BlockType::Empty)
                    .loop_(BlockType::Empty)
                    .local_get(2)
                    .local_get(1)
                    .i32_ge_u()
                    .br_if(1)
                    .local_get(0)
                    .local_get(2)
                    .i32_const(stride as i32)
                    .i32_mul()
                    .i32_add()
                    .call(operation)
                    .local_get(2)
                    .i32_const(1)
                    .i32_add()
                    .local_set(2)
                    .br(0)
                    .end()
                    .end()
                    .end();
                append_code_function(code, hints, index, body)?;
            }
        }
        for (type_id, index) in &self.children {
            if !self.values[type_id].owns_memory {
                continue;
            }
            append_code_function(
                code,
                hints,
                *index,
                self.drop_elements(module, layouts, *type_id)?,
            )?;
        }
        let mut body = Function::new([(1, ValType::I32)]);
        let mut ins = body.instructions();
        ins.local_get(0)
            .i32_const(allocation::HEADER_SIZE as i32)
            .i32_sub()
            .i32_load(mem(allocation::ELEMENT_TYPE))
            .local_set(1);
        for (type_id, index) in &self.children {
            ins.local_get(1)
                .i32_const(*type_id as i32)
                .i32_eq()
                .if_(BlockType::Empty)
                .local_get(0)
                .call(*index)
                .return_()
                .end();
        }
        ins.unreachable().end();
        append_code_function(code, hints, self.drop_children, body)
    }

    fn emit_value(
        &self,
        ins: &mut InstructionSink<'_>,
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        type_id: usize,
        mode: Mode,
        allocator: allocation::Functions,
    ) -> Result<(), String> {
        if !self.values[&type_id].owns_memory {
            return Ok(());
        }
        match &module.types[type_id] {
            RuntimeType::Text | RuntimeType::Store { .. } => {
                ins.local_get(2).call(mode.allocator(allocator));
            }
            RuntimeType::Scratch { .. } => {
                ins.local_get(3).call(mode.allocator(allocator));
            }
            RuntimeType::Indirect { .. } => {
                ins.local_get(0).call(mode.allocator(allocator));
            }
            RuntimeType::Product { fields, .. } => {
                let mut offset = 0;
                for field in fields {
                    let width = layouts.flattened(module, field.type_id)?.len() as u32;
                    if self.values[&field.type_id].owns_memory {
                        for local in offset..offset + width {
                            ins.local_get(local);
                        }
                        ins.call(mode.value(self.values[&field.type_id]));
                    }
                    offset += width;
                }
            }
            RuntimeType::Sum { cases, .. } => {
                let lanes = layouts.flattened(module, type_id)?;
                for (index, case) in cases.iter().enumerate() {
                    if !self.values[&case.payload_type].owns_memory {
                        continue;
                    }
                    ins.local_get(0)
                        .i32_const(index as i32)
                        .i32_eq()
                        .if_(BlockType::Empty);
                    for (index, lane) in layouts
                        .flattened(module, case.payload_type)?
                        .iter()
                        .enumerate()
                    {
                        ins.local_get(1 + index as u32);
                        emit_lane_conversion(ins, lanes[index + 1], *lane)?;
                    }
                    ins.call(mode.value(self.values[&case.payload_type])).end();
                }
            }
            RuntimeType::Sealed {
                representation_type: inner,
                ..
            }
            | RuntimeType::Callback {
                environment_type: inner,
                ..
            } => {
                for local in 0..layouts.flattened(module, *inner)?.len() as u32 {
                    ins.local_get(local);
                }
                ins.call(mode.value(self.values[inner]));
            }
            _ => {}
        }
        Ok(())
    }

    fn drop_elements(
        &self,
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        type_id: usize,
    ) -> Result<Function, String> {
        let element = internal_memory_type(module, type_id)?;
        let layout = memory_layout(&element);
        let lanes = layouts.flattened(module, type_id)?;
        let mut locals = vec![ValType::I32, ValType::I32, ValType::I32];
        locals.extend_from_slice(lanes);
        let values = (4..4 + lanes.len() as u32).collect::<Vec<_>>();
        let mut body = Function::new(compact_local_declarations(&locals));
        let mut ins = body.instructions();
        ins.local_get(0)
            .local_set(1)
            .i32_const(0)
            .local_set(2)
            .local_get(0)
            .i32_const(allocation::HEADER_SIZE as i32)
            .i32_sub()
            .i32_load(mem(allocation::ELEMENT_COUNT))
            .local_set(3)
            .block(BlockType::Empty)
            .loop_(BlockType::Empty)
            .local_get(2)
            .local_get(3)
            .i32_ge_u()
            .br_if(1);
        emit_load_canonical_result(&mut ins, &element, &values, 1, 0)?;
        emit_local_values(&mut ins, &values);
        ins.call(self.values[&type_id].release)
            .local_get(1)
            .i32_const(layout.size as i32)
            .i32_add()
            .local_set(1)
            .local_get(2)
            .i32_const(1)
            .i32_add()
            .local_set(2)
            .br(0)
            .end()
            .end()
            .end();
        Ok(body)
    }
}

#[derive(Clone, Copy)]
enum Mode {
    Retain,
    Release,
    Claim,
}

impl Mode {
    fn allocator(self, functions: allocation::Functions) -> u32 {
        match self {
            Self::Retain => functions.retain,
            Self::Release => functions.release,
            Self::Claim => functions.claim,
        }
    }
    fn value(self, functions: ValueFunctions) -> u32 {
        match self {
            Self::Retain => functions.retain,
            Self::Release => functions.release,
            Self::Claim => functions.claim,
        }
    }
}

fn mem(offset: u32) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

#[cfg(test)]
#[path = "managed_tests.rs"]
mod tests;
