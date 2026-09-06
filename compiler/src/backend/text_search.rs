//! Allocation-free Two-Way byte search for validated UTF-8 slices.
//!
//! The maximal suffix in each byte order supplies a critical factorization.
//! Comparing the right half first permits a safe shift after a mismatch; on
//! periodic needles, `memory` retains the prefix established by the last shift.
//! Neither a haystack position nor a long matched prefix is retried byte by byte.
//! See Crochemore and Perrin, "Two-way string-matching", JACM 38(3), 1991.

use wasm_encoder::{BlockType, Function, InstructionSink, MemArg, ValType};

const TEXT: u32 = 0;
const TEXT_LEN: u32 = 1;
const QUERY: u32 = 2;
const QUERY_LEN: u32 = 3;
const START: u32 = 4;
const SUFFIX: u32 = 5;
const CANDIDATE: u32 = 6;
const OFFSET: u32 = 7;
const PERIOD: u32 = 8;
const CRITICAL: u32 = 9;
const SAVED_PERIOD: u32 = 10;
const MEMORY: u32 = 11;
const MEMORY_AFTER_SHIFT: u32 = 12;
const INDEX: u32 = 13;
const LEFT_BYTE: u32 = 14;
const RIGHT_BYTE: u32 = 15;

const BYTE: MemArg = MemArg {
    offset: 0,
    align: 0,
    memory_index: 0,
};

/// `(text_ptr, text_bytes, query_ptr, query_bytes, start_byte) -> byte | -1`.
/// The caller converts scalar indices and validates the start before entry.
/// No allocation, host call, or change to the canonical heap is needed.
pub(super) fn function() -> Function {
    let mut function = Function::new([(11, ValType::I32)]);
    let mut code = function.instructions();
    code.local_get(QUERY_LEN)
        .i32_eqz()
        .if_(BlockType::Empty)
        .local_get(START)
        .return_()
        .end()
        .local_get(QUERY_LEN)
        .local_get(TEXT_LEN)
        .local_get(START)
        .i32_sub()
        .i32_gt_u()
        .if_(BlockType::Empty)
        .i32_const(-1)
        .return_()
        .end();

    maximal_suffix(&mut code, false);
    code.local_get(SUFFIX)
        .i32_const(1)
        .i32_add()
        .local_set(CRITICAL)
        .local_get(PERIOD)
        .local_set(SAVED_PERIOD);
    maximal_suffix(&mut code, true);
    code.local_get(SUFFIX)
        .i32_const(1)
        .i32_add()
        .local_get(CRITICAL)
        .i32_gt_u()
        .if_(BlockType::Empty)
        .local_get(SUFFIX)
        .i32_const(1)
        .i32_add()
        .local_set(CRITICAL)
        .else_()
        .local_get(SAVED_PERIOD)
        .local_set(PERIOD)
        .end();

    // Test whether the right-half period also covers the left half. A failed
    // test uses a conservative nonperiodic shift and retains no prefix memory.
    code.i32_const(0)
        .local_set(INDEX)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(INDEX)
        .local_get(CRITICAL)
        .i32_ge_u()
        .br_if(1)
        .local_get(QUERY)
        .local_get(INDEX)
        .i32_add()
        .i32_load8_u(BYTE)
        .local_get(QUERY)
        .local_get(PERIOD)
        .i32_add()
        .local_get(INDEX)
        .i32_add()
        .i32_load8_u(BYTE)
        .i32_ne()
        .br_if(1)
        .local_get(INDEX)
        .i32_const(1)
        .i32_add()
        .local_set(INDEX)
        .br(0)
        .end()
        .end()
        .local_get(INDEX)
        .local_get(CRITICAL)
        .i32_eq()
        .if_(BlockType::Empty)
        .local_get(QUERY_LEN)
        .local_get(PERIOD)
        .i32_sub()
        .local_set(MEMORY_AFTER_SHIFT)
        .else_()
        .local_get(CRITICAL)
        .local_get(QUERY_LEN)
        .local_get(CRITICAL)
        .i32_sub()
        .i32_const(1)
        .i32_add()
        .local_get(CRITICAL)
        .local_get(QUERY_LEN)
        .local_get(CRITICAL)
        .i32_sub()
        .i32_const(1)
        .i32_add()
        .i32_gt_u()
        .select()
        .local_set(PERIOD)
        .end();

    code.block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(START)
        .local_get(TEXT_LEN)
        .local_get(QUERY_LEN)
        .i32_sub()
        .i32_gt_u()
        .br_if(1)
        .local_get(CRITICAL)
        .local_get(MEMORY)
        .local_get(CRITICAL)
        .local_get(MEMORY)
        .i32_gt_u()
        .select()
        .local_set(INDEX)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(INDEX)
        .local_get(QUERY_LEN)
        .i32_ge_u()
        .br_if(1);
    compare_at(&mut code);
    code.i32_ne()
        .br_if(1)
        .local_get(INDEX)
        .i32_const(1)
        .i32_add()
        .local_set(INDEX)
        .br(0)
        .end()
        .end()
        .local_get(INDEX)
        .local_get(QUERY_LEN)
        .i32_lt_u()
        .if_(BlockType::Empty)
        .local_get(START)
        .local_get(INDEX)
        .local_get(CRITICAL)
        .i32_sub()
        .i32_const(1)
        .i32_add()
        .i32_add()
        .local_set(START)
        .i32_const(0)
        .local_set(MEMORY)
        .br(1)
        .end()
        .local_get(CRITICAL)
        .local_set(INDEX)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(INDEX)
        .local_get(MEMORY)
        .i32_le_u()
        .if_(BlockType::Empty)
        .local_get(START)
        .return_()
        .end()
        .local_get(INDEX)
        .i32_const(1)
        .i32_sub()
        .local_set(INDEX);
    compare_at(&mut code);
    code.i32_ne()
        .br_if(1)
        .br(0)
        .end()
        .end()
        .local_get(START)
        .local_get(PERIOD)
        .i32_add()
        .local_set(START)
        .local_get(MEMORY_AFTER_SHIFT)
        .local_set(MEMORY)
        .br(0)
        .end()
        .end()
        .i32_const(-1)
        .end();
    function
}

fn compare_at(code: &mut InstructionSink<'_>) {
    code.local_get(QUERY)
        .local_get(INDEX)
        .i32_add()
        .i32_load8_u(BYTE)
        .local_get(TEXT)
        .local_get(START)
        .i32_add()
        .local_get(INDEX)
        .i32_add()
        .i32_load8_u(BYTE);
}

fn maximal_suffix(code: &mut InstructionSink<'_>, reverse: bool) {
    // SUFFIX uses -1 for the empty prefix; OFFSET is positive, so every load
    // still has a nonnegative index. Compare the suffix *length* when choosing
    // between orders, avoiding signed comparisons of memory32 positions.
    code.i32_const(-1)
        .local_set(SUFFIX)
        .i32_const(0)
        .local_set(CANDIDATE)
        .i32_const(1)
        .local_set(OFFSET)
        .i32_const(1)
        .local_set(PERIOD)
        .block(BlockType::Empty)
        .loop_(BlockType::Empty)
        .local_get(OFFSET)
        .local_get(QUERY_LEN)
        .local_get(CANDIDATE)
        .i32_sub()
        .i32_ge_u()
        .br_if(1)
        .local_get(QUERY)
        .local_get(CANDIDATE)
        .i32_add()
        .local_get(OFFSET)
        .i32_add()
        .i32_load8_u(BYTE)
        .local_set(LEFT_BYTE)
        .local_get(QUERY)
        .local_get(SUFFIX)
        .i32_add()
        .local_get(OFFSET)
        .i32_add()
        .i32_load8_u(BYTE)
        .local_set(RIGHT_BYTE)
        .local_get(LEFT_BYTE)
        .local_get(RIGHT_BYTE);
    if reverse {
        code.i32_gt_u();
    } else {
        code.i32_lt_u();
    }
    code.if_(BlockType::Empty)
        .local_get(CANDIDATE)
        .local_get(OFFSET)
        .i32_add()
        .local_set(CANDIDATE)
        .i32_const(1)
        .local_set(OFFSET)
        .local_get(CANDIDATE)
        .local_get(SUFFIX)
        .i32_sub()
        .local_set(PERIOD)
        .else_()
        .local_get(LEFT_BYTE)
        .local_get(RIGHT_BYTE)
        .i32_eq()
        .if_(BlockType::Empty)
        .local_get(OFFSET)
        .local_get(PERIOD)
        .i32_eq()
        .if_(BlockType::Empty)
        .local_get(CANDIDATE)
        .local_get(PERIOD)
        .i32_add()
        .local_set(CANDIDATE)
        .i32_const(1)
        .local_set(OFFSET)
        .else_()
        .local_get(OFFSET)
        .i32_const(1)
        .i32_add()
        .local_set(OFFSET)
        .end()
        .else_()
        .local_get(CANDIDATE)
        .local_set(SUFFIX)
        .local_get(CANDIDATE)
        .i32_const(1)
        .i32_add()
        .local_set(CANDIDATE)
        .i32_const(1)
        .local_set(OFFSET)
        .i32_const(1)
        .local_set(PERIOD)
        .end()
        .end()
        .br(0)
        .end()
        .end();
}

#[cfg(test)]
mod tests;
