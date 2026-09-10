use std::collections::BTreeMap;

use super::{
    Argument, CallTarget, ContinuationId, Edge, FunctionId, Graph, Instruction, Transition, ValueId,
};
use crate::hir::WireConstant;

pub(crate) trait Values: Clone {
    fn condition(&self) -> Result<bool, String>;
    fn matches(&self, constant: &WireConstant) -> bool;
}

pub(crate) enum Observation<V> {
    Request {
        target: CallTarget,
        arguments: Vec<V>,
    },
    Yielded,
    Returned(V),
    Trapped(String),
}

struct Activation<V> {
    function: FunctionId,
    continuation: ContinuationId,
    values: BTreeMap<ValueId, V>,
}

struct Destination<V> {
    function: FunctionId,
    continuation: ContinuationId,
    arguments: Vec<Option<V>>,
    captures: BTreeMap<ValueId, V>,
}

enum State<V> {
    Ready(Activation<V>),
    Waiting(Destination<V>),
    Returned(V),
    Trapped(String),
    Running,
}

pub(crate) struct Machine<'graph, V> {
    graph: &'graph Graph,
    state: State<V>,
    callers: Vec<Destination<V>>,
}

impl<'graph, V: Values> Machine<'graph, V> {
    pub(crate) fn new(
        graph: &'graph Graph,
        function: FunctionId,
        arguments: Vec<V>,
    ) -> Result<Self, String> {
        let entry = graph
            .functions
            .iter()
            .find(|candidate| candidate.id == function)
            .ok_or("interpreter entry function is absent")?;
        let parameters = &entry.continuations[entry.entry.0].parameters;
        if parameters.len() != arguments.len() {
            return Err("interpreter entry arity differs from its arguments".to_owned());
        }
        Ok(Self {
            graph,
            state: State::Ready(Activation {
                function,
                continuation: entry.entry,
                values: parameters
                    .iter()
                    .map(|parameter| parameter.value)
                    .zip(arguments)
                    .collect(),
            }),
            callers: Vec::new(),
        })
    }

    pub(crate) fn resume(&mut self, value: V) -> Result<(), String> {
        if !matches!(self.state, State::Waiting(_)) {
            return Err("interpreter can resume only a pending request".to_owned());
        }
        let State::Waiting(destination) = std::mem::replace(&mut self.state, State::Running) else {
            unreachable!()
        };
        self.state = State::Ready(self.arrive(destination, Some(value)));
        Ok(())
    }

    pub(crate) fn cancel(&mut self) {
        self.callers.clear();
        self.state = State::Trapped("cancelled".to_owned());
    }

    pub(crate) fn poll(
        &mut self,
        quantum: usize,
        mut execute: impl FnMut(&Instruction, Vec<V>) -> Result<V, String>,
    ) -> Result<Observation<V>, String> {
        for _ in 0..quantum {
            match &self.state {
                State::Waiting(_) => {
                    return Err("pending request must settle before polling".to_owned());
                }
                State::Returned(value) => return Ok(Observation::Returned(value.clone())),
                State::Trapped(message) => return Ok(Observation::Trapped(message.clone())),
                State::Running => return Err("interpreter was polled reentrantly".to_owned()),
                State::Ready(_) => {}
            }
            let State::Ready(mut activation) = std::mem::replace(&mut self.state, State::Running)
            else {
                unreachable!()
            };
            let function = self
                .graph
                .functions
                .iter()
                .find(|function| function.id == activation.function)
                .expect("validated activation function");
            let continuation = &function.continuations[activation.continuation.0];
            for instruction in &continuation.instructions {
                let arguments = instruction
                    .operands
                    .iter()
                    .map(|value| activation.values[value].clone())
                    .collect();
                match execute(instruction, arguments) {
                    Ok(value) => {
                        activation
                            .values
                            .insert(instruction.definition.value, value);
                    }
                    Err(message) => {
                        self.callers.clear();
                        self.state = State::Trapped(message.clone());
                        return Ok(Observation::Trapped(message));
                    }
                }
            }
            match &continuation.transition {
                Transition::Jump { edge } => {
                    self.state =
                        State::Ready(self.arrive(self.destination(&activation, edge), None));
                }
                Transition::Branch {
                    condition,
                    consequent,
                    alternate,
                } => {
                    let edge = if activation.values[condition].condition()? {
                        consequent
                    } else {
                        alternate
                    };
                    self.state =
                        State::Ready(self.arrive(self.destination(&activation, edge), None));
                }
                Transition::Switch {
                    selector,
                    cases,
                    fallback,
                } => {
                    let edge = cases
                        .iter()
                        .find(|(constant, _)| activation.values[selector].matches(constant))
                        .map(|(_, edge)| edge)
                        .unwrap_or(fallback);
                    self.state =
                        State::Ready(self.arrive(self.destination(&activation, edge), None));
                }
                Transition::Call {
                    target,
                    arguments,
                    next,
                    ..
                } => {
                    let arguments = arguments
                        .iter()
                        .map(|value| activation.values[value].clone())
                        .collect::<Vec<_>>();
                    let destination = self.destination(&activation, next);
                    match target {
                        CallTarget::Function { function } => {
                            let callee = Self::new(self.graph, *function, arguments)?;
                            self.callers.push(destination);
                            self.state = callee.state;
                        }
                        CallTarget::Host { .. } | CallTarget::Link { .. } => {
                            self.state = State::Waiting(destination);
                            return Ok(Observation::Request {
                                target: target.clone(),
                                arguments,
                            });
                        }
                    }
                }
                Transition::Return { value } => {
                    let value = activation
                        .values
                        .remove(value)
                        .expect("validated return value");
                    self.state = match self.callers.pop() {
                        Some(destination) => State::Ready(self.arrive(destination, Some(value))),
                        None => State::Returned(value),
                    };
                }
                Transition::Trap { message } => {
                    self.callers.clear();
                    self.state = State::Trapped(message.clone());
                    return Ok(Observation::Trapped(message.clone()));
                }
            }
        }
        Ok(Observation::Yielded)
    }

    fn destination(&self, activation: &Activation<V>, edge: &Edge) -> Destination<V> {
        let function = self
            .graph
            .functions
            .iter()
            .find(|function| function.id == activation.function)
            .expect("validated activation function");
        let successor = &function.continuations[edge.target.0];
        Destination {
            function: activation.function,
            continuation: edge.target,
            arguments: edge
                .arguments
                .iter()
                .map(|argument| match argument {
                    Argument::Value(value) => Some(activation.values[value].clone()),
                    Argument::Result => None,
                })
                .collect(),
            captures: successor
                .captures
                .iter()
                .map(|capture| (capture.value, activation.values[&capture.value].clone()))
                .collect(),
        }
    }

    fn arrive(&self, destination: Destination<V>, result: Option<V>) -> Activation<V> {
        let function = self
            .graph
            .functions
            .iter()
            .find(|function| function.id == destination.function)
            .expect("validated destination function");
        let successor = &function.continuations[destination.continuation.0];
        let mut values = destination.captures;
        for (parameter, argument) in successor.parameters.iter().zip(destination.arguments) {
            let value = argument
                .or_else(|| result.clone())
                .expect("validated edge argument");
            values.insert(parameter.value, value);
        }
        Activation {
            function: destination.function,
            continuation: destination.continuation,
            values,
        }
    }
}
