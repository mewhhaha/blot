use super::*;
use crate::continuation::{Definition, Graph, Operation};
use crate::hir::{RuntimeField, RuntimeSignature, RuntimeSpan};

fn span() -> RuntimeSpan {
    RuntimeSpan {
        file: "managed-lifetimes.blot".to_owned(),
        start: 1,
        end: 2,
    }
}

fn definition(value: usize, type_id: usize) -> Definition {
    Definition {
        value: ValueId(value),
        type_id: TypeId(type_id),
        ownership: "owned",
        span: span(),
    }
}

fn instruction(
    value: usize,
    type_id: usize,
    kind: &'static str,
    operands: &[usize],
) -> RuntimeInstruction {
    RuntimeInstruction {
        definition: definition(value, type_id),
        operands: operands.iter().copied().map(ValueId).collect(),
        operation: Operation {
            kind,
            value: None,
            update: None,
            case: None,
            operator: None,
            conversion: None,
            lane: None,
            field: None,
            function: None,
            signature: None,
            static_store: None,
        },
    }
}

fn integer(value: usize, number: i64) -> RuntimeInstruction {
    let mut instruction = instruction(value, 1, "constant", &[]);
    instruction.operation.value = Some(WireConstant::SignedInteger64(number.to_string()));
    instruction
}

fn update(
    value: usize,
    kind: &'static str,
    mode: &'static str,
    operands: &[usize],
) -> RuntimeInstruction {
    let mut instruction = instruction(value, 3, kind, operands);
    instruction.operation.update = Some(mode);
    instruction
}

fn program(
    parameters: Vec<usize>,
    result_type: usize,
    instructions: Vec<RuntimeInstruction>,
    result: usize,
) -> RuntimeModule {
    RuntimeModule {
        format: "blot-runtime-hir",
        schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
        source: span().file,
        types: vec![
            RuntimeType::Unit,
            RuntimeType::SignedInteger64,
            RuntimeType::Text,
            RuntimeType::Store { element_type: 2 },
            RuntimeType::Store { element_type: 3 },
            RuntimeType::Scratch { element_type: 2 },
            RuntimeType::Boolean,
            RuntimeType::Product {
                name: "TextPair".to_owned(),
                fields: vec![
                    RuntimeField {
                        name: "a".to_owned(),
                        type_id: 2,
                    },
                    RuntimeField {
                        name: "b".to_owned(),
                        type_id: 2,
                    },
                ],
            },
            RuntimeType::Product {
                name: "ArrayPair".to_owned(),
                fields: vec![
                    RuntimeField {
                        name: "a".to_owned(),
                        type_id: 3,
                    },
                    RuntimeField {
                        name: "b".to_owned(),
                        type_id: 3,
                    },
                ],
            },
            RuntimeType::Store { element_type: 1 },
            RuntimeType::Scratch { element_type: 1 },
            RuntimeType::Product {
                name: "Scalars".to_owned(),
                fields: vec![
                    RuntimeField {
                        name: "a".to_owned(),
                        type_id: 1,
                    },
                    RuntimeField {
                        name: "b".to_owned(),
                        type_id: 6,
                    },
                ],
            },
            RuntimeType::Resource {
                name: "Opaque".to_owned(),
                payload_type: 2,
            },
        ],
        signatures: vec![RuntimeSignature {
            parameters: parameters.clone(),
            result: result_type,
            effects: vec![],
        }],
        static_stores: vec![],
        capabilities: vec![],
        links: vec![],
        exports: vec![RuntimeExport::Runtime {
            source_name: "run".to_owned(),
            phase: "runtime",
            wasm_name: "run".to_owned(),
            function: 0,
            signature: 0,
            ownership: "owned",
        }],
        graph: Graph {
            functions: vec![RuntimeFunction {
                id: FunctionId(0),
                name: "run".to_owned(),
                signature: SignatureId(0),
                entry: ContinuationId(0),
                suspends: false,
                framed: false,
                reuse: None,
                span: span(),
                continuations: vec![RuntimeContinuation {
                    id: ContinuationId(0),
                    parameters: parameters
                        .into_iter()
                        .enumerate()
                        .map(|(value, type_id)| definition(value, type_id))
                        .collect(),
                    captures: vec![],
                    instructions,
                    transition: RuntimeTransition::Return {
                        value: ValueId(result),
                    },
                    span: span(),
                }],
            }],
        },
    }
}

fn nested_slice() -> RuntimeModule {
    program(
        vec![4],
        2,
        vec![
            integer(1, 0),
            instruction(2, 3, "store.read", &[0, 1]),
            instruction(3, 2, "store.read", &[2, 1]),
            integer(4, 1),
            integer(5, 3),
            instruction(6, 2, "text.slice", &[3, 4, 5]),
        ],
        6,
    )
}

fn persistent_write() -> RuntimeModule {
    program(
        vec![3, 2],
        8,
        vec![
            integer(2, 0),
            update(3, "store.write", "persistent", &[0, 2, 1]),
            instruction(4, 8, "product.make", &[0, 3]),
        ],
        4,
    )
}

fn persistent_grow() -> RuntimeModule {
    program(
        vec![3, 2],
        8,
        vec![
            update(2, "store.grow", "persistent", &[0, 1]),
            instruction(3, 8, "product.make", &[0, 2]),
        ],
        3,
    )
}

fn owned_grow() -> RuntimeModule {
    program(
        vec![3, 2],
        3,
        vec![update(2, "store.grow", "owned-reuse", &[0, 1])],
        2,
    )
}

fn scratch_recycle() -> RuntimeModule {
    program(
        vec![2],
        3,
        vec![
            integer(1, 1),
            instruction(2, 5, "scratch.with-capacity", &[1]),
            instruction(3, 5, "scratch.push", &[2, 0]),
            instruction(4, 5, "scratch.push", &[3, 0]),
            instruction(5, 3, "scratch.finish", &[4]),
            instruction(6, 5, "scratch.recycle", &[5]),
            instruction(7, 5, "scratch.push", &[6, 0]),
            instruction(8, 3, "scratch.finish", &[7]),
        ],
        8,
    )
}

fn empty_scratch_recycle() -> RuntimeModule {
    program(
        vec![2],
        3,
        vec![
            integer(1, 8),
            instruction(2, 5, "scratch.with-capacity", &[1]),
            instruction(3, 3, "scratch.finish", &[2]),
            instruction(4, 5, "scratch.recycle", &[3]),
            instruction(5, 5, "scratch.push", &[4, 0]),
            instruction(6, 3, "scratch.finish", &[5]),
        ],
        6,
    )
}

fn duplicated_call() -> RuntimeModule {
    let mut module = program(vec![2], 2, vec![], 1);
    let callee = program(
        vec![2, 2],
        2,
        vec![instruction(2, 2, "text.append", &[0, 1])],
        2,
    );
    module.signatures.push(callee.signatures[0].clone());
    let mut child = callee.functions[0].clone();
    child.id = FunctionId(1);
    child.signature = SignatureId(1);
    child.name = "append".to_owned();
    module.functions[0].continuations[0].transition = RuntimeTransition::Call {
        target: CallTarget::Function {
            function: FunctionId(1),
        },
        signature: SignatureId(1),
        arguments: vec![ValueId(0), ValueId(0)],
        next: Edge {
            target: ContinuationId(1),
            arguments: vec![Argument::Result],
        },
        suspends: false,
    };
    module.functions[0].continuations.push(RuntimeContinuation {
        id: ContinuationId(1),
        parameters: vec![definition(1, 2)],
        captures: vec![],
        instructions: vec![],
        transition: RuntimeTransition::Return { value: ValueId(1) },
        span: span(),
    });
    module.functions.push(child);
    module
}

fn branch_transfer() -> RuntimeModule {
    let mut module = program(vec![6, 2, 2], 7, vec![], 5);
    module.functions[0].continuations[0].transition = RuntimeTransition::Branch {
        condition: ValueId(0),
        consequent: Edge {
            target: ContinuationId(1),
            arguments: vec![Argument::Value(ValueId(1)), Argument::Value(ValueId(1))],
        },
        alternate: Edge {
            target: ContinuationId(1),
            arguments: vec![Argument::Value(ValueId(1)), Argument::Value(ValueId(2))],
        },
    };
    module.functions[0].continuations.push(RuntimeContinuation {
        id: ContinuationId(1),
        parameters: vec![definition(3, 2), definition(4, 2)],
        captures: vec![],
        instructions: vec![instruction(5, 7, "product.make", &[3, 4])],
        transition: RuntimeTransition::Return { value: ValueId(5) },
        span: span(),
    });
    module
}

fn allocating_loop() -> RuntimeModule {
    let mut add = instruction(8, 1, "scalar", &[2, 7]);
    add.operation.operator = Some("add");
    let mut subtract = instruction(10, 1, "scalar", &[0, 9]);
    subtract.operation.operator = Some("subtract");
    let mut again = instruction(12, 6, "scalar", &[10, 11]);
    again.operation.operator = Some("greater-than");
    let mut module = program(
        vec![1, 2, 1],
        1,
        vec![
            integer(3, 0),
            instruction(4, 3, "store.literal", &[1, 1]),
            instruction(5, 2, "store.read", &[4, 3]),
            instruction(6, 2, "text.append", &[5, 1]),
            instruction(7, 1, "text.length", &[6]),
            add,
            integer(9, 1),
            subtract,
            integer(11, 0),
            again,
        ],
        13,
    );
    module.functions[0].continuations[0].transition = RuntimeTransition::Branch {
        condition: ValueId(12),
        consequent: Edge {
            target: ContinuationId(0),
            arguments: vec![
                Argument::Value(ValueId(10)),
                Argument::Value(ValueId(1)),
                Argument::Value(ValueId(8)),
            ],
        },
        alternate: Edge {
            target: ContinuationId(1),
            arguments: vec![Argument::Value(ValueId(8))],
        },
    };
    module.functions[0].continuations.push(RuntimeContinuation {
        id: ContinuationId(1),
        parameters: vec![definition(13, 1)],
        captures: vec![],
        instructions: vec![],
        transition: RuntimeTransition::Return { value: ValueId(13) },
        span: span(),
    });
    module
}

fn repeated_initial() -> RuntimeModule {
    program(
        vec![1, 2],
        3,
        vec![instruction(2, 3, "store.new", &[0, 1])],
        2,
    )
}

#[test]
fn managed_operations_emit_valid_wasm() {
    for (name, module) in [
        ("nested_slice", nested_slice()),
        ("persistent_write", persistent_write()),
        ("persistent_grow", persistent_grow()),
        ("owned_grow", owned_grow()),
        ("scratch_recycle", scratch_recycle()),
        ("empty_scratch_recycle", empty_scratch_recycle()),
        ("duplicated_call", duplicated_call()),
        ("branch_transfer", branch_transfer()),
        ("allocating_loop", allocating_loop()),
        ("repeated_initial", repeated_initial()),
    ] {
        module
            .graph
            .validate(module.tables())
            .expect("managed operation graph validates");
        let layouts = RuntimeTypeLayouts::new(&module).unwrap();
        let manifest = build_manifest(&module, &layouts).unwrap();
        let wasm = emit_dynamic_module(&module, &layouts, &manifest, b"{}").unwrap();
        wasmparser::Validator::new()
            .validate_all(&wasm)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        if let Ok(directory) = std::env::var("BLOT_MANAGED_TEST_DIRECTORY") {
            std::fs::write(
                std::path::Path::new(&directory).join(format!("{name}.wasm")),
                wasm,
            )
            .expect("write managed test fixture");
        }
    }
}

#[test]
fn reference_free_storage_operations_do_not_read_or_traverse_elements() {
    let module = program(vec![0, 1, 11, 12], 1, vec![], 1);
    let layouts = RuntimeTypeLayouts::new(&module).unwrap();
    let mut types = FunctionTypes::new();
    let mut functions = FunctionSection::new();
    let allocator = allocation::Functions::declare(&mut types, &mut functions, 0);
    let allocator_function_count = functions.len();
    let managed = ManagedValues::declare(&module, &layouts, &mut types, &mut functions, 0).unwrap();
    assert_eq!(functions.len() - allocator_function_count, 6);
    assert_eq!(managed.empty.len(), 5);
    assert!(
        !managed.values.contains_key(&2),
        "opaque resource payload Text is not a managed root"
    );
    let mut globals = GlobalSection::new();
    add_i32_global(&mut globals, 1024, true);
    let allocation_globals = allocation::Globals::append(&mut globals, 0);
    let mut code = CodeSection::new();
    let mut hints = BranchHints::new();
    allocator
        .emit(
            &mut code,
            &mut hints,
            allocation_globals,
            1024,
            managed.drop_children,
        )
        .unwrap();
    managed
        .emit(&module, &layouts, allocator, &mut code, &mut hints)
        .unwrap();
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    let mut exports = ExportSection::new();
    for (name, type_id) in [
        ("unit", 0),
        ("integer", 1),
        ("product", 11),
        ("resource", 12),
    ] {
        let functions = managed.values[&type_id];
        assert!(!functions.owns_memory);
        assert_eq!(functions.retain, functions.release);
        assert_eq!(functions.retain, functions.claim);
        assert_eq!(functions.retain_stored, functions.release_stored);
        assert_eq!(functions.retain_stored, managed.values[&6].retain);
        assert_eq!(functions.retain_range, functions.release_range);
        assert_eq!(functions.retain_range, managed.values[&0].retain_range);
        exports.export(
            &format!("retain_{name}"),
            ExportKind::Func,
            functions.retain_range,
        );
        exports.export(
            &format!("release_{name}"),
            ExportKind::Func,
            functions.release_range,
        );
    }
    assert_eq!(managed.values[&1].retain, managed.values[&12].retain);
    let mut wasm = Module::new();
    wasm.section(&types.section)
        .section(&functions)
        .section(&memories)
        .section(&globals)
        .section(&exports)
        .section(&code);
    let wasm = wasm.finish();
    wasmparser::Validator::new().validate_all(&wasm).unwrap();
    if let Ok(directory) = std::env::var("BLOT_MANAGED_TEST_DIRECTORY") {
        std::fs::write(
            std::path::Path::new(&directory).join("reference_free.wasm"),
            wasm,
        )
        .expect("write reference-free storage fixture");
    }
}
