//! Instantiation of first-class type values at checked call boundaries.
//!
//! The checker remains the authority for compatibility. This module only binds
//! unsettled variables and specializes their recorded signatures; closed parts
//! must not rediscover a type by traversing the runtime argument.
use crate::value::{
    Domain as ValueDomain, Environment, OrderedFields, TypeValue, Value, contains_type_variables,
};

#[cfg(test)]
thread_local! {
    static VALUE_SIGNATURE_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(crate) fn signature_body(mut signature: &Value) -> &Value {
    while let Value::Forall { body, .. } = signature {
        signature = body;
    }
    signature
}

pub(crate) fn substitute_signature(signature: &Value, environment: &Environment) -> Value {
    if !TypeValue::needs_substitution(signature) {
        return signature.clone();
    }

    fn substitution(environment: &Environment, variable: u32) -> Option<Value> {
        let mut scope = Some(environment.clone());
        while let Some(current) = scope {
            if let Some(value) = current.type_substitutions.borrow().get(&variable) {
                return Some(value.clone());
            }
            scope = current.parent.borrow().clone();
        }
        None
    }

    match signature {
        Value::Effect { id, .. } => {
            let mut scope = Some(environment.clone());
            while let Some(current) = scope {
                if let Some(value) = current.effect_substitutions.borrow().get(id) {
                    return value.clone();
                }
                scope = current.parent.borrow().clone();
            }
            signature.clone()
        }
        Value::TypeVariable(variable) => {
            substitution(environment, *variable).unwrap_or_else(|| signature.clone())
        }
        Value::Shape(fields) => Value::Shape(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), substitute_signature(value, environment)))
                .collect(),
        ),
        Value::Array(elements) => Value::Array(
            elements
                .iter()
                .map(|value| substitute_signature(value, environment))
                .collect(),
        ),
        Value::ScratchType(element) => {
            Value::ScratchType(Box::new(substitute_signature(element, environment)))
        }
        Value::ResourceType { family, payload } => Value::ResourceType {
            family: family.clone(),
            payload: Box::new(substitute_signature(payload, environment)),
        },
        Value::EmptyArray { element } => Value::EmptyArray {
            element: Box::new(substitute_signature(element, environment)),
        },
        Value::Union(members) => {
            members
                .iter()
                .fold(Value::Union(Default::default()), |union, member| {
                    crate::primitives::union(union, substitute_signature(member, environment))
                })
        }
        Value::Tag { name, payload } => Value::Tag {
            name: name.clone(),
            payload: payload
                .as_deref()
                .map(|value| Box::new(substitute_signature(value, environment))),
        },
        Value::Range { low, high, domain } => Value::Range {
            low: substitute_edge(low, environment),
            high: substitute_edge(high, environment),
            domain: *domain,
        },
        Value::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => Value::Arrow {
            deferred: *deferred,
            domain: substitute_edge(domain, environment),
            codomain: substitute_edge(codomain, environment),
            effects: effects
                .iter()
                .map(|effect| substitute_signature(effect, environment))
                .collect(),
            effect_tail: *effect_tail,
        },
        Value::Forall { variable, body } => Value::Forall {
            variable: *variable,
            body: Box::new(substitute_signature(body, environment)),
        },
        Value::Extended { inner, members } => Value::Extended {
            inner: Box::new(substitute_signature(inner, environment)),
            members: members
                .iter()
                .map(|(name, value)| (name.clone(), substitute_signature(value, environment)))
                .collect(),
        },
        Value::Sealed { name, inner } => Value::Sealed {
            name: name.clone(),
            inner: Box::new(substitute_signature(inner, environment)),
        },
        _ => signature.clone(),
    }
}

pub(crate) fn record_signature_substitutions(
    environment: &Environment,
    expected: &Value,
    actual: &Value,
) {
    // No compatibility check happens here: checking already established it.
    // In particular, do not reflect a whole array merely to discover that a
    // closed element signature has nowhere to store a substitution.
    if !contains_type_variables(expected) {
        return;
    }

    fn value_signature(value: &Value) -> Option<Value> {
        #[cfg(test)]
        VALUE_SIGNATURE_VISITS.with(|visits| visits.set(visits.get() + 1));
        match value {
            Value::Closure {
                signature: Some(signature),
                ..
            } => Some((**signature).clone()),
            Value::Int(_) => crate::primitives::constant("@type.int"),
            Value::Float(_) => crate::primitives::constant("@type.float"),
            Value::Float32(_) => crate::primitives::constant("@type.float32"),
            Value::Text(_) => Some(Value::Range {
                low: TypeValue::new(Value::Unbounded),
                high: TypeValue::new(Value::Unbounded),
                domain: Some(ValueDomain::Text),
            }),
            Value::Unit => Some(Value::Unit),
            Value::Range { .. }
            | Value::Arrow { .. }
            | Value::RegionType(_)
            | Value::ScratchType(_)
            | Value::ResourceType { .. }
            | Value::TypeVariable(_) => Some(value.clone()),
            Value::Shape(fields) => Some(Value::Shape(
                fields
                    .iter()
                    .map(|(name, value)| Some((name.clone(), value_signature(value)?)))
                    .collect::<Option<OrderedFields>>()?,
            )),
            Value::Array(elements) => {
                if elements.is_empty() {
                    return None;
                }
                let mut element_type = Value::Union(Default::default());
                for element in elements {
                    element_type =
                        crate::primitives::union(element_type, value_signature(element)?);
                }
                Some(Value::Array(vec![element_type].into()))
            }
            Value::EmptyArray { element } => Some(Value::Array(vec![(**element).clone()].into())),
            Value::Union(members) => Some(Value::Union(
                members
                    .iter()
                    .map(value_signature)
                    .collect::<Option<Vec<_>>>()?
                    .into(),
            )),
            Value::Tag { name, payload } => Some(Value::Tag {
                name: name.clone(),
                payload: match payload.as_deref() {
                    Some(payload) => Some(Box::new(value_signature(payload)?)),
                    None => None,
                },
            }),
            Value::Extended { inner, .. } | Value::Sealed { inner, .. } => value_signature(inner),
            _ => None,
        }
    }

    fn record_types(environment: &Environment, expected: &Value, actual: &Value) {
        let expected = signature_body(expected);
        let actual = signature_body(actual);
        if !contains_type_variables(expected) {
            return;
        }
        match (expected, actual) {
            (Value::TypeVariable(variable), actual) => {
                environment
                    .type_substitutions
                    .borrow_mut()
                    .entry(*variable)
                    .or_insert_with(|| actual.clone());
            }
            (Value::Shape(expected), Value::Shape(actual)) => {
                for (name, expected) in expected {
                    if let Some(actual) = actual.get(name) {
                        record_types(environment, expected, actual);
                    }
                }
            }
            (Value::Union(expected), actual) => {
                for expected in expected {
                    record_types(environment, expected, actual);
                }
            }
            (expected @ Value::Tag { .. }, Value::Union(actual)) => {
                for actual in actual {
                    record_types(environment, expected, actual);
                }
            }
            (
                Value::Tag {
                    name: expected_name,
                    payload: Some(expected),
                },
                Value::Tag {
                    name: actual_name,
                    payload: Some(actual),
                },
            ) if expected_name == actual_name => {
                record_types(environment, expected, actual);
            }
            (Value::Array(expected), Value::Array(actual)) => {
                if let Some(expected) = expected.first() {
                    for actual in actual {
                        record_types(environment, expected, actual);
                    }
                }
            }
            (Value::Array(expected), Value::EmptyArray { element }) => {
                if let Some(expected) = expected.first() {
                    record_types(environment, expected, element);
                }
            }
            (
                Value::ResourceType {
                    family: expected_family,
                    payload: expected,
                },
                Value::ResourceType {
                    family: actual_family,
                    payload: actual,
                },
            ) if expected_family == actual_family => {
                record_types(environment, expected, actual);
            }
            (
                Value::Arrow {
                    domain: expected_domain,
                    codomain: expected_codomain,
                    ..
                },
                Value::Arrow {
                    domain: actual_domain,
                    codomain: actual_codomain,
                    ..
                },
            ) => {
                record_types(environment, expected_domain, actual_domain);
                record_types(environment, expected_codomain, actual_codomain);
            }
            _ => {}
        }
    }

    match (signature_body(expected), signature_body(actual)) {
        (Value::Shape(expected), Value::Shape(actual)) => {
            for (name, expected) in expected {
                if let Some(actual) = actual.get(name) {
                    record_signature_substitutions(environment, expected, actual);
                }
            }
        }
        (Value::Union(expected), actual) => {
            for expected in expected {
                record_signature_substitutions(environment, expected, actual);
            }
        }
        (expected @ Value::Tag { .. }, Value::Union(actual)) => {
            for actual in actual {
                record_signature_substitutions(environment, expected, actual);
            }
        }
        (
            Value::Tag {
                name: expected_name,
                payload: Some(expected),
            },
            Value::Tag {
                name: actual_name,
                payload: Some(actual),
            },
        ) if expected_name == actual_name => {
            record_signature_substitutions(environment, expected, actual);
        }
        (Value::Array(expected), Value::Array(actual)) => {
            if let Some(expected) = expected.first()
                && let Some(Value::Array(types)) = value_signature(&Value::Array(actual.clone()))
            {
                record_types(environment, expected, &types[0]);
            }
        }
        (Value::Array(expected), Value::EmptyArray { element }) => {
            if let Some(expected) = expected.first() {
                record_signature_substitutions(environment, expected, element);
            }
        }
        (
            Value::ResourceType {
                family: expected_family,
                payload: expected,
            },
            Value::ResourceType {
                family: actual_family,
                payload: actual,
            },
        ) if expected_family == actual_family => {
            record_types(environment, expected, actual);
        }
        (expected @ Value::Arrow { .. }, Value::Closure { .. })
        | (expected @ Value::TypeVariable(_), Value::Closure { .. }) => {
            if let Value::TypeVariable(variable) = expected
                && environment
                    .type_substitutions
                    .borrow()
                    .contains_key(variable)
            {
                return;
            }
            if let Some(actual) = value_signature(actual) {
                record_types(environment, expected, &actual);
            }
        }
        (expected @ Value::Arrow { .. }, actual @ Value::Arrow { .. })
            if !crate::value::contains_free_type_variables(actual) =>
        {
            record_types(environment, expected, actual);
        }
        (Value::TypeVariable(variable), actual) => {
            if environment
                .type_substitutions
                .borrow()
                .contains_key(variable)
            {
                return;
            }
            if let Some(actual) = value_signature(actual) {
                environment
                    .type_substitutions
                    .borrow_mut()
                    .entry(*variable)
                    .or_insert(actual);
            }
        }
        _ => {}
    }
}

fn substitute_edge(edge: &TypeValue, environment: &Environment) -> TypeValue {
    if !edge.requires_substitution() {
        return edge.clone();
    }
    TypeValue::new(substitute_signature(edge, environment))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{child_env, equal};
    use std::collections::BTreeMap;

    fn int_type() -> Value {
        crate::primitives::constant("@type.int").unwrap()
    }

    fn large_array() -> Value {
        Value::Array((0..10_000).map(|n| Value::Int(n.into())).collect())
    }

    fn effect(id: u32) -> Value {
        Value::Effect {
            id,
            name: format!("Effect{id}"),
            operations: OrderedFields::default(),
            operation_ownership: BTreeMap::new(),
            host: false,
        }
    }

    #[test]
    fn closed_signature_still_normalizes_nested_and_duplicate_unions() {
        let union = Value::Union(vec![Value::Unit, Value::Unit].into());
        let nested = Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Union(vec![union].into())),
            codomain: TypeValue::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: None,
        };
        let Value::Arrow { domain, .. } = substitute_signature(&nested, &child_env(None)) else {
            panic!("arrow signature")
        };
        assert!(matches!(*domain, Value::Unit));
    }

    #[test]
    fn closed_array_signature_does_not_reflect_its_argument() {
        let environment = child_env(None);
        let expected = Value::Array(vec![int_type()].into());
        VALUE_SIGNATURE_VISITS.with(|visits| visits.set(0));
        record_signature_substitutions(&environment, &expected, &large_array());
        VALUE_SIGNATURE_VISITS.with(|visits| assert_eq!(visits.get(), 0));
        assert!(environment.type_substitutions.borrow().is_empty());
    }

    #[test]
    fn already_bound_variable_does_not_reflect_a_second_argument() {
        let environment = child_env(None);
        environment
            .type_substitutions
            .borrow_mut()
            .insert(7, int_type());
        VALUE_SIGNATURE_VISITS.with(|visits| visits.set(0));
        record_signature_substitutions(&environment, &Value::TypeVariable(7), &large_array());
        VALUE_SIGNATURE_VISITS.with(|visits| assert_eq!(visits.get(), 0));
        assert!(equal(
            &environment.type_substitutions.borrow()[&7],
            &int_type()
        ));
    }

    #[test]
    fn generic_record_only_reflects_the_unsettled_field() {
        let environment = child_env(None);
        let expected = Value::Shape(OrderedFields::from([
            ("closed".into(), Value::Array(vec![int_type()].into())),
            ("open".into(), Value::TypeVariable(7)),
        ]));
        let actual = Value::Shape(OrderedFields::from([
            ("closed".into(), large_array()),
            ("open".into(), Value::Int(42.into())),
        ]));
        VALUE_SIGNATURE_VISITS.with(|visits| visits.set(0));
        record_signature_substitutions(&environment, &expected, &actual);
        VALUE_SIGNATURE_VISITS.with(|visits| assert_eq!(visits.get(), 1));
        assert!(equal(
            &environment.type_substitutions.borrow()[&7],
            &int_type()
        ));
    }

    #[test]
    fn generic_array_still_joins_all_element_types() {
        let environment = child_env(None);
        let expected = Value::Array(vec![Value::TypeVariable(7)].into());
        let actual = Value::Array(vec![Value::Int(1.into()), Value::Text("text".into())].into());
        record_signature_substitutions(&environment, &expected, &actual);
        let substitutions = environment.type_substitutions.borrow();
        let Value::Union(members) = &substitutions[&7] else {
            panic!("generic array must retain its heterogeneous element union")
        };
        assert_eq!(members.len(), 2);
    }

    #[test]
    fn effects_are_substituted_even_without_type_variables() {
        let environment = child_env(None);
        environment
            .effect_substitutions
            .borrow_mut()
            .insert(1, effect(2));
        let signature = Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Unit),
            codomain: TypeValue::new(Value::Unit),
            effects: vec![effect(1)],
            effect_tail: None,
        };
        assert!(!contains_type_variables(&signature));
        let Value::Arrow { effects, .. } = substitute_signature(&signature, &environment) else {
            panic!("arrow signature")
        };
        assert!(matches!(&effects[0], Value::Effect { id: 2, .. }));
    }

    #[test]
    fn independent_calls_keep_independent_type_substitutions() {
        let first = child_env(None);
        let second = child_env(None);
        let variable = Value::TypeVariable(7);
        record_signature_substitutions(&first, &variable, &Value::Int(1.into()));
        record_signature_substitutions(&second, &variable, &Value::Text("text".into()));
        assert!(!equal(
            &substitute_signature(&variable, &first),
            &substitute_signature(&variable, &second),
        ));
    }

    #[test]
    fn lexical_substitutions_are_not_cached_across_environment_changes() {
        let parent = child_env(None);
        let child = child_env(Some(parent.clone()));
        let variable = Value::TypeVariable(7);
        parent.type_substitutions.borrow_mut().insert(7, int_type());
        assert!(equal(&substitute_signature(&variable, &child), &int_type()));
        parent
            .type_substitutions
            .borrow_mut()
            .insert(7, Value::Unit);
        assert!(matches!(
            substitute_signature(&variable, &child),
            Value::Unit
        ));
    }

    #[test]
    fn single_variable_substitution_keeps_quantifier_shadowing() {
        let quantified = Value::Forall {
            variable: 7,
            body: Box::new(Value::TypeVariable(7)),
        };
        let result = crate::value::substitute_type_variable(&quantified, 7, &Value::Unit).unwrap();
        assert!(equal(&quantified, &result));
    }
}
