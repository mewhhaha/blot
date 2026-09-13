use wasm_encoder::{BlockType, Function, MemArg, ValType};

pub(super) fn byte_offset_function() -> Function {
    let mut function = Function::new([]);
    function
        .instructions()
        .local_get(2)
        .local_get(1)
        .i64_extend_i32_u()
        .i64_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(2)
        .local_get(1)
        .i64_extend_i32_u()
        .i64_eq()
        .if_(BlockType::Empty)
        .local_get(1)
        .return_()
        .end()
        .local_get(0)
        .local_get(2)
        .i32_wrap_i64()
        .i32_add()
        .i32_load8_u(MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .i32_const(0xc0)
        .i32_and()
        .i32_const(0x80)
        .i32_eq()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(2)
        .i32_wrap_i64()
        .end();
    function
}

pub(super) fn next_byte_function() -> Function {
    let mut function = Function::new([(2, ValType::I32)]);
    let pointer = 0;
    let length = 1;
    let byte = 2;
    let lead = 3;
    let width = 4;
    let mut instructions = function.instructions();
    instructions
        .local_get(byte)
        .local_get(length)
        .i64_extend_i32_u()
        .i64_gt_u()
        .if_(BlockType::Empty)
        .unreachable()
        .end()
        .local_get(byte)
        .local_get(length)
        .i64_extend_i32_u()
        .i64_eq()
        .if_(BlockType::Empty)
        .i32_const(0)
        .i32_const(0)
        .i32_const(0)
        .i64_const(0)
        .return_()
        .end()
        .local_get(pointer)
        .local_get(byte)
        .i32_wrap_i64()
        .i32_add()
        .local_tee(pointer)
        .i32_load8_u(MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        })
        .local_tee(lead)
        .i32_const(0xc0)
        .i32_and()
        .i32_const(0x80)
        .i32_eq()
        .if_(BlockType::Empty)
        .unreachable()
        .end();
    // Input Text is already valid UTF-8. Its lead byte determines the width.
    instructions
        .i32_const(1)
        .local_get(lead)
        .i32_const(0x80)
        .i32_ge_u()
        .i32_add()
        .local_get(lead)
        .i32_const(0xe0)
        .i32_ge_u()
        .i32_add()
        .local_get(lead)
        .i32_const(0xf0)
        .i32_ge_u()
        .i32_add()
        .local_set(width)
        .i32_const(1)
        .local_get(pointer)
        .local_get(width)
        .local_get(byte)
        .local_get(width)
        .i64_extend_i32_u()
        .i64_add()
        .end();
    function
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmparser::{BinaryReader, FunctionBody, Operator};

    #[test]
    fn text_cursor_step_has_one_byte_load_and_no_loop_call_or_write() {
        for function in [next_byte_function(), byte_offset_function()] {
            let body = function.into_raw_body();
            let operators = FunctionBody::new(BinaryReader::new(&body, 0))
                .get_operators_reader()
                .expect("cursor helper instructions should decode");
            let mut loads = 0;
            for operator in operators {
                match operator.expect("cursor instruction should decode") {
                    Operator::I32Load8U { .. } => loads += 1,
                    Operator::LocalGet { .. }
                    | Operator::LocalSet { .. }
                    | Operator::LocalTee { .. }
                    | Operator::I32Const { .. }
                    | Operator::I64Const { .. }
                    | Operator::I32Add
                    | Operator::I32And
                    | Operator::I32Eq
                    | Operator::I32GeU
                    | Operator::I64GtU
                    | Operator::I64Eq
                    | Operator::I64Add
                    | Operator::I64ExtendI32U
                    | Operator::I32WrapI64
                    | Operator::If { .. }
                    | Operator::Unreachable
                    | Operator::Return
                    | Operator::End => {}
                    unsupported => {
                        panic!("cursor helper exceeds its instruction contract: {unsupported:?}")
                    }
                }
            }
            assert_eq!(loads, 1);
        }
    }
}
