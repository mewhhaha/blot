use super::*;
use crate::continuation::{Definition, Graph, Operation};
use crate::hir::{
    RuntimeCapability, RuntimeCapabilityOperation, RuntimeEffectOwnership, RuntimeSignature,
    RuntimeSpan,
};

fn span() -> RuntimeSpan {
    RuntimeSpan {
        file: "frame-liveness.blot".to_owned(),
        start: 1,
        end: 8,
    }
}

fn definition(value: usize) -> Definition {
    Definition {
        value: ValueId(value),
        type_id: TypeId(0),
        ownership: "plain",
        span: span(),
    }
}

fn operation(value: usize, operands: Vec<ValueId>, kind: &'static str) -> RuntimeInstruction {
    RuntimeInstruction {
        definition: definition(value),
        operands,
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

fn program() -> RuntimeModule {
    let mut dead = operation(1, vec![], "constant");
    dead.operation.value = Some(WireConstant::SignedInteger64("99".to_owned()));
    let mut capture = operation(2, vec![], "constant");
    capture.operation.value = Some(WireConstant::SignedInteger64("42".to_owned()));
    let mut add = operation(4, vec![ValueId(2), ValueId(3)], "scalar");
    add.operation.operator = Some("add");
    RuntimeModule {
        format: "blot-runtime-hir",
        schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
        source: "frame-liveness.blot".to_owned(),
        types: vec![RuntimeType::SignedInteger64],
        signatures: vec![RuntimeSignature {
            parameters: vec![0],
            result: 0,
            effects: vec![],
        }],
        static_stores: vec![],
        graph: Graph {
            functions: vec![RuntimeFunction {
                id: FunctionId(0),
                name: "run".to_owned(),
                signature: SignatureId(0),
                entry: ContinuationId(0),
                suspends: true,
                framed: true,
                reuse: None,
                span: span(),
                continuations: vec![
                    RuntimeContinuation {
                        id: ContinuationId(0),
                        parameters: vec![definition(0)],
                        captures: vec![],
                        instructions: vec![dead, capture],
                        span: span(),
                        transition: RuntimeTransition::Call {
                            target: CallTarget::Host {
                                capability: "Clock".to_owned(),
                                operation: "tick".to_owned(),
                            },
                            signature: SignatureId(0),
                            arguments: vec![ValueId(0)],
                            suspends: true,
                            next: Edge {
                                target: ContinuationId(1),
                                arguments: vec![Argument::Result],
                            },
                        },
                    },
                    RuntimeContinuation {
                        id: ContinuationId(1),
                        parameters: vec![definition(3)],
                        captures: vec![definition(2)],
                        instructions: vec![add],
                        span: span(),
                        transition: RuntimeTransition::Return { value: ValueId(4) },
                    },
                ],
            }],
        },
        capabilities: vec![RuntimeCapability {
            name: "Clock".to_owned(),
            operations: vec![RuntimeCapabilityOperation {
                name: "tick".to_owned(),
                source_name: "tick".to_owned(),
                signature: 0,
                contract: RuntimeOperationContract {
                    input: RuntimeEffectOwnership::Mode("unrestricted"),
                    result: RuntimeEffectOwnership::Mode("unrestricted"),
                    suspends: true,
                },
            }],
        }],
        links: vec![],
        exports: vec![RuntimeExport::Runtime {
            source_name: "run".to_owned(),
            phase: "runtime",
            wasm_name: "run".to_owned(),
            function: 0,
            signature: 0,
            ownership: "owned",
        }],
    }
}

#[test]
fn frame_capacity_tracks_continuation_inputs_instead_of_all_definitions() {
    let module = program();
    module
        .graph
        .validate(module.tables())
        .expect("valid continuation graph");
    let layouts = RuntimeTypeLayouts::new(&module).unwrap();
    let manifest = build_manifest(&module, &layouts).unwrap();
    let frame = Frame::new(&module, &layouts, &module.functions[0], &manifest).unwrap();
    assert_eq!(frame.value_locals.len(), 5);
    assert_eq!(
        frame.states[&ContinuationId(0)]
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        vec![ValueId(0)]
    );
    assert_eq!(
        frame.states[&ContinuationId(1)]
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        vec![ValueId(2), ValueId(3)]
    );
    assert_eq!(frame.argument_offset, FRAME_HEADER + 2 * LANE_SIZE);
}

#[test]
fn suspension_stores_captures_without_reading_the_unproduced_result() {
    let module = program();
    let layouts = RuntimeTypeLayouts::new(&module).unwrap();
    let manifest = build_manifest(&module, &layouts).unwrap();
    let function = &module.functions[0];
    let frame = Frame::new(&module, &layouts, function, &manifest).unwrap();
    let RuntimeTransition::Call { next, .. } = &function.continuations[0].transition else {
        panic!()
    };
    let mut body = Function::new([]);
    frame.save_edge(&mut body.instructions(), function, next, None);
    body.instructions().end();
    let bytes = body.into_raw_body();
    let operators = FunctionBody::new(BinaryReader::new(&bytes, 0))
        .get_operators_reader()
        .unwrap()
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let stores = operators
        .iter()
        .filter_map(|operator| match operator {
            Operator::I64Store { memarg } => Some(memarg.offset),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(stores, vec![u64::from(FRAME_HEADER + LANE_SIZE)]);
    for value in [ValueId(0), ValueId(1), ValueId(3), ValueId(4)] {
        assert!(!operators.iter().any(|operator| matches!(operator, Operator::LocalGet { local_index } if frame.value_locals[&value].contains(local_index))));
    }
}

#[test]
fn resumed_continuation_loads_only_its_parameters_and_captures() {
    let module = program();
    let layouts = RuntimeTypeLayouts::new(&module).unwrap();
    let manifest = build_manifest(&module, &layouts).unwrap();
    let frame = Frame::new(&module, &layouts, &module.functions[0], &manifest).unwrap();
    let mut body = Function::new([]);
    frame.load(&mut body.instructions(), ContinuationId(1));
    body.instructions().end();
    let bytes = body.into_raw_body();
    let operators = FunctionBody::new(BinaryReader::new(&bytes, 0))
        .get_operators_reader()
        .unwrap()
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut loaded = operators
        .iter()
        .filter_map(|operator| match operator {
            Operator::LocalSet { local_index } => Some(*local_index),
            _ => None,
        })
        .collect::<Vec<_>>();
    loaded.sort();
    let mut expected = frame.value_locals[&ValueId(2)].clone();
    expected.extend(&frame.value_locals[&ValueId(3)]);
    expected.sort();
    assert_eq!(loaded, expected);
}

#[test]
fn loop_edge_arguments_are_saved_in_parallel() {
    let mut module = program();
    module.signatures[0].parameters = vec![0, 0];
    module.capabilities.clear();
    let function = &mut module.functions[0];
    function.suspends = false;
    function.continuations.truncate(1);
    let entry = &mut function.continuations[0];
    entry.parameters = vec![definition(0), definition(1)];
    entry.instructions.clear();
    entry.transition = RuntimeTransition::Jump {
        edge: Edge {
            target: ContinuationId(0),
            arguments: vec![Argument::Value(ValueId(1)), Argument::Value(ValueId(0))],
        },
    };
    module.graph.validate(module.tables()).unwrap();
    let layouts = RuntimeTypeLayouts::new(&module).unwrap();
    let manifest = build_manifest(&module, &layouts).unwrap();
    let function = &module.functions[0];
    let frame = Frame::new(&module, &layouts, function, &manifest).unwrap();
    let RuntimeTransition::Jump { edge } = &function.continuations[0].transition else {
        panic!()
    };
    let mut body = Function::new([]);
    frame.save_edge(&mut body.instructions(), function, edge, None);
    body.instructions().end();
    let bytes = body.into_raw_body();
    let operators = FunctionBody::new(BinaryReader::new(&bytes, 0))
        .get_operators_reader()
        .unwrap()
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let assignments = operators
        .windows(2)
        .filter_map(|pair| match (&pair[0], &pair[1]) {
            (Operator::LocalGet { local_index }, Operator::I64Store { memarg }) => {
                Some((*local_index, memarg.offset))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        assignments,
        vec![
            (frame.value_locals[&ValueId(1)][0], u64::from(FRAME_HEADER)),
            (
                frame.value_locals[&ValueId(0)][0],
                u64::from(FRAME_HEADER + LANE_SIZE)
            ),
        ]
    );
    assert!(
        !operators
            .iter()
            .any(|operator| matches!(operator, Operator::LocalSet { .. }))
    );
}

#[test]
fn continuation_emission_produces_valid_wasm_for_a_host_request() {
    let module = program();
    let layouts = RuntimeTypeLayouts::new(&module).unwrap();
    let manifest = build_manifest(&module, &layouts).unwrap();
    let wasm = emit_dynamic_module(&module, &layouts, &manifest, b"{}").unwrap();
    wasmparser::Validator::new()
        .validate_all(&wasm)
        .expect("valid emitted continuation module");
}

#[test]
fn repeated_edge_destinations_retain_only_additional_references() {
    let roots = BTreeSet::from([ValueId(0), ValueId(1), ValueId(2)]);
    let transfers = RootTransfers::new(&roots, vec![ValueId(0), ValueId(0), ValueId(2)]);
    assert_eq!(transfers.retained, [ValueId(0)]);
    assert_eq!(transfers.released, [ValueId(1)]);
}

fn text_request_program() -> RuntimeModule {
    let mut module = program();
    module.types = vec![RuntimeType::Text];
    let function = &mut module.functions[0];
    function.continuations[0].instructions.clear();
    function.continuations[1].captures.clear();
    function.continuations[1].instructions.clear();
    function.continuations[1].transition = RuntimeTransition::Return { value: ValueId(3) };
    module
}

fn child_request_loop_program() -> RuntimeModule {
    let mut module = text_request_program();
    module.types = vec![
        RuntimeType::SignedInteger64,
        RuntimeType::Text,
        RuntimeType::Boolean,
    ];
    module.signatures = vec![
        RuntimeSignature {
            parameters: vec![0, 1],
            result: 1,
            effects: vec![],
        },
        RuntimeSignature {
            parameters: vec![1],
            result: 1,
            effects: vec![],
        },
    ];
    module.capabilities[0].operations[0].signature = 1;
    let typed = |value, type_id| Definition {
        type_id: TypeId(type_id),
        ..definition(value)
    };
    let mut one = operation(3, vec![], "constant");
    one.operation.value = Some(WireConstant::SignedInteger64("1".to_owned()));
    let mut next = operation(4, vec![ValueId(0), ValueId(3)], "scalar");
    next.operation.operator = Some("subtract");
    let mut zero = operation(5, vec![], "constant");
    zero.operation.value = Some(WireConstant::SignedInteger64("0".to_owned()));
    let mut again = operation(6, vec![ValueId(4), ValueId(5)], "scalar");
    again.definition.type_id = TypeId(2);
    again.operation.operator = Some("greater-than");
    let mut child = module.functions[0].clone();
    child.id = FunctionId(1);
    child.name = "request".to_owned();
    child.signature = SignatureId(1);
    child.continuations[0].parameters[0].type_id = TypeId(1);
    child.continuations[1].parameters[0].type_id = TypeId(1);
    if let RuntimeTransition::Call { signature, .. } = &mut child.continuations[0].transition {
        *signature = SignatureId(1);
    }
    module.functions[0].continuations = vec![
        RuntimeContinuation {
            id: ContinuationId(0),
            parameters: vec![typed(0, 0), typed(1, 1)],
            captures: vec![],
            instructions: vec![],
            span: span(),
            transition: RuntimeTransition::Call {
                target: CallTarget::Function {
                    function: FunctionId(1),
                },
                signature: SignatureId(1),
                arguments: vec![ValueId(1)],
                next: Edge {
                    target: ContinuationId(1),
                    arguments: vec![Argument::Result],
                },
                suspends: true,
            },
        },
        RuntimeContinuation {
            id: ContinuationId(1),
            parameters: vec![typed(2, 1)],
            captures: vec![typed(0, 0)],
            instructions: vec![one, next, zero, again],
            span: span(),
            transition: RuntimeTransition::Branch {
                condition: ValueId(6),
                consequent: Edge {
                    target: ContinuationId(0),
                    arguments: vec![Argument::Value(ValueId(4)), Argument::Value(ValueId(2))],
                },
                alternate: Edge {
                    target: ContinuationId(2),
                    arguments: vec![Argument::Value(ValueId(2))],
                },
            },
        },
        RuntimeContinuation {
            id: ContinuationId(2),
            parameters: vec![typed(7, 1)],
            captures: vec![],
            instructions: vec![],
            span: span(),
            transition: RuntimeTransition::Return { value: ValueId(7) },
        },
    ];
    module.functions.push(child);
    module
}

fn tail_request_program() -> RuntimeModule {
    let mut module = text_request_program();
    module.types = vec![RuntimeType::Text, RuntimeType::SignedInteger64];
    module.signatures = vec![
        RuntimeSignature {
            parameters: vec![0],
            result: 0,
            effects: vec![],
        },
        RuntimeSignature {
            parameters: vec![0],
            result: 0,
            effects: vec![],
        },
        RuntimeSignature {
            parameters: vec![1],
            result: 1,
            effects: vec![],
        },
    ];
    module.capabilities[0].operations[0].signature = 2;
    let mut child = module.functions[0].clone();
    child.id = FunctionId(1);
    child.name = "tail_request".to_owned();
    child.signature = SignatureId(1);
    let mut constant = operation(1, vec![], "constant");
    constant.definition.type_id = TypeId(1);
    constant.operation.value = Some(WireConstant::SignedInteger64("7".to_owned()));
    child.continuations[0].instructions = vec![constant];
    if let RuntimeTransition::Call {
        signature,
        arguments,
        ..
    } = &mut child.continuations[0].transition
    {
        *signature = SignatureId(2);
        *arguments = vec![ValueId(1)];
    }
    child.continuations[1].parameters[0].type_id = TypeId(1);
    child.continuations[1].captures = vec![
        definition(0),
        Definition {
            type_id: TypeId(1),
            ..definition(1)
        },
    ];
    let mut sum = operation(4, vec![ValueId(1), ValueId(3)], "scalar");
    sum.definition.type_id = TypeId(1);
    sum.operation.operator = Some("add");
    child.continuations[1].instructions = vec![sum];
    child.continuations[1].transition = RuntimeTransition::Return { value: ValueId(0) };
    if let RuntimeTransition::Call {
        target, signature, ..
    } = &mut module.functions[0].continuations[0].transition
    {
        *target = CallTarget::Function {
            function: FunctionId(1),
        };
        *signature = SignatureId(1);
    }
    module.functions.push(child);
    module
}

#[test]
fn managed_suspension_and_child_frame_loops_emit_valid_wasm() {
    for (name, module) in [
        ("scalar", program()),
        ("text", text_request_program()),
        ("children", child_request_loop_program()),
        ("tail", tail_request_program()),
    ] {
        module
            .graph
            .validate(module.tables())
            .expect("frame graph validates");
        let layouts = RuntimeTypeLayouts::new(&module).unwrap();
        let manifest = build_manifest(&module, &layouts).unwrap();
        let wasm = emit_dynamic_module(&module, &layouts, &manifest, b"{}").unwrap();
        wasmparser::Validator::new()
            .validate_all(&wasm)
            .expect("managed frame module validates");
        if let Ok(directory) = std::env::var("BLOT_FRAME_TEST_DIRECTORY") {
            std::fs::write(
                std::path::Path::new(&directory).join(format!("{name}.wasm")),
                wasm,
            )
            .expect("write requested managed frame fixture");
        }
    }
}
