//! Call-local graph analyses. Sharing changes work, never a semantic decision.
use super::*;
use std::collections::HashSet;

pub(super) fn reusable_across_module_instances(value: &Value) -> bool {
    let mut pending = vec![value];
    let mut seen = HashSet::new();
    while let Some(value) = pending.pop() {
        if !seen.insert(value as *const Value) {
            continue;
        }
        #[cfg(test)]
        REUSE_VISITS.with(|visits| visits.set(visits.get() + 1));
        match value {
            Value::Int(_)
            | Value::Float(_)
            | Value::Float32(_)
            | Value::Vector(_)
            | Value::VectorMask(_)
            | Value::IntegerVector { .. }
            | Value::IntegerVectorMask { .. }
            | Value::Text(_)
            | Value::Unit
            | Value::ModuleClosure { .. }
            | Value::Unbounded
            | Value::TypeVariable(_) => {}
            Value::Shape(fields) => pending.extend(fields.iter().map(|(_, value)| value)),
            Value::Array(values) => pending.extend(values.iter()),
            Value::Union(values) => pending.extend(values.iter()),
            Value::RegionType(element)
            | Value::ScratchType(element)
            | Value::ResourceType {
                payload: element, ..
            }
            | Value::DeferredScratch { capacity: element }
            | Value::EmptyArray { element }
            | Value::Forall { body: element, .. }
            | Value::Sealed { inner: element, .. } => pending.push(element),
            Value::Scratch { values, .. } | Value::IndexedStep { elements: values } => {
                pending.extend(values.iter());
            }
            Value::Tag { payload, .. } => pending.extend(payload.as_deref()),
            Value::Primitive { applied, .. } => pending.extend(applied.iter()),
            Value::Range { low, high, .. } => pending.extend([low.as_ref(), high.as_ref()]),
            Value::Arrow {
                domain,
                codomain,
                effects,
                ..
            } => {
                pending.extend([domain.as_ref(), codomain.as_ref()]);
                pending.extend(effects.iter());
            }
            Value::Extended { inner, members } => {
                pending.push(inner);
                pending.extend(members.iter().map(|(_, value)| value));
            }
            Value::OpaqueType(name) => {
                if name.starts_with("Effect:") {
                    return false;
                }
            }
            Value::Closure { .. }
            | Value::Deferred { .. }
            | Value::ClosureChoice { .. }
            | Value::Region { .. }
            | Value::RegionRejoin { .. }
            | Value::Effect { .. }
            | Value::Operation { .. }
            | Value::Runtime(_)
            | Value::Continuation { .. } => return false,
        }
    }
    true
}

pub(super) fn collect_type_variables(value: &Value, variables: &mut BTreeSet<u32>) {
    let mut pending = vec![value];
    let mut seen = HashSet::new();
    while let Some(value) = pending.pop() {
        if !seen.insert(value as *const Value) {
            continue;
        }
        #[cfg(test)]
        VARIABLE_VISITS.with(|visits| visits.set(visits.get() + 1));
        match value {
            Value::TypeVariable(variable) => {
                variables.insert(*variable);
            }
            Value::Shape(fields) => pending.extend(fields.iter().map(|(_, value)| value)),
            Value::Array(members) => pending.extend(members.iter()),
            Value::Union(members) => pending.extend(members.iter()),
            Value::RegionType(element)
            | Value::ScratchType(element)
            | Value::ResourceType {
                payload: element, ..
            }
            | Value::EmptyArray { element }
            | Value::DeferredScratch { capacity: element }
            | Value::Sealed { inner: element, .. } => pending.push(element),
            Value::Tag {
                payload: Some(payload),
                ..
            } => pending.push(payload),
            Value::Range { low, high, .. } => pending.extend([low.as_ref(), high.as_ref()]),
            Value::Arrow {
                domain,
                codomain,
                effects,
                effect_tail,
                ..
            } => {
                pending.extend([domain.as_ref(), codomain.as_ref()]);
                pending.extend(effects.iter());
                if let Some(tail) = effect_tail {
                    variables.insert(*tail);
                }
            }
            Value::Forall { variable, body } => {
                variables.insert(*variable);
                pending.push(body);
            }
            Value::Effect { operations, .. } => {
                pending.extend(operations.iter().map(|(_, operation)| operation));
            }
            Value::Operation { effect, .. } => pending.push(effect),
            Value::Extended { inner, members } => {
                pending.push(inner);
                pending.extend(members.iter().map(|(_, member)| member));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
thread_local! {
    static REUSE_VISITS: Cell<usize> = const { Cell::new(0) };
    static VARIABLE_VISITS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diamond(mut value: Value, depth: usize) -> Value {
        for _ in 0..depth {
            value = Value::Shape(OrderedFields::from([
                ("left".to_owned(), value.clone()),
                ("right".to_owned(), value),
            ]));
        }
        value
    }

    #[test]
    fn reusability_follows_the_shared_graph_not_its_expanded_tree() {
        let depth = 30;
        let value = diamond(Value::Int(1.into()), depth);
        REUSE_VISITS.with(|visits| visits.set(0));
        assert!(reusable_across_module_instances(&value));
        REUSE_VISITS.with(|visits| assert_eq!(visits.get(), 2 * depth + 1));
    }

    #[test]
    fn generative_leaves_are_not_hidden_by_sharing() {
        for value in [
            Value::OpaqueType("Effect:private".to_owned()),
            Value::Region {
                store: Rc::new(RefCell::new(vec![Value::Int(1.into())])),
                start: 0,
                end: 1,
            },
        ] {
            assert!(!reusable_across_module_instances(&diamond(value, 30)));
        }
        assert!(reusable_across_module_instances(&diamond(
            Value::OpaqueType("User:opaque".to_owned()),
            30,
        )));
    }

    #[test]
    fn type_variable_collection_visits_each_shared_value_once() {
        let depth = 30;
        let value = diamond(Value::TypeVariable(7), depth);
        let mut variables = BTreeSet::new();
        VARIABLE_VISITS.with(|visits| visits.set(0));
        collect_type_variables(&value, &mut variables);
        assert_eq!(variables, BTreeSet::from([7]));
        VARIABLE_VISITS.with(|visits| assert_eq!(visits.get(), 2 * depth + 1));
    }

    #[test]
    fn collection_retains_binders_effect_tails_and_attached_members() {
        let value = Value::Extended {
            inner: Box::new(Value::Forall {
                variable: 2,
                body: Box::new(Value::Arrow {
                    deferred: false,
                    domain: Box::new(Value::TypeVariable(2)),
                    codomain: Box::new(Value::TypeVariable(5)),
                    effects: Vec::new(),
                    effect_tail: Some(9),
                }),
            }),
            members: OrderedFields::from([("member".to_owned(), Value::TypeVariable(11))]),
        };
        let mut variables = BTreeSet::from([1]);
        collect_type_variables(&value, &mut variables);
        assert_eq!(variables, BTreeSet::from([1, 2, 5, 9, 11]));
    }
}
