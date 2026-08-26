use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::ast::{DeclarationId, Expression, ExpressionId, Module, PatternId, Span};
use crate::eval::{
    ApplicationRoot, ApplicationSite, ClosureApplication, CompilerApplication, Context,
    EffectScope, ModuleInstanceScope, ModuleInstanceSite, ModuleRevision, RecognitionProbe,
};
use crate::value::{Domain, Environment, OpenedValues, OrderedFields, Value, child_env};

const VALUE_CAPSULE_SCHEMA: u32 = 3;

#[derive(Deserialize, Serialize)]
pub(crate) struct ValueCapsule {
    schema: u32,
    environments: Vec<CapsuleEnvironment>,
    effect_scopes: Vec<Vec<CapsuleClosureApplication>>,
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
        module_instances: Vec<CapsuleModuleInstanceSite>,
        effect_scope: u32,
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

#[derive(Deserialize, Serialize)]
enum CapsuleApplicationRoot {
    Expression(ExpressionId),
    Declaration(DeclarationId),
}

#[derive(Deserialize, Serialize)]
struct CapsuleApplicationSite {
    root: CapsuleApplicationRoot,
    compiler_steps: Vec<CapsuleCompilerApplication>,
}

#[derive(Deserialize, Serialize)]
enum CapsuleCompilerApplication {
    ForceEffectDeclaration,
    ForallBody,
    IncludeParser,
    HandleThunk,
    HandleReturn,
    HandleOperation {
        operation: String,
        request: Box<CapsuleApplicationSite>,
    },
    RequirementPredicate,
    RecognitionArgument {
        probe: CapsuleRecognitionProbe,
        position: u8,
    },
    RuntimeExportParameter(u32),
}

#[derive(Deserialize, Serialize)]
enum CapsuleRecognitionProbe {
    Integer { left: i8, right: i8 },
    Boolean { left: bool, right: bool },
    BooleanUnary { argument: bool },
}

#[derive(Deserialize, Serialize)]
struct CapsuleClosureApplication {
    application: CapsuleApplicationSite,
    creation_scope: u32,
}

#[derive(Deserialize, Serialize)]
struct CapsuleModuleInstanceSite {
    application: CapsuleApplicationSite,
}

struct CapsuleEncoder {
    module_path: String,
    module_revision: ModuleRevision,
    environment_ids: HashMap<usize, u32>,
    environments: Vec<Option<CapsuleEnvironment>>,
    effect_scope_ids: HashMap<usize, u32>,
    effect_scopes: Vec<Option<Vec<CapsuleClosureApplication>>>,
}

struct CapsuleDecodeProvenance<'a> {
    effect_scopes: &'a [Rc<EffectScope>],
    module_instances: &'a ModuleInstanceScope,
    module_revision: &'a ModuleRevision,
}

enum CapsuleEncodingFailure {
    Ineligible,
    Invalid(String),
}

impl ValueCapsule {
    pub(crate) fn encode(
        environment: &Environment,
        module_path: &str,
        module_revision: &ModuleRevision,
    ) -> Result<Option<Self>, String> {
        let mut encoder = CapsuleEncoder {
            module_path: module_path.to_owned(),
            module_revision: module_revision.clone(),
            environment_ids: HashMap::new(),
            environments: Vec::new(),
            effect_scope_ids: HashMap::new(),
            effect_scopes: Vec::new(),
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
        let effect_scopes = encoder
            .effect_scopes
            .into_iter()
            .enumerate()
            .map(|(id, effect_scope)| {
                effect_scope.ok_or_else(|| format!("value capsule omitted effect scope {id}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Self {
            schema: VALUE_CAPSULE_SCHEMA,
            environments,
            effect_scopes,
            root,
        }))
    }

    pub(crate) fn decode(
        &self,
        module_path: &str,
        module: &Module,
        module_revision: &ModuleRevision,
        context: &Context,
        base_module_instances: &ModuleInstanceScope,
        base_effect_scope: &Rc<EffectScope>,
    ) -> Result<Environment, String> {
        if self.schema != VALUE_CAPSULE_SCHEMA {
            return Err(format!(
                "value capsule has schema {}, expected {VALUE_CAPSULE_SCHEMA}",
                self.schema
            ));
        }
        self.validate_environment_graph()?;
        let effect_scopes = decode_effect_scopes(
            &self.effect_scopes,
            module_path,
            module,
            module_revision,
            base_effect_scope,
        )?;
        let provenance = CapsuleDecodeProvenance {
            effect_scopes: &effect_scopes,
            module_instances: base_module_instances,
            module_revision,
        };
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
                        decode_value(
                            value,
                            &environments,
                            &provenance,
                            module_path,
                            module,
                            context,
                        )?,
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
                        &provenance,
                        module_path,
                        module,
                        context,
                    )?))
                })
                .collect::<Result<_, String>>()?;
            *environment.type_substitutions.borrow_mut() = encoded
                .type_substitutions
                .iter()
                .map(|(variable, value)| {
                    Ok((
                        *variable,
                        decode_value(
                            value,
                            &environments,
                            &provenance,
                            module_path,
                            module,
                            context,
                        )?,
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
                module_instances,
                effect_scope,
                parameter,
                body,
                environment,
                self_name,
                imports,
                reuse_assertion,
                deferred,
                signature: _,
            } => CapsuleValue::Closure {
                module: self.encode_module(module)?,
                module_instances: self.encode_module_instances(module_instances)?,
                effect_scope: self.encode_effect_scope(effect_scope)?,
                parameter: *parameter,
                body: *body,
                environment: self.encode_environment(environment)?,
                self_name: self_name.clone(),
                imports: imports.clone(),
                reuse_assertion: *reuse_assertion,
                deferred: *deferred,
            },
            Value::ModuleClosure { module } => CapsuleValue::ModuleClosure {
                module: self.encode_module(module)?,
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
            Value::OpaqueType(name) if name.starts_with("Effect:") => {
                return Err(CapsuleEncodingFailure::Ineligible);
            }
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

    fn encode_effect_scope(
        &mut self,
        effect_scope: &Rc<EffectScope>,
    ) -> Result<u32, CapsuleEncodingFailure> {
        let identity = Rc::as_ptr(effect_scope) as usize;
        if let Some(id) = self.effect_scope_ids.get(&identity) {
            return Ok(*id);
        }
        let id = u32::try_from(self.effect_scopes.len()).map_err(|_| {
            CapsuleEncodingFailure::Invalid(
                "value capsule exhausted u32 effect-scope identities".to_owned(),
            )
        })?;
        self.effect_scope_ids.insert(identity, id);
        self.effect_scopes.push(None);
        let mut encoded = Vec::with_capacity(effect_scope.len());
        for frame in effect_scope.iter() {
            encoded.push(CapsuleClosureApplication {
                application: self.encode_application_site(&frame.application)?,
                creation_scope: self.encode_effect_scope(&frame.creation_scope)?,
            });
        }
        self.effect_scopes[id as usize] = Some(encoded);
        Ok(id)
    }

    fn encode_module_instances(
        &self,
        module_instances: &ModuleInstanceScope,
    ) -> Result<Vec<CapsuleModuleInstanceSite>, CapsuleEncodingFailure> {
        module_instances
            .iter()
            .map(|site| {
                self.require_local_revision(&site.imported)?;
                Ok(CapsuleModuleInstanceSite {
                    application: self.encode_application_site(&site.application)?,
                })
            })
            .collect()
    }

    fn encode_application_site(
        &self,
        application: &ApplicationSite,
    ) -> Result<CapsuleApplicationSite, CapsuleEncodingFailure> {
        let root = match &application.root {
            ApplicationRoot::Expression {
                revision,
                expression,
            } => {
                self.require_local_revision(revision)?;
                CapsuleApplicationRoot::Expression(*expression)
            }
            ApplicationRoot::Declaration {
                revision,
                declaration,
            } => {
                self.require_local_revision(revision)?;
                CapsuleApplicationRoot::Declaration(*declaration)
            }
        };
        let compiler_steps = application
            .compiler_steps
            .iter()
            .map(|step| self.encode_compiler_application(step))
            .collect::<Result<_, _>>()?;
        Ok(CapsuleApplicationSite {
            root,
            compiler_steps,
        })
    }

    fn encode_compiler_application(
        &self,
        application: &CompilerApplication,
    ) -> Result<CapsuleCompilerApplication, CapsuleEncodingFailure> {
        Ok(match application {
            CompilerApplication::ForceEffectDeclaration => {
                CapsuleCompilerApplication::ForceEffectDeclaration
            }
            CompilerApplication::ForallBody => CapsuleCompilerApplication::ForallBody,
            CompilerApplication::IncludeParser => CapsuleCompilerApplication::IncludeParser,
            CompilerApplication::HandleThunk => CapsuleCompilerApplication::HandleThunk,
            CompilerApplication::HandleReturn => CapsuleCompilerApplication::HandleReturn,
            CompilerApplication::HandleOperation { operation, request } => {
                CapsuleCompilerApplication::HandleOperation {
                    operation: operation.clone(),
                    request: Box::new(self.encode_application_site(request)?),
                }
            }
            CompilerApplication::RequirementPredicate => {
                CapsuleCompilerApplication::RequirementPredicate
            }
            CompilerApplication::RecognitionArgument { probe, position } => {
                CapsuleCompilerApplication::RecognitionArgument {
                    probe: encode_recognition_probe(*probe),
                    position: *position,
                }
            }
            CompilerApplication::RuntimeExportParameter(parameter) => {
                CapsuleCompilerApplication::RuntimeExportParameter(*parameter)
            }
        })
    }

    fn require_local_revision(
        &self,
        revision: &ModuleRevision,
    ) -> Result<(), CapsuleEncodingFailure> {
        if revision == &self.module_revision {
            return Ok(());
        }
        Err(CapsuleEncodingFailure::Ineligible)
    }

    fn encode_module(&self, module: &str) -> Result<CapsuleModule, CapsuleEncodingFailure> {
        if module == self.module_path {
            return Ok(CapsuleModule::Local);
        }
        Err(CapsuleEncodingFailure::Ineligible)
    }
}

fn encode_recognition_probe(probe: RecognitionProbe) -> CapsuleRecognitionProbe {
    match probe {
        RecognitionProbe::Integer { left, right } => {
            CapsuleRecognitionProbe::Integer { left, right }
        }
        RecognitionProbe::Boolean { left, right } => {
            CapsuleRecognitionProbe::Boolean { left, right }
        }
        RecognitionProbe::BooleanUnary { argument } => {
            CapsuleRecognitionProbe::BooleanUnary { argument }
        }
    }
}

fn decode_effect_scopes(
    encoded: &[Vec<CapsuleClosureApplication>],
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
    base_effect_scope: &Rc<EffectScope>,
) -> Result<Vec<Rc<EffectScope>>, String> {
    let mut decoded = vec![None; encoded.len()];
    let mut visiting = HashSet::new();
    let mut decoder = EffectScopeDecoder {
        encoded,
        module_path,
        module,
        module_revision,
        base_effect_scope,
        decoded: &mut decoded,
        visiting: &mut visiting,
    };
    for id in 0..encoded.len() {
        decoder.decode(
            u32::try_from(id)
                .map_err(|_| "value capsule has more than u32 effect scopes".to_owned())?,
        )?;
    }
    decoded
        .into_iter()
        .enumerate()
        .map(|(id, effect_scope)| {
            effect_scope.ok_or_else(|| format!("value capsule omitted decoded effect scope {id}"))
        })
        .collect()
}

struct EffectScopeDecoder<'a> {
    encoded: &'a [Vec<CapsuleClosureApplication>],
    module_path: &'a str,
    module: &'a Module,
    module_revision: &'a ModuleRevision,
    base_effect_scope: &'a Rc<EffectScope>,
    decoded: &'a mut [Option<Rc<EffectScope>>],
    visiting: &'a mut HashSet<u32>,
}

impl EffectScopeDecoder<'_> {
    fn decode(&mut self, id: u32) -> Result<Rc<EffectScope>, String> {
        if let Some(effect_scope) = self.decoded.get(id as usize).and_then(Option::as_ref) {
            return Ok(effect_scope.clone());
        }
        if !self.visiting.insert(id) {
            return Err(format!("value capsule effect scope {id} is cyclic"));
        }
        let frame_count = self
            .encoded
            .get(id as usize)
            .ok_or_else(|| format!("value capsule references missing effect scope {id}"))?
            .len();
        if frame_count == 0 {
            self.visiting.remove(&id);
            self.decoded[id as usize] = Some(self.base_effect_scope.clone());
            return Ok(self.base_effect_scope.clone());
        }
        let mut effect_scope = Vec::with_capacity(self.base_effect_scope.len() + frame_count);
        effect_scope.extend(self.base_effect_scope.iter().cloned());
        for frame_index in 0..frame_count {
            let (application, creation_scope) = {
                let frame = &self.encoded[id as usize][frame_index];
                (
                    decode_application_site(
                        &frame.application,
                        self.module_path,
                        self.module,
                        self.module_revision,
                    )?,
                    frame.creation_scope,
                )
            };
            effect_scope.push(ClosureApplication {
                application,
                creation_scope: self.decode(creation_scope)?,
            });
        }
        self.visiting.remove(&id);
        let effect_scope = Rc::new(effect_scope);
        self.decoded[id as usize] = Some(effect_scope.clone());
        Ok(effect_scope)
    }
}

fn decode_module_instances(
    encoded: &[CapsuleModuleInstanceSite],
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
    base_module_instances: &ModuleInstanceScope,
) -> Result<ModuleInstanceScope, String> {
    let mut module_instances = Vec::with_capacity(base_module_instances.len() + encoded.len());
    module_instances.extend(base_module_instances.iter().cloned());
    for site in encoded {
        module_instances.push(ModuleInstanceSite {
            application: decode_application_site(
                &site.application,
                module_path,
                module,
                module_revision,
            )?,
            imported: module_revision.clone(),
        });
    }
    Ok(module_instances)
}

fn decode_application_site(
    encoded: &CapsuleApplicationSite,
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
) -> Result<ApplicationSite, String> {
    let root = match encoded.root {
        CapsuleApplicationRoot::Expression(expression) => {
            if expression.0 as usize >= module.arena.expressions.len() {
                return Err(format!(
                    "value capsule application in {module_path} references missing expression {}",
                    expression.0
                ));
            }
            ApplicationRoot::Expression {
                revision: module_revision.clone(),
                expression,
            }
        }
        CapsuleApplicationRoot::Declaration(declaration) => {
            if declaration.0 as usize >= module.arena.declarations.len() {
                return Err(format!(
                    "value capsule application in {module_path} references missing declaration {}",
                    declaration.0
                ));
            }
            ApplicationRoot::Declaration {
                revision: module_revision.clone(),
                declaration,
            }
        }
    };
    let compiler_steps = encoded
        .compiler_steps
        .iter()
        .map(|step| decode_compiler_application(step, module_path, module, module_revision))
        .collect::<Result<_, _>>()?;
    Ok(ApplicationSite {
        root,
        compiler_steps,
    })
}

fn decode_compiler_application(
    encoded: &CapsuleCompilerApplication,
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
) -> Result<CompilerApplication, String> {
    Ok(match encoded {
        CapsuleCompilerApplication::ForceEffectDeclaration => {
            CompilerApplication::ForceEffectDeclaration
        }
        CapsuleCompilerApplication::ForallBody => CompilerApplication::ForallBody,
        CapsuleCompilerApplication::IncludeParser => CompilerApplication::IncludeParser,
        CapsuleCompilerApplication::HandleThunk => CompilerApplication::HandleThunk,
        CapsuleCompilerApplication::HandleReturn => CompilerApplication::HandleReturn,
        CapsuleCompilerApplication::HandleOperation { operation, request } => {
            CompilerApplication::HandleOperation {
                operation: operation.clone(),
                request: Box::new(decode_application_site(
                    request,
                    module_path,
                    module,
                    module_revision,
                )?),
            }
        }
        CapsuleCompilerApplication::RequirementPredicate => {
            CompilerApplication::RequirementPredicate
        }
        CapsuleCompilerApplication::RecognitionArgument { probe, position } => {
            CompilerApplication::RecognitionArgument {
                probe: decode_recognition_probe(probe),
                position: *position,
            }
        }
        CapsuleCompilerApplication::RuntimeExportParameter(parameter) => {
            CompilerApplication::RuntimeExportParameter(*parameter)
        }
    })
}

fn decode_recognition_probe(probe: &CapsuleRecognitionProbe) -> RecognitionProbe {
    match probe {
        CapsuleRecognitionProbe::Integer { left, right } => RecognitionProbe::Integer {
            left: *left,
            right: *right,
        },
        CapsuleRecognitionProbe::Boolean { left, right } => RecognitionProbe::Boolean {
            left: *left,
            right: *right,
        },
        CapsuleRecognitionProbe::BooleanUnary { argument } => RecognitionProbe::BooleanUnary {
            argument: *argument,
        },
    }
}

fn decode_fields(
    fields: &[(String, CapsuleValue)],
    environments: &[Environment],
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
) -> Result<OrderedFields, String> {
    fields
        .iter()
        .map(|(name, value)| {
            Ok((
                name.clone(),
                decode_value(
                    value,
                    environments,
                    provenance,
                    module_path,
                    module,
                    context,
                )?,
            ))
        })
        .collect()
}

fn decode_values(
    values: &[CapsuleValue],
    environments: &[Environment],
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
) -> Result<Vec<Value>, String> {
    values
        .iter()
        .map(|value| {
            decode_value(
                value,
                environments,
                provenance,
                module_path,
                module,
                context,
            )
        })
        .collect()
}

fn decode_value(
    value: &CapsuleValue,
    environments: &[Environment],
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
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
            provenance,
            module_path,
            module,
            context,
        )?),
        CapsuleValue::Array(values) => Value::Array(decode_values(
            values,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?),
        CapsuleValue::RegionType(element) => Value::RegionType(Box::new(decode_value(
            element,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?)),
        CapsuleValue::ScratchType(element) => Value::ScratchType(Box::new(decode_value(
            element,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?)),
        CapsuleValue::DeferredScratch { capacity } => Value::DeferredScratch {
            capacity: Box::new(decode_value(
                capacity,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::EmptyArray { element } => Value::EmptyArray {
            element: Box::new(decode_value(
                element,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::Tag { name, payload } => Value::Tag {
            name: name.clone(),
            payload: payload
                .as_deref()
                .map(|payload| {
                    decode_value(
                        payload,
                        environments,
                        provenance,
                        module_path,
                        module,
                        context,
                    )
                    .map(Box::new)
                })
                .transpose()?,
        },
        CapsuleValue::Closure {
            module: encoded_module,
            module_instances,
            effect_scope,
            parameter,
            body,
            environment,
            self_name,
            imports,
            reuse_assertion,
            deferred,
        } => {
            let closure_module = decode_module(encoded_module, module_path)?;
            validate_closure(module_path, module, *parameter, *body, *deferred)?;
            Value::Closure {
                module: Rc::new(closure_module.clone()),
                module_instances: Rc::new(decode_module_instances(
                    module_instances,
                    module_path,
                    module,
                    provenance.module_revision,
                    provenance.module_instances,
                )?),
                effect_scope: provenance
                    .effect_scopes
                    .get(*effect_scope as usize)
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "value capsule closure {closure_module}#{} references missing effect scope {effect_scope}",
                            body.0
                        )
                    })?,
                parameter: *parameter,
                body: *body,
                environment: environments
                    .get(*environment as usize)
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "value capsule closure {closure_module}#{} references missing environment {environment}",
                            body.0
                        )
                    })?,
                self_name: self_name.clone(),
                imports: imports.clone(),
                signature: context
                    .closure_signature(&closure_module, *body)
                    .map(Box::new),
                reuse_assertion: *reuse_assertion,
                deferred: *deferred,
            }
        }
        CapsuleValue::ModuleClosure {
            module: encoded_module,
        } => Value::ModuleClosure {
            module: decode_module(encoded_module, module_path)?,
        },
        CapsuleValue::IndexedStep { elements } => Value::IndexedStep {
            elements: decode_values(
                elements,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
        },
        CapsuleValue::Primitive {
            name,
            arity,
            applied,
        } => Value::Primitive {
            name: name.clone(),
            arity: usize::try_from(*arity)
                .map_err(|_| format!("primitive {name} arity {arity} exceeds usize"))?,
            applied: decode_values(
                applied,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
        },
        CapsuleValue::Range { low, high, domain } => Value::Range {
            low: Box::new(decode_value(
                low,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            high: Box::new(decode_value(
                high,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            domain: domain.map(decode_domain).transpose()?,
        },
        CapsuleValue::Union(values) => Value::Union(decode_values(
            values,
            environments,
            provenance,
            module_path,
            module,
            context,
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
                provenance,
                module_path,
                module,
                context,
            )?),
            codomain: Box::new(decode_value(
                codomain,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            effects: decode_values(
                effects,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
            effect_tail: *effect_tail,
        },
        CapsuleValue::TypeVariable(variable) => Value::TypeVariable(*variable),
        CapsuleValue::Forall { variable, body } => Value::Forall {
            variable: *variable,
            body: Box::new(decode_value(
                body,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::Extended { inner, members } => Value::Extended {
            inner: Box::new(decode_value(
                inner,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            members: decode_fields(
                members,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
        },
        CapsuleValue::Sealed { name, inner } => Value::Sealed {
            name: name.clone(),
            inner: Box::new(decode_value(
                inner,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::OpaqueType(name) if name.starts_with("Effect:") => {
            return Err(format!(
                "value capsule contains generative effect type {name}"
            ));
        }
        CapsuleValue::OpaqueType(name) => Value::OpaqueType(name.clone()),
    })
}

fn decode_module(module: &CapsuleModule, module_path: &str) -> Result<String, String> {
    match module {
        CapsuleModule::Local => Ok(module_path.to_owned()),
        CapsuleModule::External(module) => Err(format!(
            "value capsule for dependency-free module {module_path} references external module {module}"
        )),
    }
}

fn validate_closure(
    module_path: &str,
    module: &Module,
    parameter: PatternId,
    body: ExpressionId,
    deferred: bool,
) -> Result<(), String> {
    let matches_lambda = module.arena.expressions.iter().any(|expression| {
        matches!(
            expression,
            Expression::Lambda {
                parameter: source_parameter,
                body: source_body,
                deferred: source_deferred,
                ..
            } if *source_parameter == parameter
                && *source_body == body
                && *source_deferred == deferred
        )
    });
    if matches_lambda {
        return Ok(());
    }
    Err(format!(
        "value capsule closure {module_path}#{} has no matching source lambda for parameter {}",
        body.0, parameter.0
    ))
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
