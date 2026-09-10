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

pub(crate) fn contains_free_type_variables(value: &Value) -> bool {
    let mut scopes = vec![None];
    let mut pending = vec![(value, 0)];
    let mut seen = HashSet::new();
    while let Some((value, scope)) = pending.pop() {
        if !seen.insert((value as *const Value, scope)) {
            continue;
        }
        let is_bound = |variable| {
            let mut current = scope;
            while let Some((parent, bound)) = scopes[current] {
                if variable == bound {
                    return true;
                }
                current = parent;
            }
            false
        };
        match value {
            Value::TypeVariable(variable) if !is_bound(*variable) => return true,
            Value::Forall { variable, body } => {
                let child = scopes.len();
                scopes.push(Some((scope, *variable)));
                pending.push((body, child));
            }
            Value::Shape(fields) => {
                pending.extend(fields.iter().map(|(_, value)| (value, scope)));
            }
            Value::Array(members) => {
                pending.extend(members.iter().map(|value| (value, scope)));
            }
            Value::Union(members) => {
                pending.extend(members.iter().map(|value| (value, scope)));
            }
            Value::RegionType(element)
            | Value::ScratchType(element)
            | Value::ResourceType {
                payload: element, ..
            }
            | Value::EmptyArray { element }
            | Value::DeferredScratch { capacity: element }
            | Value::Sealed { inner: element, .. } => pending.push((element, scope)),
            Value::Tag {
                payload: Some(payload),
                ..
            } => pending.push((payload, scope)),
            Value::Range { low, high, .. } => {
                pending.extend([(low.as_ref(), scope), (high.as_ref(), scope)]);
            }
            Value::Arrow {
                domain,
                codomain,
                effects,
                effect_tail,
                ..
            } => {
                if effect_tail.is_some_and(|tail| !is_bound(tail)) {
                    return true;
                }
                pending.extend([(domain.as_ref(), scope), (codomain.as_ref(), scope)]);
                pending.extend(effects.iter().map(|value| (value, scope)));
            }
            Value::Effect { operations, .. } => {
                pending.extend(operations.iter().map(|(_, value)| (value, scope)));
            }
            Value::Operation { effect, .. } => pending.push((effect, scope)),
            Value::Extended { inner, members } => {
                pending.push((inner, scope));
                pending.extend(members.iter().map(|(_, value)| (value, scope)));
            }
            _ => {}
        }
    }
    false
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

    #[test]
    fn free_variables_respect_binders_and_shared_occurrences() {
        let shared = diamond(Value::TypeVariable(7), 24);
        let closed = Value::Forall {
            variable: 7,
            body: Box::new(shared.clone()),
        };
        assert!(!contains_free_type_variables(&closed));
        assert!(contains_free_type_variables(&Value::Array(
            vec![closed, shared].into(),
        )));
    }

    #[test]
    fn free_effect_row_tails_remain_open_inside_polymorphic_signatures() {
        let signature = |tail| Value::Forall {
            variable: 7,
            body: Box::new(Value::Arrow {
                deferred: false,
                domain: Box::new(Value::TypeVariable(7)),
                codomain: Box::new(Value::Unit),
                effects: Vec::new(),
                effect_tail: Some(tail),
            }),
        };
        assert!(!contains_free_type_variables(&signature(7)));
        assert!(contains_free_type_variables(&signature(8)));
    }
}
