//! Trace-local evidence for residual code sharing, not source value equality.
//!
//! Runtime captures are named by their ABI slot, not by a caller's SSA number.
//! Everything consumed statically is retained, including transitive closures.
//! Unsupported state never produces a reusable key.

use super::{LexicalClosure, hir_error};
use crate::diagnostic::Diagnostic;
use crate::eval::{Context, EffectScope, ModuleInstanceScope, closure_free_names};
use crate::value::{
    ChoiceSource, Domain, EffectOperationOwnership, OrderedFields, RuntimeMeaning, RuntimeValue,
    Value, lookup, lookup_signature,
};
use std::collections::{BTreeMap, HashMap};
use std::mem::{Discriminant, discriminant};
use std::rc::Rc;

#[derive(Clone, PartialEq)]
pub(super) struct ResidualEnvironmentKey(Vec<Part>);

// Lengths and variant markers make this a structural encoding, not a display
// string or a hash. Scope values retain their revision-qualified identities.
#[derive(Clone, PartialEq)]
enum Part {
    Value(Discriminant<Value>),
    Number(u64),
    Integer(num_bigint::BigInt),
    Text(String),
    Domain(Option<Domain>),
    Runtime(usize, usize, RuntimeMeaning),
    Closure(usize),
    Reference(usize),
    Instances(Rc<ModuleInstanceScope>),
    Scope(Rc<EffectScope>),
    Ownership(EffectOperationOwnership),
}

pub(super) fn residual_environment_key(
    context: &Rc<Context>,
    closure: LexicalClosure<'_>,
    captures: &[RuntimeValue],
    instances: &Rc<ModuleInstanceScope>,
    scope: &Rc<EffectScope>,
    reuse: bool,
) -> Result<Option<ResidualEnvironmentKey>, Diagnostic> {
    let mut key = Builder::new(context, captures);
    key.parts.push(Part::Instances(instances.clone()));
    key.parts.push(Part::Scope(scope.clone()));
    key.number(u64::from(reuse));
    if !key.closure(closure)? {
        return Ok(None);
    }
    Ok(Some(ResidualEnvironmentKey(key.parts)))
}

struct Builder<'a> {
    context: &'a Rc<Context>,
    slots: HashMap<(usize, usize), usize>,
    closures: HashMap<(String, u32, usize), usize>,
    parts: Vec<Part>,
}

impl<'a> Builder<'a> {
    fn new(context: &'a Rc<Context>, captures: &[RuntimeValue]) -> Self {
        Self {
            context,
            slots: captures
                .iter()
                .enumerate()
                .map(|(slot, capture)| ((capture.id, capture.type_id), slot))
                .collect(),
            closures: HashMap::new(),
            parts: Vec::new(),
        }
    }

    fn number(&mut self, number: u64) {
        self.parts.push(Part::Number(number));
    }

    fn text(&mut self, text: &str) {
        self.parts.push(Part::Text(text.to_owned()));
    }

    fn optional_value(&mut self, value: Option<&Value>) -> Result<bool, Diagnostic> {
        self.number(u64::from(value.is_some()));
        match value {
            Some(value) => self.value(value),
            None => Ok(true),
        }
    }

    fn values<'v>(
        &mut self,
        values: impl ExactSizeIterator<Item = &'v Value>,
    ) -> Result<bool, Diagnostic> {
        self.number(values.len() as u64);
        for value in values {
            if !self.value(value)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn fields(&mut self, fields: &OrderedFields) -> Result<bool, Diagnostic> {
        self.number(fields.len() as u64);
        for (name, value) in fields {
            self.text(name);
            if !self.value(value)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn runtime(&mut self, value: &RuntimeValue) -> Result<bool, Diagnostic> {
        if matches!(
            value.meaning,
            RuntimeMeaning::Ordering | RuntimeMeaning::ScalarOrdering { .. }
        ) {
            return Ok(false);
        }
        let slot = self.slots.get(&(value.id, value.type_id)).ok_or_else(|| {
            hir_error("Residual environment evidence refers to an unplanned runtime capture.")
        })?;
        self.parts.push(Part::Runtime(
            *slot,
            value.type_id,
            value.meaning.clone(),
        ));
        Ok(true)
    }

    fn closure(&mut self, closure: LexicalClosure<'_>) -> Result<bool, Diagnostic> {
        let identity = (
            closure.module.to_owned(),
            closure.body.0,
            Rc::as_ptr(closure.environment) as usize,
        );
        if let Some(index) = self.closures.get(&identity) {
            self.parts.push(Part::Reference(*index));
            return Ok(true);
        }
        let index = self.closures.len();
        self.closures.insert(identity, index);
        self.parts.push(Part::Closure(index));
        self.text(closure.module);
        self.number(closure.parameter.0 as u64);
        self.number(closure.body.0 as u64);
        self.number(u64::from(closure.self_name.is_some()));
        if let Some(name) = closure.self_name {
            self.text(name);
        }

        // These substitutions are read by specialization independently of free
        // term variables. Retain the nearest lexical value of every variable.
        let mut substitutions = BTreeMap::new();
        let mut environment = Some(closure.environment.clone());
        while let Some(current) = environment {
            for (variable, value) in current.type_substitutions.borrow().iter() {
                substitutions.entry(*variable).or_insert_with(|| value.clone());
            }
            environment = current.parent.borrow().clone();
        }
        self.number(substitutions.len() as u64);
        for (variable, value) in substitutions {
            self.number(variable as u64);
            if !self.value(&value)? {
                return Ok(false);
            }
        }
        let names = closure_free_names(
            self.context,
            closure.module,
            closure.parameter,
            closure.body,
            closure.self_name,
        )?;
        self.number(names.len() as u64);
        for name in names {
            self.text(&name);
            // An absent binding is recorded explicitly, not conflated with a
            // value. Demand may make a syntactic free occurrence unreachable.
            if !self.optional_value(lookup(closure.environment, &name).as_ref())?
                || !self.optional_value(lookup_signature(closure.environment, &name).as_ref())?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn value(&mut self, value: &Value) -> Result<bool, Diagnostic> {
        self.parts.push(Part::Value(discriminant(value)));
        match value {
            Value::Int(value) => self.parts.push(Part::Integer(value.clone())),
            Value::Float(value) => self.number(value.to_bits()),
            Value::Float32(value) => self.number(value.to_bits() as u64),
            Value::Vector(values) => {
                for value in values {
                    self.number(value.to_bits() as u64);
                }
            }
            Value::VectorMask(values) => {
                for value in values {
                    self.number(u64::from(*value));
                }
            }
            Value::IntegerVector { bits, lanes } => {
                self.number(*bits as u64);
                self.number(lanes.len() as u64);
                for value in lanes {
                    self.number(*value as u32 as u64);
                }
            }
            Value::IntegerVectorMask { bits, lanes } => {
                self.number(*bits as u64);
                self.number(lanes.len() as u64);
                for value in lanes {
                    self.number(u64::from(*value));
                }
            }
            Value::Text(value) | Value::OpaqueType(value) => self.text(value),
            Value::Unit | Value::Unbounded => {}
            Value::TypeVariable(variable) => self.number(*variable as u64),
            Value::Shape(fields) => return self.fields(fields),
            Value::Array(values) => return self.values(values.iter()),
            Value::Union(values) => return self.values(values.iter()),
            Value::IndexedStep { elements } => return self.values(elements.iter()),
            Value::Scratch { values, capacity } => {
                self.number(*capacity as u64);
                return self.values(values.iter());
            }
            Value::RegionType(value)
            | Value::ScratchType(value)
            | Value::EmptyArray { element: value }
            | Value::DeferredScratch { capacity: value } => return self.value(value),
            Value::Tag { name, payload } => {
                self.text(name);
                return self.optional_value(payload.as_deref());
            }
            Value::Primitive { name, arity, applied } => {
                self.text(name);
                self.number(*arity as u64);
                return self.values(applied.iter());
            }
            Value::Range { low, high, domain } => {
                self.parts.push(Part::Domain(*domain));
                return Ok(self.value(low)? && self.value(high)?);
            }
            Value::Arrow { deferred, domain, codomain, effects, effect_tail } => {
                self.number(u64::from(*deferred));
                self.number(u64::from(effect_tail.is_some()));
                if let Some(tail) = effect_tail {
                    self.number(*tail as u64);
                }
                return Ok(self.value(domain)? && self.value(codomain)? && self.values(effects.iter())?);
            }
            Value::Forall { variable, body } => {
                self.number(*variable as u64);
                return self.value(body);
            }
            Value::Effect { id, name, operations, operation_ownership, host } => {
                self.number(*id as u64);
                self.text(name);
                self.number(u64::from(*host));
                self.number(operation_ownership.len() as u64);
                for (name, ownership) in operation_ownership {
                    self.text(name);
                    self.parts.push(Part::Ownership(ownership.clone()));
                }
                return self.fields(operations);
            }
            Value::Operation { effect, name } => {
                self.text(name);
                return self.value(effect);
            }
            Value::Sealed { name, inner } => {
                self.text(name);
                return self.value(inner);
            }
            Value::Extended { inner, members } => {
                return Ok(self.value(inner)? && self.fields(members)?);
            }
            Value::ModuleClosure { module } => self.text(module),
            Value::Runtime(value) => return self.runtime(value),
            Value::Closure {
                module, module_instances, effect_scope, parameter, body,
                environment, self_name, imports, signature, reuse_assertion, deferred,
            } => {
                self.parts.push(Part::Instances(module_instances.clone()));
                self.parts.push(Part::Scope(effect_scope.clone()));
                self.number(u64::from(*deferred));
                self.number(u64::from(reuse_assertion.is_some()));
                self.number(u64::from(imports.is_some()));
                if let Some(imports) = imports {
                    self.number(imports.len() as u64);
                    for (name, path) in imports {
                        self.text(name);
                        self.text(path);
                    }
                }
                if !self.optional_value(signature.as_deref())? {
                    return Ok(false);
                }
                return self.closure(LexicalClosure {
                    module, parameter: *parameter, body: *body,
                    environment, self_name: self_name.as_deref(),
                });
            }
            Value::ClosureChoice { selector, alternatives } => {
                if !self.runtime(selector)? {
                    return Ok(false);
                }
                self.number(alternatives.len() as u64);
                for alternative in alternatives.iter() {
                    self.number(alternative.product_type as u64);
                    self.number(alternative.payload_type as u64);
                    self.number(alternative.captures.len() as u64);
                    for capture in &alternative.captures {
                        if !self.runtime(capture)? {
                            return Ok(false);
                        }
                    }
                    let source = match &alternative.source {
                        ChoiceSource::Lambda {
                            module, module_instances, effect_scope, parameter, body,
                            environment, self_name, signature, reuse_assertion, deferred,
                        } => Value::Closure {
                            module: module.clone(), module_instances: module_instances.clone(),
                            effect_scope: effect_scope.clone(), parameter: *parameter, body: *body,
                            environment: environment.clone(), self_name: self_name.clone(),
                            imports: None, signature: signature.clone(),
                            reuse_assertion: *reuse_assertion, deferred: *deferred,
                        },
                        ChoiceSource::Primitive { name, arity, applied } => Value::Primitive {
                            name: name.clone(), arity: *arity, applied: applied.clone(),
                        },
                    };
                    if !self.value(&source)? {
                        return Ok(false);
                    }
                }
            }
            // Mutable authority and one-shot demand cannot be snapshotted by
            // copying an Rc. Continue staging instead of claiming equality.
            Value::Region { .. } | Value::RegionRejoin { .. }
            | Value::Deferred { .. } | Value::Continuation { .. } => return Ok(false),
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(value: &Value, captures: &[RuntimeValue]) -> Option<ResidualEnvironmentKey> {
        let context = Rc::new(Context::default());
        let mut builder = Builder::new(&context, captures);
        builder.value(value).unwrap().then_some(ResidualEnvironmentKey(builder.parts))
    }

    fn runtime(id: usize, meaning: RuntimeMeaning) -> RuntimeValue {
        RuntimeValue { id, type_id: 4, meaning }
    }

    #[test]
    fn static_values_and_float_bits_are_evidence() {
        assert!(key(&Value::Text("left".into()), &[]) != key(&Value::Text("right".into()), &[]));
        assert!(key(&Value::Float(0.0), &[]) != key(&Value::Float(-0.0), &[]));
        let nan = Value::Float(f64::from_bits(0x7ff8_0000_0000_0001));
        assert!(key(&nan, &[]) == key(&nan, &[]));
        assert!(key(&nan, &[]) != key(&Value::Float(f64::from_bits(0x7ff8_0000_0000_0002)), &[]));
    }

    #[test]
    fn runtime_renaming_preserves_slots_not_caller_numbers() {
        let left = runtime(7, RuntimeMeaning::Plain);
        let right = runtime(91, RuntimeMeaning::Plain);
        assert!(key(&Value::Runtime(left.clone()), &[left]) == key(&Value::Runtime(right.clone()), &[right]));
    }

    #[test]
    fn capture_permutations_and_aliases_do_not_share() {
        let x = runtime(7, RuntimeMeaning::Plain);
        let y = runtime(91, RuntimeMeaning::Plain);
        let captures = [x.clone(), y.clone()];
        let pair = |left, right| Value::Shape(OrderedFields::from([
            ("left".into(), Value::Runtime(left)),
            ("right".into(), Value::Runtime(right)),
        ]));
        let original = key(&pair(x.clone(), y.clone()), &captures);
        assert!(original != key(&pair(y.clone(), x.clone()), &captures));
        assert!(original != key(&pair(x.clone(), x), &captures));
    }

    #[test]
    fn capture_ownership_meaning_is_not_just_a_layout() {
        let shared = runtime(7, RuntimeMeaning::SharedStore);
        let reusable = runtime(7, RuntimeMeaning::ReusableStore);
        assert!(key(&Value::Runtime(shared.clone()), &[shared]) != key(&Value::Runtime(reusable.clone()), &[reusable]));
    }

    #[test]
    fn empty_array_element_types_and_record_order_are_retained() {
        let ints = Value::EmptyArray { element: Box::new(Value::OpaqueType("Int".into())) };
        let texts = Value::EmptyArray { element: Box::new(Value::OpaqueType("Text".into())) };
        assert!(key(&ints, &[]) != key(&texts, &[]));
        let first = Value::Shape(OrderedFields::from([("x".into(), Value::Unit), ("y".into(), Value::Unit)]));
        let second = Value::Shape(OrderedFields::from([("y".into(), Value::Unit), ("x".into(), Value::Unit)]));
        assert!(key(&first, &[]) != key(&second, &[]));
    }

    #[test]
    fn mutable_regions_have_no_reusable_key() {
        let value = Value::Region {
            store: Rc::new(std::cell::RefCell::new(vec![Value::Unit])), start: 0, end: 1,
        };
        assert!(key(&value, &[]).is_none());
    }
}
