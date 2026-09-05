from pathlib import Path
import re

p = Path('compiler/src/typecheck.rs')
s = p.read_text()

def replace(a, b, count=1):
    global s
    found = s.count(a)
    if found != count:
        raise RuntimeError(f'Expected {count} anchors, found {found}: {a[:130]}')
    s = s.replace(a, b)

def section(name, transform):
    global s
    match = re.search(r'(?m)^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?fn '+re.escape(name)+r'\(', s)
    if not match:
        raise RuntimeError('Missing function '+name)
    begin = match.start()
    following = re.search(r'(?m)^'+re.escape(match.group(1))+r'(?:pub(?:\([^)]*\))?\s*fn \w+\(', s[match.end():])
    end = match.end()+following.start() if following else len(s)
    before = s[begin:end]
    after = transform(before)
    if after == before:
        raise RuntimeError('Unchanged function '+name)
    s = s[:begin]+after+s[end:]

def arm(name, text, target='match type_ {'):
    def apply(t):
        if target not in t:
            raise RuntimeError(name+': missing '+target)
        return t.replace(target, target+'\n'+text, 1)
    section(name, apply)

replace('use std::cell::{Cell, RefCell};', 'use std::cell::{Cell, RefCell};\n\n#[path = "member_constraints.rs"]\nmod member_constraints;\npub use member_constraints::MemberRequirement;\nuse member_constraints::MemberConstraints;')
replace('''    Forall {
        variables: Vec<VariableId>,
        body: Rc<Type>,
    },''', '''    Forall {
        variables: Vec<VariableId>,
        body: Rc<Type>,
    },
    Qualified {
        requirements: TypeList<MemberRequirement<Type>>,
        body: Rc<Type>,
    },''')
replace('''    Forall {
        variables: Vec<VariableId>,
        body: ConstraintTypeId,
    },''', '''    Forall {
        variables: Vec<VariableId>,
        body: ConstraintTypeId,
    },
    Qualified {
        requirements: Vec<MemberRequirement<ConstraintTypeId>>,
        body: ConstraintTypeId,
    },''')
replace('''    Forall {
        variables: Vec<VariableId>,
        body: FlatTypeId,
    },''', '''    Forall {
        variables: Vec<VariableId>,
        body: FlatTypeId,
    },
    Qualified {
        requirements: Vec<MemberRequirement<FlatTypeId>>,
        body: FlatTypeId,
    },''')
replace('''            Type::Variable(id) => ConstraintTypeNode::Variable(*id),''', '''            Type::Qualified { requirements, body } => ConstraintTypeNode::Qualified {
                requirements: requirements.iter().map(|requirement| requirement.map_ref(|type_| self.intern(type_))).collect(),
                body: self.intern(body),
            },
            Type::Variable(id) => ConstraintTypeNode::Variable(*id),''')
replace('''            ConstraintTypeNode::Variable(id) => Type::Variable(*id),''', '''            ConstraintTypeNode::Qualified { requirements, body } => Type::Qualified {
                requirements: requirements.iter().map(|requirement| requirement.map_ref(|type_| self.expand(*type_))).collect(),
                body: Rc::new(self.expand(*body)),
            },
            ConstraintTypeNode::Variable(id) => Type::Variable(*id),''')
replace('''            ConstraintTypeNode::Forall { body, .. } => self.level_of(*body, variables),''', '''            ConstraintTypeNode::Forall { body, .. } => self.level_of(*body, variables),
            ConstraintTypeNode::Qualified { requirements, body } => requirements.iter()
                .flat_map(|requirement| [requirement.subject, requirement.member])
                .chain(std::iter::once(*body))
                .map(|type_| self.level_of(type_, variables)).max().unwrap_or(0),''')
replace('''        FlatTypeNode::Forall { body, .. } => children.push(*body),''', '''        FlatTypeNode::Forall { body, .. } => children.push(*body),
        FlatTypeNode::Qualified { requirements, body } => {
            children.push(*body);
            for requirement in requirements {
                children.extend([requirement.subject, requirement.member]);
            }
        },''')
replace('''    numeric_literals: RefCell<BTreeMap<VariableId, NumericLiteralFact>>,''', '''    numeric_literals: RefCell<BTreeMap<VariableId, NumericLiteralFact>>,
    member_constraints: RefCell<MemberConstraints>,''')
replace('''            numeric_literals: RefCell::new(BTreeMap::new()),''', '''            numeric_literals: RefCell::new(BTreeMap::new()),
            member_constraints: RefCell::new(MemberConstraints::default()),''')
# Reset obligations wherever mutable inference storage is reclaimed.
replace('''        self.numeric_literals.borrow_mut().clear();''', '''        self.numeric_literals.borrow_mut().clear();
        self.member_constraints.borrow_mut().clear();''', s.count('        self.numeric_literals.borrow_mut().clear();'))
replace('''                        self.defer_current_closure();
                        return Ok(Inferred {
                            type_: self.fresh(),
                            effects: subject.effects,
                        });''', '''                        self.defer_current_closure();
                        let member = self.fresh();
                        self.register_member_requirement(MemberRequirement {
                            name,
                            subject: subject.type_,
                            member: member.clone(),
                        });
                        return Ok(Inferred {
                            type_: member,
                            effects: subject.effects,
                        });''')
replace('''                    let type_ = self
                        .static_member_type(&member, Some(&settled))
                        .unwrap_or_else(|| self.fresh());''', '''                    let type_ = self
                        .static_member_type(&member, Some(&settled))
                        .ok_or_else(|| Diagnostic::new(
                            "BLOT_TYPE_NOT_REIFIABLE",
                            format!("The attached `{name}` member has no checked source signature."),
                            span,
                        ))?;
                    let type_ = self.instantiate(Typing::Scheme { level: 0, body: type_ });''')
replace('''            Typing::Mono(type_) => type_,
            Typing::Scheme { level, body } => self.freshen(body, level, &mut HashMap::new()),''', '''            Typing::Mono(type_) => self.activate_qualified_type(type_),
            Typing::Scheme { level, body } => {
                let body = self.qualify_type(body);
                let body = self.freshen(body, level, &mut HashMap::new());
                self.activate_qualified_type(body)
            },''')
replace('''    fn project_scheme_constraints(&self, type_: &Type, level: u32) -> HashMap<VariableId, Type> {
''', '''    fn project_scheme_constraints(&self, type_: &Type, level: u32) -> HashMap<VariableId, Type> {
        if let Some(replacements) = self.copy_qualified_scheme_constraints(type_, level) {
            return replacements;
        }
''')
section('project_scheme_constraints', lambda t: t.replace('''                Type::Forall { body, .. } => pending.push(body),''', '''                Type::Qualified { requirements, body } => {
                    pending.push(body);
                    for requirement in requirements {
                        pending.extend([&requirement.subject, &requirement.member]);
                    }
                },
                Type::Forall { body, .. } => pending.push(body),'''))
replace('''        let rebuilt = match node {
            ConstraintTypeNode::Forall''', '''        let rebuilt = match node {
            ConstraintTypeNode::Qualified { requirements, body } => ConstraintTypeNode::Qualified {
                requirements: requirements.into_iter().map(|requirement| requirement.map(|type_| self.freshen_constraint(type_, level, fresh, rewritten))).collect(),
                body: self.freshen_constraint(body, level, fresh, rewritten),
            },
            ConstraintTypeNode::Forall''')
section('instantiate_forall', lambda t: t.replace('''        substitute_rigid(body, &replacements)''', '''        self.activate_qualified_type(substitute_rigid(body, &replacements))'''))
# Propagate qualifiers through ordinary inference-variable rewrites.
for name, call in [
    ('extrude', 'self.extrude(child, polarity, level, copies)'),
    ('substitute_rigid', 'substitute_rigid(child, replacements)'),
    ('substitute_inference_variables', 'substitute_inference_variables(child, replacements)'),
    ('stable_loop_signature', 'stable_loop_signature(child)'),
]:
    arm(name, f'''            qualified @ Type::Qualified {{ .. }} => member_constraints::map_type_children(qualified, |child| {call}),''')
# Distinct level_of implementations: only the Type version has this exact arm.
replace('''            Type::Forall { body, .. } => self.level_of(body),''', '''            Type::Forall { body, .. } => self.level_of(body),
            Type::Qualified { requirements, body } => requirements.iter()
                .flat_map(|requirement| [&requirement.subject, &requirement.member])
                .chain(std::iter::once(body.as_ref()))
                .map(|type_| self.level_of(type_)).max().unwrap_or(0),''')
replace('''    fn record_bound_insertion(&self, variable: VariableId, direction: BoundDirection) {
''', '''    fn record_bound_insertion(&self, variable: VariableId, direction: BoundDirection) {
        self.member_constraints.borrow_mut().changed(variable);
''')
replace('''        while let Some(item) = work.pop_front() {
            self.constrain_work_item(item, seen, &mut work)?;
            self.solver_worklist_peak
                .set(self.solver_worklist_peak.get().max(work.len() as u64));
        }
        Ok(())
    }

    fn constrain_work_item''', '''        loop {
            while let Some(item) = work.pop_front() {
                self.constrain_work_item(item, seen, &mut work)?;
                self.solver_worklist_peak
                    .set(self.solver_worklist_peak.get().max(work.len() as u64));
            }
            work.extend(self.take_ready_member_constraints(span)?);
            if work.is_empty() {
                break;
            }
        }
        Ok(())
    }

    fn constrain_work_item''')
replace('''        let compatible = match (left_node, right_node) {
''', '''        let compatible = match (left_node, right_node) {
            (ConstraintTypeNode::Qualified { requirements, body }, _) => {
                for requirement in requirements {
                    self.register_member_requirement(requirement.map(|type_| self.expand_constraint(type_)));
                }
                work.push_back(WorkItem { left: body, right, span });
                true
            },
            (_, ConstraintTypeNode::Qualified { requirements, body }) => {
                for requirement in requirements {
                    self.register_member_requirement(requirement.map(|type_| self.expand_constraint(type_)));
                }
                work.push_back(WorkItem { left, right: body, span });
                true
            },
''')
# Both speculative solver entry points must roll back obligation activation and
# discharge, not just variable bounds. Their state can contain reified caches.
replace('''        let insertion_count = self.bound_insertions.borrow().len();
        let variable_count = self.variables.borrow().len();
        let next_skolem = self.next_skolem.get();''', '''        let insertion_count = self.bound_insertions.borrow().len();
        let variable_count = self.variables.borrow().len();
        let next_skolem = self.next_skolem.get();
        let member_constraints = self.member_constraints.borrow().clone();''', 2)
replace('''self.rollback_bounds(insertion_count, variable_count, next_skolem);''', '''self.rollback_bounds(insertion_count, variable_count, next_skolem);
            *self.member_constraints.borrow_mut() = member_constraints;''', 2)
section('rollback_bounds', lambda t: t.replace('''        self.next_skolem.set(next_skolem);''', '''        self.next_skolem.set(next_skolem);
        self.settled_variables.borrow_mut().clear();
        self.residual_variables.borrow_mut().clear();'''))
replace('''    fn residual_signature_analysis(&self, type_: Type) -> (Type, bool) {
''', '''    fn residual_signature_analysis(&self, type_: Type) -> (Type, bool) {
        let type_ = self.qualify_type(type_);
''')
section('residual_signature_analysis', lambda t: t.replace('''                Type::Function {
''', '''                Type::Qualified { requirements, body } => {
                    pending.push((body, bound.clone()));
                    for requirement in requirements {
                        pending.push((&requirement.subject, bound.clone()));
                        pending.push((&requirement.member, bound.clone()));
                    }
                },
                Type::Function {
''', 1))
arm('residual_signature_type', '''            qualified @ Type::Qualified { .. } => member_constraints::map_type_children(qualified, |child| self.residual_signature_type(child, seen, resolved, unresolved, recursive)),''')
section('residual_signature_type', lambda t: t.replace('''                effects: Rc::new(self.settle(Rc::unwrap_or_clone(effects), true)),''', '''                effects: Rc::new(if self.has_member_requirements(&effects) {
                    self.residual_signature_type(Rc::unwrap_or_clone(effects), seen, resolved, unresolved, recursive)
                } else {
                    self.settle(Rc::unwrap_or_clone(effects), true)
                }),'''))
arm('settle_seen', '''            qualified @ Type::Qualified { .. } => member_constraints::map_type_children(qualified, |child| self.settle_seen(child, positive, traversal)),''')
# Complete FlatType lowering and runtime traversals in the next small patch,
# using compiler exhaustiveness errors to ensure no schema boundary is missed.
p.write_text(s)

# Keep the implementation contract beside the source changes.
p = Path('spec/TYPECHECKING.md')
s = p.read_text()
s += '''\n### Qualified attached-member requirements\n\nAn unresolved projection through `@type.inferred` records the receiver type,\nmember name, and required member type. It does not choose an integer default or\nan unconstrained result. Requirements are freshened with their function scheme,\nincluding their argument, result, and effect variables. The solver discharges a\nrequirement only against the selected attached member's actual checked signature.\nNumeric candidate trials and failed union branches roll back requirement state\nas well as ordinary subtype bounds. Closed interfaces retain any requirements\nbeneath their quantifiers; they must not be silently erased by serialization.\n'''
p.write_text(s)
p = Path('LANGUAGE.md')
s = p.read_text()
s += '''\n### Generic operator requirements\n\nOperator fixities name ordinary source bindings. Binary arithmetic and prefix\nnegation dispatch to members of the inferred operand type. An unresolved operand\nretains an attached-member requirement instead of defaulting to `Int`. Each use\nof a generic function resolves its own members; the selected member's parameter,\nresult, and effect signature is checked without replacing it from its name.\nAlready-bound integer and floating-point values are not implicitly converted.\n'''
p.write_text(s)
