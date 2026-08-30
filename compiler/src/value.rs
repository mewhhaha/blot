use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::{Deref, DerefMut};
use std::rc::{Rc, Weak};

use num_bigint::BigInt;

use crate::ast::{ExpressionId, PatternId};
use crate::eval::Computation;

pub type Environment = Rc<Env>;

#[derive(Debug)]
pub(crate) struct DecodedEnvironmentIdentity;

#[derive(Default)]
pub struct DeferredDemands {
    executions: Vec<DeferredExecutionDemands>,
}

struct DeferredExecutionDemands {
    execution: Weak<()>,
    blocks: Vec<Option<usize>>,
}

impl DeferredDemands {
    pub(crate) fn blocks_for(&mut self, execution: &Rc<()>) -> &mut Vec<Option<usize>> {
        self.executions
            .retain(|demands| demands.execution.strong_count() > 0);
        let execution = Rc::downgrade(execution);
        let index = self
            .executions
            .iter()
            .position(|demands| Weak::ptr_eq(&demands.execution, &execution))
            .unwrap_or_else(|| {
                self.executions.push(DeferredExecutionDemands {
                    execution,
                    blocks: Vec::new(),
                });
                self.executions.len() - 1
            });
        &mut self.executions[index].blocks
    }
}

pub(crate) fn closure_signature(value: &Value) -> Option<Value> {
    let Value::Closure { signature, .. } = value else {
        return None;
    };
    signature.as_deref().cloned()
}

pub(crate) fn attach_signature(value: &mut Value, signature: &Value) {
    let complete_signature = signature;
    let signature = match complete_signature {
        Value::Forall { body, .. } => body.as_ref(),
        signature => signature,
    };
    if matches!(value, Value::Array(elements) if elements.is_empty())
        && let Value::Array(elements) = signature
        && let Some(element) = elements.first()
    {
        *value = Value::EmptyArray {
            element: Box::new(element.clone()),
        };
        return;
    }
    match (value, signature) {
        (
            Value::Closure {
                signature: closure_signature,
                ..
            },
            Value::Arrow { .. },
        ) => {
            let relates_input_to_output = closure_signature
                .as_deref()
                .is_some_and(has_quantified_input_output_relationship);
            if !relates_input_to_output {
                *closure_signature = Some(Box::new(complete_signature.clone()));
            }
        }
        (Value::Shape(values), Value::Shape(signatures)) => {
            let values = Rc::make_mut(&mut values.0);
            for (name, value) in &mut values.entries {
                if let Some(signature) = signatures.get(name) {
                    attach_signature(value, signature);
                }
            }
        }
        (Value::Array(values), Value::Array(signatures)) => {
            for (value, signature) in values.iter_mut_preserving_identity().zip(signatures) {
                attach_signature(value, signature);
            }
        }
        (
            Value::Tag {
                payload: Some(value),
                ..
            },
            Value::Tag {
                payload: Some(signature),
                ..
            },
        ) => attach_signature(value, signature),
        (
            Value::Extended {
                inner: value_inner,
                members: value_members,
            },
            Value::Extended {
                inner: signature_inner,
                members: signature_members,
            },
        ) => {
            attach_signature(value_inner, signature_inner);
            let values = Rc::make_mut(&mut value_members.0);
            for (name, value) in &mut values.entries {
                if let Some(signature) = signature_members.get(name) {
                    attach_signature(value, signature);
                }
            }
        }
        (
            Value::Sealed {
                inner: value_inner, ..
            },
            Value::Sealed {
                inner: signature_inner,
                ..
            },
        ) => attach_signature(value_inner, signature_inner),
        (Value::Extended { inner, .. }, signature) | (Value::Sealed { inner, .. }, signature) => {
            attach_signature(inner, signature)
        }
        _ => {}
    }
}

fn has_quantified_input_output_relationship(signature: &Value) -> bool {
    let mut quantified = BTreeSet::new();
    let mut body = signature;
    while let Value::Forall {
        variable,
        body: nested,
    } = body
    {
        quantified.insert(*variable);
        body = nested;
    }
    let Value::Arrow {
        domain, codomain, ..
    } = body
    else {
        return false;
    };
    let mut input = BTreeSet::new();
    let mut output = BTreeSet::new();
    collect_type_variables(domain, &mut input);
    collect_type_variables(codomain, &mut output);
    quantified
        .into_iter()
        .any(|variable| input.contains(&variable) && output.contains(&variable))
}

#[derive(Debug)]
pub struct Env {
    pub names: RefCell<BTreeMap<String, Value>>,
    pub opens: RefCell<Vec<OpenedValues>>,
    pub signatures: RefCell<BTreeMap<String, Value>>,
    pub type_substitutions: RefCell<BTreeMap<u32, Value>>,
    pub parent: RefCell<Option<Environment>>,
    pub(crate) recursive_bindings: Option<Rc<RecursiveBindings>>,
    decoded_identity: Option<Rc<DecodedEnvironmentIdentity>>,
    captured: Cell<bool>,
}

pub fn child_env(parent: Option<Environment>) -> Environment {
    child_env_with_identity(parent, None)
}

pub(crate) fn decoded_child_env(
    parent: Option<Environment>,
    identity: Rc<DecodedEnvironmentIdentity>,
) -> Environment {
    child_env_with_identity(parent, Some(identity))
}

fn child_env_with_identity(
    parent: Option<Environment>,
    decoded_identity: Option<Rc<DecodedEnvironmentIdentity>>,
) -> Environment {
    Rc::new(Env {
        names: RefCell::new(BTreeMap::new()),
        opens: RefCell::new(Vec::new()),
        signatures: RefCell::new(BTreeMap::new()),
        type_substitutions: RefCell::new(BTreeMap::new()),
        parent: RefCell::new(parent),
        recursive_bindings: None,
        decoded_identity,
        captured: Cell::new(false),
    })
}

pub(crate) struct RecursiveBindings {
    environment: RefCell<Weak<Env>>,
    closures: RefCell<BTreeMap<String, RecursiveClosure>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecursiveBindingError {
    DuplicateName,
    NotAClosure,
    DifferentEnvironment,
    SignatureCapturesClosure,
}

impl std::fmt::Debug for RecursiveBindings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let closures = self.closures.borrow();
        formatter
            .debug_struct("RecursiveBindings")
            .field("names", &closures.keys().collect::<Vec<_>>())
            .finish()
    }
}

#[derive(Clone)]
struct RecursiveClosure {
    module: Rc<String>,
    module_instances: Rc<crate::eval::ModuleInstanceScope>,
    effect_scope: Rc<crate::eval::EffectScope>,
    parameter: PatternId,
    body: ExpressionId,
    self_name: Option<String>,
    imports: Option<BTreeMap<String, String>>,
    signature: Option<Box<Value>>,
    reuse_assertion: Option<crate::ast::Span>,
    deferred: bool,
}

impl RecursiveBindings {
    pub(crate) fn environment(&self) -> Environment {
        self.environment
            .borrow()
            .upgrade()
            .expect("a recursive group is owned by its environment")
    }

    pub(crate) fn insert(&self, name: String, value: Value) -> Result<(), RecursiveBindingError> {
        if self.closures.borrow().contains_key(&name) {
            return Err(RecursiveBindingError::DuplicateName);
        }
        if !matches!(
            &value,
            Value::Closure { environment, .. }
                if Rc::ptr_eq(environment, &self.environment())
        ) {
            return Err(RecursiveBindingError::DifferentEnvironment);
        }
        let environment = self.environment();
        if matches!(
            &value,
            Value::Closure {
                signature: Some(signature),
                ..
            } if value_references_environment(signature, &environment)
        ) {
            return Err(RecursiveBindingError::SignatureCapturesClosure);
        }
        let Value::Closure {
            module,
            module_instances,
            effect_scope,
            parameter,
            body,
            self_name,
            imports,
            signature,
            reuse_assertion,
            deferred,
            ..
        } = value
        else {
            return Err(RecursiveBindingError::NotAClosure);
        };
        self.closures.borrow_mut().insert(
            name,
            RecursiveClosure {
                module,
                module_instances,
                effect_scope,
                parameter,
                body,
                self_name,
                imports,
                signature,
                reuse_assertion,
                deferred,
            },
        );
        Ok(())
    }

    fn lookup(&self, name: &str) -> Option<Value> {
        let closure = self.closures.borrow().get(name).cloned()?;
        let environment = self.environment();
        capture_env(&environment);
        Some(closure.value(environment))
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.closures.borrow().contains_key(name)
    }

    pub(crate) fn len(&self) -> usize {
        self.closures.borrow().len()
    }

    pub(crate) fn values(&self) -> Vec<(String, Value)> {
        let environment = self.environment();
        capture_env(&environment);
        self.closures
            .borrow()
            .iter()
            .map(|(name, closure)| (name.clone(), closure.value(environment.clone())))
            .collect()
    }
}

fn value_references_environment(value: &Value, target: &Environment) -> bool {
    match value {
        Value::Closure {
            environment,
            signature,
            ..
        } => {
            environment_has_ancestor(environment, target)
                || signature
                    .as_deref()
                    .is_some_and(|value| value_references_environment(value, target))
        }
        Value::Deferred { environment, .. } => environment_has_ancestor(environment, target),
        Value::ClosureChoice { alternatives, .. } => {
            alternatives
                .iter()
                .any(|alternative| match &alternative.source {
                    ChoiceSource::Lambda {
                        environment,
                        signature,
                        ..
                    } => {
                        environment_has_ancestor(environment, target)
                            || signature
                                .as_deref()
                                .is_some_and(|value| value_references_environment(value, target))
                    }
                    ChoiceSource::Primitive { applied, .. } => applied
                        .iter()
                        .any(|value| value_references_environment(value, target)),
                })
        }
        Value::Continuation { .. } => true,
        Value::Shape(fields)
        | Value::Extended {
            members: fields, ..
        } => {
            fields
                .iter()
                .any(|(_, value)| value_references_environment(value, target))
                || matches!(value, Value::Extended { inner, .. } if value_references_environment(inner, target))
        }
        Value::Array(values) => values
            .iter()
            .any(|value| value_references_environment(value, target)),
        Value::RegionType(value)
        | Value::ScratchType(value)
        | Value::DeferredScratch { capacity: value }
        | Value::EmptyArray { element: value }
        | Value::Forall { body: value, .. }
        | Value::Sealed { inner: value, .. } => value_references_environment(value, target),
        Value::Scratch { values, .. }
        | Value::IndexedStep { elements: values }
        | Value::Union(values) => values
            .iter()
            .any(|value| value_references_environment(value, target)),
        Value::Region { .. } | Value::RegionRejoin { .. } => true,
        Value::Tag { payload, .. } => payload
            .as_deref()
            .is_some_and(|value| value_references_environment(value, target)),
        Value::Primitive { applied, .. } => applied
            .iter()
            .any(|value| value_references_environment(value, target)),
        Value::Range { low, high, .. } => {
            value_references_environment(low, target) || value_references_environment(high, target)
        }
        Value::Arrow {
            domain,
            codomain,
            effects,
            ..
        } => {
            value_references_environment(domain, target)
                || value_references_environment(codomain, target)
                || effects
                    .iter()
                    .any(|value| value_references_environment(value, target))
        }
        Value::Effect { operations, .. } => operations
            .iter()
            .any(|(_, value)| value_references_environment(value, target)),
        Value::Operation { effect, .. } => value_references_environment(effect, target),
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
        | Value::TypeVariable(_)
        | Value::OpaqueType(_)
        | Value::Runtime(_) => false,
    }
}

fn environment_has_ancestor(environment: &Environment, target: &Environment) -> bool {
    let mut scope = Some(environment.clone());
    while let Some(current) = scope {
        if Rc::ptr_eq(&current, target) {
            return true;
        }
        scope = current.parent.borrow().clone();
    }
    false
}

impl RecursiveClosure {
    fn value(&self, environment: Environment) -> Value {
        Value::Closure {
            module: self.module.clone(),
            module_instances: self.module_instances.clone(),
            effect_scope: self.effect_scope.clone(),
            parameter: self.parameter,
            body: self.body,
            environment,
            self_name: self.self_name.clone(),
            imports: self.imports.clone(),
            signature: self.signature.clone(),
            reuse_assertion: self.reuse_assertion,
            deferred: self.deferred,
        }
    }
}

pub(crate) fn recursive_env(parent: Option<Environment>) -> (Environment, Rc<RecursiveBindings>) {
    recursive_env_with_identity(parent, None)
}

pub(crate) fn decoded_recursive_env(
    parent: Option<Environment>,
    identity: Rc<DecodedEnvironmentIdentity>,
) -> (Environment, Rc<RecursiveBindings>) {
    recursive_env_with_identity(parent, Some(identity))
}

fn recursive_env_with_identity(
    parent: Option<Environment>,
    decoded_identity: Option<Rc<DecodedEnvironmentIdentity>>,
) -> (Environment, Rc<RecursiveBindings>) {
    let bindings = Rc::new(RecursiveBindings {
        environment: RefCell::new(Weak::new()),
        closures: RefCell::new(BTreeMap::new()),
    });
    let environment = Rc::new(Env {
        names: RefCell::new(BTreeMap::new()),
        opens: RefCell::new(Vec::new()),
        signatures: RefCell::new(BTreeMap::new()),
        type_substitutions: RefCell::new(BTreeMap::new()),
        parent: RefCell::new(parent),
        recursive_bindings: Some(bindings.clone()),
        decoded_identity,
        captured: Cell::new(false),
    });
    *bindings.environment.borrow_mut() = Rc::downgrade(&environment);
    (environment, bindings)
}

fn same_closure_source_environment(left: &Environment, right: &Environment) -> bool {
    match (&left.decoded_identity, &right.decoded_identity) {
        (Some(left), Some(right)) => Rc::ptr_eq(left, right),
        (None, None) => Rc::ptr_eq(left, right),
        (Some(_), None) | (None, Some(_)) => false,
    }
}

pub(crate) fn capture_env(environment: &Environment) {
    let mut scope = Some(environment.clone());
    while let Some(current) = scope {
        if current.captured.replace(true) {
            break;
        }
        scope = current.parent.borrow().clone();
    }
}

pub(crate) fn declaration_env(environment: &Environment) -> Environment {
    if environment.captured.get() || environment.recursive_bindings.is_some() {
        return child_env(Some(environment.clone()));
    }
    environment.clone()
}

pub fn lookup_signature(environment: &Environment, name: &str) -> Option<Value> {
    let mut scope = Some(environment.clone());
    while let Some(current) = scope {
        if let Some(value) = current.signatures.borrow().get(name) {
            return Some(value.clone());
        }
        scope = current.parent.borrow().clone();
    }
    None
}

pub fn lookup(environment: &Environment, name: &str) -> Option<Value> {
    let mut scope = Some(environment.clone());
    while let Some(current) = scope {
        if let Some(value) = current.names.borrow().get(name) {
            return Some(value.clone());
        }
        if let Some(value) = current
            .recursive_bindings
            .as_ref()
            .and_then(|bindings| bindings.lookup(name))
        {
            return Some(value);
        }
        for opened in current.opens.borrow().iter().rev() {
            if let Some(value) = opened.get(name) {
                return Some(value.clone());
            }
        }
        scope = current.parent.borrow().clone();
    }
    None
}

pub(crate) fn opened_members(value: &Value) -> Option<OrderedFields> {
    match value {
        Value::Shape(fields) => Some(fields.clone()),
        Value::Effect { operations, .. } => Some(
            operations
                .keys()
                .map(|name| {
                    (
                        name.clone(),
                        Value::Operation {
                            effect: Box::new(value.clone()),
                            name: name.clone(),
                        },
                    )
                })
                .collect(),
        ),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct OpenedValues {
    fields: OrderedFields,
    used: Option<Rc<RefCell<BTreeSet<String>>>>,
}

impl OpenedValues {
    pub fn new(fields: OrderedFields) -> Self {
        Self { fields, used: None }
    }

    pub(crate) fn tracked(fields: OrderedFields, used: Rc<RefCell<BTreeSet<String>>>) -> Self {
        Self {
            fields,
            used: Some(used),
        }
    }

    pub fn get(&self, target: &str) -> Option<&Value> {
        let value = self.fields.get(target)?;
        if let Some(used) = &self.used {
            used.borrow_mut().insert(target.to_owned());
        }
        Some(value)
    }

    pub(crate) fn fields(&self) -> &OrderedFields {
        &self.fields
    }
}

pub type Resume = Rc<RefCell<Option<Box<dyn FnOnce(Value) -> Computation>>>>;

/// One evaluator Store: the shared mutable backing every Region metadata
/// interval points into.
pub type RegionStore = Rc<RefCell<Vec<Value>>>;

#[derive(Clone, Debug)]
pub struct ArrayValues {
    identity: Rc<()>,
    values: Vec<Value>,
}

impl ArrayValues {
    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }

    fn iter_mut_preserving_identity(&mut self) -> std::slice::IterMut<'_, Value> {
        self.values.iter_mut()
    }
}

impl From<Vec<Value>> for ArrayValues {
    fn from(values: Vec<Value>) -> Self {
        Self {
            identity: Rc::new(()),
            values,
        }
    }
}

impl FromIterator<Value> for ArrayValues {
    fn from_iter<T: IntoIterator<Item = Value>>(values: T) -> Self {
        values.into_iter().collect::<Vec<_>>().into()
    }
}

impl Deref for ArrayValues {
    type Target = Vec<Value>;

    fn deref(&self) -> &Self::Target {
        &self.values
    }
}

impl DerefMut for ArrayValues {
    fn deref_mut(&mut self) -> &mut Self::Target {
        if Rc::strong_count(&self.identity) > 1 {
            self.identity = Rc::new(());
        }
        &mut self.values
    }
}

impl IntoIterator for ArrayValues {
    type Item = Value;
    type IntoIter = std::vec::IntoIter<Value>;

    fn into_iter(self) -> Self::IntoIter {
        self.values.into_iter()
    }
}

impl<'a> IntoIterator for &'a ArrayValues {
    type Item = &'a Value;
    type IntoIter = std::slice::Iter<'a, Value>;

    fn into_iter(self) -> Self::IntoIter {
        self.values.iter()
    }
}

impl<'a> IntoIterator for &'a mut ArrayValues {
    type Item = &'a mut Value;
    type IntoIter = std::slice::IterMut<'a, Value>;

    fn into_iter(self) -> Self::IntoIter {
        self.deref_mut().iter_mut()
    }
}

#[derive(Clone, Debug, Default)]
pub struct OrderedFields(Rc<OrderedFieldStorage>, Rc<()>);

#[derive(Clone, Debug, Default)]
struct OrderedFieldStorage {
    entries: Vec<(String, Value)>,
    positions: BTreeMap<String, usize>,
}

impl OrderedFields {
    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.1, &other.1)
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        let position = self.0.positions.get(name)?;
        Some(&self.0.entries[*position].1)
    }

    pub fn insert(&mut self, name: String, value: Value) -> Option<Value> {
        if Rc::strong_count(&self.1) > 1 {
            self.1 = Rc::new(());
        }
        let fields = Rc::make_mut(&mut self.0);
        if let Some(position) = fields.positions.get(&name) {
            return Some(std::mem::replace(&mut fields.entries[*position].1, value));
        }
        fields.positions.insert(name.clone(), fields.entries.len());
        fields.entries.push((name, value));
        None
    }

    pub fn remove(&mut self, name: &str) -> Option<Value> {
        if Rc::strong_count(&self.1) > 1 {
            self.1 = Rc::new(());
        }
        let fields = Rc::make_mut(&mut self.0);
        let position = fields.positions.remove(name)?;
        let value = fields.entries.remove(position).1;
        for index in position..fields.entries.len() {
            fields
                .positions
                .insert(fields.entries[index].0.clone(), index);
        }
        Some(value)
    }

    pub fn contains_key(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.entries.iter().map(|(name, _)| name)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.entries.iter().map(|(name, value)| (name, value))
    }

    pub fn len(&self) -> usize {
        self.0.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.entries.is_empty()
    }

    pub fn extend(&mut self, fields: OrderedFields) {
        for (name, value) in fields {
            self.insert(name, value);
        }
    }
}

impl FromIterator<(String, Value)> for OrderedFields {
    fn from_iter<T: IntoIterator<Item = (String, Value)>>(fields: T) -> Self {
        let mut ordered = Self::default();
        for (name, value) in fields {
            ordered.insert(name, value);
        }
        ordered
    }
}

impl<const N: usize> From<[(String, Value); N]> for OrderedFields {
    fn from(fields: [(String, Value); N]) -> Self {
        fields.into_iter().collect()
    }
}

impl IntoIterator for OrderedFields {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<Self::Item>;

    fn into_iter(self) -> Self::IntoIter {
        match Rc::try_unwrap(self.0) {
            Ok(fields) => fields.entries.into_iter(),
            Err(fields) => fields.entries.clone().into_iter(),
        }
    }
}

impl<'a> IntoIterator for &'a OrderedFields {
    type Item = (&'a String, &'a Value);
    type IntoIter = std::iter::Map<
        std::slice::Iter<'a, (String, Value)>,
        fn(&(String, Value)) -> (&String, &Value),
    >;

    fn into_iter(self) -> Self::IntoIter {
        fn pair(field: &(String, Value)) -> (&String, &Value) {
            (&field.0, &field.1)
        }
        self.0.entries.iter().map(pair)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectOwnership {
    Unrestricted,
    Affine,
    Linear,
    Record(BTreeMap<String, EffectOwnership>),
    Variant(BTreeMap<String, EffectOwnership>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectOperationOwnership {
    pub input: EffectOwnership,
    pub result: EffectOwnership,
}

impl EffectOperationOwnership {
    pub fn unrestricted() -> Self {
        Self {
            input: EffectOwnership::Unrestricted,
            result: EffectOwnership::Unrestricted,
        }
    }
}

#[derive(Clone)]
pub enum Value {
    Int(BigInt),
    Float(f64),
    Float32(f32),
    Vector([f32; 4]),
    VectorMask([bool; 4]),
    IntegerVector {
        bits: u8,
        lanes: Vec<i32>,
    },
    IntegerVectorMask {
        bits: u8,
        lanes: Vec<bool>,
    },
    Text(String),
    Unit,
    Shape(OrderedFields),
    Array(ArrayValues),
    /// Private type value produced only by `@region.type`.
    RegionType(Box<Value>),
    /// Private type value produced only by `@scratch.type`.
    ScratchType(Box<Value>),
    /// Affine initialized-prefix builder. Capacity is operational only; source
    /// observation can recover only `values` through `@scratch.finish`.
    Scratch {
        values: Vec<Value>,
        capacity: usize,
    },
    /// A residual empty Scratch whose element representation is fixed by its
    /// first pushed value. This is the runtime analogue of `EmptyArray`: the
    /// capacity is known, but an empty polymorphic builder has no layout yet.
    DeferredScratch {
        capacity: Box<Value>,
    },
    /// Mutable interval into one evaluator Store. Split clones only this
    /// metadata and the `Rc`; elements stay in one backing allocation.
    Region {
        store: RegionStore,
        start: usize,
        end: usize,
    },
    /// The recombination witness a successful split mints: the proof that its
    /// two parts rejoin into their parent, reified as an element-free value.
    /// `middle` is the boundary the split cut at.
    RegionRejoin {
        store: RegionStore,
        start: usize,
        middle: usize,
        end: usize,
    },
    EmptyArray {
        element: Box<Value>,
    },
    Tag {
        name: String,
        payload: Option<Box<Value>>,
    },
    Closure {
        module: Rc<String>,
        module_instances: Rc<crate::eval::ModuleInstanceScope>,
        effect_scope: Rc<crate::eval::EffectScope>,
        parameter: PatternId,
        body: ExpressionId,
        environment: Environment,
        self_name: Option<String>,
        imports: Option<BTreeMap<String, String>>,
        signature: Option<Box<Value>>,
        /// Source span of `@[assert.reuse]`, when this closure carries the
        /// cost-contract assertion. It grants no ownership permission.
        reuse_assertion: Option<crate::ast::Span>,
        /// The caller suspends the argument until the parameter is read.
        deferred: bool,
    },
    /// An argument a deferred parameter has not demanded yet. It never escapes
    /// the call it was made for: reading the parameter replaces it with the
    /// value, and reading it twice is refused.
    Deferred {
        module: Rc<String>,
        expression: ExpressionId,
        environment: Environment,
        demands: Rc<RefCell<DeferredDemands>>,
    },
    ClosureChoice {
        selector: RuntimeValue,
        alternatives: Rc<Vec<ClosureAlternative>>,
    },
    ModuleClosure {
        module: String,
    },
    IndexedStep {
        elements: Vec<Value>,
    },
    Primitive {
        name: String,
        arity: usize,
        applied: Vec<Value>,
    },
    Range {
        low: Box<Value>,
        high: Box<Value>,
        domain: Option<Domain>,
    },
    Union(Vec<Value>),
    Unbounded,
    Arrow {
        /// Whether the callee, rather than the caller, decides if the argument
        /// is evaluated.
        deferred: bool,
        domain: Box<Value>,
        codomain: Box<Value>,
        effects: Vec<Value>,
        /// Signature-local rest of an open effect row, bound by `@forall`.
        effect_tail: Option<u32>,
    },
    TypeVariable(u32),
    Forall {
        variable: u32,
        body: Box<Value>,
    },
    Effect {
        id: u32,
        name: String,
        operations: OrderedFields,
        operation_ownership: BTreeMap<String, EffectOperationOwnership>,
        host: bool,
    },
    Operation {
        effect: Box<Value>,
        name: String,
    },
    Extended {
        inner: Box<Value>,
        members: OrderedFields,
    },
    Sealed {
        name: String,
        inner: Box<Value>,
    },
    OpaqueType(String),
    Runtime(RuntimeValue),
    Continuation {
        used: Rc<RefCell<bool>>,
        resume: Resume,
    },
}

pub(crate) fn reusable_across_module_instances(value: &Value) -> bool {
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
        | Value::TypeVariable(_) => true,
        Value::Shape(fields) => fields
            .iter()
            .all(|(_, value)| reusable_across_module_instances(value)),
        Value::Array(values) => values.iter().all(reusable_across_module_instances),
        Value::Union(values) => values.iter().all(reusable_across_module_instances),
        Value::RegionType(element)
        | Value::ScratchType(element)
        | Value::DeferredScratch { capacity: element }
        | Value::EmptyArray { element }
        | Value::Forall { body: element, .. } => reusable_across_module_instances(element),
        Value::Scratch { values, .. } | Value::IndexedStep { elements: values } => {
            values.iter().all(reusable_across_module_instances)
        }
        Value::Tag { payload, .. } => payload
            .as_deref()
            .is_none_or(reusable_across_module_instances),
        Value::Primitive { applied, .. } => applied.iter().all(reusable_across_module_instances),
        Value::Range { low, high, .. } => {
            reusable_across_module_instances(low) && reusable_across_module_instances(high)
        }
        Value::Arrow {
            domain,
            codomain,
            effects,
            ..
        } => {
            reusable_across_module_instances(domain)
                && reusable_across_module_instances(codomain)
                && effects.iter().all(reusable_across_module_instances)
        }
        Value::Extended { inner, members } => {
            reusable_across_module_instances(inner)
                && members
                    .iter()
                    .all(|(_, value)| reusable_across_module_instances(value))
        }
        Value::Sealed { inner, .. } => reusable_across_module_instances(inner),
        Value::OpaqueType(name) => !name.starts_with("Effect:"),
        Value::Closure { .. }
        | Value::Deferred { .. }
        | Value::ClosureChoice { .. }
        | Value::Region { .. }
        | Value::RegionRejoin { .. }
        | Value::Effect { .. }
        | Value::Operation { .. }
        | Value::Runtime(_)
        | Value::Continuation { .. } => false,
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeValue {
    pub id: usize,
    pub type_id: usize,
    pub meaning: RuntimeMeaning,
}

/// Where one reachable function in a residual function choice comes from. A
/// lambda names its module and body; a partially applied primitive names the
/// primitive and the arguments it already holds.
#[derive(Clone)]
pub enum ChoiceSource {
    Lambda {
        module: Rc<String>,
        module_instances: Rc<crate::eval::ModuleInstanceScope>,
        effect_scope: Rc<crate::eval::EffectScope>,
        parameter: PatternId,
        body: ExpressionId,
        environment: Environment,
        self_name: Option<String>,
        signature: Option<Box<Value>>,
        reuse_assertion: Option<crate::ast::Span>,
        deferred: bool,
    },
    Primitive {
        name: String,
        arity: usize,
        applied: Vec<Value>,
    },
}

/// One reachable function in a residual function choice, normalized to its
/// stable source identity and the ordered runtime captures its branch supplied.
#[derive(Clone)]
pub struct ClosureAlternative {
    pub source: ChoiceSource,
    pub captures: Vec<RuntimeValue>,
    /// The ordered capture product itself.
    pub product_type: usize,
    /// What this alternative's case declares as its payload: the capture
    /// product, or a private indirection to it when the alternatives of one
    /// choice capture mutually incompatible layouts.
    pub payload_type: usize,
}

impl ClosureAlternative {
    /// The name this alternative's case carries in the private sum type. It
    /// identifies the source for a reader; it is not the equality relation.
    pub fn source_name(&self) -> String {
        match &self.source {
            ChoiceSource::Lambda { module, body, .. } => format!("{module}#{}", body.0),
            ChoiceSource::Primitive { name, applied, .. } => format!("{name}/{}", applied.len()),
        }
    }

    /// The signature the checker recorded for this alternative, when it
    /// recorded one.
    pub fn signature(&self) -> Option<&Value> {
        match &self.source {
            ChoiceSource::Lambda { signature, .. } => signature.as_deref(),
            ChoiceSource::Primitive { .. } => None,
        }
    }

    pub fn deferred(&self) -> bool {
        match &self.source {
            ChoiceSource::Lambda { deferred, .. } => *deferred,
            ChoiceSource::Primitive { .. } => false,
        }
    }

    /// Do two branches supply the same function? Two lambdas agree when they
    /// share a body and the very environment that body was closed in — a
    /// captured compile-time value is part of what the lambda means, and
    /// comparing bodies alone would merge `make 1` with `make 2`. Two
    /// primitives agree when they hold equal arguments. The relation is
    /// conservative in the safe direction: a missed merge widens the
    /// alternative table, it does not change what the program computes.
    pub fn same_source(&self, other: &Self) -> bool {
        match (&self.source, &other.source) {
            (
                ChoiceSource::Lambda {
                    module,
                    body,
                    environment,
                    ..
                },
                ChoiceSource::Lambda {
                    module: other_module,
                    body: other_body,
                    environment: other_environment,
                    ..
                },
            ) => {
                module == other_module
                    && body.0 == other_body.0
                    && same_closure_source_environment(environment, other_environment)
            }
            (
                ChoiceSource::Primitive {
                    name,
                    arity,
                    applied,
                },
                ChoiceSource::Primitive {
                    name: other_name,
                    arity: other_arity,
                    applied: other_applied,
                },
            ) => {
                name == other_name
                    && arity == other_arity
                    && applied.len() == other_applied.len()
                    && applied
                        .iter()
                        .zip(other_applied)
                        .all(|(left, right)| applied_equal(left, right))
            }
            _ => false,
        }
    }
}

/// `equal` refuses two residual values because it cannot see what they will
/// hold. Two references to one runtime value are still the same argument.
fn applied_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Runtime(left), Value::Runtime(right)) => {
            left.id == right.id && left.type_id == right.type_id
        }
        _ => equal(left, right),
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum RuntimeMeaning {
    #[default]
    Plain,
    SharedStore,
    ReusableStore,
    Ordering,
    ScalarOrdering {
        right: usize,
    },
    Sum {
        cases: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Domain {
    Int,
    Text,
    Float,
    Float32,
}

impl std::fmt::Debug for Value {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&show(self))
    }
}

pub fn tuple(elements: Vec<Value>) -> Value {
    Value::Shape(
        elements
            .into_iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
    )
}

pub fn as_tuple(value: &Value, arity: usize) -> Option<Vec<Value>> {
    let Value::Shape(fields) = value else {
        return None;
    };
    if fields.len() != arity {
        return None;
    }
    (0..arity)
        .map(|index| fields.get(&index.to_string()).cloned())
        .collect()
}

pub fn boolean(value: bool) -> Value {
    Value::Tag {
        name: if value { "True" } else { "False" }.to_owned(),
        payload: None,
    }
}

/// Capture-avoiding substitution over the reified type-value constructors.
///
/// Effect-row tails are the one kinded position in this representation. A
/// variable keeps the row open; one effect or an array of effects closes it.
/// Every other replacement is refused rather than creating an invalid arrow.
pub fn substitute_type_variable(
    value: &Value,
    variable: u32,
    replacement: &Value,
) -> Option<Value> {
    let substitute = |value: &Value| substitute_type_variable(value, variable, replacement);
    Some(match value {
        Value::TypeVariable(id) if *id == variable => replacement.clone(),
        Value::Shape(fields) => Value::Shape(
            fields
                .iter()
                .map(|(name, value)| Some((name.clone(), substitute(value)?)))
                .collect::<Option<OrderedFields>>()?,
        ),
        Value::Array(elements) => Value::Array(
            elements
                .iter()
                .map(substitute)
                .collect::<Option<Vec<_>>>()?
                .into(),
        ),
        Value::EmptyArray { element } => Value::EmptyArray {
            element: Box::new(substitute(element)?),
        },
        Value::RegionType(element) => Value::RegionType(Box::new(substitute(element)?)),
        Value::ScratchType(element) => Value::ScratchType(Box::new(substitute(element)?)),
        Value::DeferredScratch { capacity } => Value::DeferredScratch {
            capacity: Box::new(substitute(capacity)?),
        },
        Value::Tag { name, payload } => Value::Tag {
            name: name.clone(),
            payload: match payload.as_deref() {
                Some(payload) => Some(Box::new(substitute(payload)?)),
                None => None,
            },
        },
        Value::Range { low, high, domain } => Value::Range {
            low: Box::new(substitute(low)?),
            high: Box::new(substitute(high)?),
            domain: *domain,
        },
        Value::Union(members) => {
            Value::Union(members.iter().map(substitute).collect::<Option<Vec<_>>>()?)
        }
        Value::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => {
            let domain = Box::new(substitute(domain)?);
            let codomain = Box::new(substitute(codomain)?);
            let mut effects = effects.iter().map(substitute).collect::<Option<Vec<_>>>()?;
            if *effect_tail != Some(variable) {
                Value::Arrow {
                    deferred: *deferred,
                    domain,
                    codomain,
                    effects,
                    effect_tail: *effect_tail,
                }
            } else {
                let mut row_replacement = replacement;
                while let Value::Extended { inner, .. } = row_replacement {
                    row_replacement = inner;
                }
                let replacement_tail = if let Value::TypeVariable(id) = row_replacement {
                    Some(*id)
                } else {
                    let additional = match row_replacement {
                        Value::Effect { .. } => vec![row_replacement.clone()],
                        Value::Array(members)
                            if members
                                .iter()
                                .all(|member| matches!(member, Value::Effect { .. })) =>
                        {
                            members.to_vec()
                        }
                        _ => return None,
                    };
                    for effect in additional {
                        if !effects.iter().any(|seen| equal(seen, &effect)) {
                            effects.push(effect);
                        }
                    }
                    None
                };
                Value::Arrow {
                    deferred: *deferred,
                    domain,
                    codomain,
                    effects,
                    effect_tail: replacement_tail,
                }
            }
        }
        Value::Forall {
            variable: bound,
            body,
        } if *bound != variable => Value::Forall {
            variable: *bound,
            body: Box::new(substitute(body)?),
        },
        Value::Effect {
            id,
            name,
            operations,
            operation_ownership,
            host,
        } => Value::Effect {
            id: *id,
            name: name.clone(),
            operations: operations
                .iter()
                .map(|(name, value)| Some((name.clone(), substitute(value)?)))
                .collect::<Option<OrderedFields>>()?,
            operation_ownership: operation_ownership.clone(),
            host: *host,
        },
        Value::Operation { effect, name } => Value::Operation {
            effect: Box::new(substitute(effect)?),
            name: name.clone(),
        },
        Value::Extended { inner, members } => Value::Extended {
            inner: Box::new(substitute(inner)?),
            members: members
                .iter()
                .map(|(name, value)| Some((name.clone(), substitute(value)?)))
                .collect::<Option<OrderedFields>>()?,
        },
        Value::Sealed { name, inner } => Value::Sealed {
            name: name.clone(),
            inner: Box::new(substitute(inner)?),
        },
        _ => value.clone(),
    })
}

fn collect_type_variables(value: &Value, variables: &mut BTreeSet<u32>) {
    match value {
        Value::TypeVariable(variable) => {
            variables.insert(*variable);
        }
        Value::Shape(fields) => {
            for (_, member) in fields {
                collect_type_variables(member, variables);
            }
        }
        Value::Array(members) => {
            for member in members {
                collect_type_variables(member, variables);
            }
        }
        Value::Union(members) => {
            for member in members {
                collect_type_variables(member, variables);
            }
        }
        Value::RegionType(element)
        | Value::ScratchType(element)
        | Value::EmptyArray { element } => {
            collect_type_variables(element, variables);
        }
        Value::DeferredScratch { capacity } => {
            collect_type_variables(capacity, variables);
        }
        Value::Tag {
            payload: Some(payload),
            ..
        } => collect_type_variables(payload, variables),
        Value::Range { low, high, .. } => {
            collect_type_variables(low, variables);
            collect_type_variables(high, variables);
        }
        Value::Arrow {
            domain,
            codomain,
            effects,
            effect_tail,
            ..
        } => {
            collect_type_variables(domain, variables);
            collect_type_variables(codomain, variables);
            for effect in effects {
                collect_type_variables(effect, variables);
            }
            if let Some(tail) = effect_tail {
                variables.insert(*tail);
            }
        }
        Value::Forall { variable, body } => {
            variables.insert(*variable);
            collect_type_variables(body, variables);
        }
        Value::Effect { operations, .. } => {
            for (_, operation) in operations {
                collect_type_variables(operation, variables);
            }
        }
        Value::Operation { effect, .. } => collect_type_variables(effect, variables),
        Value::Extended { inner, members } => {
            collect_type_variables(inner, variables);
            for (_, member) in members {
                collect_type_variables(member, variables);
            }
        }
        Value::Sealed { inner, .. } => collect_type_variables(inner, variables),
        _ => {}
    }
}

fn fresh_type_variable(left: &Value, right: &Value) -> u32 {
    let mut variables = BTreeSet::new();
    collect_type_variables(left, &mut variables);
    collect_type_variables(right, &mut variables);
    (0..u32::MAX)
        .find(|candidate| !variables.contains(candidate))
        .expect("a finite type value cannot contain every type-variable identity")
}

fn range_domain(value: &Value) -> Option<Domain> {
    let Value::Range { low, high, domain } = value else {
        return None;
    };
    Some(domain.unwrap_or_else(|| {
        if matches!(low.as_ref(), Value::Text(_)) || matches!(high.as_ref(), Value::Text(_)) {
            Domain::Text
        } else {
            Domain::Int
        }
    }))
}

pub fn equal(left: &Value, right: &Value) -> bool {
    if let Value::Extended { inner, .. } = left {
        return equal(inner, right);
    }
    if let Value::Extended { inner, .. } = right {
        return equal(left, inner);
    }
    match (left, right) {
        (Value::Int(left), Value::Int(right)) => left == right,
        (Value::Float(left), Value::Float(right)) => left.to_bits() == right.to_bits(),
        (Value::Float32(left), Value::Float32(right)) => left.to_bits() == right.to_bits(),
        (Value::Vector(left), Value::Vector(right)) => left
            .iter()
            .zip(right)
            .all(|(left, right)| left.to_bits() == right.to_bits()),
        (Value::VectorMask(left), Value::VectorMask(right)) => left == right,
        (
            Value::IntegerVector {
                bits: left_bits,
                lanes: left,
            },
            Value::IntegerVector {
                bits: right_bits,
                lanes: right,
            },
        ) => left_bits == right_bits && left == right,
        (
            Value::IntegerVectorMask {
                bits: left_bits,
                lanes: left,
            },
            Value::IntegerVectorMask {
                bits: right_bits,
                lanes: right,
            },
        ) => left_bits == right_bits && left == right,
        (Value::Text(left), Value::Text(right)) => left == right,
        (Value::Unit, Value::Unit) | (Value::Unbounded, Value::Unbounded) => true,
        (Value::Shape(left), Value::Shape(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(name, value)| right.get(name).is_some_and(|other| equal(value, other)))
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equal(left, right))
        }
        (Value::Union(left), Value::Union(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|left| right.iter().any(|right| equal(left, right)))
        }
        (Value::RegionType(left), Value::RegionType(right)) => equal(left, right),
        (Value::ScratchType(left), Value::ScratchType(right)) => equal(left, right),
        (
            Value::Scratch {
                values: left_values,
                capacity: left_capacity,
            },
            Value::Scratch {
                values: right_values,
                capacity: right_capacity,
            },
        ) => {
            left_capacity == right_capacity
                && left_values.len() == right_values.len()
                && left_values
                    .iter()
                    .zip(right_values)
                    .all(|(left, right)| equal(left, right))
        }
        (
            Value::Region {
                store: left_store,
                start: left_start,
                end: left_end,
            },
            Value::Region {
                store: right_store,
                start: right_start,
                end: right_end,
            },
        ) => {
            Rc::ptr_eq(left_store, right_store)
                && left_start == right_start
                && left_end == right_end
        }
        (
            Value::RegionRejoin {
                store: left_store,
                start: left_start,
                middle: left_middle,
                end: left_end,
            },
            Value::RegionRejoin {
                store: right_store,
                start: right_start,
                middle: right_middle,
                end: right_end,
            },
        ) => {
            Rc::ptr_eq(left_store, right_store)
                && left_start == right_start
                && left_middle == right_middle
                && left_end == right_end
        }
        (Value::EmptyArray { .. }, Value::EmptyArray { .. }) => true,
        (Value::EmptyArray { .. }, Value::Array(right))
        | (Value::Array(right), Value::EmptyArray { .. }) => right.is_empty(),
        (
            Value::DeferredScratch {
                capacity: left_capacity,
            },
            Value::DeferredScratch {
                capacity: right_capacity,
            },
        ) => equal(left_capacity, right_capacity),
        (
            Value::Tag {
                name: left_name,
                payload: left_payload,
            },
            Value::Tag {
                name: right_name,
                payload: right_payload,
            },
        ) => {
            left_name == right_name
                && match (left_payload, right_payload) {
                    (None, None) => true,
                    (Some(left), Some(right)) => equal(left, right),
                    _ => false,
                }
        }
        (
            Value::Range {
                low: left_low,
                high: left_high,
                ..
            },
            Value::Range {
                low: right_low,
                high: right_high,
                ..
            },
        ) => {
            range_domain(left) == range_domain(right)
                && equal(left_low, right_low)
                && equal(left_high, right_high)
        }
        (
            Value::Arrow {
                deferred: left_deferred,
                domain: left_domain,
                codomain: left_codomain,
                effects: left_effects,
                effect_tail: left_tail,
            },
            Value::Arrow {
                deferred: right_deferred,
                domain: right_domain,
                codomain: right_codomain,
                effects: right_effects,
                effect_tail: right_tail,
            },
        ) => {
            left_deferred == right_deferred
                && equal(left_domain, right_domain)
                && equal(left_codomain, right_codomain)
                && left_tail == right_tail
                && left_effects.len() == right_effects.len()
                && left_effects
                    .iter()
                    .all(|left| right_effects.iter().any(|right| equal(left, right)))
        }
        (Value::TypeVariable(left), Value::TypeVariable(right)) => left == right,
        (
            Value::Forall {
                variable: left_variable,
                body: left_body,
            },
            Value::Forall {
                variable: right_variable,
                body: right_body,
            },
        ) => {
            let variable = fresh_type_variable(left_body, right_body);
            let replacement = Value::TypeVariable(variable);
            substitute_type_variable(left_body, *left_variable, &replacement)
                .zip(substitute_type_variable(
                    right_body,
                    *right_variable,
                    &replacement,
                ))
                .is_some_and(|(left, right)| equal(&left, &right))
        }
        (Value::Effect { id: left, .. }, Value::Effect { id: right, .. }) => left == right,
        (
            Value::Operation {
                effect: left,
                name: left_name,
            },
            Value::Operation {
                effect: right,
                name: right_name,
            },
        ) => left_name == right_name && effect_id(left) == effect_id(right),
        (
            Value::Sealed {
                name: left_name,
                inner: left_inner,
            },
            Value::Sealed {
                name: right_name,
                inner: right_inner,
            },
        ) => left_name == right_name && equal(left_inner, right_inner),
        (Value::OpaqueType(left), Value::OpaqueType(right)) => left == right,
        _ => false,
    }
}

fn effect_id(value: &Value) -> Option<u32> {
    match value {
        Value::Effect { id, .. } => Some(*id),
        _ => None,
    }
}

#[cfg(test)]
mod type_value_tests {
    use super::*;

    fn identity(variable: u32) -> Value {
        Value::Forall {
            variable,
            body: Box::new(Value::Arrow {
                deferred: false,
                domain: Box::new(Value::TypeVariable(variable)),
                codomain: Box::new(Value::TypeVariable(variable)),
                effects: Vec::new(),
                effect_tail: None,
            }),
        }
    }

    #[test]
    fn decoded_closure_sources_use_semantic_environment_identity() {
        let identity = Rc::new(DecodedEnvironmentIdentity);
        let first = decoded_child_env(None, identity.clone());
        let repeated = decoded_child_env(None, identity);
        let different = decoded_child_env(None, Rc::new(DecodedEnvironmentIdentity));
        let ordinary = child_env(None);

        assert!(same_closure_source_environment(&first, &repeated));
        assert!(!same_closure_source_environment(&first, &different));
        assert!(!same_closure_source_environment(&first, &ordinary));
        assert!(same_closure_source_environment(&ordinary, &ordinary));
        assert!(!same_closure_source_environment(
            &ordinary,
            &child_env(None)
        ));
    }

    #[test]
    fn enclosing_values_do_not_degrade_a_closure_signature() {
        let mut closure = Value::Closure {
            module: Rc::new("test.blot".to_owned()),
            module_instances: Rc::new(Vec::new()),
            effect_scope: Rc::new(Vec::new()),
            parameter: PatternId(0),
            body: ExpressionId(0),
            environment: child_env(None),
            self_name: None,
            imports: None,
            signature: None,
            reuse_assertion: None,
            deferred: false,
        };
        let principal = identity(7);
        attach_signature(&mut closure, &principal);
        attach_signature(
            &mut closure,
            &Value::Arrow {
                deferred: false,
                domain: Box::new(Value::Unbounded),
                codomain: Box::new(Value::Unbounded),
                effects: Vec::new(),
                effect_tail: None,
            },
        );

        let attached = closure_signature(&closure).expect("the closure retains a signature");
        assert!(equal(&attached, &principal));
    }

    #[test]
    fn recursive_bindings_reject_signatures_that_capture_their_group() {
        let (environment, bindings) = recursive_env(None);
        let captured = Value::Closure {
            module: Rc::new("test.blot".to_owned()),
            module_instances: Rc::new(Vec::new()),
            effect_scope: Rc::new(Vec::new()),
            parameter: PatternId(0),
            body: ExpressionId(0),
            environment: environment.clone(),
            self_name: None,
            imports: None,
            signature: None,
            reuse_assertion: None,
            deferred: false,
        };
        let member = Value::Closure {
            module: Rc::new("test.blot".to_owned()),
            module_instances: Rc::new(Vec::new()),
            effect_scope: Rc::new(Vec::new()),
            parameter: PatternId(1),
            body: ExpressionId(1),
            environment,
            self_name: Some("loop".to_owned()),
            imports: None,
            signature: Some(Box::new(captured)),
            reuse_assertion: None,
            deferred: false,
        };

        assert!(bindings.insert("loop".to_owned(), member).is_err());
    }

    #[test]
    fn quantified_equality_is_alpha_equivalent() {
        assert!(equal(&identity(1), &identity(99)));
    }

    #[test]
    fn quantified_equality_does_not_capture_a_free_variable() {
        let free_zero = Value::Forall {
            variable: 1,
            body: Box::new(Value::TypeVariable(0)),
        };
        let bound_zero = Value::Forall {
            variable: 0,
            body: Box::new(Value::TypeVariable(0)),
        };
        assert!(!equal(&free_zero, &bound_zero));
    }

    #[test]
    fn instantiation_substitutes_an_arrow_without_leaking_the_binder() {
        let Value::Forall { variable, body } = identity(7) else {
            unreachable!()
        };
        let instantiated =
            substitute_type_variable(&body, variable, &Value::OpaqueType("T".into()))
                .expect("a type argument is valid in an ordinary arrow");
        assert!(equal(
            &instantiated,
            &Value::Arrow {
                deferred: false,
                domain: Box::new(Value::OpaqueType("T".into())),
                codomain: Box::new(Value::OpaqueType("T".into())),
                effects: Vec::new(),
                effect_tail: None,
            }
        ));
    }

    #[test]
    fn range_equality_normalizes_an_implicit_integer_domain() {
        let low = Box::new(Value::Int(0.into()));
        let high = Box::new(Value::Int(10.into()));
        assert!(equal(
            &Value::Range {
                low: low.clone(),
                high: high.clone(),
                domain: None,
            },
            &Value::Range {
                low,
                high,
                domain: Some(Domain::Int),
            }
        ));
    }

    #[test]
    fn effect_row_instantiation_closes_only_with_effects() {
        let body = Value::Arrow {
            deferred: false,
            domain: Box::new(Value::Unit),
            codomain: Box::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: Some(7),
        };
        let effect = Value::Effect {
            id: 1,
            name: "Console".into(),
            operations: OrderedFields::default(),
            operation_ownership: BTreeMap::new(),
            host: true,
        };
        assert!(equal(
            &substitute_type_variable(&body, 7, &effect)
                .expect("an effect closes an effect-row tail"),
            &Value::Arrow {
                deferred: false,
                domain: Box::new(Value::Unit),
                codomain: Box::new(Value::Unit),
                effects: vec![effect],
                effect_tail: None,
            }
        ));
        assert!(substitute_type_variable(&body, 7, &Value::Int(0.into())).is_none());
    }
}

pub fn show(value: &Value) -> String {
    match value {
        Value::Deferred { .. } => "<deferred>".to_owned(),
        Value::Int(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::Float32(value) => format!("{value}f32"),
        Value::Vector(lanes) => format!("<{:?}>", lanes),
        Value::VectorMask(lanes) => format!("mask<{:?}>", lanes),
        Value::IntegerVector { bits, lanes } => format!("i{bits}x{}<{lanes:?}>", lanes.len()),
        Value::IntegerVectorMask { bits, lanes } => {
            format!("i{bits}x{}-mask<{lanes:?}>", lanes.len())
        }
        Value::Text(value) => format!("{value:?}"),
        Value::Unit => "()".to_owned(),
        Value::Shape(fields) => {
            let tuple = fields
                .keys()
                .enumerate()
                .all(|(index, name)| name == &index.to_string());
            if tuple && !fields.is_empty() {
                let values = fields
                    .iter()
                    .map(|(_, value)| show(value))
                    .collect::<Vec<_>>();
                if values.len() == 1 {
                    return format!("({},)", values[0]);
                }
                return format!("({})", values.join(", "));
            }
            let fields = fields
                .iter()
                .map(|(name, value)| format!(".{name} = {}", show(value)))
                .collect::<Vec<_>>()
                .join("; ");
            if fields.is_empty() {
                "{ }".to_owned()
            } else {
                format!("{{ {fields}; }}")
            }
        }
        Value::Array(elements) => {
            let elements = elements
                .iter()
                .map(|element| {
                    let shown = show(element);
                    if matches!(element, Value::Union(_)) {
                        format!("({shown})")
                    } else {
                        shown
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("[{elements}]")
        }
        Value::RegionType(element) => format!("Region {}", show(element)),
        Value::ScratchType(element) => format!("Scratch {}", show(element)),
        Value::Scratch { values, capacity } => {
            format!("<scratch {}/{}>", values.len(), capacity)
        }
        Value::DeferredScratch { .. } => "<scratch empty>".to_owned(),
        Value::Region { start, end, .. } => format!("<region {start}..{end}>"),
        Value::RegionRejoin {
            start, middle, end, ..
        } => {
            format!("<rejoin {start}..{middle}..{end}>")
        }
        Value::EmptyArray { .. } => "[]".to_owned(),
        Value::Tag { name, payload } => match payload {
            Some(payload) => format!("#{name} {}", show(payload)),
            None => format!("#{name}"),
        },
        Value::Closure { .. } | Value::ModuleClosure { .. } | Value::IndexedStep { .. } => {
            "<function>".to_owned()
        }
        Value::ClosureChoice { alternatives, .. } => {
            format!("<function choice of {}>", alternatives.len())
        }
        Value::Primitive { name, .. } => format!("<primitive {name}>"),
        Value::Range { low, high, domain } => {
            if !matches!(low.as_ref(), Value::Unbounded) && equal(low, high) {
                return show(low);
            }
            if matches!(low.as_ref(), Value::Unbounded) && matches!(high.as_ref(), Value::Unbounded)
            {
                return match domain {
                    Some(Domain::Text) => "Text".to_owned(),
                    Some(Domain::Float) => "F64".to_owned(),
                    Some(Domain::Float32) => "F32".to_owned(),
                    Some(Domain::Int) | None => "..".to_owned(),
                };
            }
            format!("{}..{}", show(low), show(high))
        }
        Value::Union(members) => members.iter().map(show).collect::<Vec<_>>().join(" | "),
        Value::Unbounded => "..".to_owned(),
        Value::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => {
            let mut parts = effects.iter().map(show).collect::<Vec<_>>();
            if let Some(tail) = effect_tail {
                parts.push(format!("..'t{tail}"));
            }
            let row = if parts.is_empty() {
                String::new()
            } else {
                format!(" ~ {{ {} }}", parts.join(", "))
            };
            let arrow = if *deferred { " ~> " } else { " -> " };
            format!("{}{arrow}{}{row}", show(domain), show(codomain))
        }
        Value::TypeVariable(id) => format!("'t{id}"),
        Value::Forall { variable, body } => format!("forall 't{variable}. {}", show(body)),
        Value::Effect { name, .. } => format!("<effect {name}>"),
        Value::Operation { name, .. } => format!("<operation {name}>"),
        Value::Extended { inner, .. } => show(inner),
        Value::Sealed { name, inner } => format!("{name} {}", show(inner)),
        Value::OpaqueType(name) => name.clone(),
        Value::Runtime(value) => format!("<runtime value {}>", value.id),
        Value::Continuation { .. } => "<continuation>".to_owned(),
    }
}

#[cfg(test)]
mod show_tests {
    use super::*;

    #[test]
    fn source_values_keep_the_public_display_spelling() {
        assert_eq!(
            show(&Value::Shape(OrderedFields::from([
                ("x".to_owned(), Value::Int(1.into())),
                ("y".to_owned(), Value::Text("two".to_owned())),
            ]))),
            "{ .x = 1; .y = \"two\"; }"
        );
        assert_eq!(
            show(&tuple(vec![Value::Int(1.into()), Value::Int(2.into())])),
            "(1, 2)"
        );
        assert_eq!(
            show(&Value::Range {
                low: Box::new(Value::Int(1.into())),
                high: Box::new(Value::Int(1.into())),
                domain: Some(Domain::Int),
            }),
            "1"
        );
        assert_eq!(
            show(&Value::Range {
                low: Box::new(Value::Unbounded),
                high: Box::new(Value::Unbounded),
                domain: Some(Domain::Text),
            }),
            "Text"
        );
        assert_eq!(
            show(&Value::Sealed {
                name: "Meters".to_owned(),
                inner: Box::new(Value::Int(3.into())),
            }),
            "Meters 3"
        );
    }
}
