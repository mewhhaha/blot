use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use num_bigint::BigInt;

use crate::ast::{ExpressionId, PatternId};
use crate::eval::Computation;

pub type Environment = Rc<Env>;

pub(crate) fn closure_signature(value: &Value) -> Option<Value> {
    let Value::Closure { signature, .. } = value else {
        return None;
    };
    signature.as_deref().cloned()
}

pub(crate) fn attach_signature(value: &mut Value, signature: &Value) {
    let signature = match signature {
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
            *closure_signature = Some(Box::new(signature.clone()));
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
            for (value, signature) in values.iter_mut().zip(signatures) {
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

#[derive(Debug)]
pub struct Env {
    pub names: RefCell<BTreeMap<String, Value>>,
    pub opens: RefCell<Vec<OpenedValues>>,
    pub signatures: RefCell<BTreeMap<String, Value>>,
    pub type_substitutions: RefCell<BTreeMap<u32, Value>>,
    pub parent: Option<Environment>,
}

pub fn child_env(parent: Option<Environment>) -> Environment {
    Rc::new(Env {
        names: RefCell::new(BTreeMap::new()),
        opens: RefCell::new(Vec::new()),
        signatures: RefCell::new(BTreeMap::new()),
        type_substitutions: RefCell::new(BTreeMap::new()),
        parent,
    })
}

pub fn lookup_signature(environment: &Environment, name: &str) -> Option<Value> {
    let mut scope = Some(environment.clone());
    while let Some(current) = scope {
        if let Some(value) = current.signatures.borrow().get(name) {
            return Some(value.clone());
        }
        scope = current.parent.clone();
    }
    None
}

pub fn lookup(environment: &Environment, name: &str) -> Option<Value> {
    let mut scope = Some(environment.clone());
    while let Some(current) = scope {
        if let Some(value) = current.names.borrow().get(name) {
            return Some(value.clone());
        }
        for opened in current.opens.borrow().iter().rev() {
            if let Some(value) = opened.get(name) {
                return Some(value.clone());
            }
        }
        scope = current.parent.clone();
    }
    None
}

#[derive(Clone, Debug)]
pub struct OpenedValues {
    fields: OrderedFields,
    sources_by_target: Rc<BTreeMap<String, String>>,
}

impl OpenedValues {
    pub fn new(fields: OrderedFields, sources_by_target: BTreeMap<String, String>) -> Self {
        Self {
            fields,
            sources_by_target: Rc::new(sources_by_target),
        }
    }

    pub fn get(&self, target: &str) -> Option<&Value> {
        let source = self.sources_by_target.get(target)?;
        self.fields.get(source)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.sources_by_target
            .iter()
            .filter_map(|(target, source)| self.fields.get(source).map(|value| (target, value)))
    }
}

pub type Resume = Rc<RefCell<Option<Box<dyn FnOnce(Value) -> Computation>>>>;

#[derive(Clone, Debug, Default)]
pub struct OrderedFields(Rc<OrderedFieldStorage>);

#[derive(Clone, Debug, Default)]
struct OrderedFieldStorage {
    entries: Vec<(String, Value)>,
    positions: BTreeMap<String, usize>,
}

impl OrderedFields {
    pub fn get(&self, name: &str) -> Option<&Value> {
        let position = self.0.positions.get(name)?;
        Some(&self.0.entries[*position].1)
    }

    pub fn insert(&mut self, name: String, value: Value) -> Option<Value> {
        let fields = Rc::make_mut(&mut self.0);
        if let Some(position) = fields.positions.get(&name) {
            return Some(std::mem::replace(&mut fields.entries[*position].1, value));
        }
        fields.positions.insert(name.clone(), fields.entries.len());
        fields.entries.push((name, value));
        None
    }

    pub fn remove(&mut self, name: &str) -> Option<Value> {
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
    Array(Vec<Value>),
    /// Private type value produced only by `@region.array.type`.
    RegionType(Box<Value>),
    /// Mutable interval into one evaluator Store. Split clones only this
    /// metadata and the `Rc`; elements stay in one backing allocation.
    Region {
        store: Rc<RefCell<Vec<Value>>>,
        start: usize,
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
        parameter: PatternId,
        body: ExpressionId,
        environment: Environment,
        self_name: Option<String>,
        imports: Option<BTreeMap<String, String>>,
        signature: Option<Box<Value>>,
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
        domain: Box<Value>,
        codomain: Box<Value>,
        effects: Vec<Value>,
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
        parameter: PatternId,
        body: ExpressionId,
        environment: Environment,
        self_name: Option<String>,
        signature: Option<Box<Value>>,
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
                    && Rc::ptr_eq(environment, other_environment)
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

#[derive(Clone, Debug, Default)]
pub enum RuntimeMeaning {
    #[default]
    Plain,
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

pub fn equal(left: &Value, right: &Value) -> bool {
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
        (Value::Array(left), Value::Array(right)) | (Value::Union(left), Value::Union(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equal(left, right))
        }
        (Value::RegionType(left), Value::RegionType(right)) => equal(left, right),
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
        (Value::EmptyArray { .. }, Value::EmptyArray { .. }) => true,
        (Value::EmptyArray { .. }, Value::Array(right))
        | (Value::Array(right), Value::EmptyArray { .. }) => right.is_empty(),
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
                domain: left_domain,
            },
            Value::Range {
                low: right_low,
                high: right_high,
                domain: right_domain,
            },
        ) => {
            left_domain == right_domain
                && equal(left_low, right_low)
                && equal(left_high, right_high)
        }
        (
            Value::Arrow {
                domain: left_domain,
                codomain: left_codomain,
                effects: left_effects,
            },
            Value::Arrow {
                domain: right_domain,
                codomain: right_codomain,
                effects: right_effects,
            },
        ) => {
            equal(left_domain, right_domain)
                && equal(left_codomain, right_codomain)
                && left_effects.len() == right_effects.len()
                && left_effects
                    .iter()
                    .zip(right_effects)
                    .all(|(left, right)| equal(left, right))
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
        ) => left_variable == right_variable && equal(left_body, right_body),
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
            Value::Extended {
                inner: left_inner,
                members: left_members,
            },
            Value::Extended {
                inner: right_inner,
                members: right_members,
            },
        ) => {
            equal(left_inner, right_inner)
                && left_members.len() == right_members.len()
                && left_members.iter().all(|(name, value)| {
                    right_members
                        .get(name)
                        .is_some_and(|other| equal(value, other))
                })
        }
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

pub fn show(value: &Value) -> String {
    match value {
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
            let fields = fields
                .iter()
                .map(|(name, value)| format!(".{name} = {}", show(value)))
                .collect::<Vec<_>>()
                .join("; ");
            format!("{{ {fields} }}")
        }
        Value::Array(elements) => format!(
            "[{}]",
            elements.iter().map(show).collect::<Vec<_>>().join(", ")
        ),
        Value::RegionType(element) => format!("Region {}", show(element)),
        Value::Region { start, end, .. } => format!("<region {start}..{end}>"),
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
        Value::Range { low, high, .. } => format!("{}..{}", show(low), show(high)),
        Value::Union(members) => members.iter().map(show).collect::<Vec<_>>().join(" | "),
        Value::Unbounded => "..".to_owned(),
        Value::Arrow {
            domain,
            codomain,
            effects,
        } => {
            let row = if effects.is_empty() {
                String::new()
            } else {
                format!(
                    " ~ {{ {} }}",
                    effects.iter().map(show).collect::<Vec<_>>().join(", ")
                )
            };
            format!("{} -> {}{row}", show(domain), show(codomain))
        }
        Value::TypeVariable(id) => format!("'t{id}"),
        Value::Forall { variable, body } => format!("forall 't{variable}. {}", show(body)),
        Value::Effect { name, .. } => format!("<effect {name}>"),
        Value::Operation { name, .. } => format!("<operation {name}>"),
        Value::Extended { inner, .. } => show(inner),
        Value::Sealed { name, inner } => format!("{name}({})", show(inner)),
        Value::OpaqueType(name) => name.clone(),
        Value::Runtime(value) => format!("<runtime value {}>", value.id),
        Value::Continuation { .. } => "<continuation>".to_owned(),
    }
}
