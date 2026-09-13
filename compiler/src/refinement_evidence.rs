//! Erased proof observations. Source checking constructs these facts; consumers
//! validate their algebra but never use imported observations as new assumptions.
use serde::{Deserialize, Serialize};

use crate::ast::{Expression, ExpressionId, Module};
use crate::relational::proof::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RefinementFact {
    ArrayIndex {
        expression: ExpressionId,
        index: Term,
        length: Term,
        premises: Vec<Constraint>,
    },
    RecursiveInvariant {
        expression: ExpressionId,
        invariants: Vec<Constraint>,
        entry: Vec<Constraint>,
        context: Vec<Constraint>,
        transitions: Vec<(Vec<Constraint>, Vec<Constraint>)>,
    },
}

impl RefinementFact {
    pub(crate) fn expression(&self) -> ExpressionId {
        match self {
            Self::ArrayIndex { expression, .. } | Self::RecursiveInvariant { expression, .. } => {
                *expression
            }
        }
    }

    pub(crate) fn explanation(&self, module: &Module) -> serde_json::Value {
        let (kind, summary, reasons) = match self {
            Self::ArrayIndex { premises, .. } => ("array-index", "The index is within this array's bounds.", vec![format!("The checker proved 0 <= index and index < length from {} retained inequalities.", premises.len())]),
            Self::RecursiveInvariant { invariants, transitions, .. } => ("recursive-invariant", "The recursive state preserves its inferred bounds.", vec![format!("{} inequalities hold at entry and were replayed over {} tail-call paths.", invariants.len(), transitions.len()), "These facts describe normal returns; overflow traps and termination behavior are unchanged.".into()]),
        };
        serde_json::json!({ "span": module.arena.expression_span(self.expression()), "kind": kind, "summary": summary, "reasons": reasons })
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        let valid = match self {
            Self::ArrayIndex {
                index,
                length,
                premises,
                ..
            } => {
                bounded(premises)
                    && term_at_least_zero(index, premises)
                    && term_less_than(index, length, premises)
            }
            Self::RecursiveInvariant {
                invariants,
                entry,
                context,
                transitions,
                ..
            } => {
                invariants.len() <= crate::relational::inference::CANDIDATE_BUDGET
                    && entry.len() == invariants.len()
                    && bounded(context)
                    && entails(entry, context)
                    && !transitions.is_empty()
                    && transitions.iter().all(|(premises, required)| {
                        bounded(premises)
                            && required.len() == invariants.len()
                            && entails(required, premises)
                    })
            }
        };
        if valid {
            Ok(())
        } else {
            Err("checked-module certificate contains invalid relational evidence".into())
        }
    }

    pub(crate) fn validate_source(&self, module: &Module) -> Result<(), String> {
        let expression = module.arena.expressions.get(self.expression().0 as usize);
        let valid = match (self, expression) {
            (Self::ArrayIndex { .. }, Some(Expression::Apply { .. })) => true,
            (Self::RecursiveInvariant { .. }, Some(_)) => module.arena.expressions.iter().any(|expression| matches!(expression, Expression::Lambda { body, .. } if *body == self.expression())),
            _ => false,
        };
        if valid {
            self.validate()
        } else {
            Err("checked-module certificate relational evidence references the wrong source expression".into())
        }
    }
}

fn bounded(constraints: &[Constraint]) -> bool {
    constraints.len() <= REFINEMENT_EDGE_BUDGET
        && constraints
            .iter()
            .flat_map(|edge| [edge.left, edge.right])
            .collect::<std::collections::HashSet<_>>()
            .len()
            <= REFINEMENT_TERM_BUDGET as usize
}
