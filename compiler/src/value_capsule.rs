use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::ast::{ExpressionId, PatternId, Span};
use crate::value::{Domain, Environment, OpenedValues, OrderedFields, Value, child_env};

const VALUE_CAPSULE_SCHEMA: u32 = 2;

#[derive(Deserialize, Serialize)]
pub(crate) struct ValueCapsule {
    schema: u32,
    environments: Vec<CapsuleEnvironment>,
    root: u32,
}

#[derive(Deserialize, Serialize)]
struct CapsuleEnvironment {
    parent: Option<u32>,
    names: BTreeMap<String, CapsuleValue>,
    opens: Vec<Vec<(String, CapsuleValue)>>,
    type_substitutions: BTreeMap<u32, CapsuleValue>,
}

#[derive(Deserialize, Serialize)]
enum CapsuleValue {
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
    Shape(Vec<(String, CapsuleValue)>),
    Array(Vec<CapsuleValue>),
    RegionType(Box<CapsuleValue>),
    ScratchType(Box<CapsuleValue>),
    DeferredScratch {
        capacity: Box<CapsuleValue>,
    },
    EmptyArray {
        element: Box<CapsuleValue>,
    },
    Tag {
        name: String,
        payload: Option<Box<CapsuleValue>>,
    },
    Closure {
        module: CapsuleModule,
        parameter: PatternId,
        body: ExpressionId,
        environment: u32,
        self_name: Option<String>,
        imports: Option<BTreeMap<String, String>>,
        reuse_assertion: Option<Span>,
        deferred: bool,
    },
    ModuleClosure {
        module: CapsuleModule,
    },
    IndexedStep {
        elements: Vec<CapsuleValue>,
    },
    Primitive {
        name: String,
        arity: u32,
        applied: Vec<CapsuleValue>,
    },
    Range {
        low: Box<CapsuleValue>,
        high: Box<CapsuleValue>,
        domain: Option<u8>,
    },
    Union(Vec<CapsuleValue>),
    Unbounded,
    Arrow {
        deferred: bool,
        domain: Box<CapsuleValue>,
        codomain: Box<CapsuleValue>,
        effects: Vec<CapsuleValue>,
        effect_tail: Option<u32>,
    },
    TypeVariable(u32),
    Forall {
        variable: u32,
        body: Box<CapsuleValue>,
    },
    Extended {
        inner: Box<CapsuleValue>,
        members: Vec<(String, CapsuleValue)>,
    },
    Sealed {
        name: String,
        inner: Box<CapsuleValue>,
    },
    OpaqueType(String),
}

#[derive(Deserialize, Serialize)]
enum CapsuleModule {
    Local,
    External(String),
}

struct CapsuleEncoder {
    module_path: String,
    environment_ids: HashMap<usize, u32>,
    environments: Vec<Option<CapsuleEnvironment>>,
}

enum CapsuleEncodingFailure {
    Ineligible,
    Invalid(String),
}

impl ValueCapsule {
    pub(crate) fn encode(
        environment: &Environment,
        module_path: &str,
    ) -> Result<Option<Self>, String> {
        let mut encoder = CapsuleEncoder {
            module_path: module_path.to_owned(),
            environment_ids: HashMap::new(),
            environments: Vec::new(),
        };
        let root = match encoder.encode_environment(environment) {
            Ok(root) => root,
            Err(CapsuleEncodingFailure::Ineligible) => return Ok(None),
            Err(CapsuleEncodingFailure::Invalid(message)) => return Err(message),
        };
        let environments = encoder
            .environments
            .into_iter()
            .enumerate()
            .map(|(id, environment)| {
                environment.ok_or_else(|| format!("value capsule omitted environment {id}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Self {
            schema: VALUE_CAPSULE_SCHEMA,
            environments,
            root,
        }))
    }

    pub(crate) fn decode(
        &self,
        module_path: &str,
        closure_signatures: &HashMap<(String, ExpressionId), Value>,
    ) -> Result<Environment, String> {
        if self.schema != VALUE_CAPSULE_SCHEMA {
            return Err(format!(
                "value capsule has schema {}, expected {VALUE_CAPSULE_SCHEMA}",
                self.schema
            ));
        }
        self.validate_environment_graph()?;
        let environments = (0..self.environments.len())
            .map(|_| child_env(None))
            .collect::<Vec<_>>();
        for (id, encoded) in self.environments.iter().enumerate() {
            if let Some(parent) = encoded.parent {
                *environments[id].parent.borrow_mut() = Some(
                    environments
                        .get(parent as usize)
                        .ok_or_else(|| {
                            format!("value capsule environment {id} has missing parent {parent}")
                        })?
                        .clone(),
                );
            }
        }
        for (id, encoded) in self.environments.iter().enumerate() {
            let environment = &environments[id];
            *environment.names.borrow_mut() = encoded
                .names
                .iter()
                .map(|(name, value)| {
                    Ok((
                        name.clone(),
                        decode_value(value, &environments, module_path, closure_signatures)?,
                    ))
                })
                .collect::<Result<_, String>>()?;
            *environment.opens.borrow_mut() = encoded
                .opens
                .iter()
                .map(|fields| {
                    Ok(OpenedValues::new(decode_fields(
                        fields,
                        &environments,
                        module_path,
                        closure_signatures,
                    )?))
                })
                .collect::<Result<_, String>>()?;
            *environment.type_substitutions.borrow_mut() = encoded
                .type_substitutions
                .iter()
                .map(|(variable, value)| {
                    Ok((
                        *variable,
                        decode_value(value, &environments, module_path, closure_signatures)?,
                    ))
                })
                .collect::<Result<_, String>>()?;
        }
        environments
            .get(self.root as usize)
            .cloned()
            .ok_or_else(|| format!("value capsule has missing root environment {}", self.root))
    }

    fn validate_environment_graph(&self) -> Result<(), String> {
        if self.root as usize >= self.environments.len() {
            return Err(format!(
                "value capsule root environment {} is outside {} environments",
                self.root,
                self.environments.len()
            ));
        }
        for start in 0..self.environments.len() {
            let mut visited = HashSet::new();
            let mut current = Some(start as u32);
            while let Some(id) = current {
                if !visited.insert(id) {
                    return Err(format!(
                        "value capsule environment {start} has a cyclic parent chain at {id}"
                    ));
                }
                current = self
                    .environments
                    .get(id as usize)
                    .ok_or_else(|| {
                        format!("value capsule environment {start} references missing parent {id}")
                    })?
                    .parent;
            }
        }
        Ok(())
    }
}

impl CapsuleEncoder {
    fn encode_environment(
        &mut self,
        environment: &Environment,
    ) -> Result<u32, CapsuleEncodingFailure> {
        let identity = Rc::as_ptr(environment) as usize;
        if let Some(id) = self.environment_ids.get(&identity) {
            return Ok(*id);
        }
        let id = u32::try_from(self.environments.len()).map_err(|_| {
            CapsuleEncodingFailure::Invalid(
                "value capsule exhausted u32 environment identities".to_owned(),
            )
        })?;
        self.environment_ids.insert(identity, id);
        self.environments.push(None);
        let parent = environment
            .parent
            .borrow()
            .as_ref()
            .map(|parent| self.encode_environment(parent))
            .transpose()?;
        let names = environment
            .names
            .borrow()
            .iter()
            .map(|(name, value)| Ok((name.clone(), self.encode_value(value)?)))
            .collect::<Result<_, CapsuleEncodingFailure>>()?;
        let opens = environment
            .opens
            .borrow()
            .iter()
            .map(|opened| self.encode_fields(opened.fields()))
            .collect::<Result<_, _>>()?;
        let type_substitutions = environment
            .type_substitutions
            .borrow()
            .iter()
            .map(|(variable, value)| Ok((*variable, self.encode_value(value)?)))
            .collect::<Result<_, CapsuleEncodingFailure>>()?;
        self.environments[id as usize] = Some(CapsuleEnvironment {
            parent,
            names,
            opens,
            type_substitutions,
        });
        Ok(id)
    }

    fn encode_fields(
        &mut self,
        fields: &OrderedFields,
    ) -> Result<Vec<(String, CapsuleValue)>, CapsuleEncodingFailure> {
        fields
            .iter()
            .map(|(name, value)| Ok((name.clone(), self.encode_value(value)?)))
            .collect()
    }

    fn encode_values(
        &mut self,
        values: &[Value],
    ) -> Result<Vec<CapsuleValue>, CapsuleEncodingFailure> {
        values
            .iter()
            .map(|value| self.encode_value(value))
            .collect()
    }

    fn encode_value(&mut self, value: &Value) -> Result<CapsuleValue, CapsuleEncodingFailure> {
        Ok(match value {
            Value::Int(value) => CapsuleValue::Int(value.clone()),
            Value::Float(value) => CapsuleValue::Float(*value),
            Value::Float32(value) => CapsuleValue::Float32(*value),
            Value::Vector(value) => CapsuleValue::Vector(*value),
            Value::VectorMask(value) => CapsuleValue::VectorMask(*value),
            Value::IntegerVector { bits, lanes } => CapsuleValue::IntegerVector {
                bits: *bits,
                lanes: lanes.clone(),
            },
            Value::IntegerVectorMask { bits, lanes } => CapsuleValue::IntegerVectorMask {
                bits: *bits,
                lanes: lanes.clone(),
            },
            Value::Text(value) => CapsuleValue::Text(value.clone()),
            Value::Unit => CapsuleValue::Unit,
            Value::Shape(fields) => CapsuleValue::Shape(self.encode_fields(fields)?),
            Value::Array(values) => CapsuleValue::Array(self.encode_values(values)?),
            Value::RegionType(element) => {
                CapsuleValue::RegionType(Box::new(self.encode_value(element)?))
            }
            Value::ScratchType(element) => {
                CapsuleValue::ScratchType(Box::new(self.encode_value(element)?))
            }
            Value::DeferredScratch { capacity } => CapsuleValue::DeferredScratch {
                capacity: Box::new(self.encode_value(capacity)?),
            },
            Value::EmptyArray { element } => CapsuleValue::EmptyArray {
                element: Box::new(self.encode_value(element)?),
            },
            Value::Tag { name, payload } => CapsuleValue::Tag {
                name: name.clone(),
                payload: payload
                    .as_deref()
                    .map(|payload| self.encode_value(payload).map(Box::new))
                    .transpose()?,
            },
            Value::Closure {
                module,
                parameter,
                body,
                environment,
                self_name,
                imports,
                reuse_assertion,
                deferred,
                ..
            } => CapsuleValue::Closure {
                module: self.encode_module(module),
                parameter: *parameter,
                body: *body,
                environment: self.encode_environment(environment)?,
                self_name: self_name.clone(),
                imports: imports.clone(),
                reuse_assertion: *reuse_assertion,
                deferred: *deferred,
            },
            Value::ModuleClosure { module } => CapsuleValue::ModuleClosure {
                module: self.encode_module(module),
            },
            Value::IndexedStep { elements } => CapsuleValue::IndexedStep {
                elements: self.encode_values(elements)?,
            },
            Value::Primitive {
                name,
                arity,
                applied,
            } => CapsuleValue::Primitive {
                name: name.clone(),
                arity: u32::try_from(*arity).map_err(|_| {
                    CapsuleEncodingFailure::Invalid(format!(
                        "primitive {name} arity {arity} exceeds u32"
                    ))
                })?,
                applied: self.encode_values(applied)?,
            },
            Value::Range { low, high, domain } => CapsuleValue::Range {
                low: Box::new(self.encode_value(low)?),
                high: Box::new(self.encode_value(high)?),
                domain: domain.map(encode_domain),
            },
            Value::Union(values) => CapsuleValue::Union(self.encode_values(values)?),
            Value::Unbounded => CapsuleValue::Unbounded,
            Value::Arrow {
                deferred,
                domain,
                codomain,
                effects,
                effect_tail,
            } => CapsuleValue::Arrow {
                deferred: *deferred,
                domain: Box::new(self.encode_value(domain)?),
                codomain: Box::new(self.encode_value(codomain)?),
                effects: self.encode_values(effects)?,
                effect_tail: *effect_tail,
            },
            Value::TypeVariable(variable) => CapsuleValue::TypeVariable(*variable),
            Value::Forall { variable, body } => CapsuleValue::Forall {
                variable: *variable,
                body: Box::new(self.encode_value(body)?),
            },
            Value::Extended { inner, members } => CapsuleValue::Extended {
                inner: Box::new(self.encode_value(inner)?),
                members: self.encode_fields(members)?,
            },
            Value::Sealed { name, inner } => CapsuleValue::Sealed {
                name: name.clone(),
                inner: Box::new(self.encode_value(inner)?),
            },
            Value::OpaqueType(name) => CapsuleValue::OpaqueType(name.clone()),
            Value::Scratch { .. }
            | Value::Region { .. }
            | Value::RegionRejoin { .. }
            | Value::Deferred { .. }
            | Value::ClosureChoice { .. }
            | Value::Effect { .. }
            | Value::Operation { .. }
            | Value::Runtime(_)
            | Value::Continuation { .. } => {
                return Err(CapsuleEncodingFailure::Ineligible);
            }
        })
    }

    fn encode_module(&self, module: &str) -> CapsuleModule {
        if module == self.module_path {
            CapsuleModule::Local
        } else {
            CapsuleModule::External(module.to_owned())
        }
    }
}

fn decode_fields(
    fields: &[(String, CapsuleValue)],
    environments: &[Environment],
    module_path: &str,
    closure_signatures: &HashMap<(String, ExpressionId), Value>,
) -> Result<OrderedFields, String> {
    fields
        .iter()
        .map(|(name, value)| {
            Ok((
                name.clone(),
                decode_value(value, environments, module_path, closure_signatures)?,
            ))
        })
        .collect()
}

fn decode_values(
    values: &[CapsuleValue],
    environments: &[Environment],
    module_path: &str,
    closure_signatures: &HashMap<(String, ExpressionId), Value>,
) -> Result<Vec<Value>, String> {
    values
        .iter()
        .map(|value| decode_value(value, environments, module_path, closure_signatures))
        .collect()
}

fn decode_value(
    value: &CapsuleValue,
    environments: &[Environment],
    module_path: &str,
    closure_signatures: &HashMap<(String, ExpressionId), Value>,
) -> Result<Value, String> {
    Ok(match value {
        CapsuleValue::Int(value) => Value::Int(value.clone()),
        CapsuleValue::Float(value) => Value::Float(*value),
        CapsuleValue::Float32(value) => Value::Float32(*value),
        CapsuleValue::Vector(value) => Value::Vector(*value),
        CapsuleValue::VectorMask(value) => Value::VectorMask(*value),
        CapsuleValue::IntegerVector { bits, lanes } => Value::IntegerVector {
            bits: *bits,
            lanes: lanes.clone(),
        },
        CapsuleValue::IntegerVectorMask { bits, lanes } => Value::IntegerVectorMask {
            bits: *bits,
            lanes: lanes.clone(),
        },
        CapsuleValue::Text(value) => Value::Text(value.clone()),
        CapsuleValue::Unit => Value::Unit,
        CapsuleValue::Shape(fields) => Value::Shape(decode_fields(
            fields,
            environments,
            module_path,
            closure_signatures,
        )?),
        CapsuleValue::Array(values) => Value::Array(decode_values(
            values,
            environments,
            module_path,
            closure_signatures,
        )?),
        CapsuleValue::RegionType(element) => Value::RegionType(Box::new(decode_value(
            element,
            environments,
            module_path,
            closure_signatures,
        )?)),
        CapsuleValue::ScratchType(element) => Value::ScratchType(Box::new(decode_value(
            element,
            environments,
            module_path,
            closure_signatures,
        )?)),
        CapsuleValue::DeferredScratch { capacity } => Value::DeferredScratch {
            capacity: Box::new(decode_value(
                capacity,
                environments,
                module_path,
                closure_signatures,
            )?),
        },
        CapsuleValue::EmptyArray { element } => Value::EmptyArray {
            element: Box::new(decode_value(
                element,
                environments,
                module_path,
                closure_signatures,
            )?),
        },
        CapsuleValue::Tag { name, payload } => Value::Tag {
            name: name.clone(),
            payload: payload
                .as_deref()
                .map(|payload| {
                    decode_value(payload, environments, module_path, closure_signatures)
                        .map(Box::new)
                })
                .transpose()?,
        },
        CapsuleValue::Closure {
            module,
            parameter,
            body,
            environment,
            self_name,
            imports,
            reuse_assertion,
            deferred,
        } => {
            let module = decode_module(module, module_path);
            Value::Closure {
                module: Rc::new(module.clone()),
                parameter: *parameter,
                body: *body,
                environment: environments
                    .get(*environment as usize)
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "value capsule closure {module}#{} references missing environment {environment}",
                            body.0
                        )
                    })?,
                self_name: self_name.clone(),
                imports: imports.clone(),
                signature: closure_signatures
                    .get(&(module.clone(), *body))
                    .cloned()
                    .map(Box::new),
                reuse_assertion: *reuse_assertion,
                deferred: *deferred,
            }
        }
        CapsuleValue::ModuleClosure { module } => Value::ModuleClosure {
            module: decode_module(module, module_path),
        },
        CapsuleValue::IndexedStep { elements } => Value::IndexedStep {
            elements: decode_values(elements, environments, module_path, closure_signatures)?,
        },
        CapsuleValue::Primitive {
            name,
            arity,
            applied,
        } => Value::Primitive {
            name: name.clone(),
            arity: usize::try_from(*arity)
                .map_err(|_| format!("primitive {name} arity {arity} exceeds usize"))?,
            applied: decode_values(applied, environments, module_path, closure_signatures)?,
        },
        CapsuleValue::Range { low, high, domain } => Value::Range {
            low: Box::new(decode_value(
                low,
                environments,
                module_path,
                closure_signatures,
            )?),
            high: Box::new(decode_value(
                high,
                environments,
                module_path,
                closure_signatures,
            )?),
            domain: domain.map(decode_domain).transpose()?,
        },
        CapsuleValue::Union(values) => Value::Union(decode_values(
            values,
            environments,
            module_path,
            closure_signatures,
        )?),
        CapsuleValue::Unbounded => Value::Unbounded,
        CapsuleValue::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => Value::Arrow {
            deferred: *deferred,
            domain: Box::new(decode_value(
                domain,
                environments,
                module_path,
                closure_signatures,
            )?),
            codomain: Box::new(decode_value(
                codomain,
                environments,
                module_path,
                closure_signatures,
            )?),
            effects: decode_values(effects, environments, module_path, closure_signatures)?,
            effect_tail: *effect_tail,
        },
        CapsuleValue::TypeVariable(variable) => Value::TypeVariable(*variable),
        CapsuleValue::Forall { variable, body } => Value::Forall {
            variable: *variable,
            body: Box::new(decode_value(
                body,
                environments,
                module_path,
                closure_signatures,
            )?),
        },
        CapsuleValue::Extended { inner, members } => Value::Extended {
            inner: Box::new(decode_value(
                inner,
                environments,
                module_path,
                closure_signatures,
            )?),
            members: decode_fields(members, environments, module_path, closure_signatures)?,
        },
        CapsuleValue::Sealed { name, inner } => Value::Sealed {
            name: name.clone(),
            inner: Box::new(decode_value(
                inner,
                environments,
                module_path,
                closure_signatures,
            )?),
        },
        CapsuleValue::OpaqueType(name) => Value::OpaqueType(name.clone()),
    })
}

fn decode_module(module: &CapsuleModule, module_path: &str) -> String {
    match module {
        CapsuleModule::Local => module_path.to_owned(),
        CapsuleModule::External(module) => module.clone(),
    }
}

fn encode_domain(domain: Domain) -> u8 {
    match domain {
        Domain::Int => 0,
        Domain::Text => 1,
        Domain::Float => 2,
        Domain::Float32 => 3,
    }
}

fn decode_domain(domain: u8) -> Result<Domain, String> {
    match domain {
        0 => Ok(Domain::Int),
        1 => Ok(Domain::Text),
        2 => Ok(Domain::Float),
        3 => Ok(Domain::Float32),
        _ => Err(format!("value capsule has unknown domain {domain}")),
    }
}
