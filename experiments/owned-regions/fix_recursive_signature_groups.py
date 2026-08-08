from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))


path = Path("compiler/src/ownership.rs")
text = path.read_text()

# `sig` constrains the following recursive binding but carries no ownership
# behavior of its own. Keep it transparent when collecting one recursive
# ownership group, matching the source/type checker grouping.
old = """            while index < declarations.len()
                && recursive_declaration(analysis.module, declarations[index])
            {
                index += 1;
            }
"""
new = """            while index < declarations.len() {
                if recursive_declaration(analysis.module, declarations[index]) {
                    index += 1;
                    continue;
                }
                if signature_declaration(analysis.module, declarations[index])
                    && index + 1 < declarations.len()
                    && recursive_declaration(analysis.module, declarations[index + 1])
                {
                    index += 1;
                    continue;
                }
                break;
            }
"""
if text.count(old) != 1:
    raise SystemExit(
        f"recursive ownership group loop anchor count={text.count(old)}"
    )
text = text.replace(old, new, 1)

anchor = """fn recursive_declaration(module: &Module, declaration: DeclarationId) -> bool {
"""
helper = """fn signature_declaration(module: &Module, declaration: DeclarationId) -> bool {
    matches!(
        module.arena.declarations[declaration.0 as usize],
        Declaration::Binding {
            kind: DeclarationKind::Sig,
            ..
        }
    )
}

"""
if text.count(anchor) != 1:
    raise SystemExit(f"recursive declaration anchor count={text.count(anchor)}")
text = text.replace(anchor, helper + anchor, 1)
path.write_text(text)

# A linear function parameter needs a stable symbolic identity so a function
# that returns the same authority can substitute the caller's concrete Region
# lineage into its result. Ordinary linear values remain anonymous Leaf values.
replace_once(
    path,
    """    Leaf(Qualifier),
    Closure {
""",
    """    Leaf(Qualifier),
    Parameter {
        qualifier: Qualifier,
        source: PatternId,
    },
    Closure {
""",
)

replace_once(
    path,
    """fn written_obligation(qualifier: Qualifier) -> Produced {
    if spendable(qualifier) {
        Produced::Leaf(qualifier)
    } else {
        Produced::None
    }
}

fn written_pattern(pattern: PatternId, module: &Module) -> Produced {
""",
    """fn written_obligation(qualifier: Qualifier) -> Produced {
    if spendable(qualifier) {
        Produced::Leaf(qualifier)
    } else {
        Produced::None
    }
}

fn written_parameter_obligation(qualifier: Qualifier, source: PatternId) -> Produced {
    if spendable(qualifier) {
        Produced::Parameter { qualifier, source }
    } else {
        Produced::None
    }
}

fn written_pattern(pattern: PatternId, module: &Module) -> Produced {
""",
)
replace_once(
    path,
    """        Pattern::Name { qualifier, .. } => written_obligation(*qualifier),
""",
    """        Pattern::Name { qualifier, .. } => {
            written_parameter_obligation(*qualifier, pattern)
        }
""",
)

replace_once(
    path,
    """        Produced::Leaf(Qualifier::Linear) => Obligation::Linear,
        Produced::Leaf(Qualifier::Affine) => Obligation::Affine,
        Produced::Leaf(_) => Obligation::None,
        Produced::Region { qualifier, .. } => match qualifier {
""",
    """        Produced::Leaf(Qualifier::Linear)
        | Produced::Parameter {
            qualifier: Qualifier::Linear,
            ..
        } => Obligation::Linear,
        Produced::Leaf(Qualifier::Affine)
        | Produced::Parameter {
            qualifier: Qualifier::Affine,
            ..
        } => Obligation::Affine,
        Produced::Leaf(_) | Produced::Parameter { .. } => Obligation::None,
        Produced::Region { qualifier, .. } => match qualifier {
""",
)

replace_once(
    path,
    """        Produced::None | Produced::Leaf(_) | Produced::Region { .. } => false,
""",
    """        Produced::None
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::Region { .. } => false,
""",
)

# Outside the compiler's own prelude wrapper certification, a linear parameter
# that reaches a trusted Region operation is known (by the type checker) to be
# Region-typed. Turn that symbolic parameter into a Region root. During prelude
# certification keep it abstract so the existing wrapper-only exemption remains
# the sole trust boundary for join/freeze.
anchor = """fn join_region(left: Produced, right: Produced, span: Span, analysis: &mut Analysis) -> Produced {
"""
helper = """fn region_authority(produced: Produced, trusted_region_wrappers: bool) -> Produced {
    match produced {
        Produced::Parameter { qualifier, .. } if trusted_region_wrappers => {
            Produced::Leaf(qualifier)
        }
        Produced::Parameter { qualifier, source } => Produced::Region {
            qualifier,
            root: Some(source),
            splits: Vec::new(),
        },
        produced => produced,
    }
}

"""
replace_once(path, anchor, helper + anchor)

for operation, arity in [
    ("set", 3),
    ("swap", 3),
    ("split", 2),
    ("freeze", 1),
]:
    old = f'''        if name == "@region.{operation}" && arguments.len() == {arity} {{\n            let region = walk(arguments[0], scope, analysis, Use::Move);\n'''
    new = f'''        if name == "@region.{operation}" && arguments.len() == {arity} {{\n            let region = region_authority(\n                walk(arguments[0], scope, analysis, Use::Move),\n                analysis.trusted_region_wrappers,\n            );\n'''
    replace_once(path, old, new)

replace_once(
    path,
    """        if name == "@region.join" && arguments.len() == 2 {
            let left = walk(arguments[0], scope, analysis, Use::Move);
            let right = walk(arguments[1], scope, analysis, Use::Move);
""",
    """        if name == "@region.join" && arguments.len() == 2 {
            let left = region_authority(
                walk(arguments[0], scope, analysis, Use::Move),
                analysis.trusted_region_wrappers,
            );
            let right = region_authority(
                walk(arguments[1], scope, analysis, Use::Move),
                analysis.trusted_region_wrappers,
            );
""",
)

# Substitute symbolic ownership returned by a function with the concrete
# authority passed at this call. Region split history composes: a callee's
# relative split suffix is appended to the caller's existing prefix. This is
# the Rust parity needed for recursive Region -> Region functions.
replace_once(
    path,
    """    result
}

fn function_contract(
""",
    """    substitute_parameters(result, parameter, &argument_value, analysis.module)
}

fn function_contract(
""",
)

anchor = """fn require_continuation_ownership(
"""
helpers = r'''fn substitute_parameters(
    produced: Produced,
    parameter: Option<PatternId>,
    argument: &Produced,
    module: &Module,
) -> Produced {
    let Some(parameter) = parameter else {
        return produced;
    };
    match (&module.arena.patterns[parameter.0 as usize], argument) {
        (Pattern::Name { .. }, _) => substitute_parameter_source(produced, parameter, argument),
        (
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. },
            Produced::Sequence(values),
        ) => elements
            .iter()
            .zip(values)
            .fold(produced, |current, (pattern, value)| {
                substitute_parameters(current, Some(*pattern), value, module)
            }),
        (Pattern::Constructor { payload: Some(payload), .. }, Produced::Variant(value)) => {
            substitute_parameters(produced, Some(*payload), value, module)
        }
        (Pattern::Shape { fields, .. }, Produced::Shape(values)) => fields
            .iter()
            .fold(produced, |current, field| {
                values.get(&field.name).map_or(current.clone(), |value| {
                    substitute_parameters(current, Some(field.pattern), value, module)
                })
            }),
        _ => produced,
    }
}

fn substitute_parameter_source(
    produced: Produced,
    source: PatternId,
    argument: &Produced,
) -> Produced {
    match produced {
        Produced::None => Produced::None,
        Produced::Borrow(value) => Produced::Borrow(Box::new(substitute_parameter_source(
            *value, source, argument,
        ))),
        Produced::Leaf(qualifier) => Produced::Leaf(qualifier),
        Produced::Parameter {
            qualifier,
            source: found,
        } => {
            if found == source {
                argument.clone()
            } else {
                Produced::Parameter {
                    qualifier,
                    source: found,
                }
            }
        }
        Produced::Closure {
            captures,
            parameter,
            result,
        } => Produced::Closure {
            captures: Box::new(substitute_parameter_source(*captures, source, argument)),
            parameter,
            result: Box::new(substitute_parameter_source(*result, source, argument)),
        },
        Produced::Many(values) => join(
            values
                .into_iter()
                .map(|value| substitute_parameter_source(value, source, argument)),
        ),
        Produced::Sequence(values) => Produced::Sequence(
            values
                .into_iter()
                .map(|value| substitute_parameter_source(value, source, argument))
                .collect(),
        ),
        Produced::Shape(fields) => Produced::Shape(
            fields
                .into_iter()
                .map(|(name, value)| {
                    (name, substitute_parameter_source(value, source, argument))
                })
                .collect(),
        ),
        Produced::Variant(payload) => Produced::Variant(Box::new(
            substitute_parameter_source(*payload, source, argument),
        )),
        Produced::Choice(cases) => Produced::Choice(
            cases
                .into_iter()
                .map(|(name, value)| {
                    (name, substitute_parameter_source(value, source, argument))
                })
                .collect(),
        ),
        Produced::Region {
            qualifier,
            root,
            splits,
        } => {
            if root != Some(source) {
                return Produced::Region {
                    qualifier,
                    root,
                    splits,
                };
            }
            match argument {
                Produced::Region {
                    root: argument_root,
                    splits: argument_splits,
                    ..
                } => {
                    let mut composed = argument_splits.clone();
                    composed.extend(splits);
                    Produced::Region {
                        qualifier,
                        root: *argument_root,
                        splits: composed,
                    }
                }
                Produced::Parameter {
                    source: argument_source,
                    ..
                } => Produced::Region {
                    qualifier,
                    root: Some(*argument_source),
                    splits,
                },
                _ => Produced::Region {
                    qualifier,
                    root,
                    splits,
                },
            }
        }
    }
}

'''
replace_once(path, anchor, helpers + anchor)

print("made sig grouping and Region function-result ownership preserve caller lineage")
