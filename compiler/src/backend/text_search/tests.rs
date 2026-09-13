use super::*;
use wasm_encoder::{CodeSection, FunctionSection, MemorySection, MemoryType, Module, TypeSection};
use wasmparser::{BinaryReader, FunctionBody, Operator};

// Execute the *emitted instructions*, not a second implementation of Two-Way.
// This deliberately small test machine accepts only the helper's i32/control/
// byte-load subset. Unknown instructions fail. The end-to-end Node suite also
// executes the rebuilt compiler's actual Wasm with canonical Text arguments.
struct Program<'a> {
    operators: Vec<Operator<'a>>,
    ends: Vec<usize>,
    alternatives: Vec<usize>,
    local_count: usize,
}

#[derive(Clone, Copy)]
struct Label {
    begin: usize,
    end: usize,
    height: usize,
    is_loop: bool,
}

impl<'a> Program<'a> {
    fn new(body: &'a [u8]) -> Self {
        let body = FunctionBody::new(BinaryReader::new(body, 0));
        let mut local_count = 5;
        for local in body.get_locals_reader().unwrap() {
            let (count, type_) = local.unwrap();
            assert_eq!(type_, wasmparser::ValType::I32);
            local_count += count as usize;
        }
        let operators = body
            .get_operators_reader()
            .unwrap()
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut ends = vec![usize::MAX; operators.len()];
        let mut alternatives = ends.clone();
        let mut open = Vec::new();
        for (index, operator) in operators.iter().enumerate() {
            match operator {
                Operator::Block { .. } | Operator::Loop { .. } | Operator::If { .. } => {
                    open.push(index);
                }
                Operator::Else => alternatives[*open.last().unwrap()] = index,
                Operator::End => {
                    if let Some(begin) = open.pop() {
                        ends[begin] = index;
                    } else {
                        assert_eq!(index, operators.len() - 1);
                    }
                }
                _ => {}
            }
        }
        assert!(open.is_empty());
        Self {
            operators,
            ends,
            alternatives,
            local_count,
        }
    }

    fn run(&self, text: &[u8], query: &[u8], start: usize) -> (i32, usize) {
        assert!(start <= text.len());
        let text_pointer = 3;
        let query_pointer = text_pointer + text.len() + 7;
        let mut memory = vec![0; query_pointer + query.len()];
        memory[text_pointer..text_pointer + text.len()].copy_from_slice(text);
        memory[query_pointer..].copy_from_slice(query);
        let mut locals = vec![0_u32; self.local_count];
        locals[..5].copy_from_slice(&[
            text_pointer as u32,
            text.len() as u32,
            query_pointer as u32,
            query.len() as u32,
            start as u32,
        ]);
        let mut stack = Vec::<u32>::new();
        let mut labels = Vec::<Label>::new();
        let mut pc = 0;
        let mut loads = 0;
        let mut steps = 0;
        loop {
            steps += 1;
            assert!(
                steps < 200 * (text.len() + query.len() + 1) + 1000,
                "search exhausted its linear instruction budget"
            );
            let operator = &self.operators[pc];
            match operator {
                Operator::LocalGet { local_index } => stack.push(locals[*local_index as usize]),
                Operator::LocalSet { local_index } => {
                    locals[*local_index as usize] = stack.pop().unwrap();
                }
                Operator::I32Const { value } => stack.push(*value as u32),
                Operator::Block { .. } | Operator::Loop { .. } | Operator::If { .. } => {
                    let take =
                        !matches!(operator, Operator::If { .. }) || stack.pop().unwrap() != 0;
                    labels.push(Label {
                        begin: pc,
                        end: self.ends[pc],
                        height: stack.len(),
                        is_loop: matches!(operator, Operator::Loop { .. }),
                    });
                    if !take {
                        if self.alternatives[pc] == usize::MAX {
                            pc = self.ends[pc];
                        } else {
                            pc = self.alternatives[pc] + 1;
                        }
                        continue;
                    }
                }
                Operator::Else => {
                    pc = labels.last().unwrap().end;
                    continue;
                }
                Operator::End => {
                    if labels.pop().is_none() {
                        assert_eq!(stack.len(), 1);
                        return (stack.pop().unwrap() as i32, loads);
                    }
                }
                Operator::Br { relative_depth } | Operator::BrIf { relative_depth } => {
                    if matches!(operator, Operator::Br { .. }) || stack.pop().unwrap() != 0 {
                        let index = labels.len() - 1 - *relative_depth as usize;
                        let label = labels[index];
                        stack.truncate(label.height);
                        if label.is_loop {
                            labels.truncate(index + 1);
                            pc = label.begin + 1;
                        } else {
                            labels.truncate(index);
                            pc = label.end + 1;
                        }
                        continue;
                    }
                }
                Operator::Return => return (stack.pop().unwrap() as i32, loads),
                Operator::Select => {
                    let condition = stack.pop().unwrap();
                    let alternate = stack.pop().unwrap();
                    let consequent = stack.pop().unwrap();
                    stack.push(if condition != 0 {
                        consequent
                    } else {
                        alternate
                    });
                }
                Operator::I32Load8U { memarg } => {
                    let address = stack.pop().unwrap() as usize + memarg.offset as usize;
                    assert!(
                        (text_pointer..text_pointer + text.len()).contains(&address)
                            || (query_pointer..query_pointer + query.len()).contains(&address),
                        "search read beyond either input slice at {address}",
                    );
                    stack.push(u32::from(memory[address]));
                    loads += 1;
                }
                Operator::I32Eqz => {
                    let value = stack.pop().unwrap();
                    stack.push(u32::from(value == 0));
                }
                Operator::I32Add
                | Operator::I32Sub
                | Operator::I32Eq
                | Operator::I32Ne
                | Operator::I32LtU
                | Operator::I32GtU
                | Operator::I32LeU
                | Operator::I32GeU => {
                    let right = stack.pop().unwrap();
                    let left = stack.pop().unwrap();
                    let result = match operator {
                        Operator::I32Add => left.wrapping_add(right),
                        Operator::I32Sub => left.wrapping_sub(right),
                        Operator::I32Eq => u32::from(left == right),
                        Operator::I32Ne => u32::from(left != right),
                        Operator::I32LtU => u32::from(left < right),
                        Operator::I32GtU => u32::from(left > right),
                        Operator::I32LeU => u32::from(left <= right),
                        Operator::I32GeU => u32::from(left >= right),
                        _ => unreachable!(),
                    };
                    stack.push(result);
                }
                other => panic!("unsupported search instruction: {other:?}"),
            }
            pc += 1;
        }
    }

    fn check(&self, text: &[u8], query: &[u8], start: usize) -> usize {
        let expected = if query.is_empty() {
            start as i32
        } else {
            text[start..]
                .windows(query.len())
                .position(|part| part == query)
                .map(|offset| (start + offset) as i32)
                .unwrap_or(-1)
        };
        let (actual, loads) = self.run(text, query, start);
        assert_eq!(
            actual, expected,
            "text={text:?}, query={query:?}, start={start}"
        );
        assert!(
            loads <= 12 * (text.len() - start + query.len()) + 16,
            "{loads} byte loads for text={}, query={}",
            text.len(),
            query.len()
        );
        loads
    }
}

#[test]
fn emitted_search_is_valid_wasm_without_calls_or_allocation() {
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32; 5], [ValType::I32]);
    let mut functions = FunctionSection::new();
    functions.function(0);
    let mut memory = MemorySection::new();
    memory.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    let mut code = CodeSection::new();
    code.function(&function());
    let mut module = Module::new();
    module
        .section(&types)
        .section(&functions)
        .section(&memory)
        .section(&code);
    wasmparser::Validator::new()
        .validate_all(&module.finish())
        .unwrap();
    let body = function().into_raw_body();
    for operator in Program::new(&body).operators {
        assert!(!matches!(
            operator,
            Operator::Call { .. }
                | Operator::MemoryGrow { .. }
                | Operator::GlobalSet { .. }
                | Operator::I32Store { .. }
        ));
    }
}

#[test]
fn emitted_search_matches_exhaustive_binary_strings_at_every_start() {
    let body = function().into_raw_body();
    let program = Program::new(&body);
    let mut strings = vec![Vec::new()];
    for length in 1..=5 {
        for bits in 0..1_usize << length {
            strings.push(
                (0..length)
                    .map(|index| ((bits >> index) & 1) as u8)
                    .collect(),
            );
        }
    }
    for text in &strings {
        for query in &strings {
            for start in 0..=text.len() {
                program.check(text, query, start);
            }
        }
    }
}

#[test]
fn emitted_search_has_linear_work_on_periodic_and_late_mismatch_inputs() {
    let body = function().into_raw_body();
    let program = Program::new(&body);
    for size in [32, 128, 512, 2048, 8192] {
        let text = vec![b'a'; size * 4];
        let mut late_mismatch = vec![b'a'; size];
        late_mismatch[size - 1] = b'b';
        program.check(&text, &late_mismatch, 0);
        late_mismatch[0] = b'b';
        late_mismatch[size - 1] = b'a';
        program.check(&text, &late_mismatch, 0);
        let periodic = b"ab".repeat(size / 2);
        let mut text = b"ab".repeat(size * 2);
        text[size / 2] = b'c';
        program.check(&text, &periodic, 0);
        let mut text = vec![b'a'; size * 4];
        text.extend_from_slice(&late_mismatch);
        program.check(&text, &late_mismatch, 3);
    }
}

#[test]
fn emitted_search_preserves_zero_high_bytes_and_overlapping_matches() {
    let body = function().into_raw_body();
    let program = Program::new(&body);
    let mut state = 0x53a9_u32;
    for _ in 0..500 {
        let mut next = || {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            state
        };
        let length = (next() % 96) as usize;
        let text = (0..length)
            .map(|_| (next() >> 24) as u8)
            .collect::<Vec<_>>();
        let start = (next() as usize) % (text.len() + 1);
        let end = start + next() as usize % (text.len() - start + 1);
        for offset in [0, start, end, text.len()] {
            program.check(&text, &text[start..end], offset);
        }
    }
    for start in 0..=7 {
        program.check(b"abababa", b"ababa", start);
        program.check(b"\0\xff\0\xff\0\xff\0", b"\0\xff\0", start);
    }
}

#[test]
fn successive_nonoverlapping_searches_have_linear_total_byte_work() {
    let body = super::function().into_raw_body();
    let program = Program::new(&body);
    for (piece, query) in [
        ("a\n", "\n"),
        ("🐱α🐱", "🐱"),
        ("ababababx", "abab"),
        ("aaaaaaaaab", "aaaaab"),
    ] {
        for count in [256, 1024] {
            let text = piece.repeat(count);
            let mut start = 0;
            let mut loads = 0;
            let mut matches = 0;
            loop {
                let (found, current_loads) = program.run(text.as_bytes(), query.as_bytes(), start);
                loads += current_loads;
                if found < 0 {
                    break;
                }
                matches += 1;
                start = found as usize + query.len();
            }
            assert_eq!(matches, text.matches(query).count());
            assert!(
                loads <= 12 * (text.len() + query.len()) + 16 * (matches + 1),
                "{loads} loads for {} bytes",
                text.len()
            );
        }
    }
}
