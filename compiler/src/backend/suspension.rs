use super::*;

#[cfg(test)]
#[path = "suspension_tests.rs"]
mod tests;

const CONTEXT_SIZE: u32 = 32;
const SCOPE_TOKEN: u32 = 24;
const FRAME_HEADER: u32 = 16;
const LANE_SIZE: u32 = 16;

// Public context words: private frame, status, import ordinal, argument block,
// pending result block, completed result block, scope token, reserved word.
// Frame contents remain private.
const STATUS: u32 = 4;
const IMPORT: u32 = 8;
const ARGUMENTS: u32 = 12;
const PENDING_RESULT: u32 = 16;
const RESULT: u32 = 20;

struct SuspensionImport<'a> {
    function: &'a AbiFunction,
    suspends: bool,
}

struct SavedLane {
    offset: u32,
    type_: ValType,
}

struct Frame {
    capacity: u32,
    argument_offset: u32,
    result_offset: u32,
    value_locals: HashMap<ValueId, Vec<u32>>,
    value_types: HashMap<ValueId, usize>,
    lane_types: Vec<ValType>,
    states: BTreeMap<ContinuationId, BTreeMap<ValueId, Vec<SavedLane>>>,
}

impl Frame {
    fn new(
        module: &RuntimeModule,
        layouts: &RuntimeTypeLayouts,
        function: &RuntimeFunction,
        manifest: &AbiManifest,
    ) -> Result<Self, String> {
        let mut definitions = BTreeMap::new();
        for continuation in &function.continuations {
            for parameter in &continuation.parameters {
                definitions.insert(parameter.value, parameter.type_id.0);
            }
            for instruction in &continuation.instructions {
                definitions.insert(
                    instruction.definition.value,
                    instruction.definition.type_id.0,
                );
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
        let mut states = BTreeMap::new();
        let mut saved_size = 0;
        for continuation in &function.continuations {
            let mut slots = BTreeMap::new();
            let mut offset = FRAME_HEADER;
            for definition in continuation.parameters.iter().chain(&continuation.captures) {
                let lanes = layouts
                    .flattened(module, definition.type_id.0)?
                    .iter()
                    .map(|type_| {
                        let lane = SavedLane {
                            offset,
                            type_: *type_,
                        };
                        offset += LANE_SIZE;
                        lane
                    })
                    .collect();
                slots.insert(definition.value, lanes);
            }
            saved_size = saved_size.max(offset - FRAME_HEADER);
            states.insert(continuation.id, slots);
        }
        let argument_offset = FRAME_HEADER + saved_size;
        let mut argument_size = 0;
        let mut result_size = 0;
        for continuation in &function.continuations {
            let RuntimeTransition::Call {
                target, signature, ..
            } = &continuation.transition
            else {
                continue;
            };
            if let Some((_, imported)) = host_import(target, manifest)
                && imported.suspends
            {
                let size = imported.function.parameters.iter().fold(0, |size, type_| {
                    let layout = memory_layout(type_);
                    align_to(size, layout.alignment) + layout.size
                });
                argument_size = argument_size.max(size.max(1));
                result_size = result_size.max(memory_layout(&imported.function.result).size.max(1));
            }
            if let CallTarget::Function { function: callee } = target
                && module
                    .functions
                    .iter()
                    .any(|function| function.id == *callee && function.framed)
            {
                result_size = result_size.max(
                    layouts
                        .flattened(module, module.signatures[signature.0].result)?
                        .len() as u32
                        * LANE_SIZE,
                );
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
            states,
        })
    }

    fn size(&self) -> u32 {
        self.capacity
    }

    fn load(&self, instructions: &mut InstructionSink<'_>, state: ContinuationId) {
        for (value, lanes) in &self.states[&state] {
            for (local, lane) in self.value_locals[value].iter().zip(lanes) {
                instructions.local_get(1);
                load_lane(instructions, lane.type_, lane.offset);
                instructions.local_set(*local);
            }
        }
    }

    fn store_value(
        &self,
        instructions: &mut InstructionSink<'_>,
        state: ContinuationId,
        value: ValueId,
        sources: &[u32],
        pointer: u32,
    ) {
        let lanes = &self.states[&state][&value];
        assert_eq!(
            lanes.len(),
            sources.len(),
            "checked continuation lane count"
        );
        for (source, lane) in sources.iter().zip(lanes) {
            instructions.local_get(pointer).local_get(*source);
            store_lane(instructions, lane.type_, lane.offset);
        }
    }

    fn save_edge(
        &self,
        instructions: &mut InstructionSink<'_>,
        function: &RuntimeFunction,
        edge: &Edge,
        result: Option<&[u32]>,
    ) {
        let successor = &function.continuations[edge.target.0];
        for (parameter, argument) in successor.parameters.iter().zip(&edge.arguments) {
            let sources = match argument {
                Argument::Value(value) => &self.value_locals[value],
                Argument::Result => match result {
                    Some(locals) => locals,
                    None => continue,
                },
            };
            self.store_value(instructions, edge.target, parameter.value, sources, 1);
        }
        for capture in &successor.captures {
            self.store_value(
                instructions,
                edge.target,
                capture.value,
                &self.value_locals[&capture.value],
                1,
            );
        }
        constant_word(instructions, 1, 4, continuation_state(edge.target));
    }

    fn reference(
        &self,
        ins: &mut InstructionSink<'_>,
        helpers: DynamicHelpers,
        value: ValueId,
        mode: Reference,
    ) {
        let functions = &helpers.managed.values[&self.value_types[&value]];
        if !functions.owns_memory {
            return;
        }
        emit_local_values(ins, &self.value_locals[&value]);
        let function = match mode {
            Reference::Retain => functions.retain,
            Reference::Release => functions.release,
        };
        ins.call(function);
    }

    fn transfer_roots(
        &self,
        ins: &mut InstructionSink<'_>,
        helpers: DynamicHelpers,
        roots: &BTreeSet<ValueId>,
        destinations: Vec<ValueId>,
    ) {
        let transfers = RootTransfers::new(roots, destinations);
        for value in transfers.retained {
            self.reference(ins, helpers, value, Reference::Retain);
        }
        for value in transfers.released {
            self.reference(ins, helpers, value, Reference::Release);
        }
    }
}

#[derive(Clone, Copy)]
enum Reference {
    Retain,
    Release,
}

struct RootTransfers {
    retained: Vec<ValueId>,
    released: Vec<ValueId>,
}

impl RootTransfers {
    fn new(roots: &BTreeSet<ValueId>, destinations: Vec<ValueId>) -> Self {
        let mut seen = BTreeSet::new();
        let mut retained = Vec::new();
        for value in destinations {
            assert!(
                roots.contains(&value),
                "continuation destination has a current root"
            );
            if !seen.insert(value) {
                retained.push(value);
            }
        }
        Self {
            retained,
            released: roots.difference(&seen).copied().collect(),
        }
    }
}

fn edge_values(function: &RuntimeFunction, edge: &Edge) -> Vec<ValueId> {
    let mut values = edge
        .arguments
        .iter()
        .filter_map(|argument| match argument {
            Argument::Value(value) => Some(*value),
            Argument::Result => None,
        })
        .collect::<Vec<_>>();
    values.extend(
        function.continuations[edge.target.0]
            .captures
            .iter()
            .map(|capture| capture.value),
    );
    values
}

fn continuation_state(id: ContinuationId) -> u32 {
    u32::try_from(id.0)
        .expect("continuation id fits memory32")
        .checked_mul(2)
        .expect("continuation state fits memory32")
}

fn host_import<'a>(
    target: &CallTarget,
    manifest: &'a AbiManifest,
) -> Option<(usize, SuspensionImport<'a>)> {
    match target {
        CallTarget::Host {
            capability,
            operation,
        } => {
            let (ordinal, imported) = manifest
                .imports
                .iter()
                .enumerate()
                .find(|(_, imported)| {
                    imported.capability == *capability && imported.operation == *operation
                })
                .expect("checked host call has an ABI import");
            Some((
                ordinal,
                SuspensionImport {
                    function: &imported.function,
                    suspends: imported.contract.suspends,
                },
            ))
        }
        CallTarget::Link { unit, name } => {
            let (ordinal, link) = manifest
                .links
                .iter()
                .enumerate()
                .find(|(_, link)| link.unit == *unit && link.name == *name)
                .expect("checked external call has an ABI link");
            Some((
                manifest.imports.len() + ordinal,
                SuspensionImport {
                    function: &link.function,
                    suspends: link.suspends,
                },
            ))
        }
        CallTarget::Function { .. } => None,
    }
}

fn mem(offset: u32) -> wasm_encoder::MemArg {
    wasm_encoder::MemArg {
        offset: u64::from(offset),
        align: 0,
        memory_index: 0,
    }
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
    direct: &HashMap<FunctionId, u32>,
    types: &mut FunctionTypes,
    functions: &mut FunctionSection,
    code: &mut CodeSection,
    hints: &mut BranchHints,
    imports: u32,
) -> Result<Vec<(String, u32)>, String> {
    let framed = module
        .functions
        .iter()
        .filter(|function| function.framed)
        .map(|function| function.id)
        .collect::<BTreeSet<_>>();
    let callbacks = module
        .types
        .iter()
        .filter_map(|type_| {
            if let RuntimeType::Callback { function, .. } = type_ {
                Some(FunctionId(*function))
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>();
    let mut frames = module
        .functions
        .iter()
        .filter(|function| function.framed)
        .map(|function| {
            Ok((
                function.id,
                Frame::new(module, layouts, function, manifest)?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let tail_edges = module
        .functions
        .iter()
        .filter(|function| function.framed)
        .flat_map(|function| {
            function.continuations.iter().filter_map(|continuation| {
                let RuntimeTransition::Call {
                    target: CallTarget::Function { function: target },
                    next,
                    ..
                } = &continuation.transition
                else {
                    return None;
                };
                if framed.contains(target) && function.returns_call_result(next) {
                    Some((function.id, *target))
                } else {
                    None
                }
            })
        })
        .collect::<Vec<_>>();
    let mut roots = callbacks;
    roots.extend(module.exports.iter().filter_map(|exported| {
        if let RuntimeExport::Runtime { function, .. } = exported {
            Some(FunctionId(*function))
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
        let function_id = FunctionId(*function);
        if !module
            .functions
            .iter()
            .any(|function| function.id == function_id && function.suspends)
        {
            continue;
        }
        let frame = frames
            .get(&function_id)
            .expect("suspending export has a frame");
        let signature = &module.signatures[*signature];
        let public = manifest
            .exports
            .iter()
            .find(|exported| exported.name.as_deref() == Some(wasm_name))
            .expect("checked runtime export")
            .function
            .as_ref()
            .expect("runtime export function");
        let parameters = std::iter::once(ValType::I32)
            .chain(public.parameters.iter().flat_map(flattened_type))
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
                function_id,
                frame,
                public,
                signature,
                helpers,
            )?,
        )?;
        exports.push((wasm_name.clone(), index));
    }
    for function_id in module
        .types
        .iter()
        .filter_map(|type_| {
            if let RuntimeType::Callback { function, .. } = type_ {
                Some(FunctionId(*function))
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>()
    {
        let function = module
            .functions
            .iter()
            .find(|function| function.id == function_id)
            .expect("checked callback function");
        let public = &manifest
            .callbacks
            .iter()
            .find(|callback| callback.name == format!("blot:callback:{}", function_id.0))
            .expect("checked callback adapter")
            .function;
        let parameters = std::iter::once(ValType::I32)
            .chain(public.parameters.iter().flat_map(flattened_type))
            .collect();
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
                function_id,
                &frames[&function_id],
                public,
                &module.signatures[function.signature.0],
                helpers,
            )?,
        )?;
        exports.push((format!("blot:callback:{}", function_id.0), index));
    }
    let mut controls = Vec::new();
    if !framed.is_empty() {
        controls.extend([
            (
                "blot:poll",
                vec![ValType::I32; 3],
                vec![ValType::I32],
                poll(&steps, helpers),
            ),
            (
                "blot:resume",
                vec![ValType::I32; 2],
                Vec::new(),
                resume(helpers),
            ),
            (
                "blot:cancel",
                vec![ValType::I32; 2],
                Vec::new(),
                cancel(helpers),
            ),
            (
                "blot:release",
                vec![ValType::I32; 2],
                Vec::new(),
                release(helpers),
            ),
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
    frames: &BTreeMap<FunctionId, Frame>,
    manifest: &AbiManifest,
    helpers: DynamicHelpers,
    static_data: &StaticData,
    direct: &HashMap<FunctionId, u32>,
    roots: &BTreeSet<FunctionId>,
) -> Result<Function, String> {
    let mut locals = frame.lane_types.clone();
    let pointer = locals.len() as u32 + 2;
    locals.extend([ValType::I32; 3]);
    let mut call_results = HashMap::new();
    for continuation in &function.continuations {
        let RuntimeTransition::Call { signature, .. } = &continuation.transition else {
            continue;
        };
        let lanes = layouts.flattened(module, module.signatures[signature.0].result)?;
        let first = locals.len() as u32 + 2;
        call_results.insert(
            continuation.id,
            (first..first + lanes.len() as u32).collect::<Vec<_>>(),
        );
        locals.extend_from_slice(lanes);
    }
    let mut body = Function::new(compact_local_declarations(&locals));
    let mut ins = body.instructions();
    let facts = FunctionEmissionFacts {
        runtime_layouts: layouts,
        value_locals: &frame.value_locals,
        value_types: &frame.value_types,
    };
    for continuation in &function.continuations {
        let lifetimes = lifetimes::ContinuationLifetimes::new(function, continuation);
        let state = continuation_state(continuation.id);
        ins.local_get(1)
            .i32_load(mem(4))
            .i32_const(state as i32)
            .i32_eq()
            .if_(BlockType::Empty);
        frame.load(&mut ins, continuation.id);
        for value in &lifetimes.entry_drops {
            frame.reference(&mut ins, helpers, *value, Reference::Release);
        }
        for (instruction, drops) in continuation
            .instructions
            .iter()
            .zip(&lifetimes.instruction_drops)
        {
            emit_instruction(
                &mut ins,
                module,
                function,
                instruction,
                helpers,
                static_data,
                facts,
                pointer,
                pointer + 1,
                pointer + 2,
            )?;
            for value in drops {
                frame.reference(&mut ins, helpers, *value, Reference::Release);
            }
        }
        match &continuation.transition {
            RuntimeTransition::Jump { edge } => {
                frame.transfer_roots(
                    &mut ins,
                    helpers,
                    &lifetimes.transition_roots,
                    edge_values(function, edge),
                );
                frame.save_edge(&mut ins, function, edge, None);
            }
            RuntimeTransition::Branch {
                condition,
                consequent,
                alternate,
            } => {
                ins.local_get(frame.value_locals[condition][0])
                    .if_(BlockType::Empty);
                frame.transfer_roots(
                    &mut ins,
                    helpers,
                    &lifetimes.transition_roots,
                    edge_values(function, consequent),
                );
                frame.save_edge(&mut ins, function, consequent, None);
                ins.else_();
                frame.transfer_roots(
                    &mut ins,
                    helpers,
                    &lifetimes.transition_roots,
                    edge_values(function, alternate),
                );
                frame.save_edge(&mut ins, function, alternate, None);
                ins.end();
            }
            RuntimeTransition::Switch {
                selector,
                cases,
                fallback,
            } => {
                for (value, edge) in cases {
                    ins.local_get(frame.value_locals[selector][0]);
                    match value {
                        WireConstant::SignedInteger32(_) => {
                            ins.i32_const(switch_case_integer(value)? as i32).i32_eq();
                        }
                        WireConstant::SignedInteger64(_) => {
                            ins.i64_const(switch_case_integer(value)?).i64_eq();
                        }
                        _ => return Err("resumable switch requires integer cases".to_owned()),
                    }
                    ins.if_(BlockType::Empty);
                    frame.transfer_roots(
                        &mut ins,
                        helpers,
                        &lifetimes.transition_roots,
                        edge_values(function, edge),
                    );
                    frame.save_edge(&mut ins, function, edge, None);
                    ins.return_().end();
                }
                frame.transfer_roots(
                    &mut ins,
                    helpers,
                    &lifetimes.transition_roots,
                    edge_values(function, fallback),
                );
                frame.save_edge(&mut ins, function, fallback, None);
            }
            RuntimeTransition::Call {
                target,
                signature,
                arguments,
                next,
                ..
            } => {
                if let Some((ordinal, imported)) = host_import(target, manifest)
                    && imported.suspends
                {
                    ins.local_get(1)
                        .i32_const(frame.argument_offset as i32)
                        .i32_add()
                        .local_set(pointer);
                    ins.local_get(0)
                        .local_get(pointer)
                        .i32_store(mem(ARGUMENTS));
                    let mut offset = 0;
                    for (operand, type_) in arguments.iter().zip(&imported.function.parameters) {
                        let layout = memory_layout(type_);
                        offset = align_to(offset, layout.alignment);
                        ins.local_get(pointer).i32_const(offset as i32).i32_add();
                        emit_local_values(&mut ins, &frame.value_locals[operand]);
                        ins.call(helpers.canonical.types[&frame.value_types[operand]].upper);
                        offset += layout.size;
                    }
                    // Canonical argument copies survive until the host response is
                    // lowered, so argument-only private roots can retire now.
                    frame.transfer_roots(
                        &mut ins,
                        helpers,
                        &lifetimes.transition_roots,
                        edge_values(function, next),
                    );
                    frame.save_edge(&mut ins, function, next, None);
                    constant_word(&mut ins, 1, 4, state + 1);
                    ins.local_get(0)
                        .local_get(1)
                        .i32_const(frame.result_offset as i32)
                        .i32_add()
                        .i32_store(mem(PENDING_RESULT));
                    constant_word(&mut ins, 0, IMPORT, ordinal as u32);
                    constant_word(&mut ins, 0, STATUS, 1);
                } else if let CallTarget::Function { function: target } = target
                    && let Some(child) = frames.get(target)
                {
                    let callee = &module.functions[target.0];
                    let entry = &callee.continuations[callee.entry.0];
                    let tail = function.returns_call_result(next);
                    let mut destinations = arguments.clone();
                    if tail {
                        ins.local_get(1).local_set(pointer);
                    } else {
                        destinations.extend(edge_values(function, next));
                        frame.save_edge(&mut ins, function, next, None);
                        constant_word(&mut ins, 1, 4, state + 1);
                        allocate(&mut ins, helpers.allocator.alloc, child.size(), pointer);
                        ins.local_get(pointer)
                            .i32_const(allocation::FRAME as i32)
                            .i32_const(0)
                            .i32_const(0)
                            .call(helpers.allocator.set_layout)
                            .local_get(pointer)
                            .local_get(1)
                            .i32_store(mem(8))
                            .local_get(pointer)
                            .local_get(1)
                            .i32_const(frame.result_offset as i32)
                            .i32_add()
                            .i32_store(mem(12));
                    }
                    frame.transfer_roots(
                        &mut ins,
                        helpers,
                        &lifetimes.transition_roots,
                        destinations,
                    );
                    constant_word(&mut ins, pointer, 0, target.0 as u32);
                    constant_word(&mut ins, pointer, 4, continuation_state(callee.entry));
                    for (operand, parameter) in arguments.iter().zip(&entry.parameters) {
                        child.store_value(
                            &mut ins,
                            callee.entry,
                            parameter.value,
                            &frame.value_locals[operand],
                            pointer,
                        );
                    }
                    ins.local_get(0).local_get(pointer).i32_store(mem(0));
                } else {
                    let result = &call_results[&continuation.id];
                    let direct_call = matches!(target, CallTarget::Function { .. });
                    if direct_call {
                        let mut destinations = edge_values(function, next);
                        destinations.extend(arguments.iter().copied());
                        frame.transfer_roots(
                            &mut ins,
                            helpers,
                            &lifetimes.transition_roots,
                            destinations,
                        );
                        frame.save_edge(&mut ins, function, next, None);
                    }
                    emit_call(
                        &mut ins,
                        module,
                        target,
                        *signature,
                        arguments,
                        result,
                        manifest,
                        helpers,
                        facts,
                        pointer,
                        pointer + 1,
                        direct,
                    )?;
                    if !direct_call {
                        frame.transfer_roots(
                            &mut ins,
                            helpers,
                            &lifetimes.transition_roots,
                            edge_values(function, next),
                        );
                    }
                    frame.save_edge(&mut ins, function, next, Some(result));
                }
            }
            RuntimeTransition::Return { value } => {
                ins.local_get(1)
                    .i32_load(mem(8))
                    .local_tee(pointer + 1)
                    .i32_eqz()
                    .if_(BlockType::Empty);
                if roots.contains(&function.id) {
                    let result_type = module.signatures[function.signature.0].result;
                    ins.local_get(0).i32_load(mem(RESULT));
                    emit_local_values(&mut ins, &frame.value_locals[value]);
                    ins.call(helpers.canonical.types[&result_type].upper);
                    frame.reference(&mut ins, helpers, *value, Reference::Release);
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
                    .local_get(pointer + 1)
                    .i32_store(mem(0))
                    .local_get(1)
                    .call(helpers.allocator.release);
            }
            RuntimeTransition::Trap { .. } => {
                ins.unreachable();
            }
        }
        ins.return_().end();
        let RuntimeTransition::Call {
            target,
            signature,
            next,
            ..
        } = &continuation.transition
        else {
            continue;
        };
        let imported = host_import(target, manifest).filter(|(_, imported)| imported.suspends);
        let child =
            matches!(target, CallTarget::Function { function } if frames.contains_key(function));
        if imported.is_none() && !child {
            continue;
        }
        // Completion installs the owned result once. The saved successor roots
        // already belong to the frame and must not be retained or dropped again.
        ins.local_get(1)
            .i32_load(mem(4))
            .i32_const((state + 1) as i32)
            .i32_eq()
            .if_(BlockType::Empty);
        let result = &call_results[&continuation.id];
        let result_type = module.signatures[signature.0].result;
        if imported.is_some() {
            ins.local_get(0)
                .i32_load(mem(PENDING_RESULT))
                .local_set(pointer)
                .local_get(pointer)
                .i32_const(result_type as i32)
                .call(helpers.canonical_validator)
                .local_get(pointer)
                .call(helpers.canonical.types[&result_type].lower);
            for local in result.iter().rev() {
                ins.local_set(*local);
            }
            ins.local_get(0)
                .i32_load(mem(SCOPE_TOKEN))
                .call(helpers.allocator.clear_temporaries);
        } else {
            for (index, (local, type_)) in result
                .iter()
                .zip(layouts.flattened(module, result_type)?)
                .enumerate()
            {
                ins.local_get(1);
                load_lane(
                    &mut ins,
                    *type_,
                    frame.result_offset + index as u32 * LANE_SIZE,
                );
                ins.local_set(*local);
            }
        }
        let successor = &function.continuations[next.target.0];
        for (argument, parameter) in next.arguments.iter().zip(&successor.parameters) {
            if matches!(argument, Argument::Result) {
                frame.store_value(&mut ins, next.target, parameter.value, result, 1);
            }
        }
        constant_word(&mut ins, 1, 4, continuation_state(next.target));
        ins.return_().end();
    }
    ins.unreachable().end();
    Ok(body)
}

fn start(
    module: &RuntimeModule,
    _layouts: &RuntimeTypeLayouts,
    id: FunctionId,
    frame: &Frame,
    public: &AbiFunction,
    signature: &crate::hir::RuntimeSignature,
    helpers: DynamicHelpers,
) -> Result<Function, String> {
    let count = 1 + public.parameters.iter().flat_map(flattened_type).count() as u32;
    let context = count;
    let pointer = count + 1;
    let temporary = count + 2;
    let mut locals = vec![ValType::I32; 3];
    locals.extend_from_slice(&frame.lane_types);
    let mut body = Function::new(compact_local_declarations(&locals));
    let mut ins = body.instructions();
    ins.local_get(0).call(helpers.allocator.select);
    begin_call(&mut ins, u32::MAX, helpers);
    allocate(&mut ins, helpers.allocator.alloc, CONTEXT_SIZE, context);
    for offset in (0..CONTEXT_SIZE).step_by(4) {
        constant_word(&mut ins, context, offset, 0);
    }
    ins.local_get(context)
        .local_get(0)
        .i32_store(mem(SCOPE_TOKEN))
        .global_get(helpers.allocation_globals.current_scope)
        .local_get(context)
        .i32_store(mem(allocation::SCOPE_ACTIVE_EXPORT));
    allocate(
        &mut ins,
        helpers.allocator.alloc,
        memory_layout(&public.result).size.max(1),
        pointer,
    );
    ins.local_get(context)
        .local_get(pointer)
        .i32_store(mem(RESULT));
    allocate(&mut ins, helpers.allocator.alloc, frame.size(), pointer);
    ins.local_get(pointer)
        .i32_const(allocation::FRAME as i32)
        .i32_const(0)
        .i32_const(0)
        .call(helpers.allocator.set_layout);
    ins.local_get(context).local_get(pointer).i32_store(mem(0));
    constant_word(&mut ins, pointer, 0, id.0 as u32);
    let function = &module.functions[id.0];
    constant_word(&mut ins, pointer, 4, continuation_state(function.entry));
    constant_word(&mut ins, pointer, 8, 0);
    constant_word(&mut ins, pointer, 12, 0);
    let entry = &function.continuations[function.entry.0];
    let mut first = 1;
    for ((parameter, type_id), public_type) in entry
        .parameters
        .iter()
        .zip(&signature.parameters)
        .zip(&public.parameters)
    {
        let layout = memory_layout(public_type);
        allocate(
            &mut ins,
            helpers.allocator.alloc,
            layout.size.max(1),
            temporary,
        );
        let width = flattened_type(public_type).len() as u32;
        let sources = (first..first + width).collect::<Vec<_>>();
        let mut flat = 0;
        emit_store_canonical_result(&mut ins, public_type, &sources, &mut flat, temporary, 0)?;
        ins.local_get(temporary)
            .i32_const(*type_id as i32)
            .call(helpers.canonical_validator)
            .local_get(temporary)
            .call(helpers.canonical.types[type_id].lower);
        let translated = frame.value_locals[&parameter.value]
            .iter()
            .map(|local| count + 1 + local)
            .collect::<Vec<_>>();
        for local in translated.iter().rev() {
            ins.local_set(*local);
        }
        frame.store_value(
            &mut ins,
            function.entry,
            parameter.value,
            &translated,
            pointer,
        );
        ins.local_get(temporary).call(helpers.allocator.release);
        first += width;
    }
    ins.local_get(0)
        .call(helpers.allocator.clear_temporaries)
        .local_get(context)
        .end();
    Ok(body)
}

fn select_context(ins: &mut InstructionSink<'_>, helpers: DynamicHelpers) {
    ins.local_get(0)
        .call(helpers.allocator.select)
        .local_get(1)
        .i32_load(mem(SCOPE_TOKEN))
        .local_get(0)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(helpers.allocation_globals.current_scope)
        .i32_load(mem(allocation::SCOPE_ACTIVE_EXPORT))
        .local_get(1)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
}

fn poll(steps: &BTreeMap<FunctionId, u32>, helpers: DynamicHelpers) -> Function {
    let mut body = Function::new([(2, ValType::I32)]);
    let mut ins = body.instructions();
    select_context(&mut ins, helpers);
    ins.local_get(1)
        .i32_load(mem(STATUS))
        .local_tee(3)
        .i32_eqz()
        .local_get(3)
        .i32_const(4)
        .i32_eq()
        .i32_or()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 1, STATUS, 0);
    ins.loop_(BlockType::Empty)
        .local_get(2)
        .i32_eqz()
        .if_(BlockType::Empty);
    constant_word(&mut ins, 1, STATUS, 4);
    ins.i32_const(4)
        .return_()
        .end()
        .local_get(2)
        .i32_const(1)
        .i32_sub()
        .local_set(2)
        .local_get(1)
        .i32_load(mem(0))
        .local_tee(4)
        .i32_load(mem(0))
        .local_set(3)
        .block(BlockType::Empty);
    for (id, index) in steps {
        ins.local_get(3)
            .i32_const(id.0 as i32)
            .i32_eq()
            .if_(BlockType::Empty)
            .local_get(1)
            .local_get(4)
            .call(*index)
            .br(1)
            .end();
    }
    ins.unreachable()
        .end()
        .local_get(1)
        .i32_load(mem(STATUS))
        .local_tee(3)
        .if_(BlockType::Empty)
        .local_get(3)
        .return_()
        .end()
        .br(0)
        .end()
        .unreachable()
        .end();
    body
}

fn resume(helpers: DynamicHelpers) -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    select_context(&mut ins, helpers);
    ins.local_get(1)
        .i32_load(mem(STATUS))
        .i32_const(1)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 1, STATUS, 0);
    ins.end();
    body
}

fn cancel(helpers: DynamicHelpers) -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    select_context(&mut ins, helpers);
    ins.local_get(1)
        .i32_load(mem(STATUS))
        .i32_const(4)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 1, STATUS, 3);
    // Cancellation drains host work before scope exit frees unreachable frames.
    ins.end();
    body
}

fn release(helpers: DynamicHelpers) -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    select_context(&mut ins, helpers);
    ins.local_get(1)
        .i32_load(mem(STATUS))
        .local_tee(2)
        .i32_const(2)
        .i32_eq()
        .local_get(2)
        .i32_const(3)
        .i32_eq()
        .i32_or()
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    constant_word(&mut ins, 1, STATUS, 5);
    ins.local_get(0)
        .call(helpers.allocator.clear_temporaries)
        .local_get(1)
        .i32_load(mem(RESULT))
        .call(helpers.allocator.release)
        .global_get(helpers.allocation_globals.current_scope)
        .i32_const(-1)
        .i32_store(mem(allocation::SCOPE_ACTIVE_EXPORT))
        .local_get(1)
        .call(helpers.allocator.release)
        .end();
    body
}
