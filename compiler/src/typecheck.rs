use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::rc::Rc;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

thread_local! {
    static UNION_VISITS: Cell<u64> = const { Cell::new(0) };
}

use crate::artifact_limits::{ARTIFACT_EXPANDED_REFERENCE_LIMIT, ARTIFACT_REFERENCE_PATH_LIMIT};
use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId, Module, Pattern,
    PatternId, Qualifier, ShapeMember, Span,
};
use crate::diagnostic::Diagnostic;
use crate::eval::{
    ApplicationSite, CompilerApplication, Context, ModuleFacts, Phase, Runtime, apply,
    closure_free_names, evaluate_binding, evaluate_expression, force_effect_value, match_pattern,
    run, signature_hole_expressions,
};
use crate::value::{
    Domain as ValueDomain, Environment as ValueEnvironment, OpenedValues, OrderedFields,
    RecursiveBindings, Value, attach_signature, child_env, closure_signature, declaration_env,
    lookup, opened_members, recursive_env, reusable_across_module_instances,
};

type VariableId = u32;

#[derive(Debug)]
/// An immutable type edge whose clone preserves the checker's shared graph.
pub struct TypeList<T>(Rc<Vec<T>>);

impl<T> Clone for TypeList<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> TypeList<T> {
    fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl<T> std::ops::Deref for TypeList<T> {
    type Target = Vec<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> From<Vec<T>> for TypeList<T> {
    fn from(values: Vec<T>) -> Self {
        Self(Rc::new(values))
    }
}

impl<T> FromIterator<T> for TypeList<T> {
    fn from_iter<I: IntoIterator<Item = T>>(values: I) -> Self {
        Self(Rc::new(values.into_iter().collect()))
    }
}

impl<T: Clone> IntoIterator for TypeList<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;

    fn into_iter(self) -> Self::IntoIter {
        Rc::unwrap_or_clone(self.0).into_iter()
    }
}

impl<'a, T> IntoIterator for &'a TypeList<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

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
        body: Rc<Type>,
    },
    Range {
        domain: Domain,
        low: Option<Scalar>,
        high: Option<Scalar>,
    },
    Unit,
    Function {
        deferred: bool,
        parameter: Rc<Type>,
        effects: Rc<Type>,
        result: Rc<Type>,
    },
    Record(TypeList<(String, Type)>),
    RecordUpdate {
        base: Rc<Type>,
        fields: TypeList<(String, Type)>,
    },
    Array(Rc<Type>),
    Region(Rc<Type>),
    Scratch(Rc<Type>),
    Variant {
        cases: TypeList<(String, Type)>,
        open: bool,
    },
    Effects(BTreeSet<String>),
    OpenEffects {
        labels: BTreeSet<String>,
        tail: Rc<Type>,
    },
    Union(TypeList<Type>),
    Opaque(String),
    Top,
    Bottom,
}

pub(crate) fn record_update_type(base: Type, updates: TypeList<(String, Type)>) -> Type {
    match base {
        Type::Record(fields) => {
            let mut fields = fields.into_iter().collect::<Vec<_>>();
            for (name, type_) in updates {
                if let Some((_, current)) =
                    fields.iter_mut().find(|(candidate, _)| candidate == &name)
                {
                    *current = type_;
                } else {
                    fields.push((name, type_));
                }
            }
            Type::Record(fields.into())
        }
        Type::RecordUpdate { base, fields } => {
            let mut combined = fields.into_iter().collect::<Vec<_>>();
            for (name, type_) in updates {
                if let Some((_, current)) = combined
                    .iter_mut()
                    .find(|(candidate, _)| candidate == &name)
                {
                    *current = type_;
                } else {
                    combined.push((name, type_));
                }
            }
            Type::RecordUpdate {
                base,
                fields: combined.into(),
            }
        }
        base => Type::RecordUpdate {
            base: Rc::new(base),
            fields: updates,
        },
    }
}

// A lowered `for` can retain `RecordUpdate` relationships while its `:=`
// accumulator has already proved that every back edge preserves the base type.
// Runtime specialization needs that stable representation variable, not the
// source-level field refinement layered over it.
fn stable_loop_signature(type_: Type) -> Type {
    match type_ {
        Type::RecordUpdate { base, .. } => stable_loop_signature(Rc::unwrap_or_clone(base)),
        Type::Forall { variables, body } => Type::Forall {
            variables,
            body: Rc::new(stable_loop_signature(Rc::unwrap_or_clone(body))),
        },
        Type::Function {
            deferred,
            parameter,
            effects,
            result,
        } => Type::Function {
            deferred,
            parameter: Rc::new(stable_loop_signature(Rc::unwrap_or_clone(parameter))),
            effects: Rc::new(stable_loop_signature(Rc::unwrap_or_clone(effects))),
            result: Rc::new(stable_loop_signature(Rc::unwrap_or_clone(result))),
        },
        Type::Record(fields) => Type::Record(
            fields
                .into_iter()
                .map(|(name, type_)| (name, stable_loop_signature(type_)))
                .collect(),
        ),
        Type::Array(element) => {
            Type::Array(Rc::new(stable_loop_signature(Rc::unwrap_or_clone(element))))
        }
        Type::Region(element) => {
            Type::Region(Rc::new(stable_loop_signature(Rc::unwrap_or_clone(element))))
        }
        Type::Scratch(element) => {
            Type::Scratch(Rc::new(stable_loop_signature(Rc::unwrap_or_clone(element))))
        }
        Type::Variant { cases, open } => Type::Variant {
            cases: cases
                .into_iter()
                .map(|(name, type_)| (name, stable_loop_signature(type_)))
                .collect(),
            open,
        },
        Type::OpenEffects { labels, tail } => Type::OpenEffects {
            labels,
            tail: Rc::new(stable_loop_signature(Rc::unwrap_or_clone(tail))),
        },
        Type::Union(members) => {
            Type::Union(members.into_iter().map(stable_loop_signature).collect())
        }
        type_ => type_,
    }
}

enum Requirement {
    Type(Type),
    Predicate(Value),
}

struct EvaluatedClosure<'a> {
    module_path: &'a str,
    parameter: PatternId,
    body: ExpressionId,
    captures: &'a ValueEnvironment,
    self_name: Option<&'a str>,
    deferred: bool,
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
        deferred: bool,
        parameter: ConstraintTypeId,
        effects: ConstraintTypeId,
        result: ConstraintTypeId,
    },
    Record(Vec<(String, ConstraintTypeId)>),
    RecordUpdate {
        base: ConstraintTypeId,
        fields: Vec<(String, ConstraintTypeId)>,
    },
    Array(ConstraintTypeId),
    Region(ConstraintTypeId),
    Scratch(ConstraintTypeId),
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
    intern_attempts: u64,
}

impl ConstraintTypeArena {
    fn reset(&mut self) {
        self.nodes.clear();
        self.interned.clear();
        self.intern_attempts = 0;
    }

    fn intern(&mut self, type_: &Type) -> ConstraintTypeId {
        self.intern_attempts += 1;
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
                deferred,
                parameter,
                effects,
                result,
            } => ConstraintTypeNode::Function {
                deferred: *deferred,
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
            Type::RecordUpdate { base, fields } => ConstraintTypeNode::RecordUpdate {
                base: self.intern(base),
                fields: fields
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.intern(type_)))
                    .collect(),
            },
            Type::Array(element) => ConstraintTypeNode::Array(self.intern(element)),
            Type::Region(element) => ConstraintTypeNode::Region(self.intern(element)),
            Type::Scratch(element) => ConstraintTypeNode::Scratch(self.intern(element)),
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
                body: Rc::new(self.expand(*body)),
            },
            ConstraintTypeNode::Range { domain, low, high } => Type::Range {
                domain: *domain,
                low: low.clone(),
                high: high.clone(),
            },
            ConstraintTypeNode::Unit => Type::Unit,
            ConstraintTypeNode::Function {
                deferred,
                parameter,
                effects,
                result,
            } => Type::Function {
                deferred: *deferred,
                parameter: Rc::new(self.expand(*parameter)),
                effects: Rc::new(self.expand(*effects)),
                result: Rc::new(self.expand(*result)),
            },
            ConstraintTypeNode::Record(fields) => Type::Record(
                fields
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.expand(*type_)))
                    .collect(),
            ),
            ConstraintTypeNode::RecordUpdate { base, fields } => Type::RecordUpdate {
                base: Rc::new(self.expand(*base)),
                fields: fields
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.expand(*type_)))
                    .collect(),
            },
            ConstraintTypeNode::Array(element) => Type::Array(Rc::new(self.expand(*element))),
            ConstraintTypeNode::Region(element) => Type::Region(Rc::new(self.expand(*element))),
            ConstraintTypeNode::Scratch(element) => Type::Scratch(Rc::new(self.expand(*element))),
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
                tail: Rc::new(self.expand(*tail)),
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
                ..
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
            ConstraintTypeNode::RecordUpdate { base, fields } => fields
                .iter()
                .map(|(_, field)| self.level_of(*field, variables))
                .chain(std::iter::once(self.level_of(*base, variables)))
                .max()
                .unwrap_or(0),
            ConstraintTypeNode::Array(element)
            | ConstraintTypeNode::Region(element)
            | ConstraintTypeNode::Scratch(element) => self.level_of(*element, variables),
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
                    deferred: left_deferred,
                    parameter: left_parameter,
                    effects: left_effects,
                    result: left_result,
                },
                ConstraintTypeNode::Function {
                    deferred: right_deferred,
                    parameter: right_parameter,
                    effects: right_effects,
                    result: right_result,
                },
            ) => {
                left_deferred == right_deferred
                    && self.same_with_rigids(*left_parameter, *right_parameter, rigids)
                    && self.same_with_rigids(*left_effects, *right_effects, rigids)
                    && self.same_with_rigids(*left_result, *right_result, rigids)
            }
            (ConstraintTypeNode::Record(left), ConstraintTypeNode::Record(right)) => {
                self.same_fields(left, right, rigids)
            }
            (
                ConstraintTypeNode::RecordUpdate {
                    base: left_base,
                    fields: left_fields,
                },
                ConstraintTypeNode::RecordUpdate {
                    base: right_base,
                    fields: right_fields,
                },
            ) => {
                self.same_with_rigids(*left_base, *right_base, rigids)
                    && self.same_fields(left_fields, right_fields, rigids)
            }
            (ConstraintTypeNode::Array(left), ConstraintTypeNode::Array(right))
            | (ConstraintTypeNode::Region(left), ConstraintTypeNode::Region(right))
            | (ConstraintTypeNode::Scratch(left), ConstraintTypeNode::Scratch(right)) => {
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

#[derive(Clone, Copy)]
struct WorkItem {
    left: ConstraintTypeId,
    right: ConstraintTypeId,
    span: Span,
}

#[derive(Clone)]
struct ResidualVariable {
    type_: Type,
    unresolved: BTreeSet<VariableId>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompilerWork {
    schema: u32,
    type_nodes: u64,
    type_interns: u64,
    constraints: u64,
    settle_visits: u64,
    freshen_visits: u64,
    union_visits: u64,
    boundary_materializations: u64,
    capture_candidates: u64,
    captures_bridged: u64,
    interface_fields_demanded: u64,
    solver_worklist_peak: u64,
}

#[derive(Clone, Copy, Default)]
struct WorkSnapshot {
    type_nodes: u64,
    type_interns: u64,
    constraints: u64,
    settle_visits: u64,
    freshen_visits: u64,
    union_visits: u64,
    boundary_materializations: u64,
    capture_candidates: u64,
    captures_bridged: u64,
    interface_fields_demanded: u64,
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
    exact_records: Rc<BTreeSet<String>>,
    exact_record_orders: Rc<BTreeMap<String, Vec<String>>>,
    opens: Rc<Vec<OpenedTypes>>,
    forward: Rc<BTreeSet<String>>,
    parent: Option<Rc<TypeEnvironment>>,
}

#[derive(Clone)]
struct OpenedTypes {
    inferred: TypeList<(String, Type)>,
    values: OrderedFields,
    resolved: Rc<RefCell<HashMap<String, Type>>>,
    used: Rc<RefCell<BTreeSet<String>>>,
}

impl OpenedTypes {
    fn get(&self, target: &str, checker: &Checker) -> Option<Type> {
        if !self.values.contains_key(target) {
            return None;
        }
        self.used.borrow_mut().insert(target.to_owned());
        if let Some(type_) = self.resolved.borrow().get(target) {
            return Some(type_.clone());
        }
        let type_ = match self
            .inferred
            .iter()
            .find_map(|(name, type_)| (name == target).then_some(type_))
        {
            Some(type_) => type_.clone(),
            None => checker.bridge_runtime_value(self.values.get(target)?),
        };
        checker
            .interface_fields_demanded
            .set(checker.interface_fields_demanded.get() + 1);
        self.resolved
            .borrow_mut()
            .insert(target.to_owned(), type_.clone());
        Some(type_)
    }

    fn contains(&self, target: &str) -> bool {
        self.values.contains_key(target)
    }
}

impl TypeEnvironment {
    fn child(parent: Rc<Self>) -> Self {
        Self {
            names: Rc::new(BTreeMap::new()),
            phases: Rc::new(BTreeMap::new()),
            stable_names: Rc::new(BTreeMap::new()),
            exact_records: Rc::new(BTreeSet::new()),
            exact_record_orders: Rc::new(BTreeMap::new()),
            opens: Rc::new(Vec::new()),
            forward: Rc::new(BTreeSet::new()),
            parent: Some(parent),
        }
    }

    fn lookup(&self, name: &str, checker: &Checker) -> Option<Typing> {
        if let Some(typing) = self.names.get(name) {
            return Some(typing.clone());
        }
        for opened in self.opens.iter().rev() {
            if let Some(type_) = opened.get(name, checker) {
                return Some(Typing::Mono(type_));
            }
        }
        self.parent.as_ref()?.lookup(name, checker)
    }

    fn lookup_stable(&self, name: &str, checker: &Checker) -> Option<Typing> {
        if let Some(typing) = self.stable_names.get(name) {
            return Some(typing.clone());
        }
        if let Some(typing) = self.names.get(name) {
            return Some(typing.clone());
        }
        for opened in self.opens.iter().rev() {
            if let Some(type_) = opened.get(name, checker) {
                return Some(Typing::Mono(type_));
            }
        }
        self.parent.as_ref()?.lookup_stable(name, checker)
    }

    fn binding_phase(&self, name: &str) -> Option<Phase> {
        if self.names.contains_key(name) {
            return self.phases.get(name).copied();
        }
        if self.opens.iter().rev().any(|opened| opened.contains(name)) {
            return Some(Phase::Comptime);
        }
        self.parent.as_ref()?.binding_phase(name)
    }

    fn is_exact_record(&self, name: &str) -> bool {
        if self.names.contains_key(name) {
            return self.exact_records.contains(name);
        }
        self.parent
            .as_ref()
            .is_some_and(|parent| parent.is_exact_record(name))
    }

    fn exact_record_order(&self, name: &str) -> Option<Vec<String>> {
        if self.names.contains_key(name) {
            return self.exact_record_orders.get(name).cloned();
        }
        self.parent.as_ref()?.exact_record_order(name)
    }

    fn contains_binding(&self, name: &str) -> bool {
        self.names.contains_key(name)
            || self.opens.iter().rev().any(|opened| opened.contains(name))
            || self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.contains_binding(name))
    }

    fn open_shadows(&self, name: &str) -> bool {
        if self.names.contains_key(name) {
            return false;
        }
        self.opens.iter().rev().any(|opened| opened.contains(name))
            || self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.contains_binding(name))
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
    pub expression_types: Vec<(ExpressionId, Type)>,
    pub closure_signatures: Vec<(ExpressionId, Type)>,
    pub recursive_closures: Vec<ExpressionId>,
    pub ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
    pub simplifications: Vec<SimplificationFact>,
    pub readability: Vec<ReadabilityFact>,
}

#[derive(Clone)]
pub struct CachedModuleInterface {
    types: Rc<FlatTypeArena>,
    result: FlatTypeId,
    effects: FlatTypeId,
    parameter: Option<FlatTypeId>,
    evaluated: Option<ValueEnvironment>,
    expression_types: Vec<(ExpressionId, FlatTypeId)>,
    closure_signatures: Vec<(ExpressionId, FlatTypeId)>,
    recursive_closures: Vec<ExpressionId>,
    ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
    simplifications: Vec<SimplificationFact>,
    readability: Vec<ReadabilityFact>,
}

pub(crate) use crate::protocol::CHECKED_MODULE_CERTIFICATE_SCHEMA;

#[derive(Clone, Deserialize, Serialize)]
pub struct CheckedModuleCertificate {
    pub(crate) schema: u32,
    pub(crate) types: Vec<FlatTypeNode>,
    pub(crate) result: FlatTypeId,
    pub(crate) effects: FlatTypeId,
    pub(crate) parameter: Option<FlatTypeId>,
    pub(crate) expression_types: Vec<(ExpressionId, FlatTypeId)>,
    pub(crate) closure_signatures: Vec<(ExpressionId, FlatTypeId)>,
    pub(crate) recursive_closures: Vec<ExpressionId>,
    pub(crate) ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
    pub(crate) simplifications: Vec<SimplificationFact>,
    pub(crate) readability: Vec<ReadabilityFact>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SimplificationFact {
    IntegerEquality {
        expression: ExpressionId,
        subject: ExpressionId,
        pattern: IntegerEqualityPattern,
    },
    ShortCircuitAnd {
        expression: ExpressionId,
        left: ExpressionId,
        right: ExpressionId,
    },
}

#[derive(Clone, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReadabilityFact {
    DirectEffectComputation {
        expression: ExpressionId,
    },
    EmptyArray {
        expression: ExpressionId,
    },
    StableShadow {
        expression: ExpressionId,
        name: String,
    },
    RecordReconstruction {
        expression: ExpressionId,
        source: ExpressionId,
        retained: Vec<String>,
    },
    OpenUsage {
        expression: ExpressionId,
        used: Vec<String>,
        shadowed: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ReadabilityFactKind {
    DirectEffectComputation,
    EmptyArray,
    StableShadow,
    RecordReconstruction,
    OpenUsage,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum IntegerEqualityPattern {
    Literal { expression: ExpressionId },
    Pin { name: String },
}

impl SimplificationFact {
    fn expression(&self) -> ExpressionId {
        match self {
            Self::IntegerEquality { expression, .. } | Self::ShortCircuitAnd { expression, .. } => {
                *expression
            }
        }
    }

    fn referenced_expressions(&self) -> Vec<ExpressionId> {
        match self {
            Self::IntegerEquality {
                expression,
                subject,
                pattern,
            } => {
                let mut expressions = vec![*expression, *subject];
                if let IntegerEqualityPattern::Literal { expression } = pattern {
                    expressions.push(*expression);
                }
                expressions
            }
            Self::ShortCircuitAnd {
                expression,
                left,
                right,
            } => vec![*expression, *left, *right],
        }
    }
}

impl ReadabilityFact {
    fn kind(&self) -> ReadabilityFactKind {
        match self {
            Self::DirectEffectComputation { .. } => ReadabilityFactKind::DirectEffectComputation,
            Self::EmptyArray { .. } => ReadabilityFactKind::EmptyArray,
            Self::StableShadow { .. } => ReadabilityFactKind::StableShadow,
            Self::RecordReconstruction { .. } => ReadabilityFactKind::RecordReconstruction,
            Self::OpenUsage { .. } => ReadabilityFactKind::OpenUsage,
        }
    }

    fn expression(&self) -> ExpressionId {
        match self {
            Self::DirectEffectComputation { expression }
            | Self::EmptyArray { expression }
            | Self::StableShadow { expression, .. }
            | Self::RecordReconstruction { expression, .. }
            | Self::OpenUsage { expression, .. } => *expression,
        }
    }

    fn referenced_expressions(&self) -> Vec<ExpressionId> {
        match self {
            Self::RecordReconstruction {
                expression, source, ..
            } => vec![*expression, *source],
            fact => vec![fact.expression()],
        }
    }
}

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub(crate) struct FlatTypeId(pub(crate) u32);

#[derive(Clone, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub(crate) enum FlatTypeNode {
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
        deferred: bool,
        parameter: FlatTypeId,
        effects: FlatTypeId,
        result: FlatTypeId,
    },
    Record(Vec<(String, FlatTypeId)>),
    RecordUpdate {
        base: FlatTypeId,
        fields: Vec<(String, FlatTypeId)>,
    },
    Array(FlatTypeId),
    Region(FlatTypeId),
    Scratch(FlatTypeId),
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

fn append_flat_type_children(node: &FlatTypeNode, children: &mut Vec<FlatTypeId>) {
    match node {
        FlatTypeNode::Forall { body, .. } => children.push(*body),
        FlatTypeNode::Function {
            parameter,
            effects,
            result,
            ..
        } => children.extend([*parameter, *effects, *result]),
        FlatTypeNode::Record(fields) | FlatTypeNode::Variant { cases: fields, .. } => {
            children.extend(fields.iter().map(|(_, field)| *field));
        }
        FlatTypeNode::RecordUpdate { base, fields } => {
            children.push(*base);
            children.extend(fields.iter().map(|(_, field)| *field));
        }
        FlatTypeNode::Array(element)
        | FlatTypeNode::Region(element)
        | FlatTypeNode::Scratch(element) => children.push(*element),
        FlatTypeNode::OpenEffects { tail, .. } => children.push(*tail),
        FlatTypeNode::Union(members) => children.extend(members.iter().copied()),
        FlatTypeNode::Rigid(_)
        | FlatTypeNode::Range { .. }
        | FlatTypeNode::Unit
        | FlatTypeNode::Effects(_)
        | FlatTypeNode::Opaque(_)
        | FlatTypeNode::Top
        | FlatTypeNode::Bottom => {}
    }
}

fn validate_flat_type_reference_budget(
    artifact: &str,
    types: &[FlatTypeNode],
    roots: impl IntoIterator<Item = FlatTypeId>,
) -> Result<(), String> {
    let roots = roots.into_iter().collect::<Vec<_>>();
    let mut reachable = vec![false; types.len()];
    let mut pending = roots.clone();
    let mut children = Vec::new();
    while let Some(type_) = pending.pop() {
        let index = type_.0 as usize;
        let node = types
            .get(index)
            .ok_or_else(|| format!("{artifact} references missing type {index}"))?;
        if reachable[index] {
            continue;
        }
        reachable[index] = true;
        children.clear();
        append_flat_type_children(node, &mut children);
        for child in &children {
            if child.0 >= type_.0 {
                return Err(format!(
                    "{artifact} type {} references non-prior type {}",
                    type_.0, child.0
                ));
            }
            pending.push(*child);
        }
    }

    let mut reference_depths = vec![0_usize; types.len()];
    let mut expanded_references = vec![0_u64; types.len()];
    let expanded_overflow = ARTIFACT_EXPANDED_REFERENCE_LIMIT + 1;
    for (index, node) in types.iter().enumerate() {
        if !reachable[index] {
            continue;
        }
        children.clear();
        append_flat_type_children(node, &mut children);
        let mut depth = 0_usize;
        let mut expanded = 1_u64;
        for child in &children {
            let child = child.0 as usize;
            depth = depth.max(reference_depths[child].saturating_add(1));
            expanded = expanded
                .saturating_add(expanded_references[child])
                .min(expanded_overflow);
        }
        reference_depths[index] = depth;
        expanded_references[index] = expanded;
    }

    let mut expanded_roots = 0_u64;
    for root in roots {
        let index = root.0 as usize;
        let depth = reference_depths[index];
        if depth > ARTIFACT_REFERENCE_PATH_LIMIT {
            return Err(format!(
                "{artifact} root type {index} has reference-path depth {depth}, maximum is {ARTIFACT_REFERENCE_PATH_LIMIT}"
            ));
        }
        expanded_roots = expanded_roots
            .saturating_add(expanded_references[index])
            .min(expanded_overflow);
        if expanded_roots > ARTIFACT_EXPANDED_REFERENCE_LIMIT {
            return Err(format!(
                "{artifact} roots expand to at least {expanded_roots} references, maximum is {ARTIFACT_EXPANDED_REFERENCE_LIMIT}"
            ));
        }
    }
    Ok(())
}

fn interface_type_roots<'a>(
    result: FlatTypeId,
    effects: FlatTypeId,
    parameter: Option<FlatTypeId>,
    expression_types: &'a [(ExpressionId, FlatTypeId)],
    closure_signatures: &'a [(ExpressionId, FlatTypeId)],
) -> impl Iterator<Item = FlatTypeId> + 'a {
    std::iter::once(result)
        .chain(std::iter::once(effects))
        .chain(parameter)
        .chain(expression_types.iter().map(|(_, type_)| *type_))
        .chain(closure_signatures.iter().map(|(_, type_)| *type_))
}

struct FlatTypeArena {
    nodes: Vec<FlatTypeNode>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SealedModuleBoundary {
    pub(crate) schema: u32,
    pub(crate) compiler_semantic_version: String,
    pub(crate) certificate_schema: u32,
    pub(crate) types: Vec<FlatTypeNode>,
    pub(crate) result: FlatTypeId,
    pub(crate) effects: FlatTypeId,
    pub(crate) parameter: Option<FlatTypeId>,
}

impl SealedModuleBoundary {
    const SCHEMA: u32 = 1;

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema != Self::SCHEMA {
            return Err(format!(
                "sealed module boundary schema is {}, expected {}",
                self.schema,
                Self::SCHEMA,
            ));
        }
        if self.compiler_semantic_version != env!("CARGO_PKG_VERSION") {
            return Err(format!(
                "sealed module boundary compiler version is {}, expected {}",
                self.compiler_semantic_version,
                env!("CARGO_PKG_VERSION"),
            ));
        }
        if self.certificate_schema != CHECKED_MODULE_CERTIFICATE_SCHEMA {
            return Err(format!(
                "sealed module boundary certificate schema is {}, expected {}",
                self.certificate_schema, CHECKED_MODULE_CERTIFICATE_SCHEMA,
            ));
        }
        validate_flat_type_reference_budget(
            "sealed module boundary",
            &self.types,
            std::iter::once(self.result)
                .chain(std::iter::once(self.effects))
                .chain(self.parameter),
        )?;
        validate_certificate_type(&self.types, self.result)?;
        validate_certificate_type(&self.types, self.effects)?;
        if let Some(parameter) = self.parameter {
            validate_certificate_type(&self.types, parameter)?;
        }
        Ok(())
    }

    fn to_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        rmp_serde::to_vec(self)
            .map_err(|error| format!("could not encode sealed module boundary: {error}"))
    }

    #[cfg(test)]
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let boundary: Self = rmp_serde::from_slice(bytes)
            .map_err(|error| format!("could not decode sealed module boundary: {error}"))?;
        boundary.validate()?;
        Ok(boundary)
    }
}

#[derive(Default)]
struct FlatTypeBuilder {
    nodes: Vec<FlatTypeNode>,
    interned: HashMap<FlatTypeNode, FlatTypeId>,
}

impl FlatTypeBuilder {
    fn intern(&mut self, node: FlatTypeNode) -> FlatTypeId {
        if let Some(id) = self.interned.get(&node) {
            return *id;
        }
        let id = FlatTypeId(self.nodes.len() as u32);
        self.nodes.push(node.clone());
        self.interned.insert(node, id);
        id
    }
}

impl FlatTypeArena {
    fn node(&self, id: FlatTypeId) -> &FlatTypeNode {
        &self.nodes[id.0 as usize]
    }
}

impl CachedModuleInterface {
    fn from_checked(checked: &CheckedModule) -> Result<Option<Self>, String> {
        let interface = (|| {
            let mut types = FlatTypeBuilder::default();
            let mut bound = HashSet::new();
            let result = flatten_interface_type(&checked.result, &mut bound, &mut types)?;
            let effects = flatten_interface_type(&checked.effects, &mut bound, &mut types)?;
            let parameter = match &checked.parameter {
                Some(parameter) => Some(flatten_interface_type(parameter, &mut bound, &mut types)?),
                None => None,
            };
            let expression_types = checked
                .expression_types
                .iter()
                .map(|(expression, type_)| {
                    Some((
                        *expression,
                        flatten_interface_type(type_, &mut bound, &mut types)?,
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            let closure_signatures = checked
                .closure_signatures
                .iter()
                .map(|(body, signature)| {
                    Some((
                        *body,
                        flatten_interface_type(signature, &mut bound, &mut types)?,
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            Some(Self {
                types: Rc::new(FlatTypeArena { nodes: types.nodes }),
                result,
                effects,
                parameter,
                evaluated: checked.evaluated.clone(),
                expression_types,
                closure_signatures,
                recursive_closures: checked.recursive_closures.clone(),
                ownership_contracts: checked.ownership_contracts.clone(),
                simplifications: checked.simplifications.clone(),
                readability: checked.readability.clone(),
            })
        })();
        let Some(interface) = interface else {
            return Ok(None);
        };
        interface.validate_type_budget()?;
        Ok(Some(interface))
    }

    fn validate_type_budget(&self) -> Result<(), String> {
        validate_flat_type_reference_budget(
            "cached module interface",
            &self.types.nodes,
            interface_type_roots(
                self.result,
                self.effects,
                self.parameter,
                &self.expression_types,
                &self.closure_signatures,
            ),
        )
    }

    fn certificate(&self) -> CheckedModuleCertificate {
        CheckedModuleCertificate {
            schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            types: self.types.nodes.clone(),
            result: self.result,
            effects: self.effects,
            parameter: self.parameter,
            expression_types: self.expression_types.clone(),
            closure_signatures: self.closure_signatures.clone(),
            recursive_closures: self.recursive_closures.clone(),
            ownership_contracts: self.ownership_contracts.clone(),
            simplifications: self.simplifications.clone(),
            readability: self.readability.clone(),
        }
    }

    pub(crate) fn from_certificate(certificate: CheckedModuleCertificate) -> Result<Self, String> {
        certificate.validate()?;
        Ok(Self {
            types: Rc::new(FlatTypeArena {
                nodes: certificate.types,
            }),
            result: certificate.result,
            effects: certificate.effects,
            parameter: certificate.parameter,
            evaluated: None,
            expression_types: certificate.expression_types,
            closure_signatures: certificate.closure_signatures,
            recursive_closures: certificate.recursive_closures,
            ownership_contracts: certificate.ownership_contracts,
            simplifications: certificate.simplifications,
            readability: certificate.readability,
        })
    }

    fn sealed_boundary_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate_type_budget()?;
        let mut builder = FlatTypeBuilder::default();
        let mut rigids = Vec::new();
        let mut next_rigid = 0;
        let result = copy_boundary_type(
            &self.types,
            self.result,
            &mut rigids,
            &mut next_rigid,
            &mut builder,
        )?;
        let effects = copy_boundary_type(
            &self.types,
            self.effects,
            &mut rigids,
            &mut next_rigid,
            &mut builder,
        )?;
        let parameter = self
            .parameter
            .map(|parameter| {
                copy_boundary_type(
                    &self.types,
                    parameter,
                    &mut rigids,
                    &mut next_rigid,
                    &mut builder,
                )
            })
            .transpose()?;
        SealedModuleBoundary {
            schema: SealedModuleBoundary::SCHEMA,
            compiler_semantic_version: env!("CARGO_PKG_VERSION").to_owned(),
            certificate_schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            types: builder.nodes,
            result,
            effects,
            parameter,
        }
        .to_bytes()
    }
}

fn closed_boundary_type_key(
    source: &FlatTypeArena,
    root: FlatTypeId,
    outer_rigids: &[(VariableId, VariableId)],
) -> Option<String> {
    enum Frame {
        Visit(FlatTypeId),
        Assemble(FlatTypeNode, usize),
        AssembleForall {
            variable_count: usize,
            previous: Vec<(VariableId, Option<usize>)>,
        },
    }

    fn text(value: &str) -> String {
        format!("{}:{value}", value.len())
    }

    fn scalar(value: Option<&Scalar>) -> String {
        match value {
            None => "*".to_owned(),
            Some(Scalar::Int(value)) => format!("i{value}"),
            Some(Scalar::Text(value)) => format!("s{}", text(value)),
        }
    }

    fn fields(
        names: impl IntoIterator<Item = String>,
        keys: impl IntoIterator<Item = String>,
    ) -> String {
        let mut fields = names
            .into_iter()
            .zip(keys)
            .map(|(name, key)| format!("{}{key}", text(&name)))
            .collect::<Vec<_>>();
        fields.sort();
        format!("{{{}}}", fields.join(","))
    }

    let mut binders = outer_rigids
        .iter()
        .enumerate()
        .map(|(index, (source, _))| (*source, index))
        .collect::<HashMap<_, _>>();
    let mut stack = vec![Frame::Visit(root)];
    let mut keys = Vec::new();
    let mut children = Vec::new();
    while let Some(frame) = stack.pop() {
        match frame {
            Frame::Visit(type_) => {
                let node = source.nodes.get(type_.0 as usize)?.clone();
                match &node {
                    FlatTypeNode::Rigid(variable) => {
                        keys.push(format!("^{}", binders.get(variable)?));
                    }
                    FlatTypeNode::Forall { variables, body } => {
                        let depth = binders.len();
                        let mut previous = Vec::with_capacity(variables.len());
                        for (index, variable) in variables.iter().enumerate() {
                            previous.push((*variable, binders.insert(*variable, depth + index)));
                        }
                        stack.push(Frame::AssembleForall {
                            variable_count: variables.len(),
                            previous,
                        });
                        stack.push(Frame::Visit(*body));
                    }
                    FlatTypeNode::Range { domain, low, high } => {
                        let domain = match domain {
                            Domain::Int => "int",
                            Domain::Text => "text",
                            Domain::Float => "float64",
                            Domain::Float32 => "float32",
                        };
                        keys.push(format!(
                            "range({domain},{},{})",
                            scalar(low.as_ref()),
                            scalar(high.as_ref())
                        ));
                    }
                    FlatTypeNode::Unit => keys.push("unit".to_owned()),
                    FlatTypeNode::Effects(labels) => keys.push(format!(
                        "effects{{{}}}",
                        labels
                            .iter()
                            .map(|label| text(label))
                            .collect::<Vec<_>>()
                            .join(",")
                    )),
                    FlatTypeNode::Opaque(name) => {
                        keys.push(format!("opaque({})", text(name)));
                    }
                    FlatTypeNode::Top => keys.push("top".to_owned()),
                    FlatTypeNode::Bottom => keys.push("bottom".to_owned()),
                    _ => {
                        children.clear();
                        append_flat_type_children(&node, &mut children);
                        stack.push(Frame::Assemble(node, children.len()));
                        for child in children.iter().rev() {
                            stack.push(Frame::Visit(*child));
                        }
                    }
                }
            }
            Frame::Assemble(node, child_count) => {
                let first_child = keys.len().checked_sub(child_count)?;
                let mut children = keys.split_off(first_child).into_iter();
                let key = match node {
                    FlatTypeNode::Function { deferred, .. } => format!(
                        "fun({deferred},{},{},{})",
                        children.next()?,
                        children.next()?,
                        children.next()?
                    ),
                    FlatTypeNode::Record(values) => format!(
                        "record{}",
                        fields(values.into_iter().map(|(name, _)| name), children)
                    ),
                    FlatTypeNode::RecordUpdate { fields: values, .. } => {
                        let base = children.next()?;
                        format!(
                            "record-update({base},{})",
                            fields(values.into_iter().map(|(name, _)| name), children)
                        )
                    }
                    FlatTypeNode::Array(_) => format!("array({})", children.next()?),
                    FlatTypeNode::Region(_) => format!("region({})", children.next()?),
                    FlatTypeNode::Scratch(_) => format!("scratch({})", children.next()?),
                    FlatTypeNode::Variant { cases, open } => format!(
                        "variant({open}){}",
                        fields(cases.into_iter().map(|(name, _)| name), children)
                    ),
                    FlatTypeNode::OpenEffects { labels, .. } => format!(
                        "open-effects{{{};{}}}",
                        labels
                            .iter()
                            .map(|label| text(label))
                            .collect::<Vec<_>>()
                            .join(","),
                        children.next()?
                    ),
                    FlatTypeNode::Union(_) => {
                        let mut members = children.collect::<Vec<_>>();
                        members.sort();
                        format!("union{{{}}}", members.join(","))
                    }
                    FlatTypeNode::Rigid(_)
                    | FlatTypeNode::Forall { .. }
                    | FlatTypeNode::Range { .. }
                    | FlatTypeNode::Unit
                    | FlatTypeNode::Effects(_)
                    | FlatTypeNode::Opaque(_)
                    | FlatTypeNode::Top
                    | FlatTypeNode::Bottom => return None,
                };
                keys.push(key);
            }
            Frame::AssembleForall {
                variable_count,
                previous,
            } => {
                let body = keys.pop()?;
                for (variable, prior) in previous {
                    match prior {
                        Some(prior) => {
                            binders.insert(variable, prior);
                        }
                        None => {
                            binders.remove(&variable);
                        }
                    }
                }
                keys.push(format!("all{variable_count}({body})"));
            }
        }
    }
    let body = keys.pop()?;
    Some(format!("all{}({body})", outer_rigids.len()))
}

fn copy_boundary_type(
    source: &FlatTypeArena,
    type_: FlatTypeId,
    rigids: &mut Vec<(VariableId, VariableId)>,
    next_rigid: &mut VariableId,
    target: &mut FlatTypeBuilder,
) -> Result<FlatTypeId, String> {
    enum Frame {
        Copy(FlatTypeId),
        Assemble(FlatTypeNode, usize),
        AssembleForall {
            checkpoint: usize,
            variables: Vec<VariableId>,
        },
    }

    let mut stack = vec![Frame::Copy(type_)];
    let mut copied = Vec::new();
    let mut children = Vec::new();
    while let Some(frame) = stack.pop() {
        match frame {
            Frame::Copy(type_) => {
                let mut node = source
                    .nodes
                    .get(type_.0 as usize)
                    .ok_or_else(|| format!("sealed boundary references missing type {}", type_.0))?
                    .clone();
                match &mut node {
                    FlatTypeNode::Rigid(variable) => {
                        let canonical = rigids
                            .iter()
                            .rev()
                            .find_map(|(source, target)| (source == variable).then_some(*target))
                            .ok_or_else(|| {
                                format!("sealed boundary contains free rigid variable {variable}")
                            })?;
                        copied.push(target.intern(FlatTypeNode::Rigid(canonical)));
                        continue;
                    }
                    FlatTypeNode::Forall { variables, body } => {
                        let checkpoint = rigids.len();
                        let mut canonical_variables = Vec::with_capacity(variables.len());
                        for variable in variables.iter() {
                            let canonical = *next_rigid;
                            *next_rigid = next_rigid.checked_add(1).ok_or_else(|| {
                                "sealed boundary rigid identity overflow".to_owned()
                            })?;
                            rigids.push((*variable, canonical));
                            canonical_variables.push(canonical);
                        }
                        stack.push(Frame::AssembleForall {
                            checkpoint,
                            variables: canonical_variables,
                        });
                        stack.push(Frame::Copy(*body));
                        continue;
                    }
                    FlatTypeNode::Record(fields) => {
                        fields.sort_by(|left, right| left.0.cmp(&right.0));
                    }
                    FlatTypeNode::RecordUpdate { fields, .. } => {
                        fields.sort_by(|left, right| left.0.cmp(&right.0));
                    }
                    FlatTypeNode::Variant { cases, .. } => {
                        cases.sort_by(|left, right| left.0.cmp(&right.0));
                    }
                    FlatTypeNode::Union(members) => {
                        let mut keyed = members
                            .iter()
                            .map(|member| {
                                let key = closed_boundary_type_key(source, *member, rigids)
                                    .ok_or_else(|| {
                                        format!(
                                            "sealed boundary union member {} is not closed",
                                            member.0
                                        )
                                    })?;
                                Ok((key, *member))
                            })
                            .collect::<Result<Vec<_>, String>>()?;
                        keyed.sort_by(|left, right| left.0.cmp(&right.0));
                        *members = keyed.into_iter().map(|(_, member)| member).collect();
                    }
                    FlatTypeNode::Range { .. }
                    | FlatTypeNode::Unit
                    | FlatTypeNode::Effects(_)
                    | FlatTypeNode::Opaque(_)
                    | FlatTypeNode::Top
                    | FlatTypeNode::Bottom => {
                        copied.push(target.intern(node));
                        continue;
                    }
                    FlatTypeNode::Function { .. }
                    | FlatTypeNode::Array(_)
                    | FlatTypeNode::Region(_)
                    | FlatTypeNode::Scratch(_)
                    | FlatTypeNode::OpenEffects { .. } => {}
                }
                children.clear();
                append_flat_type_children(&node, &mut children);
                stack.push(Frame::Assemble(node, children.len()));
                for child in children.iter().rev() {
                    stack.push(Frame::Copy(*child));
                }
            }
            Frame::Assemble(node, child_count) => {
                let first_child = copied
                    .len()
                    .checked_sub(child_count)
                    .expect("sealed boundary assembly must receive every child");
                let mut children = copied.split_off(first_child).into_iter();
                let node = match node {
                    FlatTypeNode::Function { deferred, .. } => FlatTypeNode::Function {
                        deferred,
                        parameter: children.next().expect("function parameter"),
                        effects: children.next().expect("function effects"),
                        result: children.next().expect("function result"),
                    },
                    FlatTypeNode::Record(fields) => FlatTypeNode::Record(
                        fields
                            .into_iter()
                            .zip(children)
                            .map(|((name, _), type_)| (name, type_))
                            .collect(),
                    ),
                    FlatTypeNode::RecordUpdate { fields, .. } => FlatTypeNode::RecordUpdate {
                        base: children.next().expect("record-update base"),
                        fields: fields
                            .into_iter()
                            .zip(children)
                            .map(|((name, _), type_)| (name, type_))
                            .collect(),
                    },
                    FlatTypeNode::Array(_) => {
                        FlatTypeNode::Array(children.next().expect("array element"))
                    }
                    FlatTypeNode::Region(_) => {
                        FlatTypeNode::Region(children.next().expect("region element"))
                    }
                    FlatTypeNode::Scratch(_) => {
                        FlatTypeNode::Scratch(children.next().expect("scratch element"))
                    }
                    FlatTypeNode::Variant { cases, open } => FlatTypeNode::Variant {
                        cases: cases
                            .into_iter()
                            .zip(children)
                            .map(|((name, _), type_)| (name, type_))
                            .collect(),
                        open,
                    },
                    FlatTypeNode::OpenEffects { labels, .. } => FlatTypeNode::OpenEffects {
                        labels,
                        tail: children.next().expect("open-effects tail"),
                    },
                    FlatTypeNode::Union(_) => FlatTypeNode::Union(children.collect()),
                    FlatTypeNode::Rigid(_)
                    | FlatTypeNode::Forall { .. }
                    | FlatTypeNode::Range { .. }
                    | FlatTypeNode::Unit
                    | FlatTypeNode::Effects(_)
                    | FlatTypeNode::Opaque(_)
                    | FlatTypeNode::Top
                    | FlatTypeNode::Bottom => {
                        unreachable!("leaf and quantified boundary types assemble directly")
                    }
                };
                copied.push(target.intern(node));
            }
            Frame::AssembleForall {
                checkpoint,
                variables,
            } => {
                let body = copied.pop().expect("forall body must be copied");
                rigids.truncate(checkpoint);
                copied.push(target.intern(FlatTypeNode::Forall { variables, body }));
            }
        }
    }
    copied
        .pop()
        .ok_or_else(|| "sealed boundary copy produced no type".to_owned())
}

impl CheckedModuleCertificate {
    pub(crate) fn contains_generative_effect_identity(&self) -> bool {
        self.types.iter().any(|node| match node {
            FlatTypeNode::Effects(labels) | FlatTypeNode::OpenEffects { labels, .. } => labels
                .iter()
                .any(|label| label.starts_with("effect:") || label.starts_with("host:")),
            FlatTypeNode::Opaque(name) => name.starts_with("Effect:"),
            _ => false,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema != CHECKED_MODULE_CERTIFICATE_SCHEMA {
            return Err(format!(
                "checked-module certificate schema is {}, expected {}",
                self.schema, CHECKED_MODULE_CERTIFICATE_SCHEMA
            ));
        }
        validate_flat_type_reference_budget(
            "checked-module certificate",
            &self.types,
            interface_type_roots(
                self.result,
                self.effects,
                self.parameter,
                &self.expression_types,
                &self.closure_signatures,
            ),
        )?;
        validate_certificate_type(&self.types, self.result)?;
        validate_certificate_type(&self.types, self.effects)?;
        if let Some(parameter) = self.parameter {
            validate_certificate_type(&self.types, parameter)?;
        }
        let mut expressions = HashSet::new();
        for (expression, type_) in &self.expression_types {
            validate_certificate_type(&self.types, *type_)?;
            if !expressions.insert(*expression) {
                return Err(format!(
                    "checked-module certificate repeats expression type {}",
                    expression.0
                ));
            }
        }
        let mut closure_bodies = HashSet::new();
        for (body, signature) in &self.closure_signatures {
            validate_certificate_type(&self.types, *signature)?;
            if !closure_bodies.insert(*body) {
                return Err(format!(
                    "checked-module certificate repeats closure signature expression {}",
                    body.0
                ));
            }
        }
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
        let mut simplification_expressions = HashSet::new();
        for fact in &self.simplifications {
            if !simplification_expressions.insert(fact.expression()) {
                return Err(format!(
                    "checked-module certificate repeats simplification expression {}",
                    fact.expression().0
                ));
            }
        }
        let mut readability_facts = HashSet::new();
        for fact in &self.readability {
            if !readability_facts.insert((fact.kind(), fact.expression())) {
                return Err(format!(
                    "checked-module certificate repeats {:?} readability fact for expression {}",
                    fact.kind(),
                    fact.expression().0,
                ));
            }
        }
        Ok(())
    }
}

fn validate_certificate_type(types: &[FlatTypeNode], root: FlatTypeId) -> Result<(), String> {
    enum Frame {
        Type(FlatTypeId),
        LeaveScope(Vec<VariableId>),
    }

    let mut bound = HashSet::new();
    let mut stack = vec![Frame::Type(root)];
    let mut children = Vec::new();
    while let Some(frame) = stack.pop() {
        let type_ = match frame {
            Frame::Type(type_) => type_,
            Frame::LeaveScope(variables) => {
                for variable in variables {
                    bound.remove(&variable);
                }
                continue;
            }
        };
        let index = type_.0 as usize;
        let node = types
            .get(index)
            .ok_or_else(|| format!("checked-module certificate references missing type {index}"))?;
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
                if body.0 >= type_.0 {
                    return Err(format!(
                        "checked-module certificate type {} references non-prior type {}",
                        type_.0, body.0
                    ));
                }
                stack.push(Frame::LeaveScope(inserted));
                stack.push(Frame::Type(*body));
            }
            _ => {
                children.clear();
                append_flat_type_children(node, &mut children);
                for child in children.iter().rev() {
                    if child.0 >= type_.0 {
                        return Err(format!(
                            "checked-module certificate type {} references non-prior type {}",
                            type_.0, child.0
                        ));
                    }
                    stack.push(Frame::Type(*child));
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct CachedModuleAnalyses {
    ownership: Result<(), Diagnostic>,
    ownership_contracts: Vec<(ExpressionId, crate::ownership::OwnershipContract)>,
    ownership_facts: Vec<crate::ownership::OwnershipFact>,
    safety: Result<(), Diagnostic>,
}

#[derive(Clone, Default)]
struct SpecializationBinding {
    keys: BTreeMap<String, SpecializationKey>,
}

#[derive(Clone)]
struct SpecializationKey {
    reason: &'static str,
    call_sites: Vec<(String, Span)>,
}

#[derive(Clone)]
struct StableShadowCandidate {
    name: String,
    previous: Type,
    replacement: Type,
}

#[derive(Clone)]
struct DirectEffectCandidate {
    forced: bool,
    type_: Type,
}

#[derive(Clone)]
struct OpenUsageCandidate {
    effects: Type,
    used: Rc<RefCell<BTreeSet<String>>>,
    shadowed: BTreeSet<String>,
}

#[derive(Clone)]
struct ExpressionAnalysis {
    display: String,
    analysis_display: String,
    nullary_unit: bool,
    reported: bool,
}

type StructuralReadabilityCandidates =
    ModuleFacts<(ExpressionId, ReadabilityFactKind), Vec<Option<ReadabilityFact>>>;

const SPECIALIZATION_SOFT_LIMIT: usize = 2;
const SPECIALIZATION_HARD_LIMIT: usize = 256;

pub struct Checker {
    context: Rc<Context>,
    variables: RefCell<Vec<Variable>>,
    constraint_types: RefCell<ConstraintTypeArena>,
    settled_variables: RefCell<HashMap<(VariableId, bool), Type>>,
    residual_variables: RefCell<HashMap<VariableId, ResidualVariable>>,
    constraints: Cell<u64>,
    settle_visits: Cell<u64>,
    freshen_visits: Cell<u64>,
    boundary_materializations: Cell<u64>,
    capture_candidates: Cell<u64>,
    captures_bridged: Cell<u64>,
    interface_fields_demanded: Cell<u64>,
    solver_worklist_peak: Cell<u64>,
    module_work: RefCell<HashMap<String, CompilerWork>>,
    bound_insertions: RefCell<Vec<BoundInsertion>>,
    next_skolem: Rc<Cell<VariableId>>,
    next_representation_hole: Rc<Cell<VariableId>>,
    level: Cell<u32>,
    phase: Cell<Phase>,
    specialization_depth: Cell<u32>,
    active_closures: RefCell<Vec<(String, ExpressionId)>>,
    deferred_predicate_closures: RefCell<HashSet<(String, ExpressionId)>>,
    modules: RefCell<HashMap<String, Result<CheckedModule, Diagnostic>>>,
    active: RefCell<Vec<String>>,
    closure_types: RefCell<ModuleFacts<ExpressionId, Type>>,
    signed_closure_types: RefCell<ModuleFacts<ExpressionId, Type>>,
    expression_types: RefCell<ModuleFacts<ExpressionId, Type>>,
    analysis_expression_types: RefCell<ModuleFacts<ExpressionId, Type>>,
    expression_analyses: RefCell<ModuleFacts<ExpressionId, ExpressionAnalysis>>,
    declaration_tags: RefCell<ModuleFacts<Span, Vec<String>>>,
    ownership_facts: RefCell<HashMap<String, Vec<crate::ownership::OwnershipFact>>>,
    specializations: RefCell<ModuleFacts<ExpressionId, SpecializationBinding>>,
    simplifications: RefCell<ModuleFacts<ExpressionId, SimplificationFact>>,
    readability: RefCell<ModuleFacts<ExpressionId, Vec<ReadabilityFact>>>,
    conflicting_readability: RefCell<ModuleFacts<(ExpressionId, ReadabilityFactKind), ()>>,
    structural_readability_candidates: RefCell<StructuralReadabilityCandidates>,
    stable_shadow_candidates: RefCell<ModuleFacts<ExpressionId, Vec<StableShadowCandidate>>>,
    direct_effect_candidates: RefCell<ModuleFacts<ExpressionId, Vec<DirectEffectCandidate>>>,
    open_usage_candidates: RefCell<ModuleFacts<ExpressionId, Vec<OpenUsageCandidate>>>,
    recursive_closure_bodies: RefCell<ModuleFacts<ExpressionId, ()>>,
    empty_array_elements: RefCell<HashSet<VariableId>>,
    incomplete_evaluations: RefCell<HashSet<String>>,
    module_interfaces: Rc<RefCell<HashMap<String, CachedModuleInterface>>>,
    module_analyses: Rc<RefCell<HashMap<String, CachedModuleAnalyses>>>,
}

impl Checker {
    #[cfg(test)]
    pub(crate) fn solver_cardinality(&self) -> (usize, usize) {
        (
            self.variables.borrow().len(),
            self.constraint_types.borrow().nodes.len(),
        )
    }

    #[cfg(feature = "development-profile")]
    pub(crate) fn development_solver_cardinality(
        &self,
    ) -> crate::development::DevelopmentSolverCardinality {
        let constraint_types = self.constraint_types.borrow();
        crate::development::DevelopmentSolverCardinality {
            variables: self.variables.borrow().len(),
            constraint_type_nodes: constraint_types.nodes.len(),
            constraint_type_interned: constraint_types.interned.len(),
            settled_variables: self.settled_variables.borrow().len(),
            residual_variables: self.residual_variables.borrow().len(),
        }
    }

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
            settled_variables: RefCell::new(HashMap::new()),
            residual_variables: RefCell::new(HashMap::new()),
            constraints: Cell::new(0),
            settle_visits: Cell::new(0),
            freshen_visits: Cell::new(0),
            boundary_materializations: Cell::new(0),
            capture_candidates: Cell::new(0),
            captures_bridged: Cell::new(0),
            interface_fields_demanded: Cell::new(0),
            solver_worklist_peak: Cell::new(0),
            module_work: RefCell::new(HashMap::new()),
            bound_insertions: RefCell::new(Vec::new()),
            next_skolem: Rc::new(Cell::new(0x8000_0000)),
            next_representation_hole: Rc::new(Cell::new(u32::MAX)),
            level: Cell::new(0),
            phase: Cell::new(Phase::Runtime),
            specialization_depth: Cell::new(0),
            active_closures: RefCell::new(Vec::new()),
            deferred_predicate_closures: RefCell::new(HashSet::new()),
            modules: RefCell::new(HashMap::new()),
            active: RefCell::new(Vec::new()),
            closure_types: RefCell::new(ModuleFacts::default()),
            signed_closure_types: RefCell::new(ModuleFacts::default()),
            expression_types: RefCell::new(ModuleFacts::default()),
            analysis_expression_types: RefCell::new(ModuleFacts::default()),
            expression_analyses: RefCell::new(ModuleFacts::default()),
            declaration_tags: RefCell::new(ModuleFacts::default()),
            ownership_facts: RefCell::new(HashMap::new()),
            specializations: RefCell::new(ModuleFacts::default()),
            simplifications: RefCell::new(ModuleFacts::default()),
            readability: RefCell::new(ModuleFacts::default()),
            conflicting_readability: RefCell::new(ModuleFacts::default()),
            structural_readability_candidates: RefCell::new(ModuleFacts::default()),
            stable_shadow_candidates: RefCell::new(ModuleFacts::default()),
            direct_effect_candidates: RefCell::new(ModuleFacts::default()),
            open_usage_candidates: RefCell::new(ModuleFacts::default()),
            recursive_closure_bodies: RefCell::new(ModuleFacts::default()),
            empty_array_elements: RefCell::new(HashSet::new()),
            incomplete_evaluations: RefCell::new(HashSet::new()),
            module_interfaces,
            module_analyses,
        }
    }

    pub(crate) fn snapshot_staging(
        &self,
        context: Rc<Context>,
        module_interfaces: Rc<RefCell<HashMap<String, CachedModuleInterface>>>,
        module_analyses: Rc<RefCell<HashMap<String, CachedModuleAnalyses>>>,
    ) -> Self {
        let checker = Self::with_caches(context, module_interfaces, module_analyses);
        checker.next_skolem.set(self.next_skolem.get());
        checker
            .next_representation_hole
            .set(self.next_representation_hole.get());
        checker
    }

    pub(crate) fn commit_staged_snapshot(
        &self,
        path: &str,
        interface: CachedModuleInterface,
        staged: &Self,
    ) {
        self.next_representation_hole
            .set(staged.next_representation_hole.get());
        let checked = self.inflate_interface(path, interface.clone());
        self.module_interfaces
            .borrow_mut()
            .insert(path.to_owned(), interface);
        let analyses = staged.module_analyses.borrow().get(path).cloned();
        self.module_analyses.borrow_mut().remove(path);
        if let Some(analyses) = analyses {
            self.module_analyses
                .borrow_mut()
                .insert(path.to_owned(), analyses);
        }
        self.modules
            .borrow_mut()
            .insert(path.to_owned(), Ok(checked));

        let analysis_expression_types = staged
            .analysis_expression_types
            .borrow()
            .module(path)
            .map(|facts| {
                facts
                    .iter()
                    .map(|(expression, type_)| {
                        (*expression, staged.residual_signature(type_.clone()))
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        self.analysis_expression_types
            .borrow_mut()
            .replace_module(path.to_owned(), analysis_expression_types);

        let expression_analyses = staged
            .expression_analyses
            .borrow()
            .module(path)
            .cloned()
            .unwrap_or_default();
        self.expression_analyses
            .borrow_mut()
            .replace_module(path.to_owned(), expression_analyses);

        let declaration_tags = staged
            .declaration_tags
            .borrow()
            .module(path)
            .cloned()
            .unwrap_or_default();
        self.declaration_tags
            .borrow_mut()
            .replace_module(path.to_owned(), declaration_tags);

        let ownership_facts = staged.ownership_facts.borrow().get(path).cloned();
        self.ownership_facts.borrow_mut().remove(path);
        if let Some(ownership_facts) = ownership_facts {
            self.ownership_facts
                .borrow_mut()
                .insert(path.to_owned(), ownership_facts);
        }

        let specializations = staged
            .specializations
            .borrow()
            .module(path)
            .cloned()
            .unwrap_or_default();
        self.specializations
            .borrow_mut()
            .replace_module(path.to_owned(), specializations);

        let work = staged.module_work.borrow().get(path).cloned();
        self.module_work.borrow_mut().remove(path);
        if let Some(work) = work {
            self.module_work.borrow_mut().insert(path.to_owned(), work);
        }
    }

    fn work_snapshot(&self) -> WorkSnapshot {
        let types = self.constraint_types.borrow();
        WorkSnapshot {
            type_nodes: types.nodes.len() as u64,
            type_interns: types.intern_attempts,
            constraints: self.constraints.get(),
            settle_visits: self.settle_visits.get(),
            freshen_visits: self.freshen_visits.get(),
            union_visits: UNION_VISITS.with(Cell::get),
            boundary_materializations: self.boundary_materializations.get(),
            capture_candidates: self.capture_candidates.get(),
            captures_bridged: self.captures_bridged.get(),
            interface_fields_demanded: self.interface_fields_demanded.get(),
        }
    }

    fn work_since(&self, before: WorkSnapshot) -> CompilerWork {
        let after = self.work_snapshot();
        CompilerWork {
            schema: 3,
            type_nodes: after.type_nodes - before.type_nodes,
            type_interns: after.type_interns - before.type_interns,
            constraints: after.constraints - before.constraints,
            settle_visits: after.settle_visits - before.settle_visits,
            freshen_visits: after.freshen_visits - before.freshen_visits,
            union_visits: after.union_visits - before.union_visits,
            boundary_materializations: after.boundary_materializations
                - before.boundary_materializations,
            capture_candidates: after.capture_candidates - before.capture_candidates,
            captures_bridged: after.captures_bridged - before.captures_bridged,
            interface_fields_demanded: after.interface_fields_demanded
                - before.interface_fields_demanded,
            solver_worklist_peak: self.solver_worklist_peak.get(),
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
        let root_request = self.active.borrow().is_empty();
        if root_request {
            self.solver_worklist_peak.set(0);
        }
        let work_before = root_request.then(|| self.work_snapshot());
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
            && let Ok(Some(interface)) = CachedModuleInterface::from_checked(checked)
        {
            self.module_interfaces
                .borrow_mut()
                .insert(path.to_owned(), interface);
        }
        if let Some(work_before) = work_before {
            let work = self.work_since(work_before);
            self.module_work.borrow_mut().insert(path.to_owned(), work);
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
        if let Some(interface) = self.module_interfaces.borrow().get(path) {
            let certificate = interface.certificate();
            certificate.validate()?;
            return Ok(certificate);
        }
        let interface = match CachedModuleInterface::from_checked(&checked) {
            Ok(Some(interface)) => interface,
            Err(error) => {
                return Err(format!("cannot certify module {path}: {error}"));
            }
            Ok(None) => {
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
                        && flatten_interface_type(
                            type_,
                            &mut HashSet::new(),
                            &mut FlatTypeBuilder::default(),
                        )
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
        let certificate = interface.certificate();
        certificate.validate()?;
        Ok(certificate)
    }

    pub(crate) fn install_interface(
        &self,
        path: &str,
        interface: CachedModuleInterface,
    ) -> Result<(), String> {
        self.validate_interface(path, &interface)?;
        self.module_interfaces
            .borrow_mut()
            .insert(path.to_owned(), interface);
        self.modules.borrow_mut().remove(path);
        Ok(())
    }

    pub(crate) fn validate_interface(
        &self,
        path: &str,
        interface: &CachedModuleInterface,
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
        for (expression, _) in &interface.expression_types {
            if expression.0 as usize >= module.arena.expressions.len() {
                return Err(format!(
                    "checked-module certificate references missing expression {}",
                    expression.0
                ));
            }
        }
        for (body, _) in &interface.closure_signatures {
            if body.0 as usize >= module.arena.expressions.len() {
                return Err(format!(
                    "checked-module certificate references missing closure expression {}",
                    body.0
                ));
            }
        }
        for fact in &interface.simplifications {
            for expression in fact.referenced_expressions() {
                if expression.0 as usize >= module.arena.expressions.len() {
                    return Err(format!(
                        "checked-module certificate simplification references missing expression {}",
                        expression.0
                    ));
                }
            }
        }
        for fact in &interface.readability {
            for expression in fact.referenced_expressions() {
                if expression.0 as usize >= module.arena.expressions.len() {
                    return Err(format!(
                        "checked-module certificate readability fact references missing expression {}",
                        expression.0
                    ));
                }
            }
        }
        crate::ownership::validate_contracts(&module, &interface.ownership_contracts)?;
        Ok(())
    }

    pub fn begin_request(&self) {
        self.module_work.borrow_mut().clear();
        self.modules.borrow_mut().clear();
        self.closure_types.borrow_mut().clear();
        self.signed_closure_types.borrow_mut().clear();
        self.expression_types.borrow_mut().clear();
        self.analysis_expression_types.borrow_mut().clear();
        self.structural_readability_candidates.borrow_mut().clear();
        self.stable_shadow_candidates.borrow_mut().clear();
        self.direct_effect_candidates.borrow_mut().clear();
        self.open_usage_candidates.borrow_mut().clear();
        self.recursive_closure_bodies.borrow_mut().clear();
        self.variables.borrow_mut().clear();
        self.constraint_types.borrow_mut().reset();
        self.settled_variables.borrow_mut().clear();
        self.residual_variables.borrow_mut().clear();
        self.bound_insertions.borrow_mut().clear();
        self.empty_array_elements.borrow_mut().clear();
        self.active_closures.borrow_mut().clear();
        self.deferred_predicate_closures.borrow_mut().clear();
    }

    pub fn sealed_boundary_bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        self.module_interfaces
            .borrow()
            .get(path)
            .ok_or_else(|| format!("module {path} has no closed checked interface"))?
            .sealed_boundary_bytes()
    }

    pub fn invalidate(&self, paths: &HashSet<String>) {
        self.modules
            .borrow_mut()
            .retain(|path, _| !paths.contains(path));
        self.closure_types.borrow_mut().remove_modules(paths);
        self.signed_closure_types.borrow_mut().remove_modules(paths);
        self.expression_types.borrow_mut().remove_modules(paths);
        self.analysis_expression_types
            .borrow_mut()
            .remove_modules(paths);
        self.expression_analyses.borrow_mut().remove_modules(paths);
        self.declaration_tags.borrow_mut().remove_modules(paths);
        self.ownership_facts
            .borrow_mut()
            .retain(|path, _| !paths.contains(path));
        self.specializations
            .borrow_mut()
            .retain_modules(|path, bindings| {
                if paths.contains(path) {
                    return false;
                }
                bindings.retain(|_, binding| {
                    binding.keys.retain(|_, key| {
                        key.call_sites
                            .retain(|(call_path, _)| !paths.contains(call_path));
                        !key.call_sites.is_empty()
                    });
                    !binding.keys.is_empty()
                });
                !bindings.is_empty()
            });
        self.readability.borrow_mut().remove_modules(paths);
        self.conflicting_readability
            .borrow_mut()
            .remove_modules(paths);
        self.structural_readability_candidates
            .borrow_mut()
            .remove_modules(paths);
        self.stable_shadow_candidates
            .borrow_mut()
            .remove_modules(paths);
        self.direct_effect_candidates
            .borrow_mut()
            .remove_modules(paths);
        self.open_usage_candidates
            .borrow_mut()
            .remove_modules(paths);
        self.module_work
            .borrow_mut()
            .retain(|path, _| !paths.contains(path));
        self.recursive_closure_bodies
            .borrow_mut()
            .remove_modules(paths);
        self.incomplete_evaluations
            .borrow_mut()
            .retain(|path| !paths.contains(path));
        self.context
            .ownership_contracts
            .borrow_mut()
            .remove_modules(paths);
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
            Err(diagnostic) => diagnostic.failure_json("type checking"),
        }
    }

    pub fn analysis_json(&self, path: &str) -> serde_json::Value {
        let checked = match self.check(path) {
            Ok(checked) => checked,
            Err(diagnostic) => return diagnostic.failure_json("analysis"),
        };
        let module = self
            .context
            .modules
            .borrow()
            .get(path)
            .expect("checked module must remain loaded")
            .module
            .clone();
        let mut types = self
            .expression_analyses
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .filter(|(_, analysis)| analysis.reported)
            .map(|(expression, analysis)| {
                (
                    *expression,
                    serde_json::json!({
                        "span": module.arena.expression_span(*expression),
                        "type": analysis.analysis_display,
                    }),
                )
            })
            .collect::<Vec<_>>();
        types.sort_by_key(|(expression, fact)| {
            let span = &fact["span"];
            (
                span["start"].as_u64().unwrap_or_default(),
                span["end"].as_u64().unwrap_or_default(),
                expression.0,
            )
        });
        let types = types.into_iter().map(|(_, fact)| fact).collect::<Vec<_>>();
        let mut tags = self
            .declaration_tags
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(span, names)| {
                (
                    *span,
                    names.clone(),
                    serde_json::json!({ "span": span, "names": names }),
                )
            })
            .collect::<Vec<_>>();
        tags.sort_by_key(|(span, names, _)| (span.start, span.end, names.clone()));
        let tags = tags
            .into_iter()
            .map(|(_, _, fact)| fact)
            .collect::<Vec<_>>();
        let mut ownership = self
            .ownership_facts
            .borrow()
            .iter()
            .flat_map(|(module, facts)| {
                facts.iter().map(move |fact| {
                    serde_json::json!({
                        "path": module,
                        "name": &fact.name,
                        "span": fact.span,
                        "last_use": fact.last_use,
                        "spent": fact.spent,
                    })
                })
            })
            .collect::<Vec<_>>();
        ownership.sort_by_key(|fact| {
            (
                fact["path"].as_str().unwrap_or_default().to_owned(),
                fact["span"]["start"].as_u64().unwrap_or_default(),
                fact["span"]["end"].as_u64().unwrap_or_default(),
                fact["name"].as_str().unwrap_or_default().to_owned(),
            )
        });
        let mut specializations = self
            .specializations
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(body, binding)| {
                let (span, name) = specialization_binding(&module, *body);
                let keys = binding
                    .keys
                    .iter()
                    .map(|(representation, key)| {
                        let mut call_sites = key.call_sites.clone();
                        call_sites.sort_by_key(|(path, span)| (path.clone(), span.start, span.end));
                        let call_sites = call_sites
                            .into_iter()
                            .map(|(path, span)| {
                                serde_json::json!({
                                    "path": path,
                                    "span": span,
                                })
                            })
                            .collect::<Vec<_>>();
                        serde_json::json!({
                            "representation": representation,
                            "reason": key.reason,
                            "callSites": call_sites,
                            "runtimeHirNodes": 0,
                            "wasmFunctionBytes": 0,
                        })
                    })
                    .collect::<Vec<_>>();
                (
                    span,
                    *body,
                    serde_json::json!({
                        "binding": {
                            "path": path,
                            "name": name,
                            "span": span,
                        },
                        "specializationCount": keys.len(),
                        "softLimit": SPECIALIZATION_SOFT_LIMIT,
                        "hardLimit": SPECIALIZATION_HARD_LIMIT,
                        "keys": keys,
                    }),
                )
            })
            .collect::<Vec<_>>();
        specializations.sort_by_key(|(span, body, _)| (span.start, span.end, body.0));
        let specializations = specializations
            .into_iter()
            .map(|(_, _, fact)| fact)
            .collect::<Vec<_>>();
        let simplifications = checked
            .simplifications
            .iter()
            .map(|fact| match fact {
                SimplificationFact::IntegerEquality {
                    expression,
                    subject,
                    pattern,
                } => {
                    let pattern = match pattern {
                        IntegerEqualityPattern::Literal {
                            expression: pattern_expression,
                        } => serde_json::json!({
                            "kind": "integer-literal",
                            "span": module.arena.expression_span(*pattern_expression),
                        }),
                        IntegerEqualityPattern::Pin { name } => serde_json::json!({
                            "kind": "integer-pin",
                            "name": name,
                        }),
                    };
                    serde_json::json!({
                        "kind": "integer-equality",
                        "span": module.arena.expression_span(*expression),
                        "subject": module.arena.expression_span(*subject),
                        "pattern": pattern,
                    })
                }
                SimplificationFact::ShortCircuitAnd {
                    expression,
                    left,
                    right,
                } => serde_json::json!({
                    "kind": "short-circuit-and",
                    "span": module.arena.expression_span(*expression),
                    "left": module.arena.expression_span(*left),
                    "right": module.arena.expression_span(*right),
                }),
            })
            .collect::<Vec<_>>();
        let readability = checked
            .readability
            .iter()
            .map(|fact| match fact {
                ReadabilityFact::DirectEffectComputation { expression } => serde_json::json!({
                    "kind": "direct-effect-computation",
                    "span": module.arena.expression_span(*expression),
                }),
                ReadabilityFact::EmptyArray { expression } => serde_json::json!({
                    "kind": "empty-array",
                    "span": module.arena.expression_span(*expression),
                }),
                ReadabilityFact::StableShadow { expression, name } => serde_json::json!({
                    "kind": "stable-shadow",
                    "span": module.arena.expression_span(*expression),
                    "name": name,
                }),
                ReadabilityFact::RecordReconstruction {
                    expression,
                    source,
                    retained,
                } => serde_json::json!({
                    "kind": "record-reconstruction",
                    "span": module.arena.expression_span(*expression),
                    "source": module.arena.expression_span(*source),
                    "retained": retained,
                }),
                ReadabilityFact::OpenUsage {
                    expression,
                    used,
                    shadowed,
                } => serde_json::json!({
                    "kind": "open-usage",
                    "span": module.arena.expression_span(*expression),
                    "used": used,
                    "shadowed": shadowed,
                }),
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "ok": true,
            "type": self.show(&checked.result),
            "effects": show_effects(&self.settle(checked.effects, true)),
            "types": types,
            "tags": tags,
            "ownership": ownership,
            "specializations": specializations,
            "simplifications": simplifications,
            "readability": readability,
            "work": self.module_work.borrow().get(path),
        })
    }

    pub(crate) fn effects_are_empty(&self, effects: &Type) -> bool {
        empty_effects(&self.settle(effects.clone(), true))
    }

    fn record_readability(&self, path: &str, fact: ReadabilityFact) {
        let expression = fact.expression();
        let kind = fact.kind();
        let key = (expression, kind);
        if self
            .conflicting_readability
            .borrow()
            .contains_key(path, &key)
        {
            return;
        }
        let mut readability = self.readability.borrow_mut();
        let facts = readability.entry(path.to_owned(), expression).or_default();
        let existing = facts.iter().position(|candidate| candidate.kind() == kind);
        let Some(existing) = existing else {
            facts.push(fact);
            return;
        };
        if facts[existing] != fact {
            facts.remove(existing);
            self.conflicting_readability
                .borrow_mut()
                .insert(path.to_owned(), key, ());
        }
    }

    fn record_structural_readability_candidate(
        &self,
        path: &str,
        expression: ExpressionId,
        kind: ReadabilityFactKind,
        candidate: Option<ReadabilityFact>,
    ) {
        if let Some(fact) = &candidate {
            assert_eq!(fact.expression(), expression);
            assert_eq!(fact.kind(), kind);
        }
        self.structural_readability_candidates
            .borrow_mut()
            .entry(path.to_owned(), (expression, kind))
            .or_default()
            .push(candidate);
    }

    fn finalize_readability(&self, path: &str) {
        let structural_candidates = self
            .structural_readability_candidates
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(_, candidates)| candidates.clone())
            .collect::<Vec<_>>();
        for candidates in structural_candidates {
            let Some(Some(first)) = candidates.first() else {
                continue;
            };
            if candidates
                .iter()
                .all(|candidate| candidate.as_ref() == Some(first))
            {
                self.record_readability(path, first.clone());
            }
        }

        let direct_candidates = self
            .direct_effect_candidates
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(expression, candidates)| (*expression, candidates.clone()))
            .collect::<Vec<_>>();
        for (expression, candidates) in direct_candidates {
            let proved = !candidates.is_empty()
                && candidates.iter().all(|candidate| {
                    let type_ = self.settle(candidate.type_.clone(), true);
                    !candidate.forced
                        && closed_checked_type(&type_, &mut HashSet::new())
                        && self.effect_value_signature(&type_).is_none()
                });
            if proved {
                self.record_readability(
                    path,
                    ReadabilityFact::DirectEffectComputation { expression },
                );
            }
        }

        let stable_candidates = self
            .stable_shadow_candidates
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(expression, candidates)| (*expression, candidates.clone()))
            .collect::<Vec<_>>();
        for (expression, candidates) in stable_candidates {
            let Some(first) = candidates.first() else {
                continue;
            };
            if candidates
                .iter()
                .any(|candidate| candidate.name != first.name)
            {
                continue;
            }
            let proved = candidates.iter().all(|candidate| {
                let previous = stable_rebinding_type(self.settle(candidate.previous.clone(), true));
                let replacement =
                    stable_rebinding_type(self.settle(candidate.replacement.clone(), true));
                closed_checked_type(&previous, &mut HashSet::new())
                    && closed_checked_type(&replacement, &mut HashSet::new())
                    && same_type(&previous, &replacement)
            });
            if proved {
                self.record_readability(
                    path,
                    ReadabilityFact::StableShadow {
                        expression,
                        name: first.name.clone(),
                    },
                );
            }
        }

        let open_candidates = self
            .open_usage_candidates
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(expression, candidates)| (*expression, candidates.clone()))
            .collect::<Vec<_>>();
        for (expression, candidates) in open_candidates {
            if candidates.is_empty()
                || !candidates
                    .iter()
                    .all(|candidate| self.effects_are_empty(&candidate.effects))
            {
                continue;
            }
            let payloads = candidates
                .iter()
                .map(|candidate| {
                    let used = candidate.used.borrow().clone();
                    let shadowed = candidate
                        .shadowed
                        .intersection(&used)
                        .cloned()
                        .collect::<Vec<_>>();
                    (used.into_iter().collect::<Vec<_>>(), shadowed)
                })
                .collect::<Vec<_>>();
            let Some(first) = payloads.first() else {
                continue;
            };
            if payloads.iter().any(|candidate| candidate != first) {
                continue;
            }
            let (used, shadowed) = first.clone();
            self.record_readability(
                path,
                ReadabilityFact::OpenUsage {
                    expression,
                    used,
                    shadowed,
                },
            );
        }
    }

    fn deferred_call(&self, function: &Type) -> bool {
        matches!(
            self.settle(function.clone(), true),
            Type::Function { deferred: true, .. }
        )
    }

    pub(crate) fn expression_type_string(
        &self,
        path: &str,
        expression: ExpressionId,
    ) -> Option<String> {
        if let Some(analysis) = self
            .expression_analyses
            .borrow()
            .get(path, &expression)
            .cloned()
        {
            return Some(analysis.display);
        }
        self.expression_type(path, expression)
            .map(|type_| self.show(&type_))
    }

    pub(crate) fn expression_is_nullary_unit(&self, path: &str, expression: ExpressionId) -> bool {
        if let Some(analysis) = self.expression_analyses.borrow().get(path, &expression) {
            return analysis.nullary_unit;
        }
        let Some(type_) = self.expression_type(path, expression) else {
            return false;
        };
        nullary_unit_type(&type_)
    }

    fn expression_type(&self, path: &str, expression: ExpressionId) -> Option<Type> {
        let direct = self
            .analysis_expression_types
            .borrow()
            .get(path, &expression)
            .cloned();
        let type_ = if direct.is_some() {
            direct
        } else {
            let module = self.context.modules.borrow().get(path)?.module.clone();
            let body = match module.arena.expressions.get(expression.0 as usize)? {
                Expression::Lambda { body, .. } => Some(*body),
                Expression::Rec { lambda, .. } => {
                    match module.arena.expressions.get(lambda.0 as usize)? {
                        Expression::Lambda { body, .. } => Some(*body),
                        _ => None,
                    }
                }
                _ => None,
            }?;
            self.closure_types.borrow().get(path, &body).cloned()
        }?;
        Some(self.settle(type_, true))
    }

    pub(crate) fn declaration_tag_names(&self, path: &str, span: Span) -> Vec<String> {
        self.declaration_tags
            .borrow()
            .get(path, &span)
            .cloned()
            .unwrap_or_default()
    }

    fn check_uncached(&self, path: &str) -> Result<CheckedModule, Diagnostic> {
        self.simplifications.borrow_mut().remove_module(path);
        self.readability.borrow_mut().remove_module(path);
        self.conflicting_readability
            .borrow_mut()
            .remove_module(path);
        self.structural_readability_candidates
            .borrow_mut()
            .remove_module(path);
        self.stable_shadow_candidates
            .borrow_mut()
            .remove_module(path);
        self.direct_effect_candidates
            .borrow_mut()
            .remove_module(path);
        self.open_usage_candidates.borrow_mut().remove_module(path);
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
        validate_module_signature_headers(&loaded.module)?;
        let mut dependency_types = BTreeMap::new();
        for (specifier, dependency) in &loaded.imports {
            let checked = self.check(dependency)?;
            dependency_types.insert(
                specifier.clone(),
                Type::Function {
                    deferred: false,
                    parameter: Rc::new(checked.parameter.unwrap_or(Type::Unit)),
                    effects: Rc::new(checked.effects),
                    result: Rc::new(checked.result),
                },
            );
        }
        let mut types = TypeEnvironment::default();
        let mut values = child_env(None);
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
        let mut recursive_bindings = None;
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
                *declaration_id,
                declaration,
                &mut types,
                &mut values,
                &mut recursive_bindings,
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
        self.ownership_facts
            .borrow_mut()
            .insert(path.to_owned(), analyses.ownership_facts.clone());
        analyses.ownership?;
        analyses.safety?;
        let synthetic_recursive_bodies = loaded
            .module
            .arena
            .declarations
            .iter()
            .filter_map(|declaration| {
                let Declaration::Binding { pattern, value, .. } = declaration else {
                    return None;
                };
                let Pattern::Name { name, .. } = &loaded.module.arena.patterns[pattern.0 as usize]
                else {
                    return None;
                };
                if name != "go$" {
                    return None;
                }
                let Expression::Rec { lambda, .. } =
                    loaded.module.arena.expressions[value.0 as usize]
                else {
                    return None;
                };
                let Expression::Lambda { body, .. } =
                    loaded.module.arena.expressions[lambda.0 as usize]
                else {
                    return None;
                };
                Some(body)
            })
            .collect::<HashSet<_>>();
        let mut analyzed_closure_signatures = self
            .closure_types_for_path(path)
            .into_iter()
            .map(|(body, type_)| {
                let (mut signature, type_recursive) =
                    self.residual_signature_analysis(type_.clone());
                let recursive = type_recursive
                    || self
                        .recursive_closure_bodies
                        .borrow()
                        .contains_key(path, &body);
                if synthetic_recursive_bodies.contains(&body) {
                    signature = stable_loop_signature(signature);
                }
                (body, signature, recursive)
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
        let mut expression_types = self
            .expression_types
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(expression, type_)| (*expression, self.residual_signature(type_.clone())))
            .collect::<Vec<_>>();
        expression_types.sort_by_key(|(expression, _)| expression.0);
        let reified_expression_types = expression_types
            .iter()
            .filter_map(|(expression, type_)| {
                self.reify_runtime_type(type_)
                    .map(|type_| (*expression, type_))
            })
            .collect::<HashMap<_, _>>();
        let reified_closure_signatures = closure_signatures
            .iter()
            .filter_map(|(body, type_)| {
                self.reify_runtime_type(type_)
                    .map(|signature| (*body, signature))
            })
            .collect::<HashMap<_, _>>();
        self.context
            .expression_types
            .borrow_mut()
            .replace_module(path.to_owned(), reified_expression_types);
        self.context
            .closure_signatures
            .borrow_mut()
            .replace_module(path.to_owned(), reified_closure_signatures);
        let signature_types = Rc::new(
            closure_signatures
                .iter()
                .cloned()
                .collect::<HashMap<_, _>>(),
        );
        let context = Rc::downgrade(&self.context);
        let next_representation_hole = self.next_representation_hole.clone();
        let resolver: crate::eval::RuntimeTypeResolver = Rc::new(move |body| {
            let signature = signature_types.get(&body)?;
            let context = context.upgrade()?;
            let mut next_hole = next_representation_hole.get();
            let signature = reify_type_with_holes(&context, signature, &mut next_hole);
            next_representation_hole.set(next_hole);
            signature
        });
        self.context
            .closure_signature_resolvers
            .borrow_mut()
            .insert(path.to_owned(), resolver);
        self.context.recursive_closures.borrow_mut().replace_module(
            path.to_owned(),
            recursive_closures.iter().map(|body| (*body, ())).collect(),
        );
        self.context
            .ownership_contracts
            .borrow_mut()
            .replace_module(
                path.to_owned(),
                analyses
                    .ownership_contracts
                    .iter()
                    .map(|(body, contract)| (*body, contract.clone()))
                    .collect(),
            );
        self.finalize_readability(path);
        let analysis_expression_types = self
            .analysis_expression_types
            .borrow()
            .module(path)
            .cloned()
            .unwrap_or_default();
        let mut expression_analyses = analysis_expression_types
            .iter()
            .map(|(expression, type_)| {
                let settled = self.settle(type_.clone(), true);
                (
                    *expression,
                    ExpressionAnalysis {
                        display: self.show(&settled),
                        analysis_display: self.show_analysis(type_),
                        nullary_unit: nullary_unit_type(&settled),
                        reported: true,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        for (index, expression) in loaded.module.arena.expressions.iter().enumerate() {
            if !matches!(
                expression,
                Expression::Lambda { .. } | Expression::Rec { .. }
            ) {
                continue;
            }
            let expression = ExpressionId(index as u32);
            if expression_analyses.contains_key(&expression) {
                continue;
            }
            let Some(type_) = self.expression_type(path, expression) else {
                continue;
            };
            expression_analyses.insert(
                expression,
                ExpressionAnalysis {
                    display: self.show(&type_),
                    analysis_display: self.show_analysis(&type_),
                    nullary_unit: nullary_unit_type(&type_),
                    reported: false,
                },
            );
        }
        self.expression_analyses
            .borrow_mut()
            .replace_module(path.to_owned(), expression_analyses);
        let mut simplifications = self
            .simplifications
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(expression, fact)| (*expression, fact.clone()))
            .collect::<Vec<_>>();
        simplifications.sort_by_key(|(expression, _)| expression.0);
        let mut readability = self
            .readability
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .flat_map(|(expression, facts)| {
                facts
                    .iter()
                    .cloned()
                    .map(|fact| (*expression, fact))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        readability.sort_by_key(|(expression, fact)| {
            let kind = match fact {
                ReadabilityFact::DirectEffectComputation { .. } => 0,
                ReadabilityFact::EmptyArray { .. } => 1,
                ReadabilityFact::StableShadow { .. } => 2,
                ReadabilityFact::RecordReconstruction { .. } => 3,
                ReadabilityFact::OpenUsage { .. } => 4,
            };
            (expression.0, kind)
        });
        let checked = CheckedModule {
            result: self.settle(inferred.type_, true),
            effects,
            parameter: parameter.map(|parameter| self.settle(parameter, false)),
            evaluated: (!self.incomplete_evaluations.borrow().contains(path)).then_some(values),
            expression_types,
            closure_signatures,
            recursive_closures,
            ownership_contracts: analyses.ownership_contracts,
            simplifications: simplifications.into_iter().map(|(_, fact)| fact).collect(),
            readability: readability.into_iter().map(|(_, fact)| fact).collect(),
        };
        self.cache_module_result(path, &loaded.module, &checked);
        Ok(checked)
    }

    fn closure_types_for_path(&self, path: &str) -> HashMap<ExpressionId, Type> {
        let mut types = self
            .closure_types
            .borrow()
            .module(path)
            .cloned()
            .unwrap_or_default();
        if let Some(signed) = self.signed_closure_types.borrow().module(path) {
            types.extend(signed.iter().map(|(body, type_)| (*body, type_.clone())));
        }
        types
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
        let mut closure_types = self
            .closure_types
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .map(|(body, type_)| (*body, self.settle(type_.clone(), true)))
            .collect::<HashMap<_, _>>();
        closure_types.extend(
            self.signed_closure_types
                .borrow()
                .module(path)
                .into_iter()
                .flatten()
                .map(|(body, type_)| (*body, type_.clone())),
        );
        let expression_types = self
            .analysis_expression_types
            .borrow()
            .module(path)
            .into_iter()
            .flatten()
            .filter(|(_, type_)| ownership_uses_expression_type(type_))
            .map(|(expression, type_)| (*expression, self.settle(type_.clone(), true)))
            .collect::<HashMap<_, _>>();
        let ownership = crate::ownership::check(
            path,
            module,
            &self.context,
            values,
            &closure_types,
            &expression_types,
        );
        let analyses = CachedModuleAnalyses {
            ownership: ownership.diagnostics.into_iter().next().map_or(Ok(()), Err),
            ownership_contracts: ownership.contracts,
            ownership_facts: ownership.facts,
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
            let reusable = !type_exposes_generative_effect(&checked.result)
                && reusable_across_module_instances(&value);
            self.context
                .module_results
                .borrow_mut()
                .insert(path.to_owned(), value);
            if reusable {
                self.context
                    .reusable_module_results
                    .borrow_mut()
                    .insert(path.to_owned());
            }
        }
    }

    fn inflate_interface(&self, path: &str, cached: CachedModuleInterface) -> CheckedModule {
        cached
            .validate_type_budget()
            .expect("cached module interface must pass artifact admission before inflation");
        let mut rigids = HashMap::new();
        if self.expression_analyses.borrow().module(path).is_none() {
            let expression_analyses = cached
                .expression_types
                .iter()
                .map(|(expression, type_)| {
                    let mut expression_rigids = HashMap::new();
                    let type_ = Self::inflate_cached_type(
                        &cached.types,
                        *type_,
                        &mut expression_rigids,
                        &self.next_skolem,
                    );
                    (
                        *expression,
                        ExpressionAnalysis {
                            display: self.show(&type_),
                            analysis_display: self.show_analysis(&type_),
                            nullary_unit: nullary_unit_type(&type_),
                            reported: true,
                        },
                    )
                })
                .collect::<HashMap<_, _>>();
            self.expression_analyses
                .borrow_mut()
                .replace_module(path.to_owned(), expression_analyses);
        }
        let expression_type_ids = cached
            .expression_types
            .iter()
            .copied()
            .collect::<HashMap<_, _>>();
        let expression_types = Rc::new(expression_type_ids);
        let expression_type_arena = cached.types.clone();
        let next_skolem = self.next_skolem.clone();
        let next_representation_hole = self.next_representation_hole.clone();
        let context = Rc::downgrade(&self.context);
        let resolver: crate::eval::RuntimeTypeResolver = Rc::new(move |expression| {
            let type_ = *expression_types.get(&expression)?;
            let mut rigids = HashMap::new();
            let type_ =
                Self::inflate_cached_type(&expression_type_arena, type_, &mut rigids, &next_skolem);
            let context = context.upgrade()?;
            let mut next_hole = next_representation_hole.get();
            let value = reify_type_with_holes(&context, &type_, &mut next_hole);
            next_representation_hole.set(next_hole);
            value
        });
        self.context
            .expression_type_resolvers
            .borrow_mut()
            .insert(path.to_owned(), resolver);
        let closure_signature_ids = cached
            .closure_signatures
            .iter()
            .copied()
            .collect::<HashMap<_, _>>();
        let closure_signatures = Rc::new(closure_signature_ids);
        let closure_signature_arena = cached.types.clone();
        let next_skolem = self.next_skolem.clone();
        let next_representation_hole = self.next_representation_hole.clone();
        let context = Rc::downgrade(&self.context);
        let resolver: crate::eval::RuntimeTypeResolver = Rc::new(move |body| {
            let signature = *closure_signatures.get(&body)?;
            let mut rigids = HashMap::new();
            let signature = Self::inflate_cached_type(
                &closure_signature_arena,
                signature,
                &mut rigids,
                &next_skolem,
            );
            let context = context.upgrade()?;
            let mut next_hole = next_representation_hole.get();
            let value = reify_type_with_holes(&context, &signature, &mut next_hole);
            next_representation_hole.set(next_hole);
            value
        });
        self.context
            .closure_signature_resolvers
            .borrow_mut()
            .insert(path.to_owned(), resolver);
        self.context.recursive_closures.borrow_mut().replace_module(
            path.to_owned(),
            cached
                .recursive_closures
                .iter()
                .map(|body| (*body, ()))
                .collect(),
        );
        self.context
            .ownership_contracts
            .borrow_mut()
            .replace_module(
                path.to_owned(),
                cached
                    .ownership_contracts
                    .iter()
                    .map(|(body, contract)| (*body, contract.clone()))
                    .collect(),
            );
        CheckedModule {
            result: self.inflate_interface_type(&cached.types, cached.result, &mut rigids),
            effects: self.inflate_interface_type(&cached.types, cached.effects, &mut rigids),
            parameter: cached.parameter.map(|parameter| {
                self.inflate_interface_type(&cached.types, parameter, &mut rigids)
            }),
            evaluated: cached.evaluated,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: cached.recursive_closures,
            ownership_contracts: cached.ownership_contracts,
            simplifications: cached.simplifications,
            readability: cached.readability,
        }
    }

    fn inflate_interface_type(
        &self,
        arena: &FlatTypeArena,
        type_: FlatTypeId,
        rigids: &mut HashMap<VariableId, VariableId>,
    ) -> Type {
        Self::inflate_cached_type(arena, type_, rigids, &self.next_skolem)
    }

    fn inflate_cached_type(
        arena: &FlatTypeArena,
        type_: FlatTypeId,
        rigids: &mut HashMap<VariableId, VariableId>,
        next_skolem: &Cell<VariableId>,
    ) -> Type {
        enum Frame {
            Inflate(FlatTypeId),
            Assemble(FlatTypeId, usize),
            AssembleForall {
                variables: Vec<VariableId>,
                previous: Vec<(VariableId, Option<VariableId>)>,
            },
        }

        let mut stack = vec![Frame::Inflate(type_)];
        let mut inflated = Vec::new();
        let mut children = Vec::new();
        while let Some(frame) = stack.pop() {
            match frame {
                Frame::Inflate(type_) => match arena.node(type_) {
                    FlatTypeNode::Rigid(id) => {
                        inflated.push(Type::Rigid(*rigids.get(id).unwrap_or(id)));
                    }
                    FlatTypeNode::Forall { variables, body } => {
                        let mut fresh_variables = Vec::with_capacity(variables.len());
                        let mut previous = Vec::with_capacity(variables.len());
                        for variable in variables {
                            let fresh = next_skolem.get();
                            next_skolem.set(fresh + 1);
                            previous.push((*variable, rigids.insert(*variable, fresh)));
                            fresh_variables.push(fresh);
                        }
                        stack.push(Frame::AssembleForall {
                            variables: fresh_variables,
                            previous,
                        });
                        stack.push(Frame::Inflate(*body));
                    }
                    FlatTypeNode::Range { domain, low, high } => {
                        inflated.push(Type::Range {
                            domain: *domain,
                            low: low.clone(),
                            high: high.clone(),
                        });
                    }
                    FlatTypeNode::Unit => inflated.push(Type::Unit),
                    FlatTypeNode::Effects(labels) => {
                        inflated.push(Type::Effects(labels.clone()));
                    }
                    FlatTypeNode::Opaque(name) => inflated.push(Type::Opaque(name.clone())),
                    FlatTypeNode::Top => inflated.push(Type::Top),
                    FlatTypeNode::Bottom => inflated.push(Type::Bottom),
                    node => {
                        children.clear();
                        append_flat_type_children(node, &mut children);
                        stack.push(Frame::Assemble(type_, children.len()));
                        for child in children.iter().rev() {
                            stack.push(Frame::Inflate(*child));
                        }
                    }
                },
                Frame::Assemble(type_, child_count) => {
                    let first_child = inflated
                        .len()
                        .checked_sub(child_count)
                        .expect("flat type assembly must receive every child");
                    let mut children = inflated.split_off(first_child).into_iter();
                    let type_ = match arena.node(type_) {
                        FlatTypeNode::Function { deferred, .. } => Type::Function {
                            deferred: *deferred,
                            parameter: Rc::new(children.next().expect("function parameter")),
                            effects: Rc::new(children.next().expect("function effects")),
                            result: Rc::new(children.next().expect("function result")),
                        },
                        FlatTypeNode::Record(fields) => Type::Record(
                            fields
                                .iter()
                                .zip(children)
                                .map(|((name, _), type_)| (name.clone(), type_))
                                .collect(),
                        ),
                        FlatTypeNode::RecordUpdate { fields, .. } => Type::RecordUpdate {
                            base: Rc::new(children.next().expect("record-update base")),
                            fields: fields
                                .iter()
                                .zip(children)
                                .map(|((name, _), type_)| (name.clone(), type_))
                                .collect(),
                        },
                        FlatTypeNode::Array(_) => {
                            Type::Array(Rc::new(children.next().expect("array element")))
                        }
                        FlatTypeNode::Region(_) => {
                            Type::Region(Rc::new(children.next().expect("region element")))
                        }
                        FlatTypeNode::Scratch(_) => {
                            Type::Scratch(Rc::new(children.next().expect("scratch element")))
                        }
                        FlatTypeNode::Variant { cases, open } => Type::Variant {
                            cases: cases
                                .iter()
                                .zip(children)
                                .map(|((name, _), type_)| (name.clone(), type_))
                                .collect(),
                            open: *open,
                        },
                        FlatTypeNode::OpenEffects { labels, .. } => Type::OpenEffects {
                            labels: labels.clone(),
                            tail: Rc::new(children.next().expect("open-effects tail")),
                        },
                        FlatTypeNode::Union(_) => Type::Union(children.collect()),
                        FlatTypeNode::Rigid(_)
                        | FlatTypeNode::Forall { .. }
                        | FlatTypeNode::Range { .. }
                        | FlatTypeNode::Unit
                        | FlatTypeNode::Effects(_)
                        | FlatTypeNode::Opaque(_)
                        | FlatTypeNode::Top
                        | FlatTypeNode::Bottom => {
                            unreachable!("leaf and quantified types assemble directly")
                        }
                    };
                    inflated.push(type_);
                }
                Frame::AssembleForall {
                    variables,
                    previous,
                } => {
                    let body = inflated.pop().expect("forall body must be inflated");
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
                    inflated.push(Type::Forall {
                        variables,
                        body: Rc::new(body),
                    });
                }
            }
        }
        inflated
            .pop()
            .expect("flat type inflation must produce one type")
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
            Value::Array(elements) => {
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
            Value::Union(elements) | Value::IndexedStep { elements } => {
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
        declaration_id: DeclarationId,
        declaration: Declaration,
        types: &mut TypeEnvironment,
        values: &mut ValueEnvironment,
        recursive_bindings: &mut Option<(DeclarationKind, Rc<RecursiveBindings>)>,
        dependencies: &BTreeMap<String, Type>,
        signatures: &mut BTreeMap<String, Type>,
    ) -> Result<Type, Diagnostic> {
        match declaration {
            Declaration::Signature {
                name, value, span, ..
            } => {
                let holes = signature_hole_expressions(module, value);
                let hole_values = holes
                    .iter()
                    .map(|expression| (*expression, self.context.type_variable()))
                    .collect::<HashMap<_, _>>();
                let signature_value = run(evaluate_expression(
                    self.context.clone(),
                    Rc::new(path.to_owned()),
                    value,
                    values.clone(),
                    Runtime::new(Phase::Comptime, path.to_owned()).signature(hole_values.clone()),
                ))?;
                let Requirement::Type(mut signature) = self.requirement(signature_value) else {
                    return Err(Diagnostic::new(
                        "BLOT_SIGNATURE_NOT_A_TYPE",
                        format!("The signature for `{name}` is not a type value."),
                        span,
                    ));
                };
                let replacements = holes
                    .iter()
                    .map(|expression| {
                        let variable = hole_values
                            .get(expression)
                            .expect("every signature hole must have a type value");
                        (*variable, self.fresh())
                    })
                    .collect::<HashMap<_, _>>();
                signature = substitute_rigid(signature, &replacements);
                for expression in holes {
                    let variable = hole_values
                        .get(&expression)
                        .expect("every signature hole must have a type value");
                    let hole = replacements
                        .get(variable)
                        .expect("every signature hole must have an inference variable");
                    self.analysis_expression_types.borrow_mut().insert(
                        path.to_owned(),
                        expression,
                        hole.clone(),
                    );
                }
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
                if let Some(body) = declaration_closure_body(module, &name) {
                    self.signed_closure_types.borrow_mut().insert(
                        path.to_owned(),
                        body,
                        signature.clone(),
                    );
                }
                signatures.insert(name, signature);
                Ok(Type::Effects(BTreeSet::new()))
            }
            Declaration::Binding {
                kind,
                tags,
                pattern,
                value,
                span,
            } => {
                let tagged = !tags.is_empty();
                let mut tag_names = Vec::new();
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
                    tag_names.push(validate_declaration_tag(&descriptor, tag.span)?);
                }
                if !tag_names.is_empty() {
                    self.declaration_tags
                        .borrow_mut()
                        .insert(path.to_owned(), span, tag_names);
                }
                let recursive = matches!(
                    module.arena.expressions[value.0 as usize],
                    Expression::Rec { .. }
                );
                let binding_recursive_bindings = if recursive {
                    let bindings = match recursive_bindings {
                        Some((group_kind, bindings)) if *group_kind == kind && !tagged => {
                            bindings.clone()
                        }
                        _ => {
                            let (recursive_values, bindings) = recursive_env(Some(values.clone()));
                            *values = recursive_values;
                            bindings
                        }
                    };
                    *recursive_bindings = (!tagged).then(|| (kind, bindings.clone()));
                    Some(bindings)
                } else {
                    *recursive_bindings = None;
                    None
                };
                let stable_shadow = if kind == DeclarationKind::Let && !tagged && !recursive {
                    match &module.arena.patterns[pattern.0 as usize] {
                        Pattern::Name {
                            name,
                            qualifier: Qualifier::None,
                            ..
                        } => types
                            .names
                            .get(name)
                            .cloned()
                            .map(|previous| (name.clone(), self.instantiate(previous))),
                        _ => None,
                    }
                } else {
                    None
                };
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
                let recursive_name = recursive.then(|| {
                    names
                        .first()
                        .expect("a checked recursive pattern binds one name")
                        .clone()
                });
                let signature = if names.len() == 1 {
                    signatures.remove(&names[0])
                } else {
                    None
                };
                let signed = signature.is_some();
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
                let mut inferred = match inferred {
                    Ok(inferred) => inferred,
                    Err(inference_error) if kind == DeclarationKind::Const => {
                        match self.evaluate_binding(
                            path,
                            module,
                            pattern,
                            value,
                            values,
                            Phase::Comptime,
                        ) {
                            Err(evaluation_error) if evaluation_error.code != "BLOT_UNBOUND" => {
                                return Err(evaluation_error);
                            }
                            _ => return Err(inference_error),
                        }
                    }
                    Err(error) => return Err(error),
                };
                if let Some((name, previous)) = stable_shadow {
                    self.stable_shadow_candidates
                        .borrow_mut()
                        .entry(path.to_owned(), value)
                        .or_default()
                        .push(StableShadowCandidate {
                            name,
                            previous,
                            replacement: inferred.type_.clone(),
                        });
                }
                let suspended = if kind == DeclarationKind::Effect {
                    self.effect_value_signature(&inferred.type_)
                } else {
                    None
                };
                if kind == DeclarationKind::Effect {
                    self.direct_effect_candidates
                        .borrow_mut()
                        .entry(path.to_owned(), value)
                        .or_default()
                        .push(DirectEffectCandidate {
                            forced: suspended.is_some(),
                            type_: inferred.type_.clone(),
                        });
                }
                if let Some((suspended_effects, result)) = suspended {
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
                            "A declaration value performs an effect. Sequence it with `use name <- expression;` instead.",
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
                                declaration_id,
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
                        EvaluatedClosure {
                            module_path: closure_module,
                            parameter: *parameter,
                            body: *body,
                            captures: closure_values,
                            self_name: self_name.as_deref(),
                            deferred: *deferred,
                        },
                        types,
                        dependencies,
                        None,
                    );
                    self.phase.set(previous_phase);
                    inferred.type_ = selected?;
                }
                let recursive_bounds = if recursive {
                    names
                        .iter()
                        .filter_map(|name| match types.lookup(name, self) {
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
                let closure_body = match module.arena.expressions[value.0 as usize] {
                    Expression::Lambda { body, .. } => Some(body),
                    Expression::Rec { lambda, .. } => {
                        match module.arena.expressions[lambda.0 as usize] {
                            Expression::Lambda { body, .. } => Some(body),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                if let Some(body) = closure_body {
                    self.closure_types.borrow_mut().insert(
                        path.to_owned(),
                        body,
                        inferred.type_.clone(),
                    );
                    if signed {
                        self.signed_closure_types.borrow_mut().insert(
                            path.to_owned(),
                            body,
                            inferred.type_.clone(),
                        );
                    }
                }
                for bound in recursive_bounds {
                    self.constrain(inferred.type_.clone(), bound, span)?;
                }
                let exact_record = self.exact_record_expression(module, value, types);
                let exact_record_order =
                    self.exact_record_order_expression(module, value, types, values);
                self.bind_pattern(module, pattern, inferred.type_.clone(), types);
                if let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] {
                    if exact_record {
                        Rc::make_mut(&mut types.exact_records).insert(name.clone());
                    } else {
                        Rc::make_mut(&mut types.exact_records).remove(name);
                    }
                    if let Some(order) = exact_record_order {
                        Rc::make_mut(&mut types.exact_record_orders).insert(name.clone(), order);
                    } else {
                        Rc::make_mut(&mut types.exact_record_orders).remove(name);
                    }
                }
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
                let bound_values = if recursive {
                    values.clone()
                } else {
                    declaration_env(values)
                };
                for name in names {
                    let body = match types.lookup(&name, self) {
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
                    let typing = if kind == DeclarationKind::Effect {
                        Typing::Mono(body)
                    } else {
                        Typing::Scheme {
                            level: self.level.get(),
                            body,
                        }
                    };
                    Rc::make_mut(&mut types.names).insert(name.clone(), typing);
                    if let Some(signature) = inferred_signature.clone() {
                        bound_values.signatures.borrow_mut().insert(name, signature);
                    }
                }
                if let Some(mut value_) = evaluated {
                    if let Some(signature) = &inferred_signature {
                        attach_signature(&mut value_, signature);
                    }
                    if recursive {
                        if let Err(error) = binding_recursive_bindings
                            .as_ref()
                            .expect("a recursive declaration has a recursive group")
                            .insert(
                                recursive_name.expect("a recursive declaration binds one name"),
                                value_,
                            )
                        {
                            return Err(Diagnostic::new(
                                "BLOT_RUST_INVARIANT",
                                format!(
                                    "A checked recursive binding could not join its group: {error:?}."
                                ),
                                span,
                            ));
                        }
                    } else if !match_pattern(module, pattern, &value_, &bound_values) {
                        return Err(Diagnostic::new(
                            "BLOT_BINDING_MISMATCH",
                            "The declaration value does not match its pattern.",
                            span,
                        ));
                    }
                }
                *values = bound_values;
                Ok(inferred.effects)
            }
            Declaration::Shadow { name, value, span } => {
                *recursive_bindings = None;
                let previous = types.lookup_stable(&name, self).ok_or_else(|| {
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
                let exact_record = self.exact_record_expression(module, value, types);
                let exact_record_order =
                    self.exact_record_order_expression(module, value, types, values);
                Rc::make_mut(&mut types.names).insert(name.clone(), Typing::Mono(previous));
                Rc::make_mut(&mut types.phases).insert(name.clone(), Phase::Runtime);
                if exact_record {
                    Rc::make_mut(&mut types.exact_records).insert(name.clone());
                } else {
                    Rc::make_mut(&mut types.exact_records).remove(&name);
                }
                if let Some(order) = exact_record_order {
                    Rc::make_mut(&mut types.exact_record_orders).insert(name.clone(), order);
                } else {
                    Rc::make_mut(&mut types.exact_record_orders).remove(&name);
                }
                match self.evaluate(path, value, values, Phase::Runtime) {
                    Ok(value_) => {
                        let shadow_values = declaration_env(values);
                        shadow_values.names.borrow_mut().insert(name, value_);
                        *values = shadow_values;
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
                *recursive_bindings = None;
                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let opened = self.evaluate(path, value, values, Phase::Comptime)?;
                let Some(fields) = opened_members(&opened) else {
                    return Err(Diagnostic::new(
                        "BLOT_CANNOT_OPEN",
                        "`open` requires a compile-time record or effect.",
                        span,
                    ));
                };
                let inferred_fields = match &opened {
                    Value::Effect {
                        id,
                        name,
                        operations,
                        host,
                        ..
                    } => operations
                        .iter()
                        .map(|(operation, signature)| {
                            let mut type_ = self.bridge(signature).ok_or_else(|| {
                                Diagnostic::new(
                                    "BLOT_TYPE_ERROR",
                                    format!(
                                        "Effect operation `{operation}` must have a function type."
                                    ),
                                    span,
                                )
                            })?;
                            add_function_effect(
                                &mut type_,
                                format!("{}:{id}:{name}", if *host { "host" } else { "effect" }),
                            );
                            Ok((operation.clone(), type_))
                        })
                        .collect::<Result<Vec<_>, Diagnostic>>()?
                        .into(),
                    _ => match inferred.type_ {
                        Type::Record(fields) => fields,
                        type_ @ Type::Variable(_) => match self.settle(type_, true) {
                            Type::Record(fields) => fields,
                            _ => Vec::new().into(),
                        },
                        _ => Vec::new().into(),
                    },
                };
                let shadowed = fields
                    .keys()
                    .filter(|name| types.open_shadows(name))
                    .cloned()
                    .collect::<BTreeSet<_>>();
                let used = Rc::new(RefCell::new(BTreeSet::new()));
                self.open_usage_candidates
                    .borrow_mut()
                    .entry(path.to_owned(), value)
                    .or_default()
                    .push(OpenUsageCandidate {
                        effects: inferred.effects.clone(),
                        used: used.clone(),
                        shadowed,
                    });
                Rc::make_mut(&mut types.opens).push(OpenedTypes {
                    inferred: inferred_fields,
                    values: fields.clone(),
                    resolved: Rc::new(RefCell::new(HashMap::new())),
                    used: used.clone(),
                });
                let open_values = declaration_env(values);
                open_values
                    .opens
                    .borrow_mut()
                    .push(OpenedValues::tracked(fields, used));
                *values = open_values;
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
        let inferred = self.infer_inner(
            path,
            module,
            expression_id,
            environment,
            values,
            dependencies,
        );
        if let Ok(inferred) = &inferred {
            self.analysis_expression_types.borrow_mut().insert(
                path.to_owned(),
                expression_id,
                inferred.type_.clone(),
            );
            if let Some(fact) = simplification_fact(module, expression_id, values, &self.context) {
                self.simplifications
                    .borrow_mut()
                    .insert(path.to_owned(), expression_id, fact);
            }
            if matches!(
                &module.arena.expressions[expression_id.0 as usize],
                Expression::Var { .. } | Expression::Intrinsic { .. } | Expression::Field { .. }
            ) {
                let static_value = comptime_expression_value(module, expression_id, values);
                let candidate = (comptime_stable_expression(module, expression_id, environment)
                    && self.effects_are_empty(&inferred.effects)
                    && static_value.as_ref().is_some_and(|value| {
                        matches!(value, Value::Array(elements) if elements.is_empty())
                            || matches!(value, Value::EmptyArray { .. })
                    }))
                .then_some(ReadabilityFact::EmptyArray {
                    expression: expression_id,
                });
                self.record_structural_readability_candidate(
                    path,
                    expression_id,
                    ReadabilityFactKind::EmptyArray,
                    candidate,
                );
            }
            if matches!(
                &module.arena.expressions[expression_id.0 as usize],
                Expression::Shape { .. }
            ) {
                let candidate =
                    self.record_reconstruction_fact(module, expression_id, environment, values);
                self.record_structural_readability_candidate(
                    path,
                    expression_id,
                    ReadabilityFactKind::RecordReconstruction,
                    candidate,
                );
            }
        }
        if let Ok(inferred) = &inferred
            && matches!(
                module.arena.expressions[expression_id.0 as usize],
                Expression::Apply { .. }
            )
            && intrinsic_head(module, expression_id) != Some("@import")
        {
            self.expression_types.borrow_mut().insert(
                path.to_owned(),
                expression_id,
                inferred.type_.clone(),
            );
        }
        inferred
    }

    fn infer_inner(
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
                cases: vec![(name, Type::Unit)].into(),
                open: false,
            })),
            Expression::Var { name, .. } => {
                let typing = environment.lookup(&name, self).ok_or_else(|| {
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
                let function_expression = function;
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
                        EvaluatedClosure {
                            module_path: &closure_module,
                            parameter,
                            body,
                            captures: &closure_values,
                            self_name: self_name.as_deref(),
                            deferred,
                        },
                        environment,
                        dependencies,
                        None,
                    )?;
                    for argument in arguments {
                        let result = self.fresh();
                        let performed = self.fresh();
                        let deferred = self.deferred_call(&function_type);
                        self.constrain(
                            function_type,
                            Type::Function {
                                deferred,
                                parameter: Rc::new(argument),
                                effects: Rc::new(performed.clone()),
                                result: Rc::new(result.clone()),
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
                        EvaluatedClosure {
                            module_path: &closure_module,
                            parameter,
                            body,
                            captures: &closure_values,
                            self_name: self_name.as_deref(),
                            deferred,
                        },
                        environment,
                        dependencies,
                        None,
                    )?;
                    let result = self.fresh();
                    let performed = self.fresh();
                    let deferred = self.deferred_call(&function_type);
                    self.constrain(
                        function_type,
                        Type::Function {
                            deferred,
                            parameter: Rc::new(argument_type.type_),
                            effects: Rc::new(performed.clone()),
                            result: Rc::new(result.clone()),
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
                            Type::Record(vec![(name, field.clone())].into()),
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
                    argument: subject_expression,
                    ..
                } = module.arena.expressions[function.0 as usize]
                    && let Expression::Intrinsic { name, .. } =
                        &module.arena.expressions[satisfies.0 as usize]
                    && name == "@satisfies"
                {
                    let subject = self.infer(
                        path,
                        module,
                        subject_expression,
                        environment,
                        values,
                        dependencies,
                    )?;
                    if let Ok(value) = self.evaluate(path, argument, values, Phase::Comptime) {
                        return self.apply_requirement(
                            path,
                            expression_id,
                            subject,
                            self.requirement(value),
                            span,
                        );
                    }
                    if self.phase.get() == Phase::Runtime {
                        return Err(Diagnostic::new(
                            "BLOT_REQUIREMENT_NOT_COMPTIME",
                            "The second argument to `@satisfies` must be a compile-time type value or predicate. Make a requirement combinator `const` so calls specialize it.",
                            span,
                        ));
                    }
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
                            cases: vec![(name.clone(), argument.type_)].into(),
                            open: false,
                        },
                        effects: argument.effects,
                    });
                }
                if let Some(Type::Function {
                    deferred: false,
                    parameter,
                    effects,
                    result,
                }) = applied_literal_import(module, function, dependencies)
                {
                    let argument =
                        self.infer(path, module, argument, environment, values, dependencies)?;
                    self.constrain(argument.type_, Rc::unwrap_or_clone(parameter), span)?;
                    return Ok(Inferred {
                        type_: Rc::unwrap_or_clone(result),
                        effects: self
                            .join_effects(argument.effects, Rc::unwrap_or_clone(effects))?,
                    });
                }
                if let Some(imported) = literal_import(module, function, argument, dependencies) {
                    return Ok(Inferred::pure(imported));
                }
                let statically_known = statically_known_callee(module, function, environment);
                let contextual_argument = if self.specialization_depth.get() == 0
                    && statically_known
                {
                    Some(self.infer(path, module, argument, environment, values, dependencies)?)
                } else {
                    None
                };
                let evaluated_function = if statically_known {
                    self.evaluate(path, function, values, Phase::Comptime).ok()
                } else {
                    None
                };
                let evaluated_signature = evaluated_function
                    .as_ref()
                    .and_then(closure_signature)
                    .and_then(|signature| self.bridge(&signature));
                if let Some(argument) = contextual_argument.as_ref()
                    && contains_function(&self.settle(argument.type_.clone(), true))
                    && let Some(Value::Closure {
                        module: closure_module,
                        parameter,
                        body,
                        environment: closure_values,
                        self_name,
                        deferred,
                        ..
                    }) = evaluated_function.as_ref()
                    && self_name.is_none()
                {
                    self.record_specialization(closure_module, *body, &argument.type_, path, span)?;
                    let function = self.infer_evaluated_closure(
                        path,
                        module,
                        EvaluatedClosure {
                            module_path: closure_module,
                            parameter: *parameter,
                            body: *body,
                            captures: closure_values,
                            self_name: self_name.as_deref(),
                            deferred: *deferred,
                        },
                        environment,
                        dependencies,
                        Some(argument.type_.clone()),
                    )?;
                    let result = self.fresh();
                    let performed = self.fresh();
                    let deferred = self.deferred_call(&function);
                    self.constrain(
                        function,
                        Type::Function {
                            deferred,
                            parameter: Rc::new(argument.type_.clone()),
                            effects: Rc::new(performed.clone()),
                            result: Rc::new(result.clone()),
                        },
                        span,
                    )?;
                    if let Some(signature) = evaluated_signature.clone() {
                        self.analysis_expression_types.borrow_mut().insert(
                            path.to_owned(),
                            function_expression,
                            signature,
                        );
                    }
                    return Ok(Inferred {
                        type_: result,
                        effects: self.join_effects(argument.effects.clone(), performed)?,
                    });
                }
                let function = match evaluated_function
                    .as_ref()
                    .and_then(|value| self.bridge_closed_attached_signature(value))
                    .filter(function_result_contains_embedded_function)
                {
                    Some(type_) => Inferred::pure(type_),
                    None => {
                        self.infer(path, module, function, environment, values, dependencies)?
                    }
                };
                let argument = match contextual_argument {
                    Some(argument) => argument,
                    None => {
                        self.infer(path, module, argument, environment, values, dependencies)?
                    }
                };
                let argument_type = argument.type_.clone();
                let result = self.fresh();
                let performed = self.fresh();
                let deferred = self.deferred_call(&function.type_);
                self.constrain(
                    function.type_,
                    Type::Function {
                        deferred,
                        parameter: Rc::new(argument_type.clone()),
                        effects: Rc::new(performed.clone()),
                        result: Rc::new(result.clone()),
                    },
                    span,
                )?;
                let inferred_result = self.settle(result.clone(), true);
                let unsettled_result = matches!(inferred_result, Type::Top | Type::Bottom);
                let requires_specialization = evaluated_function.as_ref().is_some_and(|value| {
                    let Value::Closure { module, body, .. } = value else {
                        return false;
                    };
                    if self
                        .deferred_predicate_closures
                        .borrow()
                        .contains(&(module.as_ref().clone(), *body))
                    {
                        return true;
                    }
                    self.context
                        .modules
                        .borrow()
                        .get(module.as_ref())
                        .is_some_and(|loaded| {
                            expression_contains_computed_field(&loaded.module, *body)
                        })
                });
                let mut selected_effects = None;
                let selected_result = if self.specialization_depth.get() == 0
                    && (unsettled_result || requires_specialization)
                    && let Some(Value::Closure {
                        module: closure_module,
                        parameter,
                        body,
                        environment: closure_values,
                        self_name,
                        deferred,
                        ..
                    }) = evaluated_function.as_ref()
                    && self_name.is_none()
                {
                    self.record_specialization(closure_module, *body, &argument_type, path, span)?;
                    let selected = self.infer_evaluated_closure(
                        path,
                        module,
                        EvaluatedClosure {
                            module_path: closure_module,
                            parameter: *parameter,
                            body: *body,
                            captures: closure_values,
                            self_name: self_name.as_deref(),
                            deferred: *deferred,
                        },
                        environment,
                        dependencies,
                        Some(argument_type.clone()),
                    )?;
                    let selected_result = self.fresh();
                    let selected_performed = self.fresh();
                    let deferred = self.deferred_call(&selected);
                    self.constrain(
                        selected,
                        Type::Function {
                            deferred,
                            parameter: Rc::new(argument_type),
                            effects: Rc::new(selected_performed.clone()),
                            result: Rc::new(selected_result.clone()),
                        },
                        span,
                    )?;
                    selected_effects = Some(selected_performed);
                    selected_result
                } else {
                    result
                };
                let mut effects = self.join_effects(function.effects, argument.effects)?;
                effects = self.join_effects(effects, performed)?;
                if let Some(selected_effects) = selected_effects {
                    effects = self.join_effects(effects, selected_effects)?;
                }
                if let Some(signature) = evaluated_signature {
                    self.analysis_expression_types.borrow_mut().insert(
                        path.to_owned(),
                        function_expression,
                        signature,
                    );
                }
                Ok(Inferred {
                    type_: selected_result,
                    effects,
                })
            }
            Expression::Field { target, name, .. } => {
                let static_type = self
                    .evaluate(path, target, values, Phase::Comptime)
                    .ok()
                    .and_then(|target_value| {
                        if let Some(member) = static_member(&target_value, &name) {
                            if let Value::Primitive { name, .. } = &member {
                                return primitive_type(self, name);
                            }
                            if let Some(type_) = self.bridge(&member) {
                                return Some(type_);
                            }
                            if matches!(target_value, Value::Extended { .. }) {
                                return Some(self.fresh());
                            }
                        }
                        let Value::Effect {
                            id,
                            name: effect_name,
                            operations,
                            host,
                            ..
                        } = target_value
                        else {
                            return None;
                        };
                        let signature = operations.get(&name)?;
                        let mut type_ = self.bridge(signature)?;
                        add_function_effect(
                            &mut type_,
                            format!(
                                "{}:{id}:{effect_name}",
                                if host { "host" } else { "effect" }
                            ),
                        );
                        Some(type_)
                    });
                if let Some(type_) = static_type {
                    Ok(Inferred::pure(type_))
                } else {
                    let target =
                        self.infer(path, module, target, environment, values, dependencies)?;
                    let field = self.fresh();
                    self.constrain(
                        target.type_,
                        Type::Record(vec![(name, field.clone())].into()),
                        span,
                    )?;
                    Ok(Inferred {
                        type_: field,
                        effects: target.effects,
                    })
                }
            }
            Expression::Lambda {
                parameter,
                body: body_id,
                deferred,
                ..
            } => {
                let parameter_type = self.fresh();
                let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
                let parameter_phase = Phase::Runtime;
                self.bind_pattern_at_phase(
                    module,
                    parameter,
                    parameter_type.clone(),
                    &mut scope,
                    parameter_phase,
                );
                self.active_closures
                    .borrow_mut()
                    .push((path.to_owned(), body_id));
                let body = self.infer(path, module, body_id, &scope, values, dependencies);
                self.active_closures.borrow_mut().pop();
                let body = body?;
                let type_ = Type::Function {
                    deferred,
                    parameter: Rc::new(parameter_type),
                    effects: Rc::new(body.effects),
                    result: Rc::new(body.type_),
                };
                self.closure_types
                    .borrow_mut()
                    .entry(path.to_owned(), body_id)
                    .or_insert_with(|| type_.clone());
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
                    type_: Type::Record(fields.into()),
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
                            Type::Array(Rc::new(element_type.clone())),
                            span,
                        )?;
                    } else {
                        self.constrain(inferred.type_, element_type.clone(), span)?;
                    }
                    effects = self.join_effects(effects, inferred.effects)?;
                }
                Ok(Inferred {
                    type_: Type::Array(Rc::new(element_type)),
                    effects,
                })
            }
            Expression::Shape { members, .. } => {
                let mut fields = Vec::new();
                let mut explicit_fields = HashSet::new();
                let mut base = None;
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
                        ShapeMember::Computed {
                            name: name_expression,
                            value,
                        } => {
                            let inferred_name = self.infer(
                                path,
                                module,
                                name_expression,
                                environment,
                                values,
                                dependencies,
                            )?;
                            self.constrain(inferred_name.type_, text_type(), span)?;
                            let inferred =
                                self.infer(path, module, value, environment, values, dependencies)?;
                            match self.evaluate(path, name_expression, values, Phase::Comptime) {
                                Ok(Value::Text(name)) => {
                                    if !explicit_fields.insert(name.clone()) {
                                        return Err(Diagnostic::new(
                                            "BLOT_DUPLICATE_FIELD",
                                            format!(
                                                "Record field `{name}` is written more than once."
                                            ),
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
                                }
                                _ if !self.active_closures.borrow().is_empty() => {
                                    self.defer_current_closure();
                                }
                                _ => {
                                    return Err(Diagnostic::new(
                                        "BLOT_DYNAMIC_SHAPE_FIELD",
                                        "A computed record field name must be known at compile time.",
                                        span,
                                    ));
                                }
                            }
                            effects = self.join_effects(effects, inferred_name.effects)?;
                            effects = self.join_effects(effects, inferred.effects)?;
                        }
                        ShapeMember::Spread { value } => {
                            let inferred =
                                self.infer(path, module, value, environment, values, dependencies)?;
                            if !self.exact_record_expression(module, value, environment) {
                                if base.is_none() && fields.is_empty() {
                                    base = Some(inferred.type_);
                                    effects = self.join_effects(effects, inferred.effects)?;
                                    continue;
                                }
                                return Err(Diagnostic::new(
                                    "BLOT_OPEN_RECORD_SPREAD",
                                    "An open record spread must be the first member of a record update.",
                                    span,
                                ));
                            }
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
                let type_ = match base {
                    Some(base) if fields.is_empty() => base,
                    Some(base) => record_update_type(base, fields.into()),
                    None => Type::Record(fields.into()),
                };
                Ok(Inferred { type_, effects })
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
                        let stable = remaining.lookup_stable(&name, self).ok_or_else(|| {
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
                let mut value_scope = child_env(Some(values.clone()));
                let mut signatures = BTreeMap::new();
                let mut recursive_bindings = None;
                let mut effects = pure();
                scope.forward = Rc::new(future_binding_names(module, &declarations));
                for (index, declaration) in declarations.iter().enumerate() {
                    let declaration_id = *declaration;
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
                        declaration_id,
                        declaration,
                        &mut scope,
                        &mut value_scope,
                        &mut recursive_bindings,
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
                    .entry(path.to_owned(), body)
                    .or_insert_with(|| inferred.type_.clone());
                Ok(inferred)
            }
        }
    }

    fn exact_record_expression(
        &self,
        module: &Module,
        expression: ExpressionId,
        environment: &TypeEnvironment,
    ) -> bool {
        match &module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => environment.is_exact_record(name),
            Expression::Shape { members, .. } => members.iter().all(|member| match member {
                ShapeMember::Field { .. } | ShapeMember::Computed { .. } => true,
                ShapeMember::Spread { value } => {
                    self.exact_record_expression(module, *value, environment)
                }
            }),
            Expression::Intrinsic { name, .. } => name == "@shape.empty",
            Expression::Block { result, .. } => {
                self.exact_record_expression(module, *result, environment)
            }
            _ => false,
        }
    }

    fn exact_record_order_expression(
        &self,
        module: &Module,
        expression: ExpressionId,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
    ) -> Option<Vec<String>> {
        if comptime_stable_expression(module, expression, environment)
            && let Some(Value::Shape(fields)) =
                comptime_expression_value(module, expression, values)
        {
            return Some(fields.keys().cloned().collect());
        }
        match &module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => environment.exact_record_order(name),
            Expression::Shape { members, .. } => {
                let mut order = Vec::new();
                for member in members {
                    let names = match member {
                        ShapeMember::Field { name, .. } => vec![name.clone()],
                        ShapeMember::Computed { name, .. } => {
                            let Value::Text(name) =
                                comptime_expression_value(module, *name, values)?
                            else {
                                return None;
                            };
                            vec![name]
                        }
                        ShapeMember::Spread { value } => {
                            self.exact_record_order_expression(module, *value, environment, values)?
                        }
                    };
                    for name in names {
                        if !order.contains(&name) {
                            order.push(name);
                        }
                    }
                }
                Some(order)
            }
            Expression::Intrinsic { name, .. } if name == "@shape.empty" => Some(Vec::new()),
            Expression::Block {
                declarations,
                result,
                ..
            } if declarations.is_empty() => {
                self.exact_record_order_expression(module, *result, environment, values)
            }
            _ => None,
        }
    }

    fn record_reconstruction_fact(
        &self,
        module: &Module,
        expression: ExpressionId,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
    ) -> Option<ReadabilityFact> {
        let Expression::Shape { members, .. } = &module.arena.expressions[expression.0 as usize]
        else {
            return None;
        };
        let fields = members
            .iter()
            .map(|member| match member {
                ShapeMember::Field { name, value } => Some((name.clone(), *value)),
                ShapeMember::Computed { .. } | ShapeMember::Spread { .. } => None,
            })
            .collect::<Option<Vec<_>>>()?;

        let mut sources = Vec::<(Vec<String>, ExpressionId, usize)>::new();
        for (name, value) in &fields {
            let Expression::Field {
                target,
                name: projected,
                ..
            } = &module.arena.expressions[value.0 as usize]
            else {
                continue;
            };
            if projected != name {
                continue;
            }
            let Some(path) = expression_field_path(module, *target) else {
                continue;
            };
            if let Some((_, _, count)) = sources
                .iter_mut()
                .find(|(candidate, _, _)| candidate == &path)
            {
                *count += 1;
            } else {
                sources.push((path, *target, 1));
            }
        }
        let (_, source, copied) = sources.into_iter().max_by_key(|(_, _, count)| *count)?;
        if copied < 2 {
            return None;
        }
        let source_order =
            self.exact_record_order_expression(module, source, environment, values)?;
        if fields.len() < source_order.len()
            || !fields
                .iter()
                .map(|(name, _)| name)
                .take(source_order.len())
                .eq(source_order.iter())
        {
            return None;
        }
        let source_path = expression_field_path(module, source)?;
        let retained = fields
            .iter()
            .filter_map(|(name, value)| {
                let copied = match &module.arena.expressions[value.0 as usize] {
                    Expression::Field {
                        target,
                        name: projected,
                        ..
                    } => {
                        projected == name
                            && expression_field_path(module, *target).as_ref() == Some(&source_path)
                    }
                    _ => false,
                };
                (!copied).then_some(name.clone())
            })
            .collect();
        Some(ReadabilityFact::RecordReconstruction {
            expression,
            source,
            retained,
        })
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
                .insert(path.to_owned(), body, inferred.type_.clone());
            return Ok(inferred);
        }
        if let Expression::Lambda {
            parameter,
            body,
            deferred,
            ..
        } = module.arena.expressions[expression.0 as usize]
            && let Type::Function {
                deferred: expected_deferred,
                parameter: expected_parameter,
                effects: expected_effects,
                result: expected_result,
            } = expected.clone()
        {
            if deferred != expected_deferred {
                return self.type_error(
                    Type::Function {
                        deferred,
                        parameter: expected_parameter,
                        effects: expected_effects,
                        result: expected_result,
                    },
                    expected,
                    span,
                );
            }
            self.closure_types
                .borrow_mut()
                .insert(path.to_owned(), body, expected.clone());
            let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
            let parameter_phase = Phase::Runtime;
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
            self.constrain(body.effects, Rc::unwrap_or_clone(expected_effects), span)?;
            return Ok(Inferred::pure(expected));
        }
        let signed_closure_body = match module.arena.expressions[expression.0 as usize] {
            Expression::Lambda { body, .. }
                if matches!(function_body(&expected), Type::Function { .. }) =>
            {
                Some(body)
            }
            _ => None,
        };
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
        if let Some(body) = signed_closure_body {
            self.closure_types
                .borrow_mut()
                .insert(path.to_owned(), body, expected.clone());
        }
        self.analysis_expression_types.borrow_mut().insert(
            path.to_owned(),
            expression,
            expected.clone(),
        );
        if self
            .expression_types
            .borrow()
            .contains_key(path, &expression)
        {
            self.expression_types.borrow_mut().insert(
                path.to_owned(),
                expression,
                expected.clone(),
            );
        }
        Ok(Inferred {
            type_: expected,
            effects: inferred.effects,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn record_specialization(
        &self,
        closure_module: &str,
        body: ExpressionId,
        parameter_type: &Type,
        call_path: &str,
        call_span: Span,
    ) -> Result<(), Diagnostic> {
        let representation = self.show_analysis(&self.settle(parameter_type.clone(), true));
        let mut specializations = self.specializations.borrow_mut();
        let binding = specializations
            .entry(closure_module.to_owned(), body)
            .or_default();
        if !binding.keys.contains_key(&representation)
            && binding.keys.len() >= SPECIALIZATION_HARD_LIMIT
        {
            return Err(Diagnostic::new(
                "BLOT_SPECIALIZATION_LIMIT",
                format!(
                    "This binding requires more than {SPECIALIZATION_HARD_LIMIT} runtime representations. Narrow the structural parameter, add a public signature, move a compile-time parameter to runtime, or introduce an explicit stable representation."
                ),
                call_span,
            ));
        }
        let reason = if binding.keys.is_empty() {
            "initial parameter representation"
        } else {
            "parameter representation differs"
        };
        let key = binding
            .keys
            .entry(representation)
            .or_insert_with(|| SpecializationKey {
                reason,
                call_sites: Vec::new(),
            });
        if !key
            .call_sites
            .iter()
            .any(|site| site == &(call_path.to_owned(), call_span))
        {
            key.call_sites.push((call_path.to_owned(), call_span));
        }
        Ok(())
    }

    fn infer_evaluated_closure(
        &self,
        path: &str,
        module: &Module,
        closure: EvaluatedClosure<'_>,
        environment: &TypeEnvironment,
        dependencies: &BTreeMap<String, Type>,
        parameter_type: Option<Type>,
    ) -> Result<Type, Diagnostic> {
        let EvaluatedClosure {
            module_path: closure_module,
            parameter,
            body,
            captures: closure_values,
            self_name,
            deferred,
        } = closure;
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
        let free_names =
            closure_free_names(&self.context, closure_module, parameter, body, self_name)?
                .into_iter()
                .collect::<BTreeSet<_>>();
        self.capture_candidates
            .set(self.capture_candidates.get() + free_names.len() as u64);
        let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
        for name in free_names {
            let Some(value) = lookup(closure_values, &name) else {
                continue;
            };
            self.captures_bridged.set(self.captures_bridged.get() + 1);
            let type_ = self.bridge(&value).unwrap_or_else(|| self.fresh());
            let phase = if closure_module == path {
                environment.binding_phase(&name).unwrap_or(Phase::Comptime)
            } else {
                Phase::Comptime
            };
            Rc::make_mut(&mut scope.names).insert(name.clone(), Typing::Mono(type_));
            Rc::make_mut(&mut scope.phases).insert(name, phase);
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
        let parameter_type = match parameter_type {
            Some(parameter_type) => parameter_type,
            None => self.fresh(),
        };
        let parameter_phase = Phase::Runtime;
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
        self.active_closures
            .borrow_mut()
            .push((closure_module.to_owned(), body));
        let inferred = self.infer(
            closure_module,
            &closure_ast,
            body,
            &scope,
            closure_values,
            dependencies,
        );
        self.active_closures.borrow_mut().pop();
        self.specialization_depth.set(previous_specialization_depth);
        let inferred = inferred?;
        let function = Type::Function {
            deferred,
            parameter: Rc::new(parameter_type),
            effects: Rc::new(inferred.effects),
            result: Rc::new(inferred.type_),
        };
        if let Some((_, recursive)) = recursive {
            self.constrain(function.clone(), recursive, closure_ast.span)?;
        }
        self.closure_types
            .borrow_mut()
            .entry(closure_module.to_owned(), body)
            .or_insert_with(|| function.clone());
        Ok(function)
    }

    fn requirement(&self, value: Value) -> Requirement {
        match self.bridge(&value) {
            Some(type_) => Requirement::Type(type_),
            None => Requirement::Predicate(value),
        }
    }

    fn apply_requirement(
        &self,
        path: &str,
        expression: ExpressionId,
        subject: Inferred,
        requirement: Requirement,
        span: Span,
    ) -> Result<Inferred, Diagnostic> {
        match requirement {
            Requirement::Type(expected) => {
                self.constrain(subject.type_.clone(), expected, span)?;
                Ok(subject)
            }
            Requirement::Predicate(predicate) => {
                let settled = self.settle(subject.type_.clone(), true);
                if contains_bottom(&settled) && self.active_closure_contains_computed_field() {
                    self.defer_current_closure();
                    return Ok(subject);
                }
                let reified = self.reify_runtime_type(&settled).ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_TYPE_NOT_REIFIABLE",
                        format!(
                            "`{}` has no compile-time reading; use a canonical type value to constrain an open subject.",
                            self.show(&settled)
                        ),
                        span,
                    )
                })?;
                let application = ApplicationSite::for_expression(&self.context, path, expression)?
                    .compiler(CompilerApplication::RequirementPredicate);
                let answer = run(apply(
                    self.context.clone(),
                    predicate,
                    reified,
                    span,
                    Runtime::new(Phase::Comptime, path.to_owned()),
                    application,
                ))?;
                match answer {
                    Value::Tag { name, .. } if name == "True" => Ok(subject),
                    Value::Tag { name, .. } if name == "False" => Err(Diagnostic::new(
                        "BLOT_DOES_NOT_SATISFY",
                        format!("`{}` does not satisfy the predicate.", self.show(&settled)),
                        span,
                    )),
                    _ => Err(Diagnostic::new(
                        "BLOT_TYPE_ERROR",
                        "A requirement must be a type value or a compile-time predicate from a closed type to `Bool`.",
                        span,
                    )),
                }
            }
        }
    }

    fn defer_current_closure(&self) {
        if let Some(closure) = self.active_closures.borrow().last() {
            self.deferred_predicate_closures
                .borrow_mut()
                .insert(closure.clone());
        }
    }

    fn active_closure_contains_computed_field(&self) -> bool {
        let Some((path, body)) = self.active_closures.borrow().last().cloned() else {
            return false;
        };
        self.context
            .modules
            .borrow()
            .get(&path)
            .is_some_and(|loaded| expression_contains_computed_field(&loaded.module, body))
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

    fn fresh_empty_array_element(&self) -> Type {
        let type_ = self.fresh();
        let Type::Variable(variable) = type_ else {
            unreachable!("fresh always returns a variable")
        };
        self.empty_array_elements.borrow_mut().insert(variable);
        Type::Variable(variable)
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
            return self.type_error(Type::Unit, Type::Record(Vec::new().into()), span);
        };
        if elements.len() != 3 {
            return self.type_error(Type::Unit, Type::Record(Vec::new().into()), span);
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
                deferred: false,
                parameter: Rc::new(Type::Unit),
                effects: Rc::new(performed.clone()),
                result: Rc::new(computation_result.clone()),
            },
            span,
        )?;
        for (name, signature) in operations {
            let Some(mut signature) = self.bridge(signature) else {
                continue;
            };
            if let Type::Forall { variables, body } = signature {
                signature = self.instantiate_forall(variables, Rc::unwrap_or_clone(body));
            }
            let Type::Function {
                parameter, result, ..
            } = signature
            else {
                continue;
            };
            let continuation = Type::Function {
                deferred: false,
                parameter: result,
                effects: Rc::new(handler_row.clone()),
                result: Rc::new(handled_result.clone()),
            };
            let clause = Type::Function {
                deferred: false,
                parameter: Rc::new(Type::Record(
                    vec![
                        ("0".to_owned(), Rc::unwrap_or_clone(parameter)),
                        ("1".to_owned(), continuation),
                    ]
                    .into(),
                )),
                effects: Rc::new(handler_row.clone()),
                result: Rc::new(handled_result.clone()),
            };
            self.constrain(
                handler.type_.clone(),
                Type::Record(vec![(name.clone(), clause)].into()),
                span,
            )?;
        }
        if handler_fields.get("return").is_some() {
            self.constrain(
                handler.type_.clone(),
                Type::Record(
                    vec![(
                        "return".to_owned(),
                        Type::Function {
                            deferred: false,
                            parameter: Rc::new(computation_result),
                            effects: Rc::new(handler_row.clone()),
                            result: Rc::new(handled_result.clone()),
                        },
                    )]
                    .into(),
                ),
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
        self.freshen_visits.set(self.freshen_visits.get() + 1);
        match type_ {
            Type::Variable(id) if self.variables.borrow()[id as usize].level > level => {
                if let Some(type_) = fresh.get(&id) {
                    return type_.clone();
                }
                let replacement = self.fresh();
                fresh.insert(id, replacement.clone());
                if self.empty_array_elements.borrow().contains(&id)
                    && let Type::Variable(replacement) = &replacement
                {
                    self.empty_array_elements.borrow_mut().insert(*replacement);
                }
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
                body: Rc::new(self.freshen(Rc::unwrap_or_clone(body), level, fresh)),
            },
            Type::Function {
                deferred,
                parameter,
                effects,
                result,
            } => Type::Function {
                deferred,
                parameter: Rc::new(self.freshen(Rc::unwrap_or_clone(parameter), level, fresh)),
                effects: Rc::new(self.freshen(Rc::unwrap_or_clone(effects), level, fresh)),
                result: Rc::new(self.freshen(Rc::unwrap_or_clone(result), level, fresh)),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, type_)| (name, self.freshen(type_, level, fresh)))
                    .collect(),
            ),
            Type::RecordUpdate { base, fields } => Type::RecordUpdate {
                base: Rc::new(self.freshen(Rc::unwrap_or_clone(base), level, fresh)),
                fields: fields
                    .into_iter()
                    .map(|(name, type_)| (name, self.freshen(type_, level, fresh)))
                    .collect(),
            },
            Type::Array(element) => Type::Array(Rc::new(self.freshen(
                Rc::unwrap_or_clone(element),
                level,
                fresh,
            ))),
            Type::Region(element) => Type::Region(Rc::new(self.freshen(
                Rc::unwrap_or_clone(element),
                level,
                fresh,
            ))),
            Type::Scratch(element) => Type::Scratch(Rc::new(self.freshen(
                Rc::unwrap_or_clone(element),
                level,
                fresh,
            ))),
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Rc::new(self.freshen(Rc::unwrap_or_clone(tail), level, fresh)),
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
                ..
            } => self
                .level_of(parameter)
                .max(self.level_of(effects))
                .max(self.level_of(result)),
            Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
                .iter()
                .map(|(_, field)| self.level_of(field))
                .max()
                .unwrap_or(0),
            Type::Array(element) | Type::Region(element) | Type::Scratch(element) => {
                self.level_of(element)
            }
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
                if self.empty_array_elements.borrow().contains(&id) {
                    self.empty_array_elements.borrow_mut().insert(copy_id);
                }
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
                body: Rc::new(self.extrude(Rc::unwrap_or_clone(body), polarity, level, copies)),
            },
            Type::Function {
                deferred,
                parameter,
                effects,
                result,
            } => Type::Function {
                deferred,
                parameter: Rc::new(self.extrude(
                    Rc::unwrap_or_clone(parameter),
                    !polarity,
                    level,
                    copies,
                )),
                effects: Rc::new(self.extrude(
                    Rc::unwrap_or_clone(effects),
                    polarity,
                    level,
                    copies,
                )),
                result: Rc::new(self.extrude(Rc::unwrap_or_clone(result), polarity, level, copies)),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, field)| (name, self.extrude(field, polarity, level, copies)))
                    .collect(),
            ),
            Type::RecordUpdate { base, fields } => Type::RecordUpdate {
                base: Rc::new(self.extrude(Rc::unwrap_or_clone(base), polarity, level, copies)),
                fields: fields
                    .into_iter()
                    .map(|(name, field)| (name, self.extrude(field, polarity, level, copies)))
                    .collect(),
            },
            Type::Array(element) => Type::Array(Rc::new(self.extrude(
                Rc::unwrap_or_clone(element),
                polarity,
                level,
                copies,
            ))),
            Type::Region(element) => Type::Region(Rc::new(self.extrude(
                Rc::unwrap_or_clone(element),
                polarity,
                level,
                copies,
            ))),
            Type::Scratch(element) => Type::Scratch(Rc::new(self.extrude(
                Rc::unwrap_or_clone(element),
                polarity,
                level,
                copies,
            ))),
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Rc::new(self.extrude(Rc::unwrap_or_clone(tail), polarity, level, copies)),
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
        self.settled_variables.borrow_mut().clear();
        self.residual_variables.borrow_mut().clear();
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
        self.empty_array_elements
            .borrow_mut()
            .retain(|variable| (*variable as usize) < variable_count);
        self.next_skolem.set(next_skolem);
    }

    fn add_upper_bound(
        &self,
        variable: VariableId,
        bound: ConstraintTypeId,
        work: &mut VecDeque<WorkItem>,
        span: Span,
    ) {
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
                    work.push_back(WorkItem {
                        left: lower,
                        right: bound,
                        span,
                    });
                }
            }
        }
    }

    fn add_lower_bound(
        &self,
        variable: VariableId,
        bound: ConstraintTypeId,
        work: &mut VecDeque<WorkItem>,
        span: Span,
    ) {
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
                    work.push_back(WorkItem {
                        left: bound,
                        right: upper,
                        span,
                    });
                }
            }
        }
    }

    fn constrain_ids(
        &self,
        left: ConstraintTypeId,
        right: ConstraintTypeId,
        span: Span,
        seen: &mut HashSet<(VariableId, VariableId)>,
    ) -> Result<(), Diagnostic> {
        let mut work = VecDeque::from([WorkItem { left, right, span }]);
        while let Some(item) = work.pop_front() {
            self.constrain_work_item(item, seen, &mut work)?;
            self.solver_worklist_peak
                .set(self.solver_worklist_peak.get().max(work.len() as u64));
        }
        Ok(())
    }

    fn constrain_work_item(
        &self,
        item: WorkItem,
        seen: &mut HashSet<(VariableId, VariableId)>,
        work: &mut VecDeque<WorkItem>,
    ) -> Result<(), Diagnostic> {
        let WorkItem { left, right, span } = item;
        self.constraints.set(self.constraints.get() + 1);
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
                work.push_back(WorkItem {
                    left: instantiated,
                    right,
                    span,
                });
                true
            }
            (_, ConstraintTypeNode::Forall { variables, body }) => {
                let body = self.expand_constraint(body);
                let rigid = self.skolemize(variables, body);
                let rigid = self.constraint_type(&rigid);
                work.push_back(WorkItem {
                    left,
                    right: rigid,
                    span,
                });
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
                    deferred: left_deferred,
                    parameter: left_parameter,
                    effects: left_effects,
                    result: left_result,
                },
                ConstraintTypeNode::Function {
                    deferred: right_deferred,
                    parameter: right_parameter,
                    effects: right_effects,
                    result: right_result,
                },
            ) => {
                if left_deferred != right_deferred {
                    return self.type_error(
                        self.expand_constraint(left),
                        self.expand_constraint(right),
                        span,
                    );
                }
                work.extend([
                    WorkItem {
                        left: right_parameter,
                        right: left_parameter,
                        span,
                    },
                    WorkItem {
                        left: left_effects,
                        right: right_effects,
                        span,
                    },
                    WorkItem {
                        left: left_result,
                        right: right_result,
                        span,
                    },
                ]);
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
                            Type::Record(vec![(name, right_type)].into()),
                            span,
                        );
                    };
                    work.push_back(WorkItem {
                        left: *left_field,
                        right: right_field,
                        span,
                    });
                }
                true
            }
            (
                ConstraintTypeNode::RecordUpdate { base, fields },
                ConstraintTypeNode::Record(right_fields),
            ) => {
                for (name, right_field) in right_fields {
                    if let Some((_, updated)) =
                        fields.iter().find(|(candidate, _)| candidate == &name)
                    {
                        work.push_back(WorkItem {
                            left: *updated,
                            right: right_field,
                            span,
                        });
                        continue;
                    }
                    let required = self.constraint_type(&Type::Record(
                        vec![(name, self.expand_constraint(right_field))].into(),
                    ));
                    work.push_back(WorkItem {
                        left: base,
                        right: required,
                        span,
                    });
                }
                true
            }
            (
                ConstraintTypeNode::RecordUpdate {
                    base: left_base,
                    fields: left_fields,
                },
                ConstraintTypeNode::RecordUpdate {
                    base: right_base,
                    fields: right_fields,
                },
            ) => {
                if left_fields.len() != right_fields.len() {
                    false
                } else {
                    work.push_back(WorkItem {
                        left: left_base,
                        right: right_base,
                        span,
                    });
                    for (name, left_field) in left_fields {
                        let Some((_, right_field)) = right_fields
                            .iter()
                            .find(|(candidate, _)| candidate == &name)
                        else {
                            return self.type_error(
                                self.expand_constraint(left),
                                self.expand_constraint(right),
                                span,
                            );
                        };
                        work.push_back(WorkItem {
                            left: left_field,
                            right: *right_field,
                            span,
                        });
                    }
                    true
                }
            }
            (ConstraintTypeNode::Array(left), ConstraintTypeNode::Array(right)) => {
                work.push_back(WorkItem { left, right, span });
                let empty = self
                    .constraint_variable(left)
                    .is_some_and(|variable| self.empty_array_elements.borrow().contains(&variable));
                if empty {
                    work.push_back(WorkItem {
                        left: right,
                        right: left,
                        span,
                    });
                }
                true
            }
            (ConstraintTypeNode::Region(left), ConstraintTypeNode::Region(right)) => {
                work.extend([
                    WorkItem { left, right, span },
                    WorkItem {
                        left: right,
                        right: left,
                        span,
                    },
                ]);
                true
            }
            (ConstraintTypeNode::Scratch(left), ConstraintTypeNode::Scratch(right)) => {
                work.extend([
                    WorkItem { left, right, span },
                    WorkItem {
                        left: right,
                        right: left,
                        span,
                    },
                ]);
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
                            work.push_back(WorkItem {
                                left,
                                right: *right,
                                span,
                            });
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
                    work.push_back(WorkItem {
                        left: missing,
                        right: right_tail,
                        span,
                    });
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
                    work.push_back(WorkItem {
                        left: left_tail,
                        right,
                        span,
                    });
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
                    work.push_back(WorkItem {
                        left: missing,
                        right: right_tail,
                        span,
                    });
                }
                let same_tail = self.constraint_types.borrow().same(left_tail, right_tail);
                if !same_tail {
                    let right_row = self.constraint_type(&Type::OpenEffects {
                        labels: right_labels,
                        tail: Rc::new(self.expand_constraint(right_tail)),
                    });
                    work.push_back(WorkItem {
                        left: left_tail,
                        right: right_row,
                        span,
                    });
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
                    self.add_lower_bound(right_variable, lower, work, span);
                }
                for upper in uppers {
                    self.add_upper_bound(left_variable, upper, work, span);
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
                    self.add_upper_bound(variable, right, work, span);
                } else {
                    let bound = self.expand_constraint(right);
                    let extruded = self.extrude(bound, false, variable_level, &mut HashMap::new());
                    let extruded = self.constraint_type(&extruded);
                    work.push_back(WorkItem {
                        left,
                        right: extruded,
                        span,
                    });
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
                    self.add_lower_bound(variable, left, work, span);
                } else {
                    let bound = self.expand_constraint(left);
                    let extruded = self.extrude(bound, true, variable_level, &mut HashMap::new());
                    let extruded = self.constraint_type(&extruded);
                    work.push_back(WorkItem {
                        left: extruded,
                        right,
                        span,
                    });
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
        self.settle_seen(type_, positive, &mut HashSet::new(), &mut true)
    }

    fn residual_signature(&self, type_: Type) -> Type {
        self.residual_signature_analysis(type_).0
    }

    fn residual_signature_analysis(&self, type_: Type) -> (Type, bool) {
        self.boundary_materializations
            .set(self.boundary_materializations.get() + 1);
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
                    ..
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
                Type::RecordUpdate { base, fields } => {
                    pending.push((base, bound.clone()));
                    for (_, field) in fields {
                        pending.push((field, bound.clone()));
                    }
                }
                Type::Array(element) | Type::Region(element) | Type::Scratch(element) => {
                    pending.push((element, bound));
                }
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
                body: Rc::new(body),
            }
        };
        (signature, !recursive.is_empty())
    }

    fn reify_runtime_type(&self, type_: &Type) -> Option<Value> {
        let mut next_hole = self.next_representation_hole.get();
        let value = reify_type_with_holes(&self.context, type_, &mut next_hole);
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
                if let Some(cached) = self.residual_variables.borrow().get(&id) {
                    unresolved.extend(cached.unresolved.iter().copied());
                    return cached.type_.clone();
                }
                if !seen.insert(id) {
                    unresolved.insert(id);
                    recursive.insert(id);
                    return Type::Rigid(id);
                }
                let resolved_before_evidence = resolved.clone();
                let unresolved_before_evidence = unresolved.clone();
                let recursive_before_evidence = recursive.clone();
                let cache_unresolved_before = unresolved.clone();
                let cache_recursive_before = recursive.clone();
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
                if recursive.is_subset(&cache_recursive_before) {
                    let unresolved = unresolved
                        .difference(&cache_unresolved_before)
                        .copied()
                        .collect();
                    self.residual_variables.borrow_mut().insert(
                        id,
                        ResidualVariable {
                            type_: result.clone(),
                            unresolved,
                        },
                    );
                }
                result
            }
            Type::Forall { variables, body } => Type::Forall {
                variables,
                body: Rc::new(self.residual_signature_type(
                    Rc::unwrap_or_clone(body),
                    seen,
                    resolved,
                    unresolved,
                    recursive,
                )),
            },
            Type::Function {
                deferred,
                parameter,
                effects,
                result,
            } => Type::Function {
                deferred,
                parameter: Rc::new(self.residual_signature_type(
                    Rc::unwrap_or_clone(parameter),
                    seen,
                    resolved,
                    unresolved,
                    recursive,
                )),
                effects: Rc::new(self.settle(Rc::unwrap_or_clone(effects), true)),
                result: Rc::new(self.residual_signature_type(
                    Rc::unwrap_or_clone(result),
                    seen,
                    resolved,
                    unresolved,
                    recursive,
                )),
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
            Type::RecordUpdate { base, fields } => record_update_type(
                self.residual_signature_type(
                    Rc::unwrap_or_clone(base),
                    seen,
                    resolved,
                    unresolved,
                    recursive,
                ),
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
            Type::Array(element) => Type::Array(Rc::new(self.residual_signature_type(
                Rc::unwrap_or_clone(element),
                seen,
                resolved,
                unresolved,
                recursive,
            ))),
            Type::Region(element) => Type::Region(Rc::new(self.residual_signature_type(
                Rc::unwrap_or_clone(element),
                seen,
                resolved,
                unresolved,
                recursive,
            ))),
            Type::Scratch(element) => Type::Scratch(Rc::new(self.residual_signature_type(
                Rc::unwrap_or_clone(element),
                seen,
                resolved,
                unresolved,
                recursive,
            ))),
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Rc::new(self.residual_signature_type(
                    Rc::unwrap_or_clone(tail),
                    seen,
                    resolved,
                    unresolved,
                    recursive,
                )),
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
                    Type::Union(members.into())
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

    fn settle_seen(
        &self,
        type_: Type,
        positive: bool,
        seen: &mut HashSet<VariableId>,
        cacheable: &mut bool,
    ) -> Type {
        self.settle_visits.set(self.settle_visits.get() + 1);
        match type_ {
            Type::Variable(id) => {
                if let Some(settled) = self.settled_variables.borrow().get(&(id, positive)) {
                    return settled.clone();
                }
                if !seen.insert(id) {
                    *cacheable = false;
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
                    .map(|bound| self.settle_seen(bound, positive, seen, cacheable))
                    .collect::<Vec<_>>();
                seen.remove(&id);
                let settled = if settled.is_empty() {
                    if positive { Type::Bottom } else { Type::Top }
                } else if settled.len() == 1 {
                    settled.remove(0)
                } else if positive {
                    join_types(settled)
                } else {
                    meet_types(settled)
                };
                if *cacheable {
                    self.settled_variables
                        .borrow_mut()
                        .insert((id, positive), settled.clone());
                }
                settled
            }
            Type::Forall { variables, body } => Type::Forall {
                variables,
                body: Rc::new(self.settle_seen(
                    Rc::unwrap_or_clone(body),
                    positive,
                    seen,
                    cacheable,
                )),
            },
            Type::Function {
                deferred,
                parameter,
                effects,
                result,
            } => Type::Function {
                deferred,
                parameter: Rc::new(self.settle_seen(
                    Rc::unwrap_or_clone(parameter),
                    !positive,
                    seen,
                    cacheable,
                )),
                effects: Rc::new(self.settle_seen(
                    Rc::unwrap_or_clone(effects),
                    positive,
                    seen,
                    cacheable,
                )),
                result: Rc::new(self.settle_seen(
                    Rc::unwrap_or_clone(result),
                    positive,
                    seen,
                    cacheable,
                )),
            },
            Type::Record(fields) => Type::Record(
                fields
                    .into_iter()
                    .map(|(name, type_)| (name, self.settle_seen(type_, positive, seen, cacheable)))
                    .collect(),
            ),
            Type::RecordUpdate { base, fields } => record_update_type(
                self.settle_seen(Rc::unwrap_or_clone(base), positive, seen, cacheable),
                fields
                    .into_iter()
                    .map(|(name, type_)| (name, self.settle_seen(type_, positive, seen, cacheable)))
                    .collect(),
            ),
            Type::Array(element) => Type::Array(Rc::new(self.settle_seen(
                Rc::unwrap_or_clone(element),
                positive,
                seen,
                cacheable,
            ))),
            Type::Region(element) => Type::Region(Rc::new(self.settle_seen(
                Rc::unwrap_or_clone(element),
                positive,
                seen,
                cacheable,
            ))),
            Type::Scratch(element) => Type::Scratch(Rc::new(self.settle_seen(
                Rc::unwrap_or_clone(element),
                positive,
                seen,
                cacheable,
            ))),
            Type::OpenEffects { labels, tail } => Type::OpenEffects {
                labels,
                tail: Rc::new(self.settle_seen(
                    Rc::unwrap_or_clone(tail),
                    positive,
                    seen,
                    cacheable,
                )),
            },
            Type::Variant { cases, open } => Type::Variant {
                cases: cases
                    .into_iter()
                    .map(|(name, type_)| (name, self.settle_seen(type_, positive, seen, cacheable)))
                    .collect(),
                open,
            },
            Type::Union(members) => Type::Union(
                members
                    .into_iter()
                    .map(|member| self.settle_seen(member, positive, seen, cacheable))
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
            ..
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
                let _ = self.constrain(type_, Type::Array(Rc::new(element)), module.span);
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
                        cases: vec![(name.clone(), payload_type)].into(),
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
            Pattern::Pin { name, .. } => self.instantiate(environment.lookup(name, self)?),
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
            Pattern::Array { elements, .. } => Type::Array(Rc::new(union_types(
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
                )]
                .into(),
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
                let Some(typing) = environment.lookup(name, self) else {
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
                            "Pinned `{name}` must have a known Int or Text type, found {}.",
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
                ..
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
        let environment_identity = Rc::as_ptr(environment) as usize;
        let key = (pattern, expression, phase, environment_identity);
        let cached = {
            let evaluated_bindings = self.context.evaluated_bindings.borrow();
            evaluated_bindings.get(path).and_then(|bindings| {
                bindings
                    .get(&key)
                    .filter(|cached| {
                        cached
                            .environment
                            .upgrade()
                            .is_some_and(|cached| Rc::ptr_eq(&cached, environment))
                    })
                    .or_else(|| bindings.get(&(pattern, expression, phase, 0)))
                    .map(|cached| cached.value.clone())
            })
        };
        if let Some(value) = cached {
            return Ok(value);
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
            let key = if reusable_across_module_instances(value) {
                (pattern, expression, phase, 0)
            } else {
                key
            };
            self.context
                .evaluated_bindings
                .borrow_mut()
                .entry(path.to_owned())
                .or_default()
                .insert(
                    key,
                    crate::eval::CachedEvaluatedBinding {
                        environment: Rc::downgrade(environment),
                        value: value.clone(),
                    },
                );
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
            Value::RegionType(element) => Type::Region(Rc::new(self.bridge_runtime_value(element))),
            Value::ScratchType(element) => {
                Type::Scratch(Rc::new(self.bridge_runtime_value(element)))
            }
            Value::Scratch { values, .. } => Type::Scratch(Rc::new(join_types(
                values
                    .iter()
                    .map(|value| self.bridge_runtime_value(value))
                    .collect(),
            ))),
            Value::Region { store, start, end } => Type::Region(Rc::new(join_types(
                store.borrow()[*start..*end]
                    .iter()
                    .map(|value| self.bridge_runtime_value(value))
                    .collect(),
            ))),
            Value::RegionRejoin { .. } => Type::Opaque("Rejoin".to_owned()),
            Value::Array(elements) => Type::Array(Rc::new(join_types(
                elements
                    .iter()
                    .map(|value| self.bridge_runtime_value(value))
                    .collect(),
            ))),
            Value::EmptyArray { .. } => Type::Array(Rc::new(self.fresh_empty_array_element())),
            Value::Tag { name, payload } => Type::Variant {
                cases: vec![(
                    name.clone(),
                    payload
                        .as_deref()
                        .map(|payload| self.bridge_runtime_value(payload))
                        .unwrap_or(Type::Unit),
                )]
                .into(),
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
                    .collect::<Option<Vec<_>>>()?
                    .into(),
            )),
            Value::RegionType(element) => Some(Type::Region(Rc::new(self.bridge(element)?))),
            Value::ScratchType(element) => Some(Type::Scratch(Rc::new(self.bridge(element)?))),
            Value::Scratch { values, .. } => Some(Type::Scratch(Rc::new(join_types(
                values
                    .iter()
                    .map(|value| self.bridge(value))
                    .collect::<Option<Vec<_>>>()?,
            )))),
            Value::Region { store, start, end } => Some(Type::Region(Rc::new(union_types(
                store.borrow()[*start..*end]
                    .iter()
                    .filter_map(|value| self.bridge(value))
                    .collect(),
            )))),
            Value::RegionRejoin { .. } => Some(Type::Opaque("Rejoin".to_owned())),
            Value::Array(elements) => Some(Type::Array(Rc::new(union_types(
                elements
                    .iter()
                    .filter_map(|value| self.bridge(value))
                    .collect(),
            )))),
            Value::EmptyArray { .. } => {
                Some(Type::Array(Rc::new(self.fresh_empty_array_element())))
            }
            Value::Tag { name, payload } => Some(Type::Variant {
                cases: vec![(
                    name.clone(),
                    payload
                        .as_deref()
                        .and_then(|value| self.bridge(value))
                        .unwrap_or(Type::Unit),
                )]
                .into(),
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
                deferred,
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
                        tail: Rc::new(Type::Rigid(*tail)),
                    },
                    None => Type::Effects(labels),
                };
                Some(Type::Function {
                    deferred: *deferred,
                    parameter: Rc::new(self.bridge(domain)?),
                    effects: Rc::new(effects),
                    result: Rc::new(self.bridge(codomain)?),
                })
            }
            Value::Forall { variable, body } => Some(Type::Forall {
                variables: vec![*variable],
                body: Rc::new(self.bridge(body)?),
            }),
            Value::Effect { id, name, .. } => Some(Type::Opaque(format!("Effect:{id}:{name}"))),
            Value::Extended { inner, .. } => self.bridge(inner),
            Value::Sealed { name, inner } => sealed_type(name, &self.bridge(inner)?),
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

    fn bridge_closed_attached_signature(&self, value: &Value) -> Option<Type> {
        let Value::Closure {
            signature: Some(signature),
            ..
        } = value
        else {
            return None;
        };
        self.bridge_closed_value(signature)
    }

    fn bridge_closed_value(&self, value: &Value) -> Option<Type> {
        let signature = self.bridge(value)?;
        if !closed_checked_type(&signature, &mut HashSet::new()) {
            return None;
        }
        match signature {
            Type::Forall { variables, body } => {
                Some(self.instantiate_forall(variables, Rc::unwrap_or_clone(body)))
            }
            signature => Some(signature),
        }
    }

    fn show(&self, type_: &Type) -> String {
        let settled = self.settle(type_.clone(), true);
        self.show_settled(&settled)
    }

    fn show_settled(&self, type_: &Type) -> String {
        match type_ {
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
                    self.show_settled(&substitute_rigid(body.as_ref().clone(), &replacements))
                )
            }
            Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(low)),
                high: Some(Scalar::Int(high)),
            } if low == &BigInt::from(i64::MIN) && high == &BigInt::from(i64::MAX) => {
                "Int".to_owned()
            }
            Type::Range {
                domain: Domain::Text,
                low: None,
                high: None,
            } => "Text".to_owned(),
            Type::Range {
                domain: Domain::Float,
                ..
            } => "F64".to_owned(),
            Type::Range {
                domain: Domain::Float32,
                ..
            } => "F32".to_owned(),
            Type::Range {
                low: Some(low),
                high: Some(high),
                ..
            } if low == high => show_bound(Some(low.clone())),
            Type::Range { low, high, .. } => {
                format!("{}..{}", show_bound(low.clone()), show_bound(high.clone()))
            }
            Type::Unit => "Unit".to_owned(),
            Type::Function {
                deferred,
                parameter,
                effects,
                result,
            } => {
                let arrow = if *deferred { " ~> " } else { " -> " };
                format!(
                    "{}{arrow}{}{}",
                    self.show_settled(parameter),
                    self.show_settled(result),
                    show_effects(effects)
                )
            }
            Type::Record(fields) => format!(
                "{{ {} }}",
                fields
                    .iter()
                    .map(|(name, type_)| format!(".{name} = {}", self.show_settled(type_)))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            Type::RecordUpdate { base, fields } => format!(
                "update {} with {{ {} }}",
                self.show_settled(base),
                fields
                    .iter()
                    .map(|(name, type_)| format!(".{name} = {}", self.show_settled(type_)))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            Type::Array(element) => {
                let shown = self.show_settled(element);
                if matches!(element.as_ref(), Type::Union(_)) && shown.contains(" | ") {
                    format!("[({shown})]")
                } else {
                    format!("[{shown}]")
                }
            }
            Type::Region(element) => format!("Region {}", self.show_settled(element)),
            Type::Scratch(element) => format!("Scratch {}", self.show_settled(element)),
            Type::Variant { cases, .. } => cases
                .iter()
                .map(|(name, payload)| {
                    if matches!(payload, Type::Unit) {
                        format!("#{name}")
                    } else {
                        format!("#{name} {}", self.show_settled(payload))
                    }
                })
                .collect::<Vec<_>>()
                .join(" | "),
            Type::Effects(labels) => format!(
                "{{ {} }}",
                labels.iter().cloned().collect::<Vec<_>>().join(", ")
            ),
            Type::OpenEffects { labels, tail } => {
                let mut parts = labels.iter().cloned().collect::<Vec<_>>();
                parts.push(format!("..{}", self.show_settled(tail)));
                format!("{{ {} }}", parts.join(", "))
            }
            Type::Union(members) => show_union(
                union_members(members)
                    .into_iter()
                    .map(|member| self.show_settled(member))
                    .collect::<Vec<_>>(),
            ),
            Type::Opaque(name) => match sealed_type_name(name) {
                Some(public_name) => format!("Sealed:{public_name}"),
                None => name.clone(),
            },
            Type::Top => "⊤".to_owned(),
            Type::Bottom => "⊥".to_owned(),
        }
    }

    fn show_analysis(&self, type_: &Type) -> String {
        let signature = self.residual_signature(type_.clone());
        let mut replacements = HashMap::new();
        let body = match signature {
            Type::Forall { variables, body } => {
                for (index, variable) in variables.into_iter().enumerate() {
                    replacements.insert(variable, Type::Opaque(type_variable_name(index)));
                }
                Rc::unwrap_or_clone(body)
            }
            body => body,
        };
        let mut free = BTreeSet::new();
        free_rigid_variables(&body, &mut HashSet::new(), &mut free);
        for variable in free {
            if replacements.contains_key(&variable) {
                continue;
            }
            let index = replacements.len();
            replacements.insert(variable, Type::Opaque(type_variable_name(index)));
        }
        self.show(&substitute_rigid(body, &replacements))
    }
}

fn contains_bottom(type_: &Type) -> bool {
    match type_ {
        Type::Bottom => true,
        Type::Forall { body, .. } => contains_bottom(body),
        Type::Function {
            parameter,
            effects,
            result,
            ..
        } => contains_bottom(parameter) || contains_bottom(effects) || contains_bottom(result),
        Type::Record(fields) | Type::Variant { cases: fields, .. } => {
            fields.iter().any(|(_, field)| contains_bottom(field))
        }
        Type::RecordUpdate { base, fields } => {
            contains_bottom(base) || fields.iter().any(|(_, field)| contains_bottom(field))
        }
        Type::Array(element) | Type::Region(element) | Type::Scratch(element) => {
            contains_bottom(element)
        }
        Type::OpenEffects { tail, .. } => contains_bottom(tail),
        Type::Union(members) => members.iter().any(contains_bottom),
        Type::Variable(_)
        | Type::Rigid(_)
        | Type::Range { .. }
        | Type::Unit
        | Type::Effects(_)
        | Type::Opaque(_)
        | Type::Top => false,
    }
}

fn type_variable_name(index: usize) -> String {
    if index < 26 {
        format!("'{}", char::from(b'a' + index as u8))
    } else {
        format!("'t{index}")
    }
}

const SEALED_TYPE_PREFIX: &str = "Sealed:";

pub(crate) fn sealed_type(name: &str, carrier: &Type) -> Option<Type> {
    let carrier_key = closed_type_key(carrier)?;
    Some(Type::Opaque(format!(
        "{SEALED_TYPE_PREFIX}{}:{name}:{carrier_key}",
        name.len()
    )))
}

pub(crate) fn sealed_type_name(identity: &str) -> Option<&str> {
    let encoded = identity.strip_prefix(SEALED_TYPE_PREFIX)?;
    let (length, remainder) = encoded.split_once(':')?;
    let length = length.parse::<usize>().ok()?;
    let name = remainder.get(..length)?;
    remainder.get(length..)?.starts_with(':').then_some(name)
}

fn closed_type_key(type_: &Type) -> Option<String> {
    fn text(value: &str) -> String {
        format!("{}:{value}", value.len())
    }

    fn scalar(value: Option<&Scalar>) -> String {
        match value {
            None => "*".to_owned(),
            Some(Scalar::Int(value)) => format!("i{value}"),
            Some(Scalar::Text(value)) => format!("s{}", text(value)),
        }
    }

    fn fields(
        name: &str,
        values: &[(String, Type)],
        binders: &mut HashMap<VariableId, usize>,
    ) -> Option<String> {
        let mut keyed = values
            .iter()
            .map(|(field, type_)| Some(format!("{}{}", text(field), visit(type_, binders)?)))
            .collect::<Option<Vec<_>>>()?;
        keyed.sort();
        Some(format!("{name}{{{}}}", keyed.join(",")))
    }

    fn visit(type_: &Type, binders: &mut HashMap<VariableId, usize>) -> Option<String> {
        match type_ {
            Type::Variable(_) => None,
            Type::Rigid(id) => binders.get(id).map(|index| format!("^{index}")),
            Type::Forall { variables, body } => {
                let previous = binders.clone();
                let depth = binders.len();
                for (index, variable) in variables.iter().enumerate() {
                    binders.insert(*variable, depth + index);
                }
                let body = visit(body, binders);
                *binders = previous;
                Some(format!("all{}({})", variables.len(), body?))
            }
            Type::Range { domain, low, high } => {
                let domain = match domain {
                    Domain::Int => "int",
                    Domain::Text => "text",
                    Domain::Float => "float64",
                    Domain::Float32 => "float32",
                };
                Some(format!(
                    "range({domain},{},{})",
                    scalar(low.as_ref()),
                    scalar(high.as_ref())
                ))
            }
            Type::Unit => Some("unit".to_owned()),
            Type::Function {
                deferred,
                parameter,
                effects,
                result,
            } => Some(format!(
                "fun({deferred},{},{},{})",
                visit(parameter, binders)?,
                visit(effects, binders)?,
                visit(result, binders)?
            )),
            Type::Record(values) => fields("record", values, binders),
            Type::RecordUpdate {
                base,
                fields: values,
            } => Some(format!(
                "record-update({},{})",
                visit(base, binders)?,
                fields("", values, binders)?
            )),
            Type::Array(element) => Some(format!("array({})", visit(element, binders)?)),
            Type::Region(element) => Some(format!("region({})", visit(element, binders)?)),
            Type::Scratch(element) => Some(format!("scratch({})", visit(element, binders)?)),
            Type::Variant { cases, open } => {
                Some(format!("variant({open}){}", fields("", cases, binders)?))
            }
            Type::Effects(labels) => Some(format!(
                "effects{{{}}}",
                labels
                    .iter()
                    .map(|label| text(label))
                    .collect::<Vec<_>>()
                    .join(",")
            )),
            Type::OpenEffects { labels, tail } => Some(format!(
                "open-effects{{{};{}}}",
                labels
                    .iter()
                    .map(|label| text(label))
                    .collect::<Vec<_>>()
                    .join(","),
                visit(tail, binders)?
            )),
            Type::Union(members) => {
                let mut keys = members
                    .iter()
                    .map(|member| visit(member, binders))
                    .collect::<Option<Vec<_>>>()?;
                keys.sort();
                Some(format!("union{{{}}}", keys.join(",")))
            }
            Type::Opaque(name) => Some(format!("opaque({})", text(name))),
            Type::Top => Some("top".to_owned()),
            Type::Bottom => Some("bottom".to_owned()),
        }
    }

    visit(type_, &mut HashMap::new())
}

fn free_rigid_variables(
    type_: &Type,
    bound: &mut HashSet<VariableId>,
    free: &mut BTreeSet<VariableId>,
) {
    match type_ {
        Type::Rigid(variable) => {
            if !bound.contains(variable) {
                free.insert(*variable);
            }
        }
        Type::Forall { variables, body } => {
            let inserted = variables
                .iter()
                .copied()
                .filter(|variable| bound.insert(*variable))
                .collect::<Vec<_>>();
            free_rigid_variables(body, bound, free);
            for variable in inserted {
                bound.remove(&variable);
            }
        }
        Type::Function {
            parameter,
            effects,
            result,
            ..
        } => {
            free_rigid_variables(parameter, bound, free);
            free_rigid_variables(effects, bound, free);
            free_rigid_variables(result, bound, free);
        }
        Type::Record(fields) | Type::Variant { cases: fields, .. } => {
            for (_, field) in fields {
                free_rigid_variables(field, bound, free);
            }
        }
        Type::RecordUpdate { base, fields } => {
            free_rigid_variables(base, bound, free);
            for (_, field) in fields {
                free_rigid_variables(field, bound, free);
            }
        }
        Type::Array(element) | Type::Region(element) | Type::Scratch(element) => {
            free_rigid_variables(element, bound, free);
        }
        Type::OpenEffects { tail, .. } => free_rigid_variables(tail, bound, free),
        Type::Union(members) => {
            for member in members {
                free_rigid_variables(member, bound, free);
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
        "@f32.neg" | "@f32.sqrt" => curried(vec![f32_.clone()], f32_),
        "@f32.cmp" => curried(vec![f32_.clone(), f32_], ordering),
        "@f32.is_nan" => curried(vec![f32_], bool_.clone()),
        "@f32.of_float" => curried(vec![float], f32_),
        "@f32.of_int" => curried(vec![int], f32_),
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
        "@text.scalar_at" => curried(vec![text.clone(), int], text),
        "@text.slice" => curried(vec![text.clone(), int.clone(), int], text),
        "@text.find_from" => curried(vec![text.clone(), text, int.clone()], int),
        "@text.cmp" => curried(vec![text.clone(), text], ordering),
        "@text.contains" => curried(vec![text.clone(), text], bool_),
        "@text.of_int" => curried(vec![int], text),
        "@region.type" => curried(
            vec![Type::Opaque("Type".to_owned())],
            Type::Opaque("Type".to_owned()),
        ),
        "@scratch.type" => curried(
            vec![Type::Opaque("Type".to_owned())],
            Type::Opaque("Type".to_owned()),
        ),
        "@scratch.with_capacity" => {
            curried(vec![int.clone()], Type::Scratch(Rc::new(checker.fresh())))
        }
        "@scratch.push" => {
            let element = checker.fresh();
            let scratch = Type::Scratch(Rc::new(element.clone()));
            curried(vec![scratch.clone(), element], scratch)
        }
        "@scratch.finish" => {
            let element = checker.fresh();
            curried(
                vec![Type::Scratch(Rc::new(element.clone()))],
                Type::Array(Rc::new(element)),
            )
        }
        "@scratch.recycle" => {
            let element = checker.fresh();
            curried(
                vec![Type::Array(Rc::new(element.clone()))],
                Type::Scratch(Rc::new(element)),
            )
        }
        "@region.copy" => {
            let element = checker.fresh();
            curried(
                vec![Type::Array(Rc::new(element.clone()))],
                Type::Region(Rc::new(element)),
            )
        }
        "@region.length" => curried(vec![Type::Region(Rc::new(checker.fresh()))], int.clone()),
        "@region.get" => {
            let element = checker.fresh();
            curried(
                vec![Type::Region(Rc::new(element.clone())), int.clone()],
                Type::Variant {
                    cases: vec![
                        ("Some".to_owned(), element),
                        ("None".to_owned(), Type::Unit),
                    ]
                    .into(),
                    open: false,
                },
            )
        }
        "@region.set" => {
            let element = checker.fresh();
            let region = Type::Region(Rc::new(element.clone()));
            curried(
                vec![region.clone(), int.clone(), element],
                Type::Variant {
                    cases: vec![
                        ("Updated".to_owned(), region.clone()),
                        ("SetOutOfBounds".to_owned(), region),
                    ]
                    .into(),
                    open: false,
                },
            )
        }
        "@region.replace" => {
            let element = checker.fresh();
            let region = Type::Region(Rc::new(element.clone()));
            let payload = Type::Record(
                vec![
                    ("0".to_owned(), element.clone()),
                    ("1".to_owned(), region.clone()),
                ]
                .into(),
            );
            curried(
                vec![region, int.clone(), element],
                Type::Variant {
                    cases: vec![
                        ("Replaced".to_owned(), payload.clone()),
                        ("ReplaceOutOfBounds".to_owned(), payload),
                    ]
                    .into(),
                    open: false,
                },
            )
        }
        "@region.swap" => {
            let region = Type::Region(Rc::new(checker.fresh()));
            curried(
                vec![region.clone(), int.clone(), int.clone()],
                Type::Variant {
                    cases: vec![
                        ("Updated".to_owned(), region.clone()),
                        ("SwapOutOfBounds".to_owned(), region),
                    ]
                    .into(),
                    open: false,
                },
            )
        }
        "@region.split" => {
            let region = Type::Region(Rc::new(checker.fresh()));
            curried(
                vec![region.clone(), int.clone()],
                Type::Variant {
                    cases: vec![
                        (
                            "Split".to_owned(),
                            Type::Record(
                                vec![
                                    ("0".to_owned(), region.clone()),
                                    ("1".to_owned(), region.clone()),
                                    ("2".to_owned(), Type::Opaque("Rejoin".to_owned())),
                                ]
                                .into(),
                            ),
                        ),
                        ("SplitOutOfBounds".to_owned(), region),
                    ]
                    .into(),
                    open: false,
                },
            )
        }
        "@region.join" => {
            let region = Type::Region(Rc::new(checker.fresh()));
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
                Type::Record(
                    vec![("0".to_owned(), witness.clone()), ("1".to_owned(), witness)].into(),
                ),
            )
        }
        "@region.freeze" => {
            let element = checker.fresh();
            curried(
                vec![Type::Region(Rc::new(element.clone()))],
                Type::Array(Rc::new(element)),
            )
        }
        "@array.empty" => Type::Array(Rc::new(checker.fresh_empty_array_element())),
        "@array.len" => curried(vec![Type::Array(Rc::new(checker.fresh()))], int),
        "@array.copy" => {
            let array = Type::Array(Rc::new(checker.fresh()));
            curried(vec![array.clone()], array)
        }
        "@array.get" => {
            let element = checker.fresh();
            curried(vec![Type::Array(Rc::new(element.clone())), int], element)
        }
        "@array.set" => {
            let element = checker.fresh();
            let array = Type::Array(Rc::new(element.clone()));
            curried(vec![array.clone(), int, element], array)
        }
        "@array.push" => {
            let element = checker.fresh();
            let array = Type::Array(Rc::new(element.clone()));
            curried(vec![array.clone(), element], array)
        }
        "@shape.empty" => Type::Record(Vec::new().into()),
        "@shape.names" => curried(vec![checker.fresh()], Type::Array(Rc::new(text))),
        "@shape.has" => curried(vec![checker.fresh(), text], bool_),
        "@shape.get" | "@shape.remove" => curried(vec![checker.fresh(), text], checker.fresh()),
        "@type.unbounded" | "@type.int" | "@type.text" | "@type.float" | "@type.float32"
        | "@type.f32x4" | "@type.f32x4_mask" | "@type.i32x4" | "@type.i32x4_mask"
        | "@type.i16x8" | "@type.i16x8_mask" | "@type.i8x16" | "@type.i8x16_mask" => {
            Type::Opaque("Type".to_owned())
        }
        "@type.unit" => Type::Unit,
        "@type.range"
        | "@type.refine"
        | "@type.union"
        | "@type.intersect"
        | "@type.diff"
        | "@type.arrow"
        | "@type.deferred_arrow"
        | "@type.performs"
        | "@type.instantiate" => curried(
            vec![checker.fresh(), checker.fresh()],
            Type::Opaque("Type".to_owned()),
        ),
        "@type.equal" => curried(vec![checker.fresh(), checker.fresh()], bool_),
        "@type.probe" => curried(vec![checker.fresh()], Type::Opaque("Type".to_owned())),
        "@type.of" | "@type.reflect" | "@type.members" | "@type.union_of" => {
            curried(vec![checker.fresh()], checker.fresh())
        }
        "@type.seal" => curried(vec![text, checker.fresh()], Type::Opaque("Type".to_owned())),
        "@linear.freeze" => {
            let array = Type::Array(Rc::new(checker.fresh()));
            curried(vec![array.clone()], array)
        }
        "@type.open" | "@linear.own" | "@linear.maybe" | "@linear.borrow" | "@assert.reuse"
        | "@branch.likely" | "@branch.unlikely" => {
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
        "@fail" | "@panic" => curried(vec![text], Type::Bottom),
        "@effect" | "@effect.host" | "@forall" | "@import" => {
            curried(vec![checker.fresh()], checker.fresh())
        }
        "@include" => {
            let result = checker.fresh();
            curried(
                vec![
                    text,
                    Type::Function {
                        deferred: false,
                        parameter: Rc::new(checker.fresh()),
                        effects: Rc::new(Type::Effects(BTreeSet::new())),
                        result: Rc::new(result.clone()),
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
            let array = Type::Array(Rc::new(element.clone()));
            curried(
                vec![array.clone(), int],
                Type::Record(vec![("0".to_owned(), element), ("1".to_owned(), array)].into()),
            )
        }
        "@array.split" => {
            let element = checker.fresh();
            let array = Type::Array(Rc::new(element.clone()));
            curried(
                vec![array.clone(), int],
                Type::Record(
                    vec![
                        ("0".to_owned(), array.clone()),
                        ("1".to_owned(), element),
                        ("2".to_owned(), array),
                    ]
                    .into(),
                ),
            )
        }
        "@array.indexed" => {
            let element = checker.fresh();
            let step_result = Type::Variant {
                cases: vec![
                    ("None".to_owned(), Type::Unit),
                    (
                        "Some".to_owned(),
                        Type::Record(
                            vec![
                                (
                                    "0".to_owned(),
                                    Type::Record(
                                        vec![
                                            ("0".to_owned(), int.clone()),
                                            ("1".to_owned(), element.clone()),
                                        ]
                                        .into(),
                                    ),
                                ),
                                ("1".to_owned(), int.clone()),
                            ]
                            .into(),
                        ),
                    ),
                ]
                .into(),
                open: false,
            };
            curried(
                vec![Type::Array(Rc::new(element))],
                Type::Record(
                    vec![
                        ("state".to_owned(), int.clone()),
                        ("step".to_owned(), curried(vec![int], step_result)),
                    ]
                    .into(),
                ),
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
            deferred: false,
            parameter: Rc::new(parameter),
            effects: Rc::new(Type::Effects(BTreeSet::new())),
            result: Rc::new(result),
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

fn statically_known_callee(
    module: &Module,
    expression: ExpressionId,
    environment: &TypeEnvironment,
) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => environment.binding_phase(name) == Some(Phase::Comptime),
        Expression::Field { target, .. } => statically_known_callee(module, *target, environment),
        _ => false,
    }
}

fn function_body(mut type_: &Type) -> &Type {
    while let Type::Forall { body, .. } = type_ {
        type_ = body;
    }
    type_
}

fn contains_function(type_: &Type) -> bool {
    match type_ {
        Type::Function { .. } => true,
        Type::Forall { body, .. }
        | Type::Array(body)
        | Type::Region(body)
        | Type::Scratch(body)
        | Type::OpenEffects { tail: body, .. } => contains_function(body),
        Type::Record(fields) | Type::Variant { cases: fields, .. } => {
            fields.iter().any(|(_, field)| contains_function(field))
        }
        Type::Union(members) => members.iter().any(contains_function),
        _ => false,
    }
}

fn ownership_uses_expression_type(type_: &Type) -> bool {
    match type_ {
        Type::Variable(_) | Type::Rigid(_) | Type::Top => true,
        Type::Forall { body, .. } => ownership_uses_expression_type(body),
        Type::Function { .. } | Type::Array(_) => true,
        Type::Range { .. }
        | Type::Unit
        | Type::Record(_)
        | Type::RecordUpdate { .. }
        | Type::Region(_)
        | Type::Scratch(_)
        | Type::Variant { .. }
        | Type::Effects(_)
        | Type::OpenEffects { .. }
        | Type::Union(_)
        | Type::Opaque(_)
        | Type::Bottom => false,
    }
}

fn function_result_contains_embedded_function(type_: &Type) -> bool {
    match type_ {
        Type::Forall { body, .. } => function_result_contains_embedded_function(body),
        Type::Function { result, .. } => match result.as_ref() {
            Type::Function { .. } => false,
            result => contains_function(result),
        },
        _ => false,
    }
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

fn applied_literal_import(
    module: &Module,
    function: ExpressionId,
    dependencies: &BTreeMap<String, Type>,
) -> Option<Type> {
    let Expression::Apply {
        function, argument, ..
    } = &module.arena.expressions[function.0 as usize]
    else {
        return None;
    };
    literal_import(module, *function, *argument, dependencies)
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

fn simplification_fact(
    module: &Module,
    expression: ExpressionId,
    values: &ValueEnvironment,
    context: &Rc<Context>,
) -> Option<SimplificationFact> {
    let (callee, arguments) = application_spine_ids(module, expression);
    if arguments.len() != 2 {
        return None;
    }
    let function = comptime_expression_value(module, callee, values)?;
    let equality = crate::recognise::comparison(context, &function);
    if equality == Some(BTreeSet::from([crate::recognise::Ordering::Equal])) {
        let (subject, pattern) = integer_equality_pattern(module, &arguments, values)?;
        return Some(SimplificationFact::IntegerEquality {
            expression,
            subject,
            pattern,
        });
    }
    if crate::recognise::short_circuit_junction(context, &function)
        == Some(crate::recognise::Junction::And)
    {
        return Some(SimplificationFact::ShortCircuitAnd {
            expression,
            left: arguments[0],
            right: arguments[1],
        });
    }
    None
}

fn integer_equality_pattern(
    module: &Module,
    arguments: &[ExpressionId],
    values: &ValueEnvironment,
) -> Option<(ExpressionId, IntegerEqualityPattern)> {
    let left = arguments[0];
    let right = arguments[1];
    let left_expression = &module.arena.expressions[left.0 as usize];
    let right_expression = &module.arena.expressions[right.0 as usize];
    match (left_expression, right_expression) {
        (Expression::Int { .. }, Expression::Int { .. }) => None,
        (_, Expression::Int { .. }) => {
            Some((left, IntegerEqualityPattern::Literal { expression: right }))
        }
        (Expression::Int { .. }, _) => {
            Some((right, IntegerEqualityPattern::Literal { expression: left }))
        }
        (_, Expression::Var { name, .. })
            if matches!(lookup(values, name), Some(Value::Int(_))) =>
        {
            Some((left, IntegerEqualityPattern::Pin { name: name.clone() }))
        }
        (Expression::Var { name, .. }, _)
            if matches!(lookup(values, name), Some(Value::Int(_))) =>
        {
            Some((right, IntegerEqualityPattern::Pin { name: name.clone() }))
        }
        _ => None,
    }
}

fn comparison_refinements(
    module: &Module,
    expression: ExpressionId,
    environment: &TypeEnvironment,
    values: &ValueEnvironment,
    checker: &Checker,
) -> Option<(String, Type, Type)> {
    if let Expression::If {
        branches,
        fallback: Some(fallback),
        ..
    } = &module.arena.expressions[expression.0 as usize]
        && let [branch] = branches.as_slice()
    {
        let left = comparison_refinements(module, branch.condition, environment, values, checker)?;
        let (right_expression, junction) = match (
            &module.arena.expressions[branch.consequence.0 as usize],
            &module.arena.expressions[fallback.0 as usize],
        ) {
            (_, Expression::Tag { name, .. }) if name == "False" => {
                (branch.consequence, crate::recognise::Junction::And)
            }
            (Expression::Tag { name, .. }, _) if name == "True" => {
                (*fallback, crate::recognise::Junction::Or)
            }
            _ => return None,
        };
        let right = comparison_refinements(module, right_expression, environment, values, checker)?;
        if left.0 != right.0 {
            return None;
        }
        let original = checker.settle(
            checker.instantiate(environment.lookup(&left.0, checker)?),
            true,
        );
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
        let original = checker.settle(
            checker.instantiate(environment.lookup(&left.0, checker)?),
            true,
        );
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
    let original = checker.settle(
        checker.instantiate(environment.lookup(&name, checker)?),
        true,
    );
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
        Type::Union(all.into())
    }
}

fn comptime_expression_value(
    module: &Module,
    expression: ExpressionId,
    values: &ValueEnvironment,
) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => lookup(values, name),
        Expression::Intrinsic { name, .. } => crate::primitives::constant(name),
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

fn comptime_stable_expression(
    module: &Module,
    expression: ExpressionId,
    environment: &TypeEnvironment,
) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Intrinsic { .. } => true,
        Expression::Var { name, .. } => environment.binding_phase(name) == Some(Phase::Comptime),
        Expression::Field { target, .. } => {
            comptime_stable_expression(module, *target, environment)
        }
        _ => false,
    }
}

fn expression_field_path(module: &Module, expression: ExpressionId) -> Option<Vec<String>> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => Some(vec![name.clone()]),
        Expression::Field { target, name, .. } => {
            let mut path = expression_field_path(module, *target)?;
            path.push(name.clone());
            Some(path)
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
                body: Rc::new(substitute_rigid(
                    Rc::unwrap_or_clone(body),
                    &inner_replacements,
                )),
            }
        }
        Type::Function {
            deferred,
            parameter,
            effects,
            result,
        } => Type::Function {
            deferred,
            parameter: Rc::new(substitute_rigid(
                Rc::unwrap_or_clone(parameter),
                replacements,
            )),
            effects: Rc::new(substitute_rigid(Rc::unwrap_or_clone(effects), replacements)),
            result: Rc::new(substitute_rigid(Rc::unwrap_or_clone(result), replacements)),
        },
        Type::Record(fields) => Type::Record(
            fields
                .into_iter()
                .map(|(name, field)| (name, substitute_rigid(field, replacements)))
                .collect(),
        ),
        Type::RecordUpdate { base, fields } => Type::RecordUpdate {
            base: Rc::new(substitute_rigid(Rc::unwrap_or_clone(base), replacements)),
            fields: fields
                .into_iter()
                .map(|(name, field)| (name, substitute_rigid(field, replacements)))
                .collect(),
        },
        Type::Array(element) => Type::Array(Rc::new(substitute_rigid(
            Rc::unwrap_or_clone(element),
            replacements,
        ))),
        Type::Region(element) => Type::Region(Rc::new(substitute_rigid(
            Rc::unwrap_or_clone(element),
            replacements,
        ))),
        Type::Scratch(element) => Type::Scratch(Rc::new(substitute_rigid(
            Rc::unwrap_or_clone(element),
            replacements,
        ))),
        Type::OpenEffects { labels, tail } => Type::OpenEffects {
            labels,
            tail: Rc::new(substitute_rigid(Rc::unwrap_or_clone(tail), replacements)),
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
    Constructor(String, Option<Rc<Witness>>),
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
                    witnesses.push(Witness::Constructor(name.clone(), Some(Rc::new(payload))));
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
                    witnesses.push(Witness::Constructor(name.clone(), Some(Rc::new(payload))));
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
        cases: merge_fields(cases).into(),
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

fn validate_declaration_tag(value: &Value, span: Span) -> Result<String, Diagnostic> {
    let Value::Shape(fields) = value else {
        return Err(Diagnostic::new(
            "BLOT_BAD_DECLARATION_TAG",
            "A declaration tag descriptor must be a record.",
            span,
        ));
    };
    let name = match fields.get("name") {
        Some(Value::Text(name)) if !name.is_empty() => name.clone(),
        _ => {
            return Err(Diagnostic::new(
                "BLOT_BAD_DECLARATION_TAG",
                "A declaration tag descriptor needs a non-empty text field `.name`.",
                span,
            ));
        }
    };
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
    Ok(name)
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
        add_function_effect(Rc::make_mut(body), label);
        return;
    }
    let Type::Function { effects, .. } = type_ else {
        return;
    };
    let effects = Rc::make_mut(effects);
    match effects {
        Type::Effects(labels) => {
            labels.insert(label);
        }
        Type::OpenEffects { labels, .. } => {
            labels.insert(label);
        }
        Type::Bottom => {
            *effects = Type::Effects(BTreeSet::from([label]));
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
    let Declaration::Binding {
        kind: group_kind,
        tags: group_tags,
        ..
    } = &module.arena.declarations[declaration_id.0 as usize]
    else {
        unreachable!("a recursive declaration is a binding")
    };
    if group_tags.is_empty()
        && declarations[..index]
            .iter()
            .rev()
            .find(|declaration| !signature_declaration(module, **declaration))
            .is_some_and(|declaration| {
                let Declaration::Binding { kind, tags, .. } =
                    &module.arena.declarations[declaration.0 as usize]
                else {
                    return false;
                };
                recursive_declaration(module, *declaration) && kind == group_kind && tags.is_empty()
            })
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
            tags,
            pattern,
            value,
            span,
            ..
        } = &module.arena.declarations[declaration_id.0 as usize]
        else {
            break;
        };
        if kind != group_kind || (!tags.is_empty() && !closures.is_empty()) {
            break;
        }
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
        if !tags.is_empty() {
            break;
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
        let mut recursive_closure_bodies = checker.recursive_closure_bodies.borrow_mut();
        for member in component {
            let (_, _, body) = closures[member];
            recursive_closure_bodies.insert(path.to_owned(), body, ());
        }
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
    let mut pending = vec![(node, 0)];
    while let Some((node, next_target)) = pending.last_mut() {
        if let Some(target) = graph[*node].get(*next_target).copied() {
            *next_target += 1;
            if !visited[target] {
                visited[target] = true;
                pending.push((target, 0));
            }
            continue;
        }
        order.push(*node);
        pending.pop();
    }
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
    let mut pending = vec![node];
    while let Some(node) = pending.pop() {
        component.push(node);
        for source in &reverse[node] {
            if !visited[*source] {
                visited[*source] = true;
                pending.push(*source);
            }
        }
    }
}

fn future_binding_names(module: &Module, declarations: &[DeclarationId]) -> BTreeSet<String> {
    declarations
        .iter()
        .flat_map(
            |declaration| match &module.arena.declarations[declaration.0 as usize] {
                Declaration::Signature { .. } => Vec::new(),
                Declaration::Binding { pattern, .. } => pattern_names(module, *pattern),
                Declaration::Shadow { .. } | Declaration::Open { .. } => Vec::new(),
            },
        )
        .collect()
}

fn declaration_closure_body(module: &Module, name: &str) -> Option<ExpressionId> {
    module.declarations.iter().find_map(|declaration| {
        let Declaration::Binding { pattern, value, .. } =
            &module.arena.declarations[declaration.0 as usize]
        else {
            return None;
        };
        let Pattern::Name {
            name: bound_name, ..
        } = &module.arena.patterns[pattern.0 as usize]
        else {
            return None;
        };
        if bound_name != name {
            return None;
        }
        match module.arena.expressions[value.0 as usize] {
            Expression::Lambda { body, .. } => Some(body),
            Expression::Rec { lambda, .. } => match module.arena.expressions[lambda.0 as usize] {
                Expression::Lambda { body, .. } => Some(body),
                _ => None,
            },
            _ => None,
        }
    })
}

fn remove_declaration_names(
    module: &Module,
    declaration: DeclarationId,
    names: &mut BTreeSet<String>,
) {
    if signature_declaration(module, declaration) {
        return;
    }
    let Declaration::Binding { pattern, .. } = &module.arena.declarations[declaration.0 as usize]
    else {
        return;
    };
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
        Declaration::Signature { .. }
    )
}

fn validate_signature_headers(
    module: &Module,
    declarations: &[DeclarationId],
) -> Result<(), Diagnostic> {
    for (index, declaration) in declarations.iter().enumerate() {
        let Declaration::Signature {
            kind: expected_kind,
            recursive: expected_recursive,
            name: expected_name,
            span,
            ..
        } = &module.arena.declarations[declaration.0 as usize]
        else {
            continue;
        };
        let Some(next) = declarations.get(index + 1) else {
            return Err(signature_target_diagnostic(
                expected_name,
                *expected_kind,
                *expected_recursive,
                None,
                *span,
            ));
        };
        let next = &module.arena.declarations[next.0 as usize];
        let Declaration::Binding {
            kind,
            pattern,
            value,
            ..
        } = next
        else {
            return Err(signature_target_diagnostic(
                expected_name,
                *expected_kind,
                *expected_recursive,
                None,
                *span,
            ));
        };
        let actual_name = match &module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => Some(name.as_str()),
            _ => None,
        };
        let actual_recursive = matches!(
            module.arena.expressions[value.0 as usize],
            Expression::Rec { .. }
        );
        if *kind == *expected_kind
            && actual_recursive == *expected_recursive
            && actual_name == Some(expected_name.as_str())
        {
            continue;
        }
        let actual = actual_name.map(|name| (*kind, actual_recursive, name));
        return Err(signature_target_diagnostic(
            expected_name,
            *expected_kind,
            *expected_recursive,
            actual,
            *span,
        ));
    }
    Ok(())
}

fn validate_module_signature_headers(module: &Module) -> Result<(), Diagnostic> {
    validate_signature_headers(module, &module.declarations)?;
    for expression in &module.arena.expressions {
        if let Expression::Block { declarations, .. } = expression {
            validate_signature_headers(module, declarations)?;
        }
    }
    Ok(())
}

fn signature_target_diagnostic(
    expected_name: &str,
    expected_kind: DeclarationKind,
    expected_recursive: bool,
    actual: Option<(DeclarationKind, bool, &str)>,
    span: Span,
) -> Diagnostic {
    let expected = declaration_header(expected_kind, expected_recursive, expected_name);
    let message = match actual {
        Some((kind, recursive, name)) => format!(
            "Signature header `{expected} ::` must be followed by `{}`, found `{}`.",
            declaration_header(expected_kind, expected_recursive, expected_name),
            declaration_header(kind, recursive, name),
        ),
        None => format!(
            "Signature header `{expected} ::` must be immediately followed by its matching binding."
        ),
    };
    Diagnostic::new("BLOT_SIGNATURE_TARGET", message, span)
}

fn declaration_header(kind: DeclarationKind, recursive: bool, name: &str) -> String {
    let kind = match kind {
        DeclarationKind::Let => "let",
        DeclarationKind::Const => "const",
        DeclarationKind::Effect => "effect",
    };
    if recursive {
        format!("{kind} rec {name}")
    } else {
        format!("{kind} {name}")
    }
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
    reify_type_with_holes(&Context::default(), type_, &mut next_hole)
}

fn reify_type_with_holes(context: &Context, type_: &Type, next_hole: &mut u32) -> Option<Value> {
    match type_ {
        Type::Bottom => {
            let hole = *next_hole;
            *next_hole = next_hole.checked_sub(1)?;
            Some(Value::TypeVariable(hole))
        }
        Type::Rigid(id) => Some(Value::TypeVariable(*id)),
        Type::Forall { variables, body } => {
            let mut body = reify_type_with_holes(context, body, next_hole)?;
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
                .map(|(name, type_)| {
                    Some((
                        name.clone(),
                        reify_type_with_holes(context, type_, next_hole)?,
                    ))
                })
                .collect::<Option<Vec<_>>>()?
                .into_iter()
                .collect(),
        )),
        Type::Array(element) => Some(Value::Array(
            vec![reify_type_with_holes(context, element, next_hole)?].into(),
        )),
        Type::Region(element) => Some(Value::RegionType(Box::new(reify_type_with_holes(
            context, element, next_hole,
        )?))),
        Type::Scratch(element) => Some(Value::ScratchType(Box::new(reify_type_with_holes(
            context, element, next_hole,
        )?))),
        Type::Variant { cases, open: false } => Some(Value::Union(
            cases
                .iter()
                .map(|(name, payload)| {
                    let payload = reify_type_with_holes(context, payload, next_hole)?;
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
            deferred,
            parameter,
            effects,
            result,
        } => {
            let (labels, effect_tail) = match effects.as_ref() {
                Type::Effects(labels) => (labels.clone(), None),
                Type::OpenEffects { labels, tail } => {
                    let Value::TypeVariable(tail) =
                        reify_type_with_holes(context, tail, next_hole)?
                    else {
                        return None;
                    };
                    (labels.clone(), Some(tail))
                }
                Type::Bottom => (BTreeSet::new(), None),
                _ => return None,
            };
            Some(Value::Arrow {
                deferred: *deferred,
                domain: Box::new(reify_type_with_holes(context, parameter, next_hole)?),
                codomain: Box::new(reify_type_with_holes(context, result, next_hole)?),
                effects: labels
                    .iter()
                    .map(|label| context.effect_value(label))
                    .collect::<Option<Vec<_>>>()?,
                effect_tail,
            })
        }
        Type::Union(members) => Some(Value::Union(
            members
                .iter()
                .map(|member| reify_type_with_holes(context, member, next_hole))
                .collect::<Option<Vec<_>>>()?,
        )),
        Type::Top => {
            let hole = *next_hole;
            *next_hole = next_hole.checked_sub(1)?;
            Some(Value::TypeVariable(hole))
        }
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
                deferred: left_deferred,
                parameter: left_parameter,
                effects: left_effects,
                result: left_result,
            },
            Type::Function {
                deferred: right_deferred,
                parameter: right_parameter,
                effects: right_effects,
                result: right_result,
            },
        ) => {
            left_deferred == right_deferred
                && same_type_with_rigids(left_parameter, right_parameter, rigids)
                && same_type_with_rigids(left_effects, right_effects, rigids)
                && same_type_with_rigids(left_result, right_result, rigids)
        }
        (Type::Record(left), Type::Record(right)) => same_fields(left, right, rigids),
        (Type::Array(left), Type::Array(right))
        | (Type::Region(left), Type::Region(right))
        | (Type::Scratch(left), Type::Scratch(right)) => same_type_with_rigids(left, right, rigids),
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
            ..
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

fn union_types(types: Vec<Type>) -> Type {
    fn append(members: &mut Vec<Type>, type_: Type) -> bool {
        UNION_VISITS.with(|visits| visits.set(visits.get() + 1));
        match type_ {
            Type::Bottom => true,
            Type::Top => false,
            Type::Union(nested) => nested.into_iter().all(|member| append(members, member)),
            type_ => {
                if !members
                    .iter()
                    .any(|existing| same_closed_type(existing, &type_))
                {
                    members.push(type_);
                }
                true
            }
        }
    }

    let mut members = Vec::new();
    if !types.into_iter().all(|type_| append(&mut members, type_)) {
        return Type::Top;
    }
    match members.len() {
        0 => Type::Bottom,
        1 => members.pop().expect("one union member exists"),
        _ => Type::Union(members.into()),
    }
}

fn same_closed_type(left: &Type, right: &Type) -> bool {
    fn fields(
        left: &[(String, Type)],
        right: &[(String, Type)],
        binders: &mut Vec<(VariableId, VariableId)>,
    ) -> bool {
        left.len() == right.len()
            && left.iter().all(|(name, type_)| {
                right
                    .iter()
                    .find(|(candidate, _)| candidate == name)
                    .is_some_and(|(_, candidate)| visit(type_, candidate, binders))
            })
    }

    fn visit(left: &Type, right: &Type, binders: &mut Vec<(VariableId, VariableId)>) -> bool {
        fn edge(
            left: &Rc<Type>,
            right: &Rc<Type>,
            binders: &mut Vec<(VariableId, VariableId)>,
        ) -> bool {
            Rc::ptr_eq(left, right) || visit(left, right, binders)
        }

        match (left, right) {
            (Type::Variable(left), Type::Variable(right)) => left == right,
            (Type::Rigid(left), Type::Rigid(right)) => {
                if let Some(bound_left) =
                    binders.iter().rev().find_map(|(bound_left, bound_right)| {
                        (bound_right == right).then_some(bound_left)
                    })
                {
                    return bound_left == left;
                }
                if binders
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
                let previous = binders.len();
                binders.extend(
                    left_variables
                        .iter()
                        .zip(right_variables)
                        .map(|(left, right)| (*left, *right)),
                );
                let same = edge(left_body, right_body, binders);
                binders.truncate(previous);
                same
            }
            (
                Type::Range {
                    domain: left_domain,
                    low: left_low,
                    high: left_high,
                },
                Type::Range {
                    domain: right_domain,
                    low: right_low,
                    high: right_high,
                },
            ) => left_domain == right_domain && left_low == right_low && left_high == right_high,
            (Type::Unit, Type::Unit) | (Type::Top, Type::Top) | (Type::Bottom, Type::Bottom) => {
                true
            }
            (
                Type::Function {
                    deferred: left_deferred,
                    parameter: left_parameter,
                    effects: left_effects,
                    result: left_result,
                },
                Type::Function {
                    deferred: right_deferred,
                    parameter: right_parameter,
                    effects: right_effects,
                    result: right_result,
                },
            ) => {
                left_deferred == right_deferred
                    && edge(left_parameter, right_parameter, binders)
                    && edge(left_effects, right_effects, binders)
                    && edge(left_result, right_result, binders)
            }
            (Type::Record(left), Type::Record(right)) => {
                left.ptr_eq(right) || fields(left, right, binders)
            }
            (Type::Array(left), Type::Array(right))
            | (Type::Region(left), Type::Region(right))
            | (Type::Scratch(left), Type::Scratch(right)) => edge(left, right, binders),
            (
                Type::Variant {
                    cases: left,
                    open: left_open,
                },
                Type::Variant {
                    cases: right,
                    open: right_open,
                },
            ) => left_open == right_open && (left.ptr_eq(right) || fields(left, right, binders)),
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
            ) => left_labels == right_labels && edge(left_tail, right_tail, binders),
            (Type::Union(left), Type::Union(right)) => {
                left.ptr_eq(right)
                    || left.len() == right.len()
                        && left.iter().all(|member| {
                            right
                                .iter()
                                .any(|candidate| visit(member, candidate, binders))
                        })
            }
            (Type::Opaque(left), Type::Opaque(right)) => left == right,
            _ => false,
        }
    }

    visit(left, right, &mut Vec::new())
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
            cases: merge_fields(variants).into(),
            open: false,
        };
    }
    other.extend(ranges);
    if !variants.is_empty() {
        other.push(Type::Variant {
            cases: merge_fields(variants).into(),
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
        return Type::Record(merge_fields(records.into_iter().flatten().collect()).into());
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
    expression_contains(
        module,
        expression,
        &|expression| matches!(expression, Expression::Intrinsic { name, .. } if name == intrinsic),
    )
}

fn expression_contains_computed_field(module: &Module, expression: ExpressionId) -> bool {
    expression_contains(module, expression, &|expression| {
        matches!(
            expression,
            Expression::Shape { members, .. }
                if members
                    .iter()
                    .any(|member| matches!(member, ShapeMember::Computed { .. }))
        )
    })
}

fn expression_contains(
    module: &Module,
    expression: ExpressionId,
    predicate: &impl Fn(&Expression) -> bool,
) -> bool {
    let expression = &module.arena.expressions[expression.0 as usize];
    if predicate(expression) {
        return true;
    }
    match expression {
        Expression::Apply {
            function, argument, ..
        } => {
            expression_contains(module, *function, predicate)
                || expression_contains(module, *argument, predicate)
        }
        Expression::Field { target, .. } => expression_contains(module, *target, predicate),
        Expression::Lambda { body, .. } | Expression::Rec { lambda: body, .. } => {
            expression_contains(module, *body, predicate)
        }
        Expression::Array { elements, .. } => elements
            .iter()
            .any(|element| expression_contains(module, element.value, predicate)),
        Expression::Tuple { elements, .. } => elements
            .iter()
            .any(|element| expression_contains(module, *element, predicate)),
        Expression::Shape { members, .. } => members.iter().any(|member| match member {
            ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                expression_contains(module, *value, predicate)
            }
            ShapeMember::Computed { name, value } => {
                expression_contains(module, *name, predicate)
                    || expression_contains(module, *value, predicate)
            }
        }),
        Expression::If {
            branches, fallback, ..
        } => {
            branches.iter().any(|branch| {
                expression_contains(module, branch.condition, predicate)
                    || expression_contains(module, branch.consequence, predicate)
            }) || fallback.is_some_and(|fallback| expression_contains(module, fallback, predicate))
        }
        Expression::Case { target, arms, .. } => {
            expression_contains(module, *target, predicate)
                || arms
                    .iter()
                    .any(|arm| expression_contains(module, arm.body, predicate))
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            declarations.iter().any(|declaration| {
                let value = match &module.arena.declarations[declaration.0 as usize] {
                    Declaration::Signature { value, .. }
                    | Declaration::Binding { value, .. }
                    | Declaration::Shadow { value, .. }
                    | Declaration::Open { value, .. } => *value,
                };
                expression_contains(module, value, predicate)
            }) || expression_contains(module, *result, predicate)
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
        Expression::Array { elements, .. } => elements
            .iter()
            .any(|element| expression_has_generic_reflection(module, element.value, bound)),
        Expression::Tuple { elements, .. } => elements
            .iter()
            .any(|element| expression_has_generic_reflection(module, *element, bound)),
        Expression::Shape { members, .. } => members.iter().any(|member| match member {
            ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                expression_has_generic_reflection(module, *value, bound)
            }
            ShapeMember::Computed { name, value } => {
                expression_has_generic_reflection(module, *name, bound)
                    || expression_has_generic_reflection(module, *value, bound)
            }
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
                    Declaration::Signature { value, .. }
                    | Declaration::Binding { value, .. }
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
        Expression::Shape { members, .. } => members.iter().any(|member| match member {
            ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                expression_references_bound(module, *value, bound)
            }
            ShapeMember::Computed { name, value } => {
                expression_references_bound(module, *name, bound)
                    || expression_references_bound(module, *value, bound)
            }
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
        | Expression::Rec { span, .. } => *span,
    }
}

fn specialization_binding(module: &Module, body: ExpressionId) -> (Span, Option<String>) {
    for declaration_id in &module.declarations {
        let Declaration::Binding {
            pattern,
            value,
            span,
            ..
        } = &module.arena.declarations[declaration_id.0 as usize]
        else {
            continue;
        };
        if closure_body(module, *value) != Some(body) {
            continue;
        }
        let name = match &module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => Some(name.clone()),
            _ => None,
        };
        return (*span, name);
    }
    (module.arena.expression_span(body), None)
}

fn closure_body(module: &Module, expression: ExpressionId) -> Option<ExpressionId> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Lambda { body, .. } => Some(*body),
        Expression::Rec { lambda, .. } => match &module.arena.expressions[lambda.0 as usize] {
            Expression::Lambda { body, .. } => Some(*body),
            _ => None,
        },
        _ => None,
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
        Expression::Field { target, .. } | Expression::Rec { lambda: target, .. } => {
            free_name_span(module, *target, name, bound)
        }
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
                match member {
                    ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                        if let Some(span) = free_name_span(module, *value, name, bound) {
                            return Some(span);
                        }
                    }
                    ShapeMember::Computed {
                        name: field_name,
                        value,
                    } => {
                        if let Some(span) = free_name_span(module, *field_name, name, bound) {
                            return Some(span);
                        }
                        if let Some(span) = free_name_span(module, *value, name, bound) {
                            return Some(span);
                        }
                    }
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
                    Declaration::Signature { value, .. } => {
                        if let Some(span) = free_name_span(module, *value, name, block_bound) {
                            return Some(span);
                        }
                    }
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

pub(crate) fn empty_effects(type_: &Type) -> bool {
    matches!(type_, Type::Bottom) || matches!(type_, Type::Effects(labels) if labels.is_empty())
}

fn nullary_unit_type(type_: &Type) -> bool {
    let Type::Function {
        parameter,
        effects,
        result,
        ..
    } = type_
    else {
        return false;
    };
    matches!(parameter.as_ref(), Type::Unit)
        && empty_effects(effects)
        && matches!(result.as_ref(), Type::Unit | Type::Bottom)
}

pub(crate) fn type_exposes_generative_effect(type_: &Type) -> bool {
    match type_ {
        Type::Forall { body, .. }
        | Type::Array(body)
        | Type::Region(body)
        | Type::Scratch(body) => type_exposes_generative_effect(body),
        Type::Function {
            parameter,
            effects,
            result,
            ..
        } => {
            type_exposes_generative_effect(parameter)
                || type_exposes_generative_effect(effects)
                || type_exposes_generative_effect(result)
        }
        Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
            .iter()
            .any(|(_, field)| type_exposes_generative_effect(field)),
        Type::RecordUpdate { base, fields } => {
            type_exposes_generative_effect(base)
                || fields
                    .iter()
                    .any(|(_, field)| type_exposes_generative_effect(field))
        }
        Type::Effects(labels) => !labels.is_empty(),
        Type::OpenEffects { labels, tail } => {
            !labels.is_empty() || type_exposes_generative_effect(tail)
        }
        Type::Union(members) => members.iter().any(type_exposes_generative_effect),
        Type::Opaque(name) => name.starts_with("Effect:"),
        Type::Variable(_)
        | Type::Rigid(_)
        | Type::Range { .. }
        | Type::Unit
        | Type::Top
        | Type::Bottom => false,
    }
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
            ..
        } => {
            closed_checked_type(parameter, bound)
                && closed_checked_type(effects, bound)
                && closed_checked_type(result, bound)
        }
        Type::Record(fields) | Type::Variant { cases: fields, .. } => fields
            .iter()
            .all(|(_, field)| closed_checked_type(field, bound)),
        Type::RecordUpdate { base, fields } => {
            closed_checked_type(base, bound)
                && fields
                    .iter()
                    .all(|(_, field)| closed_checked_type(field, bound))
        }
        Type::Array(element) | Type::Region(element) | Type::Scratch(element) => {
            closed_checked_type(element, bound)
        }
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
    types: &mut FlatTypeBuilder,
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
            let body = flatten_interface_type(body, bound, types);
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
            deferred,
            parameter,
            effects,
            result,
        } => FlatTypeNode::Function {
            deferred: *deferred,
            parameter: flatten_interface_type(parameter, bound, types)?,
            effects: flatten_interface_type(effects, bound, types)?,
            result: flatten_interface_type(result, bound, types)?,
        },
        Type::Record(fields) => FlatTypeNode::Record(
            fields
                .iter()
                .map(|(name, type_)| {
                    Some((name.clone(), flatten_interface_type(type_, bound, types)?))
                })
                .collect::<Option<Vec<_>>>()?,
        ),
        Type::RecordUpdate { base, fields } => FlatTypeNode::RecordUpdate {
            base: flatten_interface_type(base, bound, types)?,
            fields: fields
                .iter()
                .map(|(name, type_)| {
                    Some((name.clone(), flatten_interface_type(type_, bound, types)?))
                })
                .collect::<Option<Vec<_>>>()?,
        },
        Type::Array(element) => FlatTypeNode::Array(flatten_interface_type(element, bound, types)?),
        Type::Region(element) => {
            FlatTypeNode::Region(flatten_interface_type(element, bound, types)?)
        }
        Type::Scratch(element) => {
            FlatTypeNode::Scratch(flatten_interface_type(element, bound, types)?)
        }
        Type::Variant { cases, open } => FlatTypeNode::Variant {
            cases: cases
                .iter()
                .map(|(name, type_)| {
                    Some((name.clone(), flatten_interface_type(type_, bound, types)?))
                })
                .collect::<Option<Vec<_>>>()?,
            open: *open,
        },
        Type::Union(members) => FlatTypeNode::Union(
            members
                .iter()
                .map(|member| flatten_interface_type(member, bound, types))
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
            tail: flatten_interface_type(tail, bound, types)?,
        },
        Type::Opaque(name) => FlatTypeNode::Opaque(name.clone()),
        Type::Top => FlatTypeNode::Top,
        Type::Bottom => FlatTypeNode::Bottom,
    };
    Some(types.intern(node))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn certificate_with_result(
        mut types: Vec<FlatTypeNode>,
        result: FlatTypeId,
    ) -> CheckedModuleCertificate {
        let effects = FlatTypeId(types.len() as u32);
        types.push(FlatTypeNode::Effects(BTreeSet::new()));
        CheckedModuleCertificate {
            schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            types,
            result,
            effects,
            parameter: None,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        }
    }

    fn nested_array_certificate(depth: usize) -> CheckedModuleCertificate {
        let mut types = vec![FlatTypeNode::Unit];
        let mut result = FlatTypeId(0);
        for _ in 0..depth {
            result = FlatTypeId(types.len() as u32);
            types.push(FlatTypeNode::Array(FlatTypeId(result.0 - 1)));
        }
        certificate_with_result(types, result)
    }

    fn duplicating_union_certificate(depth: usize) -> CheckedModuleCertificate {
        let mut types = vec![FlatTypeNode::Unit];
        let mut result = FlatTypeId(0);
        for _ in 0..depth {
            let previous = result;
            result = FlatTypeId(types.len() as u32);
            types.push(FlatTypeNode::Union(vec![previous, previous]));
        }
        certificate_with_result(types, result)
    }

    fn nested_union_certificate(depth: usize) -> CheckedModuleCertificate {
        let mut types = vec![FlatTypeNode::Unit];
        let mut result = FlatTypeId(0);
        for _ in 0..depth {
            let previous = result;
            result = FlatTypeId(types.len() as u32);
            types.push(FlatTypeNode::Union(vec![previous]));
        }
        certificate_with_result(types, result)
    }

    fn cache_checked(checked: &CheckedModule) -> CachedModuleInterface {
        CachedModuleInterface::from_checked(checked)
            .expect("closed test interface must pass artifact admission")
            .expect("test interface must be closed")
    }

    #[test]
    fn exposed_effect_identity_prevents_module_result_reuse() {
        let ordinary = Type::Record(
            vec![(
                "identity".to_owned(),
                Type::Function {
                    deferred: false,
                    parameter: Rc::new(Type::Rigid(1)),
                    effects: Rc::new(Type::Effects(BTreeSet::new())),
                    result: Rc::new(Type::Rigid(1)),
                },
            )]
            .into(),
        );
        let generative = Type::Record(
            vec![(
                "Console".to_owned(),
                Type::Opaque("Effect:7:Console".to_owned()),
            )]
            .into(),
        );

        assert!(!type_exposes_generative_effect(&ordinary));
        assert!(type_exposes_generative_effect(&generative));
    }

    #[test]
    fn seal_identity_is_canonical_and_carrier_sensitive() {
        let integer = Type::Range {
            domain: Domain::Int,
            low: None,
            high: None,
        };
        let text = Type::Range {
            domain: Domain::Text,
            low: None,
            high: None,
        };
        let left_record = Type::Record(
            vec![
                ("number".to_owned(), integer.clone()),
                ("label".to_owned(), text.clone()),
            ]
            .into(),
        );
        let right_record = Type::Record(
            vec![
                ("label".to_owned(), text.clone()),
                ("number".to_owned(), integer.clone()),
            ]
            .into(),
        );

        assert!(same_type(
            &sealed_type("Box", &left_record).expect("closed carrier"),
            &sealed_type("Box", &right_record).expect("closed carrier"),
        ));
        assert!(!same_type(
            &sealed_type("Box", &integer).expect("closed carrier"),
            &sealed_type("Box", &text).expect("closed carrier"),
        ));

        let left_identity = Type::Forall {
            variables: vec![7],
            body: Rc::new(Type::Rigid(7)),
        };
        let right_identity = Type::Forall {
            variables: vec![19],
            body: Rc::new(Type::Rigid(19)),
        };
        assert!(same_type(
            &sealed_type("Identity", &left_identity).expect("closed carrier"),
            &sealed_type("Identity", &right_identity).expect("closed carrier"),
        ));
    }

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
        let signature = reify_type(&Type::Record(
            vec![
                ("left".to_owned(), Type::Bottom),
                ("right".to_owned(), Type::Bottom),
            ]
            .into(),
        ))
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
    fn residual_top_positions_get_distinct_representation_holes() {
        let signature = reify_type(&Type::Record(
            vec![
                ("left".to_owned(), Type::Top),
                ("right".to_owned(), Type::Top),
            ]
            .into(),
        ))
        .expect("top positions should reify as representation holes");
        let Value::Shape(fields) = signature else {
            panic!("record signature did not reify as a shape");
        };
        let Some(Value::TypeVariable(left)) = fields.get("left") else {
            panic!("left top position lost its representation hole");
        };
        let Some(Value::TypeVariable(right)) = fields.get("right") else {
            panic!("right top position lost its representation hole");
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
        let store = Type::Array(Rc::new(int_type()));
        let recursive_bound = checker.constraint_type(&Type::Array(Rc::new(recursive.clone())));
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
            ]
            .into(),
            open: false,
        });
        checker.variables.borrow_mut()[variable as usize].lower = vec![recursive_bound];

        let (residual, recursive) = checker.residual_signature_analysis(recursive);

        assert!(recursive);
        assert!(matches!(residual, Type::Forall { .. }));
    }

    #[test]
    fn residual_region_signature_reifies_for_recursive_lowering() {
        let checker = Checker::new(Rc::new(Context::default()));
        let region = Type::Region(Rc::new(int_type()));
        let signature = Type::Function {
            deferred: false,
            parameter: Rc::new(region.clone()),
            effects: Rc::new(Type::Effects(BTreeSet::new())),
            result: Rc::new(region),
        };

        let Some(Value::Arrow {
            domain, codomain, ..
        }) = checker.reify_runtime_type(&signature)
        else {
            panic!("Region closure signature was not reified");
        };
        assert!(matches!(*domain, Value::RegionType(_)));
        assert!(matches!(*codomain, Value::RegionType(_)));
    }

    #[test]
    fn residual_recursive_union_uses_its_non_recursive_lower_bound() {
        let checker = Checker::new(Rc::new(Context::default()));
        let recursive = checker.fresh();
        let Type::Variable(variable) = recursive.clone() else {
            unreachable!("fresh always returns a variable")
        };
        let store = Type::Array(Rc::new(int_type()));
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
        let state = Type::Record(vec![("value".to_owned(), int_type())].into());
        let control = Type::Variant {
            cases: vec![("LoopContinue$1$2".to_owned(), state.clone())].into(),
            open: false,
        };

        let residual = checker.residual_signature(Type::Union(vec![state, control.clone()].into()));

        assert!(same_type(&residual, &control));
    }

    #[test]
    fn cached_interfaces_instantiate_bound_rigids_freshly() {
        let checked = CheckedModule {
            result: Type::Forall {
                variables: vec![7],
                body: Rc::new(Type::Rigid(7)),
            },
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let cached = cache_checked(&checked);
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
    fn checked_certificate_at_the_reference_path_limit_is_safe_to_seal_and_inflate() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let cached = CachedModuleInterface::from_certificate(nested_array_certificate(
                    ARTIFACT_REFERENCE_PATH_LIMIT,
                ))
                .expect("a certificate at the reference-path limit must be admitted");
                cached
                    .sealed_boundary_bytes()
                    .expect("an admitted interface must be safe to seal");
                let checker = Checker::new(Rc::new(Context::default()));
                let inflated = checker.inflate_interface("depth-limit", cached);
                assert!(matches!(&inflated.result, Type::Array(_)));
            })
            .expect("small-stack certificate thread must start")
            .join()
            .expect("at-limit certificate consumers must not overflow");
    }

    #[test]
    fn checked_certificate_seals_nested_unions_at_the_reference_path_limit() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let cached = CachedModuleInterface::from_certificate(nested_union_certificate(
                    ARTIFACT_REFERENCE_PATH_LIMIT,
                ))
                .expect("a union certificate at the reference-path limit must be admitted");
                cached
                    .sealed_boundary_bytes()
                    .expect("an admitted union interface must be safe to seal");
            })
            .expect("small-stack union certificate thread must start")
            .join()
            .expect("at-limit union sealing must not overflow");
    }

    #[test]
    fn checked_certificate_rejects_a_reference_path_over_the_limit() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let error = match CachedModuleInterface::from_certificate(nested_array_certificate(
                    ARTIFACT_REFERENCE_PATH_LIMIT + 1,
                )) {
                    Ok(_) => panic!("an over-limit certificate must be refused"),
                    Err(error) => error,
                };
                assert!(error.contains("reference-path depth 129, maximum is 128"));
            })
            .expect("small-stack certificate thread must start")
            .join()
            .expect("over-limit certificate validation must not overflow");
    }

    #[test]
    fn checked_certificate_rejects_a_shallow_expansion_bomb() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let error = match CachedModuleInterface::from_certificate(
                    duplicating_union_certificate(20),
                ) {
                    Ok(_) => panic!("an over-budget expanded DAG must be refused"),
                    Err(error) => error,
                };
                assert!(
                    error.contains("expand to at least 1048577 references, maximum is 1048576")
                );
            })
            .expect("small-stack certificate thread must start")
            .join()
            .expect("expanded-reference certificate validation must not overflow");
    }

    #[test]
    fn cached_private_type_facts_are_reified_on_demand() {
        let checked = CheckedModule {
            result: Type::Unit,
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: vec![(ExpressionId(7), Type::Unit)],
            closure_signatures: vec![(ExpressionId(8), Type::Unit)],
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let cached = cache_checked(&checked);
        let context = Rc::new(Context::default());
        let checker = Checker::new(context.clone());

        let inflated = checker.inflate_interface("cached", cached.clone());

        assert!(inflated.expression_types.is_empty());
        assert!(inflated.closure_signatures.is_empty());
        assert!(context.expression_types.borrow().is_empty());
        assert!(context.closure_signatures.borrow().is_empty());
        assert!(matches!(
            context.expression_type("cached", ExpressionId(7)),
            Some(Value::Unit)
        ));
        assert!(matches!(
            context.closure_signature("cached", ExpressionId(8)),
            Some(Value::Unit)
        ));

        checker
            .module_interfaces
            .borrow_mut()
            .insert("cached".to_owned(), cached);
        checker
            .modules
            .borrow_mut()
            .insert("cached".to_owned(), Ok(inflated));
        let certificate = checker
            .certificate("cached")
            .expect("the cached certificate should remain complete");
        assert_eq!(certificate.expression_types.len(), 1);
        assert_eq!(certificate.closure_signatures.len(), 1);
    }

    #[test]
    fn invalidation_removes_only_changed_module_facts_and_call_sites() {
        let checker = Checker::new(Rc::new(Context::default()));
        checker.analysis_expression_types.borrow_mut().insert(
            "changed.blot".to_owned(),
            ExpressionId(1),
            Type::Unit,
        );
        checker.analysis_expression_types.borrow_mut().insert(
            "unchanged.blot".to_owned(),
            ExpressionId(2),
            Type::Unit,
        );
        let retained_span = Span { start: 3, end: 4 };
        let mut specialization = SpecializationBinding::default();
        specialization.keys.insert(
            "Int".to_owned(),
            SpecializationKey {
                reason: "test representation",
                call_sites: vec![
                    ("changed.blot".to_owned(), Span { start: 1, end: 2 }),
                    ("unchanged.blot".to_owned(), retained_span),
                ],
            },
        );
        checker.specializations.borrow_mut().insert(
            "unchanged.blot".to_owned(),
            ExpressionId(3),
            specialization,
        );

        checker.invalidate(&HashSet::from(["changed.blot".to_owned()]));

        assert!(
            checker
                .analysis_expression_types
                .borrow()
                .module("changed.blot")
                .is_none()
        );
        assert!(
            checker
                .analysis_expression_types
                .borrow()
                .get("unchanged.blot", &ExpressionId(2))
                .is_some()
        );
        let specializations = checker.specializations.borrow();
        let retained = specializations
            .get("unchanged.blot", &ExpressionId(3))
            .expect("unchanged specialization should remain");
        assert_eq!(
            retained.keys["Int"].call_sites,
            vec![("unchanged.blot".to_owned(), retained_span)]
        );
    }

    #[test]
    fn sealed_boundaries_are_alpha_canonical_and_ignore_private_facts() {
        let interface = |variable, private_type| CheckedModule {
            result: Type::Forall {
                variables: vec![variable],
                body: Rc::new(Type::Record(
                    vec![("value".to_owned(), Type::Rigid(variable))].into(),
                )),
            },
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: vec![(ExpressionId(99), private_type)],
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let first = cache_checked(&interface(7, Type::Unit))
            .sealed_boundary_bytes()
            .expect("first boundary should serialize");
        let second = cache_checked(&interface(42, int_type()))
            .sealed_boundary_bytes()
            .expect("second boundary should serialize");

        assert_eq!(first, second);
        let decoded =
            SealedModuleBoundary::from_bytes(&first).expect("canonical boundary should round-trip");
        assert_eq!(decoded.schema, SealedModuleBoundary::SCHEMA);
        assert_eq!(decoded.compiler_semantic_version, env!("CARGO_PKG_VERSION"),);
    }

    #[test]
    fn sealed_boundaries_canonicalize_union_member_order() {
        let integer = Type::Range {
            domain: Domain::Int,
            low: None,
            high: None,
        };
        let text = Type::Range {
            domain: Domain::Text,
            low: None,
            high: None,
        };
        let boundary = |members| CheckedModule {
            result: Type::Union(members),
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let first = cache_checked(&boundary(vec![integer.clone(), text.clone()].into()))
            .sealed_boundary_bytes()
            .expect("first union boundary should serialize");
        let second = cache_checked(&boundary(vec![text, integer].into()))
            .sealed_boundary_bytes()
            .expect("second union boundary should serialize");

        assert_eq!(first, second);
    }

    #[test]
    fn sealed_boundary_flat_keys_match_closed_type_keys() {
        let type_ = Type::Forall {
            variables: vec![7],
            body: Rc::new(Type::Record(
                vec![
                    ("zeta".to_owned(), Type::Array(Rc::new(Type::Rigid(7)))),
                    (
                        "alpha".to_owned(),
                        Type::Union(vec![Type::Unit, int_type()].into()),
                    ),
                ]
                .into(),
            )),
        };
        let mut builder = FlatTypeBuilder::default();
        let root = flatten_interface_type(&type_, &mut HashSet::new(), &mut builder)
            .expect("representative closed type must flatten");
        let arena = FlatTypeArena {
            nodes: builder.nodes,
        };
        let expected = closed_type_key(&Type::Forall {
            variables: Vec::new(),
            body: Rc::new(type_),
        })
        .expect("representative type must have a closed key");

        assert_eq!(closed_boundary_type_key(&arena, root, &[]), Some(expected));
    }

    #[test]
    fn sealed_boundaries_change_with_public_types() {
        let interface = |result| CheckedModule {
            result,
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let first = cache_checked(&interface(Type::Unit))
            .sealed_boundary_bytes()
            .expect("first boundary should serialize");
        let second = cache_checked(&interface(int_type()))
            .sealed_boundary_bytes()
            .expect("second boundary should serialize");

        assert_ne!(first, second);
    }

    #[test]
    fn cached_interfaces_reject_mutable_inference_variables() {
        let checked = CheckedModule {
            result: Type::Variable(0),
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };

        assert!(matches!(
            CachedModuleInterface::from_checked(&checked),
            Ok(None)
        ));
    }

    #[test]
    fn cached_interfaces_reject_types_over_the_artifact_reference_path_limit() {
        let mut result = Type::Unit;
        for _ in 0..=ARTIFACT_REFERENCE_PATH_LIMIT {
            result = Type::Array(Rc::new(result));
        }
        let checked = CheckedModule {
            result,
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: Vec::new(),
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };

        let error = match CachedModuleInterface::from_checked(&checked) {
            Ok(_) => panic!("an over-limit checked interface must be refused"),
            Err(error) => error,
        };
        assert!(error.contains("reference-path depth 129, maximum is 128"));

        let checker = Checker::new(Rc::new(Context::default()));
        checker
            .modules
            .borrow_mut()
            .insert("over-limit".to_owned(), Ok(checked));
        let error = match checker.certificate("over-limit") {
            Ok(_) => panic!("certificate export must refuse an over-limit checked interface"),
            Err(error) => error,
        };
        assert!(error.contains("reference-path depth 129, maximum is 128"));
    }

    #[test]
    fn recursive_closure_certificate_rejects_an_unknown_body() {
        let checked = CheckedModule {
            result: Type::Unit,
            effects: Type::Effects(BTreeSet::new()),
            parameter: None,
            evaluated: None,
            expression_types: Vec::new(),
            closure_signatures: vec![(ExpressionId(7), Type::Unit)],
            recursive_closures: vec![ExpressionId(8)],
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let cached = cache_checked(&checked);

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
            expression_types: Vec::new(),
            closure_signatures: vec![(ExpressionId(7), Type::Unit)],
            recursive_closures: Vec::new(),
            ownership_contracts: vec![(
                ExpressionId(8),
                crate::ownership::OwnershipContract {
                    parameter: PatternId(0),
                    input: crate::ownership::Produced::None,
                    result: crate::ownership::Produced::None,
                    callback_requirements: Vec::new(),
                },
            )],
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let cached = cache_checked(&checked);

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
        let left = Type::Record(vec![("value".to_owned(), variable)].into());
        let right = Type::Union(
            vec![Type::Record(
                vec![
                    ("value".to_owned(), int_type()),
                    ("missing".to_owned(), int_type()),
                ]
                .into(),
            )]
            .into(),
        );

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
        let left = Type::Record(vec![("value".to_owned(), variable)].into());
        let right = Type::Union(
            vec![
                Type::Record(
                    vec![
                        ("value".to_owned(), int_type()),
                        ("missing".to_owned(), int_type()),
                    ]
                    .into(),
                ),
                Type::Record(vec![("value".to_owned(), text_type())].into()),
            ]
            .into(),
        );

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
            ]
            .into(),
            open: false,
        };
        let second = Type::Variant {
            cases: vec![
                ("Right".to_owned(), Type::Unit),
                ("Left".to_owned(), Type::Unit),
            ]
            .into(),
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
                Type::Array(Rc::new(Type::Variable(deep_id))),
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
                    deferred: false,
                    parameter: Rc::new(Type::Unit),
                    effects: Rc::new(callback_effects.clone()),
                    result: Rc::new(Type::Unit),
                },
                Span { start: 0, end: 0 },
            )
            .expect("the callback parameter is callable");
        checker
            .constrain(
                parameter.clone(),
                Type::Record(vec![("0".to_owned(), callback)].into()),
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
            deferred: false,
            parameter: Rc::new(parameter),
            effects: Rc::new(wrapper_effects),
            result: Rc::new(Type::Unit),
        };
        checker.level.set(0);
        let wrapper = checker.freshen(wrapper, 0, &mut HashMap::new());
        let performed = checker.fresh();
        checker
            .constrain(
                wrapper,
                Type::Function {
                    deferred: false,
                    parameter: Rc::new(Type::Record(
                        vec![(
                            "0".to_owned(),
                            Type::Function {
                                deferred: false,
                                parameter: Rc::new(Type::Unit),
                                effects: Rc::new(Type::Effects(BTreeSet::from([
                                    "Access".to_owned()
                                ]))),
                                result: Rc::new(Type::Unit),
                            },
                        )]
                        .into(),
                    )),
                    effects: Rc::new(performed.clone()),
                    result: Rc::new(Type::Unit),
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
            body: Rc::new(Type::Function {
                deferred: false,
                parameter: Rc::new(Type::Rigid(7)),
                effects: Rc::new(Type::Effects(BTreeSet::new())),
                result: Rc::new(Type::Rigid(7)),
            }),
        };
        let integer_identity = Type::Function {
            deferred: false,
            parameter: Rc::new(int_type()),
            effects: Rc::new(Type::Effects(BTreeSet::new())),
            result: Rc::new(int_type()),
        };

        checker
            .constrain(identity, integer_identity, Span { start: 0, end: 0 })
            .expect("a polymorphic identity can be instantiated at Int");
    }

    #[test]
    fn forall_equality_ignores_bound_rigid_names() {
        let left = Type::Forall {
            variables: vec![7],
            body: Rc::new(Type::Function {
                deferred: false,
                parameter: Rc::new(Type::Rigid(7)),
                effects: Rc::new(Type::Effects(BTreeSet::new())),
                result: Rc::new(Type::Rigid(7)),
            }),
        };
        let right = Type::Forall {
            variables: vec![91],
            body: Rc::new(Type::Function {
                deferred: false,
                parameter: Rc::new(Type::Rigid(91)),
                effects: Rc::new(Type::Effects(BTreeSet::new())),
                result: Rc::new(Type::Rigid(91)),
            }),
        };

        assert!(same_type(&left, &right));
    }

    #[test]
    fn forall_equality_does_not_capture_a_free_rigid() {
        let bound = Type::Forall {
            variables: vec![7],
            body: Rc::new(Type::Rigid(7)),
        };
        let free = Type::Forall {
            variables: vec![91],
            body: Rc::new(Type::Rigid(7)),
        };

        assert!(!same_type(&bound, &free));
    }

    #[test]
    fn monomorphic_function_does_not_satisfy_a_forall_requirement() {
        let checker = Checker::new(Rc::new(Context::default()));
        let integer_identity = Type::Function {
            deferred: false,
            parameter: Rc::new(int_type()),
            effects: Rc::new(Type::Effects(BTreeSet::new())),
            result: Rc::new(int_type()),
        };
        let identity_requirement = Type::Forall {
            variables: vec![7],
            body: Rc::new(Type::Function {
                deferred: false,
                parameter: Rc::new(Type::Rigid(7)),
                effects: Rc::new(Type::Effects(BTreeSet::new())),
                result: Rc::new(Type::Rigid(7)),
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
            body: Rc::new(Type::Rigid(7)),
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
            &Type::Union(
                vec![
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
                ]
                .into()
            )
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

    #[test]
    fn closed_unions_have_one_canonical_form() {
        let one = Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(1.into())),
            high: Some(Scalar::Int(1.into())),
        };
        assert!(same_type(
            &union_types(vec![
                Type::Bottom,
                one.clone(),
                Type::Union(vec![one.clone()].into()),
            ]),
            &one,
        ));
        assert!(matches!(
            union_types(vec![one.clone(), Type::Top]),
            Type::Top
        ));
        assert!(same_closed_type(
            &union_types(vec![
                Type::Range {
                    domain: Domain::Int,
                    low: Some(Scalar::Int(2.into())),
                    high: Some(Scalar::Int(2.into())),
                },
                one.clone(),
            ]),
            &union_types(vec![
                one,
                Type::Range {
                    domain: Domain::Int,
                    low: Some(Scalar::Int(2.into())),
                    high: Some(Scalar::Int(2.into())),
                },
            ]),
        ));
    }
}
