//! Persistent edges in the type-value graph.
//!
//! Sharing is an allocation strategy, not type equality or quantifier identity.
//! A write detaches the edge and invalidates its summaries before exposing it.
use super::Value;
#[cfg(test)]
use super::graph;
use std::cell::OnceCell;
use std::collections::HashSet;
use std::ops::{Deref, DerefMut};
use std::rc::Rc;

#[cfg(test)]
thread_local! {
    static SUMMARY_WORKLISTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

const VARIABLES: u8 = 1;
const EFFECTS: u8 = 2;
// Signature substitution also flattens/deduplicates unions and collapses a
// singleton. Closed is not enough to skip that normalization operation.
const NORMALIZATION: u8 = 4;

#[derive(Clone)]
struct Node {
    value: Value,
    summary: OnceCell<u8>,
}

#[derive(Clone)]
pub struct TypeValue(Rc<Node>);

impl TypeValue {
    pub fn new(value: Value) -> Self {
        Self(Rc::new(Node {
            value,
            summary: OnceCell::new(),
        }))
    }

    fn summary(&self) -> u8 {
        *self
            .0
            .summary
            .get_or_init(|| summarize(&self.0.value, false))
    }

    pub(crate) fn contains_variables(value: &Value) -> bool {
        if matches!(value, Value::TypeVariable(_) | Value::Forall { .. }) {
            return true;
        }
        summarize(value, true) & VARIABLES != 0
    }

    pub(crate) fn has_variables(&self) -> bool {
        self.summary() & VARIABLES != 0
    }

    pub(crate) fn has_shared_storage(&self) -> bool {
        Rc::strong_count(&self.0) > 1
    }

    pub(crate) fn requires_substitution(&self) -> bool {
        self.summary() != 0
    }

    pub(crate) fn needs_substitution(value: &Value) -> bool {
        if matches!(
            value,
            Value::TypeVariable(_) | Value::Forall { .. } | Value::Effect { .. }
        ) {
            return true;
        }
        summarize(value, true) != 0
    }

    pub fn into_owned(self) -> Value {
        match Rc::try_unwrap(self.0) {
            Ok(node) => node.value,
            Err(node) => node.value.clone(),
        }
    }
}

impl Deref for TypeValue {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.0.value
    }
}

impl DerefMut for TypeValue {
    fn deref_mut(&mut self) -> &mut Value {
        let node = Rc::make_mut(&mut self.0);
        node.summary.take();
        &mut node.value
    }
}

impl AsRef<Value> for TypeValue {
    fn as_ref(&self) -> &Value {
        self
    }
}

// Computing a missing summary never recursively computes another missing
// summary: the explicit worklist handles arbitrarily deep type graphs. Existing
// summaries prune shared subgraphs; flags describe the same graph as the existing
// variable collector, with effect identities additionally marked for substitution.
fn summarize(value: &Value, populate_edges: bool) -> u8 {
    // Scalars and opaque runtime values have no traversable type dependencies.
    // Keep their frequent queries allocation-free.
    match value {
        Value::TypeVariable(_) => return VARIABLES,
        Value::Arrow { .. }
        | Value::Range { .. }
        | Value::Forall { .. }
        | Value::Shape(_)
        | Value::Array(_)
        | Value::Union(_)
        | Value::RegionType(_)
        | Value::ScratchType(_)
        | Value::ResourceType { .. }
        | Value::EmptyArray { .. }
        | Value::DeferredScratch { .. }
        | Value::Sealed { .. }
        | Value::Tag {
            payload: Some(_), ..
        }
        | Value::Effect { .. }
        | Value::Operation { .. }
        | Value::Extended { .. } => {}
        _ => return 0,
    }
    // Function/range roots are frequent signature queries. Their persistent
    // edges already carry the complete dependency summary: combine those flags
    // without allocating a worklist and visited set for the root. When building
    // a missing edge summary, never recursively initialize another missing one;
    // the fallback below remains bounded-stack for arbitrarily deep graphs.
    let edge_summary = |edge: &TypeValue| {
        if populate_edges {
            Some(edge.summary())
        } else {
            edge.0.summary.get().copied()
        }
    };
    let parts = match value {
        Value::Range { low, high, .. } => Some((low, high, 0)),
        Value::Arrow {
            domain,
            codomain,
            effects,
            effect_tail,
            ..
        } if effects.is_empty() => {
            let flags = if effect_tail.is_some() { VARIABLES } else { 0 };
            Some((domain, codomain, flags))
        }
        _ => None,
    };
    if let Some((left, right, flags)) = parts
        && let Some(left) = edge_summary(left)
        && let Some(right) = edge_summary(right)
    {
        return flags | left | right;
    }
    #[cfg(test)]
    SUMMARY_WORKLISTS.with(|count| count.set(count.get() + 1));
    let mut summary = 0;
    let mut pending = vec![value];
    let mut seen = HashSet::new();
    while let Some(value) = pending.pop() {
        if !seen.insert(value as *const Value) {
            continue;
        }
        let edge = |part: &TypeValue| {
            if populate_edges {
                Some(part.summary())
            } else {
                part.0.summary.get().copied()
            }
        };
        match value {
            Value::TypeVariable(_) => summary |= VARIABLES,
            Value::Forall { body, .. } => {
                summary |= VARIABLES;
                pending.push(body);
            }
            Value::Range { low, high, .. } => {
                for part in [low, high] {
                    if let Some(flags) = edge(part) {
                        summary |= flags;
                    } else {
                        pending.push(part);
                    }
                }
            }
            Value::Arrow {
                domain,
                codomain,
                effects,
                effect_tail,
                ..
            } => {
                if effect_tail.is_some() {
                    summary |= VARIABLES;
                }
                for part in [domain, codomain] {
                    if let Some(flags) = edge(part) {
                        summary |= flags;
                    } else {
                        pending.push(part);
                    }
                }
                pending.extend(effects.iter());
            }
            Value::Shape(fields) => pending.extend(fields.iter().map(|(_, value)| value)),
            Value::Array(values) => pending.extend(values.iter()),
            Value::Union(values) => {
                summary |= NORMALIZATION;
                pending.extend(values.iter());
            }
            Value::RegionType(value)
            | Value::ScratchType(value)
            | Value::ResourceType { payload: value, .. }
            | Value::EmptyArray { element: value }
            | Value::DeferredScratch { capacity: value }
            | Value::Sealed { inner: value, .. } => pending.push(value),
            Value::Tag {
                payload: Some(value),
                ..
            } => pending.push(value),
            Value::Effect { operations, .. } => {
                summary |= EFFECTS;
                pending.extend(operations.iter().map(|(_, value)| value));
            }
            Value::Operation { effect, .. } => pending.push(effect),
            Value::Extended { inner, members } => {
                pending.push(inner);
                pending.extend(members.iter().map(|(_, value)| value));
            }
            _ => {}
        }
        if summary == VARIABLES | EFFECTS | NORMALIZATION {
            return summary;
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn cached_function_and_range_roots_do_not_allocate_summary_worklists() {
        let range = crate::primitives::constant("@type.int").unwrap();
        let arrow = Value::Arrow {
            deferred: false,
            domain: TypeValue::new(range.clone()),
            codomain: TypeValue::new(range.clone()),
            effects: Vec::new(),
            effect_tail: None,
        };
        for value in [&range, &arrow] {
            assert!(!TypeValue::needs_substitution(value));
        }
        SUMMARY_WORKLISTS.with(|count| count.set(0));
        for _ in 0..10_000 {
            assert!(!TypeValue::needs_substitution(&range));
            assert!(!TypeValue::needs_substitution(&arrow));
            assert!(!TypeValue::contains_variables(&arrow));
        }
        SUMMARY_WORKLISTS.with(|count| assert_eq!(count.get(), 0));
    }

    #[test]
    fn summary_root_fast_path_keeps_effect_tails_and_union_flags() {
        let mut arrow = Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Unit),
            codomain: TypeValue::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: Some(7),
        };
        assert_eq!(summarize(&arrow, true), VARIABLES);
        let Value::Arrow {
            domain,
            effect_tail,
            ..
        } = &mut arrow
        else {
            panic!("arrow")
        };
        *effect_tail = None;
        **domain = Value::Union(vec![Value::Unit].into());
        assert_eq!(summarize(&arrow, true), NORMALIZATION);
        assert!(!TypeValue::contains_variables(&arrow));
        assert!(TypeValue::needs_substitution(&arrow));
    }

    #[test]
    fn summary_root_fast_path_observes_copy_on_write_edge_mutation() {
        let original = Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Unit),
            codomain: TypeValue::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: None,
        };
        assert_eq!(summarize(&original, true), 0);
        let mut changed = original.clone();
        let Value::Arrow { domain, .. } = &mut changed else {
            panic!("arrow")
        };
        **domain = Value::TypeVariable(42);
        assert_eq!(summarize(&changed, true), VARIABLES);
        assert_eq!(summarize(&original, true), 0);
    }

    #[test]
    fn cloning_and_substitution_reuse_closed_type_edges() {
        let edge = TypeValue::new(Value::Unit);
        let copy = edge.clone();
        assert!(Rc::ptr_eq(&edge.0, &copy.0));
        let value = Value::Arrow {
            deferred: false,
            domain: edge,
            codomain: copy,
            effects: Vec::new(),
            effect_tail: None,
        };
        let substituted = crate::eval::substitute_signature(&value, &super::super::child_env(None));
        let (Value::Arrow { domain: before, .. }, Value::Arrow { domain: after, .. }) =
            (&value, &substituted)
        else {
            panic!("arrow graph")
        };
        assert!(Rc::ptr_eq(&before.0, &after.0));
    }

    #[test]
    fn mutating_a_clone_detaches_and_invalidates_its_summary() {
        let original = TypeValue::new(Value::Unit);
        assert_eq!(original.summary(), 0);
        let mut changed = original.clone();
        *changed = Value::TypeVariable(17);
        assert!(!Rc::ptr_eq(&original.0, &changed.0));
        assert_eq!(original.summary(), 0);
        assert_eq!(changed.summary(), VARIABLES);
        assert!(matches!(*original, Value::Unit));
    }

    #[test]
    fn nested_mutation_invalidates_the_parent_without_changing_its_alias() {
        let original = TypeValue::new(Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::TypeVariable(7)),
            codomain: TypeValue::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: None,
        });
        assert!(original.has_variables());
        let mut changed = original.clone();
        let Value::Arrow { domain, .. } = &mut *changed else {
            panic!("arrow graph")
        };
        **domain = Value::Unit;
        assert!(original.has_variables());
        assert!(!changed.has_variables());
    }

    #[test]
    fn summaries_agree_with_the_existing_variable_collector() {
        for value in [
            Value::Unit,
            Value::TypeVariable(1),
            Value::Forall {
                variable: 2,
                body: Box::new(Value::Unit),
            },
            Value::Arrow {
                deferred: false,
                domain: TypeValue::new(Value::Unit),
                codomain: TypeValue::new(Value::Unit),
                effects: Vec::new(),
                effect_tail: Some(3),
            },
            Value::Tag {
                name: "Some".into(),
                payload: Some(Box::new(Value::TypeVariable(4))),
            },
        ] {
            let mut variables = BTreeSet::new();
            graph::collect_type_variables(&value, &mut variables);
            assert_eq!(TypeValue::contains_variables(&value), !variables.is_empty());
        }
    }

    #[test]
    fn deep_type_summaries_use_an_explicit_worklist() {
        std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(|| {
                let mut value = Value::Unit;
                for _ in 0..20_000 {
                    value = Value::Arrow {
                        deferred: false,
                        domain: TypeValue::new(Value::Unit),
                        codomain: TypeValue::new(value),
                        effects: Vec::new(),
                        effect_tail: None,
                    };
                }
                assert!(!TypeValue::contains_variables(&value));
                // Recursive destruction is unrelated to summary traversal.
                std::mem::forget(value);
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
