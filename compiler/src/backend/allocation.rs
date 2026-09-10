use super::{FunctionTypes, add_i32_global, append_code_function};
use wasm_encoder::{
    BlockType, BranchHints, CodeSection, Function, FunctionSection, GlobalSection, InstructionSink,
    MemArg, ValType,
};

pub(super) const HEADER_SIZE: u32 = 48;
pub(super) const CAPACITY: u32 = 0;
pub(super) const INITIALIZED_BYTES: u32 = 4;
pub(super) const REFERENCES: u32 = 8;
pub(super) const KIND: u32 = 12;
pub(super) const ELEMENT_TYPE: u32 = 16;
pub(super) const ELEMENT_COUNT: u32 = 20;
pub(super) const SCOPE: u32 = 24;
const FLAGS: u32 = 28;
const PREVIOUS: u32 = 32;
const NEXT: u32 = 36;
const AUX_PREVIOUS: u32 = 40;
const AUX_NEXT: u32 = 44;
pub(super) const BYTES: u32 = 0;
pub(super) const ELEMENTS: u32 = 1;
pub(super) const INDIRECT: u32 = 2;
pub(super) const FRAME: u32 = 3;
const FRESH: i32 = 8;
const TEMPORARY: i32 = 1;
const FREE: i32 = 2;
const QUEUED: i32 = 4;
const CLASS_COUNT: u32 = 28;
pub(super) const SCOPE_SIZE: u32 = 32;
pub(super) const SCOPE_TOKEN: u32 = 0;
const SCOPE_PREVIOUS: u32 = 4;
const SCOPE_NEXT: u32 = 8;
const SCOPE_ALLOCATIONS: u32 = 12;
const SCOPE_TEMPORARIES: u32 = 16;
pub(super) const SCOPE_ACTIVE_EXPORT: u32 = 20;
pub(super) const SCOPE_RESULT: u32 = 24;

#[derive(Clone, Copy)]
pub(super) struct Globals {
    pub heap: u32,
    pub current_scope: u32,
    pub active_scopes: u32,
    pub next_token: u32,
    pub live_bytes: u32,
    pub live_allocations: u32,
    pub live_scopes: u32,
    pub free_scopes: u32,
    pub pending_drops: u32,
    pub dropping: u32,
    pub free_lists: u32,
}

impl Globals {
    pub(super) fn append(globals: &mut GlobalSection, heap: u32) -> Self {
        let first = globals.len();
        for _ in 0..9 + CLASS_COUNT {
            add_i32_global(globals, 0, true);
        }
        Self {
            heap,
            current_scope: first,
            active_scopes: first + 1,
            next_token: first + 2,
            live_bytes: first + 3,
            live_allocations: first + 4,
            live_scopes: first + 5,
            free_scopes: first + 6,
            pending_drops: first + 7,
            dropping: first + 8,
            free_lists: first + 9,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Functions {
    take: u32,
    recycle: u32,
    pub temporary: u32,
    remove_temporary: u32,
    pub select: u32,
    pub enter: u32,
    pub leave: u32,
    pub alloc: u32,
    pub realloc: u32,
    pub retain: u32,
    pub release: u32,
    pub set_layout: u32,
    pub clear_temporaries: u32,
    pub claim: u32,
    pub live_bytes: u32,
    pub live_allocations: u32,
    pub live_scopes: u32,
}

impl Functions {
    pub(super) fn declare(
        types: &mut FunctionTypes,
        functions: &mut FunctionSection,
        imports: u32,
    ) -> Self {
        let first = imports + functions.len();
        for (parameters, results) in [
            (1, 1),
            (1, 0),
            (1, 0),
            (1, 0),
            (1, 0),
            (0, 1),
            (1, 0),
            (4, 1),
            (5, 1),
            (1, 0),
            (1, 0),
            (4, 0),
            (1, 0),
            (1, 0),
            (0, 1),
            (0, 1),
            (0, 1),
        ] {
            functions.function(
                types.intern(vec![ValType::I32; parameters], vec![ValType::I32; results]),
            );
        }
        Self {
            take: first,
            recycle: first + 1,
            temporary: first + 2,
            remove_temporary: first + 3,
            select: first + 4,
            enter: first + 5,
            leave: first + 6,
            alloc: first + 7,
            realloc: first + 8,
            retain: first + 9,
            release: first + 10,
            set_layout: first + 11,
            clear_temporaries: first + 12,
            claim: first + 13,
            live_bytes: first + 14,
            live_allocations: first + 15,
            live_scopes: first + 16,
        }
    }

    pub(super) fn emit(
        self,
        code: &mut CodeSection,
        hints: &mut BranchHints,
        globals: Globals,
        heap_start: u32,
        drop_children: u32,
    ) -> Result<(), String> {
        let bodies = [
            take(globals),
            recycle(globals),
            temporary(),
            remove_temporary(),
            select(globals),
            enter(self, globals),
            leave(self, globals),
            alloc(self, globals, heap_start),
            realloc(self),
            retain(heap_start),
            release(self, globals, heap_start, drop_children),
            set_layout(heap_start),
            clear_temporaries(self, globals),
            claim(self, heap_start),
            statistic(globals.live_bytes),
            statistic(globals.live_allocations),
            statistic(globals.live_scopes),
        ];
        for (offset, body) in bodies.into_iter().enumerate() {
            append_code_function(code, hints, self.take + offset as u32, body)?;
        }
        Ok(())
    }
}

fn mem(offset: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

fn header(ins: &mut InstructionSink<'_>, owner: u32) {
    ins.local_get(owner).i32_const(HEADER_SIZE as i32).i32_sub();
}

fn read(ins: &mut InstructionSink<'_>, owner: u32, offset: u32) {
    header(ins, owner);
    ins.i32_load(mem(offset));
}

fn write_constant(ins: &mut InstructionSink<'_>, owner: u32, offset: u32, value: i32) {
    header(ins, owner);
    ins.i32_const(value).i32_store(mem(offset));
}

fn require_owner(ins: &mut InstructionSink<'_>, heap_start: u32) {
    ins.local_get(0)
        .i32_const(heap_start as i32)
        .i32_lt_u()
        .local_get(0)
        .i32_const(15)
        .i32_and()
        .i32_eqz()
        .i32_eqz()
        .i32_or()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    read(ins, 0, FLAGS);
    ins.i32_const(FREE | QUEUED)
        .i32_and()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    read(ins, 0, REFERENCES);
    ins.i32_eqz().if_(BlockType::Empty).unreachable().end();
}

fn take(globals: Globals) -> Function {
    // Size classes bound the search independently of the number of live or freed allocations.
    let capacity = 1;
    let owner = 2;
    let end = 3;
    let pages = 4;
    let mut body = Function::new([(4, ValType::I32)]);
    let mut ins = body.instructions();
    ins.i32_const(16)
        .local_set(capacity)
        .block(BlockType::Empty);
    for class in 0..CLASS_COUNT {
        ins.local_get(0)
            .local_get(capacity)
            .i32_le_u()
            .if_(BlockType::Empty)
            .global_get(globals.free_lists + class)
            .local_tee(owner)
            .if_(BlockType::Empty);
        read(&mut ins, owner, AUX_NEXT);
        ins.global_set(globals.free_lists + class);
        write_constant(&mut ins, owner, FLAGS, 0);
        ins.local_get(owner).return_().end().br(1).end();
        if class + 1 < CLASS_COUNT {
            ins.local_get(capacity)
                .i32_const(1)
                .i32_shl()
                .local_set(capacity);
        }
    }
    ins.unreachable()
        .end()
        .global_get(globals.heap)
        .i32_const(15)
        .i32_add()
        .i32_const(-16)
        .i32_and()
        .i32_const(HEADER_SIZE as i32)
        .i32_add()
        .local_tee(owner)
        .global_get(globals.heap)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(owner)
        .local_get(capacity)
        .i32_add()
        .local_tee(end)
        .local_get(owner)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(end)
        .i32_const(1)
        .i32_sub()
        .i32_const(16)
        .i32_shr_u()
        .i32_const(1)
        .i32_add()
        .local_tee(pages)
        .memory_size(0)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .local_get(pages)
        .memory_size(0)
        .i32_sub()
        .memory_grow(0)
        .i32_const(-1)
        .i32_eq()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .end();
    header(&mut ins, owner);
    ins.i32_const(0)
        .i32_const(HEADER_SIZE as i32)
        .memory_fill(0);
    header(&mut ins, owner);
    ins.local_get(capacity)
        .i32_store(mem(CAPACITY))
        .local_get(end)
        .global_set(globals.heap)
        .local_get(owner)
        .end();
    body
}

fn recycle(globals: Globals) -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    write_constant(&mut ins, 0, FLAGS, FREE);
    read(&mut ins, 0, CAPACITY);
    ins.local_set(1);
    for class in 0..CLASS_COUNT {
        ins.local_get(1)
            .i32_const((16_u32 << class) as i32)
            .i32_eq()
            .if_(BlockType::Empty);
        header(&mut ins, 0);
        ins.global_get(globals.free_lists + class)
            .i32_store(mem(AUX_NEXT))
            .local_get(0)
            .global_set(globals.free_lists + class)
            .return_()
            .end();
    }
    ins.unreachable().end();
    body
}

fn select(globals: Globals) -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .global_get(globals.active_scopes)
        .local_set(1)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(1)
        .i32_eqz()
        .br_if(1)
        .local_get(1)
        .i32_load(mem(SCOPE_TOKEN))
        .local_get(0)
        .i32_eq()
        .if_(BlockType::Empty)
        .local_get(1)
        .global_set(globals.current_scope)
        .return_()
        .end()
        .local_get(1)
        .i32_load(mem(SCOPE_NEXT))
        .local_set(1)
        .br(0)
        .end()
        .end()
        .unreachable()
        .end();
    body
}

fn enter(functions: Functions, globals: Globals) -> Function {
    let mut body = Function::new([(2, ValType::I32)]);
    let mut ins = body.instructions();
    let scope = 0;
    let token = 1;
    ins.global_get(globals.next_token)
        .i32_const(1)
        .i32_add()
        .local_tee(token)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(token)
        .global_set(globals.next_token)
        .global_get(globals.free_scopes)
        .local_tee(scope)
        .if_(BlockType::Empty)
        .local_get(scope)
        .i32_load(mem(SCOPE_NEXT))
        .global_set(globals.free_scopes)
        .else_()
        .i32_const(SCOPE_SIZE as i32)
        .call(functions.take)
        .local_set(scope)
        .end()
        .local_get(scope)
        .i32_const(0)
        .i32_const(SCOPE_SIZE as i32)
        .memory_fill(0)
        .local_get(scope)
        .local_get(token)
        .i32_store(mem(SCOPE_TOKEN))
        .local_get(scope)
        .global_get(globals.active_scopes)
        .i32_store(mem(SCOPE_NEXT))
        .global_get(globals.active_scopes)
        .if_(BlockType::Empty)
        .global_get(globals.active_scopes)
        .local_get(scope)
        .i32_store(mem(SCOPE_PREVIOUS))
        .end()
        .local_get(scope)
        .global_set(globals.active_scopes)
        .local_get(scope)
        .global_set(globals.current_scope)
        .global_get(globals.live_scopes)
        .i32_const(1)
        .i32_add()
        .global_set(globals.live_scopes)
        .local_get(token)
        .end();
    body
}

fn temporary() -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    read(&mut ins, 0, FLAGS);
    ins.i32_const(TEMPORARY)
        .i32_and()
        .if_(BlockType::Empty)
        .return_()
        .end();
    read(&mut ins, 0, SCOPE);
    ins.local_set(1);
    header(&mut ins, 0);
    ins.local_get(1)
        .i32_load(mem(SCOPE_TEMPORARIES))
        .i32_store(mem(AUX_NEXT));
    write_constant(&mut ins, 0, AUX_PREVIOUS, 0);
    ins.local_get(1)
        .i32_load(mem(SCOPE_TEMPORARIES))
        .if_(BlockType::Empty)
        .local_get(1)
        .i32_load(mem(SCOPE_TEMPORARIES))
        .i32_const(HEADER_SIZE as i32)
        .i32_sub()
        .local_get(0)
        .i32_store(mem(AUX_PREVIOUS))
        .end()
        .local_get(1)
        .local_get(0)
        .i32_store(mem(SCOPE_TEMPORARIES));
    header(&mut ins, 0);
    read(&mut ins, 0, FLAGS);
    ins.i32_const(!FRESH)
        .i32_and()
        .i32_const(TEMPORARY)
        .i32_or()
        .i32_store(mem(FLAGS));
    ins.end();
    body
}

fn remove_temporary() -> Function {
    let mut body = Function::new([(2, ValType::I32)]);
    let mut ins = body.instructions();
    read(&mut ins, 0, FLAGS);
    ins.i32_const(TEMPORARY)
        .i32_and()
        .i32_eqz()
        .if_(BlockType::Empty)
        .return_()
        .end();
    read(&mut ins, 0, AUX_PREVIOUS);
    ins.local_tee(1).if_(BlockType::Empty);
    header(&mut ins, 1);
    read(&mut ins, 0, AUX_NEXT);
    ins.i32_store(mem(AUX_NEXT)).else_();
    read(&mut ins, 0, SCOPE);
    read(&mut ins, 0, AUX_NEXT);
    ins.i32_store(mem(SCOPE_TEMPORARIES)).end();
    read(&mut ins, 0, AUX_NEXT);
    ins.local_tee(2).if_(BlockType::Empty);
    header(&mut ins, 2);
    ins.local_get(1).i32_store(mem(AUX_PREVIOUS)).end();
    header(&mut ins, 0);
    read(&mut ins, 0, FLAGS);
    ins.i32_const(!TEMPORARY).i32_and().i32_store(mem(FLAGS));
    write_constant(&mut ins, 0, AUX_PREVIOUS, 0);
    write_constant(&mut ins, 0, AUX_NEXT, 0);
    ins.end();
    body
}

fn unlink(ins: &mut InstructionSink<'_>, owner: u32, previous: u32, next: u32, globals: Globals) {
    read(ins, owner, PREVIOUS);
    ins.local_tee(previous).if_(BlockType::Empty);
    header(ins, previous);
    read(ins, owner, NEXT);
    ins.i32_store(mem(NEXT)).else_();
    read(ins, owner, SCOPE);
    read(ins, owner, NEXT);
    ins.i32_store(mem(SCOPE_ALLOCATIONS)).end();
    read(ins, owner, NEXT);
    ins.local_tee(next).if_(BlockType::Empty);
    header(ins, next);
    ins.local_get(previous)
        .i32_store(mem(PREVIOUS))
        .end()
        .global_get(globals.live_bytes);
    read(ins, owner, CAPACITY);
    ins.i32_sub()
        .global_set(globals.live_bytes)
        .global_get(globals.live_allocations)
        .i32_const(1)
        .i32_sub()
        .global_set(globals.live_allocations);
}

fn leave(functions: Functions, globals: Globals) -> Function {
    let mut body = Function::new([(4, ValType::I32)]);
    let mut ins = body.instructions();
    let scope = 1;
    let owner = 2;
    let previous = 3;
    let next = 4;
    ins.local_get(0)
        .call(functions.select)
        .global_get(globals.current_scope)
        .local_set(scope)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(scope)
        .i32_load(mem(SCOPE_ALLOCATIONS))
        .local_tee(owner)
        .i32_eqz()
        .br_if(1);
    // All invocation roots are dead here, including after a trap. Children belong
    // to this same scope, so bulk cleanup must not run their destructors twice.
    unlink(&mut ins, owner, previous, next, globals);
    ins.local_get(owner)
        .call(functions.recycle)
        .br(0)
        .end()
        .end()
        .local_get(scope)
        .i32_load(mem(SCOPE_PREVIOUS))
        .local_tee(previous)
        .if_(BlockType::Empty)
        .local_get(previous)
        .local_get(scope)
        .i32_load(mem(SCOPE_NEXT))
        .i32_store(mem(SCOPE_NEXT))
        .else_()
        .local_get(scope)
        .i32_load(mem(SCOPE_NEXT))
        .global_set(globals.active_scopes)
        .end()
        .local_get(scope)
        .i32_load(mem(SCOPE_NEXT))
        .local_tee(next)
        .if_(BlockType::Empty)
        .local_get(next)
        .local_get(previous)
        .i32_store(mem(SCOPE_PREVIOUS))
        .end()
        .local_get(scope)
        .i32_const(0)
        .i32_store(mem(SCOPE_TOKEN))
        .local_get(scope)
        .global_get(globals.free_scopes)
        .i32_store(mem(SCOPE_NEXT))
        .local_get(scope)
        .global_set(globals.free_scopes)
        .i32_const(0)
        .global_set(globals.current_scope)
        .global_get(globals.live_scopes)
        .i32_const(1)
        .i32_sub()
        .global_set(globals.live_scopes)
        .i32_const(0)
        .global_set(globals.pending_drops)
        .i32_const(0)
        .global_set(globals.dropping)
        .end();
    body
}

fn alloc(functions: Functions, globals: Globals, heap_start: u32) -> Function {
    let mut body = Function::new([(4, ValType::I32)]);
    let mut ins = body.instructions();
    let owner = 4;
    let scope = 5;
    let old_dynamic = 6;
    let copy_length = 7;
    ins.global_get(globals.current_scope)
        .local_tee(scope)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(2)
        .i32_const(1)
        .i32_lt_u()
        .local_get(2)
        .i32_const(16)
        .i32_gt_u()
        .i32_or()
        .local_get(2)
        .local_get(2)
        .i32_const(1)
        .i32_sub()
        .i32_and()
        .i32_eqz()
        .i32_eqz()
        .i32_or()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(0)
        .i32_const(heap_start as i32)
        .i32_ge_u()
        .local_get(0)
        .i32_eqz()
        .i32_eqz()
        .i32_and()
        .local_tee(old_dynamic)
        .if_(BlockType::Empty);
    require_owner(&mut ins, heap_start);
    read(&mut ins, 0, SCOPE);
    ins.local_get(scope)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    read(&mut ins, 0, REFERENCES);
    ins.i32_const(1)
        .i32_ne()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    ins.local_get(1);
    read(&mut ins, 0, CAPACITY);
    ins.i32_gt_u().if_(BlockType::Empty).unreachable().end();

    ins.end()
        .local_get(3)
        .i32_eqz()
        .if_(BlockType::Empty)
        .local_get(old_dynamic)
        .if_(BlockType::Empty)
        .local_get(0)
        .call(functions.release)
        .end()
        .i32_const(0)
        .return_()
        .end()
        .local_get(old_dynamic)
        .if_(BlockType::Empty)
        .local_get(3);
    read(&mut ins, 0, CAPACITY);
    ins.i32_le_u().if_(BlockType::Empty);
    header(&mut ins, 0);
    ins.local_get(3)
        .i32_store(mem(INITIALIZED_BYTES))
        .local_get(0)
        .return_()
        .end()
        .end()
        .local_get(3)
        .call(functions.take)
        .local_set(owner);
    for offset in (INITIALIZED_BYTES..HEADER_SIZE).step_by(4) {
        write_constant(&mut ins, owner, offset, 0);
    }
    header(&mut ins, owner);
    ins.local_get(3).i32_store(mem(INITIALIZED_BYTES));
    write_constant(&mut ins, owner, REFERENCES, 1);
    write_constant(&mut ins, owner, FLAGS, FRESH);
    header(&mut ins, owner);
    ins.local_get(scope).i32_store(mem(SCOPE));
    header(&mut ins, owner);
    ins.local_get(scope)
        .i32_load(mem(SCOPE_ALLOCATIONS))
        .i32_store(mem(NEXT))
        .local_get(scope)
        .i32_load(mem(SCOPE_ALLOCATIONS))
        .if_(BlockType::Empty)
        .local_get(scope)
        .i32_load(mem(SCOPE_ALLOCATIONS))
        .i32_const(HEADER_SIZE as i32)
        .i32_sub()
        .local_get(owner)
        .i32_store(mem(PREVIOUS))
        .end()
        .local_get(scope)
        .local_get(owner)
        .i32_store(mem(SCOPE_ALLOCATIONS))
        .global_get(globals.live_bytes);
    read(&mut ins, owner, CAPACITY);
    ins.i32_add()
        .global_set(globals.live_bytes)
        .global_get(globals.live_allocations)
        .i32_const(1)
        .i32_add()
        .global_set(globals.live_allocations)
        .local_get(0)
        .if_(BlockType::Empty)
        .local_get(1)
        .local_get(3)
        .i32_lt_u()
        .if_(BlockType::Result(ValType::I32))
        .local_get(1)
        .else_()
        .local_get(3)
        .end()
        .local_set(copy_length)
        .local_get(owner)
        .local_get(0)
        .local_get(copy_length)
        .memory_copy(0, 0)
        .local_get(old_dynamic)
        .if_(BlockType::Empty);
    for offset in [KIND, ELEMENT_TYPE, ELEMENT_COUNT] {
        header(&mut ins, owner);
        read(&mut ins, 0, offset);
        ins.i32_store(mem(offset));
    }
    // Resizing transfers all initialized child edges instead of dropping them.
    write_constant(&mut ins, 0, KIND, BYTES as i32);
    ins.local_get(0)
        .call(functions.release)
        .end()
        .end()
        .local_get(owner)
        .end();
    body
}

fn realloc(functions: Functions) -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .call(functions.select)
        .local_get(1)
        .local_get(2)
        .local_get(3)
        .local_get(4)
        .call(functions.alloc)
        .local_tee(5)
        .if_(BlockType::Empty)
        .local_get(5)
        .call(functions.temporary)
        .end()
        .local_get(5)
        .end();
    body
}

fn retain(heap_start: u32) -> Function {
    let mut body = Function::new([(1, ValType::I32)]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_eqz()
        .if_(BlockType::Empty)
        .return_()
        .end();
    require_owner(&mut ins, heap_start);
    read(&mut ins, 0, REFERENCES);
    ins.i32_const(1)
        .i32_add()
        .local_tee(1)
        .i32_eqz()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    header(&mut ins, 0);
    ins.local_get(1).i32_store(mem(REFERENCES)).end();
    body
}

fn release(
    functions: Functions,
    globals: Globals,
    heap_start: u32,
    drop_children: u32,
) -> Function {
    let mut body = Function::new([(4, ValType::I32)]);
    let mut ins = body.instructions();
    let remaining = 1;
    let owner = 2;
    let previous = 3;
    let next = 4;
    ins.local_get(0)
        .i32_eqz()
        .if_(BlockType::Empty)
        .return_()
        .end();
    require_owner(&mut ins, heap_start);
    read(&mut ins, 0, REFERENCES);
    ins.i32_const(1).i32_sub().local_set(remaining);
    header(&mut ins, 0);
    ins.local_get(remaining)
        .i32_store(mem(REFERENCES))
        .local_get(remaining)
        .if_(BlockType::Empty)
        .return_()
        .end()
        .local_get(0)
        .call(functions.remove_temporary);
    write_constant(&mut ins, 0, FLAGS, QUEUED);
    header(&mut ins, 0);
    ins.global_get(globals.pending_drops)
        .i32_store(mem(AUX_NEXT))
        .local_get(0)
        .global_set(globals.pending_drops)
        .global_get(globals.dropping)
        .if_(BlockType::Empty)
        .return_()
        .end()
        .i32_const(1)
        .global_set(globals.dropping)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .global_get(globals.pending_drops)
        .local_tee(owner)
        .i32_eqz()
        .br_if(1);
    read(&mut ins, owner, AUX_NEXT);
    ins.global_set(globals.pending_drops);
    read(&mut ins, owner, KIND);
    ins.i32_const(ELEMENTS as i32).i32_eq();
    read(&mut ins, owner, KIND);
    ins.i32_const(INDIRECT as i32)
        .i32_eq()
        .i32_or()
        .if_(BlockType::Empty)
        .local_get(owner)
        .call(drop_children)
        .end();
    unlink(&mut ins, owner, previous, next, globals);
    ins.local_get(owner)
        .call(functions.recycle)
        .br(0)
        .end()
        .end()
        .i32_const(0)
        .global_set(globals.dropping)
        .end();
    body
}

fn set_layout(heap_start: u32) -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_eqz()
        .if_(BlockType::Empty)
        .return_()
        .end();
    require_owner(&mut ins, heap_start);
    for (offset, local) in [(KIND, 1), (ELEMENT_TYPE, 2), (ELEMENT_COUNT, 3)] {
        header(&mut ins, 0);
        ins.local_get(local).i32_store(mem(offset));
    }
    ins.end();
    body
}

fn clear_temporaries(functions: Functions, globals: Globals) -> Function {
    let mut body = Function::new([(2, ValType::I32)]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .call(functions.select)
        .global_get(globals.current_scope)
        .local_set(1)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(1)
        .i32_load(mem(SCOPE_TEMPORARIES))
        .local_tee(2)
        .i32_eqz()
        .br_if(1)
        .local_get(2)
        .call(functions.remove_temporary)
        .local_get(2)
        .call(functions.release)
        .br(0)
        .end()
        .end()
        .end();
    body
}

fn claim(functions: Functions, heap_start: u32) -> Function {
    let mut body = Function::new([]);
    let mut ins = body.instructions();
    ins.local_get(0)
        .i32_eqz()
        .if_(BlockType::Empty)
        .return_()
        .end();
    require_owner(&mut ins, heap_start);
    read(&mut ins, 0, FLAGS);
    ins.i32_const(FRESH).i32_and().if_(BlockType::Empty);
    header(&mut ins, 0);
    read(&mut ins, 0, FLAGS);
    ins.i32_const(!FRESH)
        .i32_and()
        .i32_store(mem(FLAGS))
        .else_()
        .local_get(0)
        .call(functions.retain)
        .end()
        .end();
    body
}

fn statistic(global: u32) -> Function {
    let mut body = Function::new([]);
    body.instructions().global_get(global).end();
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_encoder::{
        ConstExpr, ExportKind, ExportSection, GlobalType, MemorySection, MemoryType, Module,
    };

    fn artifact() -> Vec<u8> {
        let mut types = FunctionTypes::new();
        let mut functions = FunctionSection::new();
        let allocation = Functions::declare(&mut types, &mut functions, 0);
        let destructor = functions.len();
        functions.function(types.intern(vec![ValType::I32], Vec::new()));
        let mut globals = GlobalSection::new();
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i32_const(1024),
        );
        let allocation_globals = Globals::append(&mut globals, 0);
        let destructor_calls = globals.len();
        add_i32_global(&mut globals, 0, true);
        let mut code = CodeSection::new();
        allocation
            .emit(
                &mut code,
                &mut BranchHints::new(),
                allocation_globals,
                1024,
                destructor,
            )
            .expect("allocator emits");
        let mut destructor_body = Function::new([(2, ValType::I32)]);
        let mut ins = destructor_body.instructions();
        ins.global_get(destructor_calls)
            .i32_const(1)
            .i32_add()
            .global_set(destructor_calls);
        read(&mut ins, 0, KIND);
        ins.i32_const(INDIRECT as i32)
            .i32_eq()
            .if_(BlockType::Empty)
            .local_get(0)
            .i32_load(mem(0))
            .call(allocation.release)
            .return_()
            .end();
        read(&mut ins, 0, ELEMENT_COUNT);
        ins.local_set(1)
            .i32_const(0)
            .local_set(2)
            .block(BlockType::Empty)
            .loop_(BlockType::Empty)
            .local_get(2)
            .local_get(1)
            .i32_ge_u()
            .br_if(1)
            .local_get(0)
            .local_get(2)
            .i32_const(4)
            .i32_mul()
            .i32_add()
            .i32_load(mem(0))
            .call(allocation.release)
            .local_get(2)
            .i32_const(1)
            .i32_add()
            .local_set(2)
            .br(0)
            .end()
            .end()
            .end();
        code.function(&destructor_body);
        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        let mut exports = ExportSection::new();
        exports.export("memory", ExportKind::Memory, 0);
        exports.export("destructor_calls", ExportKind::Global, destructor_calls);
        exports.export(
            "next_token",
            ExportKind::Global,
            allocation_globals.next_token,
        );
        for (name, index) in [
            ("enter", allocation.enter),
            ("leave", allocation.leave),
            ("select", allocation.select),
            ("alloc", allocation.alloc),
            ("realloc", allocation.realloc),
            ("claim", allocation.claim),
            ("retain", allocation.retain),
            ("release", allocation.release),
            ("set_layout", allocation.set_layout),
            ("clear_temporaries", allocation.clear_temporaries),
            ("live_bytes", allocation.live_bytes),
            ("live_allocations", allocation.live_allocations),
            ("live_scopes", allocation.live_scopes),
        ] {
            exports.export(name, ExportKind::Func, index);
        }
        let mut module = Module::new();
        module
            .section(&types.section)
            .section(&functions)
            .section(&memories)
            .section(&globals)
            .section(&exports)
            .section(&code);
        module.finish()
    }

    #[test]
    fn allocator_helpers_validate_as_a_complete_wasm_module() {
        let artifact = artifact();
        wasmparser::Validator::new()
            .validate_all(&artifact)
            .expect("allocator instructions validate");
        if let Ok(path) = std::env::var("BLOT_ALLOCATION_TEST_ARTIFACT") {
            std::fs::write(path, artifact).expect("write requested allocator test artifact");
        }
    }
}
