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

// Distinct free variables can never compare equal. Keep structural subjects in
// one bucket so alpha-equivalent forall types still use semantic equality.
#[derive(Eq, Hash, PartialEq)]
enum RequirementTypeHint {
    Variable(VariableId),
    Rigid(VariableId),
    Structural,
}

fn requirement_type_hint(type_: &Type) -> RequirementTypeHint {
    match type_ {
        Type::Variable(id) => RequirementTypeHint::Variable(*id),
        Type::Rigid(id) => RequirementTypeHint::Rigid(*id),
        _ => RequirementTypeHint::Structural,
    }
}

fn requirement_hint(
    requirement: &MemberRequirement<Type>,
) -> (String, RequirementTypeHint, RequirementTypeHint) {
    (
        requirement.name.clone(),
        requirement_type_hint(&requirement.subject),
        requirement_type_hint(&requirement.member),
    )
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
    #[cfg(test)]
    node_visits: Cell<u64>,
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
        let subject = self.settle(type_.clone(), true);
        if !matches!(subject, Type::Top)
            && !contains_bottom(&subject)
            && closed_checked_type(&subject, &mut HashSet::new())
            && operator_dispatch_type_is_concrete(&subject)
        {
            return Some(subject);
        }
        if let Some(upper) = self.member_upper_subject(type_) {
            return Some(upper);
        }
        if self.specialization_depth.get() == 0 {
            return None;
        }
        // Keep every possible producer: one unknown alternative still prevents
        // choosing an operation during specialization.
        let mut pending = vec![self.constraint_type(type_)];
        let mut visited = HashSet::new();
        let mut evidence = Vec::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            let source = self.expand_constraint(id);
            if type_domain(&source).is_some() {
                evidence.push(source);
                continue;
            }
            if let Some(upper) = self.member_upper_subject(&source) {
                if type_domain(&upper).is_some() {
                    evidence.push(upper);
                    continue;
                }
                return None;
            }
            let variable = self.constraint_variable(id)?;
            let lower = self.variables.borrow()[variable as usize].lower.clone();
            if lower.is_empty() {
                return None;
            }
            pending.extend(lower);
        }
        let carrier = join_types(evidence);
        type_domain(&carrier).map(|_| carrier)
    }

    /// A checked upper edge is evidence even when negative settlement has
    /// conservatively widened several bounds to Top. Follow only upper aliases:
    /// a lower bound or a type nested inside a container is not receiver evidence.
    fn member_upper_subject(&self, type_: &Type) -> Option<Type> {
        let mut pending = vec![self.constraint_type(type_)];
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            if let Some(variable) = self.constraint_variable(id) {
                pending.extend(self.variables.borrow()[variable as usize].upper.clone());
                continue;
            }
            let upper = self.settle(self.expand_constraint(id), false);
            if type_domain(&upper).is_some() || matches!(upper, Type::Opaque(_)) {
                return Some(upper);
            }
        }
        None
    }

    /// Include graph edges as well as syntactic occurrences. A member's result
    /// and effects can become connected to a function only after an application.
    fn member_variable_ids(&self, type_: &Type) -> BTreeSet<VariableId> {
        let mut variables = BTreeSet::new();
        self.walk_member_variables(type_, |variable, _| {
            variables.insert(variable);
            false
        });
        variables
    }

    // All roots discovered by the visitor share the same visited set. Expanding
    // each requirement with a separate traversal repeatedly walks the same
    // connected inference graph.
    fn walk_member_variables(
        &self,
        type_: &Type,
        mut visit: impl FnMut(VariableId, &mut Vec<ConstraintTypeId>) -> bool,
    ) -> bool {
        let mut pending = vec![self.constraint_type(type_)];
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            #[cfg(test)]
            {
                let constraints = self.member_constraints.borrow();
                constraints
                    .node_visits
                    .set(constraints.node_visits.get() + 1);
            }
            let node = self.constraint_types.borrow().nodes[id.0 as usize].clone();
            match node {
                ConstraintTypeNode::Variable(variable) => {
                    if visit(variable, &mut pending) {
                        return true;
                    }
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
                | ConstraintTypeNode::Scratch(element)
                | ConstraintTypeNode::Resource {
                    payload: element, ..
                } => pending.push(element),
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
        false
    }

    fn index_member_requirement(&self, id: usize, requirement: &MemberRequirement<Type>) {
        let mut variables = self.member_variable_ids(&requirement.subject);
        variables.extend(self.member_variable_ids(&requirement.member));
        let mut constraints = self.member_constraints.borrow_mut();
        for variable in variables {
            if constraints
                .variables
                .entry(variable)
                .or_default()
                .insert(id)
            {
                self.member_reachability.borrow_mut().clear();
                self.residual_analyses.borrow_mut().clear();
                self.residual_prefixes.borrow_mut().clear();
            }
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
        self.residual_analyses.borrow_mut().clear();
        self.residual_prefixes.borrow_mut().clear();
        self.member_reachability.borrow_mut().clear();
        self.index_member_requirement(id, &requirement);
    }

    // Compute transitive obligations by strongly connected component. A cycle
    // shares one complete result; predecessors union child results. Cache keys
    // are exact arena nodes, and every bound/index/discharge mutation invalidates
    // them. A cached successor is therefore a complete, not speculative, fact.
    fn reachable_member_requirements(&self, type_: &Type) -> Vec<MemberRequirement<Type>> {
        struct Node {
            id: ConstraintTypeId,
            low: usize,
            active: bool,
            children: Vec<ConstraintTypeId>,
            members: Vec<usize>,
        }
        let root = self.constraint_type(type_);
        let mut indices = HashMap::<ConstraintTypeId, usize>::new();
        let mut nodes = Vec::<Node>::new();
        let mut active = Vec::<usize>::new();
        let mut frames = Vec::<(usize, usize)>::new();
        let enter = |id,
                     nodes: &mut Vec<Node>,
                     indices: &mut HashMap<_, _>,
                     active: &mut Vec<usize>,
                     frames: &mut Vec<(usize, usize)>| {
            let index = nodes.len();
            let (children, members) = self.member_graph_edges(id);
            nodes.push(Node {
                id,
                low: index,
                active: true,
                children,
                members,
            });
            indices.insert(id, index);
            active.push(index);
            frames.push((index, 0));
        };
        if !self.member_reachability.borrow().contains_key(&root) {
            enter(root, &mut nodes, &mut indices, &mut active, &mut frames);
        }
        while let Some(&(current, next)) = frames.last() {
            if let Some(&child) = nodes[current].children.get(next) {
                frames.last_mut().expect("a DFS frame is active").1 += 1;
                if self.member_reachability.borrow().contains_key(&child) {
                    continue;
                }
                if let Some(&index) = indices.get(&child) {
                    if nodes[index].active {
                        nodes[current].low = nodes[current].low.min(index);
                    }
                } else {
                    enter(child, &mut nodes, &mut indices, &mut active, &mut frames);
                }
                continue;
            }
            frames.pop();
            if nodes[current].low == current {
                let mut component = Vec::new();
                loop {
                    let member = active.pop().expect("a component contains its root");
                    nodes[member].active = false;
                    component.push(member);
                    if member == current {
                        break;
                    }
                }
                let members = component.iter().copied().collect::<HashSet<_>>();
                let mut result = BTreeSet::new();
                {
                    let cache = self.member_reachability.borrow();
                    for &index in &component {
                        result.extend(nodes[index].members.iter().copied());
                        for child in &nodes[index].children {
                            if indices
                                .get(child)
                                .is_some_and(|index| members.contains(index))
                            {
                                continue;
                            }
                            result.extend(
                                cache
                                    .get(child)
                                    .expect("successor components finish first")
                                    .iter()
                                    .copied(),
                            );
                        }
                    }
                }
                let result: Rc<[usize]> = result.into_iter().collect::<Vec<_>>().into();
                let mut cache = self.member_reachability.borrow_mut();
                for index in component {
                    cache.insert(nodes[index].id, result.clone());
                }
            }
            if let Some(&(parent, _)) = frames.last() {
                nodes[parent].low = nodes[parent].low.min(nodes[current].low);
            }
        }
        let cache = self.member_reachability.borrow();
        let constraints = self.member_constraints.borrow();
        cache[&root]
            .iter()
            .map(|id| constraints.entries[*id].requirement.clone())
            .collect()
    }

    fn member_graph_edges(&self, id: ConstraintTypeId) -> (Vec<ConstraintTypeId>, Vec<usize>) {
        #[cfg(test)]
        {
            let constraints = self.member_constraints.borrow();
            constraints
                .node_visits
                .set(constraints.node_visits.get() + 1);
        }
        let node = self.constraint_types.borrow().nodes[id.0 as usize].clone();
        let mut children = Vec::new();
        let mut members = Vec::new();
        match node {
            ConstraintTypeNode::Variable(variable) => {
                let source = self.variables.borrow()[variable as usize].clone();
                children.extend(source.lower);
                children.extend(source.upper);
                let constraints = self.member_constraints.borrow();
                if let Some(ids) = constraints.variables.get(&variable) {
                    for &id in ids {
                        let entry = &constraints.entries[id];
                        if !entry.discharged {
                            members.push(id);
                            children.push(self.constraint_type(&entry.requirement.subject));
                            children.push(self.constraint_type(&entry.requirement.member));
                        }
                    }
                }
            }
            ConstraintTypeNode::Forall { body, .. } => children.push(body),
            ConstraintTypeNode::Qualified { requirements, body } => {
                children.push(body);
                for requirement in requirements {
                    children.extend([requirement.subject, requirement.member]);
                }
            }
            ConstraintTypeNode::Function {
                parameter,
                effects,
                result,
                ..
            } => children.extend([parameter, effects, result]),
            ConstraintTypeNode::Record(fields)
            | ConstraintTypeNode::Variant { cases: fields, .. } => {
                children.extend(fields.into_iter().map(|(_, field)| field))
            }
            ConstraintTypeNode::RecordUpdate { base, fields } => {
                children.push(base);
                children.extend(fields.into_iter().map(|(_, field)| field));
            }
            ConstraintTypeNode::Array(element)
            | ConstraintTypeNode::Region(element)
            | ConstraintTypeNode::Scratch(element)
            | ConstraintTypeNode::Resource {
                payload: element, ..
            } => children.push(element),
            ConstraintTypeNode::OpenEffects { tail, .. } => children.push(tail),
            ConstraintTypeNode::Union(members) => children.extend(members),
            ConstraintTypeNode::Rigid(_)
            | ConstraintTypeNode::Range { .. }
            | ConstraintTypeNode::Unit
            | ConstraintTypeNode::Effects(_)
            | ConstraintTypeNode::Opaque(_)
            | ConstraintTypeNode::Top
            | ConstraintTypeNode::Bottom => {}
        }
        (children, members)
    }

    pub(super) fn qualify_type(&self, type_: Type) -> Type {
        let (mut requirements, body) = match type_ {
            Type::Qualified { requirements, body } => (
                requirements.into_iter().collect::<Vec<_>>(),
                Rc::unwrap_or_clone(body),
            ),
            other => (Vec::new(), other),
        };
        let mut candidates = HashMap::<_, Vec<usize>>::new();
        for (index, requirement) in requirements.iter().enumerate() {
            candidates
                .entry(requirement_hint(requirement))
                .or_default()
                .push(index);
        }
        for requirement in self.reachable_member_requirements(&body) {
            let matching = candidates
                .entry(requirement_hint(&requirement))
                .or_default();
            if !matching.iter().any(|index| {
                let existing = &requirements[*index];
                same_type(&existing.subject, &requirement.subject)
                    && same_type(&existing.member, &requirement.member)
            }) {
                matching.push(requirements.len());
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
        // Reaching a transitive obligation first requires reaching a pending
        // obligation. An existence query can stop at that first requirement.
        self.walk_member_variables(type_, |variable, _| {
            let constraints = self.member_constraints.borrow();
            constraints.variables.get(&variable).is_some_and(|entries| {
                entries
                    .iter()
                    .any(|id| !constraints.entries[*id].discharged)
            })
        })
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
            self.residual_analyses.borrow_mut().clear();
            self.residual_prefixes.borrow_mut().clear();
            self.member_reachability.borrow_mut().clear();
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
        Type::Resource { family, payload } => Type::Resource {
            family,
            payload: Rc::new(f(Rc::unwrap_or_clone(payload))),
        },
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

#[cfg(test)]
mod traversal_tests {
    use super::*;

    #[test]
    fn cached_reachability_covers_cycles_and_new_obligations() {
        let checker = Checker::new(Rc::new(Context::default()));
        let a = checker.fresh();
        let b = checker.fresh();
        let span = Span { start: 0, end: 0 };
        checker.constrain(a.clone(), b.clone(), span).unwrap();
        checker.constrain(b.clone(), a.clone(), span).unwrap();
        checker.register_member_requirement(MemberRequirement {
            name: "first".to_owned(),
            subject: a.clone(),
            member: checker.fresh(),
        });
        assert_eq!(checker.reachable_member_requirements(&b).len(), 1);
        assert_eq!(checker.reachable_member_requirements(&a).len(), 1);
        checker.register_member_requirement(MemberRequirement {
            name: "second".to_owned(),
            subject: b.clone(),
            member: checker.fresh(),
        });
        for root in [&a, &b, &a] {
            let names = checker
                .reachable_member_requirements(root)
                .into_iter()
                .map(|requirement| requirement.name)
                .collect::<BTreeSet<_>>();
            assert_eq!(
                names,
                BTreeSet::from(["first".to_owned(), "second".to_owned()])
            );
        }
    }

    #[test]
    fn connected_requirements_are_walked_once_and_existence_short_circuits() {
        let checker = Checker::new(Rc::new(Context::default()));
        let subjects = (0..32).map(|_| checker.fresh()).collect::<Vec<_>>();
        for pair in subjects.windows(2) {
            checker
                .constrain(pair[0].clone(), pair[1].clone(), Span { start: 0, end: 0 })
                .unwrap();
        }
        for subject in &subjects {
            checker.register_member_requirement(MemberRequirement {
                name: "add".to_owned(),
                subject: subject.clone(),
                member: checker.fresh(),
            });
        }
        let before = checker.member_constraints.borrow().node_visits.get();
        let requirements = checker.reachable_member_requirements(&subjects[0]);
        let after = checker.member_constraints.borrow().node_visits.get();
        assert_eq!(requirements.len(), 32);
        assert_eq!(
            after - before,
            64,
            "each graph node must be visited once, not once per requirement"
        );
        assert!(checker.has_member_requirements(&subjects[0]));
        assert_eq!(
            checker.member_constraints.borrow().node_visits.get() - after,
            1,
            "existence must stop at the first pending requirement"
        );
        for entry in &mut checker.member_constraints.borrow_mut().entries {
            entry.discharged = true;
        }
        assert!(!checker.has_member_requirements(&subjects[0]));
    }

    #[test]
    fn requirement_bucketing_retains_alpha_equivalence_and_distinct_variables() {
        for quantified_subject in [false, true] {
            let checker = Checker::new(Rc::new(Context::default()));
            let root = checker.fresh();
            let forall = |id| Type::Forall {
                variables: vec![id],
                body: Rc::new(curried(vec![Type::Rigid(id)], Type::Rigid(id))),
            };
            let requirement = |id| {
                let (subject, member) = if quantified_subject {
                    (forall(id), root.clone())
                } else {
                    (root.clone(), forall(id))
                };
                MemberRequirement {
                    name: "add".to_owned(),
                    subject,
                    member,
                }
            };
            checker.register_member_requirement(requirement(8));
            let existing = Type::Qualified {
                requirements: vec![requirement(7)].into(),
                body: Rc::new(root),
            };
            let Type::Qualified { requirements, .. } = checker.qualify_type(existing) else {
                panic!("qualification was dropped")
            };
            assert_eq!(
                requirements.len(),
                1,
                "alpha-equivalent obligations must still deduplicate"
            );
        }
        let checker = Checker::new(Rc::new(Context::default()));
        let left = checker.fresh();
        let right = checker.fresh();
        for subject in [&left, &right] {
            checker.register_member_requirement(MemberRequirement {
                name: "add".to_owned(),
                subject: subject.clone(),
                member: Type::Unit,
            });
        }
        let Type::Qualified { requirements, .. } = checker.qualify_type(Type::Record(
            vec![("left".to_owned(), left), ("right".to_owned(), right)].into(),
        )) else {
            panic!("requirements were lost")
        };
        assert_eq!(
            requirements.len(),
            2,
            "distinct free receivers must not merge"
        );
    }
}
