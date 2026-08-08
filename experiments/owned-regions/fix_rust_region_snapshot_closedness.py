from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


path = "experiments/rust-middle/src/typecheck.rs"

# Compiler snapshots are internal typed caches, not ABI 1 values. They need to
# preserve Region inside the prelude's Slice function signatures so imported
# callers see the same ownership-aware types. The runtime/public ABI rejection
# remains separate in backend lowering and still refuses live Region values.
replace_once(
    path,
    '''    Record(Vec<(String, FlatTypeId)>),
    Array(FlatTypeId),
    Variant {
''',
    '''    Record(Vec<(String, FlatTypeId)>),
    Array(FlatTypeId),
    Region(FlatTypeId),
    Variant {
''',
)

replace_once(
    path,
    '''        FlatTypeNode::Array(element) => validate_child(*element, bound)?,
        FlatTypeNode::Union(members) => {
''',
    '''        FlatTypeNode::Array(element) | FlatTypeNode::Region(element) => {
            validate_child(*element, bound)?;
        }
        FlatTypeNode::Union(members) => {
''',
)

replace_once(
    path,
    '''            FlatTypeNode::Array(element) => Type::Array(Box::new(
                self.inflate_interface_type(arena, *element, rigids),
            )),
            FlatTypeNode::Variant { cases, open } => Type::Variant {
''',
    '''            FlatTypeNode::Array(element) => Type::Array(Box::new(
                self.inflate_interface_type(arena, *element, rigids),
            )),
            FlatTypeNode::Region(element) => Type::Region(Box::new(
                self.inflate_interface_type(arena, *element, rigids),
            )),
            FlatTypeNode::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''        Type::Array(element) => FlatTypeNode::Array(flatten_interface_type(element, bound, nodes)?),
        // Region authority is intentionally absent from portable/public module
        // interfaces. It must be consumed/frozen before crossing that boundary.
        Type::Region(_) => return None,
        Type::Variant { cases, open } => FlatTypeNode::Variant {
''',
    '''        Type::Array(element) => FlatTypeNode::Array(flatten_interface_type(element, bound, nodes)?),
        Type::Region(element) => {
            FlatTypeNode::Region(flatten_interface_type(element, bound, nodes)?)
        }
        Type::Variant { cases, open } => FlatTypeNode::Variant {
''',
)

# Snapshot closure signatures only need to be closed: every rigid variable must
# be bound by an enclosing forall and no inference variable may remain. Public
# ABI representability is a stricter, separate question and intentionally
# rejects Region at runtime/export boundaries.
replace_once(
    path,
    '''                for (body, signature) in &checked.closure_signatures {
                    if flatten_interface_type(signature, &mut HashSet::new(), &mut Vec::new())
                        .is_none()
                    {
                        return Err(format!(
                            "module {path} closure expression {} has an open checked signature: {signature:?}",
                            body.0
                        ));
                    }
                }
''',
    '''                for (body, signature) in &checked.closure_signatures {
                    if !closed_checked_type(signature, &mut HashSet::new()) {
                        return Err(format!(
                            "module {path} closure expression {} has an open checked signature: {signature:?}",
                            body.0
                        ));
                    }
                }
''',
)

anchor = '''fn flatten_interface_type(
    type_: &Type,
    bound: &mut HashSet<VariableId>,
    nodes: &mut Vec<FlatTypeNode>,
) -> Option<FlatTypeId> {
'''
helper = '''fn closed_checked_type(type_: &Type, bound: &mut HashSet<VariableId>) -> bool {
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

'''
replace_once(path, anchor, helper + anchor)

print("made Region snapshot-serializable while preserving ABI rejection")
