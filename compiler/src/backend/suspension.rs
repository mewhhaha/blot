use super::*;
use crate::suspension::ResumableFunction;

pub(super) const CONTEXT_GLOBAL: u32 = 6;
pub(super) const TOKEN_GLOBAL: u32 = 7;
const FRAME_HEADER: u32 = 32;
const SLOT_SIZE: u32 = 16;

pub(super) fn validate_boundary(type_: &AbiType) -> Result<(), String> {
    match type_ {
        AbiType::Array { .. } => Err("Arrays crossing a suspension boundary require canonical element copying, which this target does not yet support.".to_owned()),
        AbiType::Record { fields } => {
            for field in fields {
                validate_boundary(&field.type_)?;
            }
            Ok(())
        }
        AbiType::Variant { cases } => {
            for case_ in cases {
                if let Some(payload) = &case_.payload {
                    validate_boundary(payload)?;
                }
            }
            Ok(())
        }
        AbiType::Sealed { inner, .. } => validate_boundary(inner),
        _ => Ok(()),
    }
}

pub(super) struct FrameLayout {
    values: HashMap<usize, Vec<u32>>,
    types: HashMap<usize, usize>,
    locals: Vec<ValType>,
    entry: usize,
}

impl FrameLayout {
    pub(super) fn new(
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        function: &RuntimeFunction,
        plan: &ResumableFunction,
    ) -> Result<Self, String> {
        let mut definitions = BTreeMap::new();
        for block in &function.blocks {
            for parameter in &block.parameters {
                definitions.insert(parameter.value, parameter.type_id);
            }
            for operation in &block.operations {
                definitions.insert(operation.result, operation.type_id);
            }
        }
        let mut values = HashMap::new();
        let mut locals = Vec::new();
        for (value, type_id) in &definitions {
            let first = locals.len() as u32 + 1;
            locals.extend_from_slice(layouts.flattened(module, *type_id)?);
            values.insert(*value, (first..locals.len() as u32 + 1).collect());
        }
        Ok(Self {
            values,
            types: definitions.into_iter().collect(),
            locals,
            entry: plan.block_entries[&function.entry_block],
        })
    }

    fn size(&self) -> u32 {
        FRAME_HEADER + self.locals.len() as u32 * SLOT_SIZE
    }
    fn offset(local: u32) -> u32 {
        FRAME_HEADER + (local - 1) * SLOT_SIZE
    }

    fn restore(&self, instructions: &mut InstructionSink<'_>) {
        for (index, type_) in self.locals.iter().enumerate() {
            let local = index as u32 + 1;
            instructions.local_get(0);
            load(instructions, *type_, Self::offset(local));
            instructions.local_set(local);
        }
    }

    fn save(&self, instructions: &mut InstructionSink<'_>) {
        for (index, type_) in self.locals.iter().enumerate() {
            let local = index as u32 + 1;
            instructions.local_get(0).local_get(local);
            store(instructions, *type_, Self::offset(local));
        }
    }
}

fn memory(offset: u32) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset: u64::from(offset),
        align: 0,
        memory_index: 0,
    }
}

fn load(instructions: &mut InstructionSink<'_>, type_: ValType, offset: u32) {
    match type_ {
        ValType::I32 => {
            instructions.i32_load(memory(offset));
        }
        ValType::I64 => {
            instructions.i64_load(memory(offset));
        }
        ValType::F32 => {
            instructions.f32_load(memory(offset));
        }
        ValType::F64 => {
            instructions.f64_load(memory(offset));
        }
        ValType::V128 => {
            instructions.v128_load(memory(offset));
        }
        _ => unreachable!("Runtime HIR has no reference-valued frame slots"),
    }
}

fn store(instructions: &mut InstructionSink<'_>, type_: ValType, offset: u32) {
    match type_ {
        ValType::I32 => {
            instructions.i32_store(memory(offset));
        }
        ValType::I64 => {
            instructions.i64_store(memory(offset));
        }
        ValType::F32 => {
            instructions.f32_store(memory(offset));
        }
        ValType::F64 => {
            instructions.f64_store(memory(offset));
        }
        ValType::V128 => {
            instructions.v128_store(memory(offset));
        }
        _ => unreachable!("Runtime HIR has no reference-valued frame slots"),
    }
}

fn allocate(instructions: &mut InstructionSink<'_>, size: u32, realloc: u32) {
    instructions
        .i32_const(0)
        .i32_const(0)
        .i32_const(16)
        .i32_const(size as i32)
        .call(realloc);
}

fn set_field(instructions: &mut InstructionSink<'_>, pointer: u32, offset: u32, value: i32) {
    instructions
        .local_get(pointer)
        .i32_const(value)
        .i32_store(memory(offset));
}

pub(super) fn step(
    module: &RuntimeModule,
    layouts: &RuntimeTypeLayouts,
    function: &RuntimeFunction,
    plan: &ResumableFunction,
    frames: &BTreeMap<usize, FrameLayout>,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    direct_functions: &HashMap<usize, u32>,
) -> Result<Function, String> {
    let frame = &frames[&function.id];
    let mut locals = frame.locals.clone();
    let mut public_results = HashMap::new();
    for segment in &plan.segments {
        if let Some(operation_index) = segment.host_result {
            let block = function
                .blocks
                .iter()
                .find(|block| block.id == segment.block)
                .ok_or("resumption segment has no block")?;
            let operation = &block.operations[operation_index];
            let public = canonical_type(module, operation.type_id, &mut Vec::new())?;
            let start = locals.len() as u32 + 1;
            locals.extend(flattened_type(&public));
            public_results.insert(
                operation.result,
                (start..locals.len() as u32 + 1).collect::<Vec<_>>(),
            );
        }
    }
    let scratch = locals.len() as u32 + 1;
    locals.extend([ValType::I32; 4]);
    let pointer = scratch;
    let length = scratch + 1;
    let index = scratch + 2;
    let context = scratch + 3;
    let facts = FunctionEmissionFacts {
        runtime_layouts: layouts,
        value_locals: &frame.values,
        value_types: &frame.types,
    };
    let mut result = Function::new(compact_local_declarations(&locals));
    let mut instructions = result.instructions();
    instructions.global_get(CONTEXT_GLOBAL).local_set(context);
    frame.restore(&mut instructions);
    instructions.block(BlockType::Empty);
    for _ in &plan.segments {
        instructions.block(BlockType::Empty);
    }
    instructions.local_get(0).i32_load(memory(8)).br_table(
        (0..plan.segments.len() as u32).rev(),
        plan.segments.len() as u32,
    );
    for (segment_id, segment) in plan.segments.iter().enumerate().rev() {
        instructions.end();
        let block = function
            .blocks
            .iter()
            .find(|block| block.id == segment.block)
            .ok_or("resumption segment has no block")?;
        if let Some(operation) = segment.host_result {
            let operation = &block.operations[operation];
            let type_ = canonical_type(module, operation.type_id, &mut Vec::new())?;
            instructions
                .local_get(0)
                .i32_load(memory(20))
                .local_set(pointer);
            let output = &frame.values[&operation.result];
            let public = &public_results[&operation.result];
            emit_load_canonical_result(&mut instructions, &type_, public, pointer, 0)?;
            let mut flat = 0;
            emit_validate_canonical_texts(
                &mut instructions,
                &type_,
                public,
                &mut flat,
                length,
                helpers
                    .utf8_validator
                    .ok_or("suspension requires UTF-8 validator")?,
            )?;
            emit_translate_public_flat_value(
                &mut instructions,
                module,
                layouts,
                operation.type_id,
                &type_,
                public,
                output,
                false,
            )?;
        }
        for operation in &block.operations[segment.start..segment.end] {
            emit_dynamic_operation(
                &mut instructions,
                module,
                function,
                operation,
                manifest,
                helpers,
                static_data,
                facts,
                pointer,
                length,
                index,
                direct_functions,
            )?;
        }
        if let Some(operation) = block.operations.get(segment.end) {
            frame.save(&mut instructions);
            set_field(&mut instructions, 0, 8, segment_id as i32 + 1);
            if operation.kind == "call.direct" {
                let target = operation
                    .function
                    .ok_or("suspending call has no function")?;
                let callee = &module.functions[target];
                let callee_frame = &frames[&target];
                allocate(&mut instructions, callee_frame.size(), helpers.realloc);
                instructions.local_set(pointer);
                instructions
                    .local_get(pointer)
                    .local_get(0)
                    .i32_store(memory(0));
                set_field(&mut instructions, pointer, 4, target as i32);
                set_field(&mut instructions, pointer, 8, callee_frame.entry as i32);
                let destination = frame.values[&operation.result]
                    .first()
                    .map(|local| FrameLayout::offset(*local))
                    .unwrap_or(FRAME_HEADER);
                instructions
                    .local_get(pointer)
                    .local_get(0)
                    .i32_const(destination as i32)
                    .i32_add()
                    .i32_store(memory(12));
                let entry = callee
                    .blocks
                    .iter()
                    .find(|block| block.id == callee.entry_block)
                    .ok_or("callee has no entry")?;
                for (parameter, operand) in entry.parameters.iter().zip(&operation.operands) {
                    for (destination, source) in callee_frame.values[&parameter.value]
                        .iter()
                        .zip(&frame.values[operand])
                    {
                        instructions.local_get(pointer).local_get(*source);
                        store(
                            &mut instructions,
                            callee_frame.locals[*destination as usize - 1],
                            FrameLayout::offset(*destination),
                        );
                    }
                }
                instructions
                    .local_get(context)
                    .local_get(pointer)
                    .i32_store(memory(0));
                instructions.i32_const(0).return_();
            } else {
                let (import_index, imported) = manifest
                    .imports
                    .iter()
                    .enumerate()
                    .find(|(_, imported)| {
                        Some(&imported.capability) == operation.capability.as_ref()
                            && Some(&imported.operation) == operation.operation.as_ref()
                    })
                    .ok_or("suspending call has no ABI import")?;
                let argument = *operation
                    .operands
                    .first()
                    .ok_or("host call has no argument")?;
                let input = &imported.function.parameters[0];
                allocate(
                    &mut instructions,
                    memory_layout(input).size,
                    helpers.realloc,
                );
                instructions.local_set(pointer);
                emit_store_public_result(
                    &mut instructions,
                    module,
                    layouts,
                    frame.types[&argument],
                    input,
                    &frame.values[&argument],
                    CanonicalDestination { pointer, offset: 0 },
                )?;
                allocate(
                    &mut instructions,
                    memory_layout(&imported.function.result).size,
                    helpers.realloc,
                );
                instructions.local_set(length);
                instructions
                    .local_get(0)
                    .local_get(length)
                    .i32_store(memory(20));
                instructions
                    .local_get(context)
                    .local_get(context)
                    .i32_load(memory(16))
                    .i32_const(1)
                    .i32_add()
                    .i32_store(memory(16));
                instructions
                    .local_get(context)
                    .i32_load(memory(16))
                    .i32_eqz()
                    .if_(BlockType::Empty)
                    .unreachable()
                    .end();
                instructions
                    .local_get(context)
                    .i32_load(memory(12))
                    .local_get(pointer)
                    .local_get(length)
                    .local_get(context)
                    .i32_load(memory(16))
                    .call(import_index as u32)
                    .return_();
            }
            continue;
        }
        match &block.terminator {
            RuntimeTerminator::Return { value, .. } => {
                instructions
                    .local_get(0)
                    .i32_load(memory(0))
                    .local_tee(pointer)
                    .i32_eqz()
                    .if_(BlockType::Empty);
                if module.exports.iter().any(|export| matches!(export, RuntimeExport::Runtime { function: id, .. } if *id == function.id)) {
                    let result_type = module.signatures[function.signature].result;
                    let public = canonical_type(module, result_type, &mut Vec::new())?;
                    instructions.local_get(context).i32_load(memory(8)).local_set(length);
                    emit_store_public_result(&mut instructions, module, layouts, result_type, &public, &frame.values[value], CanonicalDestination { pointer: length, offset: 0 })?;
                    instructions.i32_const(2).return_();
                } else { instructions.unreachable(); }
                instructions.end();
                instructions
                    .local_get(0)
                    .i32_load(memory(12))
                    .local_set(length);
                for (slot, local) in frame.values[value].iter().enumerate() {
                    instructions.local_get(length).local_get(*local);
                    store(
                        &mut instructions,
                        frame.locals[*local as usize - 1],
                        slot as u32 * SLOT_SIZE,
                    );
                }
                instructions
                    .local_get(context)
                    .local_get(pointer)
                    .i32_store(memory(0));
                instructions.i32_const(0).return_();
            }
            RuntimeTerminator::Trap { .. } => {
                instructions.unreachable();
            }
            terminator => {
                let target = |instructions: &mut InstructionSink<'_>,
                              block: usize,
                              arguments: &[usize]|
                 -> Result<(), String> {
                    assign_block_arguments(
                        instructions,
                        module,
                        function,
                        block,
                        arguments,
                        facts,
                    )?;
                    set_field(instructions, 0, 8, plan.block_entries[&block] as i32);
                    Ok(())
                };
                match terminator {
                    RuntimeTerminator::Branch {
                        target: block,
                        arguments,
                        ..
                    } => target(&mut instructions, *block, arguments)?,
                    RuntimeTerminator::Conditional {
                        condition,
                        consequent,
                        consequent_arguments,
                        alternate,
                        alternate_arguments,
                        ..
                    } => {
                        instructions
                            .local_get(frame.values[condition][0])
                            .if_(BlockType::Empty);
                        target(&mut instructions, *consequent, consequent_arguments)?;
                        instructions.else_();
                        target(&mut instructions, *alternate, alternate_arguments)?;
                        instructions.end();
                    }
                    RuntimeTerminator::Switch {
                        selector,
                        cases,
                        fallback,
                        ..
                    } => {
                        set_field(&mut instructions, 0, 8, plan.block_entries[fallback] as i32);
                        for case in cases {
                            instructions.local_get(frame.values[selector][0]);
                            match frame.locals[frame.values[selector][0] as usize - 1] {
                                ValType::I64 => {
                                    instructions
                                        .i64_const(switch_case_integer(&case.value)?)
                                        .i64_eq();
                                }
                                ValType::I32 => {
                                    instructions
                                        .i32_const(switch_case_integer(&case.value)? as i32)
                                        .i32_eq();
                                }
                                _ => {
                                    return Err(
                                        "suspending switch requires an integer selector".to_owned()
                                    );
                                }
                            }
                            instructions.if_(BlockType::Empty);
                            set_field(
                                &mut instructions,
                                0,
                                8,
                                plan.block_entries[&case.target] as i32,
                            );
                            instructions.end();
                        }
                    }
                    _ => unreachable!(),
                }
                frame.save(&mut instructions);
                instructions.i32_const(0).return_();
            }
        }
    }
    instructions.end().unreachable().end();
    Ok(result)
}

pub(super) fn start(
    module: &RuntimeModule,
    layouts: &RuntimeTypeLayouts,
    function: &RuntimeFunction,
    frame: &FrameLayout,
    plan: &ResumableFunction,
    lookup: u32,
    realloc: u32,
    utf8_validator: u32,
) -> Result<Function, String> {
    let signature = &module.signatures[function.signature];
    let fields = signature
        .parameters
        .iter()
        .enumerate()
        .map(|(index, type_id)| {
            Ok(AbiField {
                name: index.to_string(),
                type_: canonical_type(module, *type_id, &mut Vec::new())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let offsets = record_layout(&fields);
    let context = 2;
    let pointer = 3;
    let scratch = 4;
    let mut locals = vec![ValType::I32; 3];
    let mut parameters = Vec::new();
    for (index, type_id) in signature.parameters.iter().enumerate() {
        let first = locals.len() as u32 + 2;
        locals.extend(flattened_type(&fields[index].type_));
        let public = (first..locals.len() as u32 + 2).collect::<Vec<_>>();
        let first = locals.len() as u32 + 2;
        locals.extend_from_slice(layouts.flattened(module, *type_id)?);
        let private = (first..locals.len() as u32 + 2).collect::<Vec<_>>();
        parameters.push((public, private));
    }
    let mut result = Function::new(compact_local_declarations(&locals));
    let mut instructions = result.instructions();
    instructions
        .local_get(0)
        .call(lookup)
        .local_tee(context)
        .i32_load(memory(0))
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    allocate(&mut instructions, frame.size(), realloc);
    instructions.local_set(pointer);
    set_field(&mut instructions, pointer, 0, 0);
    set_field(&mut instructions, pointer, 4, function.id as i32);
    set_field(
        &mut instructions,
        pointer,
        8,
        plan.block_entries[&function.entry_block] as i32,
    );
    instructions
        .local_get(context)
        .local_get(pointer)
        .i32_store(memory(0));
    let entry = function
        .blocks
        .iter()
        .find(|block| block.id == function.entry_block)
        .ok_or("async export has no entry")?;
    for (index, parameter) in entry.parameters.iter().enumerate() {
        let offset = offsets
            .iter()
            .find(|field| field.name == index.to_string())
            .ok_or("async parameter has no canonical offset")?
            .offset;
        let (public, private) = &parameters[index];
        emit_load_canonical_result(&mut instructions, &fields[index].type_, public, 1, offset)?;
        let mut flat = 0;
        emit_validate_canonical_texts(
            &mut instructions,
            &fields[index].type_,
            public,
            &mut flat,
            scratch,
            utf8_validator,
        )?;
        emit_translate_public_flat_value(
            &mut instructions,
            module,
            layouts,
            parameter.type_id,
            &fields[index].type_,
            public,
            private,
            false,
        )?;
        for (destination, source) in frame.values[&parameter.value].iter().zip(private) {
            instructions.local_get(pointer).local_get(*source);
            store(
                &mut instructions,
                frame.locals[*destination as usize - 1],
                FrameLayout::offset(*destination),
            );
        }
    }
    let public = canonical_type(module, signature.result, &mut Vec::new())?;
    instructions.local_get(context);
    allocate(
        &mut instructions,
        memory_layout(&public).size.max(1),
        realloc,
    );
    instructions.i32_store(memory(8)).end();
    Ok(result)
}

pub(super) fn append_protocol(
    types: &mut FunctionTypes,
    functions: &mut FunctionSection,
    code: &mut CodeSection,
    imported: u32,
    realloc: u32,
    steps: &BTreeMap<usize, u32>,
) -> (u32, Vec<(String, u32)>) {
    let mut exports = Vec::new();
    let lookup = imported + functions.len();
    functions.function(types.intern(vec![ValType::I32], vec![ValType::I32]));
    let mut body = Function::new([(1, ValType::I32)]);
    body.instructions()
        .global_get(CONTEXT_GLOBAL)
        .local_tee(1)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(1)
        .i32_load(memory(12))
        .local_get(0)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(1)
        .end();
    code.function(&body);
    let begin = imported + functions.len();
    functions.function(types.intern(Vec::new(), vec![ValType::I32]));
    let mut body = Function::new([(1, ValType::I32)]);
    let mut instructions = body.instructions();
    begin_call(&mut instructions, u32::MAX);
    instructions
        .global_get(TOKEN_GLOBAL)
        .i32_const(1)
        .i32_add()
        .local_tee(0)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(0)
        .global_set(TOKEN_GLOBAL);
    allocate(&mut instructions, 32, realloc);
    instructions.global_set(CONTEXT_GLOBAL);
    for offset in [0, 4, 8, 16] {
        instructions
            .global_get(CONTEXT_GLOBAL)
            .i32_const(0)
            .i32_store(memory(offset));
    }
    instructions
        .global_get(CONTEXT_GLOBAL)
        .local_get(0)
        .i32_store(memory(12))
        .local_get(0)
        .end();
    code.function(&body);
    exports.push(("blot:begin".to_owned(), begin));
    let resume = imported + functions.len();
    functions.function(types.intern(vec![ValType::I32, ValType::I32], vec![ValType::I32]));
    let mut body = Function::new([(3, ValType::I32)]);
    let mut instructions = body.instructions();
    instructions.local_get(0).call(lookup).local_set(2);
    instructions
        .local_get(2)
        .i32_load(memory(16))
        .local_get(1)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    instructions
        .local_get(2)
        .i32_load(memory(4))
        .i32_const(2)
        .i32_ge_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    // A host import can call back into this instance before a step returns.
    // Keep that attempt from consuming the in-flight request recursively.
    set_field(&mut instructions, 2, 4, 3);
    instructions.loop_(BlockType::Empty);
    instructions
        .local_get(2)
        .i32_load(memory(0))
        .local_tee(3)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    for (function, step) in steps {
        instructions
            .local_get(3)
            .i32_load(memory(4))
            .i32_const(*function as i32)
            .i32_eq()
            .if_(BlockType::Empty);
        instructions
            .local_get(3)
            .call(*step)
            .local_tee(4)
            .i32_eqz()
            .br_if(1);
        instructions
            .local_get(4)
            .i32_const(2)
            .i32_gt_u()
            .if_(BlockType::Empty)
            .unreachable()
            .end();
        instructions
            .local_get(2)
            .local_get(4)
            .i32_store(memory(4))
            .local_get(4)
            .return_()
            .end();
    }
    instructions.unreachable().end().unreachable().end();
    code.function(&body);
    exports.push(("blot:resume".to_owned(), resume));
    let result = imported + functions.len();
    functions.function(types.intern(vec![ValType::I32], vec![ValType::I32]));
    let mut body = Function::new([(1, ValType::I32)]);
    body.instructions()
        .local_get(0)
        .call(lookup)
        .local_tee(1)
        .i32_load(memory(4))
        .i32_const(2)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(1)
        .i32_load(memory(8))
        .end();
    code.function(&body);
    exports.push(("blot:result".to_owned(), result));
    let release = imported + functions.len();
    functions.function(types.intern(vec![ValType::I32], Vec::new()));
    let mut body = Function::new(Vec::new());
    body.instructions()
        .local_get(0)
        .call(lookup)
        .drop()
        .i32_const(0)
        .global_set(CONTEXT_GLOBAL);
    finish_call(&mut body.instructions());
    body.instructions().end();
    code.function(&body);
    exports.push(("blot:release".to_owned(), release));
    (lookup, exports)
}
