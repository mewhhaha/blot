//! Qualified attached-member requirements. These are compile-time obligations,
//! not runtime dictionaries and not signatures selected from operator spellings.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MemberRequirement<T> {
    pub name: String,
    pub subject: T,
    pub member: T,
}

impl<T> MemberRequirement<T> {
    pub(super) fn map<U>(self, mut f: impl FnMut(T) -> U) -> MemberRequirement<U> {
        MemberRequirement {
            name: self.name,
            subject: f(self.subject),
            member: f(self.member),
        }
    }

    pub(super) fn map_ref<U>(&self, mut f: impl FnMut(&T) -> U) -> MemberRequirement<U> {
        MemberRequirement {
            name: self.name.clone(),
            subject: f(&self.subject),
            member: f(&self.member),
        }
    }
}

#[derive(Clone)]
struct PendingMember {
    requirement: MemberRequirement<Type>,
    discharged: bool,
}

#[derive(Clone, Default)]
pub(super) struct MemberConstraints {
    entries: Vec<PendingMember>,
    identities: HashMap<(String, ConstraintTypeId, ConstraintTypeId), usize>,
    variables: HashMap<VariableId, BTreeSet<usize>>,
    queued: BTreeSet<usize>,
}

impl MemberConstraints {
    pub(super) fn changed(&mut self, variable: VariableId) {
        if let Some(entries) = self.variables.get(&variable) {
            self.queued.extend(entries.iter().copied());
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }
}

impl Checker {
    /// Lookup needs evidence for the receiver, not a numeric default. Positive
    /// evidence describes an actual value. A closed upper numeric domain (or
    /// exact opaque type) also suffices: every possible inhabitant has that
    /// domain, and subsequent applications still check the selected signature.
    /// In particular, an unconstrained upper Top is never a lookup subject.
    pub(super) fn member_lookup_subject(&self, type_: &Type) -> Option<Type> {
        let mut subject = self.settle(type_.clone(), true);
        if matches!(subject, Type::Bottom | Type::Top) {
            let upper = self.settle(type_.clone(), false);
            if type_domain(&upper).is_some() || matches!(upper, Type::Opaque(_)) {
                subject = upper;
            }
        }
        (!matches!(subject, Type::Top)
            && !contains_bottom(&subject)
            && closed_checked_type(&subject, &mut HashSet::new())
            && operator_dispatch_type_is_concrete(&subject))
        .then_some(subject)
    }

    /// Include graph edges as well as syntactic occurrences. A member's result
    /// and effects can become connected to a function only after an application.
    fn member_variable_ids(&self, type_: &Type) -> BTreeSet<VariableId> {
        let mut pending = vec![self.constraint_type(type_)];
        let mut visited = HashSet::new();
        let mut variables = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            let node = self.constraint_types.borrow().nodes[id.0 as usize].clone();
            match node {
                ConstraintTypeNode::Variable(variable) => {
                    variables.insert(variable);
                    let source = self.variables.borrow()[variable as usize].clone();
                    pending.extend(source.lower);
                    pending.extend(source.upper);
                }
                ConstraintTypeNode::Forall { body, .. } => pending.push(body),
                ConstraintTypeNode::Qualified { requirements, body } => {
                    pending.push(body);
                    for requirement in requirements {
                        pending.extend([requirement.subject, requirement.member]);
                    }
                }
                ConstraintTypeNode::Function {
                    parameter,
                    effects,
                    result,
                    ..
                } => {
                    pending.extend([parameter, effects, result]);
                }
                ConstraintTypeNode::Record(fields)
                | ConstraintTypeNode::Variant { cases: fields, .. } => {
                    pending.extend(fields.into_iter().map(|(_, field)| field));
                }
                ConstraintTypeNode::RecordUpdate { base, fields } => {
                    pending.push(base);
                    pending.extend(fields.into_iter().map(|(_, field)| field));
                }
                ConstraintTypeNode::Array(element)
                | ConstraintTypeNode::Region(element)
                | ConstraintTypeNode::Scratch(element) => pending.push(element),
                ConstraintTypeNode::OpenEffects { tail, .. } => pending.push(tail),
                ConstraintTypeNode::Union(members) => pending.extend(members),
                ConstraintTypeNode::Rigid(_)
                | ConstraintTypeNode::Range { .. }
                | ConstraintTypeNode::Unit
                | ConstraintTypeNode::Effects(_)
                | ConstraintTypeNode::Opaque(_)
                | ConstraintTypeNode::Top
                | ConstraintTypeNode::Bottom => {}
            }
        }
        variables
    }

    fn index_member_requirement(&self, id: usize, requirement: &MemberRequirement<Type>) {
        let mut variables = self.member_variable_ids(&requirement.subject);
        variables.extend(self.member_variable_ids(&requirement.member));
        let mut constraints = self.member_constraints.borrow_mut();
        for variable in variables {
            constraints
                .variables
                .entry(variable)
                .or_default()
                .insert(id);
        }
    }

    pub(super) fn register_member_requirement(&self, requirement: MemberRequirement<Type>) {
        let identity = (
            requirement.name.clone(),
            self.constraint_type(&requirement.subject),
            self.constraint_type(&requirement.member),
        );
        let id = {
            let mut constraints = self.member_constraints.borrow_mut();
            if constraints.identities.contains_key(&identity) {
                return;
            }
            let id = constraints.entries.len();
            constraints.identities.insert(identity, id);
            constraints.entries.push(PendingMember {
                requirement: requirement.clone(),
                discharged: false,
            });
            constraints.queued.insert(id);
            id
        };
        self.index_member_requirement(id, &requirement);
    }

    fn reachable_member_requirements(&self, type_: &Type) -> Vec<MemberRequirement<Type>> {
        let mut pending = self
            .member_variable_ids(type_)
            .into_iter()
            .collect::<Vec<_>>();
        let mut variables = BTreeSet::new();
        let mut selected = BTreeSet::new();
        while let Some(variable) = pending.pop() {
            if !variables.insert(variable) {
                continue;
            }
            let ids = self
                .member_constraints
                .borrow()
                .variables
                .get(&variable)
                .cloned();
            for id in ids.into_iter().flatten() {
                let entry = self.member_constraints.borrow().entries[id].clone();
                if entry.discharged || !selected.insert(id) {
                    continue;
                }
                pending.extend(self.member_variable_ids(&entry.requirement.subject));
                pending.extend(self.member_variable_ids(&entry.requirement.member));
            }
        }
        let constraints = self.member_constraints.borrow();
        selected
            .into_iter()
            .map(|id| constraints.entries[id].requirement.clone())
            .collect()
    }

    pub(super) fn qualify_type(&self, type_: Type) -> Type {
        let (mut requirements, body) = match type_ {
            Type::Qualified { requirements, body } => (
                requirements.into_iter().collect::<Vec<_>>(),
                Rc::unwrap_or_clone(body),
            ),
            other => (Vec::new(), other),
        };
        for requirement in self.reachable_member_requirements(&body) {
            if !requirements.iter().any(|existing| {
                existing.name == requirement.name
                    && same_type(&existing.subject, &requirement.subject)
                    && same_type(&existing.member, &requirement.member)
            }) {
                requirements.push(requirement);
            }
        }
        if requirements.is_empty() {
            return body;
        }
        Type::Qualified {
            requirements: requirements.into(),
            body: Rc::new(body),
        }
    }

    /// A qualifier is activated only after its enclosing forall has been
    /// instantiated. Installing obligations on bound rigids would both leak
    /// between call sites and mistake a generic requirement for a failed lookup.
    pub(super) fn activate_qualified_type(&self, type_: Type) -> Type {
        match type_ {
            Type::Forall { .. } => type_,
            Type::Qualified { requirements, body } => {
                for requirement in requirements {
                    self.register_member_requirement(requirement);
                }
                self.activate_qualified_type(Rc::unwrap_or_clone(body))
            }
            other => map_type_children(other, |child| self.activate_qualified_type(child)),
        }
    }

    pub(super) fn has_member_requirements(&self, type_: &Type) -> bool {
        !self.reachable_member_requirements(type_).is_empty()
    }

    /// Produce ordinary subtype work only after lookup has actual type evidence.
    /// Running this inside the solver worklist keeps numeric-candidate rollback
    /// and union speculation transactional, including obligations created by
    /// instantiating the selected member's own qualified signature.
    pub(super) fn take_ready_member_constraints(
        &self,
        span: Span,
    ) -> Result<Vec<WorkItem>, Diagnostic> {
        let mut work = Vec::new();
        loop {
            let next = self.member_constraints.borrow_mut().queued.pop_first();
            let Some(id) = next else { break };
            let entry = self.member_constraints.borrow().entries[id].clone();
            if entry.discharged {
                continue;
            }
            self.index_member_requirement(id, &entry.requirement);
            let Some(subject) = self.member_lookup_subject(&entry.requirement.subject) else {
                continue;
            };
            let value = self.reify_runtime_type(&subject).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_TYPE_NOT_REIFIABLE",
                    format!(
                        "`{}` has no compile-time type value for member lookup.",
                        self.show(&subject)
                    ),
                    span,
                )
            })?;
            let value = self.context.decorate_operator_type(value);
            let member = static_member(&value, &entry.requirement.name).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_NO_TYPE_MEMBER",
                    format!(
                        "Type `{}` has no attached `{}` operation.",
                        self.show(&subject),
                        entry.requirement.name
                    ),
                    span,
                )
            })?;
            let signature = self
                .static_member_type(&member, Some(&subject))
                .ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_TYPE_NOT_REIFIABLE",
                        format!(
                            "The attached `{}` member has no checked source signature.",
                            entry.requirement.name
                        ),
                        span,
                    )
                })?;
            let signature = self.instantiate(Typing::Scheme {
                level: 0,
                body: signature,
            });
            self.member_constraints.borrow_mut().entries[id].discharged = true;
            work.push(WorkItem {
                left: self.constraint_type(&signature),
                right: self.constraint_type(&entry.requirement.member),
                span,
            });
        }
        Ok(work)
    }
}

/// Rebuild immediate structural children without interpreting the type. Binder-
/// sensitive operations handle Forall before using this helper.
pub(super) fn map_type_children(type_: Type, mut f: impl FnMut(Type) -> Type) -> Type {
    match type_ {
        Type::Forall { variables, body } => Type::Forall {
            variables,
            body: Rc::new(f(Rc::unwrap_or_clone(body))),
        },
        Type::Qualified { requirements, body } => Type::Qualified {
            requirements: requirements
                .into_iter()
                .map(|requirement| requirement.map(&mut f))
                .collect(),
            body: Rc::new(f(Rc::unwrap_or_clone(body))),
        },
        Type::Function {
            deferred,
            parameter,
            effects,
            result,
        } => Type::Function {
            deferred,
            parameter: Rc::new(f(Rc::unwrap_or_clone(parameter))),
            effects: Rc::new(f(Rc::unwrap_or_clone(effects))),
            result: Rc::new(f(Rc::unwrap_or_clone(result))),
        },
        Type::Record(fields) => Type::Record(
            fields
                .into_iter()
                .map(|(name, field)| (name, f(field)))
                .collect(),
        ),
        Type::RecordUpdate { base, fields } => Type::RecordUpdate {
            base: Rc::new(f(Rc::unwrap_or_clone(base))),
            fields: fields
                .into_iter()
                .map(|(name, field)| (name, f(field)))
                .collect(),
        },
        Type::Array(element) => Type::Array(Rc::new(f(Rc::unwrap_or_clone(element)))),
        Type::Region(element) => Type::Region(Rc::new(f(Rc::unwrap_or_clone(element)))),
        Type::Scratch(element) => Type::Scratch(Rc::new(f(Rc::unwrap_or_clone(element)))),
        Type::Variant { cases, open } => Type::Variant {
            cases: cases
                .into_iter()
                .map(|(name, field)| (name, f(field)))
                .collect(),
            open,
        },
        Type::OpenEffects { labels, tail } => Type::OpenEffects {
            labels,
            tail: Rc::new(f(Rc::unwrap_or_clone(tail))),
        },
        Type::Union(members) => Type::Union(members.into_iter().map(f).collect()),
        other => other,
    }
}
