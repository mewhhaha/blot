use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId, Module, Pattern,
    PatternId, Qualifier, ShapeMember, Span,
};
use crate::diagnostic::Diagnostic;
use crate::eval::{
    Context, Phase, Runtime, apply, closure_free_names, evaluate_binding, evaluate_expression,
    force_effect_value, match_pattern, run,
};
use crate::value::{
    Domain as ValueDomain, Environment as ValueEnvironment, OpenedValues, Value, attach_signature,
    child_env, lookup,
};

type VariableId = u32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum Domain {
    Int,
    Text,
    Float,
    Float32,
}

#[derive(Clone, Debug)]
pub enum Type {
    Variable(VariableId),
    Rigid(VariableId),
    Forall {
        variables: Vec<VariableId>,
        body: Box<Type>,
    },
    Range {
        domain: Domain,
        low: Option<Scalar>,
        high: Option<Scalar>,
    },
    Unit,
    Function {
        parameter: Box<Type>,
        effects: Box<Type>,
        result: Box<Type>,
    },
    Record(Vec<(String, Type)>),
    Array(Box<Type>),
    Region(Box<Type>),
    Variant {
        cases: Vec<(String, Type)>,
        open: bool,
    },
    Effects(BTreeSet<String>),
    OpenEffects {
        labels: BTreeSet<String>,
        tail: Box<Type>,
    },
    Union(Vec<Type>),
    Opaque(String),
    Top,
    Bottom,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, PartialOrd, Ord, Serialize)]
pub enum Scalar {
    Int(BigInt),
    Text(String),
}

#[derive(Clone, Debug)]
struct Variable {
    level: u32,
    lower: Vec<ConstraintTypeId>,
    upper: Vec<ConstraintTypeId>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ConstraintTypeId(u32);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum ConstraintTypeNode {
    Variable(VariableId),
    Rigid(VariableId),
    Forall {
        variables: Vec<VariableId>,
        body: ConstraintTypeId,
    },
    Range {
        domain: Domain,
        low: Option<Scalar>,
        high: Option<Scalar>,
    },
    Unit,
    Function {
        parameter: ConstraintTypeId,
        effects: ConstraintTypeId,
        result: ConstraintTypeId,
    },
    Record(Vec<(String, ConstraintTypeId)>),
    Array(ConstraintTypeId),
    Region(ConstraintTypeId),
    Variant {
        cases: Vec<(String, ConstraintTypeId)>,
        open: bool,
    },
    Effects(BTreeSet<String>),
    OpenEffects {
        labels: BTreeSet<String>,
        tail: ConstraintTypeId,
    },
    Union(Vec<ConstraintTypeId>),
    Opaque(String),
    Top,
    Bottom,
}

#[derive(Default)]
struct ConstraintTypeArena {
    nodes: Vec<ConstraintTypeNode>,
    interned: HashMap<ConstraintTypeNode, ConstraintTypeId>,
}

impl ConstraintTypeArena {
    fn intern(&mut self, type_: &Type) -> ConstraintTypeId {
        let node = match type_ {
            Type::Variable(id) => ConstraintTypeNode::Variable(*id),
            Type::Rigid(id) => ConstraintTypeNode::Rigid(*id),
            Type::Forall { variables, body } => ConstraintTypeNode::Forall {
                variables: variables.clone(),
                body: self.intern(body),
            },
            Type::Range { domain, low, high } => ConstraintTypeNode::Range {
                domain: *domain,
                low: low.clone(),
                high: high.clone(),
            },
            Type::Unit => ConstraintTypeNode::Unit,
            Type::Function {
                parameter,
                effects,
                result,
            } => ConstraintTypeNode::Function {
                parameter: self.intern(parameter),
                effects: self.intern(effects),
                result: self.intern(result),
            },
            Type::Record(fields) => ConstraintTypeNode::Record(
                fields
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.intern(type_)))
                    .collect(),
            ),
            Type::Array(element) => ConstraintTypeNode::Array(self.intern(element)),
            Type::Region(element) => ConstraintTypeNode::Region(self.intern(element)),
            Type::Variant { cases, open } => ConstraintTypeNode::Variant {
                cases: cases
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.intern(type_)))
                    .collect(),
                open: *open,
            },
            Type::Effects(labels) => ConstraintTypeNode::Effects(labels.clone()),
            Type::OpenEffects { labels, tail } => ConstraintTypeNode::OpenEffects {
                labels: labels.clone(),
                tail: self.intern(tail),
            },
            Type::Union(members) => ConstraintTypeNode::Union(
                members.iter().map(|member| self.intern(member)).collect(),
            ),
            Type::Opaque(name) => ConstraintTypeNode::Opaque(name.clone()),
            Type::Top => ConstraintTypeNode::Top,
            Type::Bottom => ConstraintTypeNode::Bottom,
        };
        if let Some(id) = self.interned.get(&node) {
            return *id;
        }
        let id = ConstraintTypeId(self.nodes.len() as u32);
        self.nodes.push(node.clone());
        self.interned.insert(node, id);
        id
    }

    fn expand(&self, id: ConstraintTypeId) -> Type {
        match &self.nodes[id.0 as usize] {
            ConstraintTypeNode::Variable(id) => Type::Variable(*id),
            ConstraintTypeNode::Rigid(id) => Type::Rigid(*id),
            ConstraintTypeNode::Forall { variables, body } => Type::Forall {
                variables: variables.clone(),
                body: Box::new(self.expand(*body)),
            },
            ConstraintTypeNode::Range { domain, low, high } => Type::Range {
                domain: *domain,
                low: low.clone(),
                high: high.clone(),
            },
            ConstraintTypeNode::Unit => Type::Unit,
            ConstraintTypeNode::Function {
                parameter,
                effects,
                result,
            } => Type::Function {
                parameter: Box::new(self.expand(*parameter)),
                effects: Box::new(self.expand(*effects)),
                result: Box::new(self.expand(*result)),
            },
            ConstraintTypeNode::Record(fields) => Type::Record(
                fields
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.expand(*type_)))
                    .collect(),
            ),
            ConstraintTypeNode::Array(element) => Type::Array(Box::new(self.expand(*element))),
            ConstraintTypeNode::Region(element) => Type::Region(Box::new(self.expand(*element))),
            ConstraintTypeNode::Variant { cases, open } => Type::Variant {
                cases: cases
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.expand(*type_)))
                    .collect(),
                open: *open,
            },
            ConstraintTypeNode::Effects(labels) => Type::Effects(labels.clone()),
            ConstraintTypeNode::OpenEffects { labels, tail } => Type::OpenEffects {
                labels: labels.clone(),
                tail: Box::new(self.expand(*tail)),
            },
            ConstraintTypeNode::Union(members) => {
                Type::Union(members.iter().map(|member| self.expand(*member)).collect())
            }
            ConstraintTypeNode::Opaque(name) => Type::Opaque(name.clone()),
            ConstraintTypeNode::Top => Type::Top,
            ConstraintTypeNode::Bottom => Type::Bottom,
        }
    }

    fn variable(&self, id: ConstraintTypeId) -> Option<VariableId> {
        match self.nodes[id.0 as usize] {
            ConstraintTypeNode::Variable(variable) => Some(variable),
            _ => None,
        }
    }

    fn level_of(&self, id: ConstraintTypeId, variables: &[Variable]) -> u32 {
        match &self.nodes[id.0 as usize] {
            ConstraintTypeNode::Variable(id) => variables[*id as usize].level,
            ConstraintTypeNode::Forall { body, .. } => self.level_of(*body, variables),
            ConstraintTypeNode::Function {
                parameter,
                effects,
                result,
            } => self
                .level_of(*parameter, variables)
                .max(self.level_of(*effects, variables))
                .max(self.level_of(*result, variables)),
            ConstraintTypeNode::Record(fields)
            | ConstraintTypeNode::Variant { cases: fields, .. } => fields
                .iter()
                .map(|(_, field)| self.level_of(*field, variables))
                .max()
                .unwrap_or(0),
            ConstraintTypeNode::Array(element) | ConstraintTypeNode::Region(element) => {
                self.level_of(*element, variables)
            }
            ConstraintTypeNode::OpenEffects { tail, .. } => self.level_of(*tail, variables),
            ConstraintTypeNode::Union(members) => members
                .iter()
                .map(|member| self.level_of(*member, variables))
                .max()
                .unwrap_or(0),
            _ => 0,
        }
    }

    fn same(&self, left: ConstraintTypeId, right: ConstraintTypeId) -> bool {
        self.same_with_rigids(left, right, &mut Vec::new())
    }

    fn same_with_rigids(
        &self,
        left: ConstraintTypeId,
        right: ConstraintTypeId,
        rigids: &mut Vec<(VariableId, VariableId)>,
    ) -> bool {
        if left == right {
            return true;
        }
        match (&self.nodes[left.0 as usize], &self.nodes[right.0 as usize]) {
            (ConstraintTypeNode::Variable(left), ConstraintTypeNode::Variable(right)) => {
                left == right
            }
            (ConstraintTypeNode::Rigid(left), ConstraintTypeNode::Rigid(right)) => {
                if let Some(bound_left) =
                    rigids.iter().rev().find_map(|(bound_left, bound_right)| {
                        (bound_right == right).then_some(bound_left)
                    })
                {
                    return bound_left == left;
                }
                if rigids
                    .iter()
                    .any(|(bound_left, bound_right)| bound_left == left || bound_right == right)
                {
                    return false;
                }
                left == right
            }
            (
                ConstraintTypeNode::Forall {
                    variables: left_variables,
                    body: left_body,
                },
                ConstraintTypeNode::Forall {
                    variables: right_variables,
                    body: right_body,
                },
            ) => {
                if left_variables.len() != right_variables.len() {
                    return false;
                }
                let previous = rigids.len();
                rigids.extend(
                    left_variables
                        .iter()
                        .zip(right_variables)
                        .map(|(left, right)| (*left, *right)),
                );
                let same = self.same_with_rigids(*left_body, *right_body, rigids);
                rigids.truncate(previous);
                same
            }
            (ConstraintTypeNode::Unit, ConstraintTypeNode::Unit)
            | (ConstraintTypeNode::Top, ConstraintTypeNode::Top)
            | (ConstraintTypeNode::Bottom, ConstraintTypeNode::Bottom) => true,
            (ConstraintTypeNode::Opaque(left), ConstraintTypeNode::Opaque(right)) => left == right,
            (
                ConstraintTypeNode::Range {
                    domain: left_domain,
                    low: left_low,
                    high: left_high,
                },
                ConstraintTypeNode::Range {
                    domain: right_domain,
                    low: right_low,
                    high: right_high,
                },
            ) => left_domain == right_domain && left_low == right_low && left_high == right_high,
            (ConstraintTypeNode::Effects(left), ConstraintTypeNode::Effects(right)) => {
                left == right
            }
            (
                ConstraintTypeNode::OpenEffects {
                    labels: left_labels,
                    tail: left_tail,
                },
                ConstraintTypeNode::OpenEffects {
                    labels: right_labels,
                    tail: right_tail,
                },
            ) => {
                left_labels == right_labels
                    && self.same_with_rigids(*left_tail, *right_tail, rigids)
            }
            (
                ConstraintTypeNode::Function {
                    parameter: left_parameter,
                    effects: left_effects,
                    result: left_result,
                },
                ConstraintTypeNode::Function {
                    parameter: right_parameter,
                    effects: right_effects,
                    result: right_result,
                },
            ) => {
                self.same_with_rigids(*left_parameter, *right_parameter, rigids)
                    && self.same_with_rigids(*left_effects, *right_effects, rigids)
                    && self.same_with_rigids(*left_result, *right_result, rigids)
            }
            (ConstraintTypeNode::Record(left), ConstraintTypeNode::Record(right)) => {
                self.same_fields(left, right, rigids)
            }
            (ConstraintTypeNode::Array(left), ConstraintTypeNode::Array(right))
            | (ConstraintTypeNode::Region(left), ConstraintTypeNode::Region(right)) => {
                self.same_with_rigids(*left, *right, rigids)
            }
            (
                ConstraintTypeNode::Variant {
                    cases: left,
                    open: left_open,
                },
                ConstraintTypeNode::Variant {
                    cases: right,
                    open: right_open,
                },
            ) => left_open == right_open && self.same_fields(left, right, rigids),
            (ConstraintTypeNode::Union(left), ConstraintTypeNode::Union(right)) => {
                left.len() == right.len()
                    && left.iter().all(|member| {
                        right
                            .iter()
                            .any(|candidate| self.same_with_rigids(*member, *candidate, rigids))
                    })
            }
            _ => false,
        }
    }

    fn same_fields(
        &self,
        left: &[(String, ConstraintTypeId)],
        right: &[(String, ConstraintTypeId)],
        rigids: &mut Vec<(VariableId, VariableId)>,
    ) -> bool {
        left.len() == right.len()
            && left.iter().all(|(name, type_)| {
                right
                    .iter()
                    .find(|(candidate, _)| candidate == name)
                    .is_some_and(|(_, candidate)| self.same_with_rigids(*type_, *candidate, rigids))
            })
    }
}

#[derive(Clone, Copy)]
enum BoundDirection {
    Lower,
    Upper,
}

#[derive(Clone, Copy)]
struct BoundInsertion {
    variable: VariableId,
    direction: BoundDirection,
}

#[derive(Clone)]
enum Typing {
    Mono(Type),
    Scheme { level: u32, body: Type },
}

#[derive(Clone, Default)]
struct TypeEnvironment {
    names: Rc<BTreeMap<String, Typing>>,
    phases: Rc<BTreeMap<String, Phase>>,
    stable_names: Rc<BTreeMap<String, Typing>>,
    opens: Rc<Vec<OpenedTypes>>,
    forward: Rc<BTreeSet<String>>,
    parent: Option<Rc<TypeEnvironment>>,
}

#[derive(Clone)]
struct OpenedTypes {
    fields: Rc<Vec<(String, Type)>>,
    positions_by_target: Rc<BTreeMap<String, usize>>,
}

impl OpenedTypes {
    fn get(&self, target: &str) -> Option<Type> {
        let position = self.positions_by_target.get(target)?;
        Some(self.fields[*position].1.clone())
    }
}

impl TypeEnvironment {
    fn child(parent: Rc<Self>) -> Self {
        Self {
            names: Rc::new(BTreeMap::new()),
            phases: Rc::new(BTreeMap::new()),
            stable_names: Rc::new(BTreeMap::new()),
            opens: Rc::new(Vec::new()),
            forward: Rc::new(BTreeSet::new()),
            parent: Some(parent),
        }
    }

    fn lookup(&self, name: &str) -> Option<Typing> {
        if let Some(typing) = self.names.get(name) {
            return Some(typing.clone());
        }
        for opened in self.opens.iter().rev() {
            if let Some(type_) = opened.get(name) {
                return Some(Typing::Mono(type_));
            }
        }
        self.parent.as_ref()?.lookup(name)
    }

    fn lookup_stable(&self, name: &str) -> Option<Typing> {
        if let Some(typing) = self.stable_names.get(name) {
            return Some(typing.clone());
        }
        if let Some(typing) = self.names.get(name) {
            return Some(typing.clone());
        }
        for opened in self.opens.iter().rev() {
            if let Some(type_) = opened.get(name) {
                return Some(Typing::Mono(type_));
            }
        }
        self.parent.as_ref()?.lookup_stable(name)
    }

    fn binding_phase(&self, name: &str) -> Option<Phase> {
        if self.names.contains_key(name) {
            return self.phases.get(name).copied();
        }
        if self
            .opens
            .iter()
            .rev()
            .any(|opened| opened.get(name).is_some())
        {
            return Some(Phase::Comptime);
        }
        self.parent.as_ref()?.binding_phase(name)
    }

    fn is_forward(&self, name: &str) -> bool {
        self.forward.contains(name)
            || self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.is_forward(name))
    }
}

#[derive(Clone)]
pub struct CheckedModule {
    pub result: Type,
    pub effects: Type,
    pub parameter: Option<Type>,
    pub evaluated: Option<ValueEnvironment>,
    pub closure_signatures: Vec<(ExpressionId, Type)>,
    pub recursive_closures: Vec<ExpressionId>,
    pub ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
}

#[derive(Clone)]
pub struct CachedModuleInterface {
    types: Rc<FlatTypeArena>,
    result: FlatTypeId,
    effects: FlatTypeId,
    parameter: Option<FlatTypeId>,
    evaluated: Option<ValueEnvironment>,
    closure_signatures: Vec<(ExpressionId, FlatTypeId)>,
    recursive_closures: Vec<ExpressionId>,
    ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
}

pub const CHECKED_MODULE_CERTIFICATE_SCHEMA: u32 = 5;

#[derive(Clone, Deserialize, Serialize)]
pub struct CheckedModuleCertificate {
    schema: u32,
    types: Vec<FlatTypeNode>,
    result: FlatTypeId,
    effects: FlatTypeId,
    parameter: Option<FlatTypeId>,
    closure_signatures: Vec<(ExpressionId, FlatTypeId)>,
    recursive_closures: Vec<ExpressionId>,
    ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct FlatTypeId(u32);

#[derive(Clone, Deserialize, Serialize)]
enum FlatTypeNode {
    Rigid(VariableId),
    Forall {
        variables: Vec<VariableId>,
        body: FlatTypeId,
    },
    Range {
        domain: Domain,
        low: Option<Scalar>,
        high: Option<Scalar>,
    },
    Unit,
    Function {
        parameter: FlatTypeId,
        effects: FlatTypeId,
        result: FlatTypeId,
    },
    Record(Vec<(String, FlatTypeId)>),
    Array(FlatTypeId),
    Region(FlatTypeId),
    Variant {
        cases: Vec<(String, FlatTypeId)>,
        open: bool,
    },
    Effects(BTreeSet<String>),
    OpenEffects {
        labels: BTreeSet<String>,
        tail: FlatTypeId,
    },
    Union(Vec<FlatTypeId>),
    Opaque(String),
    Top,
    Bottom,
}

struct FlatTypeArena {
    nodes: Vec<FlatTypeNode>,
}

impl FlatTypeArena {
    fn node(&self, id: FlatTypeId) -> &FlatTypeNode {
        &self.nodes[id.0 as usize]
    }
}

impl CachedModuleInterface {
    fn from_checked(checked: &CheckedModule) -> Option<Self> {
        let mut nodes = Vec::new();
        let mut bound = HashSet::new();
        let result = flatten_interface_type(&checked.result, &mut bound, &mut nodes)?;
        let effects = flatten_interface_type(&checked.effects, &mut bound, &mut nodes)?;
        let parameter = match &checked.parameter {
            Some(parameter) => Some(flatten_interface_type(parameter, &mut bound, &mut nodes)?),
            None => None,
        };
        let closure_signatures = checked
            .closure_signatures
            .iter()
            .map(|(body, signature)| {
                Some((
                    *body,
                    flatten_interface_type(signature, &mut bound, &mut nodes)?,
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            types: Rc::new(FlatTypeArena { nodes }),
            result,
            effects,
            parameter,
            evaluated: checked.evaluated.clone(),
            closure_signatures,
            recursive_closures: checked.recursive_closures.clone(),
            ownership_contracts: checked.ownership_contracts.clone(),
        })
    }

    fn certificate(&self) -> CheckedModuleCertificate {
        CheckedModuleCertificate {
            schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            types: self.types.nodes.clone(),
            result: self.result,
            effects: self.effects,
            parameter: self.parameter,
            closure_signatures: self.closure_signatures.clone(),
            recursive_closures: self.recursive_closures.clone(),
            ownership_contracts: self.ownership_contracts.clone(),
        }
    }

    fn from_certificate(certificate: CheckedModuleCertificate) -> Result<Self, String> {
        certificate.validate()?;
        Ok(Self {
            types: Rc::new(FlatTypeArena {
                nodes: certificate.types,
            }),
            result: certificate.result,
            effects: certificate.effects,
            parameter: certificate.parameter,
            evaluated: None,
            closure_signatures: certificate.closure_signatures,
            recursive_closures: certificate.recursive_closures,
            ownership_contracts: certificate.ownership_contracts,
        })
    }
}

impl CheckedModuleCertificate {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != CHECKED_MODULE_CERTIFICATE_SCHEMA {
            return Err(format!(
                "checked-module certificate schema is {}, expected {}",
                self.schema, CHECKED_MODULE_CERTIFICATE_SCHEMA
            ));
        }
        let arena = FlatTypeArena {
            nodes: self.types.clone(),
        };
        validate_certificate_type(&arena, self.result, &mut HashSet::new())?;
        validate_certificate_type(&arena, self.effects, &mut HashSet::new())?;
        if let Some(parameter) = self.parameter {
            validate_certificate_type(&arena, parameter, &mut HashSet::new())?;
        }
        for (_, signature) in &self.closure_signatures {
            validate_certificate_type(&arena, *signature, &mut HashSet::new())?;
        }
        let closure_bodies = self
            .closure_signatures
            .iter()
            .map(|(body, _)| *body)
            .collect::<HashSet<_>>();
        let mut recursive_bodies = HashSet::new();
        for body in &self.recursive_closures {
            if !closure_bodies.contains(body) {
                return Err(format!(
                    "checked-module certificate marks unknown closure expression {} as recursive",
                    body.0
                ));
            }
            if !recursive_bodies.insert(*body) {
                return Err(format!(
                    "checked-module certificate repeats recursive closure expression {}",
                    body.0
                ));
            }
        }
        let mut ownership_bodies = HashSet::new();
        for (body, _) in &self.ownership_contracts {
            if !closure_bodies.contains(body) {
                return Err(format!(
                    "checked-module certificate has an ownership contract for unknown closure expression {}",
                    body.0
                ));
            }
            if !ownership_bodies.insert(*body) {
                return Err(format!(
                    "checked-module certificate repeats ownership contract for closure expression {}",
                    body.0
                ));
            }
        }
        Ok(())
    }
}

fn validate_certificate_type(
    arena: &FlatTypeArena,
    type_: FlatTypeId,
    bound: &mut HashSet<VariableId>,
) -> Result<(), String> {
    let index = type_.0 as usize;
    let node = arena
        .nodes
        .get(index)
        .ok_or_else(|| format!("checked-module certificate references missing type {index}"))?;
    let validate_child =
        |child: FlatTypeId, bound: &mut HashSet<VariableId>| -> Result<(), String> {
            if child.0 >= type_.0 {
                return Err(format!(
                    "checked-module certificate type {} references non-prior type {}",
                    type_.0, child.0
                ));
            }
            validate_certificate_type(arena, child, bound)
        };
    match node {
        FlatTypeNode::Rigid(variable) => {
            if !bound.contains(variable) {
                return Err(format!(
                    "checked-module certificate contains free rigid variable {variable}"
                ));
            }
        }
        FlatTypeNode::Forall { variables, body } => {
            let mut inserted = Vec::with_capacity(variables.len());
            for variable in variables {
                if !bound.insert(*variable) {
                    return Err(format!(
                        "checked-module certificate rebinds rigid variable {variable}"
                    ));
                }
                inserted.push(*variable);
            }
            validate_child(*body, bound)?;
            for variable in inserted {
                bound.remove(&variable);
            }
        }
        FlatTypeNode::Function {
            parameter,
            effects,
            result,
        } => {
            validate_child(*parameter, bound)?;
            validate_child(*effects, bound)?;
            validate_child(*result, bound)?;
        }
        FlatTypeNode::Record(fields) | FlatTypeNode::Variant { cases: fields, .. } => {
            for (_, field) in fields {
                validate_child(*field, bound)?;
            }
        }
        FlatTypeNode::Array(element) | FlatTypeNode::Region(element) => {
            validate_child(*element, bound)?;
        }
        FlatTypeNode::OpenEffects { tail, .. } => {
            validate_child(*tail, bound)?;
        }
        FlatTypeNode::Union(members) => {
            for member in members {
                validate_child(*member, bound)?;
            }
        }
        FlatTypeNode::Range { .. }
        | FlatTypeNode::Unit
        | FlatTypeNode::Effects(_)
        | FlatTypeNode::Opaque(_)
        | FlatTypeNode::Top
        | FlatTypeNode::Bottom => {}
    }
    Ok(())
}

#[derive(Clone)]
pub struct CachedModuleAnalyses {
    ownership: Result<(), Diagnostic>,
    ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
    safety: Result<(), Diagnostic>,
}

pub struct Checker {
    context: Rc<Context>,
    variables: RefCell<Vec<Variable>>,
    constraint_types: RefCell<ConstraintTypeArena>,
    bound_insertions: RefCell<Vec<BoundInsertion>>,
    next_skolem: Cell<VariableId>,
    next_representation_hole: Cell<VariableId>,
    level: Cell<u32>,
    phase: Cell<Phase>,
    specialization_depth: Cell<u32>,
    modules: RefCell<HashMap<String, Result<CheckedModule, Diagnostic>>>,
    active: RefCell<Vec<String>>,
    closure_types: RefCell<HashMap<(String, ExpressionId), Type>>,
    recursive_closure_bodies: RefCell<HashSet<(String, ExpressionId)>>,
    incomplete_evaluations: RefCell<HashSet<String>>,
    module_interfaces: Rc<RefCell<HashMap<String, CachedModuleInterface>>>,
    module_analyses: Rc<RefCell<HashMap<String, CachedModuleAnalyses>>>,
}

impl Checker {
    #[cfg(test)]
    pub fn new(context: Rc<Context>) -> Self {
        Self::with_caches(
            context,
            Rc::new(RefCell::new(HashMap::new())),
            Rc::new(RefCell::new(HashMap::new())),
        )
    }

    pub fn with_caches(
        context: Rc<Context>,
        module_interfaces: Rc<RefCell<HashMap<String, CachedModuleInterface>>>,
        module_analyses: Rc<RefCell<HashMap<String, CachedModuleAnalyses>>>,
    ) -> Self {
        Self {
            context,
            variables: RefCell::new(Vec::new()),
            constraint_types: RefCell::new(ConstraintTypeArena::default()),
            bound_insertions: RefCell::new(Vec::new()),
            next_skolem: Cell::new(0x8000_0000),
            next_representation_hole: Cell::new(u32::MAX),
            level: Cell::new(0),
            phase: Cell::new(Phase::Runtime),
            specialization_depth: Cell::new(0),
            modules: RefCell::new(HashMap::new()),
            active: RefCell::new(Vec::new()),
            closure_types: RefCell::new(HashMap::new()),
            recursive_closure_bodies: RefCell::new(HashSet::new()),
            incomplete_evaluations: RefCell::new(HashSet::new()),
            module_interfaces,
            module_analyses,
        }
    }

    pub fn check(&self, path: &str) -> Result<CheckedModule, Diagnostic> {
        if let Some(checked) = self.modules.borrow().get(path) {
            return checked.clone();
        }
        if let Some(cached) = self.module_interfaces.borrow().get(path).cloned() {
            let checked = self.inflate_interface(path, cached);
            self.modules
                .borrow_mut()
                .insert(path.to_owned(), Ok(checked.clone()));
            return Ok(checked);
        }
        if self.active.borrow().iter().any(|active| active == path) {
            return Err(Diagnostic::new(
                "BLOT_IMPORT_CYCLE",
                format!("Import cycle reaches `{path}`."),
                Span { start: 0, end: 0 },
            ));
        }
        self.active.borrow_mut().push(path.to_owned());
        let result = self
            .check_uncached(path)
            .map_err(|diagnostic| diagnostic.at(path));
        self.active.borrow_mut().pop();
        if result.is_err() {
            self.context.evaluated_bindings.borrow_mut().remove(path);
        }
        self.modules
            .borrow_mut()
            .insert(path.to_owned(), result.clone());
        if let Ok(checked) = &result
            && let Some(interface) = CachedModuleInterface::from_checked(checked)
        {
            self.module_interfaces
                .borrow_mut()
                .insert(path.to_owned(), interface);
        }
        result
    }

    pub fn certificate(&self, path: &str) -> Result<CheckedModuleCertificate, String> {
        let checked = self.check(path).map_err(|diagnostic| {
            format!(
                "cannot certify module {path}: {} ({})",
                diagnostic.message, diagnostic.code
            )
        })?;
        let interface = match CachedModuleInterface::from_checked(&checked) {
            Some(interface) => interface,
            None => {
                for (body, signature) in &checked.closure_signatures {
                    if !closed_checked_type(signature, &mut HashSet::new()) {
                        return Err(format!(
                            "module {path} closure expression {} has an open checked signature: {signature:?}",
                            body.0
                        ));
                    }
                }
                for (name, type_) in [
                    ("result", Some(&checked.result)),
                    ("effects", Some(&checked.effects)),
                    ("parameter", checked.parameter.as_ref()),
                ] {
                    if let Some(type_) = type_
                        && flatten_interface_type(type_, &mut HashSet::new(), &mut Vec::new())
                            .is_none()
                    {
                        return Err(format!(
                            "module {path} has an open checked {name}: {type_:?}"
                        ));
                    }
                }
                return Err(format!("module {path} has no closed checked interface"));
            }
        };
        Ok(interface.certificate())
    }

    pub fn install_certificate(
        &self,
        path: &str,
        certificate: CheckedModuleCertificate,
    ) -> Result<(), String> {
        if !self.context.modules.borrow().contains_key(path) {
            return Err(format!(
                "cannot install checked-module certificate for unknown module {path}"
            ));
        }
        let module = self
            .context
            .modules
            .borrow()
            .get(path)
            .expect("checked module presence was tested")
            .module
            .clone();
        crate::ownership::validate_contracts(&module, &certificate.ownership_contracts)?;
        let interface = CachedModuleInterface::from_certificate(certificate)?;
        self.module_interfaces
            .borrow_mut()
            .insert(path.to_owned(), interface);
        self.modules.borrow_mut().remove(path);
        Ok(())
    }

    pub fn begin_request(&self) {
        let interfaces = self.module_interfaces.borrow();
        self.modules
            .borrow_mut()
            .retain(|path, result| result.is_ok() && interfaces.contains_key(path));
    }

    pub fn invalidate(&self, paths: &HashSet<String>) {
        self.modules
            .borrow_mut()
            .retain(|path, _| !paths.contains(path));
        self.closure_types
            .borrow_mut()
            .retain(|(path, _), _| !paths.contains(path));
        self.recursive_closure_bodies
            .borrow_mut()
            .retain(|(path, _)| !paths.contains(path));
        self.incomplete_evaluations
            .borrow_mut()
            .retain(|path| !paths.contains(path));
        self.context
            .ownership_contracts
            .borrow_mut()
            .retain(|(path, _), _| !paths.contains(path));
    }

    pub fn check_json(&self, path: &str) -> serde_json::Value {
        match self.check(path) {
            Ok(checked) => {
                let effects = self.settle(checked.effects.clone(), true);
                serde_json::json!({
                    "ok": true,
                    "type": self.show(&checked.result),
                    "effects": show_effects(&effects),
                })
            }
            Err(diagnostic) => serde_json::json!({
                "ok": false,
                "diagnostic": {
                    "code": diagnostic.code,
                    "message": diagnostic.message,
                    "origin": diagnostic.origin,
                    "span": {
                        "start": diagnostic.span.start,
                        "end": diagnostic.span.end,
                    },
                },
            }),
        }
    }

    fn check_uncached(&self, path: &str) -> Result<CheckedModule, Diagnostic> {
        let loaded = self
            .context
            .modules
            .borrow()
            .get(path)
            .cloned()
            .ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_UNRESOLVED_IMPORT",
                    format!("Module `{path}` was not loaded."),
                    Span { start: 0, end: 0 },
                )
            })?;
        let mut dependency_types = BTreeMap::new();
        for (specifier, dependency) in &loaded.imports {
            let checked = self.check(dependency)?;
            dependency_types.insert(
                specifier.clone(),
                Type::Function {
                    parameter: Box::new(checked.parameter.unwrap_or(Type::Unit)),
                    effects: Box::new(checked.effects),
                    result: Box::new(checked.result),
                },
            );
        }
        let mut types = TypeEnvironment::default();
        let values = child_env(None);
        let parameter = loaded.module.parameter.map(|pattern| {
            let parameter = self.fresh();
            // The entry authority survives hoisting: projections from it
            // become host imports rather than runtime-frame captures.
            self.bind_pattern_at_phase(
                &loaded.module,
                pattern,
                parameter.clone(),
                &mut types,
                Phase::Comptime,
            );
            parameter
        });
        let mut signatures = BTreeMap::<String, Type>::new();
        let mut effects = Type::Effects(BTreeSet::new());
        types.forward = Rc::new(future_binding_names(
            &loaded.module,
            &loaded.module.declarations,
        ));
        for (index, declaration_id) in loaded.module.declarations.iter().enumerate() {
            remove_declaration_names(
                &loaded.module,
                *declaration_id,
                Rc::make_mut(&mut types.forward),
            );
            prebind_recursive_group(
                path,
                &loaded.module,
                &loaded.module.declarations,
                index,
                &mut types,
                self,
            )?;
            let declaration = loaded.module.arena.declarations[declaration_id.0 as usize].clone();
            let declaration_effects = self.check_declaration(
                path,
                &loaded.module,
                declaration,
                &mut types,
                &values,
                &dependency_types,
                &mut signatures,
            )?;
            effects = self.join_effects(effects, declaration_effects)?;
        }
        let inferred = self.infer(
            path,
            &loaded.module,
            loaded.module.result,
            &types,
            &values,
            &dependency_types,
        )?;
        effects = self.join_effects(effects, inferred.effects)?;
        let effects = self.settle(effects, true);
        if let Type::Effects(labels) = &effects
            && labels.iter().any(|label| !label.starts_with("host:"))
        {
            let escaping = labels
                .iter()
                .filter(|label| !label.starts_with("host:"))
                .cloned()
                .collect::<Vec<_>>();
            return Err(Diagnostic::new(
                "BLOT_UNHANDLED_EFFECT",
                format!(
                    "Nothing handles {{ {} }} at the module boundary.",
                    escaping.join(", ")
                ),
                loaded.module.span,
            ));
        }
        let analyses = self.cached_analyses(path, &loaded.module, &values);
        analyses.ownership?;
        analyses.safety?;
        let mut analyzed_closure_signatures = self
            .closure_types
            .borrow()
            .iter()
            .filter(|((module, _), _)| module == path)
            .map(|((_, body), type_)| {
                let (signature, type_recursive) = self.residual_signature_analysis(type_.clone());
                let recursive = type_recursive
                    || self
                        .recursive_closure_bodies
                        .borrow()
                        .contains(&(path.to_owned(), *body));
                (*body, signature, recursive)
            })
            .collect::<Vec<_>>();
        analyzed_closure_signatures.sort_by_key(|(body, _, _)| body.0);
        let recursive_closures = analyzed_closure_signatures
            .iter()
            .filter_map(|(body, _, recursive)| recursive.then_some(*body))
            .collect::<Vec<_>>();
        let closure_signatures = analyzed_closure_signatures
            .into_iter()
            .map(|(body, signature, _)| (body, signature))
            .collect::<Vec<_>>();
        let reified_closure_signatures = closure_signatures
            .iter()
            .filter_map(|(body, type_)| {
                self.reify_runtime_type(type_)
                    .map(|signature| ((path.to_owned(), *body), signature))
            })
            .collect::<Vec<_>>();
        self.context
            .closure_signatures
            .borrow_mut()
            .extend(reified_closure_signatures);
        self.context.recursive_closures.borrow_mut().extend(
            recursive_closures
                .iter()
                .map(|body| (path.to_owned(), *body)),
        );
        self.context.ownership_contracts.borrow_mut().extend(
            analyses
                .ownership_contracts
                .iter()
                .map(|(body, contract)| ((path.to_owned(), *body), contract.clone())),
        );
        let checked = CheckedModule {
            result: self.settle(inferred.type_, true),
            effects,
            parameter: parameter.map(|parameter| self.settle(parameter, false)),
            evaluated: (!self.incomplete_evaluations.borrow().contains(path)).then_some(values),
            closure_signatures,
            recursive_closures,
            ownership_contracts: analyses.ownership_contracts,
        };
        self.cache_module_result(path, &loaded.module, &checked);
        Ok(checked)
    }

    fn cached_analyses(
        &self,
        path: &str,
        module: &Module,
        values: &ValueEnvironment,
    ) -> CachedModuleAnalyses {
        if let Some(cached) = self.module_analyses.borrow().get(path) {
            return cached.clone();
        }
        let ownership = crate::ownership::check(module, &self.context, values);
        let analyses = CachedModuleAnalyses {
            ownership: ownership.diagnostics.into_iter().next().map_or(Ok(()), Err),
            ownership_contracts: ownership.contracts,
            safety: crate::safety::check(module, &self.context, values)
                .into_iter()
                .next()
                .map_or(Ok(()), Err),
        };
        if module.parameter.is_none() {
            self.module_analyses
                .borrow_mut()
                .insert(path.to_owned(), analyses.clone());
        }
        analyses
    }

    fn cache_module_result(&self, path: &str, module: &Module, checked: &CheckedModule) {
        if module.parameter.is_some() || !empty_effects(&checked.effects) {
            return;
        }
        let Some(environment) = &checked.evaluated else {
            return;
        };
        let result = run(evaluate_expression(
            self.context.clone(),
            Rc::new(path.to_owned()),
            module.result,
            environment.clone(),
            Runtime::new(Phase::Comptime, path.to_owned()),
        ));
        if let Ok(value) = result {
            self.context
                .module_results
                .borrow_mut()
                .insert(path.to_owned(), value);
        }
    }

    fn inflate_interface(&self, path: &str, cached: CachedModuleInterface) -> CheckedModule {
        let mut rigids = HashMap::new();
        let closure_signatures = cached
            .closure_signatures
            .iter()
            .map(|(body, signature)| {
                (
                    *body,
                    self.inflate_interface_type(&cached.types, *signature, &mut rigids),
                )
            })
            .collect::<Vec<_>>();
        self.context
            .closure_signatures
            .borrow_mut()
            .extend(closure_signatures.iter().filter_map(|(body, type_)| {
                self.reify_runtime_type(type_)
                    .map(|signature| ((path.to_owned(), *body), signature))
            }));
        self.context.recursive_closures.borrow_mut().extend(
            cached
                .recursive_closures
                .iter()
                .map(|body| (path.to_owned(), *body)),
        );
        self.context.ownership_contracts.borrow_mut().extend(
            cached
                .ownership_contracts
                .iter()
                .map(|(body, contract)| ((path.to_owned(), *body), contract.clone())),
        );
        CheckedModule {
            result: self.inflate_interface_type(&cached.types, cached.result, &mut rigids),
            effects: self.inflate_interface_type(&cached.types, cached.effects, &mut rigids),
            parameter: cached.parameter.map(|parameter| {
                self.inflate_interface_type(&cached.types, parameter, &mut rigids)
            }),
            evaluated: cached.evaluated,
            closure_signatures,
            recursive_closures: cached.recursive_closures,
            ownership_contracts: cached.ownership_contracts,
        }
    }

    fn inflate_interface_type(
        &self,
        arena: &FlatTypeArena,
        type_: FlatTypeId,
        rigids: &mut HashMap<VariableId, VariableId>,
    ) -> Type {
        match arena.node(type_) {
            FlatTypeNode::Rigid(id) => Type::Rigid(*rigids.get(id).unwrap_or(id)),
            FlatTypeNode::Forall { variables, body } => {
                let mut fresh_variables = Vec::with_capacity(variables.len());
                let mut previous = Vec::with_capacity(variables.len());
                for variable in variables {
                    let fresh = self.next_skolem.get();
                    self.next_skolem.set(fresh + 1);
                    previous.push((*variable, rigids.insert(*variable, fresh)));
                    fresh_variables.push(fresh);
                }
                let body = self.inflate_interface_type(arena, *body, rigids);
                for (variable, prior) in previous {
                    match prior {
                        Some(prior) => {
                            rigids.insert(variable, prior);
                        }
                        None => {
                            rigids.remove(&variable);
                        }
                    }
                }
                Type::Forall {
                    variables: fresh_variables,
                    body: Box::new(body),
                }
            }
            FlatTypeNode::Function {
                parameter,
                effects,
                result,
            } => Type::Function {
                parameter: Box::new(self.inflate_interface_type(arena, *parameter, rigids)),
                effects: Box::new(self.inflate_interface_type(arena, *effects, rigids)),
                result: Box::new(self.inflate_interface_type(arena, *result, rigids)),
            },
            FlatTypeNode::Record(fields) => Type::Record(
                fields
                    .iter()
                    .map(|(name, type_)| {
                        (
                            name.clone(),
                            self.inflate_interface_type(arena, *type_, rigids),
                        )
                    })
                    .collect(),
            ),
            FlatTypeNode::Array(element) => Type::Array(Box::new(
                self.inflate_interface_type(arena, *element, rigids),
            )),
            FlatTypeNode::Region(element) => Type::Region(Box::new(
                self.inflate_interface_type(arena, *element, rigids),
            )),
            FlatTypeNode::Variant { cases, open } => Type::Variant {
                cases: cases
                    .iter()
                    .map(|(name, type_)| {
                        (
                            name.clone(),
                            self.inflate_interface_type(arena, *type_, rigids),
                        )
                    })
                    .collect(),
                open: *open,
            },
            FlatTypeNode::Union(members) => Type::Union(
                members
                    .iter()
                    .map(|member| self.inflate_interface_type(arena, *member, rigids))
                    .collect(),
            ),
            FlatTypeNode::Range { domain, low, high } => Type::Range {
                domain: *domain,
                low: low.clone(),
                high: high.clone(),
            },
            FlatTypeNode::Unit => Type::Unit,
            FlatTypeNode::Effects(labels) => Type::Effects(labels.clone()),
            FlatTypeNode::OpenEffects { labels, tail } => Type::OpenEffects {
                labels: labels.clone(),
                tail: Box::new(self.inflate_interface_type(arena, *tail, rigids)),
            },
            FlatTypeNode::Opaque(name) => Type::Opaque(name.clone()),
            FlatTypeNode::Top => Type::Top,
            FlatTypeNode::Bottom => Type::Bottom,
        }
    }

    fn refuse_runtime_const_captures(
        &self,
        path: &str,
        value: &Value,
        environment: &TypeEnvironment,
        source: &Module,
        binding_name: Option<&str>,
        span: Span,
    ) -> Result<(), Diagnostic> {
        match value {
            Value::Closure {
                module,
                parameter,
                body,
                self_name,
                ..
            } => {
                // A dependency checks closures in its own lexical type
                // environment. Names from another module cannot be classified
                // by this module's same-spelled bindings.
                if module.as_str() != path {
                    return Ok(());
                }
                for name in closure_free_names(
                    &self.context,
                    path,
                    *parameter,
                    *body,
                    self_name.as_deref(),
                )? {
                    if environment.binding_phase(&name) != Some(Phase::Runtime) {
                        continue;
                    }
                    let Some(capture_span) = closure_free_name_span(
                        source,
                        *parameter,
                        *body,
                        self_name.as_deref(),
                        &name,
                    ) else {
                        // `closure_free_names` is deliberately conservative
                        // around pinned patterns. A name with no unbound source
                        // occurrence is local, not a runtime capture.
                        continue;
                    };
                    let mut binding = "this compile-time closure".to_owned();
                    if let Some(binding_name) = binding_name {
                        binding = format!("the compile-time closure `{binding_name}`");
                    }
                    return Err(Diagnostic::new(
                        "BLOT_CONST_CAPTURES_RUNTIME",
                        format!(
                            "`{name}` is a runtime binding, so it has no value at compile time and {binding} cannot capture it. Write a `let` binding for the closure, or make `{name}` available with `const`."
                        ),
                        capture_span,
                    ));
                }
            }
            Value::Shape(fields)
            | Value::Effect {
                operations: fields, ..
            } => {
                for (_, member) in fields {
                    self.refuse_runtime_const_captures(
                        path,
                        member,
                        environment,
                        source,
                        binding_name,
                        span,
                    )?;
                }
            }
            Value::Array(elements) | Value::Union(elements) | Value::IndexedStep { elements } => {
                for element in elements {
                    self.refuse_runtime_const_captures(
                        path,
                        element,
                        environment,
                        source,
                        binding_name,
                        span,
                    )?;
                }
            }
            Value::RegionType(inner)
            | Value::EmptyArray { element: inner }
            | Value::Forall { body: inner, .. }
            | Value::Sealed { inner, .. } => {
                self.refuse_runtime_const_captures(
                    path,
                    inner,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
            }
            Value::Tag {
                payload: Some(payload),
                ..
            } => {
                self.refuse_runtime_const_captures(
                    path,
                    payload,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
            }
            Value::Primitive { applied, .. } => {
                for argument in applied {
                    self.refuse_runtime_const_captures(
                        path,
                        argument,
                        environment,
                        source,
                        binding_name,
                        span,
                    )?;
                }
            }
            Value::Range { low, high, .. } => {
                self.refuse_runtime_const_captures(
                    path,
                    low,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
                self.refuse_runtime_const_captures(
                    path,
                    high,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
            }
            Value::Arrow {
                domain,
                codomain,
                effects,
                ..
            } => {
                self.refuse_runtime_const_captures(
                    path,
                    domain,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
                self.refuse_runtime_const_captures(
                    path,
                    codomain,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
                for effect in effects {
                    self.refuse_runtime_const_captures(
                        path,
                        effect,
                        environment,
                        source,
                        binding_name,
                        span,
                    )?;
                }
            }
            Value::Operation { effect, .. } => {
                self.refuse_runtime_const_captures(
                    path,
                    effect,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
            }
            Value::Extended { inner, members } => {
                self.refuse_runtime_const_captures(
                    path,
                    inner,
                    environment,
                    source,
                    binding_name,
                    span,
                )?;
                for (_, member) in members {
                    self.refuse_runtime_const_captures(
                        path,
                        member,
                        environment,
                        source,
                        binding_name,
                        span,
                    )?;
                }
            }
            Value::Runtime(_)
            | Value::ClosureChoice { .. }
            | Value::Region { .. }
            | Value::RegionRejoin { .. }
            | Value::Continuation { .. } => {
                return Err(Diagnostic::new(
                    "BLOT_CONST_CAPTURES_RUNTIME",
                    "A compile-time value contains a runtime value that is not available while the `const` is created.",
                    span,
                ));
            }
            _ => {}
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn check_declaration(
        &self,
        path: &str,
        module: &Module,
        declaration: Declaration,
        types: &mut TypeEnvironment,
        values: &ValueEnvironment,
        dependencies: &BTreeMap<String, Type>,
        signatures: &mut BTreeMap<String, Type>,
    ) -> Result<Type, Diagnostic> {
        match declaration {
            Declaration::Binding {
                kind: DeclarationKind::Sig,
                pattern,
                value,
                span,
                ..
            } => {
                let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] else {
                    return Err(Diagnostic::new(
                        "BLOT_SIG_PATTERN",
                        "A signature must name one binding.",
                        span,
                    ));
                };
                let signature_value = self.evaluate(path, value, values, Phase::Comptime)?;
                let signature = self.bridge(&signature_value).ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_SIG_NOT_A_TYPE",
                        format!("The signature for `{name}` is not a type value."),
                        span,
                    )
                })?;
                if let Some(unrepresentable) = unrepresentable_integer(&signature) {
                    return Err(Diagnostic::new(
                        "BLOT_UNREPRESENTABLE_INTEGER",
                        format!(
                            "Runtime signature `{name}` contains {}, which has inhabitants outside signed i64.",
                            self.show(unrepresentable)
                        ),
                        span,
                    ));
                }
                signatures.insert(name.clone(), signature);
                Ok(Type::Effects(BTreeSet::new()))
            }
            Declaration::Binding {
                kind,
                tags,
                pattern,
                value,
                span,
            } => {
                for tag in tags {
                    let descriptor = self
                        .evaluate(path, tag.descriptor, values, Phase::Comptime)
                        .map_err(|_| {
                            Diagnostic::new(
                                "BLOT_NOT_COMPTIME",
                                "A declaration tag descriptor must be known at compile time.",
                                tag.span,
                            )
                        })?;
                    validate_declaration_tag(&descriptor, tag.span)?;
                }
                let recursive = matches!(
                    module.arena.expressions[value.0 as usize],
                    Expression::Rec { .. }
                );
                if recursive {
                    let Expression::Rec { lambda, .. } = module.arena.expressions[value.0 as usize]
                    else {
                        unreachable!();
                    };
                    if !matches!(
                        module.arena.expressions[lambda.0 as usize],
                        Expression::Lambda { .. }
                    ) {
                        return Err(Diagnostic::new(
                            "BLOT_TYPE_ERROR",
                            "A recursive binding must bind a function.",
                            span,
                        ));
                    }
                    for name in pattern_names(module, pattern) {
                        Rc::make_mut(&mut types.names)
                            .entry(name.clone())
                            .or_insert_with(|| Typing::Mono(self.fresh()));
                        Rc::make_mut(&mut types.phases).insert(
                            name.clone(),
                            if kind == DeclarationKind::Const {
                                Phase::Comptime
                            } else {
                                Phase::Runtime
                            },
                        );
                    }
                }
                let names = pattern_names(module, pattern);
                let signature = if names.len() == 1 {
                    signatures.remove(&names[0])
                } else {
                    None
                };
                if signature.is_some()
                    && expression_has_generic_reflection(module, value, &mut Vec::new())
                {
                    return Err(Diagnostic::new(
                        "BLOT_REFLECTION_NOT_INDEXED",
                        "A generic reflection result cannot prove a runtime signature.",
                        span,
                    ));
                }
                self.level.set(self.level.get() + 1);
                let previous_phase = self.phase.get();
                if kind == DeclarationKind::Const {
                    self.phase.set(Phase::Comptime);
                }
                let inferred = match (&signature, kind) {
                    (Some(expected), declaration_kind)
                        if declaration_kind != DeclarationKind::Effect =>
                    {
                        self.infer_against(
                            path,
                            module,
                            value,
                            expected.clone(),
                            types,
                            values,
                            dependencies,
                            span,
                        )
                    }
                    _ => self.infer(path, module, value, types, values, dependencies),
                };
                self.phase.set(previous_phase);
                self.level.set(self.level.get() - 1);
                let mut inferred = inferred?;
                if kind == DeclarationKind::Effect
                    && let Some((suspended_effects, result)) =
                        self.effect_value_signature(&inferred.type_)
                {
                    inferred.effects = self.join_effects(inferred.effects, suspended_effects)?;
                    inferred.type_ = result;
                }
                if kind != DeclarationKind::Effect {
                    self.constrain(
                        inferred.effects.clone(),
                        Type::Effects(BTreeSet::new()),
                        span,
                    )
                    .map_err(|_| {
                        Diagnostic::new(
                            "BLOT_UNSEQUENCED_EFFECT",
                            "A declaration value performs an effect. Sequence it with `name <- expression;` instead.",
                            span,
                        )
                    })?;
                    inferred.effects = Type::Effects(BTreeSet::new());
                }
                let evaluated = if kind == DeclarationKind::Const {
                    match self.evaluate_binding(
                        path,
                        module,
                        pattern,
                        value,
                        values,
                        Phase::Comptime,
                    ) {
                        Ok(value) => Some(value),
                        Err(error) if error.code == "BLOT_UNBOUND" => {
                            self.incomplete_evaluations
                                .borrow_mut()
                                .insert(path.to_owned());
                            None
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    match self.evaluate_binding(
                        path,
                        module,
                        pattern,
                        value,
                        values,
                        Phase::Runtime,
                    ) {
                        Ok(value) if kind == DeclarationKind::Effect => {
                            match run(force_effect_value(
                                self.context.clone(),
                                value,
                                span,
                                Runtime::new(Phase::Runtime, path.to_owned()),
                            )) {
                                Ok(value) => Some(value),
                                Err(_) => {
                                    self.incomplete_evaluations
                                        .borrow_mut()
                                        .insert(path.to_owned());
                                    None
                                }
                            }
                        }
                        Ok(value) => Some(value),
                        Err(_) => {
                            self.incomplete_evaluations
                                .borrow_mut()
                                .insert(path.to_owned());
                            None
                        }
                    }
                };
                if kind == DeclarationKind::Const
                    && let Some(value) = &evaluated
                {
                    let binding_name = if names.len() == 1 {
                        Some(names[0].as_str())
                    } else {
                        None
                    };
                    self.refuse_runtime_const_captures(
                        path,
                        value,
                        types,
                        module,
                        binding_name,
                        span,
                    )?;
                }
                if signature.is_none()
                    && kind == DeclarationKind::Const
                    && !matches!(
                        module.arena.expressions[value.0 as usize],
                        Expression::Lambda { .. } | Expression::Rec { .. }
                    )
                    && let Some(exact) = evaluated.as_ref().and_then(|value| self.bridge(value))
                {
                    inferred.type_ = exact;
                } else if signature.is_none()
                    && kind == DeclarationKind::Const
                    && !matches!(
                        module.arena.expressions[value.0 as usize],
                        Expression::Lambda { .. } | Expression::Rec { .. }
                    )
                    && let Some(Value::Closure {
                        module: closure_module,
                        parameter,
                        body,
                        environment: closure_values,
                        self_name,
                        deferred,
                        ..
                    }) = evaluated.as_ref()
                {
                    let previous_phase = self.phase.replace(Phase::Comptime);
                    let selected = self.infer_evaluated_closure(
                        path,
                        module,
                        closure_module,
                        *parameter,
                        *body,
                        closure_values,
                        self_name.as_deref(),
                        *deferred,
                        types,
                        dependencies,
                    );
                    self.phase.set(previous_phase);
                    inferred.type_ = selected?;
                }
                let recursive_bounds = if recursive {
                    names
                        .iter()
                        .filter_map(|name| match types.lookup(name) {
                            Some(Typing::Mono(bound)) => Some(bound),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
                if let Some(signature) = signature {
                    if kind == DeclarationKind::Effect {
                        self.constrain(inferred.type_.clone(), signature.clone(), span)?;
                    }
                    inferred.type_ = signature;
                }
                for bound in recursive_bounds {
                    self.constrain(inferred.type_.clone(), bound, span)?;
                }
                self.bind_pattern(module, pattern, inferred.type_.clone(), types);
                let binding_phase = if kind == DeclarationKind::Const {
                    Phase::Comptime
                } else {
                    Phase::Runtime
                };
                for name in &names {
                    Rc::make_mut(&mut types.phases).insert(name.clone(), binding_phase);
                }
                let settled_signature = if matches!(
                    module.arena.expressions[value.0 as usize],
                    Expression::Lambda { .. } | Expression::Rec { .. }
                ) {
                    self.residual_signature(inferred.type_.clone())
                } else {
                    self.settle(inferred.type_.clone(), true)
                };
                let inferred_signature = self.reify_runtime_type(&settled_signature);
                for name in names {
                    let body = match types.lookup(&name) {
                        Some(Typing::Mono(type_)) => type_,
                        Some(Typing::Scheme { body, .. }) => body,
                        None => {
                            return Err(Diagnostic::new(
                                "BLOT_BINDING_MISMATCH",
                                format!("The declaration pattern did not bind `{name}`."),
                                span,
                            ));
                        }
                    };
                    Rc::make_mut(&mut types.names).insert(
                        name.clone(),
                        Typing::Scheme {
                            level: self.level.get(),
                            body,
                        },
                    );
                    if let Some(signature) = inferred_signature.clone() {
                        values.signatures.borrow_mut().insert(name, signature);
                    }
                }
                if let Some(mut value_) = evaluated {
                    if let Some(signature) = &inferred_signature {
                        attach_signature(&mut value_, signature);
                    }
                    if !match_pattern(module, pattern, &value_, values) {
                        return Err(Diagnostic::new(
                            "BLOT_BINDING_MISMATCH",
                            "The declaration value does not match its pattern.",
                            span,
                        ));
                    }
                }
                Ok(inferred.effects)
            }
            Declaration::Shadow { name, value, span } => {
                let previous = types.lookup_stable(&name).ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_UNBOUND",
                        format!("`{name} := ...` cannot shadow an unbound name."),
                        span,
                    )
                })?;
                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred_type = stable_rebinding_type(inferred.type_.clone());
                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                self.constrain(previous.clone(), inferred_type, span)?;
                Rc::make_mut(&mut types.names).insert(name.clone(), Typing::Mono(previous));
                Rc::make_mut(&mut types.phases).insert(name.clone(), Phase::Runtime);
                match self.evaluate(path, value, values, Phase::Runtime) {
                    Ok(value_) => {
                        values.names.borrow_mut().insert(name, value_);
                    }
                    Err(_) => {
                        self.incomplete_evaluations
                            .borrow_mut()
                            .insert(path.to_owned());
                    }
                }
                Ok(inferred.effects)
            }
            Declaration::Open { value, span } => {
                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let opened = self.evaluate(path, value, values, Phase::Comptime)?;
                let Value::Shape(fields) = opened else {
                    return Err(Diagnostic::new(
                        "BLOT_CANNOT_OPEN",
                        "`open` requires a compile-time record.",
                        span,
                    ));
                };
                let inferred_fields = match self.settle(inferred.type_.clone(), true) {
                    Type::Record(fields) => fields,
                    _ => Vec::new(),
                };
                let mut type_positions_by_source = inferred_fields
                    .iter()
                    .enumerate()
                    .map(|(position, (name, _))| (name.clone(), position))
                    .collect::<HashMap<_, _>>();
                let mut inferred_fields = inferred_fields;
                let mut type_positions_by_target = BTreeMap::new();
                let mut value_sources_by_target = BTreeMap::new();
                for (source, value) in &fields {
                    let type_position = match type_positions_by_source.get(source) {
                        Some(position) => *position,
                        None => {
                            let position = inferred_fields.len();
                            inferred_fields
                                .push((source.clone(), self.bridge_runtime_value(value)));
                            type_positions_by_source.insert(source.clone(), position);
                            position
                        }
                    };
                    type_positions_by_target.insert(source.clone(), type_position);
                    value_sources_by_target.insert(source.clone(), source.clone());
                }
                Rc::make_mut(&mut types.opens).push(OpenedTypes {
                    fields: Rc::new(inferred_fields),
                    positions_by_target: Rc::new(type_positions_by_target),
                });
                values
                    .opens
                    .borrow_mut()
                    .push(OpenedValues::new(fields, value_sources_by_target));
                Ok(inferred.effects)
            }
        }
    }

    fn infer(
        &self,
        path: &str,
        module: &Module,
        expression_id: ExpressionId,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
        dependencies: &BTreeMap<String, Type>,
    ) -> Result<Inferred, Diagnostic> {
        let expression = module.arena.expressions[expression_id.0 as usize].clone();
        let span = expression_span(&expression);
        let pure = || Type::Effects(BTreeSet::new());
        match expression {
            Expression::Int { value, .. } => Ok(Inferred::pure(Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(value.clone())),
                high: Some(Scalar::Int(value)),
            })),
            Expression::Float { .. } => Ok(Inferred::pure(float_type())),
            Expression::Text { value, .. } => Ok(Inferred::pure(Type::Range {
                domain: Domain::Text,
                low: Some(Scalar::Text(value.clone())),
                high: Some(Scalar::Text(value)),
            })),
            Expression::Unit { .. } => Ok(Inferred::pure(Type::Unit)),
            Expression::Tag { name, .. } => Ok(Inferred::pure(Type::Variant {
                cases: vec![(name, Type::Unit)],
                open: false,
            })),
            Expression::Var { name, .. } => {
                let typing = environment.lookup(&name).ok_or_else(|| {
                    if environment.is_forward(&name) {
                        return Diagnostic::new(
                            "BLOT_FORWARD_REFERENCE",
                            format!("`{name}` is bound further down and is not in scope here."),
                            span,
                        );
                    }
                    Diagnostic::new("BLOT_UNBOUND", format!("`{name}` is not in scope."), span)
                })?;
                Ok(Inferred::pure(self.instantiate(typing)))
            }
            Expression::Intrinsic { name, .. } => primitive_type(self, &name)
                .map(Inferred::pure)
                .ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_UNKNOWN_PRIMITIVE",
                        format!("`{name}` is not a primitive."),
                        span,
                    )
                }),
            Expression::Apply {
                function, argument, ..
            } => {
                let (member_callee, member_arguments) =
                    application_spine_ids(module, expression_id);
                if member_arguments.len() == 2
                    && let Ok(Value::Primitive { name, .. }) =
                        self.evaluate(path, member_callee, values, Phase::Comptime)
                    && name == "@i32x4.lane"
                {
                    let selector = self
                        .evaluate(path, member_arguments[1], values, Phase::Comptime)
                        .map_err(|_| {
                            Diagnostic::new(
                                "BLOT_SIMD_IMMEDIATE_NOT_COMPTIME",
                                "An SIMD lane selector must be known at compile time. Bind it with `const`, or use `.x`, `.y`, `.z`, or `.w`.",
                                span,
                            )
                        })?;
                    let Value::Int(lane) = selector else {
                        return Err(Diagnostic::new(
                            "BLOT_SIMD_IMMEDIATE_RANGE",
                            "An I32x4 lane selector must be an integer in 0..3.",
                            span,
                        ));
                    };
                    if lane < BigInt::from(0_u8) || lane > BigInt::from(3_u8) {
                        return Err(Diagnostic::new(
                            "BLOT_SIMD_IMMEDIATE_RANGE",
                            format!("I32x4 lane {lane} is outside 0..3."),
                            span,
                        ));
                    }
                }
                if member_arguments.len() > 1
                    && let Expression::Field { target, name, .. } =
                        &module.arena.expressions[member_callee.0 as usize]
                    && let Ok(target_value) = self.evaluate(path, *target, values, Phase::Comptime)
                    && matches!(target_value, Value::Extended { .. })
                    && let Some(Value::Closure {
                        module: closure_module,
                        parameter,
                        body,
                        environment: closure_values,
                        self_name,
                        deferred,
                        ..
                    }) = static_member(&target_value, name)
                {
                    let mut effects = pure();
                    let mut arguments = Vec::new();
                    for argument in member_arguments {
                        let inferred =
                            self.infer(path, module, argument, environment, values, dependencies)?;
                        effects = self.join_effects(effects, inferred.effects)?;
                        arguments.push(inferred.type_);
                    }
                    if matches!(target_value, Value::Extended { .. })
                        && let Ok(value) =
                            self.evaluate(path, expression_id, values, Phase::Comptime)
                        && !matches!(value, Value::Closure { .. })
                    {
                        return Ok(Inferred {
                            type_: self.bridge_runtime_value(&value),
                            effects,
                        });
                    }
                    let mut function_type = self.infer_evaluated_closure(
                        path,
                        module,
                        &closure_module,
                        parameter,
                        body,
                        &closure_values,
                        self_name.as_deref(),
                        deferred,
                        environment,
                        dependencies,
                    )?;
                    for argument in arguments {
                        let result = self.fresh();
                        let performed = self.fresh();
                        self.constrain(
                            function_type,
                            Type::Function {
                                parameter: Box::new(argument),
                                effects: Box::new(performed.clone()),
                                result: Box::new(result.clone()),
                            },
                            span,
                        )?;
                        effects = self.join_effects(effects, performed)?;
                        function_type = result;
                    }
                    return Ok(Inferred {
                        type_: function_type,
                        effects,
                    });
                }
                if let Expression::Field { target, name, .. } =
                    &module.arena.expressions[function.0 as usize]
                    && let Ok(target_value) = self.evaluate(path, *target, values, Phase::Comptime)
                    && (matches!(target_value, Value::Extended { .. }) || name == "transform")
                    && let Some(Value::Closure {
                        module: closure_module,
                        parameter,
                        body,
                        environment: closure_values,
                        self_name,
                        deferred,
                        ..
                    }) = static_member(&target_value, name)
                {
                    let argument_type =
                        self.infer(path, module, argument, environment, values, dependencies)?;
                    if matches!(target_value, Value::Extended { .. })
                        && let Ok(value) =
                            self.evaluate(path, expression_id, values, Phase::Comptime)
                        && !matches!(value, Value::Closure { .. })
                    {
                        return Ok(Inferred {
                            type_: self.bridge_runtime_value(&value),
                            effects: argument_type.effects,
                        });
                    }
                    let function_type = self.infer_evaluated_closure(
                        path,
                        module,
                        &closure_module,
                        parameter,
                        body,
                        &closure_values,
                        self_name.as_deref(),
                        deferred,
                        environment,
                        dependencies,
                    )?;
                    let result = self.fresh();
                    let performed = self.fresh();
                    self.constrain(
                        function_type,
                        Type::Function {
                            parameter: Box::new(argument_type.type_),
                            effects: Box::new(performed.clone()),
                            result: Box::new(result.clone()),
                        },
                        span,
                    )?;
                    return Ok(Inferred {
                        type_: result,
                        effects: self.join_effects(argument_type.effects, performed)?,
                    });
                }
                if let Expression::Apply {
                    function: projection,
                    argument: target_expression,
                    ..
                } = module.arena.expressions[function.0 as usize]
                    && let Expression::Intrinsic { name, .. } =
                        &module.arena.expressions[projection.0 as usize]
                    && name == "@shape.get"
                {
                    let target = self.infer(
                        path,
                        module,
                        target_expression,
                        environment,
                        values,
                        dependencies,
                    )?;
                    let field_name =
                        self.infer(path, module, argument, environment, values, dependencies)?;
                    self.constrain(field_name.type_, text_type(), span)?;
                    let field = self.fresh();
                    if let Ok(Value::Text(name)) =
                        self.evaluate(path, argument, values, Phase::Comptime)
                    {
                        self.constrain(
                            target.type_,
                            Type::Record(vec![(name, field.clone())]),
                            span,
                        )?;
                    } else if self.phase.get() == Phase::Runtime
                        && self.specialization_depth.get() == 0
                    {
                        return Err(Diagnostic::new(
                            "BLOT_DYNAMIC_SHAPE_FIELD",
                            "A runtime shape projection needs a statically known field name.",
                            span,
                        ));
                    }
                    let effects = self.join_effects(target.effects, field_name.effects)?;
                    return Ok(Inferred {
                        type_: field,
                        effects,
                    });
                }
                if self.phase.get() == Phase::Runtime
                    && let Some(name) = intrinsic_head(module, function)
                {
                    if name == "@include" {
                        return Err(Diagnostic::new(
                            "BLOT_INCLUDE_NOT_COMPTIME",
                            "`@include` is available only during compile-time evaluation.",
                            span,
                        ));
                    }
                    if name == "@json.parse" {
                        return Err(Diagnostic::new(
                            "BLOT_JSON_NOT_COMPTIME",
                            "`@json.parse` is available only during compile-time evaluation.",
                            span,
                        ));
                    }
                }
                if let Expression::Apply {
                    function: satisfies,
                    argument: subject,
                    ..
                } = module.arena.expressions[function.0 as usize]
                    && let Expression::Intrinsic { name, .. } =
                        &module.arena.expressions[satisfies.0 as usize]
                    && name == "@satisfies"
                {
                    let subject =
                        self.infer(path, module, subject, environment, values, dependencies)?;
                    if let Ok(expected_value) =
                        self.evaluate(path, argument, values, Phase::Comptime)
                        && let Some(expected) = self.bridge(&expected_value)
                    {
                        self.constrain(subject.type_.clone(), expected, span)?;
                        return Ok(subject);
                    }
                }
                if let Expression::Intrinsic { name, .. } =
                    &module.arena.expressions[function.0 as usize]
                    && name == "@type.satisfies"
                {
                    return self.infer_type_satisfies(
                        path,
                        module,
                        argument,
                        environment,
                        values,
                        dependencies,
                        span,
                    );
                }
                if let Expression::Intrinsic { name, .. } =
                    &module.arena.expressions[function.0 as usize]
                    && name == "@type.open"
                    && let Ok(value) = self.evaluate(path, expression_id, values, Phase::Comptime)
                {
                    return Ok(Inferred::pure(self.bridge_runtime_value(&value)));
                }
                if let Expression::Intrinsic { name, .. } =
                    &module.arena.expressions[function.0 as usize]
                    && matches!(
                        name.as_str(),
                        "@type.open"
                            | "@linear.own"
                            | "@linear.maybe"
                            | "@linear.borrow"
                            | "@branch.likely"
                            | "@branch.unlikely"
                    )
                {
                    return self.infer(path, module, argument, environment, values, dependencies);
                }
                if let Expression::Intrinsic { name, .. } =
                    &module.arena.expressions[function.0 as usize]
                    && name == "@handle"
                {
                    return self.infer_handle(
                        path,
                        module,
                        argument,
                        environment,
                        values,
                        dependencies,
                        span,
                    );
                }
                if let Expression::Tag { name, .. } = &module.arena.expressions[function.0 as usize]
                {
                    let argument =
                        self.infer(path, module, argument, environment, values, dependencies)?;
                    return Ok(Inferred {
                        type_: Type::Variant {
                            cases: vec![(name.clone(), argument.type_)],
                            open: false,
                        },
                        effects: argument.effects,
                    });
                }
                if let Some(imported) = literal_import(module, function, argument, dependencies) {
                    return Ok(Inferred::pure(imported));
                }
                let argument_id = argument;
                let function =
                    self.infer(path, module, function, environment, values, dependencies)?;
                let argument =
                    self.infer(path, module, argument_id, environment, values, dependencies)?;
                let result = self.fresh();
                let performed = self.fresh();
                self.constrain(
                    function.type_,
                    Type::Function {
                        parameter: Box::new(argument.type_),
                        effects: Box::new(performed.clone()),
                        result: Box::new(result.clone()),
                    },
                    span,
                )?;
                let effects = self.join_effects(function.effects, argument.effects)?;
                let effects = self.join_effects(effects, performed)?;
                Ok(Inferred {
                    type_: result,
                    effects,
                })
            }
            Expression::Field { target, name, .. } => {
                if let Ok(target_value) = self.evaluate(path, target, values, Phase::Comptime) {
                    if let Some(member) = static_member(&target_value, &name) {
                        if let Some(type_) = self.bridge(&member) {
                            return Ok(Inferred::pure(type_));
                        }
                        if matches!(target_value, Value::Extended { .. }) {
                            return Ok(Inferred::pure(self.fresh()));
                        }
                    }
                    if let Value::Effect {
                        id,
                        name: effect_name,
                        operations,
                        host,
                    } = target_value
                        && let Some(signature) = operations.get(&name)
                        && let Some(mut type_) = self.bridge(signature)
                    {
                        add_function_effect(
                            &mut type_,
                            format!(
                                "{}:{id}:{effect_name}",
                                if host { "host" } else { "effect" }
                            ),
                        );
                        return Ok(Inferred::pure(type_));
                    }
                }
                let target = self.infer(path, module, target, environment, values, dependencies)?;
                let field = self.fresh();
                self.constrain(
                    target.type_,
                    Type::Record(vec![(name, field.clone())]),
                    span,
                )?;
                Ok(Inferred {
                    type_: field,
                    effects: target.effects,
                })
            }
            Expression::Lambda {
                parameter,
                body: body_id,
                deferred,
                ..
            } => {
                // Deferral is settled while compiling, so a deferred lambda
                // belongs to a compile-time declaration. One checked in the
                // runtime phase is part of the program that runs, where the
                // argument would be evaluated whether or not the parameter is
                // read — the same refusal source elaboration makes when it
                // builds Core.
                if deferred && self.phase.get() == Phase::Runtime {
                    return Err(Diagnostic::new(
                        "BLOT_DEFERRED_AT_RUNTIME",
                        concat!(
                            "A deferred parameter is only supplied while compiling. This ",
                            "function survives into the running program, where its argument ",
                            "would run whether or not the parameter is read."
                        ),
                        expression_span(&expression),
                    ));
                }
                let parameter_type = self.fresh();
                let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
                let parameter_phase = if deferred {
                    Phase::Comptime
                } else {
                    Phase::Runtime
                };
                self.bind_pattern_at_phase(
                    module,
                    parameter,
                    parameter_type.clone(),
                    &mut scope,
                    parameter_phase,
                );
                let body = self.infer(path, module, body_id, &scope, values, dependencies)?;
                let type_ = Type::Function {
                    parameter: Box::new(parameter_type),
                    effects: Box::new(body.effects),
                    result: Box::new(body.type_),
                };
                self.closure_types
                    .borrow_mut()
                    .insert((path.to_owned(), body_id), type_.clone());
                Ok(Inferred::pure(type_))
            }
            Expression::Tuple { elements, .. } => {
                let mut fields = Vec::new();
                let mut effects = pure();
                for (index, element) in elements.into_iter().enumerate() {
                    let inferred =
                        self.infer(path, module, element, environment, values, dependencies)?;
                    fields.push((index.to_string(), inferred.type_));
                    effects = self.join_effects(effects, inferred.effects)?;
                }
                Ok(Inferred {
                    type_: Type::Record(fields),
                    effects,
                })
            }
            Expression::Array { elements, .. } => {
                let element_type = self.fresh();
                let mut effects = pure();
                for element in elements {
                    let inferred = self.infer(
                        path,
                        module,
                        element.value,
                        environment,
                        values,
                        dependencies,
                    )?;
                    if element.spread {
                        self.constrain(
                            inferred.type_,
                            Type::Array(Box::new(element_type.clone())),
                            span,
                        )?;
                    } else {
                        self.constrain(inferred.type_, element_type.clone(), span)?;
                    }
                    effects = self.join_effects(effects, inferred.effects)?;
                }
                Ok(Inferred {
                    type_: Type::Array(Box::new(element_type)),
                    effects,
                })
            }
            Expression::Shape { members, .. } => {
                let mut fields = Vec::new();
                let mut explicit_fields = HashSet::new();
                let mut effects = pure();
                for member in members {
                    match member {
                        ShapeMember::Field { name, value } => {
                            let inferred =
                                self.infer(path, module, value, environment, values, dependencies)?;
                            if !explicit_fields.insert(name.clone()) {
                                return Err(Diagnostic::new(
                                    "BLOT_DUPLICATE_FIELD",
                                    format!("Record field `{name}` is written more than once."),
                                    span,
                                ));
                            }
                            if let Some(existing) =
                                fields.iter_mut().find(|(field, _)| field == &name)
                            {
                                existing.1 = inferred.type_;
                            } else {
                                fields.push((name, inferred.type_));
                            }
                            effects = self.join_effects(effects, inferred.effects)?;
                        }
                        ShapeMember::Spread { value } => {
                            let inferred =
                                self.infer(path, module, value, environment, values, dependencies)?;
                            let settled = self.settle(inferred.type_, true);
                            let Type::Record(spread) = settled else {
                                let code = if fields.is_empty() {
                                    "BLOT_TYPE_ERROR"
                                } else {
                                    "BLOT_SPREAD_MAY_OVERWRITE"
                                };
                                return Err(Diagnostic::new(
                                    code,
                                    "A record spread must have a statically known field set.",
                                    span,
                                ));
                            };
                            for (name, type_) in spread {
                                if let Some(existing) =
                                    fields.iter_mut().find(|(field, _)| field == &name)
                                {
                                    existing.1 = type_;
                                } else {
                                    fields.push((name, type_));
                                }
                            }
                            effects = self.join_effects(effects, inferred.effects)?;
                        }
                    }
                }
                Ok(Inferred {
                    type_: Type::Record(fields),
                    effects,
                })
            }
            Expression::If {
                branches, fallback, ..
            } => {
                let result = self.fresh();
                let mut effects = pure();
                let mut remaining = TypeEnvironment::child(Rc::new(environment.clone()));
                for branch in branches {
                    let condition = self.infer(
                        path,
                        module,
                        branch.condition,
                        &remaining,
                        values,
                        dependencies,
                    )?;
                    self.constrain(condition.type_, bool_type(), span)?;
                    let refinements =
                        comparison_refinements(module, branch.condition, &remaining, values, self);
                    let mut consequence_scope = TypeEnvironment::child(Rc::new(remaining.clone()));
                    if let Some((name, consequence, alternate)) = refinements {
                        let binding_phase = remaining.binding_phase(&name);
                        let stable = remaining.lookup_stable(&name).ok_or_else(|| {
                            Diagnostic::new(
                                "BLOT_RUST_INVARIANT",
                                format!("A refinement references unbound `{name}`."),
                                span,
                            )
                        })?;
                        Rc::make_mut(&mut consequence_scope.stable_names)
                            .insert(name.clone(), stable.clone());
                        Rc::make_mut(&mut remaining.stable_names).insert(name.clone(), stable);
                        Rc::make_mut(&mut consequence_scope.names)
                            .insert(name.clone(), Typing::Mono(consequence));
                        Rc::make_mut(&mut remaining.names)
                            .insert(name.clone(), Typing::Mono(alternate));
                        if let Some(phase) = binding_phase {
                            Rc::make_mut(&mut consequence_scope.phases).insert(name.clone(), phase);
                            Rc::make_mut(&mut remaining.phases).insert(name, phase);
                        }
                    }
                    let consequence = self.infer(
                        path,
                        module,
                        branch.consequence,
                        &consequence_scope,
                        values,
                        dependencies,
                    )?;
                    self.constrain(consequence.type_, result.clone(), span)?;
                    effects = self.join_effects(effects, condition.effects)?;
                    effects = self.join_effects(effects, consequence.effects)?;
                }
                if let Some(fallback) = fallback {
                    let fallback =
                        self.infer(path, module, fallback, &remaining, values, dependencies)?;
                    self.constrain(fallback.type_, result.clone(), span)?;
                    effects = self.join_effects(effects, fallback.effects)?;
                }
                Ok(Inferred {
                    type_: result,
                    effects,
                })
            }
            Expression::Case { target, arms, .. } => {
                let target = self.infer(path, module, target, environment, values, dependencies)?;
                let target_type = target.type_.clone();
                let target_before_patterns = self.settle(target_type.clone(), false);
                let result = self.fresh();
                let mut effects = target.effects;
                let mut covered = Vec::new();
                let mut accepted_patterns = Vec::new();
                let mut catch_all = false;
                let mut constructor_patterns = true;
                let mut unit_excluded = false;
                for arm in &arms {
                    let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
                    self.validate_matchable_pins(module, arm.pattern, environment)?;
                    catch_all |= matches!(
                        module.arena.patterns[arm.pattern.0 as usize],
                        Pattern::Wildcard { .. } | Pattern::Name { .. }
                    );
                    constructor_patterns &= matches!(
                        module.arena.patterns[arm.pattern.0 as usize],
                        Pattern::Constructor { .. }
                    );
                    let accepted = self.pattern_type(module, arm.pattern, &mut scope);
                    if let Some(accepted) = accepted {
                        accepted_patterns.push((arm.pattern, accepted.clone()));
                        if !matches!(
                            module.arena.patterns[arm.pattern.0 as usize],
                            Pattern::Wildcard { .. } | Pattern::Name { .. }
                        ) {
                            covered.push(accepted);
                        }
                    }
                    let matched_type = if unit_excluded
                        && matches!(
                            module.arena.patterns[arm.pattern.0 as usize],
                            Pattern::Name { .. }
                        ) {
                        remove_type(self.settle(target_type.clone(), false), &Type::Unit)
                    } else {
                        target_type.clone()
                    };
                    self.bind_pattern_from_type(module, arm.pattern, &matched_type, &mut scope);
                    let body = self.infer(path, module, arm.body, &scope, values, dependencies)?;
                    self.constrain(body.type_, result.clone(), span)?;
                    effects = self.join_effects(effects, body.effects)?;
                    if matches!(
                        module.arena.patterns[arm.pattern.0 as usize],
                        Pattern::Unit { .. }
                    ) {
                        unit_excluded = true;
                    }
                }
                if let Some(covered) =
                    case_constraint(module, &accepted_patterns, &covered, catch_all)
                {
                    self.constrain(target_type.clone(), covered, span)?;
                }
                if !catch_all {
                    let structural_patterns = arms
                        .iter()
                        .all(|arm| structural_pattern(module, arm.pattern));
                    let patterns_pin_target = constructor_patterns
                        || structural_patterns
                        || tuple_columns_are_total(module, &arms);
                    let settled_target = if patterns_pin_target {
                        self.settle(target_type, false)
                    } else {
                        target_before_patterns
                    };
                    if !patterns_cover(module, &arms, &settled_target) {
                        let code = if matches!(settled_target, Type::Variant { .. }) {
                            "BLOT_TYPE_ERROR"
                        } else {
                            "BLOT_INCOMPLETE_CASE"
                        };
                        return Err(Diagnostic::new(
                            code,
                            format!(
                                "The case arms do not cover every value of {}.",
                                self.show(&settled_target)
                            ),
                            span,
                        ));
                    }
                }
                Ok(Inferred {
                    type_: result,
                    effects,
                })
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
                let value_scope = child_env(Some(values.clone()));
                let mut signatures = BTreeMap::new();
                let mut effects = pure();
                scope.forward = Rc::new(future_binding_names(module, &declarations));
                for (index, declaration) in declarations.iter().enumerate() {
                    remove_declaration_names(
                        module,
                        *declaration,
                        Rc::make_mut(&mut scope.forward),
                    );
                    prebind_recursive_group(path, module, &declarations, index, &mut scope, self)?;
                    let declaration = module.arena.declarations[declaration.0 as usize].clone();
                    let declaration_effects = self.check_declaration(
                        path,
                        module,
                        declaration,
                        &mut scope,
                        &value_scope,
                        dependencies,
                        &mut signatures,
                    )?;
                    effects = self.join_effects(effects, declaration_effects)?;
                }
                let result =
                    self.infer(path, module, result, &scope, &value_scope, dependencies)?;
                effects = self.join_effects(effects, result.effects)?;
                Ok(Inferred {
                    type_: result.type_,
                    effects,
                })
            }
            Expression::Rec { lambda, .. } => {
                let inferred =
                    self.infer(path, module, lambda, environment, values, dependencies)?;
                let Expression::Lambda { body, .. } = module.arena.expressions[lambda.0 as usize]
                else {
                    return Ok(inferred);
                };
                self.closure_types
                    .borrow_mut()
                    .insert((path.to_owned(), body), inferred.type_.clone());
                Ok(inferred)
            }
            Expression::Comptime { body, .. } => {
                let previous_phase = self.phase.replace(Phase::Comptime);
                let inferred = self.infer(path, module, body, environment, values, dependencies);
                self.phase.set(previous_phase);
                let inferred = inferred?;
                Ok(Inferred::pure(inferred.type_))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn infer_against(
        &self,
        path: &str,
        module: &Module,
        expression: ExpressionId,
        expected: Type,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
        dependencies: &BTreeMap<String, Type>,
        span: Span,
    ) -> Result<Inferred, Diagnostic> {
        let (callee, _) = application_spine_ids(module, expression);
        if let Expression::Field { target, .. } = &module.arena.expressions[callee.0 as usize]
            && self
                .evaluate(path, *target, values, Phase::Comptime)
                .is_ok_and(|value| matches!(value, Value::Extended { .. }))
            && self
                .evaluate(path, expression, values, Phase::Comptime)
                .is_err()
        {
            return self.type_error(Type::Top, expected, span);
        }
        if let Expression::Rec { lambda, .. } = module.arena.expressions[expression.0 as usize] {
            let inferred = self.infer_against(
                path,
                module,
                lambda,
                expected,
                environment,
                values,
                dependencies,
                span,
            )?;
            let Expression::Lambda { body, .. } = module.arena.expressions[lambda.0 as usize]
            else {
                return Ok(inferred);
            };
            self.closure_types
                .borrow_mut()
                .insert((path.to_owned(), body), inferred.type_.clone());
            return Ok(inferred);
        }
        if let Expression::Lambda {
            parameter,
            body,
            deferred,
            ..
        } = module.arena.expressions[expression.0 as usize]
            && let Type::Function {
                parameter: expected_parameter,
                effects: expected_effects,
                result: expected_result,
            } = expected.clone()
        {
            self.closure_types
                .borrow_mut()
                .insert((path.to_owned(), body), expected.clone());
            let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
            let parameter_phase = if deferred {
                Phase::Comptime
            } else {
                Phase::Runtime
            };
            self.bind_pattern_at_phase(
                module,
                parameter,
                (*expected_parameter).clone(),
                &mut scope,
                parameter_phase,
            );
            let body = self.infer_against(
                path,
                module,
                body,
                (*expected_result).clone(),
                &scope,
                values,
                dependencies,
                span,
            )?;
            self.constrain(body.effects, *expected_effects, span)?;
            return Ok(Inferred::pure(expected));
        }
        let inferred = self.infer(path, module, expression, environment, values, dependencies)?;
        if self.contains_unevidenced(&inferred.type_, &mut HashSet::new()) {
            if expression_contains_intrinsic(module, expression, "@type.reflect") {
                return Err(Diagnostic::new(
                    "BLOT_REFLECTION_NOT_INDEXED",
                    "A generic reflection result cannot prove a runtime signature.",
                    span,
                ));
            }
            return self.type_error(inferred.type_, expected, span);
        }
        self.constrain(inferred.type_, expected.clone(), span)?;
        Ok(Inferred {
            type_: expected,
            effects: inferred.effects,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn infer_evaluated_closure(
        &self,
        path: &str,
        module: &Module,
        closure_module: &str,
        parameter: PatternId,
        body: ExpressionId,
        closure_values: &ValueEnvironment,
        self_name: Option<&str>,
        deferred: bool,
        environment: &TypeEnvironment,
        dependencies: &BTreeMap<String, Type>,
    ) -> Result<Type, Diagnostic> {
        let closure_loaded = self
            .context
            .modules
            .borrow()
            .get(closure_module)
            .cloned()
            .ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_UNRESOLVED_IMPORT",
                    format!("Module `{closure_module}` was not loaded."),
                    module.span,
                )
            })?;
        let closure_ast = closure_loaded.module;
        let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
        let mut captured = Vec::new();
        let mut value_scope = Some(closure_values.clone());
        while let Some(values) = value_scope {
            captured.push(values.clone());
            value_scope = values.parent.clone();
        }
        for values in captured.into_iter().rev() {
            for (name, value) in values.names.borrow().iter() {
                let type_ = self.bridge(value).unwrap_or_else(|| self.fresh());
                Rc::make_mut(&mut scope.names).insert(name.clone(), Typing::Mono(type_));
                let phase = if closure_module == path {
                    environment.binding_phase(name).unwrap_or(Phase::Comptime)
                } else {
                    Phase::Comptime
                };
                Rc::make_mut(&mut scope.phases).insert(name.clone(), phase);
            }
            for opened in values.opens.borrow().iter() {
                for (name, value) in opened.iter() {
                    let type_ = self.bridge(value).unwrap_or_else(|| self.fresh());
                    Rc::make_mut(&mut scope.names).insert(name.clone(), Typing::Mono(type_));
                    let phase = if closure_module == path {
                        environment.binding_phase(name).unwrap_or(Phase::Comptime)
                    } else {
                        Phase::Comptime
                    };
                    Rc::make_mut(&mut scope.phases).insert(name.clone(), phase);
                }
            }
        }
        let recursive = self_name.map(|name| (name.to_owned(), self.fresh()));
        if let Some((name, type_)) = &recursive {
            Rc::make_mut(&mut scope.names).insert(name.clone(), Typing::Mono(type_.clone()));
            let phase = if closure_module == path {
                environment.binding_phase(name).unwrap_or(self.phase.get())
            } else {
                Phase::Comptime
            };
            Rc::make_mut(&mut scope.phases).insert(name.clone(), phase);
        }
        let parameter_type = self.fresh();
        let parameter_phase = if deferred {
            Phase::Comptime
        } else {
            Phase::Runtime
        };
        self.bind_pattern_at_phase(
            &closure_ast,
            parameter,
            parameter_type.clone(),
            &mut scope,
            parameter_phase,
        );
        let previous_specialization_depth = self.specialization_depth.get();
        self.specialization_depth
            .set(previous_specialization_depth + 1);
        let inferred = self.infer(
            closure_module,
            &closure_ast,
            body,
            &scope,
            closure_values,
            dependencies,
        );
        self.specialization_depth.set(previous_specialization_depth);
        let inferred = inferred?;
        let function = Type::Function {
            parameter: Box::new(parameter_type),
            effects: Box::new(inferred.effects),
            result: Box::new(inferred.type_),
        };
        if let Some((_, recursive)) = recursive {
            self.constrain(function.clone(), recursive, closure_ast.span)?;
        }
        Ok(function)
    }

    #[allow(clippy::too_many_arguments)]
    fn infer_type_satisfies(
        &self,
        path: &str,
        module: &Module,
        argument: ExpressionId,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
        dependencies: &BTreeMap<String, Type>,
        span: Span,
    ) -> Result<Inferred, Diagnostic> {
        let Expression::Tuple { elements, .. } = &module.arena.expressions[argument.0 as usize]
        else {
            return self.type_error(Type::Unit, Type::Record(Vec::new()), span);
        };
        if elements.len() != 2 {
            return self.type_error(Type::Unit, Type::Record(Vec::new()), span);
        }
        let subject = self.infer(path, module, elements[0], environment, values, dependencies)?;
        let settled = self.settle(subject.type_.clone(), true);
        let reified = self.reify_runtime_type(&settled).ok_or_else(|| {
            Diagnostic::new(
                "BLOT_TYPE_NOT_REIFIABLE",
                format!("`{}` has no compile-time reading.", self.show(&settled)),
                span,
            )
        })?;
        let predicate = self.evaluate(path, elements[1], values, Phase::Comptime)?;
        let answer = run(apply(
            self.context.clone(),
            predicate,
            reified,
            span,
            Runtime::new(Phase::Comptime, path.to_owned()),
        ))?;
        match answer {
            Value::Tag { name, .. } if name == "True" => Ok(subject),
            Value::Tag { .. } => Err(Diagnostic::new(
                "BLOT_DOES_NOT_SATISFY",
                format!("`{}` does not satisfy the predicate.", self.show(&settled)),
                span,
            )),
            _ => Err(Diagnostic::new(
                "BLOT_TYPE_ERROR",
                "The predicate given to `@type.satisfies` must answer `#True` or `#False`.",
                span,
            )),
        }
    }

    fn fresh(&self) -> Type {
        let mut variables = self.variables.borrow_mut();
        let id = variables.len() as VariableId;
        variables.push(Variable {
            level: self.level.get(),
            lower: Vec::new(),
            upper: Vec::new(),
        });
        Type::Variable(id)
    }

    fn fresh_at_next_level(&self) -> Type {
        let level = self.level.get();
        self.level.set(level + 1);
        let type_ = self.fresh();
        self.level.set(level);
        type_
    }

    #[allow(clippy::too_many_arguments)]
    fn infer_handle(
        &self,
        path: &str,
        module: &Module,
        argument: ExpressionId,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
        dependencies: &BTreeMap<String, Type>,
        span: Span,
    ) -> Result<Inferred, Diagnostic> {
        let Expression::Tuple { elements, .. } = &module.arena.expressions[argument.0 as usize]
        else {
            return self.type_error(Type::Unit, Type::Record(Vec::new()), span);
        };
        if elements.len() != 3 {
            return self.type_error(Type::Unit, Type::Record(Vec::new()), span);
        }
        let effect_expression = elements[0];
        let thunk_expression = elements[1];
        let handler_expression = elements[2];
        let effect_value = match self.evaluate(path, effect_expression, values, Phase::Comptime) {
            Ok(value) => value,
            Err(error) if error.code == "BLOT_UNBOUND" => {
                return Ok(Inferred::pure(self.fresh()));
            }
            Err(error) => return Err(error),
        };
        let label = effect_label(&effect_value).ok_or_else(|| {
            Diagnostic::new(
                "BLOT_TYPE_ERROR",
                "`@handle` must name an effect known at compile time.",
                span,
            )
        })?;
        let Value::Effect { operations, .. } = &effect_value else {
            return self.type_error(Type::Unit, Type::Opaque("Effect".to_owned()), span);
        };
        let handler_value = self.evaluate(path, handler_expression, values, Phase::Runtime)?;
        let Value::Shape(handler_fields) = &handler_value else {
            return Err(Diagnostic::new(
                "BLOT_TYPE_ERROR",
                "A handler must be a statically known record of clauses.",
                span,
            ));
        };
        for (name, clause) in handler_fields {
            if name == "return" {
                continue;
            }
            if operations.get(name).is_none() {
                return Err(Diagnostic::new(
                    "BLOT_TYPE_ERROR",
                    format!("The handled effect has no operation `{name}`."),
                    span,
                ));
            }
            require_continuation_qualifier(module, name, clause, span)?;
        }
        let thunk = self.infer(
            path,
            module,
            thunk_expression,
            environment,
            values,
            dependencies,
        )?;
        let handler = self.infer(
            path,
            module,
            handler_expression,
            environment,
            values,
            dependencies,
        )?;
        let computation_result = self.fresh();
        let handled_result = self.fresh();
        let performed = self.fresh();
        let handler_row = self.fresh();
        self.constrain(
            thunk.type_,
            Type::Function {
                parameter: Box::new(Type::Unit),
                effects: Box::new(performed.clone()),
                result: Box::new(computation_result.clone()),
            },
            span,
        )?;
        for (name, signature) in operations {
            let Some(mut signature) = self.bridge(signature) else {
                continue;
            };
            if let Type::Forall { variables, body } = signature {
                signature = self.instantiate_forall(variables, *body);
            }
            let Type::Function {
                parameter, result, ..
            } = signature
            else {
                continue;
            };
            let continuation = Type::Function {
                parameter: result,
                effects: Box::new(handler_row.clone()),
                result: Box::new(handled_result.clone()),
            };
            let clause = Type::Function {
                parameter: Box::new(Type::Record(vec![
                    ("0".to_owned(), *parameter),
                    ("1".to_owned(), continuation),
                ])),
                effects: Box::new(handler_row.clone()),
                result: Box::new(handled_result.clone()),
            };
            self.constrain(
                handler.type_.clone(),
                Type::Record(vec![(name.clone(), clause)]),
                span,
            )?;
        }
        if handler_fields.get("return").is_some() {
            self.constrain(
                handler.type_.clone(),
                Type::Record(vec![(
                    "return".to_owned(),
                    Type::Function {
                        parameter: Box::new(computation_result),
                        effects: Box::new(handler_row.clone()),
                        result: Box::new(handled_result.clone()),
                    },
                )]),
                span,
            )?;
        } else {
            self.constrain(computation_result, handled_result.clone(), span)?;
        }
        let mut effects = match self.settle(performed, true) {
            Type::Effects(mut labels) => {
                labels.remove(&label);
                Type::Effects(labels)
            }
            Type::Bottom => Type::Effects(BTreeSet::new()),
            other => other,
        };
        effects = self.join_effects(effects, handler.effects)?;
        effects = self.join_effects(effects, handler_row)?;
        Ok(Inferred {
            type_: handled_result,
            effects,
        })
    }

    fn instantiate(&self, typing: Typing) -> Type {
        match typing {
            Typing::Mono(type_) => type_,
            Typing::Scheme { level, body } => self.freshen(body, level, &mut HashMap::new()),
        }
    }

    fn constraint_type(&self, type_: &Type) -> ConstraintTypeId {
        self.constraint_types.borrow_mut().intern(type_)
    }

    fn expand_constraint(&self, type_: ConstraintTypeId) -> Type {
        self.constraint_types.borrow().expand(type_)
    }

    fn constraint_variable(&self, type_: ConstraintTypeId) -> Option<VariableId> {
        self.constraint_types.borrow().variable(type_)
    }

    fn contains_constraint(&self, bounds: &[ConstraintTypeId], bound_id: ConstraintTypeId) -> bool {
        let types = self.constraint_types.borrow();
        bounds
            .iter()
            .any(|candidate| types.same(*candidate, bound_id))
    }

    fn freshen(&self, type_: Type, level: u32, fresh: &mut HashMap<VariableId, Type>) -> Type {
        match type_ {
            Type::Variable(id) if self.variables.borrow()[id as usize].level > level => {
                if let Some(type_) = fresh.get(&id) {
                    return type_.clone();
                }
                let replacement = self.fresh();
                fresh.insert(id, replacement.clone());
                let source = self.variables.borrow()[id as usize].clone();
                let lower = source
                    .lower
                    .into_iter()
                    .map(|bound| self.expand_constraint(bound))
                    .map(|bound| self.freshen(bound, level, fresh))
                    .map(|bound| self.constraint_type(&bound))
                    .collect();
                let upper = source
                    .upper
                    .into_iter()
                    .map(|bound| self.expand_constraint(bound))
                    .map(|bound| self.freshen(bound, level, fresh))
                    .map(|bound| self.constraint_type(&bound))
                    .collect();
                let Type::Variable(replacement_id) = replacement else {
                    unreachable!("fresh always returns a variable")
                };
                let mut variables = self.variables.borrow_mut();
                variables[replacement_id as usize].lower = lower;
                variables[replacement_id as usize].upper = upper;
                Type::Variable(replacement_id)
            }
            Type::Forall { variables, body } => Type::Forall {
                variables,
                body: Box::new(self.freshen(*body, level, fresh)),
            },
            Type::Function {
                parameter,
                effects,
                result,
            } => Type::Function {
                parameter: Box::new(self.freshen(*parameter, level, fresh)),
                effects: Box::new(self.freshen(*effects, level, fresh)),
                result: Box::new(self.freshen(*result, level, fresh)),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, type_)| (name, self.freshen(type_, level, fresh)))
                    .collect(),
            ),
            Type::Array(element) => Type::Array(Box::new(self.freshen(*element, level, fresh))),
            Type::Region(element) => Type::Region(Box::new(self.freshen(*element, level, fresh))),
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Box::new(self.freshen(*tail, level, fresh)),
            },
            Type::Variant { cases, open } => Type::Variant {
                cases: cases
                    .into_iter()
                    .map(|(name, type_)| (name, self.freshen(type_, level, fresh)))
                    .collect(),
                open,
            },
            Type::Union(members) => Type::Union(
                members
                    .into_iter()
                    .map(|member| self.freshen(member, level, fresh))
                    .collect(),
            ),
            other => other,
        }
    }

    fn instantiate_forall(&self, variables: Vec<VariableId>, body: Type) -> Type {
        let replacements = variables
            .into_iter()
            .map(|variable| (variable, self.fresh()))
            .collect();
        substitute_rigid(body, &replacements)
    }

    fn skolemize(&self, variables: Vec<VariableId>, body: Type) -> Type {
        let replacements = variables
            .into_iter()
            .map(|variable| {
                let skolem = self.next_skolem.get();
                self.next_skolem.set(skolem + 1);
                (variable, Type::Rigid(skolem))
            })
            .collect();
        substitute_rigid(body, &replacements)
    }

    fn level_of(&self, type_: &Type) -> u32 {
        match type_ {
            Type::Variable(id) => self.variables.borrow()[*id as usize].level,
            Type::Forall { body, .. } => self.level_of(body),
            Type::Function {
                parameter,
                effects,
                result,
            } => self
                .level_of(parameter)
                .max(self.level_of(effects))
                .max(self.level_of(result)),
            Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
                .iter()
                .map(|(_, field)| self.level_of(field))
                .max()
                .unwrap_or(0),
            Type::Array(element) | Type::Region(element) => self.level_of(element),
            Type::OpenEffects { tail, .. } => self.level_of(tail),
            Type::Union(members) => members
                .iter()
                .map(|member| self.level_of(member))
                .max()
                .unwrap_or(0),
            _ => 0,
        }
    }

    fn extrude(
        &self,
        type_: Type,
        polarity: bool,
        level: u32,
        copies: &mut HashMap<VariableId, Type>,
    ) -> Type {
        if self.level_of(&type_) <= level {
            return type_;
        }
        match type_ {
            Type::Variable(id) => {
                if let Some(copy) = copies.get(&id) {
                    return copy.clone();
                }
                let previous_level = self.level.replace(level);
                let copy = self.fresh();
                self.level.set(previous_level);
                copies.insert(id, copy.clone());
                let Type::Variable(copy_id) = copy else {
                    unreachable!("fresh always returns a variable")
                };
                let source = self.variables.borrow()[id as usize].clone();
                if polarity {
                    let copy_type = self.constraint_type(&Type::Variable(copy_id));
                    self.variables.borrow_mut()[id as usize]
                        .upper
                        .push(copy_type);
                    self.record_bound_insertion(id, BoundDirection::Upper);
                    for bound in source.lower {
                        let bound = self.expand_constraint(bound);
                        let bound = self.extrude(bound, polarity, level, copies);
                        let bound = self.constraint_type(&bound);
                        self.variables.borrow_mut()[copy_id as usize]
                            .lower
                            .push(bound);
                        self.record_bound_insertion(copy_id, BoundDirection::Lower);
                    }
                } else {
                    let copy_type = self.constraint_type(&Type::Variable(copy_id));
                    self.variables.borrow_mut()[id as usize]
                        .lower
                        .push(copy_type);
                    self.record_bound_insertion(id, BoundDirection::Lower);
                    for bound in source.upper {
                        let bound = self.expand_constraint(bound);
                        let bound = self.extrude(bound, polarity, level, copies);
                        let bound = self.constraint_type(&bound);
                        self.variables.borrow_mut()[copy_id as usize]
                            .upper
                            .push(bound);
                        self.record_bound_insertion(copy_id, BoundDirection::Upper);
                    }
                }
                Type::Variable(copy_id)
            }
            Type::Forall { variables, body } => Type::Forall {
                variables,
                body: Box::new(self.extrude(*body, polarity, level, copies)),
            },
            Type::Function {
                parameter,
                effects,
                result,
            } => Type::Function {
                parameter: Box::new(self.extrude(*parameter, !polarity, level, copies)),
                effects: Box::new(self.extrude(*effects, polarity, level, copies)),
                result: Box::new(self.extrude(*result, polarity, level, copies)),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, field)| (name, self.extrude(field, polarity, level, copies)))
                    .collect(),
            ),
            Type::Array(element) => {
                Type::Array(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Region(element) => {
                Type::Region(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Box::new(self.extrude(*tail, polarity, level, copies)),
            },
            Type::Variant { cases, open } => Type::Variant {
                cases: cases
                    .into_iter()
                    .map(|(name, payload)| (name, self.extrude(payload, polarity, level, copies)))
                    .collect(),
                open,
            },
            Type::Union(members) => Type::Union(
                members
                    .into_iter()
                    .map(|member| self.extrude(member, polarity, level, copies))
                    .collect(),
            ),
            other => other,
        }
    }

    fn constrain(&self, left: Type, right: Type, span: Span) -> Result<(), Diagnostic> {
        debug_assert!(self.bound_insertions.borrow().is_empty());
        let left = self.constraint_type(&left);
        let right = self.constraint_type(&right);
        let result = self.constrain_ids(left, right, span, &mut HashSet::new());
        self.bound_insertions.borrow_mut().clear();
        result
    }

    fn record_bound_insertion(&self, variable: VariableId, direction: BoundDirection) {
        self.bound_insertions.borrow_mut().push(BoundInsertion {
            variable,
            direction,
        });
    }

    fn rollback_bounds(
        &self,
        insertion_count: usize,
        variable_count: usize,
        next_skolem: VariableId,
    ) {
        let mut insertions = self.bound_insertions.borrow_mut();
        let mut variables = self.variables.borrow_mut();
        while insertions.len() > insertion_count {
            let insertion = insertions
                .pop()
                .expect("a rollback checkpoint preceded every journal entry");
            let bounds = match insertion.direction {
                BoundDirection::Lower => &mut variables[insertion.variable as usize].lower,
                BoundDirection::Upper => &mut variables[insertion.variable as usize].upper,
            };
            bounds
                .pop()
                .expect("a journalled bound insertion must still be present");
        }
        variables.truncate(variable_count);
        self.next_skolem.set(next_skolem);
    }

    fn add_upper_bound(
        &self,
        variable: VariableId,
        bound: ConstraintTypeId,
        span: Span,
        seen: &mut HashSet<(VariableId, VariableId)>,
    ) -> Result<(), Diagnostic> {
        let mut pending = vec![variable];
        let mut visited = HashSet::new();
        while let Some(variable) = pending.pop() {
            if !visited.insert(variable) {
                continue;
            }
            let (inserted, lowers) = {
                let mut variables = self.variables.borrow_mut();
                let inserted =
                    !self.contains_constraint(&variables[variable as usize].upper, bound);
                if inserted {
                    variables[variable as usize].upper.push(bound);
                }
                (inserted, variables[variable as usize].lower.clone())
            };
            if !inserted {
                continue;
            }
            self.record_bound_insertion(variable, BoundDirection::Upper);
            for lower in lowers {
                if let Some(predecessor) = self.constraint_variable(lower) {
                    pending.push(predecessor);
                } else {
                    self.constrain_ids(lower, bound, span, seen)?;
                }
            }
        }
        Ok(())
    }

    fn add_lower_bound(
        &self,
        variable: VariableId,
        bound: ConstraintTypeId,
        span: Span,
        seen: &mut HashSet<(VariableId, VariableId)>,
    ) -> Result<(), Diagnostic> {
        let mut pending = vec![variable];
        let mut visited = HashSet::new();
        while let Some(variable) = pending.pop() {
            if !visited.insert(variable) {
                continue;
            }
            let (inserted, uppers) = {
                let mut variables = self.variables.borrow_mut();
                let inserted =
                    !self.contains_constraint(&variables[variable as usize].lower, bound);
                if inserted {
                    variables[variable as usize].lower.push(bound);
                }
                (inserted, variables[variable as usize].upper.clone())
            };
            if !inserted {
                continue;
            }
            self.record_bound_insertion(variable, BoundDirection::Lower);
            for upper in uppers {
                if let Some(successor) = self.constraint_variable(upper) {
                    pending.push(successor);
                } else {
                    self.constrain_ids(bound, upper, span, seen)?;
                }
            }
        }
        Ok(())
    }

    fn constrain_ids(
        &self,
        left: ConstraintTypeId,
        right: ConstraintTypeId,
        span: Span,
        seen: &mut HashSet<(VariableId, VariableId)>,
    ) -> Result<(), Diagnostic> {
        if self.constraint_types.borrow().same(left, right) {
            return Ok(());
        }
        let (left_node, right_node) = {
            let types = self.constraint_types.borrow();
            (
                types.nodes[left.0 as usize].clone(),
                types.nodes[right.0 as usize].clone(),
            )
        };
        let compatible = match (left_node, right_node) {
            (_, ConstraintTypeNode::Top) | (ConstraintTypeNode::Bottom, _) => true,
            (ConstraintTypeNode::Forall { variables, body }, _) => {
                let body = self.expand_constraint(body);
                let instantiated = self.instantiate_forall(variables, body);
                let instantiated = self.constraint_type(&instantiated);
                self.constrain_ids(instantiated, right, span, seen)?;
                true
            }
            (_, ConstraintTypeNode::Forall { variables, body }) => {
                let body = self.expand_constraint(body);
                let rigid = self.skolemize(variables, body);
                let rigid = self.constraint_type(&rigid);
                self.constrain_ids(left, rigid, span, seen)?;
                true
            }
            (ConstraintTypeNode::Unit, ConstraintTypeNode::Unit) => true,
            (
                ConstraintTypeNode::Range {
                    domain: left_domain,
                    low: left_low,
                    high: left_high,
                },
                ConstraintTypeNode::Range {
                    domain: right_domain,
                    low: right_low,
                    high: right_high,
                },
            ) => {
                left_domain == right_domain
                    && lower_within(&left_low, &right_low)
                    && upper_within(&left_high, &right_high)
            }
            (
                ConstraintTypeNode::Function {
                    parameter: left_parameter,
                    effects: left_effects,
                    result: left_result,
                },
                ConstraintTypeNode::Function {
                    parameter: right_parameter,
                    effects: right_effects,
                    result: right_result,
                },
            ) => {
                self.constrain_ids(right_parameter, left_parameter, span, seen)?;
                self.constrain_ids(left_effects, right_effects, span, seen)?;
                self.constrain_ids(left_result, right_result, span, seen)?;
                true
            }
            (ConstraintTypeNode::Record(left_fields), ConstraintTypeNode::Record(right_fields)) => {
                for (name, right_field) in right_fields {
                    let Some((_, left_field)) =
                        left_fields.iter().find(|(candidate, _)| candidate == &name)
                    else {
                        let right_type = self.expand_constraint(right_field);
                        if admits_omission(&right_type) {
                            continue;
                        }
                        return self.type_error(
                            self.expand_constraint(left),
                            Type::Record(vec![(name, right_type)]),
                            span,
                        );
                    };
                    self.constrain_ids(*left_field, right_field, span, seen)?;
                }
                true
            }
            (ConstraintTypeNode::Array(left), ConstraintTypeNode::Array(right)) => {
                self.constrain_ids(left, right, span, seen)?;
                true
            }
            (ConstraintTypeNode::Region(left), ConstraintTypeNode::Region(right)) => {
                self.constrain_ids(left, right, span, seen)?;
                self.constrain_ids(right, left, span, seen)?;
                true
            }
            (
                ConstraintTypeNode::Variant {
                    cases: left,
                    open: left_open,
                },
                ConstraintTypeNode::Variant {
                    cases: right,
                    open: right_open,
                },
            ) => {
                if !right_open
                    && (left_open
                        || left
                            .iter()
                            .any(|(name, _)| !right.iter().any(|(candidate, _)| candidate == name)))
                {
                    false
                } else {
                    for (name, left) in left {
                        if let Some((_, right)) =
                            right.iter().find(|(candidate, _)| candidate == &name)
                        {
                            self.constrain_ids(left, *right, span, seen)?;
                        }
                    }
                    true
                }
            }
            (ConstraintTypeNode::Effects(left), ConstraintTypeNode::Effects(right)) => {
                left.is_subset(&right)
            }
            (
                ConstraintTypeNode::Effects(left),
                ConstraintTypeNode::OpenEffects {
                    labels: right_labels,
                    tail: right_tail,
                },
            ) => {
                let missing = left
                    .difference(&right_labels)
                    .cloned()
                    .collect::<BTreeSet<_>>();
                if !missing.is_empty() {
                    let missing = self.constraint_type(&Type::Effects(missing));
                    self.constrain_ids(missing, right_tail, span, seen)?;
                }
                true
            }
            (
                ConstraintTypeNode::OpenEffects {
                    labels: left_labels,
                    tail: left_tail,
                },
                ConstraintTypeNode::Effects(right),
            ) => {
                if !left_labels.is_subset(&right) {
                    false
                } else {
                    let right = self.constraint_type(&Type::Effects(right));
                    self.constrain_ids(left_tail, right, span, seen)?;
                    true
                }
            }
            (
                ConstraintTypeNode::OpenEffects {
                    labels: left_labels,
                    tail: left_tail,
                },
                ConstraintTypeNode::OpenEffects {
                    labels: right_labels,
                    tail: right_tail,
                },
            ) => {
                let missing = left_labels
                    .difference(&right_labels)
                    .cloned()
                    .collect::<BTreeSet<_>>();
                if !missing.is_empty() {
                    let missing = self.constraint_type(&Type::Effects(missing));
                    self.constrain_ids(missing, right_tail, span, seen)?;
                }
                let same_tail = self.constraint_types.borrow().same(left_tail, right_tail);
                if !same_tail {
                    let right_row = self.constraint_type(&Type::OpenEffects {
                        labels: right_labels,
                        tail: Box::new(self.expand_constraint(right_tail)),
                    });
                    self.constrain_ids(left_tail, right_row, span, seen)?;
                }
                true
            }
            (
                ConstraintTypeNode::Variable(left_variable),
                ConstraintTypeNode::Variable(right_variable),
            ) => {
                if left_variable == right_variable || !seen.insert((left_variable, right_variable))
                {
                    return Ok(());
                }
                let (inserted, lowers, uppers) = {
                    let mut variables = self.variables.borrow_mut();
                    let inserted =
                        !self.contains_constraint(&variables[left_variable as usize].upper, right);
                    if inserted {
                        variables[left_variable as usize].upper.push(right);
                        variables[right_variable as usize].lower.push(left);
                    }
                    (
                        inserted,
                        variables[left_variable as usize]
                            .lower
                            .iter()
                            .filter(|bound| self.constraint_variable(**bound).is_none())
                            .cloned()
                            .collect::<Vec<_>>(),
                        variables[right_variable as usize]
                            .upper
                            .iter()
                            .filter(|bound| self.constraint_variable(**bound).is_none())
                            .cloned()
                            .collect::<Vec<_>>(),
                    )
                };
                if !inserted {
                    return Ok(());
                }
                self.record_bound_insertion(left_variable, BoundDirection::Upper);
                self.record_bound_insertion(right_variable, BoundDirection::Lower);
                for lower in lowers {
                    self.add_lower_bound(right_variable, lower, span, seen)?;
                }
                for upper in uppers {
                    self.add_upper_bound(left_variable, upper, span, seen)?;
                }
                true
            }
            (ConstraintTypeNode::Variable(variable), _) => {
                let bound_level = {
                    let variables = self.variables.borrow();
                    self.constraint_types.borrow().level_of(right, &variables)
                };
                let variable_level = self.variables.borrow()[variable as usize].level;
                if bound_level <= variable_level {
                    self.add_upper_bound(variable, right, span, seen)?;
                } else {
                    let bound = self.expand_constraint(right);
                    let extruded = self.extrude(bound, false, variable_level, &mut HashMap::new());
                    let extruded = self.constraint_type(&extruded);
                    self.constrain_ids(left, extruded, span, seen)?;
                }
                true
            }
            (_, ConstraintTypeNode::Variable(variable)) => {
                let bound_level = {
                    let variables = self.variables.borrow();
                    self.constraint_types.borrow().level_of(left, &variables)
                };
                let variable_level = self.variables.borrow()[variable as usize].level;
                if bound_level <= variable_level {
                    self.add_lower_bound(variable, left, span, seen)?;
                } else {
                    let bound = self.expand_constraint(left);
                    let extruded = self.extrude(bound, true, variable_level, &mut HashMap::new());
                    let extruded = self.constraint_type(&extruded);
                    self.constrain_ids(extruded, right, span, seen)?;
                }
                true
            }
            (ConstraintTypeNode::Union(members), _) => members
                .into_iter()
                .all(|member| self.can_constrain_ids(member, right, span)),
            (_, ConstraintTypeNode::Union(members)) => members
                .into_iter()
                .any(|member| self.can_constrain_ids(left, member, span)),
            (ConstraintTypeNode::Opaque(left), ConstraintTypeNode::Opaque(right)) => left == right,
            (ConstraintTypeNode::Rigid(left), ConstraintTypeNode::Rigid(right)) => left == right,
            _ => false,
        };
        if compatible {
            Ok(())
        } else {
            self.type_error(
                self.expand_constraint(left),
                self.expand_constraint(right),
                span,
            )
        }
    }

    #[cfg(test)]
    fn can_constrain(&self, left: Type, right: Type, span: Span) -> bool {
        let left = self.constraint_type(&left);
        let right = self.constraint_type(&right);
        self.can_constrain_ids(left, right, span)
    }

    fn can_constrain_ids(
        &self,
        left: ConstraintTypeId,
        right: ConstraintTypeId,
        span: Span,
    ) -> bool {
        let insertion_count = self.bound_insertions.borrow().len();
        let variable_count = self.variables.borrow().len();
        let next_skolem = self.next_skolem.get();
        let result = self
            .constrain_ids(left, right, span, &mut HashSet::new())
            .is_ok();
        if !result {
            self.rollback_bounds(insertion_count, variable_count, next_skolem);
        }
        result
    }

    fn type_error<T>(&self, left: Type, right: Type, span: Span) -> Result<T, Diagnostic> {
        Err(Diagnostic::new(
            "BLOT_TYPE_ERROR",
            format!(
                "{} does not flow into {}.",
                self.show(&left),
                self.show(&right)
            ),
            span,
        ))
    }

    fn settle(&self, type_: Type, positive: bool) -> Type {
        self.settle_seen(type_, positive, &mut HashSet::new())
    }

    fn residual_signature(&self, type_: Type) -> Type {
        self.residual_signature_analysis(type_).0
    }

    fn residual_signature_analysis(&self, type_: Type) -> (Type, bool) {
        let mut unresolved = BTreeSet::new();
        let mut recursive = HashSet::new();
        let body = self.residual_signature_type(
            type_,
            &mut HashSet::new(),
            &mut HashMap::new(),
            &mut unresolved,
            &mut recursive,
        );
        unresolved.clear();
        let mut pending = vec![(&body, BTreeSet::<VariableId>::new())];
        while let Some((type_, bound)) = pending.pop() {
            match type_ {
                Type::Rigid(variable) => {
                    if !bound.contains(variable) {
                        unresolved.insert(*variable);
                    }
                }
                Type::Forall { variables, body } => {
                    let mut nested_bound = bound;
                    nested_bound.extend(variables);
                    pending.push((body, nested_bound));
                }
                Type::Function {
                    parameter,
                    effects,
                    result,
                } => {
                    pending.push((parameter, bound.clone()));
                    pending.push((effects, bound.clone()));
                    pending.push((result, bound));
                }
                Type::Record(fields) | Type::Variant { cases: fields, .. } => {
                    for (_, field) in fields {
                        pending.push((field, bound.clone()));
                    }
                }
                Type::Array(element) | Type::Region(element) => pending.push((element, bound)),
                Type::OpenEffects { tail, .. } => pending.push((tail, bound)),
                Type::Union(members) => {
                    for member in members {
                        pending.push((member, bound.clone()));
                    }
                }
                Type::Variable(_)
                | Type::Range { .. }
                | Type::Unit
                | Type::Effects(_)
                | Type::Opaque(_)
                | Type::Top
                | Type::Bottom => {}
            }
        }
        let signature = if unresolved.is_empty() {
            body
        } else {
            Type::Forall {
                variables: unresolved.into_iter().collect(),
                body: Box::new(body),
            }
        };
        (signature, !recursive.is_empty())
    }

    fn reify_runtime_type(&self, type_: &Type) -> Option<Value> {
        let mut next_hole = self.next_representation_hole.get();
        let value = reify_type_with_holes(type_, &mut next_hole);
        self.next_representation_hole.set(next_hole);
        value
    }

    fn residual_signature_type(
        &self,
        type_: Type,
        seen: &mut HashSet<VariableId>,
        resolved: &mut HashMap<VariableId, Type>,
        unresolved: &mut BTreeSet<VariableId>,
        recursive: &mut HashSet<VariableId>,
    ) -> Type {
        match type_ {
            Type::Variable(id) => {
                if let Some(type_) = resolved.get(&id) {
                    return type_.clone();
                }
                if !seen.insert(id) {
                    unresolved.insert(id);
                    recursive.insert(id);
                    return Type::Rigid(id);
                }
                let resolved_before_evidence = resolved.clone();
                let unresolved_before_evidence = unresolved.clone();
                let recursive_before_evidence = recursive.clone();
                let variable = self.variables.borrow()[id as usize].clone();
                let mut lower_evidence = variable
                    .lower
                    .iter()
                    .map(|bound| self.expand_constraint(*bound))
                    .filter(|bound| !matches!(bound, Type::Variable(variable) if *variable == id))
                    .collect::<Vec<_>>();
                let mut upper_evidence = variable
                    .upper
                    .iter()
                    .map(|bound| self.expand_constraint(*bound))
                    .collect::<Vec<_>>();
                let upper_evidence = match upper_evidence.len() {
                    0 => None,
                    1 => upper_evidence.pop(),
                    _ => Some(meet_types(upper_evidence)),
                };
                let evidence = if lower_evidence.is_empty() {
                    upper_evidence.clone()
                } else {
                    match lower_evidence.len() {
                        0 => None,
                        1 => lower_evidence.pop(),
                        _ => Some(join_types(lower_evidence)),
                    }
                };
                let mut result = if let Some(evidence) = evidence {
                    self.residual_signature_type(evidence, seen, resolved, unresolved, recursive)
                } else {
                    unresolved.insert(id);
                    Type::Rigid(id)
                };
                if unresolved.contains(&id)
                    && let Some(upper_evidence) = upper_evidence
                {
                    let lower_resolved = resolved.clone();
                    let lower_unresolved = unresolved.clone();
                    let lower_recursive = recursive.clone();
                    *resolved = resolved_before_evidence;
                    *unresolved = unresolved_before_evidence;
                    *recursive = recursive_before_evidence;
                    let upper = self.residual_signature_type(
                        upper_evidence,
                        seen,
                        resolved,
                        unresolved,
                        recursive,
                    );
                    if !unresolved.contains(&id) {
                        result = upper;
                    } else {
                        *resolved = lower_resolved;
                        *unresolved = lower_unresolved;
                        *recursive = lower_recursive;
                    }
                }
                seen.remove(&id);
                resolved.insert(id, result.clone());
                result
            }
            Type::Forall { variables, body } => Type::Forall {
                variables,
                body: Box::new(
                    self.residual_signature_type(*body, seen, resolved, unresolved, recursive),
                ),
            },
            Type::Function {
                parameter,
                effects,
                result,
            } => Type::Function {
                parameter: Box::new(
                    self.residual_signature_type(*parameter, seen, resolved, unresolved, recursive),
                ),
                effects: Box::new(self.settle(*effects, true)),
                result: Box::new(
                    self.residual_signature_type(*result, seen, resolved, unresolved, recursive),
                ),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, type_)| {
                        (
                            name,
                            self.residual_signature_type(
                                type_, seen, resolved, unresolved, recursive,
                            ),
                        )
                    })
                    .collect(),
            ),
            Type::Array(element) => Type::Array(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Region(element) => Type::Region(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Box::new(
                    self.residual_signature_type(*tail, seen, resolved, unresolved, recursive),
                ),
            },
            Type::Variant { cases, open } => Type::Variant {
                cases: cases
                    .into_iter()
                    .map(|(name, type_)| {
                        (
                            name,
                            self.residual_signature_type(
                                type_, seen, resolved, unresolved, recursive,
                            ),
                        )
                    })
                    .collect(),
                open,
            },
            Type::Union(members) => {
                let members = members
                    .into_iter()
                    .map(|member| {
                        self.residual_signature_type(member, seen, resolved, unresolved, recursive)
                    })
                    .collect::<Vec<_>>();
                let mut control_cases = BTreeMap::<String, Vec<Type>>::new();
                for member in &members {
                    let Type::Variant { cases, .. } = member else {
                        continue;
                    };
                    for (name, payload) in cases {
                        if name.contains('$') {
                            control_cases
                                .entry(name.clone())
                                .or_default()
                                .push(payload.clone());
                        }
                    }
                }
                if control_cases.is_empty() {
                    Type::Union(members)
                } else {
                    Type::Variant {
                        cases: control_cases
                            .into_iter()
                            .map(|(name, mut payloads)| {
                                let payload = if payloads.len() == 1 {
                                    payloads.pop().expect("one control payload exists")
                                } else {
                                    join_types(payloads)
                                };
                                (name, payload)
                            })
                            .collect(),
                        open: false,
                    }
                }
            }
            other => other,
        }
    }

    fn settle_seen(&self, type_: Type, positive: bool, seen: &mut HashSet<VariableId>) -> Type {
        match type_ {
            Type::Variable(id) => {
                if !seen.insert(id) {
                    return if positive { Type::Bottom } else { Type::Top };
                }
                let variable = self.variables.borrow()[id as usize].clone();
                let bounds = if positive {
                    variable.lower
                } else {
                    variable.upper
                };
                let mut settled = bounds
                    .into_iter()
                    .map(|bound| self.expand_constraint(bound))
                    .map(|bound| self.settle_seen(bound, positive, seen))
                    .collect::<Vec<_>>();
                seen.remove(&id);
                if settled.is_empty() {
                    return if positive { Type::Bottom } else { Type::Top };
                }
                if settled.len() == 1 {
                    return settled.remove(0);
                }
                if positive {
                    join_types(settled)
                } else {
                    meet_types(settled)
                }
            }
            Type::Forall { variables, body } => Type::Forall {
                variables,
                body: Box::new(self.settle_seen(*body, positive, seen)),
            },
            Type::Function {
                parameter,
                effects,
                result,
            } => Type::Function {
                parameter: Box::new(self.settle_seen(*parameter, !positive, seen)),
                effects: Box::new(self.settle_seen(*effects, positive, seen)),
                result: Box::new(self.settle_seen(*result, positive, seen)),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, type_)| (name, self.settle_seen(type_, positive, seen)))
                    .collect(),
            ),
            Type::Array(element) => {
                Type::Array(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Region(element) => {
                Type::Region(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Box::new(self.settle_seen(*tail, positive, seen)),
            },
            Type::Variant { cases, open } => Type::Variant {
                cases: cases
                    .into_iter()
                    .map(|(name, type_)| (name, self.settle_seen(type_, positive, seen)))
                    .collect(),
                open,
            },
            Type::Union(members) => Type::Union(
                members
                    .into_iter()
                    .map(|member| self.settle_seen(member, positive, seen))
                    .collect(),
            ),
            other => other,
        }
    }

    fn join_effects(&self, left: Type, right: Type) -> Result<Type, Diagnostic> {
        match (left.clone(), right.clone()) {
            (Type::Effects(mut left), Type::Effects(right)) => {
                left.extend(right);
                Ok(Type::Effects(left))
            }
            (Type::Bottom, _) => Ok(right),
            (_, Type::Bottom) => Ok(left),
            _ => {
                let joined = self.fresh();
                self.constrain(left, joined.clone(), Span { start: 0, end: 0 })?;
                self.constrain(right, joined.clone(), Span { start: 0, end: 0 })?;
                Ok(joined)
            }
        }
    }

    fn effect_value_signature(&self, type_: &Type) -> Option<(Type, Type)> {
        let Type::Function {
            parameter,
            effects,
            result,
        } = type_
        else {
            return None;
        };
        if !matches!(self.settle((**parameter).clone(), false), Type::Unit) {
            return None;
        }
        Some(((**effects).clone(), (**result).clone()))
    }

    fn bind_pattern(
        &self,
        module: &Module,
        pattern: PatternId,
        type_: Type,
        environment: &mut TypeEnvironment,
    ) {
        self.bind_pattern_at_phase(module, pattern, type_, environment, self.phase.get());
    }

    fn bind_pattern_at_phase(
        &self,
        module: &Module,
        pattern: PatternId,
        type_: Type,
        environment: &mut TypeEnvironment,
        phase: Phase,
    ) {
        match &module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => {
                Rc::make_mut(&mut environment.names).insert(name.clone(), Typing::Mono(type_));
                Rc::make_mut(&mut environment.phases).insert(name.clone(), phase);
            }
            Pattern::Tuple { elements, .. } => {
                let fields = elements
                    .iter()
                    .enumerate()
                    .map(|(index, pattern)| {
                        let field = self.fresh();
                        self.bind_pattern_at_phase(
                            module,
                            *pattern,
                            field.clone(),
                            environment,
                            phase,
                        );
                        (index.to_string(), field)
                    })
                    .collect();
                let _ = self.constrain(type_, Type::Record(fields), module.span);
            }
            Pattern::Array { elements, .. } => {
                let element = self.fresh();
                for pattern in elements {
                    self.bind_pattern_at_phase(
                        module,
                        *pattern,
                        element.clone(),
                        environment,
                        phase,
                    );
                }
                let _ = self.constrain(type_, Type::Array(Box::new(element)), module.span);
            }
            Pattern::Constructor { name, payload, .. } => {
                let payload_type = if let Some(payload) = payload {
                    let payload_type = self.fresh();
                    self.bind_pattern_at_phase(
                        module,
                        *payload,
                        payload_type.clone(),
                        environment,
                        phase,
                    );
                    payload_type
                } else {
                    Type::Unit
                };
                let _ = self.constrain(
                    Type::Variant {
                        cases: vec![(name.clone(), payload_type)],
                        open: false,
                    },
                    type_,
                    module.span,
                );
            }
            Pattern::Unit { .. } => {
                let _ = self.constrain(type_, Type::Unit, module.span);
            }
            Pattern::Int { value, .. } => {
                let _ = self.constrain(
                    type_,
                    Type::Range {
                        domain: Domain::Int,
                        low: Some(Scalar::Int(value.clone())),
                        high: Some(Scalar::Int(value.clone())),
                    },
                    module.span,
                );
            }
            Pattern::Text { value, .. } => {
                let _ = self.constrain(
                    type_,
                    Type::Range {
                        domain: Domain::Text,
                        low: Some(Scalar::Text(value.clone())),
                        high: Some(Scalar::Text(value.clone())),
                    },
                    module.span,
                );
            }
            Pattern::Float { .. } => {
                let _ = self.constrain(type_, float_type(), module.span);
            }
            Pattern::Shape { fields, .. } => {
                let required = fields
                    .iter()
                    .map(|field| {
                        let field_type = self.fresh();
                        self.bind_pattern_at_phase(
                            module,
                            field.pattern,
                            field_type.clone(),
                            environment,
                            phase,
                        );
                        (field.name.clone(), field_type)
                    })
                    .collect();
                let _ = self.constrain(type_, Type::Record(required), module.span);
            }
            _ => {}
        }
    }

    fn pattern_type(
        &self,
        module: &Module,
        pattern: PatternId,
        environment: &mut TypeEnvironment,
    ) -> Option<Type> {
        let type_ = match &module.arena.patterns[pattern.0 as usize] {
            Pattern::Wildcard { .. } | Pattern::Name { .. } => self.fresh(),
            Pattern::Pin { name, .. } => self.instantiate(environment.lookup(name)?),
            Pattern::Int { value, .. } => Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(value.clone())),
                high: Some(Scalar::Int(value.clone())),
            },
            Pattern::Float { .. } => float_type(),
            Pattern::Text { value, .. } => Type::Range {
                domain: Domain::Text,
                low: Some(Scalar::Text(value.clone())),
                high: Some(Scalar::Text(value.clone())),
            },
            Pattern::Unit { .. } => Type::Unit,
            Pattern::Tuple { elements, .. } => Type::Record(
                elements
                    .iter()
                    .enumerate()
                    .map(|(index, pattern)| {
                        (
                            index.to_string(),
                            self.pattern_type(module, *pattern, environment)
                                .unwrap_or_else(|| self.fresh()),
                        )
                    })
                    .collect(),
            ),
            Pattern::Array { elements, .. } => Type::Array(Box::new(union_types(
                elements
                    .iter()
                    .filter_map(|pattern| self.pattern_type(module, *pattern, environment))
                    .collect(),
            ))),
            Pattern::Constructor { name, payload, .. } => Type::Variant {
                cases: vec![(
                    name.clone(),
                    payload
                        .and_then(|payload| self.pattern_type(module, payload, environment))
                        .unwrap_or(Type::Unit),
                )],
                open: false,
            },
            Pattern::Shape { fields, .. } => Type::Record(
                fields
                    .iter()
                    .map(|field| {
                        (
                            field.name.clone(),
                            self.pattern_type(module, field.pattern, environment)
                                .unwrap_or_else(|| self.fresh()),
                        )
                    })
                    .collect(),
            ),
        };
        self.bind_pattern(module, pattern, type_.clone(), environment);
        Some(type_)
    }

    fn bind_pattern_from_type(
        &self,
        module: &Module,
        pattern: PatternId,
        type_: &Type,
        environment: &mut TypeEnvironment,
    ) {
        self.bind_pattern_from_type_seen(module, pattern, type_, environment, &mut HashSet::new());
    }

    fn bind_pattern_from_type_seen(
        &self,
        module: &Module,
        pattern: PatternId,
        type_: &Type,
        environment: &mut TypeEnvironment,
        seen: &mut HashSet<VariableId>,
    ) {
        match (&module.arena.patterns[pattern.0 as usize], type_) {
            (_, Type::Variable(id)) => {
                if !seen.insert(*id) {
                    return;
                }
                let variable = self.variables.borrow()[*id as usize].clone();
                for bound in variable.upper.iter().chain(&variable.lower) {
                    let bound = self.expand_constraint(*bound);
                    self.bind_pattern_from_type_seen(module, pattern, &bound, environment, seen);
                }
                seen.remove(id);
            }
            (Pattern::Name { name, .. }, Type::Top | Type::Bottom) => {
                let _ = name;
            }
            (Pattern::Name { name, .. }, type_) => {
                Rc::make_mut(&mut environment.names)
                    .insert(name.clone(), Typing::Mono(type_.clone()));
                Rc::make_mut(&mut environment.phases).insert(name.clone(), self.phase.get());
            }
            (Pattern::Tuple { elements, .. }, Type::Record(fields))
            | (Pattern::Array { elements, .. }, Type::Record(fields)) => {
                for (index, pattern) in elements.iter().enumerate() {
                    if let Some((_, field)) =
                        fields.iter().find(|(name, _)| name == &index.to_string())
                    {
                        self.bind_pattern_from_type_seen(
                            module,
                            *pattern,
                            field,
                            environment,
                            seen,
                        );
                    }
                }
            }
            (Pattern::Constructor { name, payload, .. }, Type::Variant { cases, .. }) => {
                if let Some(payload) = payload
                    && let Some((_, payload_type)) =
                        cases.iter().find(|(candidate, _)| candidate == name)
                {
                    self.bind_pattern_from_type_seen(
                        module,
                        *payload,
                        payload_type,
                        environment,
                        seen,
                    );
                }
            }
            (Pattern::Shape { fields, .. }, Type::Record(type_fields)) => {
                for field in fields {
                    if let Some((_, field_type)) = type_fields
                        .iter()
                        .find(|(candidate, _)| candidate == &field.name)
                    {
                        self.bind_pattern_from_type_seen(
                            module,
                            field.pattern,
                            field_type,
                            environment,
                            seen,
                        );
                    }
                }
            }
            (_, Type::Union(members)) => {
                for member in members {
                    self.bind_pattern_from_type_seen(module, pattern, member, environment, seen);
                }
            }
            _ => {}
        }
    }

    fn validate_matchable_pins(
        &self,
        module: &Module,
        pattern: PatternId,
        environment: &TypeEnvironment,
    ) -> Result<(), Diagnostic> {
        match &module.arena.patterns[pattern.0 as usize] {
            Pattern::Pin { name, span } => {
                let Some(typing) = environment.lookup(name) else {
                    let code = if environment.is_forward(name) {
                        "BLOT_FORWARD_REFERENCE"
                    } else {
                        "BLOT_UNBOUND"
                    };
                    return Err(Diagnostic::new(
                        code,
                        format!("`{name}` is not in scope for this pinned pattern."),
                        *span,
                    ));
                };
                let type_ = self.instantiate(typing);
                if self.pinned_domain(&type_, &mut HashSet::new()).is_none() {
                    return Err(Diagnostic::new(
                        "BLOT_UNMATCHABLE_PIN",
                        format!(
                            "Pinned `{name}` must have a known Int or Str type, found {}.",
                            self.show(&type_)
                        ),
                        *span,
                    ));
                }
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for pattern in elements {
                    self.validate_matchable_pins(module, *pattern, environment)?;
                }
            }
            Pattern::Constructor {
                payload: Some(payload),
                ..
            } => self.validate_matchable_pins(module, *payload, environment)?,
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    self.validate_matchable_pins(module, field.pattern, environment)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn pinned_domain(&self, type_: &Type, seen: &mut HashSet<VariableId>) -> Option<Domain> {
        match type_ {
            Type::Forall { body, .. } => self.pinned_domain(body, seen),
            Type::Range { domain, .. } if matches!(domain, Domain::Int | Domain::Text) => {
                Some(*domain)
            }
            Type::Union(members) => {
                let mut domain = None;
                for member in members {
                    let found = self.pinned_domain(member, seen)?;
                    if domain.is_some_and(|domain| domain != found) {
                        return None;
                    }
                    domain = Some(found);
                }
                domain
            }
            Type::Variable(id) if seen.insert(*id) => {
                let variable = self.variables.borrow()[*id as usize].clone();
                let mut domain = None;
                for bound in variable.lower.iter().chain(&variable.upper) {
                    let bound = self.expand_constraint(*bound);
                    let Some(found) = self.pinned_domain(&bound, seen) else {
                        continue;
                    };
                    if domain.is_some_and(|domain| domain != found) {
                        return None;
                    }
                    domain = Some(found);
                }
                seen.remove(id);
                domain
            }
            _ => None,
        }
    }

    fn contains_unevidenced(&self, type_: &Type, seen: &mut HashSet<VariableId>) -> bool {
        match type_ {
            Type::Top => true,
            Type::Forall { body, .. } => self.contains_unevidenced(body, seen),
            Type::Variable(id) if seen.insert(*id) => {
                let variable = self.variables.borrow()[*id as usize].clone();
                let found = variable
                    .lower
                    .iter()
                    .chain(&variable.upper)
                    .map(|bound| self.expand_constraint(*bound))
                    .any(|bound| self.contains_unevidenced(&bound, seen));
                seen.remove(id);
                found
            }
            Type::Function {
                parameter,
                effects,
                result,
            } => {
                self.contains_unevidenced(parameter, seen)
                    || self.contains_unevidenced(effects, seen)
                    || self.contains_unevidenced(result, seen)
            }
            Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
                .iter()
                .any(|(_, type_)| self.contains_unevidenced(type_, seen)),
            Type::Array(element) => self.contains_unevidenced(element, seen),
            Type::Union(members) => members
                .iter()
                .any(|member| self.contains_unevidenced(member, seen)),
            _ => false,
        }
    }

    fn evaluate(
        &self,
        path: &str,
        expression: ExpressionId,
        environment: &ValueEnvironment,
        phase: Phase,
    ) -> Result<Value, Diagnostic> {
        run(evaluate_expression(
            self.context.clone(),
            Rc::new(path.to_owned()),
            expression,
            environment.clone(),
            Runtime::new(phase, path.to_owned()),
        ))
    }

    fn evaluate_binding(
        &self,
        path: &str,
        _module: &Module,
        pattern: PatternId,
        expression: ExpressionId,
        environment: &ValueEnvironment,
        phase: Phase,
    ) -> Result<Value, Diagnostic> {
        let key = (pattern, expression, phase);
        if let Some(value) = self
            .context
            .evaluated_bindings
            .borrow()
            .get(path)
            .and_then(|bindings| bindings.get(&key))
        {
            return Ok(value.clone());
        }
        let evaluated = run(evaluate_binding(
            self.context.clone(),
            Rc::new(path.to_owned()),
            pattern,
            expression,
            environment.clone(),
            Runtime::new(phase, path.to_owned()),
        ));
        if let Ok(value) = &evaluated {
            self.context
                .evaluated_bindings
                .borrow_mut()
                .entry(path.to_owned())
                .or_default()
                .insert(key, value.clone());
        }
        evaluated
    }

    fn bridge_runtime_value(&self, value: &Value) -> Type {
        match value {
            Value::Closure { .. } | Value::ModuleClosure { .. } | Value::IndexedStep { .. } => {
                self.fresh()
            }
            Value::Shape(fields) => Type::Record(
                fields
                    .iter()
                    .map(|(name, value)| (name.clone(), self.bridge_runtime_value(value)))
                    .collect(),
            ),
            Value::RegionType(element) => {
                Type::Region(Box::new(self.bridge_runtime_value(element)))
            }
            Value::Region { store, start, end } => Type::Region(Box::new(join_types(
                store.borrow()[*start..*end]
                    .iter()
                    .map(|value| self.bridge_runtime_value(value))
                    .collect(),
            ))),
            Value::RegionRejoin { .. } => Type::Opaque("Rejoin".to_owned()),
            Value::Array(elements) => Type::Array(Box::new(join_types(
                elements
                    .iter()
                    .map(|value| self.bridge_runtime_value(value))
                    .collect(),
            ))),
            Value::EmptyArray { .. } => Type::Array(Box::new(Type::Bottom)),
            Value::Tag { name, payload } => Type::Variant {
                cases: vec![(
                    name.clone(),
                    payload
                        .as_deref()
                        .map(|payload| self.bridge_runtime_value(payload))
                        .unwrap_or(Type::Unit),
                )],
                open: false,
            },
            _ => self.bridge(value).unwrap_or(Type::Top),
        }
    }

    fn bridge(&self, value: &Value) -> Option<Type> {
        match value {
            Value::Int(value) => Some(Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(value.clone())),
                high: Some(Scalar::Int(value.clone())),
            }),
            Value::Float(_) => Some(float_type()),
            Value::Float32(_) => Some(float32_type()),
            Value::Text(value) => Some(Type::Range {
                domain: Domain::Text,
                low: Some(Scalar::Text(value.clone())),
                high: Some(Scalar::Text(value.clone())),
            }),
            Value::Unit => Some(Type::Unit),
            Value::Shape(fields) => Some(Type::Record(
                fields
                    .iter()
                    .map(|(name, value)| Some((name.clone(), self.bridge(value)?)))
                    .collect::<Option<Vec<_>>>()?,
            )),
            Value::RegionType(element) => Some(Type::Region(Box::new(self.bridge(element)?))),
            Value::Region { store, start, end } => Some(Type::Region(Box::new(union_types(
                store.borrow()[*start..*end]
                    .iter()
                    .filter_map(|value| self.bridge(value))
                    .collect(),
            )))),
            Value::RegionRejoin { .. } => Some(Type::Opaque("Rejoin".to_owned())),
            Value::Array(elements) => Some(Type::Array(Box::new(union_types(
                elements
                    .iter()
                    .filter_map(|value| self.bridge(value))
                    .collect(),
            )))),
            Value::EmptyArray { .. } => Some(Type::Array(Box::new(Type::Bottom))),
            Value::Tag { name, payload } => Some(Type::Variant {
                cases: vec![(
                    name.clone(),
                    payload
                        .as_deref()
                        .and_then(|value| self.bridge(value))
                        .unwrap_or(Type::Unit),
                )],
                open: false,
            }),
            Value::Range { low, high, domain } => Some(Type::Range {
                domain: match domain.unwrap_or_else(|| {
                    if matches!(**low, Value::Text(_)) || matches!(**high, Value::Text(_)) {
                        ValueDomain::Text
                    } else {
                        ValueDomain::Int
                    }
                }) {
                    ValueDomain::Int => Domain::Int,
                    ValueDomain::Text => Domain::Text,
                    ValueDomain::Float => Domain::Float,
                    ValueDomain::Float32 => Domain::Float32,
                },
                low: scalar_bound(low),
                high: scalar_bound(high),
            }),
            Value::Union(members) => Some(join_types(
                members
                    .iter()
                    .filter_map(|member| self.bridge(member))
                    .collect(),
            )),
            Value::Unbounded => Some(Type::Top),
            Value::Arrow {
                domain,
                codomain,
                effects,
                effect_tail,
            } => {
                let labels = effects
                    .iter()
                    .filter_map(effect_label)
                    .collect::<BTreeSet<_>>();
                let effects = match effect_tail {
                    Some(tail) => Type::OpenEffects {
                        labels,
                        tail: Box::new(Type::Rigid(*tail)),
                    },
                    None => Type::Effects(labels),
                };
                Some(Type::Function {
                    parameter: Box::new(self.bridge(domain)?),
                    effects: Box::new(effects),
                    result: Box::new(self.bridge(codomain)?),
                })
            }
            Value::Forall { variable, body } => Some(Type::Forall {
                variables: vec![*variable],
                body: Box::new(self.bridge(body)?),
            }),
            Value::Effect { id, name, .. } => Some(Type::Opaque(format!("Effect:{id}:{name}"))),
            Value::Extended { inner, .. } => self.bridge(inner),
            Value::Sealed { name, .. } => Some(Type::Opaque(format!("Sealed:{name}"))),
            Value::OpaqueType(name) => Some(Type::Opaque(name.clone())),
            Value::Vector(_) => Some(Type::Opaque("F32x4".to_owned())),
            Value::VectorMask(_) => Some(Type::Opaque("F32x4Mask".to_owned())),
            Value::IntegerVector { bits, lanes } => {
                Some(Type::Opaque(format!("I{bits}x{}", lanes.len())))
            }
            Value::IntegerVectorMask { bits, lanes } => {
                Some(Type::Opaque(format!("I{bits}x{}Mask", lanes.len())))
            }
            Value::TypeVariable(id) => Some(Type::Rigid(*id)),
            _ => None,
        }
    }

    fn show(&self, type_: &Type) -> String {
        match self.settle(type_.clone(), true) {
            Type::Variable(id) => format!("'t{id}"),
            Type::Rigid(id) => format!("'s{id}"),
            Type::Forall { variables, body } => {
                let replacements = variables
                    .iter()
                    .enumerate()
                    .map(|(index, variable)| (*variable, Type::Opaque(format!("'q{index}"))))
                    .collect();
                let names = (0..variables.len())
                    .map(|index| format!("'q{index}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!(
                    "forall {names}. {}",
                    self.show(&substitute_rigid(*body, &replacements))
                )
            }
            Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(low)),
                high: Some(Scalar::Int(high)),
            } if low == BigInt::from(i64::MIN) && high == BigInt::from(i64::MAX) => {
                "Int".to_owned()
            }
            Type::Range {
                domain: Domain::Text,
                low: None,
                high: None,
            } => "Str".to_owned(),
            Type::Range {
                domain: Domain::Float,
                ..
            } => "F64".to_owned(),
            Type::Range {
                domain: Domain::Float32,
                ..
            } => "F32".to_owned(),
            Type::Range { low, high, .. } => format!("{}..{}", show_bound(low), show_bound(high)),
            Type::Unit => "Unit".to_owned(),
            Type::Function {
                parameter,
                effects,
                result,
            } => format!(
                "{} -> {}{}",
                self.show(&parameter),
                self.show(&result),
                show_effects(&effects)
            ),
            Type::Record(fields) => format!(
                "{{ {} }}",
                fields
                    .iter()
                    .map(|(name, type_)| format!(".{name} = {}", self.show(type_)))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            Type::Array(element) => format!("[{}]", self.show(&element)),
            Type::Region(element) => format!("Region {}", self.show(&element)),
            Type::Variant { cases, .. } => cases
                .iter()
                .map(|(name, payload)| {
                    if matches!(payload, Type::Unit) {
                        format!("#{name}")
                    } else {
                        format!("#{name} {}", self.show(payload))
                    }
                })
                .collect::<Vec<_>>()
                .join(" | "),
            Type::Effects(labels) => format!(
                "{{ {} }}",
                labels.into_iter().collect::<Vec<_>>().join(", ")
            ),
            Type::OpenEffects { labels, tail } => {
                let mut parts = labels.into_iter().collect::<Vec<_>>();
                parts.push(format!("..{}", self.show(&tail)));
                format!("{{ {} }}", parts.join(", "))
            }
            Type::Union(members) => show_union(
                union_members(&members)
                    .into_iter()
                    .map(|member| self.show(member))
                    .collect::<Vec<_>>(),
            ),
            Type::Opaque(name) => name,
            Type::Top => "⊤".to_owned(),
            Type::Bottom => "⊥".to_owned(),
        }
    }
}

/// Renders a union as a set rather than as the list the solver happened to
/// build.
///
/// A union carries one member per contributing bound, so a construct that
/// residualizes per iteration contributes one per iteration. `Int | Int` and
/// `Int` describe the same values, and the printed type is what inference tests
/// assert, so the repetition would make a lattice change unreadable rather than
/// visible. `⊥` inhabits nothing and drops out beside any other member; a union
/// of nothing but `⊥` is still `⊥`.
/// The members a union needs, with the ones another member already covers left
/// out.
///
/// A domain absorbs its own sub-ranges: `Int | 0..0` is `Int`, because every
/// value of `0..0` is a value of `Int`. This is the shape a residualized
/// accumulator produces — the initial literal's singleton beside the widened
/// domain, once per iteration — and printing all of them describes the
/// solver's bookkeeping rather than the type.
fn union_members(members: &[Type]) -> Vec<&Type> {
    members
        .iter()
        .enumerate()
        .filter(|(index, member)| {
            !members.iter().enumerate().any(|(other, candidate)| {
                // Keep the first of two members that cover each other, so an
                // exact repeat leaves one behind rather than none.
                let earlier = other < *index;
                (earlier || !covers(member, candidate)) && covers(candidate, member)
            })
        })
        .map(|(_, member)| member)
        .collect()
}

/// Does every value of `inner` inhabit `outer`?
///
/// Two ranges of one domain nest when the outer bounds are no tighter, and an
/// absent bound is the domain's own end. Arrays nest by their elements, and
/// `⊥` is covered by anything.
fn covers(outer: &Type, inner: &Type) -> bool {
    // Nothing inhabits `⊥`, so every member covers it.
    if matches!(inner, Type::Bottom) {
        return true;
    }
    if let (Type::Array(outer), Type::Array(inner)) = (outer, inner) {
        return covers(outer, inner);
    }
    let (
        Type::Range {
            domain: outer_domain,
            low: outer_low,
            high: outer_high,
        },
        Type::Range {
            domain: inner_domain,
            low: inner_low,
            high: inner_high,
        },
    ) = (outer, inner)
    else {
        return false;
    };
    if outer_domain != inner_domain {
        return false;
    }
    let low = match (outer_low, inner_low) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(outer), Some(inner)) => outer <= inner,
    };
    let high = match (outer_high, inner_high) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(outer), Some(inner)) => outer >= inner,
    };
    low && high
}

fn show_union(members: Vec<String>) -> String {
    let mut shown = Vec::new();
    for member in members {
        if member == "⊥" {
            continue;
        }
        if shown.contains(&member) {
            continue;
        }
        shown.push(member);
    }
    if shown.is_empty() {
        return "⊥".to_owned();
    }
    shown.join(" | ")
}

struct Inferred {
    type_: Type,
    effects: Type,
}

impl Inferred {
    fn pure(type_: Type) -> Self {
        Self {
            type_,
            effects: Type::Effects(BTreeSet::new()),
        }
    }
}

fn simd_primitive_type(name: &str) -> Option<Type> {
    let (prefix, operation) = name.strip_prefix('@')?.split_once('.')?;
    let operation = operation.strip_suffix("_wrapping").unwrap_or(operation);
    let (vector_name, mask_name) = match prefix {
        "f32x4" => ("F32x4", "F32x4Mask"),
        "i32x4" => ("I32x4", "I32x4Mask"),
        "i16x8" => ("I16x8", "I16x8Mask"),
        "i8x16" => ("I8x16", "I8x16Mask"),
        _ => return None,
    };
    let vector = Type::Opaque(vector_name.to_owned());
    let mask = Type::Opaque(mask_name.to_owned());
    let scalar = if prefix == "f32x4" {
        float32_type()
    } else {
        signed_lane_type(match prefix {
            "i32x4" => 32,
            "i16x8" => 16,
            _ => 8,
        })
    };
    if operation == "of" {
        if prefix == "f32x4" || prefix == "i32x4" {
            let argument = if name.ends_with("_wrapping") {
                int_type()
            } else {
                scalar
            };
            return Some(curried(vec![argument; 4], vector));
        }
        return None;
    }
    if operation == "splat" {
        let argument = if name.ends_with("_wrapping") {
            int_type()
        } else {
            scalar
        };
        return Some(curried(vec![argument], vector));
    }
    if operation == "lane" && prefix == "i32x4" {
        return Some(curried(vec![vector, integer_range(0, 3)], int_type()));
    }
    if operation.starts_with("with_lane") {
        let argument = if name.ends_with("_wrapping") {
            int_type()
        } else {
            scalar
        };
        return Some(curried(vec![vector.clone(), argument], vector));
    }
    if operation.starts_with("lane") {
        return Some(curried(vec![vector], int_type()));
    }
    if matches!(operation, "mask_bitmask" | "mask_all" | "mask_any") {
        return Some(curried(vec![mask], int_type()));
    }
    if operation == "select" {
        return Some(curried(vec![mask, vector.clone(), vector.clone()], vector));
    }
    if matches!(operation, "convert_i32_s" | "convert_i32_u") {
        return Some(curried(
            vec![Type::Opaque("I32x4".to_owned())],
            Type::Opaque("F32x4".to_owned()),
        ));
    }
    if matches!(operation, "trunc_sat_f32_s" | "trunc_sat_f32_u") {
        return Some(curried(
            vec![Type::Opaque("F32x4".to_owned())],
            Type::Opaque("I32x4".to_owned()),
        ));
    }
    if matches!(
        operation,
        "abs" | "neg" | "sqrt" | "ceil" | "floor" | "trunc" | "nearest" | "not"
    ) {
        return Some(curried(vec![vector.clone()], vector));
    }
    if matches!(operation, "shl" | "shr_s" | "shr_u") {
        return Some(curried(vec![vector.clone(), int_type()], vector));
    }
    if matches!(
        operation,
        "eq" | "ne"
            | "less"
            | "le"
            | "gt"
            | "ge"
            | "lt_s"
            | "lt_u"
            | "gt_s"
            | "gt_u"
            | "le_s"
            | "le_u"
            | "ge_s"
            | "ge_u"
    ) {
        return Some(curried(vec![vector.clone(), vector], mask));
    }
    if matches!(
        operation,
        "add"
            | "sub"
            | "mul"
            | "div"
            | "and"
            | "or"
            | "xor"
            | "min"
            | "max"
            | "pmin"
            | "pmax"
            | "min_s"
            | "min_u"
            | "max_s"
            | "max_u"
    ) {
        return Some(curried(vec![vector.clone(), vector.clone()], vector));
    }
    None
}

fn primitive_type(checker: &Checker, name: &str) -> Option<Type> {
    let int = int_type();
    let text = text_type();
    let float = float_type();
    let f32_ = float32_type();
    let bool_ = bool_type();
    let ordering = variant(&["Less", "Equal", "Greater"]);
    let vector = Type::Opaque("F32x4".to_owned());
    let mask = Type::Opaque("F32x4Mask".to_owned());
    if let Some(type_) = simd_primitive_type(name) {
        return Some(type_);
    }
    let type_ = match name {
        "@int.add" | "@int.sub" | "@int.mul" | "@int.div" | "@int.rem" => {
            curried(vec![int.clone(), int.clone()], int)
        }
        "@int.neg" => curried(vec![int.clone()], int),
        "@int.cmp" => curried(vec![int.clone(), int], ordering.clone()),
        "@float.add" | "@float.sub" | "@float.mul" | "@float.div" | "@float.rem" => {
            curried(vec![float.clone(), float.clone()], float)
        }
        "@float.neg" => curried(vec![float.clone()], float),
        "@float.cmp" => curried(vec![float.clone(), float], ordering.clone()),
        "@float.is_nan" => curried(vec![float], bool_.clone()),
        "@float.of_int" => curried(vec![int], float),
        "@int.of_float" => curried(vec![float], int),
        "@f32.add" | "@f32.sub" | "@f32.mul" | "@f32.div" => {
            curried(vec![f32_.clone(), f32_.clone()], f32_)
        }
        "@f32.neg" => curried(vec![f32_.clone()], f32_),
        "@f32.cmp" => curried(vec![f32_.clone(), f32_], ordering),
        "@f32.is_nan" => curried(vec![f32_], bool_.clone()),
        "@f32.of_float" => curried(vec![float], f32_),
        "@float.of_f32" => curried(vec![f32_], float),
        "@f32x4.of" => curried(vec![float32_type(); 4], vector),
        "@f32x4.splat" => curried(vec![float32_type()], vector),
        "@f32x4.add" | "@f32x4.sub" | "@f32x4.mul" | "@f32x4.div" => {
            curried(vec![vector.clone(), vector.clone()], vector)
        }
        "@f32x4.eq" | "@f32x4.less" => curried(vec![vector.clone(), vector], mask),
        "@f32x4.select" => curried(vec![mask, vector.clone(), vector.clone()], vector),
        "@f32x4.shuffle" => curried(
            vec![
                vector.clone(),
                vector.clone(),
                int_type(),
                int_type(),
                int_type(),
                int_type(),
            ],
            vector,
        ),
        "@f32x4.sum" | "@f32x4.x" | "@f32x4.y" | "@f32x4.z" | "@f32x4.w" => {
            curried(vec![vector], f32_)
        }
        "@text.concat" => curried(vec![text.clone(), text.clone()], text),
        "@text.len" => curried(vec![text], int),
        "@text.cmp" => curried(vec![text.clone(), text], ordering),
        "@text.contains" => curried(vec![text.clone(), text], bool_),
        "@text.of_int" => curried(vec![int], text),
        "@region.type" => curried(
            vec![Type::Opaque("Type".to_owned())],
            Type::Opaque("Type".to_owned()),
        ),
        "@region.claim" => {
            let element = checker.fresh();
            curried(
                vec![Type::Array(Box::new(element.clone()))],
                Type::Region(Box::new(element)),
            )
        }
        "@region.length" => curried(vec![Type::Region(Box::new(checker.fresh()))], int.clone()),
        "@region.get" => {
            let element = checker.fresh();
            curried(
                vec![Type::Region(Box::new(element.clone())), int.clone()],
                Type::Variant {
                    cases: vec![
                        ("Some".to_owned(), element),
                        ("None".to_owned(), Type::Unit),
                    ],
                    open: false,
                },
            )
        }
        "@region.set" => {
            let element = checker.fresh();
            let region = Type::Region(Box::new(element.clone()));
            curried(
                vec![region.clone(), int.clone(), element],
                Type::Variant {
                    cases: vec![
                        ("Updated".to_owned(), region.clone()),
                        ("SetOutOfBounds".to_owned(), region),
                    ],
                    open: false,
                },
            )
        }
        "@region.replace" => {
            let element = checker.fresh();
            let region = Type::Region(Box::new(element.clone()));
            let payload = Type::Record(vec![
                ("0".to_owned(), element.clone()),
                ("1".to_owned(), region.clone()),
            ]);
            curried(
                vec![region, int.clone(), element],
                Type::Variant {
                    cases: vec![
                        ("Replaced".to_owned(), payload.clone()),
                        ("ReplaceOutOfBounds".to_owned(), payload),
                    ],
                    open: false,
                },
            )
        }
        "@region.swap" => {
            let region = Type::Region(Box::new(checker.fresh()));
            curried(
                vec![region.clone(), int.clone(), int.clone()],
                Type::Variant {
                    cases: vec![
                        ("Updated".to_owned(), region.clone()),
                        ("SwapOutOfBounds".to_owned(), region),
                    ],
                    open: false,
                },
            )
        }
        "@region.split" => {
            let region = Type::Region(Box::new(checker.fresh()));
            curried(
                vec![region.clone(), int.clone()],
                Type::Variant {
                    cases: vec![
                        (
                            "Split".to_owned(),
                            Type::Record(vec![
                                ("0".to_owned(), region.clone()),
                                ("1".to_owned(), region.clone()),
                                ("2".to_owned(), Type::Opaque("Rejoin".to_owned())),
                            ]),
                        ),
                        ("SplitOutOfBounds".to_owned(), region),
                    ],
                    open: false,
                },
            )
        }
        "@region.join" => {
            let region = Type::Region(Box::new(checker.fresh()));
            curried(
                vec![
                    Type::Opaque("Rejoin".to_owned()),
                    region.clone(),
                    region.clone(),
                ],
                region,
            )
        }
        "@region.reassociate_left" | "@region.reassociate_right" => {
            let witness = Type::Opaque("Rejoin".to_owned());
            curried(
                vec![witness.clone(), witness.clone()],
                Type::Record(vec![
                    ("0".to_owned(), witness.clone()),
                    ("1".to_owned(), witness),
                ]),
            )
        }
        "@region.freeze" => {
            let element = checker.fresh();
            curried(
                vec![Type::Region(Box::new(element.clone()))],
                Type::Array(Box::new(element)),
            )
        }
        "@array.empty" => Type::Array(Box::new(checker.fresh())),
        "@array.len" => curried(vec![Type::Array(Box::new(checker.fresh()))], int),
        "@array.get" => {
            let element = checker.fresh();
            curried(vec![Type::Array(Box::new(element.clone())), int], element)
        }
        "@array.set" => {
            let element = checker.fresh();
            let array = Type::Array(Box::new(element.clone()));
            curried(vec![array.clone(), int, element], array)
        }
        "@array.push" => {
            let element = checker.fresh();
            let array = Type::Array(Box::new(element.clone()));
            curried(vec![array.clone(), element], array)
        }
        "@shape.empty" => Type::Record(Vec::new()),
        "@shape.names" => curried(vec![checker.fresh()], Type::Array(Box::new(text))),
        "@shape.has" => curried(vec![checker.fresh(), text], bool_),
        "@shape.get" | "@shape.remove" => curried(vec![checker.fresh(), text], checker.fresh()),
        "@shape.set" => curried(
            vec![checker.fresh(), text, checker.fresh()],
            checker.fresh(),
        ),
        "@type.unbounded" | "@type.int" | "@type.text" | "@type.float" | "@type.float32"
        | "@type.f32x4" | "@type.f32x4_mask" | "@type.i32x4" | "@type.i32x4_mask"
        | "@type.i16x8" | "@type.i16x8_mask" | "@type.i8x16" | "@type.i8x16_mask" => {
            Type::Opaque("Type".to_owned())
        }
        "@type.unit" => Type::Unit,
        "@type.range" | "@type.refine" | "@type.union" | "@type.intersect" | "@type.diff"
        | "@type.arrow" | "@type.performs" | "@type.instantiate" => curried(
            vec![checker.fresh(), checker.fresh()],
            Type::Opaque("Type".to_owned()),
        ),
        "@type.equal" => curried(vec![checker.fresh(), checker.fresh()], bool_),
        "@type.of" | "@type.reflect" | "@type.members" | "@type.union_of"
        | "@type.probe" => {
            curried(vec![checker.fresh()], checker.fresh())
        }
        "@type.seal" => curried(vec![text, checker.fresh()], Type::Opaque("Type".to_owned())),
        "@type.open" | "@linear.own" | "@linear.maybe" | "@linear.borrow" | "@branch.likely"
        | "@branch.unlikely" => {
            let value = checker.fresh();
            curried(vec![value.clone()], value)
        }
        "@type.attach" => curried(
            vec![checker.fresh(), text, checker.fresh()],
            checker.fresh(),
        ),
        "@satisfies" => {
            let value = checker.fresh();
            curried(vec![value.clone(), checker.fresh()], value)
        }
        "@type.satisfies" => {
            let value = checker.fresh();
            curried(
                vec![Type::Record(vec![
                    ("0".to_owned(), value.clone()),
                    ("1".to_owned(), checker.fresh()),
                ])],
                value,
            )
        }
        "@fail" | "@panic" => curried(vec![text], Type::Bottom),
        "@effect" | "@effect.host" | "@effect.named" | "@forall" | "@import" => {
            curried(vec![checker.fresh()], checker.fresh())
        }
        "@include" => {
            let result = checker.fresh();
            curried(
                vec![
                    text,
                    Type::Function {
                        parameter: Box::new(checker.fresh()),
                        effects: Box::new(Type::Effects(BTreeSet::new())),
                        result: Box::new(result.clone()),
                    },
                ],
                result,
            )
        }
        "@handle" => curried(vec![checker.fresh()], checker.fresh()),
        "@continuation.cancel" => curried(vec![checker.fresh()], Type::Unit),
        "@json.parse" => curried(
            vec![variant(&["Widen", "Exact"]), checker.fresh()],
            checker.fresh(),
        ),
        "@array.take" => {
            let element = checker.fresh();
            let array = Type::Array(Box::new(element.clone()));
            curried(
                vec![array.clone(), int],
                Type::Record(vec![("0".to_owned(), element), ("1".to_owned(), array)]),
            )
        }
        "@array.split" => {
            let element = checker.fresh();
            let array = Type::Array(Box::new(element.clone()));
            curried(
                vec![array.clone(), int],
                Type::Record(vec![
                    ("0".to_owned(), array.clone()),
                    ("1".to_owned(), element),
                    ("2".to_owned(), array),
                ]),
            )
        }
        "@array.indexed" => {
            let element = checker.fresh();
            let step_result = Type::Variant {
                cases: vec![
                    ("None".to_owned(), Type::Unit),
                    (
                        "Some".to_owned(),
                        Type::Record(vec![
                            (
                                "0".to_owned(),
                                Type::Record(vec![
                                    ("0".to_owned(), int.clone()),
                                    ("1".to_owned(), element.clone()),
                                ]),
                            ),
                            ("1".to_owned(), int.clone()),
                        ]),
                    ),
                ],
                open: false,
            };
            curried(
                vec![Type::Array(Box::new(element))],
                Type::Record(vec![
                    ("state".to_owned(), int.clone()),
                    ("step".to_owned(), curried(vec![int], step_result)),
                ]),
            )
        }
        _ => return None,
    };
    Some(type_)
}

fn curried(parameters: Vec<Type>, result: Type) -> Type {
    parameters
        .into_iter()
        .rev()
        .fold(result, |result, parameter| Type::Function {
            parameter: Box::new(parameter),
            effects: Box::new(Type::Effects(BTreeSet::new())),
            result: Box::new(result),
        })
}

fn int_type() -> Type {
    Type::Range {
        domain: Domain::Int,
        low: Some(Scalar::Int(-(BigInt::from(1_u64) << 63_usize))),
        high: Some(Scalar::Int((BigInt::from(1_u64) << 63_usize) - 1)),
    }
}

fn integer_range(low: i64, high: i64) -> Type {
    Type::Range {
        domain: Domain::Int,
        low: Some(Scalar::Int(BigInt::from(low))),
        high: Some(Scalar::Int(BigInt::from(high))),
    }
}

fn signed_lane_type(bits: u8) -> Type {
    let bound = BigInt::from(1_u8) << usize::from(bits - 1);
    Type::Range {
        domain: Domain::Int,
        low: Some(Scalar::Int(-bound.clone())),
        high: Some(Scalar::Int(bound - 1)),
    }
}
fn text_type() -> Type {
    Type::Range {
        domain: Domain::Text,
        low: None,
        high: None,
    }
}
fn float_type() -> Type {
    Type::Range {
        domain: Domain::Float,
        low: None,
        high: None,
    }
}
fn float32_type() -> Type {
    Type::Range {
        domain: Domain::Float32,
        low: None,
        high: None,
    }
}
fn variant(names: &[&str]) -> Type {
    Type::Variant {
        cases: names
            .iter()
            .map(|name| ((*name).to_owned(), Type::Unit))
            .collect(),
        open: false,
    }
}
fn bool_type() -> Type {
    variant(&["True", "False"])
}

fn literal_import(
    module: &Module,
    function: ExpressionId,
    argument: ExpressionId,
    dependencies: &BTreeMap<String, Type>,
) -> Option<Type> {
    let Expression::Intrinsic { name, .. } = &module.arena.expressions[function.0 as usize] else {
        return None;
    };
    if name != "@import" {
        return None;
    }
    let Expression::Text { value, .. } = &module.arena.expressions[argument.0 as usize] else {
        return None;
    };
    dependencies.get(value).cloned()
}

fn intrinsic_head(module: &Module, mut expression: ExpressionId) -> Option<&str> {
    loop {
        match &module.arena.expressions[expression.0 as usize] {
            Expression::Intrinsic { name, .. } => return Some(name),
            Expression::Apply { function, .. } => expression = *function,
            _ => return None,
        }
    }
}

fn application_spine_ids(
    module: &Module,
    expression: ExpressionId,
) -> (ExpressionId, Vec<ExpressionId>) {
    let mut callee = expression;
    let mut arguments = Vec::new();
    while let Expression::Apply {
        function, argument, ..
    } = module.arena.expressions[callee.0 as usize]
    {
        arguments.push(argument);
        callee = function;
    }
    arguments.reverse();
    (callee, arguments)
}

fn comparison_refinements(
    module: &Module,
    expression: ExpressionId,
    environment: &TypeEnvironment,
    values: &ValueEnvironment,
    checker: &Checker,
) -> Option<(String, Type, Type)> {
    let (callee, arguments) = application_spine_ids(module, expression);
    let operator = comptime_expression_value(module, callee, values)?;

    if arguments.len() == 2
        && let Some(junction) = crate::recognise::junction(&checker.context, &operator)
    {
        let left = comparison_refinements(module, arguments[0], environment, values, checker)?;
        let right = comparison_refinements(module, arguments[1], environment, values, checker)?;
        if left.0 != right.0 {
            return None;
        }
        let original = checker.settle(checker.instantiate(environment.lookup(&left.0)?), true);
        return match junction {
            crate::recognise::Junction::And => Some((
                left.0,
                intersect_integer_types(&left.1, &right.1)?,
                original,
            )),
            crate::recognise::Junction::Or => Some((
                left.0,
                original,
                intersect_integer_types(&left.2, &right.2)?,
            )),
        };
    }

    if arguments.len() == 1 && crate::recognise::negation(&checker.context, &operator) {
        let (name, consequence, alternate) =
            comparison_refinements(module, arguments[0], environment, values, checker)?;
        return Some((name, alternate, consequence));
    }

    if arguments.len() != 2 {
        return None;
    }
    let mut orderings = crate::recognise::comparison(&checker.context, &operator)?;
    let left = arguments[0];
    let right = arguments[1];
    let (name, witness) = match (
        &module.arena.expressions[left.0 as usize],
        &module.arena.expressions[right.0 as usize],
    ) {
        (Expression::Var { name, .. }, Expression::Int { value, .. }) => {
            (name.clone(), value.clone())
        }
        (Expression::Int { value, .. }, Expression::Var { name, .. }) => {
            orderings = mirror_orderings(&orderings);
            (name.clone(), value.clone())
        }
        _ => return None,
    };
    let original = checker.settle(checker.instantiate(environment.lookup(&name)?), true);
    let accepted = ordering_type(&orderings, &witness);
    let rejected = ordering_type(&complement_orderings(&orderings), &witness);
    Some((
        name,
        intersect_integer_types(&original, &accepted)?,
        intersect_integer_types(&original, &rejected)?,
    ))
}

fn mirror_orderings(
    orderings: &BTreeSet<crate::recognise::Ordering>,
) -> BTreeSet<crate::recognise::Ordering> {
    use crate::recognise::Ordering;
    orderings
        .iter()
        .map(|ordering| match ordering {
            Ordering::Less => Ordering::Greater,
            Ordering::Equal => Ordering::Equal,
            Ordering::Greater => Ordering::Less,
        })
        .collect()
}

fn complement_orderings(
    orderings: &BTreeSet<crate::recognise::Ordering>,
) -> BTreeSet<crate::recognise::Ordering> {
    use crate::recognise::Ordering;
    [Ordering::Less, Ordering::Equal, Ordering::Greater]
        .into_iter()
        .filter(|ordering| !orderings.contains(ordering))
        .collect()
}

fn ordering_type(orderings: &BTreeSet<crate::recognise::Ordering>, witness: &BigInt) -> Type {
    use crate::recognise::Ordering;
    let semantic_basis = [Ordering::Less, Ordering::Equal, Ordering::Greater];
    let mut start = None;
    let mut intervals = Vec::new();
    for index in 0..=semantic_basis.len() {
        let accepted = index < semantic_basis.len() && orderings.contains(&semantic_basis[index]);
        if accepted && start.is_none() {
            start = Some(index);
        }
        if !accepted && let Some(first) = start.take() {
            let last = index - 1;
            let low = match semantic_basis[first] {
                Ordering::Less => None,
                Ordering::Equal => Some(witness.clone()),
                Ordering::Greater => Some(witness + 1),
            };
            let high = match semantic_basis[last] {
                Ordering::Less => Some(witness - 1),
                Ordering::Equal => Some(witness.clone()),
                Ordering::Greater => None,
            };
            intervals.push(IntegerInterval { low, high });
        }
    }
    integer_intervals_type(intervals)
}

#[derive(Clone)]
struct IntegerInterval {
    low: Option<BigInt>,
    high: Option<BigInt>,
}

fn intersect_integer_types(left: &Type, right: &Type) -> Option<Type> {
    let left = integer_intervals(left)?;
    let right = integer_intervals(right)?;
    let mut intersections = Vec::new();
    for left in &left {
        for right in &right {
            let low = match (&left.low, &right.low) {
                (None, low) | (low, None) => low.clone(),
                (Some(left), Some(right)) => Some(left.max(right).clone()),
            };
            let high = match (&left.high, &right.high) {
                (None, high) | (high, None) => high.clone(),
                (Some(left), Some(right)) => Some(left.min(right).clone()),
            };
            if matches!((&low, &high), (Some(low), Some(high)) if low > high) {
                continue;
            }
            intersections.push(IntegerInterval { low, high });
        }
    }
    Some(integer_intervals_type(intersections))
}

fn integer_intervals(type_: &Type) -> Option<Vec<IntegerInterval>> {
    match type_ {
        Type::Bottom => Some(Vec::new()),
        Type::Range {
            domain: Domain::Int,
            low,
            high,
        } => Some(vec![IntegerInterval {
            low: match low {
                Some(Scalar::Int(value)) => Some(value.clone()),
                None => None,
                _ => return None,
            },
            high: match high {
                Some(Scalar::Int(value)) => Some(value.clone()),
                None => None,
                _ => return None,
            },
        }]),
        Type::Union(members) => {
            let mut intervals = Vec::new();
            for member in members {
                intervals.extend(integer_intervals(member)?);
            }
            Some(intervals)
        }
        _ => None,
    }
}

fn integer_intervals_type(mut intervals: Vec<IntegerInterval>) -> Type {
    intervals.sort_by(|left, right| match (&left.low, &right.low) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(left), Some(right)) => left.cmp(right),
    });
    let mut normalized: Vec<IntegerInterval> = Vec::new();
    for interval in intervals {
        let Some(previous) = normalized.last_mut() else {
            normalized.push(interval);
            continue;
        };
        let touches = match (&previous.high, &interval.low) {
            (None, _) | (_, None) => true,
            (Some(high), Some(low)) => low <= &(high + 1),
        };
        if !touches {
            normalized.push(interval);
            continue;
        }
        previous.high = match (&previous.high, &interval.high) {
            (None, _) | (_, None) => None,
            (Some(left), Some(right)) => Some(left.max(right).clone()),
        };
    }
    let mut members = normalized.into_iter().map(|interval| Type::Range {
        domain: Domain::Int,
        low: interval.low.map(Scalar::Int),
        high: interval.high.map(Scalar::Int),
    });
    let Some(first) = members.next() else {
        return Type::Bottom;
    };
    let remaining = members.collect::<Vec<_>>();
    if remaining.is_empty() {
        first
    } else {
        let mut all = vec![first];
        all.extend(remaining);
        Type::Union(all)
    }
}

fn comptime_expression_value(
    module: &Module,
    expression: ExpressionId,
    values: &ValueEnvironment,
) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => lookup(values, name),
        Expression::Field { target, name, .. } => {
            let target = comptime_expression_value(module, *target, values)?;
            match target {
                Value::Shape(fields) => fields.get(name).cloned(),
                Value::Extended { members, .. } => members.get(name).cloned(),
                Value::Sealed { inner, .. } => match *inner {
                    Value::Shape(fields) => fields.get(name).cloned(),
                    _ => None,
                },
                _ => None,
            }
        }
        _ => None,
    }
}

fn substitute_rigid(type_: Type, replacements: &HashMap<VariableId, Type>) -> Type {
    match type_ {
        Type::Rigid(id) => replacements.get(&id).cloned().unwrap_or(Type::Rigid(id)),
        Type::Forall { variables, body } => {
            let mut inner_replacements = replacements.clone();
            for variable in &variables {
                inner_replacements.remove(variable);
            }
            Type::Forall {
                variables,
                body: Box::new(substitute_rigid(*body, &inner_replacements)),
            }
        }
        Type::Function {
            parameter,
            effects,
            result,
        } => Type::Function {
            parameter: Box::new(substitute_rigid(*parameter, replacements)),
            effects: Box::new(substitute_rigid(*effects, replacements)),
            result: Box::new(substitute_rigid(*result, replacements)),
        },
        Type::Record(fields) => Type::Record(
            fields
                .into_iter()
                .map(|(name, field)| (name, substitute_rigid(field, replacements)))
                .collect(),
        ),
        Type::Array(element) => Type::Array(Box::new(substitute_rigid(*element, replacements))),
        Type::Region(element) => Type::Region(Box::new(substitute_rigid(*element, replacements))),
        Type::OpenEffects { labels, tail } => Type::OpenEffects {
            labels,
            tail: Box::new(substitute_rigid(*tail, replacements)),
        },
        Type::Variant { cases, open } => Type::Variant {
            cases: cases
                .into_iter()
                .map(|(name, payload)| (name, substitute_rigid(payload, replacements)))
                .collect(),
            open,
        },
        Type::Union(members) => Type::Union(
            members
                .into_iter()
                .map(|member| substitute_rigid(member, replacements))
                .collect(),
        ),
        other => other,
    }
}

fn remove_type(type_: Type, removed: &Type) -> Type {
    match type_ {
        Type::Union(members) => join_types(
            members
                .into_iter()
                .filter(|member| !same_type(member, removed))
                .collect(),
        ),
        type_ if same_type(&type_, removed) => Type::Bottom,
        type_ => type_,
    }
}

#[derive(Clone)]
enum Witness {
    Unknown,
    Unit,
    Int(BigInt),
    Text(String),
    Constructor(String, Option<Box<Witness>>),
    Tuple(Vec<Witness>),
    Shape(BTreeMap<String, Witness>),
}

fn patterns_cover(module: &Module, arms: &[crate::ast::Arm], type_: &Type) -> bool {
    let Some(witnesses) = enumerate_type(type_, 256) else {
        return false;
    };
    !witnesses.is_empty()
        && witnesses.iter().all(|witness| {
            arms.iter()
                .any(|arm| pattern_covers(module, arm.pattern, witness))
        })
}

fn enumerate_type(type_: &Type, limit: usize) -> Option<Vec<Witness>> {
    match type_ {
        Type::Unit => Some(vec![Witness::Unit]),
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(low)),
            high: Some(Scalar::Int(high)),
        } => {
            let width = high - low;
            if width < BigInt::from(0) || width >= BigInt::from(limit) {
                return Some(vec![Witness::Unknown]);
            }
            let mut witnesses = Vec::new();
            let mut value = low.clone();
            while value <= *high {
                witnesses.push(Witness::Int(value.clone()));
                value += 1;
            }
            Some(witnesses)
        }
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(low)),
            high: Some(Scalar::Text(high)),
        } if low == high => Some(vec![Witness::Text(low.clone())]),
        Type::Variant { cases, open: false } => {
            let mut witnesses = Vec::new();
            for (name, payload) in cases {
                for payload in enumerate_type(payload, limit)? {
                    witnesses.push(Witness::Constructor(name.clone(), Some(Box::new(payload))));
                    if witnesses.len() > limit {
                        return None;
                    }
                }
            }
            Some(witnesses)
        }
        Type::Variant { cases, open: true } => {
            let mut witnesses = Vec::new();
            for (name, payload) in cases {
                for payload in enumerate_type(payload, limit)? {
                    witnesses.push(Witness::Constructor(name.clone(), Some(Box::new(payload))));
                    if witnesses.len() > limit {
                        return Some(vec![Witness::Unknown]);
                    }
                }
            }
            witnesses.push(Witness::Unknown);
            Some(witnesses)
        }
        Type::Union(members) => {
            let mut witnesses = Vec::new();
            for member in members {
                witnesses.extend(enumerate_type(member, limit)?);
                if witnesses.len() > limit {
                    return None;
                }
            }
            Some(witnesses)
        }
        Type::Record(fields)
            if fields
                .iter()
                .enumerate()
                .all(|(index, (name, _))| name == &index.to_string()) =>
        {
            let mut tuples = vec![Vec::new()];
            for (_, field) in fields {
                let choices = enumerate_type(field, limit)?;
                let mut next = Vec::new();
                for tuple in &tuples {
                    for choice in &choices {
                        let mut tuple = tuple.clone();
                        tuple.push(choice.clone());
                        next.push(tuple);
                        if next.len() > limit {
                            return Some(vec![Witness::Tuple(
                                fields.iter().map(|_| Witness::Unknown).collect(),
                            )]);
                        }
                    }
                }
                tuples = next;
            }
            Some(tuples.into_iter().map(Witness::Tuple).collect())
        }
        Type::Record(fields) => {
            let mut shapes = vec![BTreeMap::new()];
            for (name, field) in fields {
                let choices = enumerate_type(field, limit)?;
                let mut next = Vec::new();
                for shape in &shapes {
                    for choice in &choices {
                        let mut shape = shape.clone();
                        shape.insert(name.clone(), choice.clone());
                        next.push(shape);
                        if next.len() > limit {
                            return Some(vec![Witness::Shape(
                                fields
                                    .iter()
                                    .map(|(name, _)| (name.clone(), Witness::Unknown))
                                    .collect(),
                            )]);
                        }
                    }
                }
                shapes = next;
            }
            Some(shapes.into_iter().map(Witness::Shape).collect())
        }
        _ => Some(vec![Witness::Unknown]),
    }
}

fn pattern_covers(module: &Module, pattern: PatternId, witness: &Witness) -> bool {
    match (&module.arena.patterns[pattern.0 as usize], witness) {
        (Pattern::Wildcard { .. } | Pattern::Name { .. }, _) => true,
        (Pattern::Unit { .. }, Witness::Unit) => true,
        (Pattern::Int { value, .. }, Witness::Int(found)) => value == found,
        (Pattern::Text { value, .. }, Witness::Text(found)) => value == found,
        (
            Pattern::Constructor { name, payload, .. },
            Witness::Constructor(found, found_payload),
        ) if name == found => match (payload, found_payload) {
            (None, None) => true,
            (None, Some(payload)) => matches!(payload.as_ref(), Witness::Unit),
            (Some(pattern), Some(value)) => pattern_covers(module, *pattern, value),
            _ => false,
        },
        (Pattern::Tuple { elements, .. }, Witness::Tuple(values)) => {
            elements.len() == values.len()
                && elements
                    .iter()
                    .zip(values)
                    .all(|(pattern, value)| pattern_covers(module, *pattern, value))
        }
        (Pattern::Shape { fields, .. }, Witness::Shape(values)) => fields.iter().all(|field| {
            values
                .get(&field.name)
                .is_some_and(|value| pattern_covers(module, field.pattern, value))
        }),
        _ => false,
    }
}

fn structural_pattern(module: &Module, pattern: PatternId) -> bool {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Constructor { payload, .. } => payload
            .map(|payload| structural_pattern(module, payload))
            .unwrap_or(true),
        Pattern::Tuple { elements, .. } => elements
            .iter()
            .all(|pattern| structural_pattern(module, *pattern)),
        Pattern::Name { .. } | Pattern::Wildcard { .. } | Pattern::Unit { .. } => true,
        _ => false,
    }
}

fn merged_variant_constraint(types: &[Type], open: bool) -> Option<Type> {
    let mut cases = Vec::new();
    for type_ in types {
        let Type::Variant {
            cases: accepted, ..
        } = type_
        else {
            return None;
        };
        cases.extend(accepted.clone());
    }
    if cases.is_empty() {
        return None;
    }
    Some(Type::Variant {
        cases: merge_fields(cases),
        open,
    })
}

fn case_constraint(
    module: &Module,
    accepted: &[(PatternId, Type)],
    refutable: &[Type],
    open: bool,
) -> Option<Type> {
    if let Some(variant) = merged_variant_constraint(refutable, open) {
        return Some(variant);
    }
    if !accepted.is_empty()
        && accepted.iter().all(|(pattern, _)| {
            matches!(
                module.arena.patterns[pattern.0 as usize],
                Pattern::Tuple { .. }
            )
        })
    {
        let arity = match &module.arena.patterns[accepted[0].0.0 as usize] {
            Pattern::Tuple { elements, .. } => elements.len(),
            _ => unreachable!(),
        };
        if accepted.iter().all(|(pattern, _)| {
            matches!(
                &module.arena.patterns[pattern.0 as usize],
                Pattern::Tuple { elements, .. } if elements.len() == arity
            )
        }) {
            let fields = (0..arity)
                .map(|index| {
                    let mut candidates = Vec::new();
                    let mut total = false;
                    for (pattern, type_) in accepted {
                        let Pattern::Tuple { elements, .. } =
                            &module.arena.patterns[pattern.0 as usize]
                        else {
                            unreachable!();
                        };
                        total |= total_pattern(module, elements[index]);
                        if let Type::Record(fields) = type_
                            && let Some((_, field)) =
                                fields.iter().find(|(name, _)| name == &index.to_string())
                        {
                            candidates.push(field.clone());
                        }
                    }
                    let field = if total {
                        Type::Top
                    } else if let Some(variant) = merged_variant_constraint(&candidates, false) {
                        variant
                    } else {
                        Type::Top
                    };
                    (index.to_string(), field)
                })
                .collect();
            return Some(Type::Record(fields));
        }
    }
    if !open
        && !refutable.is_empty()
        && accepted
            .iter()
            .all(|(pattern, _)| structural_pattern(module, *pattern))
    {
        return Some(join_types(refutable.to_vec()));
    }
    None
}

fn tuple_columns_are_total(module: &Module, arms: &[crate::ast::Arm]) -> bool {
    let Some(Pattern::Tuple { elements, .. }) = arms
        .first()
        .map(|arm| &module.arena.patterns[arm.pattern.0 as usize])
    else {
        return false;
    };
    let arity = elements.len();
    arms.iter().all(|arm| {
        matches!(
            &module.arena.patterns[arm.pattern.0 as usize],
            Pattern::Tuple { elements, .. } if elements.len() == arity
        )
    }) && (0..arity).all(|index| {
        arms.iter().any(|arm| {
            let Pattern::Tuple { elements, .. } = &module.arena.patterns[arm.pattern.0 as usize]
            else {
                return false;
            };
            total_pattern(module, elements[index])
        })
    })
}

fn total_pattern(module: &Module, pattern: PatternId) -> bool {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { .. } | Pattern::Wildcard { .. } | Pattern::Unit { .. } => true,
        Pattern::Tuple { elements, .. } => elements
            .iter()
            .all(|pattern| total_pattern(module, *pattern)),
        Pattern::Shape { fields, .. } => fields
            .iter()
            .all(|field| total_pattern(module, field.pattern)),
        _ => false,
    }
}

fn static_member(value: &Value, name: &str) -> Option<Value> {
    match value {
        Value::Extended { inner, members } => members
            .get(name)
            .cloned()
            .or_else(|| static_member(inner, name)),
        Value::Shape(fields) => fields.get(name).cloned(),
        _ => None,
    }
}

fn validate_declaration_tag(value: &Value, span: Span) -> Result<(), Diagnostic> {
    let Value::Shape(fields) = value else {
        return Err(Diagnostic::new(
            "BLOT_BAD_DECLARATION_TAG",
            "A declaration tag descriptor must be a record.",
            span,
        ));
    };
    if !matches!(fields.get("name"), Some(Value::Text(name)) if !name.is_empty()) {
        return Err(Diagnostic::new(
            "BLOT_BAD_DECLARATION_TAG",
            "A declaration tag descriptor needs a non-empty text field `.name`.",
            span,
        ));
    }
    if fields.get("metadata").is_none() {
        return Err(Diagnostic::new(
            "BLOT_BAD_DECLARATION_TAG",
            "A declaration tag descriptor needs a `.metadata` field.",
            span,
        ));
    }
    let callable = matches!(
        fields.get("transform"),
        Some(
            Value::Closure { .. }
                | Value::Primitive { .. }
                | Value::Operation { .. }
                | Value::Continuation { .. }
        )
    );
    if !callable {
        return Err(Diagnostic::new(
            "BLOT_BAD_DECLARATION_TAG",
            "A declaration tag descriptor needs a callable `.transform` field.",
            span,
        ));
    }
    Ok(())
}

fn require_continuation_qualifier(
    module: &Module,
    operation: &str,
    clause: &Value,
    span: Span,
) -> Result<(), Diagnostic> {
    let Value::Closure { parameter, .. } = clause else {
        return Ok(());
    };
    let Pattern::Tuple { elements, .. } = &module.arena.patterns[parameter.0 as usize] else {
        return Err(Diagnostic::new(
            "BLOT_HANDLER_RESUME_NOT_AFFINE",
            format!("Handler clause `.{operation}` must bind its continuation as `?resume`."),
            span,
        ));
    };
    let Some(resume) = elements.get(1) else {
        return Err(Diagnostic::new(
            "BLOT_HANDLER_RESUME_NOT_AFFINE",
            format!("Handler clause `.{operation}` must bind its continuation as `?resume`."),
            span,
        ));
    };
    let Pattern::Name { qualifier, .. } = &module.arena.patterns[resume.0 as usize] else {
        return Err(Diagnostic::new(
            "BLOT_HANDLER_RESUME_NOT_AFFINE",
            format!("Handler clause `.{operation}` must name its continuation."),
            span,
        ));
    };
    if matches!(qualifier, Qualifier::Affine | Qualifier::Linear) {
        return Ok(());
    }
    Err(Diagnostic::new(
        "BLOT_HANDLER_RESUME_NOT_AFFINE",
        format!("Handler clause `.{operation}` must bind its continuation as `?resume`."),
        span,
    ))
}

fn effect_label(value: &Value) -> Option<String> {
    match value {
        Value::Effect { id, name, host, .. } => Some(format!(
            "{}:{id}:{name}",
            if *host { "host" } else { "effect" }
        )),
        _ => None,
    }
}

fn add_function_effect(type_: &mut Type, label: String) {
    if let Type::Forall { body, .. } = type_ {
        add_function_effect(body, label);
        return;
    }
    let Type::Function { effects, .. } = type_ else {
        return;
    };
    match effects.as_mut() {
        Type::Effects(labels) => {
            labels.insert(label);
        }
        Type::OpenEffects { labels, .. } => {
            labels.insert(label);
        }
        Type::Bottom => {
            **effects = Type::Effects(BTreeSet::from([label]));
        }
        _ => {}
    }
}

fn prebind_recursive_group(
    path: &str,
    module: &Module,
    declarations: &[DeclarationId],
    index: usize,
    environment: &mut TypeEnvironment,
    checker: &Checker,
) -> Result<(), Diagnostic> {
    let Some(declaration_id) = declarations.get(index) else {
        return Ok(());
    };
    if !recursive_declaration(module, *declaration_id) {
        return Ok(());
    }
    if declarations[..index]
        .iter()
        .rev()
        .find(|declaration| !signature_declaration(module, **declaration))
        .is_some_and(|declaration| recursive_declaration(module, *declaration))
    {
        return Ok(());
    }
    let mut names = HashSet::new();
    let mut closures = Vec::new();
    for declaration_id in &declarations[index..] {
        if signature_declaration(module, *declaration_id) {
            continue;
        }
        if !recursive_declaration(module, *declaration_id) {
            break;
        }
        let Declaration::Binding {
            kind,
            pattern,
            value,
            span,
            ..
        } = &module.arena.declarations[declaration_id.0 as usize]
        else {
            break;
        };
        let bound_names = pattern_names(module, *pattern);
        for name in &bound_names {
            if !names.insert(name.clone()) {
                return Err(Diagnostic::new(
                    "BLOT_DUPLICATE_RECURSIVE_BINDING",
                    format!("`{name}` is bound twice in one recursive group."),
                    *span,
                ));
            }
            Rc::make_mut(&mut environment.names)
                .insert(name.clone(), Typing::Mono(checker.fresh_at_next_level()));
            Rc::make_mut(&mut environment.phases).insert(
                name.clone(),
                if *kind == DeclarationKind::Const {
                    Phase::Comptime
                } else {
                    Phase::Runtime
                },
            );
        }
        let Expression::Rec { lambda, .. } = module.arena.expressions[value.0 as usize] else {
            continue;
        };
        let Expression::Lambda {
            parameter, body, ..
        } = module.arena.expressions[lambda.0 as usize]
        else {
            continue;
        };
        for name in bound_names {
            closures.push((name, parameter, body));
        }
    }
    certify_recursive_components(path, checker, closures)?;
    Ok(())
}

fn certify_recursive_components(
    path: &str,
    checker: &Checker,
    closures: Vec<(String, PatternId, ExpressionId)>,
) -> Result<(), Diagnostic> {
    let positions = closures
        .iter()
        .enumerate()
        .map(|(position, (name, _, _))| (name.clone(), position))
        .collect::<HashMap<_, _>>();
    let mut graph = vec![Vec::new(); closures.len()];
    for (position, (_, parameter, body)) in closures.iter().enumerate() {
        for free in closure_free_names(&checker.context, path, *parameter, *body, None)? {
            if let Some(target) = positions.get(&free) {
                graph[position].push(*target);
            }
        }
    }
    let mut visited = vec![false; graph.len()];
    let mut order = Vec::with_capacity(graph.len());
    for node in 0..graph.len() {
        finish_component(node, &graph, &mut visited, &mut order);
    }
    let mut reverse = vec![Vec::new(); graph.len()];
    for (source, targets) in graph.iter().enumerate() {
        for target in targets {
            reverse[*target].push(source);
        }
    }
    visited.fill(false);
    while let Some(node) = order.pop() {
        if visited[node] {
            continue;
        }
        let mut component = Vec::new();
        collect_component(node, &reverse, &mut visited, &mut component);
        let recursive = component.len() > 1 || graph[node].contains(&node);
        if !recursive {
            continue;
        }
        checker
            .recursive_closure_bodies
            .borrow_mut()
            .extend(component.into_iter().map(|member| {
                let (_, _, body) = closures[member];
                (path.to_owned(), body)
            }));
    }
    Ok(())
}

fn finish_component(
    node: usize,
    graph: &[Vec<usize>],
    visited: &mut [bool],
    order: &mut Vec<usize>,
) {
    if visited[node] {
        return;
    }
    visited[node] = true;
    for target in &graph[node] {
        finish_component(*target, graph, visited, order);
    }
    order.push(node);
}

fn collect_component(
    node: usize,
    reverse: &[Vec<usize>],
    visited: &mut [bool],
    component: &mut Vec<usize>,
) {
    if visited[node] {
        return;
    }
    visited[node] = true;
    component.push(node);
    for source in &reverse[node] {
        collect_component(*source, reverse, visited, component);
    }
}

fn future_binding_names(module: &Module, declarations: &[DeclarationId]) -> BTreeSet<String> {
    declarations
        .iter()
        .flat_map(
            |declaration| match &module.arena.declarations[declaration.0 as usize] {
                Declaration::Binding {
                    kind: DeclarationKind::Sig,
                    ..
                } => Vec::new(),
                Declaration::Binding { pattern, .. } => pattern_names(module, *pattern),
                Declaration::Shadow { .. } | Declaration::Open { .. } => Vec::new(),
            },
        )
        .collect()
}

fn remove_declaration_names(
    module: &Module,
    declaration: DeclarationId,
    names: &mut BTreeSet<String>,
) {
    let Declaration::Binding { pattern, .. } = &module.arena.declarations[declaration.0 as usize]
    else {
        return;
    };
    if signature_declaration(module, declaration) {
        return;
    }
    for name in pattern_names(module, *pattern) {
        names.remove(&name);
    }
}

fn recursive_declaration(module: &Module, declaration: DeclarationId) -> bool {
    let Declaration::Binding { value, .. } = &module.arena.declarations[declaration.0 as usize]
    else {
        return false;
    };
    matches!(
        module.arena.expressions[value.0 as usize],
        Expression::Rec { .. }
    )
}

fn signature_declaration(module: &Module, declaration: DeclarationId) -> bool {
    matches!(
        module.arena.declarations[declaration.0 as usize],
        Declaration::Binding {
            kind: DeclarationKind::Sig,
            ..
        }
    )
}

fn scalar_bound(value: &Value) -> Option<Scalar> {
    match value {
        Value::Int(value) => Some(Scalar::Int(value.clone())),
        Value::Text(value) => Some(Scalar::Text(value.clone())),
        _ => None,
    }
}

#[cfg(test)]
fn reify_type(type_: &Type) -> Option<Value> {
    let mut next_hole = u32::MAX;
    reify_type_with_holes(type_, &mut next_hole)
}

fn reify_type_with_holes(type_: &Type, next_hole: &mut u32) -> Option<Value> {
    match type_ {
        Type::Bottom => {
            let hole = *next_hole;
            *next_hole = next_hole.checked_sub(1)?;
            Some(Value::TypeVariable(hole))
        }
        Type::Rigid(id) => Some(Value::TypeVariable(*id)),
        Type::Forall { variables, body } => {
            let mut body = reify_type_with_holes(body, next_hole)?;
            for variable in variables.iter().rev() {
                body = Value::Forall {
                    variable: *variable,
                    body: Box::new(body),
                };
            }
            Some(body)
        }
        Type::Range { domain, low, high } => {
            let low = reify_bound(low)?;
            let high = reify_bound(high)?;
            if !matches!(low, Value::Unbounded) && crate::value::equal(&low, &high) {
                return Some(low);
            }
            Some(Value::Range {
                low: Box::new(low),
                high: Box::new(high),
                domain: Some(match domain {
                    Domain::Int => ValueDomain::Int,
                    Domain::Text => ValueDomain::Text,
                    Domain::Float => ValueDomain::Float,
                    Domain::Float32 => ValueDomain::Float32,
                }),
            })
        }
        Type::Unit => Some(Value::Unit),
        Type::Record(fields) => Some(Value::Shape(
            fields
                .iter()
                .map(|(name, type_)| Some((name.clone(), reify_type_with_holes(type_, next_hole)?)))
                .collect::<Option<Vec<_>>>()?
                .into_iter()
                .collect(),
        )),
        Type::Array(element) => Some(Value::Array(vec![reify_type_with_holes(
            element, next_hole,
        )?])),
        Type::Region(_) => None,
        Type::Variant { cases, open: false } => Some(Value::Union(
            cases
                .iter()
                .map(|(name, payload)| {
                    let payload = reify_type_with_holes(payload, next_hole)?;
                    Some(Value::Tag {
                        name: name.clone(),
                        payload: if matches!(payload, Value::Unit) {
                            None
                        } else {
                            Some(Box::new(payload))
                        },
                    })
                })
                .collect::<Option<Vec<_>>>()?,
        )),
        Type::Function {
            parameter,
            effects,
            result,
        } => {
            let (labels, effect_tail) = match effects.as_ref() {
                Type::Effects(labels) => (labels.clone(), None),
                Type::OpenEffects { labels, tail } => {
                    let Value::TypeVariable(tail) = reify_type_with_holes(tail, next_hole)? else {
                        return None;
                    };
                    (labels.clone(), Some(tail))
                }
                Type::Bottom => (BTreeSet::new(), None),
                _ => return None,
            };
            Some(Value::Arrow {
                domain: Box::new(reify_type_with_holes(parameter, next_hole)?),
                codomain: Box::new(reify_type_with_holes(result, next_hole)?),
                effects: labels
                    .iter()
                    .map(|label| crate::primitives::effect_value(label))
                    .collect::<Option<Vec<_>>>()?,
                effect_tail,
            })
        }
        Type::Union(members) => Some(Value::Union(
            members
                .iter()
                .map(|member| reify_type_with_holes(member, next_hole))
                .collect::<Option<Vec<_>>>()?,
        )),
        Type::Top => Some(Value::Unbounded),
        Type::Opaque(name) => Some(Value::OpaqueType(name.clone())),
        _ => None,
    }
}

fn reify_bound(bound: &Option<Scalar>) -> Option<Value> {
    match bound {
        None => Some(Value::Unbounded),
        Some(Scalar::Int(value)) => Some(Value::Int(value.clone())),
        Some(Scalar::Text(value)) => Some(Value::Text(value.clone())),
    }
}

fn lower_within(left: &Option<Scalar>, right: &Option<Scalar>) -> bool {
    match (left, right) {
        (_, None) => true,
        (Some(left), Some(right)) => left >= right,
        (None, Some(_)) => false,
    }
}
fn upper_within(left: &Option<Scalar>, right: &Option<Scalar>) -> bool {
    match (left, right) {
        (_, None) => true,
        (Some(left), Some(right)) => left <= right,
        (None, Some(_)) => false,
    }
}

fn same_type(left: &Type, right: &Type) -> bool {
    same_type_with_rigids(left, right, &mut Vec::new())
}

fn same_type_with_rigids(
    left: &Type,
    right: &Type,
    rigids: &mut Vec<(VariableId, VariableId)>,
) -> bool {
    match (left, right) {
        (Type::Variable(left), Type::Variable(right)) => left == right,
        (Type::Rigid(left), Type::Rigid(right)) => {
            if let Some(bound_left) = rigids
                .iter()
                .rev()
                .find_map(|(bound_left, bound_right)| (bound_right == right).then_some(bound_left))
            {
                return bound_left == left;
            }
            if rigids
                .iter()
                .any(|(bound_left, bound_right)| bound_left == left || bound_right == right)
            {
                return false;
            }
            left == right
        }
        (
            Type::Forall {
                variables: left_variables,
                body: left_body,
            },
            Type::Forall {
                variables: right_variables,
                body: right_body,
            },
        ) => {
            if left_variables.len() != right_variables.len() {
                return false;
            }
            let previous = rigids.len();
            rigids.extend(
                left_variables
                    .iter()
                    .zip(right_variables)
                    .map(|(left, right)| (*left, *right)),
            );
            let same = same_type_with_rigids(left_body, right_body, rigids);
            rigids.truncate(previous);
            same
        }
        (Type::Unit, Type::Unit) | (Type::Top, Type::Top) | (Type::Bottom, Type::Bottom) => true,
        (Type::Opaque(left), Type::Opaque(right)) => left == right,
        (
            Type::Range {
                domain: ld,
                low: ll,
                high: lh,
            },
            Type::Range {
                domain: rd,
                low: rl,
                high: rh,
            },
        ) => ld == rd && ll == rl && lh == rh,
        (Type::Effects(left), Type::Effects(right)) => left == right,
        (
            Type::OpenEffects {
                labels: left_labels,
                tail: left_tail,
            },
            Type::OpenEffects {
                labels: right_labels,
                tail: right_tail,
            },
        ) => left_labels == right_labels && same_type_with_rigids(left_tail, right_tail, rigids),
        (
            Type::Function {
                parameter: left_parameter,
                effects: left_effects,
                result: left_result,
            },
            Type::Function {
                parameter: right_parameter,
                effects: right_effects,
                result: right_result,
            },
        ) => {
            same_type_with_rigids(left_parameter, right_parameter, rigids)
                && same_type_with_rigids(left_effects, right_effects, rigids)
                && same_type_with_rigids(left_result, right_result, rigids)
        }
        (Type::Record(left), Type::Record(right)) => same_fields(left, right, rigids),
        (Type::Array(left), Type::Array(right)) | (Type::Region(left), Type::Region(right)) => {
            same_type_with_rigids(left, right, rigids)
        }
        (
            Type::Variant {
                cases: left,
                open: left_open,
            },
            Type::Variant {
                cases: right,
                open: right_open,
            },
        ) => left_open == right_open && same_fields(left, right, rigids),
        (Type::Union(left), Type::Union(right)) => {
            left.len() == right.len()
                && left.iter().all(|member| {
                    right
                        .iter()
                        .any(|candidate| same_type_with_rigids(member, candidate, rigids))
                })
        }
        _ => false,
    }
}

fn same_fields(
    left: &[(String, Type)],
    right: &[(String, Type)],
    rigids: &mut Vec<(VariableId, VariableId)>,
) -> bool {
    left.len() == right.len()
        && left.iter().all(|(name, type_)| {
            right
                .iter()
                .find(|(candidate, _)| candidate == name)
                .is_some_and(|(_, candidate)| same_type_with_rigids(type_, candidate, rigids))
        })
}

fn admits_omission(type_: &Type) -> bool {
    match type_ {
        Type::Unit => true,
        Type::Forall { body, .. } => admits_omission(body),
        Type::Union(members) => members.iter().any(admits_omission),
        _ => false,
    }
}

fn stable_rebinding_type(type_: Type) -> Type {
    match type_ {
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(low)),
            high: Some(Scalar::Int(high)),
        } if low == high => int_type(),
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(low)),
            high: Some(Scalar::Text(high)),
        } if low == high => text_type(),
        type_ => type_,
    }
}

fn unrepresentable_integer(type_: &Type) -> Option<&Type> {
    match type_ {
        Type::Forall { body, .. } => unrepresentable_integer(body),
        Type::Range {
            domain: Domain::Int,
            low,
            high,
        } => {
            let below = low
                .as_ref()
                .and_then(|bound| match bound {
                    Scalar::Int(value) => Some(value < &BigInt::from(i64::MIN)),
                    Scalar::Text(_) => None,
                })
                .unwrap_or(false);
            let above = high
                .as_ref()
                .and_then(|bound| match bound {
                    Scalar::Int(value) => Some(value > &BigInt::from(i64::MAX)),
                    Scalar::Text(_) => None,
                })
                .unwrap_or(false);
            (below || above).then_some(type_)
        }
        Type::Function {
            parameter,
            effects,
            result,
        } => unrepresentable_integer(parameter)
            .or_else(|| unrepresentable_integer(effects))
            .or_else(|| unrepresentable_integer(result)),
        Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
            .iter()
            .find_map(|(_, type_)| unrepresentable_integer(type_)),
        Type::Array(element) => unrepresentable_integer(element),
        Type::Union(members) => members.iter().find_map(unrepresentable_integer),
        _ => None,
    }
}

fn union_types(mut types: Vec<Type>) -> Type {
    if types.is_empty() {
        return Type::Bottom;
    }
    if types.len() == 1 {
        return types.remove(0);
    }
    Type::Union(types)
}

fn join_types(types: Vec<Type>) -> Type {
    let mut ranges = Vec::new();
    let mut variants = Vec::new();
    let mut effects = BTreeSet::new();
    let mut other = Vec::new();
    for type_ in types {
        match type_ {
            Type::Range { .. } => ranges.push(type_),
            Type::Variant { cases, .. } => variants.extend(cases),
            Type::Effects(labels) => effects.extend(labels),
            Type::Bottom => {}
            type_ => other.push(type_),
        }
    }
    if !effects.is_empty() && ranges.is_empty() && variants.is_empty() && other.is_empty() {
        return Type::Effects(effects);
    }
    if !variants.is_empty() && ranges.is_empty() && other.is_empty() {
        return Type::Variant {
            cases: merge_fields(variants),
            open: false,
        };
    }
    other.extend(ranges);
    if !variants.is_empty() {
        other.push(Type::Variant {
            cases: merge_fields(variants),
            open: false,
        });
    }
    union_types(other)
}

fn meet_types(mut types: Vec<Type>) -> Type {
    if types.len() == 1 {
        return types.remove(0);
    }
    let records = types
        .iter()
        .filter_map(|type_| {
            if let Type::Record(fields) = type_ {
                Some(fields.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if records.len() == types.len() {
        return Type::Record(merge_fields(records.into_iter().flatten().collect()));
    }
    Type::Top
}

fn merge_fields(fields: Vec<(String, Type)>) -> Vec<(String, Type)> {
    let mut merged: Vec<(String, Type)> = Vec::new();
    for (name, type_) in fields {
        if let Some((_, existing)) = merged.iter_mut().find(|(candidate, _)| candidate == &name) {
            *existing = join_types(vec![existing.clone(), type_]);
        } else {
            merged.push((name, type_));
        }
    }
    merged
}

fn pattern_names(module: &Module, pattern: PatternId) -> Vec<String> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => vec![name.clone()],
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => elements
            .iter()
            .flat_map(|pattern| pattern_names(module, *pattern))
            .collect(),
        Pattern::Constructor {
            payload: Some(payload),
            ..
        } => pattern_names(module, *payload),
        Pattern::Shape { fields, .. } => fields
            .iter()
            .flat_map(|field| pattern_names(module, field.pattern))
            .collect(),
        _ => Vec::new(),
    }
}

fn expression_contains_intrinsic(
    module: &Module,
    expression: ExpressionId,
    intrinsic: &str,
) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Intrinsic { name, .. } => name == intrinsic,
        Expression::Apply {
            function, argument, ..
        } => {
            expression_contains_intrinsic(module, *function, intrinsic)
                || expression_contains_intrinsic(module, *argument, intrinsic)
        }
        Expression::Field { target, .. } => {
            expression_contains_intrinsic(module, *target, intrinsic)
        }
        Expression::Lambda { body, .. }
        | Expression::Rec { lambda: body, .. }
        | Expression::Comptime { body, .. } => {
            expression_contains_intrinsic(module, *body, intrinsic)
        }
        Expression::Array { elements, .. } => elements
            .iter()
            .any(|element| expression_contains_intrinsic(module, element.value, intrinsic)),
        Expression::Tuple { elements, .. } => elements
            .iter()
            .any(|element| expression_contains_intrinsic(module, *element, intrinsic)),
        Expression::Shape { members, .. } => members.iter().any(|member| {
            let value = match member {
                ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
            };
            expression_contains_intrinsic(module, value, intrinsic)
        }),
        Expression::If {
            branches, fallback, ..
        } => {
            branches.iter().any(|branch| {
                expression_contains_intrinsic(module, branch.condition, intrinsic)
                    || expression_contains_intrinsic(module, branch.consequence, intrinsic)
            }) || fallback
                .is_some_and(|fallback| expression_contains_intrinsic(module, fallback, intrinsic))
        }
        Expression::Case { target, arms, .. } => {
            expression_contains_intrinsic(module, *target, intrinsic)
                || arms
                    .iter()
                    .any(|arm| expression_contains_intrinsic(module, arm.body, intrinsic))
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            declarations.iter().any(|declaration| {
                let value = match &module.arena.declarations[declaration.0 as usize] {
                    Declaration::Binding { value, .. }
                    | Declaration::Shadow { value, .. }
                    | Declaration::Open { value, .. } => *value,
                };
                expression_contains_intrinsic(module, value, intrinsic)
            }) || expression_contains_intrinsic(module, *result, intrinsic)
        }
        _ => false,
    }
}

fn expression_has_generic_reflection(
    module: &Module,
    expression: ExpressionId,
    bound: &mut Vec<BTreeSet<String>>,
) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Apply {
            function, argument, ..
        } => {
            if matches!(
                &module.arena.expressions[function.0 as usize],
                Expression::Intrinsic { name, .. } if name == "@type.reflect"
            ) && expression_references_bound(module, *argument, bound)
            {
                return true;
            }
            expression_has_generic_reflection(module, *function, bound)
                || expression_has_generic_reflection(module, *argument, bound)
        }
        Expression::Field { target, .. } => {
            expression_has_generic_reflection(module, *target, bound)
        }
        Expression::Lambda {
            parameter, body, ..
        } => {
            bound.push(pattern_names(module, *parameter).into_iter().collect());
            let found = expression_has_generic_reflection(module, *body, bound);
            bound.pop();
            found
        }
        Expression::Rec { lambda, .. } => expression_has_generic_reflection(module, *lambda, bound),
        Expression::Comptime { body, .. } => {
            expression_has_generic_reflection(module, *body, bound)
        }
        Expression::Array { elements, .. } => elements
            .iter()
            .any(|element| expression_has_generic_reflection(module, element.value, bound)),
        Expression::Tuple { elements, .. } => elements
            .iter()
            .any(|element| expression_has_generic_reflection(module, *element, bound)),
        Expression::Shape { members, .. } => members.iter().any(|member| {
            let value = match member {
                ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
            };
            expression_has_generic_reflection(module, value, bound)
        }),
        Expression::If {
            branches, fallback, ..
        } => {
            branches.iter().any(|branch| {
                expression_has_generic_reflection(module, branch.condition, bound)
                    || expression_has_generic_reflection(module, branch.consequence, bound)
            }) || fallback
                .is_some_and(|fallback| expression_has_generic_reflection(module, fallback, bound))
        }
        Expression::Case { target, arms, .. } => {
            expression_has_generic_reflection(module, *target, bound)
                || arms.iter().any(|arm| {
                    bound.push(pattern_names(module, arm.pattern).into_iter().collect());
                    let found = expression_has_generic_reflection(module, arm.body, bound);
                    bound.pop();
                    found
                })
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            bound.push(BTreeSet::new());
            for declaration in declarations {
                let declaration = &module.arena.declarations[declaration.0 as usize];
                let value = match declaration {
                    Declaration::Binding { value, .. }
                    | Declaration::Shadow { value, .. }
                    | Declaration::Open { value, .. } => *value,
                };
                if expression_has_generic_reflection(module, value, bound) {
                    bound.pop();
                    return true;
                }
                if let Declaration::Binding { pattern, .. } = declaration {
                    bound
                        .last_mut()
                        .expect("block reflection scope exists")
                        .extend(pattern_names(module, *pattern));
                }
            }
            let found = expression_has_generic_reflection(module, *result, bound);
            bound.pop();
            found
        }
        _ => false,
    }
}

fn expression_references_bound(
    module: &Module,
    expression: ExpressionId,
    bound: &[BTreeSet<String>],
) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => bound.iter().rev().any(|scope| scope.contains(name)),
        Expression::Apply {
            function, argument, ..
        } => {
            expression_references_bound(module, *function, bound)
                || expression_references_bound(module, *argument, bound)
        }
        Expression::Field { target, .. } => expression_references_bound(module, *target, bound),
        Expression::Array { elements, .. } => elements
            .iter()
            .any(|element| expression_references_bound(module, element.value, bound)),
        Expression::Tuple { elements, .. } => elements
            .iter()
            .any(|element| expression_references_bound(module, *element, bound)),
        Expression::Shape { members, .. } => members.iter().any(|member| {
            let value = match member {
                ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
            };
            expression_references_bound(module, value, bound)
        }),
        _ => false,
    }
}

fn expression_span(expression: &Expression) -> Span {
    match expression {
        Expression::Var { span, .. }
        | Expression::Int { span, .. }
        | Expression::Float { span, .. }
        | Expression::Text { span, .. }
        | Expression::Unit { span }
        | Expression::Intrinsic { span, .. }
        | Expression::Tag { span, .. }
        | Expression::Apply { span, .. }
        | Expression::Field { span, .. }
        | Expression::Lambda { span, .. }
        | Expression::Array { span, .. }
        | Expression::Tuple { span, .. }
        | Expression::Shape { span, .. }
        | Expression::If { span, .. }
        | Expression::Case { span, .. }
        | Expression::Block { span, .. }
        | Expression::Rec { span, .. }
        | Expression::Comptime { span, .. } => *span,
    }
}

fn closure_free_name_span(
    module: &Module,
    parameter: PatternId,
    body: ExpressionId,
    self_name: Option<&str>,
    name: &str,
) -> Option<Span> {
    let mut bound = pattern_names(module, parameter)
        .iter()
        .any(|candidate| candidate == name);
    if self_name == Some(name) {
        bound = true;
    }
    free_name_span(module, body, name, bound)
}

fn free_name_span(
    module: &Module,
    expression_id: ExpressionId,
    name: &str,
    bound: bool,
) -> Option<Span> {
    let expression = &module.arena.expressions[expression_id.0 as usize];
    match expression {
        Expression::Var {
            name: candidate,
            span,
        } => {
            if !bound && candidate == name {
                return Some(*span);
            }
            None
        }
        Expression::Apply {
            function, argument, ..
        } => {
            if let Some(span) = free_name_span(module, *function, name, bound) {
                return Some(span);
            }
            free_name_span(module, *argument, name, bound)
        }
        Expression::Field { target, .. }
        | Expression::Rec { lambda: target, .. }
        | Expression::Comptime { body: target, .. } => free_name_span(module, *target, name, bound),
        Expression::Lambda {
            parameter, body, ..
        } => {
            let parameter_binds_name = pattern_names(module, *parameter)
                .iter()
                .any(|candidate| candidate == name);
            free_name_span(module, *body, name, bound || parameter_binds_name)
        }
        Expression::Array { elements, .. } => {
            for element in elements {
                if let Some(span) = free_name_span(module, element.value, name, bound) {
                    return Some(span);
                }
            }
            None
        }
        Expression::Tuple { elements, .. } => {
            for element in elements {
                if let Some(span) = free_name_span(module, *element, name, bound) {
                    return Some(span);
                }
            }
            None
        }
        Expression::Shape { members, .. } => {
            for member in members {
                let value = match member {
                    ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
                };
                if let Some(span) = free_name_span(module, value, name, bound) {
                    return Some(span);
                }
            }
            None
        }
        Expression::If {
            branches, fallback, ..
        } => {
            for branch in branches {
                if let Some(span) = free_name_span(module, branch.condition, name, bound) {
                    return Some(span);
                }
                if let Some(span) = free_name_span(module, branch.consequence, name, bound) {
                    return Some(span);
                }
            }
            if let Some(fallback) = fallback {
                return free_name_span(module, *fallback, name, bound);
            }
            None
        }
        Expression::Case { target, arms, .. } => {
            if let Some(span) = free_name_span(module, *target, name, bound) {
                return Some(span);
            }
            for arm in arms {
                if !bound && let Some(span) = pattern_pin_name_span(module, arm.pattern, name) {
                    return Some(span);
                }
                let pattern_binds_name = pattern_names(module, arm.pattern)
                    .iter()
                    .any(|candidate| candidate == name);
                if let Some(span) =
                    free_name_span(module, arm.body, name, bound || pattern_binds_name)
                {
                    return Some(span);
                }
            }
            None
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            let mut block_bound = bound;
            for declaration in declarations {
                let declaration = &module.arena.declarations[declaration.0 as usize];
                match declaration {
                    Declaration::Binding {
                        tags,
                        pattern,
                        value,
                        ..
                    } => {
                        for tag in tags {
                            if let Some(span) =
                                free_name_span(module, tag.descriptor, name, block_bound)
                            {
                                return Some(span);
                            }
                        }
                        if !block_bound
                            && let Some(span) = pattern_pin_name_span(module, *pattern, name)
                        {
                            return Some(span);
                        }
                        if let Some(span) = free_name_span(module, *value, name, block_bound) {
                            return Some(span);
                        }
                        if pattern_names(module, *pattern)
                            .iter()
                            .any(|candidate| candidate == name)
                        {
                            block_bound = true;
                        }
                    }
                    Declaration::Shadow {
                        name: shadowed,
                        value,
                        ..
                    } => {
                        if let Some(span) = free_name_span(module, *value, name, block_bound) {
                            return Some(span);
                        }
                        if shadowed == name {
                            block_bound = true;
                        }
                    }
                    Declaration::Open { value, .. } => {
                        if let Some(span) = free_name_span(module, *value, name, block_bound) {
                            return Some(span);
                        }
                    }
                }
            }
            free_name_span(module, *result, name, block_bound)
        }
        Expression::Int { .. }
        | Expression::Float { .. }
        | Expression::Text { .. }
        | Expression::Unit { .. }
        | Expression::Intrinsic { .. }
        | Expression::Tag { .. } => None,
    }
}

fn pattern_pin_name_span(module: &Module, pattern: PatternId, name: &str) -> Option<Span> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Pin {
            name: candidate,
            span,
        } => {
            if candidate == name {
                return Some(*span);
            }
            None
        }
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
            for element in elements {
                if let Some(span) = pattern_pin_name_span(module, *element, name) {
                    return Some(span);
                }
            }
            None
        }
        Pattern::Constructor {
            payload: Some(payload),
            ..
        } => pattern_pin_name_span(module, *payload, name),
        Pattern::Shape { fields, .. } => {
            for field in fields {
                if let Some(span) = pattern_pin_name_span(module, field.pattern, name) {
                    return Some(span);
                }
            }
            None
        }
        _ => None,
    }
}

fn show_bound(bound: Option<Scalar>) -> String {
    match bound {
        None => String::new(),
        Some(Scalar::Int(value)) => value.to_string(),
        Some(Scalar::Text(value)) => format!("{value:?}"),
    }
}

fn show_effects(effects: &Type) -> String {
    match effects {
        Type::Bottom => String::new(),
        Type::Effects(labels) if labels.is_empty() => String::new(),
        Type::Effects(labels) => format!(
            " ~ {{ {} }}",
            labels.iter().cloned().collect::<Vec<_>>().join(", ")
        ),
        Type::OpenEffects { labels, tail } => {
            let mut parts = labels.iter().cloned().collect::<Vec<_>>();
            parts.push(format!(
                "..{}",
                match tail.as_ref() {
                    Type::Rigid(id) => format!("e{id}"),
                    Type::Variable(id) => format!("e{id}"),
                    _ => "?".to_owned(),
                }
            ));
            format!(" ~ {{ {} }}", parts.join(", "))
        }
        _ => " ~ {?}".to_owned(),
    }
}

fn empty_effects(type_: &Type) -> bool {
    matches!(type_, Type::Bottom) || matches!(type_, Type::Effects(labels) if labels.is_empty())
}

fn closed_checked_type(type_: &Type, bound: &mut HashSet<VariableId>) -> bool {
    match type_ {
        Type::Variable(_) => false,
        Type::Rigid(variable) => bound.contains(variable),
        Type::Forall { variables, body } => {
            let inserted = variables
                .iter()
                .copied()
                .filter(|variable| bound.insert(*variable))
                .collect::<Vec<_>>();
            let closed = closed_checked_type(body, bound);
            for variable in inserted {
                bound.remove(&variable);
            }
            closed
        }
        Type::Function {
            parameter,
            effects,
            result,
        } => {
            closed_checked_type(parameter, bound)
                && closed_checked_type(effects, bound)
                && closed_checked_type(result, bound)
        }
        Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
            .iter()
            .all(|(_, field)| closed_checked_type(field, bound)),
        Type::Array(element) | Type::Region(element) => closed_checked_type(element, bound),
        Type::OpenEffects { tail, .. } => closed_checked_type(tail, bound),
        Type::Union(members) => members
            .iter()
            .all(|member| closed_checked_type(member, bound)),
        Type::Range { .. }
        | Type::Unit
        | Type::Effects(_)
        | Type::Opaque(_)
        | Type::Top
        | Type::Bottom => true,
    }
}

fn flatten_interface_type(
    type_: &Type,
    bound: &mut HashSet<VariableId>,
    nodes: &mut Vec<FlatTypeNode>,
) -> Option<FlatTypeId> {
    let node = match type_ {
        Type::Variable(_) => return None,
        Type::Rigid(id) => {
            if !bound.contains(id) {
                return None;
            }
            FlatTypeNode::Rigid(*id)
        }
        Type::Forall { variables, body } => {
            let inserted = variables
                .iter()
                .map(|variable| (*variable, bound.insert(*variable)))
                .collect::<Vec<_>>();
            let body = flatten_interface_type(body, bound, nodes);
            for (variable, was_new) in inserted {
                if was_new {
                    bound.remove(&variable);
                }
            }
            FlatTypeNode::Forall {
                variables: variables.clone(),
                body: body?,
            }
        }
        Type::Function {
            parameter,
            effects,
            result,
        } => FlatTypeNode::Function {
            parameter: flatten_interface_type(parameter, bound, nodes)?,
            effects: flatten_interface_type(effects, bound, nodes)?,
            result: flatten_interface_type(result, bound, nodes)?,
        },
        Type::Record(fields) => FlatTypeNode::Record(
            fields
                .iter()
                .map(|(name, type_)| {
                    Some((name.clone(), flatten_interface_type(type_, bound, nodes)?))
                })
                .collect::<Option<Vec<_>>>()?,
        ),
        Type::Array(element) => FlatTypeNode::Array(flatten_interface_type(element, bound, nodes)?),
        Type::Region(element) => {
            FlatTypeNode::Region(flatten_interface_type(element, bound, nodes)?)
        }
        Type::Variant { cases, open } => FlatTypeNode::Variant {
            cases: cases
                .iter()
                .map(|(name, type_)| {
                    Some((name.clone(), flatten_interface_type(type_, bound, nodes)?))
                })
                .collect::<Option<Vec<_>>>()?,
            open: *open,
        },
        Type::Union(members) => FlatTypeNode::Union(
            members
                .iter()
                .map(|member| flatten_interface_type(member, bound, nodes))
                .collect::<Option<Vec<_>>>()?,
        ),
        Type::Range { domain, low, high } => FlatTypeNode::Range {
            domain: *domain,
            low: low.clone(),
            high: high.clone(),
        },
        Type::Unit => FlatTypeNode::Unit,
        Type::Effects(labels) => FlatTypeNode::Effects(labels.clone()),
        Type::OpenEffects { labels, tail } => FlatTypeNode::OpenEffects {
            labels: labels.clone(),
            tail: flatten_interface_type(tail, bound, nodes)?,
        },
        Type::Opaque(name) => FlatTypeNode::Opaque(name.clone()),
        Type::Top => FlatTypeNode::Top,
        Type::Bottom => FlatTypeNode::Bottom,
    };
    let id = FlatTypeId(nodes.len() as u32);
    nodes.push(node);
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A union carries one member per contributing bound. A residualized
    /// accumulator contributes the initial literal's singleton beside the
    /// widened domain once per iteration, and printing all of them describes
    /// the solver rather than the type.
    #[test]
    fn a_union_prints_only_the_members_it_needs() {
        let integer = || Type::Range {
            domain: Domain::Int,
            low: None,
            high: None,
        };
        let zero = || Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(0.into())),
            high: Some(Scalar::Int(0.into())),
        };
        let members = vec![integer(), zero(), integer(), zero()];
        let kept = union_members(&members);
        assert_eq!(kept.len(), 1);
        assert!(matches!(
            kept[0],
            Type::Range {
                low: None,
                high: None,
                ..
            }
        ));
    }

    #[test]
    fn a_union_keeps_members_no_other_covers() {
        let one = Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(1.into())),
            high: Some(Scalar::Int(1.into())),
        };
        let two = Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(2.into())),
            high: Some(Scalar::Int(2.into())),
        };
        assert_eq!(union_members(&[one, two]).len(), 2);
    }

    /// Nothing inhabits `⊥`, so it disappears beside anything else — but a
    /// union of nothing else is still `⊥`.
    #[test]
    fn bottom_drops_out_of_a_union_unless_it_is_the_union() {
        assert_eq!(show_union(vec!["Int".to_owned(), "⊥".to_owned()]), "Int");
        assert_eq!(show_union(vec!["⊥".to_owned(), "⊥".to_owned()]), "⊥");
    }

    #[test]
    fn residual_bottom_positions_get_distinct_representation_holes() {
        let signature = reify_type(&Type::Record(vec![
            ("left".to_owned(), Type::Bottom),
            ("right".to_owned(), Type::Bottom),
        ]))
        .expect("bottom positions should reify as representation holes");
        let Value::Shape(fields) = signature else {
            panic!("record signature did not reify as a shape");
        };
        let Some(Value::TypeVariable(left)) = fields.get("left") else {
            panic!("left bottom position lost its representation hole");
        };
        let Some(Value::TypeVariable(right)) = fields.get("right") else {
            panic!("right bottom position lost its representation hole");
        };
        assert_ne!(left, right);
    }

    #[test]
    fn residual_recursive_representation_uses_its_closed_upper_bound() {
        let checker = Checker::new(Rc::new(Context::default()));
        let recursive = checker.fresh();
        let Type::Variable(variable) = recursive.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let store = Type::Array(Box::new(int_type()));
        let recursive_bound = checker.constraint_type(&Type::Array(Box::new(recursive.clone())));
        let store_bound = checker.constraint_type(&store);
        {
            let mut variables = checker.variables.borrow_mut();
            variables[variable as usize].lower = vec![recursive_bound, store_bound];
            variables[variable as usize].upper = vec![store_bound];
        }

        let (residual, recursive) = checker.residual_signature_analysis(recursive);

        assert!(same_type(&residual, &store));
        assert!(!recursive);
    }

    #[test]
    fn residual_signature_certifies_a_recursive_type_back_edge() {
        let checker = Checker::new(Rc::new(Context::default()));
        let recursive = checker.fresh();
        let Type::Variable(variable) = recursive.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let recursive_bound = checker.constraint_type(&Type::Variant {
            cases: vec![
                ("Nil".to_owned(), Type::Unit),
                ("Cons".to_owned(), recursive.clone()),
            ],
            open: false,
        });
        checker.variables.borrow_mut()[variable as usize].lower = vec![recursive_bound];

        let (residual, recursive) = checker.residual_signature_analysis(recursive);

        assert!(recursive);
        assert!(matches!(residual, Type::Forall { .. }));
    }

    #[test]
    fn residual_recursive_union_uses_its_non_recursive_lower_bound() {
        let checker = Checker::new(Rc::new(Context::default()));
        let recursive = checker.fresh();
        let Type::Variable(variable) = recursive.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let store = Type::Array(Box::new(int_type()));
        let recursive_bound = checker.constraint_type(&recursive);
        let store_bound = checker.constraint_type(&store);
        checker.variables.borrow_mut()[variable as usize].lower =
            vec![recursive_bound, store_bound];

        let residual = checker.residual_signature(recursive);

        assert!(same_type(&residual, &store));
    }

    #[test]
    fn residual_control_union_keeps_its_synthetic_envelope() {
        let checker = Checker::new(Rc::new(Context::default()));
        let state = Type::Record(vec![("value".to_owned(), int_type())]);
        let control = Type::Variant {
            cases: vec![("LoopContinue$1$2".to_owned(), state.clone())],
            open: false,
        };

        let residual = checker.residual_signature(Type::Union(vec![state, control.clone()]));

        assert!(same_type(&residual, &control));
    }

    #[test]
    fn cached_interfaces_instantiate_bound_rigids_freshly() {
        let checked = CheckedModule {
            result: Type::Forall {
                variables: vec![7],
                body: Box::new(Type::Rigid(7)),
            },
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
        };
        let cached = CachedModuleInterface::from_checked(&checked)
            .expect("a quantified closed interface is cacheable");
        let checker = Checker::new(Rc::new(Context::default()));

        let first = checker.inflate_interface("first", cached.clone()).result;
        let second = checker.inflate_interface("second", cached).result;

        let Type::Forall {
            variables: first_variables,
            body: first_body,
        } = first
        else {
            panic!("inflated interface lost its quantifier");
        };
        let Type::Forall {
            variables: second_variables,
            body: second_body,
        } = second
        else {
            panic!("inflated interface lost its quantifier");
        };
        assert_ne!(first_variables, second_variables);
        assert!(matches!(*first_body, Type::Rigid(id) if id == first_variables[0]));
        assert!(matches!(*second_body, Type::Rigid(id) if id == second_variables[0]));
    }

    #[test]
    fn cached_interfaces_reject_mutable_inference_variables() {
        let checked = CheckedModule {
            result: Type::Variable(0),
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
        };

        assert!(CachedModuleInterface::from_checked(&checked).is_none());
    }

    #[test]
    fn recursive_closure_certificate_rejects_an_unknown_body() {
        let checked = CheckedModule {
            result: Type::Unit,
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            closure_signatures: vec![(ExpressionId(7), Type::Unit)],
            recursive_closures: vec![ExpressionId(8)],
            ownership_contracts: Vec::new(),
        };
        let cached =
            CachedModuleInterface::from_checked(&checked).expect("a closed interface is cacheable");

        assert!(
            cached
                .certificate()
                .validate()
                .is_err_and(|error| error.contains("unknown closure expression 8"))
        );
    }

    #[test]
    fn ownership_contract_certificate_rejects_an_unknown_body() {
        let checked = CheckedModule {
            result: Type::Unit,
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            closure_signatures: vec![(ExpressionId(7), Type::Unit)],
            recursive_closures: Vec::new(),
            ownership_contracts: vec![(
                ExpressionId(8),
                crate::ownership::OwnershipContract {
                    parameter: PatternId(0),
                    result: crate::ownership::Produced::None,
                },
            )],
        };
        let cached =
            CachedModuleInterface::from_checked(&checked).expect("a closed interface is cacheable");

        assert!(cached.certificate().validate().is_err_and(|error| {
            error.contains("ownership contract for unknown closure expression 8")
        }));
    }

    #[test]
    fn failed_union_candidates_leave_no_variable_bounds() {
        let checker = Checker::new(Rc::new(Context::default()));
        let variable = checker.fresh();
        let Type::Variable(variable_id) = variable.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let left = Type::Record(vec![("value".to_owned(), variable)]);
        let right = Type::Union(vec![Type::Record(vec![
            ("value".to_owned(), int_type()),
            ("missing".to_owned(), int_type()),
        ])]);

        let result = checker.constrain(left, right, Span { start: 0, end: 0 });

        assert!(result.is_err());
        let variables = checker.variables.borrow();
        assert!(variables[variable_id as usize].lower.is_empty());
        assert!(variables[variable_id as usize].upper.is_empty());
    }

    #[test]
    fn successful_union_candidate_commits_only_its_variable_bounds() {
        let checker = Checker::new(Rc::new(Context::default()));
        let variable = checker.fresh();
        let Type::Variable(variable_id) = variable.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let left = Type::Record(vec![("value".to_owned(), variable)]);
        let right = Type::Union(vec![
            Type::Record(vec![
                ("value".to_owned(), int_type()),
                ("missing".to_owned(), int_type()),
            ]),
            Type::Record(vec![("value".to_owned(), text_type())]),
        ]);

        checker
            .constrain(left, right, Span { start: 0, end: 0 })
            .expect("the second union candidate accepts the record");

        let variables = checker.variables.borrow();
        let variable = &variables[variable_id as usize];
        assert!(variable.lower.is_empty());
        assert_eq!(variable.upper.len(), 1);
        assert!(same_type(
            &checker.expand_constraint(variable.upper[0]),
            &text_type()
        ));
    }

    #[test]
    fn permuted_variant_bounds_share_one_constraint_edge() {
        let checker = Checker::new(Rc::new(Context::default()));
        let variable = checker.fresh();
        let Type::Variable(variable_id) = variable.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let first = Type::Variant {
            cases: vec![
                ("Left".to_owned(), Type::Unit),
                ("Right".to_owned(), Type::Unit),
            ],
            open: false,
        };
        let second = Type::Variant {
            cases: vec![
                ("Right".to_owned(), Type::Unit),
                ("Left".to_owned(), Type::Unit),
            ],
            open: false,
        };

        checker
            .constrain(variable.clone(), first.clone(), Span { start: 0, end: 0 })
            .expect("the first closed variant constrains the variable");
        checker
            .constrain(variable.clone(), second, Span { start: 0, end: 0 })
            .expect("field order does not change the closed variant");

        assert_eq!(
            checker.variables.borrow()[variable_id as usize].upper.len(),
            1
        );
        assert!(same_type(&checker.settle(variable, false), &first));
    }

    #[test]
    fn extrusion_copies_deeper_variables_to_the_shallower_level() {
        let checker = Checker::new(Rc::new(Context::default()));
        let shallow = checker.fresh();
        checker.level.set(1);
        let deep = checker.fresh();
        checker.level.set(0);
        let Type::Variable(shallow_id) = shallow.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let Type::Variable(deep_id) = deep else {
            unreachable!("fresh always returns a variable")
        };

        checker
            .constrain(
                shallow,
                Type::Array(Box::new(Type::Variable(deep_id))),
                Span { start: 0, end: 0 },
            )
            .expect("a deeper type can flow through an extruded copy");

        let upper = checker.variables.borrow()[shallow_id as usize].upper[0];
        let upper = checker.expand_constraint(upper);
        let Type::Array(element) = upper else {
            panic!("the shallow variable must retain the array structure")
        };
        let Type::Variable(copy_id) = *element else {
            panic!("the deeper element must be copied")
        };
        let variables = checker.variables.borrow();
        assert_eq!(variables[copy_id as usize].level, 0);
        assert!(
            variables[deep_id as usize]
                .lower
                .iter()
                .map(|bound| checker.expand_constraint(*bound))
                .any(|bound| same_type(&bound, &Type::Variable(copy_id)))
        );
    }

    #[test]
    fn effectful_callback_contributes_to_wrapper_effects() {
        let checker = Checker::new(Rc::new(Context::default()));
        checker.level.set(1);
        let parameter = checker.fresh();
        let callback = checker.fresh();
        let callback_effects = checker.fresh();
        let wrapper_effects = checker.fresh();
        checker
            .constrain(
                callback.clone(),
                Type::Function {
                    parameter: Box::new(Type::Unit),
                    effects: Box::new(callback_effects.clone()),
                    result: Box::new(Type::Unit),
                },
                Span { start: 0, end: 0 },
            )
            .expect("the callback parameter is callable");
        checker
            .constrain(
                parameter.clone(),
                Type::Record(vec![("0".to_owned(), callback)]),
                Span { start: 0, end: 0 },
            )
            .expect("the wrapper parameter contains its callback");
        checker
            .constrain(
                callback_effects,
                wrapper_effects.clone(),
                Span { start: 0, end: 0 },
            )
            .expect("the wrapper performs its callback effects");
        let wrapper = Type::Function {
            parameter: Box::new(parameter),
            effects: Box::new(wrapper_effects),
            result: Box::new(Type::Unit),
        };
        checker.level.set(0);
        let wrapper = checker.freshen(wrapper, 0, &mut HashMap::new());
        let performed = checker.fresh();
        checker
            .constrain(
                wrapper,
                Type::Function {
                    parameter: Box::new(Type::Record(vec![(
                        "0".to_owned(),
                        Type::Function {
                            parameter: Box::new(Type::Unit),
                            effects: Box::new(Type::Effects(BTreeSet::from(["Access".to_owned()]))),
                            result: Box::new(Type::Unit),
                        },
                    )])),
                    effects: Box::new(performed.clone()),
                    result: Box::new(Type::Unit),
                },
                Span { start: 0, end: 0 },
            )
            .expect("the wrapper accepts an effectful callback");

        assert!(same_type(
            &checker.settle(performed, true),
            &Type::Effects(BTreeSet::from(["Access".to_owned()])),
        ));
    }

    #[test]
    fn forall_on_the_left_instantiates_at_a_monotype() {
        let checker = Checker::new(Rc::new(Context::default()));
        let identity = Type::Forall {
            variables: vec![7],
            body: Box::new(Type::Function {
                parameter: Box::new(Type::Rigid(7)),
                effects: Box::new(Type::Effects(BTreeSet::new())),
                result: Box::new(Type::Rigid(7)),
            }),
        };
        let integer_identity = Type::Function {
            parameter: Box::new(int_type()),
            effects: Box::new(Type::Effects(BTreeSet::new())),
            result: Box::new(int_type()),
        };

        checker
            .constrain(identity, integer_identity, Span { start: 0, end: 0 })
            .expect("a polymorphic identity can be instantiated at Int");
    }

    #[test]
    fn forall_equality_ignores_bound_rigid_names() {
        let left = Type::Forall {
            variables: vec![7],
            body: Box::new(Type::Function {
                parameter: Box::new(Type::Rigid(7)),
                effects: Box::new(Type::Effects(BTreeSet::new())),
                result: Box::new(Type::Rigid(7)),
            }),
        };
        let right = Type::Forall {
            variables: vec![91],
            body: Box::new(Type::Function {
                parameter: Box::new(Type::Rigid(91)),
                effects: Box::new(Type::Effects(BTreeSet::new())),
                result: Box::new(Type::Rigid(91)),
            }),
        };

        assert!(same_type(&left, &right));
    }

    #[test]
    fn forall_equality_does_not_capture_a_free_rigid() {
        let bound = Type::Forall {
            variables: vec![7],
            body: Box::new(Type::Rigid(7)),
        };
        let free = Type::Forall {
            variables: vec![91],
            body: Box::new(Type::Rigid(7)),
        };

        assert!(!same_type(&bound, &free));
    }

    #[test]
    fn monomorphic_function_does_not_satisfy_a_forall_requirement() {
        let checker = Checker::new(Rc::new(Context::default()));
        let integer_identity = Type::Function {
            parameter: Box::new(int_type()),
            effects: Box::new(Type::Effects(BTreeSet::new())),
            result: Box::new(int_type()),
        };
        let identity_requirement = Type::Forall {
            variables: vec![7],
            body: Box::new(Type::Function {
                parameter: Box::new(Type::Rigid(7)),
                effects: Box::new(Type::Effects(BTreeSet::new())),
                result: Box::new(Type::Rigid(7)),
            }),
        };

        let result = checker.constrain(
            integer_identity,
            identity_requirement,
            Span { start: 0, end: 0 },
        );

        assert!(result.is_err());
    }

    #[test]
    fn failed_speculation_restores_skolem_identity_allocation() {
        let checker = Checker::new(Rc::new(Context::default()));
        let initial_skolem = checker.next_skolem.get();
        let requirement = Type::Forall {
            variables: vec![7],
            body: Box::new(Type::Rigid(7)),
        };

        assert!(!checker.can_constrain(int_type(), requirement, Span { start: 0, end: 0 },));
        assert_eq!(checker.next_skolem.get(), initial_skolem);
    }

    #[test]
    fn semantic_ordering_sets_build_exact_integer_regions() {
        use crate::recognise::Ordering;
        let non_zero = ordering_type(
            &BTreeSet::from([Ordering::Less, Ordering::Greater]),
            &BigInt::from(0),
        );
        assert!(same_type(
            &non_zero,
            &Type::Union(vec![
                Type::Range {
                    domain: Domain::Int,
                    low: None,
                    high: Some(Scalar::Int((-1).into())),
                },
                Type::Range {
                    domain: Domain::Int,
                    low: Some(Scalar::Int(1.into())),
                    high: None,
                },
            ])
        ));
    }

    #[test]
    fn conjunction_intersects_semantic_integer_regions() {
        use crate::recognise::Ordering;
        let at_least_zero = ordering_type(
            &BTreeSet::from([Ordering::Equal, Ordering::Greater]),
            &BigInt::from(0),
        );
        let at_most_byte = ordering_type(
            &BTreeSet::from([Ordering::Less, Ordering::Equal]),
            &BigInt::from(255),
        );
        let byte = intersect_integer_types(&at_least_zero, &at_most_byte)
            .expect("both sides are integer regions");
        assert!(same_type(
            &byte,
            &Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(0.into())),
                high: Some(Scalar::Int(255.into())),
            }
        ));
    }
}
