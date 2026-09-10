use super::*;
use crate::hir::{RuntimeSignature, StagedBlock};

fn span() -> RuntimeSpan {
    RuntimeSpan {
        file: "continuation.blot".to_owned(),
        start: 1,
        end: 9,
    }
}

fn operation(kind: &'static str, result: usize, operands: &[usize]) -> StagedOperation {
    StagedOperation {
        kind,
        result,
        type_id: 0,
        operands: operands.to_vec(),
        ownership: "plain",
        span: span(),
        value: None,
        update: None,
        case: None,
        capability: None,
        operation: None,
        operator: None,
        conversion: None,
        lane: None,
        field: None,
        function: None,
        signature: None,
        static_store: None,
    }
}

fn constant(result: usize, value: i64) -> StagedOperation {
    StagedOperation {
        value: Some(WireConstant::SignedInteger64(value.to_string())),
        ..operation("constant", result, &[])
    }
}

fn parameter(value: usize, type_id: usize) -> StagedBlockParameter {
    StagedBlockParameter {
        value,
        type_id,
        ownership: "plain",
        span: span(),
    }
}

fn program() -> StagedModule {
    let call = StagedOperation {
        function: Some(1),
        signature: Some(1),
        ..operation("call.direct", 4, &[0])
    };
    let addition = StagedOperation {
        operator: Some("add"),
        ..operation("scalar", 5, &[4, 3])
    };
    StagedModule {
        checked_functions: Vec::new(),
        format: "blot-runtime-hir",
        schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
        source: "continuation.blot".to_owned(),
        types: vec![RuntimeType::SignedInteger64, RuntimeType::Boolean],
        signatures: vec![
            RuntimeSignature {
                parameters: vec![0, 1],
                result: 0,
                effects: Vec::new(),
            },
            RuntimeSignature {
                parameters: vec![0],
                result: 0,
                effects: Vec::new(),
            },
        ],
        static_stores: Vec::new(),
        capabilities: Vec::new(),
        links: Vec::new(),
        resumable_roots: Vec::new(),
        exports: Vec::new(),
        functions: vec![
            StagedFunction {
                id: 0,
                name: "main".to_owned(),
                signature: 0,
                reuse: None,
                entry_block: 0,
                span: span(),
                blocks: vec![
                    StagedBlock {
                        id: 0,
                        parameters: vec![parameter(0, 0), parameter(1, 1)],
                        operations: vec![constant(2, 100), constant(3, 5), call, addition],
                        terminator: StagedTerminator::Conditional {
                            condition: 1,
                            consequent: 1,
                            consequent_arguments: vec![5],
                            alternate: 1,
                            alternate_arguments: vec![0],
                            span: span(),
                        },
                    },
                    StagedBlock {
                        id: 1,
                        parameters: vec![parameter(6, 0)],
                        operations: Vec::new(),
                        terminator: StagedTerminator::Return {
                            value: 6,
                            span: span(),
                        },
                    },
                ],
            },
            StagedFunction {
                id: 1,
                name: "callee".to_owned(),
                signature: 1,
                reuse: None,
                entry_block: 0,
                span: span(),
                blocks: vec![StagedBlock {
                    id: 0,
                    parameters: vec![parameter(0, 0)],
                    operations: Vec::new(),
                    terminator: StagedTerminator::Return {
                        value: 0,
                        span: span(),
                    },
                }],
            },
        ],
    }
}

#[test]
fn continuation_captures_exclude_dead_values_and_the_unproduced_call_result() {
    let graph = Graph::lower(&program()).unwrap();
    let function = &graph.functions[0];
    assert_eq!(function.continuations.len(), 3);
    let continuation = &function.continuations[1];
    assert_eq!(
        continuation
            .parameters
            .iter()
            .map(|parameter| parameter.value)
            .collect::<Vec<_>>(),
        [ValueId(4)]
    );
    assert_eq!(
        continuation
            .captures
            .iter()
            .map(|capture| capture.value)
            .collect::<Vec<_>>(),
        [ValueId(0), ValueId(1), ValueId(3)]
    );
    assert!(function.continuations[2].captures.is_empty());
    let Transition::Branch {
        consequent,
        alternate,
        ..
    } = &continuation.transition
    else {
        panic!("call successor must branch")
    };
    assert_eq!(consequent.target, alternate.target);
    assert!(matches!(
        &consequent.arguments[..],
        [Argument::Value(ValueId(5))]
    ));
    assert!(matches!(
        &alternate.arguments[..],
        [Argument::Value(ValueId(0))]
    ));
}

#[test]
fn continuation_validation_refuses_stale_captures_and_unavailable_values() {
    let module = program();
    let graph = Graph::lower(&module).unwrap();
    let mut broken = graph.clone();
    broken.functions[0].continuations[1].captures.pop();
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("stale or unordered captures")
    );
    let mut broken = graph.clone();
    broken.functions[0].continuations[1].captures[0].type_id = TypeId(1);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("capture")
    );
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].id = ContinuationId(1000);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("occupies slot")
    );
    let mut broken = graph.clone();
    let Transition::Call { next, .. } = &mut broken.functions[0].continuations[0].transition else {
        panic!("first continuation must call")
    };
    next.target = ContinuationId(1000);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("absent continuation")
    );
    let mut broken = graph;
    let Transition::Call { next, .. } = &mut broken.functions[0].continuations[0].transition else {
        panic!("first continuation must call")
    };
    next.arguments.clear();
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("expects 1 arguments")
    );
}

#[test]
fn continuation_captures_values_transferred_to_unused_parameters() {
    let mut module = program();
    module.functions[0].blocks[1].operations = vec![constant(7, 42)];
    module.functions[0].blocks[1].terminator = StagedTerminator::Return {
        value: 7,
        span: span(),
    };
    let graph = Graph::lower(&module).unwrap();
    assert!(
        graph.functions[0].continuations[1]
            .captures
            .iter()
            .any(|capture| capture.value == ValueId(0))
    );
    graph.validate(module.tables()).unwrap();
}

#[test]
fn continuation_validation_requires_an_explicit_call_result_and_execution_contract() {
    let module = program();
    let graph = Graph::lower(&module).unwrap();
    let mut broken = graph.clone();
    let Transition::Call { next, .. } = &mut broken.functions[0].continuations[0].transition else {
        panic!("first continuation must call")
    };
    next.arguments[0] = Argument::Value(ValueId(0));
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("exactly one parameter")
    );

    let mut broken = graph.clone();
    broken.functions[0].suspends = true;
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("has no frame")
    );

    let mut broken = graph;
    broken.functions[0].framed = true;
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("without a frame")
    );
}

#[test]
fn continuation_suspension_propagates_and_rejects_a_live_borrow() {
    let mut module = program();
    module.resumable_roots.push(1);
    let graph = Graph::lower(&module).unwrap();
    assert!(
        graph
            .functions
            .iter()
            .all(|function| function.suspends && function.framed)
    );
    assert!(matches!(
        &graph.functions[0].continuations[0].transition,
        Transition::Call { suspends: true, .. }
    ));
    module.functions[0].blocks[0].operations[1].ownership = "borrowed";
    assert!(
        Graph::lower(&module)
            .err()
            .unwrap()
            .contains("retains borrowed value 3")
    );
}

#[test]
fn continuation_callback_frames_preserve_synchronous_export_execution() {
    let mut module = program();
    module.types.push(RuntimeType::Product {
        name: "CallbackEnvironment".to_owned(),
        fields: vec![crate::hir::RuntimeField {
            name: "capture00000000".to_owned(),
            type_id: 1,
        }],
    });
    module.types.push(RuntimeType::Callback {
        function: 0,
        signature: 0,
        environment_type: 2,
    });
    let graph = Graph::lower(&module).unwrap();
    assert!(
        graph
            .functions
            .iter()
            .all(|function| function.framed && !function.suspends)
    );
}

impl interpreter::Values for WireConstant {
    fn condition(&self) -> Result<bool, String> {
        match self {
            Self::Boolean(value) => Ok(*value),
            _ => Err("condition is not Boolean".to_owned()),
        }
    }

    fn matches(&self, constant: &WireConstant) -> bool {
        self == constant
    }
}

fn execute(
    instruction: &Instruction,
    arguments: Vec<WireConstant>,
) -> Result<WireConstant, String> {
    use crate::value::Value;
    match instruction.operation.kind {
        "constant" => Ok(instruction
            .operation
            .value
            .clone()
            .expect("checked constant")),
        "scalar" if instruction.operation.operator == Some("add") => {
            let values = arguments
                .into_iter()
                .map(|argument| match argument {
                    WireConstant::SignedInteger64(value) => Value::Int(value.parse().unwrap()),
                    _ => panic!("test addition expects integers"),
                })
                .collect();
            let result = crate::primitives::run_primitive(
                "@int.add",
                values,
                crate::ast::Span { start: 1, end: 9 },
                crate::eval::Phase::Runtime,
            )
            .map_err(|error| error.message)?;
            match result {
                Value::Int(value) => Ok(WireConstant::SignedInteger64(value.to_string())),
                _ => Err("integer addition returned a non-integer".to_owned()),
            }
        }
        kind => Err(format!("test oracle does not implement {kind}")),
    }
}

#[test]
fn continuation_interpreter_preserves_calls_and_parallel_edge_arguments() {
    let graph = Graph::lower(&program()).unwrap();
    for (condition, expected) in [(true, "15"), (false, "10")] {
        let mut machine = interpreter::Machine::new(
            &graph,
            FunctionId(0),
            vec![
                WireConstant::SignedInteger64("10".to_owned()),
                WireConstant::Boolean(condition),
            ],
        )
        .unwrap();
        let mut yields = 0;
        loop {
            match machine.poll(1, execute).unwrap() {
                interpreter::Observation::Yielded => yields += 1,
                interpreter::Observation::Returned(value) => {
                    assert_eq!(value, WireConstant::SignedInteger64(expected.to_owned()));
                    break;
                }
                _ => panic!("pure program must return"),
            }
        }
        assert_eq!(yields, 4);
    }
}

#[test]
fn continuation_interpreter_resumes_once_without_replaying_a_request() {
    use crate::hir::{
        RuntimeCapability, RuntimeCapabilityOperation, RuntimeEffectOwnership,
        RuntimeOperationContract,
    };
    let mut module = program();
    module.signatures[0].effects.push("Device".to_owned());
    module.capabilities.push(RuntimeCapability {
        name: "Device".to_owned(),
        operations: vec![RuntimeCapabilityOperation {
            name: "read".to_owned(),
            source_name: "read".to_owned(),
            signature: 1,
            contract: RuntimeOperationContract {
                input: RuntimeEffectOwnership::Mode("unrestricted"),
                result: RuntimeEffectOwnership::Mode("unrestricted"),
                suspends: true,
            },
        }],
    });
    let operation = &mut module.functions[0].blocks[0].operations[2];
    operation.kind = "host.call";
    operation.function = None;
    operation.capability = Some("Device".to_owned());
    operation.operation = Some("read".to_owned());
    let graph = Graph::lower(&module).unwrap();
    let mut machine = interpreter::Machine::new(
        &graph,
        FunctionId(0),
        vec![
            WireConstant::SignedInteger64("10".to_owned()),
            WireConstant::Boolean(true),
        ],
    )
    .unwrap();
    match machine.poll(10, execute).unwrap() {
        interpreter::Observation::Request {
            target:
                CallTarget::Host {
                    capability,
                    operation,
                },
            arguments,
        } => {
            assert_eq!(capability, "Device");
            assert_eq!(operation, "read");
            assert_eq!(arguments, [WireConstant::SignedInteger64("10".to_owned())]);
        }
        _ => panic!("host program must request"),
    }
    assert!(machine.poll(10, execute).is_err());
    machine
        .resume(WireConstant::SignedInteger64("30".to_owned()))
        .unwrap();
    assert!(
        machine
            .resume(WireConstant::SignedInteger64("99".to_owned()))
            .is_err()
    );
    match machine.poll(10, execute).unwrap() {
        interpreter::Observation::Returned(value) => {
            assert_eq!(value, WireConstant::SignedInteger64("35".to_owned()));
        }
        _ => panic!("resumption must finish without another request"),
    }
    machine.cancel();
    assert!(
        machine
            .resume(WireConstant::SignedInteger64("99".to_owned()))
            .is_err()
    );
    match machine.poll(10, execute).unwrap() {
        interpreter::Observation::Trapped(message) => assert_eq!(message, "cancelled"),
        _ => panic!("cancelled interpreter must not run"),
    }
}

fn contract_module(
    types: Vec<RuntimeType>,
    parameters: Vec<usize>,
    operations: Vec<StagedOperation>,
    result: (usize, usize),
) -> StagedModule {
    let mut module = program();
    module.types = types;
    module.signatures = vec![RuntimeSignature {
        parameters: parameters.clone(),
        result: result.1,
        effects: Vec::new(),
    }];
    module.functions.truncate(1);
    module.functions[0].blocks = vec![StagedBlock {
        id: 0,
        parameters: parameters
            .into_iter()
            .enumerate()
            .map(|(value, type_id)| parameter(value, type_id))
            .collect(),
        operations,
        terminator: StagedTerminator::Return {
            value: result.0,
            span: span(),
        },
    }];
    module
}

#[test]
fn continuation_validation_requires_callback_environment_and_matching_target() {
    let mut module = program();
    module.types.push(RuntimeType::Product {
        name: "Environment".to_owned(),
        fields: Vec::new(),
    });
    module.types.push(RuntimeType::Callback {
        function: 1,
        signature: 1,
        environment_type: 2,
    });
    let mut environment = operation("product.make", 7, &[]);
    environment.type_id = 2;
    let mut callback = operation("callback.make", 8, &[7]);
    callback.type_id = 3;
    callback.function = Some(1);
    module.functions[0].blocks[0]
        .operations
        .splice(0..0, [environment, callback]);
    let graph = Graph::lower(&module).unwrap();
    for operands in [Vec::new(), vec![ValueId(0)], vec![ValueId(7), ValueId(7)]] {
        let mut broken = graph.clone();
        broken.functions[0].continuations[0].instructions[1].operands = operands;
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("callback.make instruction")
        );
    }
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[1]
        .operation
        .function = Some(FunctionId(0));
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("callback.make instruction")
    );
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[1]
        .operation
        .signature = Some(SignatureId(0));
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("callback.make instruction")
    );
    let RuntimeType::Product { fields, .. } = &mut module.types[2] else {
        unreachable!()
    };
    fields.push(crate::hir::RuntimeField {
        name: "capture00000000".to_owned(),
        type_id: 0,
    });
    assert!(
        graph
            .validate(module.tables())
            .unwrap_err()
            .contains("captured parameters")
    );
}

#[test]
fn continuation_validation_checks_scalar_operands_results_and_finite_metadata() {
    let mut add = operation("scalar", 2, &[0, 0]);
    add.operator = Some("add");
    let module = contract_module(
        vec![RuntimeType::SignedInteger64, RuntimeType::Boolean],
        vec![0, 1],
        vec![add],
        (2, 0),
    );
    let graph = Graph::lower(&module).unwrap();
    for operands in [
        Vec::new(),
        vec![ValueId(0)],
        vec![ValueId(0), ValueId(1)],
        vec![ValueId(0); 3],
    ] {
        let mut broken = graph.clone();
        broken.functions[0].continuations[0].instructions[0].operands = operands;
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("scalar instruction")
        );
    }
    for operator in [None, Some("invented-operator")] {
        let mut broken = graph.clone();
        broken.functions[0].continuations[0].instructions[0]
            .operation
            .operator = operator;
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("scalar instruction")
        );
    }
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[0]
        .definition
        .type_id = TypeId(1);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("scalar instruction")
    );
    let mut broken = graph;
    broken.functions[0].continuations[0].instructions[0]
        .operation
        .kind = "unknown.operation";
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("unknown.operation instruction")
    );
}

#[test]
fn continuation_validation_requires_explicit_unit_payload_and_store_initializer() {
    let types = vec![
        RuntimeType::Unit,
        RuntimeType::SignedInteger64,
        RuntimeType::Sum {
            name: "Choice".to_owned(),
            cases: vec![crate::hir::RuntimeCase {
                name: "Empty".to_owned(),
                payload_type: 0,
            }],
        },
        RuntimeType::Store { element_type: 1 },
    ];
    let mut sum = operation("sum.make", 2, &[0]);
    sum.type_id = 2;
    sum.case = Some(0);
    let mut store = operation("store.new", 3, &[1, 1]);
    store.type_id = 3;
    let module = contract_module(types, vec![0, 1], vec![sum, store], (3, 3));
    let graph = Graph::lower(&module).unwrap();
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[0]
        .operands
        .clear();
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("sum.make instruction")
    );
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[1]
        .operands
        .pop();
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("store.new instruction")
    );
    let mut broken = graph;
    broken.functions[0].continuations[0].instructions[0]
        .operation
        .case = Some(99);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("sum.make instruction")
    );
}

#[test]
fn continuation_validation_checks_static_store_and_product_projection_types() {
    let types = vec![
        RuntimeType::SignedInteger64,
        RuntimeType::Boolean,
        RuntimeType::Product {
            name: "Pair".to_owned(),
            fields: vec![
                crate::hir::RuntimeField {
                    name: "number".to_owned(),
                    type_id: 0,
                },
                crate::hir::RuntimeField {
                    name: "condition".to_owned(),
                    type_id: 1,
                },
            ],
        },
        RuntimeType::Store { element_type: 0 },
    ];
    let mut projection = operation("product.project", 1, &[0]);
    projection.field = Some(0);
    let mut literal = operation("store.literal", 2, &[]);
    literal.type_id = 3;
    literal.static_store = Some(0);
    let mut module = contract_module(types, vec![2], vec![projection, literal], (1, 0));
    module.static_stores.push(RuntimeStaticStore {
        element_type: 0,
        values: vec![WireConstant::SignedInteger64("7".to_owned())],
    });
    let graph = Graph::lower(&module).unwrap();
    for field in [None, Some(1), Some(99)] {
        let mut broken = graph.clone();
        broken.functions[0].continuations[0].instructions[0]
            .operation
            .field = field;
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("product.project instruction")
        );
    }
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[1]
        .operation
        .static_store = Some(99);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("store.literal instruction")
    );
    module.static_stores[0].values[0] = WireConstant::Boolean(true);
    assert!(
        graph
            .validate(module.tables())
            .unwrap_err()
            .contains("static Store constant")
    );
}

#[test]
fn continuation_validation_checks_vector_shape_lane_and_constant_shuffle_selectors() {
    let types = vec![
        RuntimeType::Float32,
        RuntimeType::Integer32,
        RuntimeType::Vector {
            element: "float-32",
            lanes: 4,
        },
    ];
    let mut selector = operation("constant", 1, &[]);
    selector.type_id = 1;
    selector.value = Some(WireConstant::SignedInteger32(7));
    let mut shuffle = operation("vector", 2, &[0, 0, 1, 1, 1, 1]);
    shuffle.type_id = 2;
    shuffle.operator = Some("shuffle");
    let module = contract_module(types, vec![2], vec![selector, shuffle], (2, 2));
    let graph = Graph::lower(&module).unwrap();
    for selector in [-1, 8] {
        let mut broken = graph.clone();
        broken.functions[0].continuations[0].instructions[0]
            .operation
            .value = Some(WireConstant::SignedInteger32(selector));
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("vector instruction")
        );
    }
    let mut broken = graph.clone();
    broken.functions[0].continuations[0].instructions[1]
        .operands
        .pop();
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("vector instruction")
    );
    let mut module = module;
    let extract = &mut module.functions[0].blocks[0].operations[1];
    extract.operands = vec![0];
    extract.operator = Some("extract");
    extract.lane = Some(3);
    extract.type_id = 0;
    module.signatures[0].result = 0;
    let graph = Graph::lower(&module).unwrap();
    for lane in [None, Some(4)] {
        let mut broken = graph.clone();
        broken.functions[0].continuations[0].instructions[1]
            .operation
            .lane = lane;
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("vector instruction")
        );
    }
}

#[test]
fn continuation_validation_checks_call_return_capture_and_switch_contracts() {
    let mut module = program();
    let graph = Graph::lower(&module).unwrap();
    for arguments in [vec![], vec![ValueId(1)], vec![ValueId(0), ValueId(0)]] {
        let mut broken = graph.clone();
        let Transition::Call {
            arguments: actual, ..
        } = &mut broken.functions[0].continuations[0].transition
        else {
            unreachable!()
        };
        *actual = arguments;
        assert!(
            broken
                .validate(module.tables())
                .unwrap_err()
                .contains("call arguments")
        );
    }
    let mut broken = graph.clone();
    broken.functions[0].continuations[1].captures[0].ownership = "borrowed";
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("changed representation or ownership")
    );
    module.signatures[0].result = 1;
    assert!(
        graph
            .validate(module.tables())
            .unwrap_err()
            .contains("return disagrees")
    );

    let module = contract_module(vec![RuntimeType::SignedInteger64], vec![0], vec![], (0, 0));
    let mut graph = Graph::lower(&module).unwrap();
    let edge = Edge {
        target: ContinuationId(0),
        arguments: vec![Argument::Value(ValueId(0))],
    };
    graph.functions[0].continuations[0].transition = Transition::Switch {
        selector: ValueId(0),
        cases: vec![(WireConstant::SignedInteger64("7".to_owned()), edge.clone())],
        fallback: edge.clone(),
    };
    graph.validate(module.tables()).unwrap();
    let mut broken = graph.clone();
    let Transition::Switch { cases, .. } = &mut broken.functions[0].continuations[0].transition
    else {
        unreachable!()
    };
    cases[0].0 = WireConstant::SignedInteger32(7);
    assert!(
        broken
            .validate(module.tables())
            .unwrap_err()
            .contains("switch case disagrees")
    );
    let Transition::Switch { cases, .. } = &mut graph.functions[0].continuations[0].transition
    else {
        unreachable!()
    };
    cases.push((WireConstant::SignedInteger64("07".to_owned()), edge));
    assert!(
        graph
            .validate(module.tables())
            .unwrap_err()
            .contains("switch repeats")
    );
}
