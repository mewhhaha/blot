use std::collections::BTreeSet;

use crate::continuation::{Argument, Continuation, Function, ValueId};

pub(super) struct ContinuationLifetimes {
    pub entry_drops: Vec<ValueId>,
    pub instruction_drops: Vec<Vec<ValueId>>,
    pub transition_roots: BTreeSet<ValueId>,
}

impl ContinuationLifetimes {
    pub(super) fn new(function: &Function, continuation: &Continuation) -> Self {
        let mut live = continuation
            .transition
            .uses()
            .into_iter()
            .collect::<BTreeSet<_>>();
        for edge in continuation.transition.edges() {
            live.extend(edge.arguments.iter().filter_map(|argument| match argument {
                Argument::Value(value) => Some(*value),
                Argument::Result => None,
            }));
            live.extend(
                function.continuations[edge.target.0]
                    .captures
                    .iter()
                    .map(|capture| capture.value),
            );
        }
        let transition_roots = live.clone();
        let mut instruction_drops = vec![Vec::new(); continuation.instructions.len()];
        for (index, instruction) in continuation.instructions.iter().enumerate().rev() {
            let mut drops = instruction
                .operands
                .iter()
                .copied()
                .filter(|operand| !live.contains(operand))
                .collect::<BTreeSet<_>>();
            if !live.remove(&instruction.definition.value) {
                drops.insert(instruction.definition.value);
            }
            live.extend(&instruction.operands);
            instruction_drops[index] = drops.into_iter().collect();
        }
        let entry_drops = continuation
            .parameters
            .iter()
            .chain(&continuation.captures)
            .map(|definition| definition.value)
            .filter(|value| !live.contains(value))
            .collect();
        Self {
            entry_drops,
            instruction_drops,
            transition_roots,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuation::{
        CallTarget, ContinuationId, Definition, Edge, FunctionId, Instruction, Operation,
        SignatureId, Transition, TypeId,
    };
    use crate::hir::RuntimeSpan;

    fn definition(value: usize) -> Definition {
        Definition {
            value: ValueId(value),
            type_id: TypeId(0),
            ownership: "plain",
            span: RuntimeSpan {
                file: "lifetimes.blot".to_owned(),
                start: 0,
                end: 1,
            },
        }
    }

    fn instruction(value: usize, operands: &[usize]) -> Instruction {
        Instruction {
            definition: definition(value),
            operands: operands.iter().copied().map(ValueId).collect(),
            operation: Operation {
                kind: "product.make",
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

    #[test]
    fn final_uses_release_once_and_keep_live_call_captures() {
        let first = Continuation {
            id: ContinuationId(0),
            parameters: vec![definition(0), definition(1), definition(2)],
            captures: Vec::new(),
            instructions: vec![instruction(3, &[0, 0]), instruction(4, &[3])],
            transition: Transition::Call {
                target: CallTarget::Function {
                    function: FunctionId(1),
                },
                signature: SignatureId(0),
                arguments: vec![ValueId(1)],
                next: Edge {
                    target: ContinuationId(1),
                    arguments: vec![Argument::Result],
                },
                suspends: false,
            },
            span: definition(0).span,
        };
        let next = Continuation {
            id: ContinuationId(1),
            parameters: vec![definition(5)],
            captures: vec![definition(3)],
            instructions: vec![instruction(6, &[3, 5])],
            transition: Transition::Return { value: ValueId(6) },
            span: definition(0).span,
        };
        let function = Function {
            id: FunctionId(0),
            name: "lifetimes".to_owned(),
            signature: SignatureId(0),
            entry: ContinuationId(0),
            continuations: vec![first, next],
            suspends: false,
            framed: false,
            reuse: None,
            span: definition(0).span,
        };
        let first = ContinuationLifetimes::new(&function, &function.continuations[0]);
        assert_eq!(first.entry_drops, [ValueId(2)]);
        assert_eq!(
            first.instruction_drops,
            [vec![ValueId(0)], vec![ValueId(4)]]
        );
        assert_eq!(
            first.transition_roots,
            BTreeSet::from([ValueId(1), ValueId(3)])
        );
        let next = ContinuationLifetimes::new(&function, &function.continuations[1]);
        assert!(next.entry_drops.is_empty());
        assert_eq!(next.instruction_drops, [vec![ValueId(3), ValueId(5)]]);
        assert_eq!(next.transition_roots, BTreeSet::from([ValueId(6)]));
    }
}
