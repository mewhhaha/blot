//! Difference constraints shared by relational inference and proof replay.
use crate::ast::Span;
use crate::diagnostic::Diagnostic;
use num_bigint::BigInt;
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) type Identity = u32;

pub(crate) const REFINEMENT_TERM_BUDGET: Identity = 512;
pub(crate) const REFINEMENT_EDGE_BUDGET: usize = 2_048;

#[derive(Clone, Debug, Eq, PartialEq, Hash, serde::Serialize, serde::Deserialize)]
pub(crate) enum Term {
    Literal(BigInt),
    Variable { identity: Identity, offset: BigInt },
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, serde::Serialize, serde::Deserialize)]
pub(crate) struct Constraint {
    pub(crate) left: Node,
    pub(crate) right: Node,
    pub(crate) bound: BigInt,
}

#[derive(
    Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize, serde::Deserialize,
)]
pub(crate) enum Node {
    Zero,
    Variable(Identity),
}

#[derive(Clone, Default)]
pub(crate) struct Constraints {
    pub(crate) edges: Vec<Constraint>,
    incident: HashMap<Node, Vec<usize>>,
}

impl Constraints {
    pub(crate) fn within_budget(&self) -> bool {
        self.edges.len() <= REFINEMENT_EDGE_BUDGET
            && self.incident.len() < REFINEMENT_TERM_BUDGET as usize
    }

    pub(crate) fn push(&mut self, constraint: Constraint) {
        let index = self.edges.len();
        for node in [constraint.left, constraint.right] {
            if node != Node::Zero {
                self.incident.entry(node).or_default().push(index);
            }
        }
        self.edges.push(constraint);
    }

    pub(crate) fn extend(&mut self, constraints: impl IntoIterator<Item = Constraint>) {
        for constraint in constraints {
            self.push(constraint);
        }
    }

    pub(crate) fn forget(&mut self, identity: Identity) {
        let mut edges = std::mem::take(&mut self.edges);
        forget_identity(&mut edges, identity);
        self.incident.clear();
        for edge in edges {
            self.push(edge);
        }
    }

    pub(crate) fn proof(
        &self,
        index: &Term,
        length: &Term,
        span: Span,
    ) -> Result<Vec<Constraint>, Diagnostic> {
        let mut nodes = HashSet::from([Node::Zero]);
        let mut pending = Vec::new();
        for term in [index, length] {
            let (node, _) = term_node(term);
            if nodes.insert(node) {
                pending.push(node);
            }
        }
        let mut edges = HashSet::new();
        while let Some(node) = pending.pop() {
            for &index in self.incident.get(&node).into_iter().flatten() {
                if !edges.insert(index) {
                    continue;
                }
                let edge = &self.edges[index];
                for next in [edge.left, edge.right] {
                    // Zero terminates a dependency path: unrelated literal bounds
                    // must not join every variable into the same proof graph.
                    if nodes.insert(next) {
                        pending.push(next);
                    }
                }
                if nodes.len() > REFINEMENT_TERM_BUDGET as usize
                    || edges.len() > REFINEMENT_EDGE_BUDGET
                {
                    return Err(Diagnostic::new(
                        "BLOT_REFINEMENT_BUDGET",
                        format!(
                            "The array-index proof exceeded its bounded affine refinement budget (maximum {REFINEMENT_TERM_BUDGET} terms and {REFINEMENT_EDGE_BUDGET} edges per proof). Split the relevant relation into a verified helper."
                        ),
                        span,
                    ));
                }
            }
        }
        let mut edges = edges.into_iter().collect::<Vec<_>>();
        edges.sort_unstable();
        Ok(edges
            .into_iter()
            .map(|index| self.edges[index].clone())
            .collect())
    }
}

pub(crate) fn shift(term: Term, offset: BigInt) -> Term {
    match term {
        Term::Literal(value) => Term::Literal(value + offset),
        Term::Variable {
            identity,
            offset: current,
        } => Term::Variable {
            identity,
            offset: current + offset,
        },
    }
}

pub(crate) fn constraints_less_than(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(left, right, BigInt::from(-1))
}

pub(crate) fn constraints_at_least(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(right, left, BigInt::from(0))
}

pub(crate) fn constraints_at_most(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(left, right, BigInt::from(0))
}

pub(crate) fn constraints_greater_than(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(right, left, BigInt::from(-1))
}

pub(crate) fn constraints_equal(left: &Term, right: &Term) -> Vec<Constraint> {
    let mut constraints = constraints_difference(left, right, BigInt::from(0));
    constraints.extend(constraints_difference(right, left, BigInt::from(0)));
    constraints
}

pub(crate) fn constraints_difference(left: &Term, right: &Term, delta: BigInt) -> Vec<Constraint> {
    let (left_node, left_offset) = term_node(left);
    let (right_node, right_offset) = term_node(right);
    vec![Constraint {
        left: left_node,
        right: right_node,
        bound: right_offset - left_offset + delta,
    }]
}

pub(crate) fn term_node(term: &Term) -> (Node, BigInt) {
    match term {
        Term::Literal(value) => (Node::Zero, value.clone()),
        Term::Variable { identity, offset } => (Node::Variable(*identity), offset.clone()),
    }
}

pub(crate) fn term_at_least_zero(term: &Term, constraints: &[Constraint]) -> bool {
    term_at_least(term, &Term::Literal(BigInt::from(0)), constraints)
}

pub(crate) fn term_less_than(left: &Term, right: &Term, constraints: &[Constraint]) -> bool {
    entails(&constraints_less_than(left, right), constraints)
}

pub(crate) fn term_at_least(left: &Term, right: &Term, constraints: &[Constraint]) -> bool {
    entails(&constraints_at_least(left, right), constraints)
}

pub(crate) fn entails(required: &[Constraint], constraints: &[Constraint]) -> bool {
    let node_count = constraints
        .iter()
        .flat_map(|constraint| [constraint.left, constraint.right])
        .chain(std::iter::once(Node::Zero))
        .collect::<HashSet<_>>()
        .len();
    let mut distances = HashMap::<Node, HashMap<Node, BigInt>>::new();
    for required in required {
        let from = distances
            .entry(required.right)
            .or_insert_with(|| shortest_paths_from(required.right, constraints, node_count));
        if !from
            .get(&required.left)
            .is_some_and(|distance| distance <= &required.bound)
        {
            return false;
        }
    }
    true
}

pub(crate) fn shortest_paths_from(
    source: Node,
    constraints: &[Constraint],
    node_count: usize,
) -> HashMap<Node, BigInt> {
    let mut distances = HashMap::from([(source, BigInt::from(0))]);
    for _ in 0..node_count {
        let mut changed = false;
        for constraint in constraints {
            let Some(right) = distances.get(&constraint.right).cloned() else {
                continue;
            };
            let candidate = right + &constraint.bound;
            if distances
                .get(&constraint.left)
                .is_some_and(|current| current <= &candidate)
            {
                continue;
            }
            distances.insert(constraint.left, candidate);
            changed = true;
        }
        if !changed {
            break;
        }
    }
    distances
}

pub(crate) fn forget_identity(constraints: &mut Vec<Constraint>, identity: Identity) {
    let dead = Node::Variable(identity);
    if !constraints
        .iter()
        .any(|constraint| constraint.left == dead || constraint.right == dead)
    {
        return;
    }
    let mut into_dead = BTreeMap::<Node, BigInt>::new();
    let mut from_dead = BTreeMap::<Node, BigInt>::new();
    let mut projected = BTreeMap::<(Node, Node), BigInt>::new();
    for constraint in constraints.iter() {
        if constraint.left == dead && constraint.right != dead {
            into_dead
                .entry(constraint.right)
                .and_modify(|bound| {
                    if constraint.bound < *bound {
                        *bound = constraint.bound.clone();
                    }
                })
                .or_insert_with(|| constraint.bound.clone());
            continue;
        }
        if constraint.right == dead && constraint.left != dead {
            from_dead
                .entry(constraint.left)
                .and_modify(|bound| {
                    if constraint.bound < *bound {
                        *bound = constraint.bound.clone();
                    }
                })
                .or_insert_with(|| constraint.bound.clone());
            continue;
        }
        if constraint.left == dead || constraint.right == dead {
            continue;
        }
        projected
            .entry((constraint.left, constraint.right))
            .and_modify(|bound| {
                if constraint.bound < *bound {
                    *bound = constraint.bound.clone();
                }
            })
            .or_insert_with(|| constraint.bound.clone());
    }
    for (right, into_bound) in into_dead {
        for (left, from_bound) in &from_dead {
            if *left == right {
                continue;
            }
            let bound = &into_bound + from_bound;
            projected
                .entry((*left, right))
                .and_modify(|current| {
                    if bound < *current {
                        *current = bound.clone();
                    }
                })
                .or_insert(bound);
        }
    }
    *constraints = projected
        .into_iter()
        .map(|((left, right), bound)| Constraint { left, right, bound })
        .collect();
}
