from pathlib import Path
import json
import re

files = {}

def load(path):
    return files.setdefault(path, Path(path).read_text())

def replace(path, before, after, count=1):
    text = load(path)
    found = text.count(before)
    if found != count:
        raise RuntimeError(f'{path}: expected {count} anchors, found {found}: {before[:120]}')
    files[path] = text.replace(before, after)

def section(path, name, transform):
    text = load(path)
    match = re.search(r'(?m)^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?fn '+re.escape(name)+r'\(', text)
    if not match:
        raise RuntimeError('Missing function '+name)
    following = re.search(r'(?m)^'+re.escape(match.group(1))+r'(?:pub(?:\([^)]*\))?\s+)?fn \w+\(', text[match.end():])
    end = match.end()+following.start() if following else len(text)
    before = text[match.start():end]
    after = transform(before)
    if before == after:
        raise RuntimeError('Unchanged function '+name)
    files[path] = text[:match.start()]+after+text[end:]

t = 'compiler/src/typecheck.rs'

def arm(name, code, target='match type_ {'):
    def change(text):
        if target not in text:
            raise RuntimeError(name+': missing match')
        return text.replace(target, target+'\n'+code, 1)
    section(t, name, change)

# Flat child order is body, followed by subject/member pairs. Every serializer
# and iterative boundary traversal uses exactly that ordering.
section(t, 'closed_boundary_type_key', lambda s: s.replace('''                let key = match node {''', '''                let key = match node {
                    FlatTypeNode::Qualified { requirements, .. } => {
                        let body = children.next()?;
                        let mut keys = Vec::with_capacity(requirements.len());
                        for requirement in requirements {
                            keys.push(format!("{}({},{})", text(&requirement.name), children.next()?, children.next()?));
                        }
                        keys.sort();
                        format!("qualified({body};{})", keys.join(","))
                    },''', 1))
section(t, 'copy_boundary_type', lambda s: s.replace('''                    FlatTypeNode::Function { .. }
''', '''                    FlatTypeNode::Qualified { .. }
                    | FlatTypeNode::Function { .. }
''', 1).replace('''                let node = match node {''', '''                let node = match node {
                    FlatTypeNode::Qualified { requirements, .. } => FlatTypeNode::Qualified {
                        body: children.next().expect("qualified body"),
                        requirements: requirements.into_iter().map(|requirement| MemberRequirement {
                            name: requirement.name,
                            subject: children.next().expect("requirement subject"),
                            member: children.next().expect("requirement member"),
                        }).collect(),
                    },''', 1))
section(t, 'inflate_cached_type', lambda s: s.replace('''                    let type_ = match arena.node(type_) {''', '''                    let type_ = match arena.node(type_) {
                        FlatTypeNode::Qualified { requirements, .. } => Type::Qualified {
                            body: Rc::new(children.next().expect("qualified body")),
                            requirements: requirements.iter().map(|requirement| MemberRequirement {
                                name: requirement.name.clone(),
                                subject: children.next().expect("requirement subject"),
                                member: children.next().expect("requirement member"),
                            }).collect(),
                        },''', 1))
for name in ['mentions_pending_numeric_literal', 'pending_numeric_literal_domain']:
    arm(name, '''                Type::Qualified { requirements, body } => {
                    pending.push(Rc::unwrap_or_clone(body));
                    for requirement in requirements {
                        pending.extend([requirement.subject, requirement.member]);
                    }
                },''')
arm('show_settled', '''            Type::Qualified { requirements, body } => format!(
                "({}) => {}",
                requirements.iter().map(|requirement| format!("{}.{} :: {}", self.show_settled(&requirement.subject), requirement.name, self.show_settled(&requirement.member))).collect::<Vec<_>>().join(", "),
                self.show_settled(body),
            ),''')
arm('operator_dispatch_type_is_concrete', '''        Type::Qualified { .. } => false,''')
arm('contains_bottom', '''        Type::Qualified { requirements, body } => contains_bottom(body)
            || requirements.iter().any(|requirement| contains_bottom(&requirement.subject) || contains_bottom(&requirement.member)),''')
section(t, 'closed_type_key', lambda s: s.replace('''        match type_ {''', '''        match type_ {
            Type::Qualified { requirements, body } => {
                let body = visit(body, binders)?;
                let mut keys = requirements.iter().map(|requirement| Some(format!("{}({},{})", text(&requirement.name), visit(&requirement.subject, binders)?, visit(&requirement.member, binders)?))).collect::<Option<Vec<_>>>()?;
                keys.sort();
                Some(format!("qualified({body};{})", keys.join(",")))
            },''', 1))
arm('free_rigid_variables', '''        Type::Qualified { requirements, body } => {
            free_rigid_variables(body, bound, free);
            for requirement in requirements {
                free_rigid_variables(&requirement.subject, bound, free);
                free_rigid_variables(&requirement.member, bound, free);
            }
        },''')
for name in ['ownership_uses_expression_type', 'contains_function', 'function_result_contains_embedded_function']:
    arm(name, f'''        Type::Qualified {{ body, .. }} => {name}(body),''')
arm('coverage_matrix', '''        Type::Qualified { body, .. } => {
            let mut unqualified = vec![body.as_ref().clone()];
            unqualified.extend_from_slice(rest);
            coverage_matrix(rows, &unqualified)
        },''', 'match &types[0] {')
arm('type_exposes_generative_effect', '''        Type::Qualified { requirements, body } => type_exposes_generative_effect(body)
            || requirements.iter().any(|requirement| type_exposes_generative_effect(&requirement.subject) || type_exposes_generative_effect(&requirement.member)),''')
arm('closed_checked_type', '''        Type::Qualified { requirements, body } => closed_checked_type(body, bound)
            && requirements.iter().all(|requirement| closed_checked_type(&requirement.subject, bound) && closed_checked_type(&requirement.member, bound)),''')
arm('flatten_interface_type', '''        Type::Qualified { requirements, body } => FlatTypeNode::Qualified {
            body: flatten_interface_type(body, bound, types)?,
            requirements: requirements.iter().map(|requirement| Some(MemberRequirement {
                name: requirement.name.clone(),
                subject: flatten_interface_type(&requirement.subject, bound, types)?,
                member: flatten_interface_type(&requirement.member, bound, types)?,
            })).collect::<Option<Vec<_>>>()?,
        },''')
# Qualifiers are compile-time obligations. They must not be treated as a proven
# monomorphic signature merely to select a runtime representation.
arm('quantify_settlement_holes', '''        Type::Qualified { .. } => None,''')
# Equality includes the obligations and respects surrounding rigid binders.
replace(t, '''        match (&self.nodes[left.0 as usize], &self.nodes[right.0 as usize]) {''', '''        match (&self.nodes[left.0 as usize], &self.nodes[right.0 as usize]) {
            (ConstraintTypeNode::Qualified { requirements: left, body: left_body }, ConstraintTypeNode::Qualified { requirements: right, body: right_body }) => {
                left.len() == right.len()
                    && self.same_with_rigids(*left_body, *right_body, rigids)
                    && left.iter().zip(right).all(|(left, right)| left.name == right.name
                        && self.same_with_rigids(left.subject, right.subject, rigids)
                        && self.same_with_rigids(left.member, right.member, rigids))
            },''')
section(t, 'same_type_with_rigids', lambda s: s.replace('''    match (left, right) {''', '''    match (left, right) {
        (Type::Qualified { requirements: left, body: left_body }, Type::Qualified { requirements: right, body: right_body }) => {
            left.len() == right.len()
                && same_type_with_rigids(left_body, right_body, rigids)
                && left.iter().zip(right).all(|(left, right)| left.name == right.name
                    && same_type_with_rigids(&left.subject, &right.subject, rigids)
                    && same_type_with_rigids(&left.member, &right.member, rigids))
        },''', 1))

h = 'compiler/src/hir.rs'
section(h, 'type_value', lambda s: s.replace('''    match type_ {''', '''    match type_ {
        Type::Qualified { .. } => Value::Unbounded,''', 1))
section(h, 'runtime_type', lambda s: s.replace('''        match type_ {''', '''        match type_ {
            Type::Qualified { .. } => Err(hir_error("An attached-member requirement must be discharged before the runtime boundary.")),''', 1))
o = 'compiler/src/ownership.rs'
for name in ['type_may_carry_ownership', 'contains_type_value']:
    section(o, name, lambda s, name=name: s.replace('''    match type_ {''', f'''    match type_ {{
        Type::Qualified {{ body, .. }} => {name}(body),''', 1))

q = 'compiler/src/qcore.rs'
section(q, 'translate_flat_type', lambda s: s.replace('''    match type_ {''', '''    match type_ {
        FlatTypeNode::Qualified { requirements, body } => Value::StructuralQualified {
            body: ValueId(body.0),
            names: requirements.iter().map(|requirement| requirement.name.clone()).collect(),
            subjects: requirements.iter().map(|requirement| ValueId(requirement.subject.0)).collect(),
            members: requirements.iter().map(|requirement| ValueId(requirement.member.0)).collect(),
        },''', 1))
replace(q, '''                Value::StructuralRecordUpdate {
                    base, field_types, ..
                } => {
                    self.ensure_value(source, base)?;''', '''                Value::StructuralQualified { body, subjects, members, .. } => {
                    self.ensure_value(source, body)?;
                    for child in subjects.into_iter().chain(members) {
                        self.ensure_value(source, child)?;
                    }
                },
                Value::StructuralRecordUpdate {
                    base, field_types, ..
                } => {
                    self.ensure_value(source, base)?;''')
replace(q, '''            Value::StructuralRecordUpdate {
                base, field_types, ..
            } => {
                self.visit_value(base, depth, rigids)?;''', '''            Value::StructuralQualified { body, subjects, members, .. } => {
                self.visit_value(body, depth, rigids)?;
                for child in subjects.into_iter().chain(members) {
                    self.visit_value(child, depth, rigids)?;
                }
            },
            Value::StructuralRecordUpdate {
                base, field_types, ..
            } => {
                self.visit_value(base, depth, rigids)?;''')
replace(q, '''            match &node.term {
                Value::StructuralRecord {''', '''            match &node.term {
                Value::StructuralQualified { names, subjects, members, .. } => {
                    for length in [subjects.len(), members.len()] {
                        if names.len() != length {
                            return Err(ValidationError::LabeledTypeLengthMismatch { value, labels: names.len(), types: length });
                        }
                    }
                },
                Value::StructuralRecord {''')
replace('compiler/src/qcore_typing.rs', '''            | Value::StructuralForall { .. }''', '''            | Value::StructuralForall { .. }
            | Value::StructuralQualified { .. }''')

schema = json.loads(load('qcore/schema.json'))
assert schema['version'] == 3
schema['version'] = 4
variants = next(union['variants'] for union in schema['unions'] if union['name'] == 'Value')
assert max(variant['tag'] for variant in variants) == 29
variants.append({'name': 'StructuralQualified', 'tag': 30, 'fields': [
    {'name': 'body', 'type': 'ValueId'},
    {'name': 'names', 'type': 'string[]'},
    {'name': 'subjects', 'type': 'ValueId[]'},
    {'name': 'members', 'type': 'ValueId[]'},
]})
files['qcore/schema.json'] = json.dumps(schema, indent=2)+'\n'
protocol = json.loads(load('compiler/protocol.json'))
assert protocol['checkedModuleCertificate'] == 16
protocol['checkedModuleCertificate'] = 17
files['compiler/protocol.json'] = json.dumps(protocol, indent=2)+'\n'
files['spec/QCORE.md'] = load('spec/QCORE.md').rstrip()+'''

### Qualified structural certificates

Schema version 4 adds `StructuralQualified`: a body plus equally sized member
name, receiver-type, and member-type arrays. Receivers and members are checked
under the enclosing structural quantifiers. Repeated member names are valid
when they constrain different receivers. These obligations are retained in the
structural shadow certificate; they do not become proofs in the pure QCore
fragment, which rejects this node like other structural certificate forms.

Checked-module certificate schema 17 carries the corresponding qualified flat
type. Older certificates are rejected rather than read with erased obligations.
Unresolved qualifications cannot select a Runtime HIR representation.
'''

for path, text in files.items():
    Path(path).write_text(text)
