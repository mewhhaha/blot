use super::*;

const ACTIVE_CONTEXTS: u32 = 6;
const CONTEXT_CHECKPOINT: u32 = 7;
const CONTEXT_SIZE: u32 = 24;
const FRAME_HEADER: u32 = 16;
const LANE_SIZE: u32 = 16;

// Public context words: private frame, status, import ordinal, argument block,
// pending result block, completed result block. Frame contents remain private.
const STATUS: u32 = 4;
const IMPORT: u32 = 8;
const ARGUMENTS: u32 = 12;
const PENDING_RESULT: u32 = 16;
const RESULT: u32 = 20;

pub(crate) fn functions(module: &RuntimeModule) -> BTreeSet<usize> {
    let operations = module
        .capabilities
        .iter()
        .flat_map(|capability| {
            capability
                .operations
                .iter()
                .filter(|operation| operation.contract.suspends)
                .map(|operation| (capability.name.as_str(), operation.name.as_str()))
        })
        .collect::<BTreeSet<_>>();
    let mut suspended = module
        .resumable_roots
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    loop {
        let before = suspended.len();
        for function in &module.functions {
            if function
                .blocks
                .iter()
                .flat_map(|block| &block.operations)
                .any(|operation| {
                    (operation.kind == "host.call"
                        && operations.contains(&(
                            operation
                                .capability
                                .as_deref()
                                .expect("checked host capability"),
                            operation
                                .operation
                                .as_deref()
                                .expect("checked host operation"),
                        )))
                        || (operation.kind == "call.direct"
                            && suspended
                                .contains(&operation.function.expect("checked direct call target")))
                        || (operation.kind == "call.external"
                            && module.links.iter().any(|link| {
                                link.suspends
                                    && Some(link.unit.as_str()) == operation.capability.as_deref()
                                    && Some(link.name.as_str()) == operation.operation.as_deref()
                            }))
                })
            {
                suspended.insert(function.id);
            }
        }
        if before == suspended.len() {
            return suspended;
        }
    }
}

pub(crate) fn framed_functions(module: &RuntimeModule) -> BTreeSet<usize> {
    let mut framed = functions(module);
    framed.extend(module.types.iter().filter_map(|type_| {
        if let RuntimeType::Callback { function, .. } = type_ {
            Some(*function)
        } else {
            None
        }
    }));
    loop {
        let before = framed.len();
        let callees = module
            .functions
            .iter()
            .filter(|function| framed.contains(&function.id))
            .flat_map(|function| &function.blocks)
            .flat_map(|block| &block.operations)
            .filter(|operation| operation.kind == "call.direct")
            .filter_map(|operation| operation.function)
            .collect::<Vec<_>>();
        framed.extend(callees);
        if framed.len() == before {
            return framed;
        }
    }
}

struct SuspensionImport<'a> {
    function: &'a AbiFunction,
    suspends: bool,
}

struct Segment {
    block: usize,
    start: usize,
    end: usize,
}

struct Frame {
    capacity: u32,
    argument_offset: u32,
    result_offset: u32,
    value_locals: HashMap<usize, Vec<u32>>,
    value_types: HashMap<usize, usize>,
    lane_types: Vec<ValType>,
    segments: Vec<Segment>,
    entries: HashMap<usize, usize>,
}

impl Frame {
    fn new(
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        function: &RuntimeFunction,
        manifest: &AbiManifest,
        suspended: &BTreeSet<usize>,
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
        let mut value_locals = HashMap::new();
        let mut lane_types = Vec::new();
        for (value, type_id) in &definitions {
            let lanes = layouts.flattened(module, *type_id)?;
            let first = 2 + lane_types.len() as u32;
            value_locals.insert(*value, (first..first + lanes.len() as u32).collect());
            lane_types.extend_from_slice(lanes);
        }
        let mut segments = Vec::new();
        let mut entries = HashMap::new();
        for block in &function.blocks {
            entries.insert(block.id, segments.len());
            let mut start = 0;
            for (index, operation) in block.operations.iter().enumerate() {
                if boundary(operation, manifest, suspended) {
                    segments.push(Segment {
                        block: block.id,
                        start,
                        end: index + 1,
                    });
                    start = index + 1;
                }
            }
            segments.push(Segment {
                block: block.id,
                start,
                end: block.operations.len(),
            });
        }
        let argument_offset = FRAME_HEADER + lane_types.len() as u32 * LANE_SIZE;
        let mut argument_size = 0;
        let mut result_size = 0;
        for operation in function.blocks.iter().flat_map(|block| &block.operations) {
            if let Some((_, imported)) = host_import(operation, manifest)
                && imported.suspends
            {
                let size = imported.function.parameters.iter().fold(0, |size, type_| {
                    let layout = memory_layout(type_);
                    align_to(size, layout.alignment) + layout.size
                });
                argument_size = argument_size.max(size.max(1));
                result_size = result_size.max(memory_layout(&imported.function.result).size.max(1));
            }
        }
        let result_offset = argument_offset + align_to(argument_size, 16);
        Ok(Self {
            capacity: result_offset + align_to(result_size, 16),
            argument_offset,
            result_offset,
            value_locals,
            value_types: definitions.into_iter().collect(),
            lane_types,
            segments,
            entries,
        })
    }

    fn size(&self) -> u32 {
        self.capacity
    }

    fn save(&self, instructions: &mut InstructionSink<'_>) {
        for (index, type_) in self.lane_types.iter().enumerate() {
            instructions.local_get(1).local_get(index as u32 + 2);
            store_lane(instructions, *type_, lane_offset(index as u32 + 2));
        }
    }
}

fn boundary(
    operation: &RuntimeOperation,
    manifest: &AbiManifest,
    suspended: &BTreeSet<usize>,
) -> bool {
    if operation.kind == "call.direct" {
        return suspended.contains(&operation.function.expect("checked direct call target"));
    }
    host_import(operation, manifest).is_some_and(|(_, imported)| imported.suspends)
}

fn host_import<'a>(
    operation: &RuntimeOperation,
    manifest: &'a AbiManifest,
) -> Option<(usize, SuspensionImport<'a>)> {
    if operation.kind == "host.call" {
        let (ordinal, imported) = manifest
            .imports
            .iter()
            .enumerate()
            .find(|(_, imported)| {
                Some(imported.capability.as_str()) == operation.capability.as_deref()
                    && Some(imported.operation.as_str()) == operation.operation.as_deref()
            })
            .expect("checked host call has an ABI import");
        return Some((
            ordinal,
            SuspensionImport {
                function: &imported.function,
                suspends: imported.contract.suspends,
            },
        ));
    }
    if operation.kind == "call.external" {
        let (ordinal, link) = manifest
            .links
            .iter()
            .enumerate()
            .find(|(_, link)| {
                Some(link.unit.as_str()) == operation.capability.as_deref()
                    && Some(link.name.as_str()) == operation.operation.as_deref()
            })
            .expect("checked external call has an ABI link");
        return Some((
            manifest.imports.len() + ordinal,
            SuspensionImport {
                function: &link.function,
                suspends: link.suspends,
            },
        ));
    }
    None
}

fn mem(offset: u32) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset: u64::from(offset),
        align: 0,
        memory_index: 0,
    }
}

fn lane_offset(local: u32) -> u32 {
    FRAME_HEADER + (local - 2) * LANE_SIZE
}

fn load_lane(instructions: &mut InstructionSink<'_>, type_: ValType, offset: u32) {
    match type_ {
        ValType::I32 => {
            instructions.i32_load(mem(offset));
        }
        ValType::I64 => {
            instructions.i64_load(mem(offset));
        }
        ValType::F32 => {
            instructions.f32_load(mem(offset));
        }
        ValType::F64 => {
            instructions.f64_load(mem(offset));
        }
        ValType::V128 => {
            instructions.v128_load(mem(offset));
        }
        _ => unreachable!("Runtime HIR has no reference-valued frame lanes"),
    }
}

fn store_lane(instructions: &mut InstructionSink<'_>, type_: ValType, offset: u32) {
    match type_ {
        ValType::I32 => {
            instructions.i32_store(mem(offset));
        }
        ValType::I64 => {
            instructions.i64_store(mem(offset));
        }
        ValType::F32 => {
            instructions.f32_store(mem(offset));
        }
        ValType::F64 => {
            instructions.f64_store(mem(offset));
        }
        ValType::V128 => {
            instructions.v128_store(mem(offset));
        }
        _ => unreachable!("Runtime HIR has no reference-valued frame lanes"),
    }
}

fn constant_word(instructions: &mut InstructionSink<'_>, pointer: u32, offset: u32, value: u32) {
    instructions
        .local_get(pointer)
        .i32_const(value as i32)
        .i32_store(mem(offset));
}

fn allocate(instructions: &mut InstructionSink<'_>, realloc: u32, size: u32, destination: u32) {
    instructions
        .i32_const(0)
        .i32_const(0)
        .i32_const(16)
        .i32_const(size as i32)
        .call(realloc)
        .local_set(destination);
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit(
    module: &RuntimeModule,
    layouts: &RuntimeTypeLayouts,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    direct: &HashMap<usize, u32>,
    suspended: &BTreeSet<usize>,
    types: &mut FunctionTypes,
    functions: &mut FunctionSection,
    code: &mut CodeSection,
    hints: &mut BranchHints,
    imports: u32,
) -> Result<Vec<(String, u32)>, String> {
    let framed = framed_functions(module);
    let callbacks = module
        .types
        .iter()
        .filter_map(|type_| {
            if let RuntimeType::Callback { function, .. } = type_ {
                Some(*function)
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>();
    let mut frames = module
        .functions
        .iter()
        .filter(|function| framed.contains(&function.id))
        .map(|function| {
            Ok((
                function.id,
                Frame::new(module, layouts, function, manifest, &framed)?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let tail_edges = module
        .functions
        .iter()
        .filter(|function| framed.contains(&function.id))
        .flat_map(|function| {
            function.blocks.iter().filter_map(|block| {
                let call = direct_tail_call(function, block)?;
                let target = call.function.expect("checked tail call");
                if framed.contains(&target) {
                    Some((function.id, target))
                } else {
                    None
                }
            })
        })
        .collect::<Vec<_>>();
    let mut roots = callbacks;
    roots.extend(module.exports.iter().filter_map(|exported| {
        if let RuntimeExport::Runtime { function, .. } = exported {
            Some(*function)
        } else {
            None
        }
    }));
    // Tail calls retain the parent continuation and reuse a frame large enough
    // for every tail-reachable callee, including mutually recursive functions.
    loop {
        let mut changed = false;
        for (caller, callee) in &tail_edges {
            let required = frames[callee].capacity;
            let frame = frames.get_mut(caller).expect("checked tail caller");
            if frame.capacity < required {
                frame.capacity = required;
                changed = true;
            }
            if roots.contains(caller) && roots.insert(*callee) {
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut steps = BTreeMap::new();
    let step_type = types.intern(vec![ValType::I32, ValType::I32], Vec::new());
    for id in frames.keys() {
        steps.insert(*id, imports + functions.len());
        functions.function(step_type);
    }
    for (id, frame) in &frames {
        let function = module
            .functions
            .iter()
            .find(|function| function.id == *id)
            .expect("checked frame function");
        append_code_function(
            code,
            hints,
            steps[id],
            step(
                module,
                layouts,
                function,
                frame,
                &frames,
                manifest,
                helpers,
                static_data,
                direct,
                &framed,
                &roots,
            )?,
        )?;
    }
    let mut exports = Vec::new();
    for exported in &module.exports {
        let RuntimeExport::Runtime {
            function,
            wasm_name,
            signature,
            ..
        } = exported
        else {
            continue;
        };
        if !suspended.contains(function) {
            continue;
        }
        let Some(frame) = frames.get(function) else {
            continue;
        };
        let signature = &module.signatures[*signature];
        let public = manifest
            .exports
            .iter()
            .find(|exported| exported.name.as_deref() == Some(wasm_name))
            .expect("checked runtime export")
            .function
            .as_ref()
            .expect("runtime export function");
        let parameters = public
            .parameters
            .iter()
            .flat_map(flattened_type)
            .collect::<Vec<_>>();
        let type_id = types.intern(parameters, vec![ValType::I32]);
        let index = imports + functions.len();
        functions.function(type_id);
        append_code_function(
            code,
            hints,
            index,
            start(
                module,
                layouts,
                *function,
                frame,
                public,
                signature,
                helpers.realloc,
            )?,
        )?;
        exports.push((wasm_name.clone(), index));
    }
    for function_id in module
        .types
        .iter()
        .filter_map(|type_| {
            if let RuntimeType::Callback { function, .. } = type_ {
                Some(function)
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>()
    {
        let function = module
            .functions
            .iter()
            .find(|function| function.id == *function_id)
            .expect("checked callback function");
        let public = &manifest
            .callbacks
            .iter()
            .find(|callback| callback.name == format!("blot:callback:{function_id}"))
            .expect("checked callback adapter")
            .function;
        let parameters = public.parameters.iter().flat_map(flattened_type).collect();
        let type_id = types.intern(parameters, vec![ValType::I32]);
        let index = imports + functions.len();
        functions.function(type_id);
        append_code_function(
            code,
            hints,
            index,
            start(
                module,
                layouts,
                *function_id,
                &frames[function_id],
                public,
                &module.signatures[function.signature],
                helpers.realloc,
            )?,
        )?;
        exports.push((format!("blot:callback:{function_id}"), index));
    }
    let mut controls = vec![
        ("cabi_enter", Vec::new(), Vec::new(), enter()),
        ("cabi_leave", Vec::new(), Vec::new(), leave()),
    ];
    if !framed.is_empty() {
        controls.extend([
            (
                "blot:poll",
                vec![ValType::I32, ValType::I32],
                vec![ValType::I32],
                poll(&steps),
            ),
            ("blot:resume", vec![ValType::I32], Vec::new(), resume()),
            ("blot:cancel", vec![ValType::I32], Vec::new(), cancel()),
            ("blot:release", vec![ValType::I32], Vec::new(), release()),
        ]);
    }
    for (name, parameters, results, body) in controls {
        let index = imports + functions.len();
        functions.function(types.intern(parameters, results));
        append_code_function(code, hints, index, body)?;
        exports.push((name.to_owned(), index));
    }
    Ok(exports)
}

#[allow(clippy::too_many_arguments)]
fn step(
    module: &RuntimeModule,
    layouts: &RuntimeTypeLayouts,
    function: &RuntimeFunction,
    frame: &Frame,
    frames: &BTreeMap<usize, Frame>,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    direct: &HashMap<usize, u32>,
    suspended: &BTreeSet<usize>,
    roots: &BTreeSet<usize>,
) -> Result<Function, String> {
    let mut locals = frame.lane_types.clone();
    let pointer = locals.len() as u32 + 2;
    locals.extend([ValType::I32, ValType::I32, ValType::I32]);
    let mut canonical_results = HashMap::new();
    for operation in function.blocks.iter().flat_map(|block| &block.operations) {
        if let Some((_, imported)) = host_import(operation, manifest) {
            if !imported.suspends {
                continue;
            }
            let lanes = flattened_type(&imported.function.result);
            let first = locals.len() as u32 + 2;
            canonical_results.insert(
                operation.result,
                (first..first + lanes.len() as u32).collect::<Vec<_>>(),
            );
            locals.extend(lanes);
        }
    }
    let mut body = Function::new(compact_local_declarations(&locals));
    let mut ins = body.instructions();
    for (index, type_) in frame.lane_types.iter().enumerate() {
        ins.local_get(1);
        load_lane(&mut ins, *type_, lane_offset(index as u32 + 2));
        ins.local_set(index as u32 + 2);
    }
    let facts = FunctionEmissionFacts {
        runtime_layouts: layouts,
        value_locals: &frame.value_locals,
        value_types: &frame.value_types,
    };
    for (state, segment) in frame.segments.iter().enumerate() {
        let block = function
            .blocks
            .iter()
            .find(|block| block.id == segment.block)
            .expect("checked segment block");
        ins.local_get(1)
            .i32_load(mem(4))
            .i32_const(state as i32)
            .i32_eq()
            .if_(BlockType::Empty);
        if segment.start > 0 {
            let previous = &block.operations[segment.start - 1];
            if let Some((_, imported)) = host_import(previous, manifest) {
                ins.local_get(0)
                    .i32_load(mem(PENDING_RESULT))
                    .local_set(pointer);
                let destination = &frame.value_locals[&previous.result];
                let canonical = &canonical_results[&previous.result];
                ins.local_get(pointer)
                    .i32_const(previous.type_id as i32)
                    .call(
                        helpers
                            .canonical_validator
                            .expect("host results require canonical validation"),
                    );
                emit_load_canonical_result(
                    &mut ins,
                    &imported.function.result,
                    canonical,
                    pointer,
                    0,
                )?;
                // Canonical input is translated through separate locals, since
                // record order and constructor tags are private to Runtime HIR.
                emit_translate_public_flat_value(
                    &mut ins,
                    module,
                    layouts,
                    previous.type_id,
                    &imported.function.result,
                    canonical,
                    destination,
                    false,
                )?;
            }
        }
        let mut stopped = false;
        for operation in &block.operations[segment.start..segment.end] {
            if !boundary(operation, manifest, suspended) {
                emit_dynamic_operation(
                    &mut ins,
                    module,
                    function,
                    operation,
                    manifest,
                    helpers,
                    static_data,
                    facts,
                    pointer,
                    pointer + 1,
                    pointer + 2,
                    direct,
                )?;
                continue;
            }
            constant_word(&mut ins, 1, 4, state as u32 + 1);
            frame.save(&mut ins);
            if let Some((ordinal, imported)) = host_import(operation, manifest) {
                let mut size = 0;
                let offsets = imported
                    .function
                    .parameters
                    .iter()
                    .map(|type_| {
                        let layout = memory_layout(type_);
                        size = align_to(size, layout.alignment);
                        let offset = size;
                        size += layout.size;
                        offset
                    })
                    .collect::<Vec<_>>();
                ins.local_get(1)
                    .i32_const(frame.argument_offset as i32)
                    .i32_add()
                    .local_set(pointer);
                ins.local_get(0)
                    .local_get(pointer)
                    .i32_store(mem(ARGUMENTS));
                for ((operand, type_), offset) in operation
                    .operands
                    .iter()
                    .zip(&imported.function.parameters)
                    .zip(offsets)
                {
                    emit_store_public_result(
                        &mut ins,
                        module,
                        layouts,
                        frame.value_types[operand],
                        type_,
                        &frame.value_locals[operand],
                        CanonicalDestination { pointer, offset },
                    )?;
                }
                ins.local_get(1)
                    .i32_const(frame.result_offset as i32)
                    .i32_add()
                    .local_set(pointer);
                ins.local_get(0)
                    .local_get(pointer)
                    .i32_store(mem(PENDING_RESULT));
                constant_word(&mut ins, 0, IMPORT, ordinal as u32);
                constant_word(&mut ins, 0, STATUS, 1);
            } else {
                let target = operation.function.expect("checked resumable call target");
                let child = &frames[&target];
                let callee = module
                    .functions
                    .iter()
                    .find(|function| function.id == target)
                    .expect("checked callee");
                let entry = callee
                    .blocks
                    .iter()
                    .find(|block| block.id == callee.entry_block)
                    .expect("checked callee entry");
                let tail = direct_tail_call(function, block)
                    .is_some_and(|call| call.result == operation.result);
                if tail {
                    ins.local_get(1).local_set(pointer);
                } else {
                    allocate(&mut ins, helpers.realloc, child.size(), pointer);
                }
                constant_word(&mut ins, pointer, 0, target as u32);
                constant_word(
                    &mut ins,
                    pointer,
                    4,
                    child.entries[&callee.entry_block] as u32,
                );
                if !tail {
                    ins.local_get(pointer).local_get(1).i32_store(mem(8));
                    let destination = &frame.value_locals[&operation.result];
                    ins.local_get(pointer).local_get(1);
                    if let Some(first) = destination.first() {
                        ins.i32_const(lane_offset(*first) as i32).i32_add();
                    }
                    ins.i32_store(mem(12));
                }
                for (operand, parameter) in operation.operands.iter().zip(&entry.parameters) {
                    for (source, destination) in frame.value_locals[operand]
                        .iter()
                        .zip(&child.value_locals[&parameter.value])
                    {
                        ins.local_get(pointer).local_get(*source);
                        store_lane(
                            &mut ins,
                            frame.lane_types[*source as usize - 2],
                            lane_offset(*destination),
                        );
                    }
                }
                ins.local_get(0).local_get(pointer).i32_store(mem(0));
            }
            ins.return_();
            stopped = true;
        }
        if !stopped {
            match &block.terminator {
                RuntimeTerminator::Branch {
                    target, arguments, ..
                } => {
                    assign_block_arguments(&mut ins, module, function, *target, arguments, facts)?;
                    constant_word(&mut ins, 1, 4, frame.entries[target] as u32);
                }
                RuntimeTerminator::Conditional {
                    condition,
                    consequent,
                    consequent_arguments,
                    alternate,
                    alternate_arguments,
                    ..
                } => {
                    ins.local_get(frame.value_locals[condition][0])
                        .if_(BlockType::Empty);
                    assign_block_arguments(
                        &mut ins,
                        module,
                        function,
                        *consequent,
                        consequent_arguments,
                        facts,
                    )?;
                    constant_word(&mut ins, 1, 4, frame.entries[consequent] as u32);
                    ins.else_();
                    assign_block_arguments(
                        &mut ins,
                        module,
                        function,
                        *alternate,
                        alternate_arguments,
                        facts,
                    )?;
                    constant_word(&mut ins, 1, 4, frame.entries[alternate] as u32);
                    ins.end();
                }
                RuntimeTerminator::Switch {
                    selector,
                    cases,
                    fallback,
                    ..
                } => {
                    constant_word(&mut ins, 1, 4, frame.entries[fallback] as u32);
                    for case in cases {
                        ins.local_get(frame.value_locals[selector][0]);
                        match case.value {
                            WireConstant::SignedInteger32(_) => {
                                ins.i32_const(switch_case_integer(&case.value)? as i32)
                                    .i32_eq();
                            }
                            WireConstant::SignedInteger64(_) => {
                                ins.i64_const(switch_case_integer(&case.value)?).i64_eq();
                            }
                            _ => return Err("resumable switch requires integer cases".to_owned()),
                        }
                        ins.if_(BlockType::Empty);
                        constant_word(&mut ins, 1, 4, frame.entries[&case.target] as u32);
                        ins.end();
                    }
                }
                RuntimeTerminator::Return { value, .. } => {
                    ins.local_get(1)
                        .i32_load(mem(8))
                        .i32_eqz()
                        .if_(BlockType::Empty);
                    if roots.contains(&function.id) {
                        let result_type = module.signatures[function.signature].result;
                        let public = canonical_type(module, result_type, &mut Vec::new())?;
                        ins.local_get(0).i32_load(mem(RESULT)).local_set(pointer);
                        emit_store_public_result(
                            &mut ins,
                            module,
                            layouts,
                            result_type,
                            &public,
                            &frame.value_locals[value],
                            CanonicalDestination { pointer, offset: 0 },
                        )?;
                        constant_word(&mut ins, 0, STATUS, 2);
                    } else {
                        ins.unreachable();
                    }
                    ins.else_()
                        .local_get(1)
                        .i32_load(mem(12))
                        .local_set(pointer);
                    for (index, source) in frame.value_locals[value].iter().enumerate() {
                        ins.local_get(pointer).local_get(*source);
                        store_lane(
                            &mut ins,
                            frame.lane_types[*source as usize - 2],
                            index as u32 * LANE_SIZE,
                        );
                    }
                    ins.end()
                        .local_get(0)
                        .local_get(1)
                        .i32_load(mem(8))
                        .i32_store(mem(0))
                        .return_();
                }
                RuntimeTerminator::Trap { .. } => {
                    ins.unreachable();
                }
            }
            frame.save(&mut ins);
            ins.return_();
        }
        ins.end();
    }
    ins.unreachable().end();
    Ok(body)
}

fn start(
    module: &RuntimeModule,
    layouts: &RuntimeTypeLayouts,
    id: usize,
    frame: &Frame,
    public: &AbiFunction,
    signature: &crate::hir::RuntimeSignature,
    realloc: u32,
) -> Result<Function, String> {
    let parameters = public
        .parameters
        .iter()
        .flat_map(flattened_type)
        .collect::<Vec<_>>();
    let context = parameters.len() as u32;
    let pointer = context + 1;
    let mut locals = vec![ValType::I32, ValType::I32];
    locals.extend_from_slice(&frame.lane_types);
    let mut body = Function::new(compact_local_declarations(&locals));
    let mut ins = body.instructions();
    ins.global_get(ACTIVE_CONTEXTS)
        .i32_eqz()
        .if_(BlockType::Empty)
        .global_get(HEAP_GLOBAL)
        .global_set(CONTEXT_CHECKPOINT)
        .end()
        .global_get(ACTIVE_CONTEXTS)
        .i32_const(1)
        .i32_add()
        .global_set(ACTIVE_CONTEXTS);
    allocate(&mut ins, realloc, CONTEXT_SIZE, context);
    for offset in (0..CONTEXT_SIZE).step_by(4) {
        constant_word(&mut ins, context, offset, 0);
    }
    allocate(
        &mut ins,
        realloc,
        memory_layout(&public.result).size.max(1),
        pointer,
    );
    ins.local_get(context)
        .local_get(pointer)
        .i32_store(mem(RESULT));
    allocate(&mut ins, realloc, frame.size(), pointer);
    ins.local_get(context).local_get(pointer).i32_store(mem(0));
    constant_word(&mut ins, pointer, 0, id as u32);
    let function = module
        .functions
        .iter()
        .find(|function| function.id == id)
        .expect("checked root function");
    constant_word(
        &mut ins,
        pointer,
        4,
        frame.entries[&function.entry_block] as u32,
    );
    constant_word(&mut ins, pointer, 8, 0);
    constant_word(&mut ins, pointer, 12, 0);
    let entry = function
        .blocks
        .iter()
        .find(|block| block.id == function.entry_block)
        .expect("checked root entry");
    let mut source = 0;
    for ((parameter, type_id), public_type) in entry
        .parameters
        .iter()
        .zip(&signature.parameters)
        .zip(&public.parameters)
    {
        let destinations = &frame.value_locals[&parameter.value];
        let translated = destinations
            .iter()
            .map(|local| local + context)
            .collect::<Vec<_>>();
        let width = destinations.len() as u32;
        emit_translate_public_flat_value(
            &mut ins,
            module,
            layouts,
            *type_id,
            public_type,
            &(source..source + width).collect::<Vec<_>>(),
            &translated,
            false,
        )?;
        for ((destination, local), type_) in destinations
            .iter()
            .zip(translated)
            .zip(layouts.flattened(module, *type_id)?)
        {
            ins.local_get(pointer).local_get(local);
            store_lane(&mut ins, *type_, lane_offset(*destination));
        }
        source += width;
    }
    ins.local_get(context).end();
    Ok(body)
}

fn poll(steps: &BTreeMap<usize, u32>) -> Function {
    let mut body = Function::new([(2, ValType::I32)]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_load(mem(STATUS))
        .local_tee(2)
        .i32_eqz()
        .local_get(2)
        .i32_const(4)
        .i32_eq()
        .i32_or()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 0, STATUS, 0);
    ins.loop_(BlockType::Empty)
        .local_get(1)
        .i32_eqz()
        .if_(BlockType::Empty);
    constant_word(&mut ins, 0, STATUS, 4);
    ins.i32_const(4)
        .return_()
        .end()
        .local_get(1)
        .i32_const(1)
        .i32_sub()
        .local_set(1)
        .local_get(0)
        .i32_load(mem(0))
        .local_tee(3)
        .i32_load(mem(0))
        .local_set(2)
        .block(BlockType::Empty);
    for (id, index) in steps {
        ins.local_get(2)
            .i32_const(*id as i32)
            .i32_eq()
            .if_(BlockType::Empty)
            .local_get(0)
            .local_get(3)
            .call(*index)
            .br(1)
            .end();
    }
    ins.unreachable()
        .end()
        .local_get(0)
        .i32_load(mem(STATUS))
        .local_tee(2)
        .if_(BlockType::Empty)
        .local_get(2)
        .return_()
        .end()
        .br(0)
        .end()
        .unreachable()
        .end();
    body
}

fn resume() -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_load(mem(STATUS))
        .i32_const(1)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 0, STATUS, 0);
    ins.end();
    body
}

fn cancel() -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_load(mem(STATUS))
        .i32_const(4)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 0, STATUS, 3);
    constant_word(&mut ins, 0, 0, 0);
    ins.end();
    body
}

fn release() -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_load(mem(STATUS))
        .local_tee(1)
        .i32_const(2)
        .i32_eq()
        .local_get(1)
        .i32_const(3)
        .i32_eq()
        .i32_or()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 0, STATUS, 5);
    ins.global_get(ACTIVE_CONTEXTS)
        .i32_const(1)
        .i32_sub()
        .global_set(ACTIVE_CONTEXTS)
        .global_get(ACTIVE_CONTEXTS)
        .i32_eqz()
        .if_(BlockType::Empty)
        .global_get(CONTEXT_CHECKPOINT)
        .global_set(HEAP_GLOBAL)
        .end()
        .end();
    body
}

fn enter() -> Function {
    let mut body = Function::new([]);
    body.instructions()
        .global_get(ACTIVE_CONTEXTS)
        .i32_eqz()
        .if_(BlockType::Empty)
        .global_get(HEAP_GLOBAL)
        .global_set(CONTEXT_CHECKPOINT)
        .end()
        .global_get(ACTIVE_CONTEXTS)
        .i32_const(1)
        .i32_add()
        .global_set(ACTIVE_CONTEXTS)
        .end();
    body
}

fn leave() -> Function {
    let mut body = Function::new([]);
    body.instructions()
        .global_get(ACTIVE_CONTEXTS)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(ACTIVE_CONTEXTS)
        .i32_const(1)
        .i32_sub()
        .global_set(ACTIVE_CONTEXTS)
        .global_get(ACTIVE_CONTEXTS)
        .i32_eqz()
        .if_(BlockType::Empty)
        .global_get(CONTEXT_CHECKPOINT)
        .global_set(HEAP_GLOBAL)
        .end()
        .end();
    body
}
