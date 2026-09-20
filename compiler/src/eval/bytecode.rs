//! Revision-local executable instructions. Code reuse never grants value reuse.
use super::*;
use std::cell::OnceCell;

mod bindings;
pub(super) use bindings::Locals;

#[cfg(test)]
mod tests;

type CapturePlans = HashMap<(PatternId, ExpressionId), Rc<[String]>>;

pub(super) struct Program {
    source: Rc<Module>,
    instructions: Vec<OnceCell<Instruction>>,
    bindings: RefCell<HashMap<(PatternId, ExpressionId), Rc<bindings::Layout>>>,
    captures: RefCell<CapturePlans>,
}

enum Instruction {
    Semantic,
    Constant(Rc<Value>),
    EmptyArray,
    EmptyShape,
    Integer(crate::integer::Integer),
    Float(f64),
    Load(Rc<str>),
    Closure {
        parameter: PatternId,
        body: ExpressionId,
        deferred: bool,
    },
    Apply {
        function: ExpressionId,
        argument: ExpressionId,
    },
    Project {
        target: ExpressionId,
        name: Rc<str>,
    },
    Tuple(Rc<[ExpressionId]>),
    Array(Rc<[crate::ast::ArrayElement]>),
    Shape(Rc<[ShapeMember]>),
    Branch {
        branches: Rc<[crate::ast::Branch]>,
        fallback: Option<ExpressionId>,
    },
    Case {
        target: ExpressionId,
        arms: Rc<[crate::ast::Arm]>,
    },
}

impl Program {
    fn new(source: Rc<Module>) -> Self {
        Self {
            instructions: (0..source.arena.expressions.len())
                .map(|_| OnceCell::new())
                .collect(),
            source,
            bindings: RefCell::new(HashMap::new()),
            captures: RefCell::new(HashMap::new()),
        }
    }

    fn instruction(&self, expression: ExpressionId) -> &Instruction {
        self.instructions[expression.0 as usize].get_or_init(|| {
            crate::phase_telemetry::note_instruction_compiled();
            match &self.source.arena.expressions[expression.0 as usize] {
                Expression::Unit { .. } => Instruction::Constant(Rc::new(Value::Unit)),
                Expression::Text { value, .. } => {
                    Instruction::Constant(Rc::new(Value::Text(value.as_str().into())))
                }
                Expression::Tag { name, .. } => Instruction::Constant(Rc::new(Value::Tag {
                    name: name.clone(),
                    payload: None,
                })),
                Expression::Int { value, .. } => Instruction::Integer(value.clone()),
                Expression::Float { value, .. } => Instruction::Float(*value),
                Expression::Var { name, .. } => Instruction::Load(name.as_str().into()),
                Expression::Lambda {
                    parameter,
                    body,
                    deferred,
                    ..
                } => Instruction::Closure {
                    parameter: *parameter,
                    body: *body,
                    deferred: *deferred,
                },
                Expression::Intrinsic { name, .. } if name == "@array.empty" => {
                    Instruction::EmptyArray
                }
                Expression::Intrinsic { name, .. } if name == "@shape.empty" => {
                    Instruction::EmptyShape
                }
                Expression::Intrinsic { name, span } => match intrinsic(name.clone(), *span) {
                    Computation::Done(Ok(value)) => Instruction::Constant(Rc::new(value)),
                    Computation::Done(Err(_)) => Instruction::Semantic,
                    _ => unreachable!("primitive loading performs no computation"),
                },
                Expression::Apply {
                    function, argument, ..
                } => Instruction::Apply {
                    function: *function,
                    argument: *argument,
                },
                Expression::Field { target, name, .. } => Instruction::Project {
                    target: *target,
                    name: name.as_str().into(),
                },
                Expression::Tuple { elements, .. } => Instruction::Tuple(elements.clone().into()),
                Expression::Array { elements, .. } => Instruction::Array(elements.clone().into()),
                Expression::Shape { members, .. } => Instruction::Shape(members.clone().into()),
                Expression::If {
                    branches, fallback, ..
                } => Instruction::Branch {
                    branches: branches.clone().into(),
                    fallback: *fallback,
                },
                Expression::Case { target, arms, .. } => Instruction::Case {
                    target: *target,
                    arms: arms.clone().into(),
                },
                _ => Instruction::Semantic,
            }
        })
    }
}

struct Activation {
    context: Rc<Context>,
    module: Rc<String>,
    program: Rc<Program>,
    environment: Environment,
    runtime: Runtime,
}

enum Action {
    Evaluate {
        activation: Rc<Activation>,
        expression: ExpressionId,
    },
    Complete(Result<Value, Diagnostic>),
    Semantic(Computation),
}

enum Frame {
    Return(CallReturn),
    Origin(Rc<String>),
    External(ComputationContinuation),
    ApplyFunction {
        activation: Rc<Activation>,
        argument: ExpressionId,
        evidence: CallEvidence,
    },
    ApplyArgument {
        activation: Rc<Activation>,
        function: Value,
        evidence: CallEvidence,
    },
    Project {
        name: Rc<str>,
        span: Span,
    },
    Tuple {
        activation: Rc<Activation>,
        expressions: Rc<[ExpressionId]>,
        values: Vec<Value>,
    },
    Array {
        activation: Rc<Activation>,
        elements: Rc<[crate::ast::ArrayElement]>,
        index: usize,
        values: crate::value::ArrayValues,
        span: Span,
    },
    ShapeName {
        activation: Rc<Activation>,
        members: Rc<[ShapeMember]>,
        index: usize,
        fields: OrderedFields,
        span: Span,
    },
    ShapeValue {
        activation: Rc<Activation>,
        members: Rc<[ShapeMember]>,
        index: usize,
        fields: OrderedFields,
        name: Option<String>,
        span: Span,
    },
    Branch {
        activation: Rc<Activation>,
        branches: Rc<[crate::ast::Branch]>,
        fallback: Option<ExpressionId>,
        index: usize,
        span: Span,
    },
    Case {
        activation: Rc<Activation>,
        arms: Rc<[crate::ast::Arm]>,
        checked_result: Option<Value>,
        span: Span,
    },
}

struct CallEvidence {
    application: ApplicationSite,
    expected_argument: Option<Value>,
    expected_result: Option<Value>,
    span: Span,
}

pub(super) struct Machine {
    action: Action,
    frames: Vec<Frame>,
}

pub(super) struct Call {
    activation: Rc<Activation>,
    body: ExpressionId,
    completion: CallReturn,
}

impl Call {
    pub(super) fn enter(
        context: Rc<Context>,
        module: Rc<String>,
        body: ExpressionId,
        environment: Environment,
        runtime: Runtime,
        completion: CallReturn,
    ) -> Computation {
        let program = {
            let modules = context.modules.borrow();
            let loaded = modules
                .get(module.as_str())
                .expect("a checked call retains its source module");
            loaded
                .bytecode
                .get_or_init(|| Rc::new(Program::new(loaded.module.clone())))
                .clone()
        };
        Computation::Step(ComputationStep {
            next: ComputationAction::Call(Box::new(Self {
                activation: Rc::new(Activation {
                    context,
                    module,
                    program,
                    environment,
                    runtime,
                }),
                body,
                completion,
            })),
            continuations: VecDeque::new(),
        })
    }
}

impl Machine {
    pub(super) fn from_call(call: Call) -> Self {
        Self {
            action: Action::Evaluate {
                activation: call.activation,
                expression: call.body,
            },
            frames: vec![Frame::Return(call.completion)],
        }
    }

    pub(super) fn start(
        context: &Rc<Context>,
        module: &Rc<String>,
        expression: ExpressionId,
        environment: &Environment,
        runtime: &Runtime,
    ) -> Option<Self> {
        let program = {
            let modules = context.modules.borrow();
            let loaded = modules.get(module.as_str())?;
            loaded.module.arena.expressions.get(expression.0 as usize)?;
            let program = loaded
                .bytecode
                .get_or_init(|| Rc::new(Program::new(loaded.module.clone())))
                .clone();
            if matches!(
                program.instruction(expression),
                Instruction::Semantic
                    | Instruction::Constant(_)
                    | Instruction::Integer(_)
                    | Instruction::Float(_)
                    | Instruction::Load(_)
                    | Instruction::Closure { .. }
            ) {
                return None;
            }
            program
        };
        Some(Self {
            action: Action::Evaluate {
                activation: Rc::new(Activation {
                    context: context.clone(),
                    module: module.clone(),
                    program,
                    environment: environment.clone(),
                    runtime: runtime.clone(),
                }),
                expression,
            },
            frames: Vec::new(),
        })
    }

    pub(super) fn run(mut self) -> Computation {
        let telemetry = crate::phase_telemetry::is_active();
        let mut instructions = 0;
        let mut semantic_steps = 0;
        let mut peak_frames = self.frames.len();
        loop {
            if telemetry {
                peak_frames = peak_frames.max(self.frames.len());
            }
            let action = std::mem::replace(&mut self.action, Action::Complete(Ok(Value::Unit)));
            match action {
                Action::Evaluate {
                    activation,
                    expression,
                } => {
                    if telemetry
                        && !matches!(
                            activation.program.instruction(expression),
                            Instruction::Semantic
                        )
                    {
                        instructions += 1;
                    }
                    self.evaluate(activation, expression);
                }
                Action::Semantic(computation) => match computation {
                    Computation::Done(result) => self.action = Action::Complete(result),
                    Computation::Step(step) => {
                        self.frames
                            .extend(step.continuations.into_iter().rev().map(Frame::External));
                        match step.next {
                            ComputationAction::Callback(next) => {
                                if telemetry {
                                    semantic_steps += 1;
                                }
                                self.action = Action::Semantic(next())
                            }
                            ComputationAction::Bytecode(mut machine) => {
                                self.frames.append(&mut machine.frames);
                                self.action = machine.action;
                            }
                            ComputationAction::Call(call) => {
                                self.frames.push(Frame::Return(call.completion));
                                self.action = Action::Evaluate {
                                    activation: call.activation,
                                    expression: call.body,
                                };
                            }
                        }
                    }
                    Computation::Perform { request, resume } => {
                        if telemetry {
                            crate::phase_telemetry::note_machine(
                                instructions,
                                semantic_steps,
                                peak_frames,
                            );
                        }
                        return Computation::perform(request, move |value| {
                            self.action = Action::Semantic(resume.advance(value));
                            self.run()
                        });
                    }
                },
                Action::Complete(result) => {
                    let Some(frame) = self.frames.pop() else {
                        if telemetry {
                            crate::phase_telemetry::note_machine(
                                instructions,
                                semantic_steps,
                                peak_frames,
                            );
                        }
                        return Computation::Done(result);
                    };
                    if telemetry
                        && matches!(
                            frame,
                            Frame::External(
                                ComputationContinuation::Value(_)
                                    | ComputationContinuation::Result(_)
                            )
                        )
                    {
                        semantic_steps += 1;
                    }
                    self.resume(frame, result);
                }
            }
        }
    }

    fn evaluate(&mut self, activation: Rc<Activation>, expression: ExpressionId) {
        let program = activation.program.clone();
        let instruction = program.instruction(expression);
        if matches!(instruction, Instruction::Semantic) {
            self.action = Action::Semantic(evaluate_ast_expression(
                activation.context.clone(),
                activation.module.clone(),
                expression,
                activation.environment.clone(),
                activation.runtime.clone(),
            ));
            return;
        }
        let span = program.source.arena.expression_span(expression);
        let remaining = activation.runtime.fuel.get() - 1;
        activation.runtime.fuel.set(remaining);
        self.frames.push(Frame::Origin(activation.module.clone()));
        if remaining < 0 {
            self.action = Action::Complete(Err(Diagnostic::new(
                "BLOT_EVALUATION_LIMIT",
                format!(
                    "Evaluation of `{}` expression {} at bytes {}..{} exceeded its deterministic limit of {} steps.",
                    activation.module, expression.0, span.start, span.end, activation.runtime.limit,
                ),
                span,
            )));
            return;
        }
        if let Some(variable) = activation
            .runtime
            .signature_holes
            .as_ref()
            .filter(|holes| holes.module == activation.module)
            .and_then(|holes| holes.expressions.get(&expression))
            .copied()
        {
            self.action = Action::Complete(Ok(Value::TypeVariable(variable)));
            return;
        }
        let child = if activation.runtime.result_context.is_none() {
            activation.clone()
        } else {
            let mut runtime = activation.runtime.clone();
            runtime.result_context = None;
            Rc::new(Activation {
                runtime,
                context: activation.context.clone(),
                module: activation.module.clone(),
                program: program.clone(),
                environment: activation.environment.clone(),
            })
        };
        match instruction {
            Instruction::Semantic => unreachable!(),
            Instruction::Constant(value) => {
                self.action = Action::Complete(Ok(value.as_ref().clone()))
            }
            Instruction::EmptyArray => {
                self.action = Action::Complete(Ok(Value::Array(Vec::new().into())))
            }
            Instruction::EmptyShape => {
                self.action = Action::Complete(Ok(Value::Shape(OrderedFields::default())))
            }
            Instruction::Integer(value) => {
                let representation = activation
                    .runtime
                    .expression_type(&activation.context, &activation.module, expression)
                    .map(|type_| substitute_signature(&type_, &activation.environment));
                let converted = match representation {
                    Some(Value::Range {
                        domain: Some(ValueDomain::Float),
                        ..
                    }) => value.to_f64().map(Value::Float).ok_or_else(|| {
                        Diagnostic::new(
                            "BLOT_INTEGER_OVERFLOW",
                            format!("The integer literal {value} cannot be represented as F64."),
                            span,
                        )
                    }),
                    Some(Value::Range {
                        domain: Some(ValueDomain::Float32),
                        ..
                    }) => value.to_f32().map(Value::Float32).ok_or_else(|| {
                        Diagnostic::new(
                            "BLOT_INTEGER_OVERFLOW",
                            format!("The integer literal {value} cannot be represented as F32."),
                            span,
                        )
                    }),
                    _ if activation.runtime.phase == Phase::Runtime && value.to_i64().is_none() => {
                        Err(Diagnostic::new(
                            "BLOT_INTEGER_OVERFLOW",
                            format!("The runtime integer {value} is outside signed i64."),
                            span,
                        ))
                    }
                    _ => Ok(Value::Int(value.clone())),
                };
                self.action = Action::Complete(converted);
            }
            Instruction::Float(value) => {
                let representation = activation
                    .runtime
                    .expression_type(&activation.context, &activation.module, expression)
                    .map(|type_| substitute_signature(&type_, &activation.environment));
                let value = if matches!(
                    representation,
                    Some(Value::Range {
                        domain: Some(ValueDomain::Float32),
                        ..
                    })
                ) {
                    Value::Float32(*value as f32)
                } else {
                    Value::Float(*value)
                };
                self.action = Action::Complete(Ok(value));
            }
            Instruction::Load(name) => match activation.runtime.load(
                &activation.module,
                expression,
                &activation.environment,
                name,
            ) {
                Some(Value::Deferred {
                    module,
                    expression,
                    environment,
                    demands,
                }) => {
                    let mut demands = demands.borrow_mut();
                    let demands = demands.blocks_for(&activation.runtime.execution);
                    if !demands.is_empty() {
                        self.action = Action::Complete(Err(Diagnostic::new(
                            "BLOT_DEFERRED_DEMANDED_TWICE",
                            format!(
                                "Deferred parameter `{name}` was demanded more than once. Force it once into an ordinary `let` binding before reusing the value."
                            ),
                            span,
                        )));
                    } else {
                        demands.push(None);
                        let mut runtime = child.runtime.clone();
                        runtime.locals = None;
                        self.action = Action::Semantic(evaluate_expression(
                            activation.context.clone(),
                            module,
                            expression,
                            environment,
                            runtime,
                        ));
                    }
                }
                Some(mut value) => {
                    if let Value::Closure { signature, .. } = &mut value
                        && signature.is_none()
                        && let Some(inferred) = lookup_signature(&activation.environment, name)
                    {
                        *signature = Some(Rc::new(inferred));
                    }
                    self.action = Action::Complete(Ok(value));
                }
                None => {
                    self.action = Action::Complete(Err(Diagnostic::new(
                        "BLOT_UNBOUND",
                        format!("`{name}` is not in scope."),
                        span,
                    )))
                }
            },
            Instruction::Closure {
                parameter,
                body,
                deferred,
            } => {
                let environment = match &activation.runtime.locals {
                    Some(locals) => locals.capture(
                        &activation.context,
                        &activation.module,
                        *parameter,
                        *body,
                        &activation.environment,
                    ),
                    None => {
                        capture_env(&activation.environment);
                        activation.environment.clone()
                    }
                };
                let signature = activation
                    .runtime
                    .closure_signature(&activation.context, &activation.module, *body)
                    .map(|signature| {
                        Rc::new(substitute_signature(&signature, &activation.environment))
                    });
                self.action = Action::Complete(Ok(Value::Closure {
                    module: activation.module.clone(),
                    module_instances: activation.runtime.module_instances.clone(),
                    effect_scope: activation.runtime.effect_scope.clone(),
                    parameter: *parameter,
                    body: *body,
                    deferred: *deferred,
                    environment,
                    self_name: None,
                    imports: None,
                    signature,
                    reuse_assertion: None,
                }));
            }
            Instruction::Apply { function, argument } => {
                match prepare_application(
                    &activation.context,
                    &activation.module,
                    &program.source,
                    expression,
                    function,
                    argument,
                    &activation.environment,
                    &activation.runtime,
                    activation.runtime.result_context.clone(),
                    span,
                ) {
                    Ok(PreparedApplication::Value(value)) => {
                        self.action = Action::Complete(Ok(value))
                    }
                    Err(error) => self.action = Action::Complete(Err(error)),
                    Ok(PreparedApplication::Call {
                        application,
                        expected_argument,
                        expected_result,
                    }) => {
                        self.frames.push(Frame::ApplyFunction {
                            activation: child.clone(),
                            argument: *argument,
                            evidence: CallEvidence {
                                application,
                                expected_argument,
                                expected_result,
                                span,
                            },
                        });
                        self.action = Action::Evaluate {
                            activation: child,
                            expression: *function,
                        };
                    }
                }
            }
            Instruction::Project { target, name } => {
                self.frames.push(Frame::Project {
                    name: name.clone(),
                    span,
                });
                self.action = Action::Evaluate {
                    activation: child,
                    expression: *target,
                };
            }
            Instruction::Tuple(expressions) => {
                if let Some(first) = expressions.first() {
                    self.frames.push(Frame::Tuple {
                        activation: child.clone(),
                        expressions: expressions.clone(),
                        values: Vec::with_capacity(expressions.len()),
                    });
                    self.action = Action::Evaluate {
                        activation: child,
                        expression: *first,
                    };
                } else {
                    self.action = Action::Complete(Ok(tuple(Vec::new())));
                }
            }
            Instruction::Array(elements) => {
                // Numeric/aggregate evidence remains a demand of the source entry.
                let _representation = activation
                    .runtime
                    .expression_type(&activation.context, &activation.module, expression)
                    .map(|type_| substitute_signature(&type_, &activation.environment));
                if let Some(first) = elements.first() {
                    self.frames.push(Frame::Array {
                        activation: child.clone(),
                        elements: elements.clone(),
                        index: 0,
                        values: Vec::with_capacity(elements.len()).into(),
                        span,
                    });
                    self.action = Action::Evaluate {
                        activation: child,
                        expression: first.value,
                    };
                } else {
                    self.action = Action::Complete(Ok(Value::Array(Vec::new().into())));
                }
            }
            Instruction::Shape(members) => {
                self.shape(child, members.clone(), 0, OrderedFields::default(), span)
            }
            Instruction::Branch { branches, fallback } => {
                self.branch(activation, branches.clone(), *fallback, 0, span)
            }
            Instruction::Case { target, arms } => {
                let checked_result = activation
                    .runtime
                    .expression_type(&activation.context, &activation.module, expression)
                    .map(|type_| substitute_signature(&type_, &activation.environment));
                self.frames.push(Frame::Case {
                    activation,
                    arms: arms.clone(),
                    checked_result,
                    span,
                });
                self.action = Action::Evaluate {
                    activation: child,
                    expression: *target,
                };
            }
        }
    }

    fn branch(
        &mut self,
        activation: Rc<Activation>,
        branches: Rc<[crate::ast::Branch]>,
        fallback: Option<ExpressionId>,
        index: usize,
        span: Span,
    ) {
        if let Some(branch) = branches.get(index) {
            let expression = branch.condition;
            let mut runtime = activation.runtime.clone();
            runtime.result_context = None;
            let condition = Rc::new(Activation {
                context: activation.context.clone(),
                module: activation.module.clone(),
                program: activation.program.clone(),
                environment: activation.environment.clone(),
                runtime,
            });
            self.frames.push(Frame::Branch {
                activation,
                branches,
                fallback,
                index,
                span,
            });
            self.action = Action::Evaluate {
                activation: condition,
                expression,
            };
        } else if let Some(expression) = fallback {
            self.action = Action::Evaluate {
                activation,
                expression,
            };
        } else {
            self.action = Action::Complete(Err(Diagnostic::new(
                "BLOT_NO_BRANCH",
                "No branch matched and there is no `else`.",
                span,
            )));
        }
    }

    fn resume(&mut self, frame: Frame, result: Result<Value, Diagnostic>) {
        let frame = match frame {
            Frame::Origin(module) | Frame::External(ComputationContinuation::Origin(module)) => {
                self.action = Action::Complete(result.map_err(|error| error.at(&module)));
                return;
            }
            Frame::External(ComputationContinuation::Result(next)) => {
                self.action = Action::Semantic(next(result));
                return;
            }
            frame => frame,
        };
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                self.action = Action::Complete(Err(error));
                return;
            }
        };
        match frame {
            Frame::Return(completion) => {
                self.action = Action::Complete(Ok(completion.finish(value)))
            }
            Frame::External(ComputationContinuation::Value(next)) => {
                self.action = Action::Semantic(next(value))
            }
            Frame::ApplyFunction {
                activation,
                argument,
                evidence,
            } => {
                let mut function = value;
                while let Value::Extended { inner, .. } = function {
                    function = *inner;
                }
                let deferred = match &function {
                    Value::Closure { deferred, .. } => *deferred,
                    Value::ClosureChoice { alternatives, .. } => {
                        let deferred = alternatives.first().is_some_and(|choice| choice.deferred());
                        if alternatives
                            .iter()
                            .any(|choice| choice.deferred() != deferred)
                        {
                            self.action = Action::Complete(Err(Diagnostic::new(
                                "BLOT_RUST_INVARIANT",
                                "One runtime function choice mixed strict and deferred arrows.",
                                evidence.span,
                            )));
                            return;
                        }
                        deferred
                    }
                    _ => false,
                };
                if deferred {
                    capture_env(&activation.environment);
                    let suspended = Value::Deferred {
                        module: activation.module.clone(),
                        expression: argument,
                        environment: activation.environment.clone(),
                        demands: Rc::new(RefCell::new(DeferredDemands::default())),
                    };
                    self.apply(activation, function, suspended, evidence);
                } else {
                    self.frames.push(Frame::ApplyArgument {
                        activation: activation.clone(),
                        function,
                        evidence,
                    });
                    self.action = Action::Evaluate {
                        activation,
                        expression: argument,
                    };
                }
            }
            Frame::ApplyArgument {
                activation,
                function,
                evidence,
            } => self.apply(activation, function, value, evidence),
            Frame::Project { name, span } => {
                self.action = Action::Semantic(project(value, &name, span))
            }
            Frame::Tuple {
                activation,
                expressions,
                mut values,
            } => {
                values.push(value);
                if let Some(expression) = expressions.get(values.len()).copied() {
                    self.frames.push(Frame::Tuple {
                        activation: activation.clone(),
                        expressions,
                        values,
                    });
                    self.action = Action::Evaluate {
                        activation,
                        expression,
                    };
                } else {
                    self.action = Action::Complete(Ok(tuple(values)));
                }
            }
            Frame::Array {
                activation,
                elements,
                index,
                mut values,
                span,
            } => {
                match (elements[index].spread, value) {
                    (false, value) => values.push(value),
                    (true, Value::Array(spread)) => values.extend(spread),
                    (true, Value::EmptyArray { .. }) => {}
                    (true, value) => {
                        self.action = Action::Complete(Err(Diagnostic::new(
                            "BLOT_TYPE",
                            format!("`...` spreads an array, found {}.", show(&value)),
                            span,
                        )));
                        return;
                    }
                }
                let index = index + 1;
                if let Some(expression) = elements.get(index).map(|element| element.value) {
                    self.frames.push(Frame::Array {
                        activation: activation.clone(),
                        elements,
                        index,
                        values,
                        span,
                    });
                    self.action = Action::Evaluate {
                        activation,
                        expression,
                    };
                } else {
                    self.action = Action::Complete(Ok(Value::Array(values)));
                }
            }
            Frame::ShapeName {
                activation,
                members,
                index,
                fields,
                span,
            } => {
                let Value::Text(name) = value else {
                    self.action = Action::Complete(Err(Diagnostic::new(
                        "BLOT_DYNAMIC_SHAPE_FIELD",
                        "A computed record field name must resolve at compile time to Text.",
                        span,
                    )));
                    return;
                };
                let ShapeMember::Computed {
                    value: expression, ..
                } = members[index]
                else {
                    unreachable!("a computed field suspends its name first")
                };
                self.frames.push(Frame::ShapeValue {
                    activation: activation.clone(),
                    members,
                    index,
                    fields,
                    name: Some(name.to_string()),
                    span,
                });
                self.action = Action::Evaluate {
                    activation,
                    expression,
                };
            }
            Frame::ShapeValue {
                activation,
                members,
                index,
                mut fields,
                name,
                span,
            } => {
                if let Some(name) = name {
                    fields.insert(name, value);
                } else if let Value::Shape(spread) = value {
                    fields.extend(spread);
                } else {
                    self.action = Action::Complete(Err(Diagnostic::new(
                        "BLOT_TYPE",
                        format!("`...` spreads a shape, found {}.", show(&value)),
                        span,
                    )));
                    return;
                }
                self.shape(activation, members, index + 1, fields, span);
            }
            Frame::Branch {
                activation,
                branches,
                fallback,
                index,
                span,
            } => {
                if let Value::Runtime(condition) = value {
                    self.action = Action::Semantic(evaluate_dynamic_if(
                        activation.context.clone(),
                        activation.module.clone(),
                        activation.environment.clone(),
                        activation.runtime.clone(),
                        BranchProgress {
                            branches: branches.to_vec(),
                            fallback,
                            index,
                            span,
                        },
                        branches[index].clone(),
                        condition,
                    ));
                } else {
                    match truth(&value, span) {
                        Ok(true) => {
                            self.action = Action::Evaluate {
                                expression: branches[index].consequence,
                                activation,
                            }
                        }
                        Ok(false) => self.branch(activation, branches, fallback, index + 1, span),
                        Err(error) => self.action = Action::Complete(Err(error)),
                    }
                }
            }
            Frame::Case {
                activation,
                arms,
                checked_result,
                span,
            } => {
                if let Value::Runtime(target) = value {
                    self.action = Action::Semantic(evaluate_dynamic_case(
                        activation.context.clone(),
                        activation.module.clone(),
                        activation.environment.clone(),
                        activation.runtime.clone(),
                        DynamicCase {
                            target,
                            arms: arms.to_vec(),
                            checked_result,
                            span,
                        },
                    ));
                    return;
                }
                for arm in arms.iter() {
                    let environment = child_env(Some(activation.environment.clone()));
                    if match_pattern(
                        &activation.program.source,
                        arm.pattern,
                        &value,
                        &environment,
                    ) {
                        self.action = Action::Evaluate {
                            expression: arm.body,
                            activation: Rc::new(Activation {
                                context: activation.context.clone(),
                                module: activation.module.clone(),
                                program: activation.program.clone(),
                                environment,
                                runtime: activation.runtime.clone(),
                            }),
                        };
                        return;
                    }
                }
                self.action = Action::Complete(Err(Diagnostic::new(
                    "BLOT_NO_MATCH",
                    format!("No arm matched {}.", show(&value)),
                    span,
                )));
            }
            Frame::Origin(_) | Frame::External(_) => {
                unreachable!("result continuations were handled before value continuations")
            }
        }
    }

    fn apply(
        &mut self,
        activation: Rc<Activation>,
        function: Value,
        argument: Value,
        evidence: CallEvidence,
    ) {
        self.action = Action::Semantic(apply_with_expected(
            activation.context.clone(),
            function,
            ApplicationCall {
                argument,
                expected_argument: evidence.expected_argument,
                span: evidence.span,
                runtime: activation.runtime.clone(),
                expected_result: evidence.expected_result,
                application: evidence.application,
            },
        ));
    }

    fn shape(
        &mut self,
        activation: Rc<Activation>,
        members: Rc<[ShapeMember]>,
        index: usize,
        fields: OrderedFields,
        span: Span,
    ) {
        let Some(member) = members.get(index) else {
            self.action = Action::Complete(Ok(Value::Shape(fields)));
            return;
        };
        match member {
            ShapeMember::Computed { name, .. } => {
                let expression = *name;
                let name_activation = Rc::new(Activation {
                    context: activation.context.clone(),
                    module: activation.module.clone(),
                    program: activation.program.clone(),
                    environment: activation.environment.clone(),
                    runtime: activation.runtime.comptime(),
                });
                self.frames.push(Frame::ShapeName {
                    activation,
                    members,
                    index,
                    fields,
                    span,
                });
                self.action = Action::Evaluate {
                    activation: name_activation,
                    expression,
                };
            }
            ShapeMember::Field { name, value } => {
                let expression = *value;
                let name = Some(name.clone());
                self.frames.push(Frame::ShapeValue {
                    activation: activation.clone(),
                    members,
                    index,
                    fields,
                    name,
                    span,
                });
                self.action = Action::Evaluate {
                    activation,
                    expression,
                };
            }
            ShapeMember::Spread { value } => {
                let expression = *value;
                self.frames.push(Frame::ShapeValue {
                    activation: activation.clone(),
                    members,
                    index,
                    fields,
                    name: None,
                    span,
                });
                self.action = Action::Evaluate {
                    activation,
                    expression,
                };
            }
        }
    }
}
