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

/// Select the highest-priority evidence before doing any fallback work. An
/// environment-independent signature can retain its shared root; open variables,
/// effect identities and unions still go through call-local substitution.
pub(crate) fn resolve_call_signature(
    attached: Option<std::rc::Rc<Value>>,
    environment: &Environment,
    recursive: impl FnOnce() -> Option<Value>,
    inferred: impl FnOnce() -> Option<Value>,
) -> Option<std::rc::Rc<Value>> {
    let signature = attached
        .or_else(|| recursive().map(std::rc::Rc::new))
        .or_else(|| inferred().map(std::rc::Rc::new))?;
    if TypeValue::needs_substitution(&signature) {
        Some(std::rc::Rc::new(substitute_signature(
            &signature,
            environment,
        )))
    } else {
        Some(signature)
    }
}

pub(crate) fn substitute_signature(signature: &Value, environment: &Environment) -> Value {
    if !TypeValue::needs_substitution(signature) {
        return signature.clone();
    }
    SignatureSubstitution::new(environment).value(signature)
}

// One synchronous environment read. Shared input owners stay alive until the
// traversal ends; addresses identify repeated storage, not type equivalence.
// Substitution results must never survive an environment change or another call.
struct SignatureSubstitution<'a> {
    environment: &'a Environment,
    edges: std::collections::HashMap<*const Value, (TypeValue, TypeValue)>,
    records: std::collections::HashMap<*const (), (OrderedFields, OrderedFields)>,
    #[cfg(test)]
    value_visits: usize,
}

impl<'a> SignatureSubstitution<'a> {
    fn new(environment: &'a Environment) -> Self {
        Self {
            environment,
            edges: Default::default(),
            records: Default::default(),
            #[cfg(test)]
            value_visits: 0,
        }
    }

    fn edge(&mut self, edge: &TypeValue) -> TypeValue {
        if !edge.requires_substitution() {
            return edge.clone();
        }
        // Unaliased input storage cannot be visited by another incoming edge.
        // Leave the common tree-shaped case free of memo-table allocations.
        if !edge.has_shared_storage() {
            return TypeValue::new(self.value(edge));
        }
        let identity = edge.as_ref() as *const Value;
        if let Some((_, result)) = self.edges.get(&identity) {
            return result.clone();
        }
        let result = TypeValue::new(self.value(edge));
        self.edges.insert(identity, (edge.clone(), result.clone()));
        result
    }

    fn fields(&mut self, fields: &OrderedFields) -> OrderedFields {
        let shared = fields.has_shared_storage();
        let identity = fields.storage_identity();
        if shared && let Some((_, result)) = self.records.get(&identity) {
            return result.clone();
        }
        let result: OrderedFields = fields
            .iter()
            .map(|(name, value)| (name.clone(), self.value(value)))
            .collect();
        if shared {
            self.records
                .insert(identity, (fields.clone(), result.clone()));
        }
        result
    }

    fn value(&mut self, signature: &Value) -> Value {
        if let Value::Shape(fields) = signature
            && fields.has_shared_storage()
            && let Some((_, result)) = self.records.get(&fields.storage_identity())
        {
            return Value::Shape(result.clone());
        }
        #[cfg(test)]
        {
            self.value_visits += 1;
        }
        if !TypeValue::needs_substitution(signature) {
            return signature.clone();
        }

        match signature {
            Value::Effect { id, .. } => {
                let mut scope = Some(self.environment.clone());
                while let Some(current) = scope {
                    if let Some(value) = current.effect_substitutions.borrow().get(id) {
                        return value.clone();
                    }
                    scope = current.parent.borrow().clone();
                }
                signature.clone()
            }
            Value::TypeVariable(variable) => {
                substitution(self.environment, *variable).unwrap_or_else(|| signature.clone())
            }
            Value::Shape(fields) => Value::Shape(self.fields(fields)),
            Value::Array(elements) => {
                Value::Array(elements.iter().map(|value| self.value(value)).collect())
            }
            Value::ScratchType(element) => Value::ScratchType(Box::new(self.value(element))),
            Value::ResourceType { family, payload } => Value::ResourceType {
                family: family.clone(),
                payload: Box::new(self.value(payload)),
            },
            Value::EmptyArray { element } => Value::EmptyArray {
                element: Box::new(self.value(element)),
            },
            Value::Union(members) => members
                .iter()
                .fold(Value::Union(Default::default()), |union, member| {
                    crate::primitives::union(union, self.value(member))
                }),
            Value::Tag { name, payload } => Value::Tag {
                name: name.clone(),
                payload: payload.as_deref().map(|value| Box::new(self.value(value))),
            },
            Value::Range { low, high, domain } => Value::Range {
                low: self.edge(low),
                high: self.edge(high),
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
                domain: self.edge(domain),
                codomain: self.edge(codomain),
                effects: effects.iter().map(|effect| self.value(effect)).collect(),
                effect_tail: *effect_tail,
            },
            Value::Forall { variable, body } => Value::Forall {
                variable: *variable,
                body: Box::new(self.value(body)),
            },
            Value::Extended { inner, members } => Value::Extended {
                inner: Box::new(self.value(inner)),
                members: self.fields(members),
            },
            Value::Sealed { name, inner } => Value::Sealed {
                name: name.clone(),
                inner: Box::new(self.value(inner)),
            },
            _ => signature.clone(),
        }
    }
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

    fn shared_arrow(edge: TypeValue) -> Value {
        Value::Arrow {
            deferred: false,
            domain: edge.clone(),
            codomain: edge,
            effects: Vec::new(),
            effect_tail: None,
        }
    }

    #[test]
    fn substitution_visits_open_function_graph_nodes_not_expanded_paths() {
        let environment = child_env(None);
        environment
            .type_substitutions
            .borrow_mut()
            .insert(7, int_type());
        let mut input = TypeValue::new(Value::TypeVariable(7));
        for _ in 0..24 {
            input = TypeValue::new(shared_arrow(input));
        }
        let mut operation = SignatureSubstitution::new(&environment);
        let result = operation.value(&input);
        assert!(
            operation.value_visits <= 26,
            "{} visits",
            operation.value_visits
        );
        assert_eq!(operation.edges.len(), 24);
        let mut current = &result;
        for _ in 0..24 {
            let Value::Arrow {
                domain, codomain, ..
            } = current
            else {
                panic!("arrow");
            };
            assert!(std::ptr::eq(domain.as_ref(), codomain.as_ref()));
            current = domain;
        }
        assert!(equal(current, &int_type()));
    }

    #[test]
    fn substitution_preserves_open_record_diamonds() {
        let environment = child_env(None);
        environment
            .type_substitutions
            .borrow_mut()
            .insert(7, int_type());
        let mut input = Value::TypeVariable(7);
        for _ in 0..24 {
            input = Value::Shape(OrderedFields::from([
                ("left".into(), input.clone()),
                ("right".into(), input),
            ]));
        }
        let mut operation = SignatureSubstitution::new(&environment);
        let result = operation.value(&input);
        assert!(
            operation.value_visits <= 50,
            "{} visits",
            operation.value_visits
        );
        assert_eq!(operation.records.len(), 23);
        let mut current = &result;
        for depth in 0..24 {
            let Value::Shape(fields) = current else {
                panic!("shape");
            };
            let left = fields.get("left").unwrap();
            let right = fields.get("right").unwrap();
            if depth < 23 {
                let (Value::Shape(left), Value::Shape(right)) = (left, right) else {
                    panic!("shapes");
                };
                assert_eq!(left.storage_identity(), right.storage_identity());
            } else {
                assert!(equal(left, &int_type()) && equal(right, &int_type()));
            }
            current = left;
        }
    }

    #[test]
    fn substitution_graph_memo_is_local_to_current_lexical_environment() {
        let parent = child_env(None);
        let child = child_env(Some(parent.clone()));
        let signature = shared_arrow(TypeValue::new(Value::TypeVariable(7)));
        let result_leaf = |environment: &Environment| {
            let Value::Arrow { domain, .. } = substitute_signature(&signature, environment) else {
                panic!("arrow");
            };
            domain.into_owned()
        };
        assert!(matches!(result_leaf(&child), Value::TypeVariable(7)));
        parent
            .type_substitutions
            .borrow_mut()
            .insert(7, Value::Unit);
        assert!(matches!(result_leaf(&child), Value::Unit));
        child.type_substitutions.borrow_mut().insert(7, int_type());
        assert!(equal(&result_leaf(&child), &int_type()));
        child.type_substitutions.borrow_mut().clear();
        let replacement = child_env(None);
        replacement
            .type_substitutions
            .borrow_mut()
            .insert(7, Value::OpaqueType("Text".into()));
        *child.parent.borrow_mut() = Some(replacement);
        assert!(matches!(result_leaf(&child), Value::OpaqueType(name) if name == "Text"));
    }

    #[test]
    fn substitution_graph_preserves_single_step_replacement_and_quantifier_identity() {
        let environment = child_env(None);
        environment
            .type_substitutions
            .borrow_mut()
            .extend([(7, Value::TypeVariable(8)), (8, int_type())]);
        let signature = Value::Forall {
            variable: 11,
            body: Box::new(shared_arrow(TypeValue::new(Value::TypeVariable(7)))),
        };
        let Value::Forall { variable, body } = substitute_signature(&signature, &environment)
        else {
            panic!("forall");
        };
        assert_eq!(variable, 11);
        let Value::Arrow {
            domain, codomain, ..
        } = body.as_ref()
        else {
            panic!("arrow");
        };
        assert!(matches!(domain.as_ref(), Value::TypeVariable(8)));
        assert!(std::ptr::eq(domain.as_ref(), codomain.as_ref()));
    }

    #[test]
    fn substitution_graph_observes_copy_on_write_and_effect_replacements() {
        let environment = child_env(None);
        environment
            .effect_substitutions
            .borrow_mut()
            .insert(7, effect(9));
        let original = TypeValue::new(effect(7));
        let mut changed = original.clone();
        *changed = effect(8);
        let signature = Value::Arrow {
            deferred: true,
            domain: original.clone(),
            codomain: changed,
            effects: vec![effect(7)],
            effect_tail: Some(12),
        };
        let Value::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } = substitute_signature(&signature, &environment)
        else {
            panic!("arrow");
        };
        assert!(deferred);
        assert_eq!(effect_tail, Some(12));
        assert!(matches!(domain.as_ref(), Value::Effect { id: 9, .. }));
        assert!(matches!(codomain.as_ref(), Value::Effect { id: 8, .. }));
        assert!(matches!(&effects[0], Value::Effect { id: 9, .. }));
        assert!(matches!(original.as_ref(), Value::Effect { id: 7, .. }));
        environment
            .effect_substitutions
            .borrow_mut()
            .insert(7, effect(10));
        let result = substitute_signature(&shared_arrow(original), &environment);
        assert!(
            matches!(result, Value::Arrow { domain, .. } if matches!(domain.as_ref(), Value::Effect { id: 10, .. }))
        );
    }

    #[test]
    fn substitution_graph_still_normalizes_unions_and_shares_closed_edges() {
        let environment = child_env(None);
        let union = TypeValue::new(Value::Union(
            vec![Value::Unit, Value::Union(vec![Value::Unit].into())].into(),
        ));
        let Value::Arrow {
            domain, codomain, ..
        } = substitute_signature(&shared_arrow(union), &environment)
        else {
            panic!("arrow");
        };
        assert!(matches!(domain.as_ref(), Value::Unit));
        assert!(std::ptr::eq(domain.as_ref(), codomain.as_ref()));
        let closed = TypeValue::new(int_type());
        let signature = Value::Arrow {
            deferred: false,
            domain: closed.clone(),
            codomain: TypeValue::new(Value::TypeVariable(7)),
            effects: Vec::new(),
            effect_tail: None,
        };
        let Value::Arrow { domain, .. } = substitute_signature(&signature, &environment) else {
            panic!("arrow");
        };
        assert!(std::ptr::eq(closed.as_ref(), domain.as_ref()));
    }

    #[test]
    fn attached_closed_call_signature_is_reused_without_forcing_fallbacks() {
        let attached = std::rc::Rc::new(Value::Arrow {
            deferred: false,
            domain: TypeValue::new(int_type()),
            codomain: TypeValue::new(int_type()),
            effects: Vec::new(),
            effect_tail: None,
        });
        let result = resolve_call_signature(
            Some(attached.clone()),
            &child_env(None),
            || panic!("an attached signature precedes recursive lookup"),
            || panic!("an attached signature precedes inferred lookup"),
        )
        .unwrap();
        assert!(std::rc::Rc::ptr_eq(&attached, &result));
    }

    #[test]
    fn recursive_call_signature_precedes_inferred_signature() {
        let result = resolve_call_signature(
            None,
            &child_env(None),
            || Some(int_type()),
            || panic!("a recursive signature precedes inferred lookup"),
        )
        .unwrap();
        assert!(equal(&result, &int_type()));
    }

    #[test]
    fn missing_call_signatures_force_each_fallback_once_and_do_not_cache_absence() {
        let calls = std::cell::Cell::new(0);
        for inferred in [None, Some(Value::Unit)] {
            let expected = inferred.is_some();
            let result = resolve_call_signature(
                None,
                &child_env(None),
                || {
                    calls.set(calls.get() + 1);
                    None
                },
                || {
                    calls.set(calls.get() + 1);
                    inferred
                },
            );
            assert_eq!(result.is_some(), expected);
        }
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn call_signatures_specialize_again_after_environment_changes() {
        let environment = child_env(None);
        let signature = std::rc::Rc::new(Value::TypeVariable(7));
        for expected in [int_type(), Value::Unit] {
            environment
                .type_substitutions
                .borrow_mut()
                .insert(7, expected.clone());
            let result =
                resolve_call_signature(Some(signature.clone()), &environment, || None, || None)
                    .unwrap();
            assert!(equal(&result, &expected));
            assert!(!std::rc::Rc::ptr_eq(&signature, &result));
        }
        assert!(matches!(signature.as_ref(), Value::TypeVariable(7)));
    }

    #[test]
    fn shared_call_signatures_keep_effect_identity_substitution() {
        let environment = child_env(None);
        let signature = std::rc::Rc::new(Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Unit),
            codomain: TypeValue::new(Value::Unit),
            effects: vec![effect(1)],
            effect_tail: None,
        });
        for id in [2, 3] {
            environment
                .effect_substitutions
                .borrow_mut()
                .insert(1, effect(id));
            let result =
                resolve_call_signature(Some(signature.clone()), &environment, || None, || None)
                    .unwrap();
            let Value::Arrow { effects, .. } = result.as_ref() else {
                panic!("arrow")
            };
            assert!(matches!(effects[0], Value::Effect { id: actual, .. } if actual == id));
        }
        let Value::Arrow { effects, .. } = signature.as_ref() else {
            panic!("arrow")
        };
        assert!(matches!(effects[0], Value::Effect { id: 1, .. }));
    }

    #[test]
    fn shared_call_signatures_keep_union_normalization() {
        let signature = std::rc::Rc::new(Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Union(vec![Value::Unit, Value::Unit].into())),
            codomain: TypeValue::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: None,
        });
        let result =
            resolve_call_signature(Some(signature.clone()), &child_env(None), || None, || None)
                .unwrap();
        let Value::Arrow { domain, .. } = result.as_ref() else {
            panic!("arrow")
        };
        assert!(matches!(domain.as_ref(), Value::Unit));
        let Value::Arrow { domain, .. } = signature.as_ref() else {
            panic!("arrow")
        };
        assert!(matches!(domain.as_ref(), Value::Union(members) if members.len() == 2));
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
