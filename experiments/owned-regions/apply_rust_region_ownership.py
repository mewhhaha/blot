from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))

path = "experiments/rust-middle/src/ownership.rs"

replace_once(
    path,
    '''    Shape(BTreeMap<String, Produced>),
    Variant(Box<Produced>),
}
''',
    '''    Shape(BTreeMap<String, Produced>),
    Variant(Box<Produced>),
    Choice(BTreeMap<String, Produced>),
    Region {
        qualifier: Qualifier,
        root: Option<PatternId>,
        splits: Vec<(Span, u8)>,
    },
}
''',
)
replace_once(
    path,
    '''            let owned = if relevant(&produced) {
                produced
            } else {
                written
            };
            let qualifier = inherited(*qualifier, &owned);
''',
    '''            let mut owned = if relevant(&produced) {
                produced
            } else {
                written
            };
            if let Produced::Region { root, .. } = &mut owned
                && root.is_none()
            {
                *root = Some(pattern);
            }
            let qualifier = inherited(*qualifier, &owned);
''',
)
replace_once(
    path,
    '''                declare(arm.pattern, target.clone(), &inner, analysis);
                produced.push(walk(arm.body, &inner, analysis, kind));
''',
    '''                let arm_target = choice_for_pattern(&target, arm.pattern, analysis.module);
                declare(arm.pattern, arm_target, &inner, analysis);
                produced.push(walk(arm.body, &inner, analysis, kind));
''',
)
anchor = '''        if name == "@array.get" && arguments.len() == 2 {
'''
region_rules = r'''        if name == "@region.array.claim" && arguments.len() == 1 {
            let source = walk(arguments[0], scope, analysis, Use::Project);
            if obligation(&source) != Obligation::None {
                analysis.report(
                    "BLOT_REGION_OWNED_ELEMENT",
                    "The first Region implementation copies its input, so arrays containing owned elements cannot be claimed yet.",
                    analysis.module.arena.expression_span(arguments[0]),
                );
            }
            return Produced::Region {
                qualifier: Qualifier::Linear,
                root: None,
                splits: Vec::new(),
            };
        }
        if name == "@region.array.length" && arguments.len() == 1 {
            walk(arguments[0], scope, analysis, Use::Borrow);
            return Produced::None;
        }
        if name == "@region.array.get" && arguments.len() == 2 {
            walk(arguments[0], scope, analysis, Use::Borrow);
            walk(arguments[1], scope, analysis, Use::Move);
            return Produced::None;
        }
        if name == "@region.array.set" && arguments.len() == 3 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            walk(arguments[1], scope, analysis, Use::Move);
            let replacement = walk(arguments[2], scope, analysis, Use::Move);
            if obligation(&replacement) != Obligation::None {
                analysis.report(
                    "BLOT_REGION_OWNED_ELEMENT",
                    "Region replacement cannot move an owned element in the first implementation.",
                    analysis.module.arena.expression_span(arguments[2]),
                );
            }
            return region;
        }
        if name == "@region.array.swap" && arguments.len() == 3 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            walk(arguments[1], scope, analysis, Use::Move);
            walk(arguments[2], scope, analysis, Use::Move);
            return region;
        }
        if name == "@region.array.split" && arguments.len() == 2 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            walk(arguments[1], scope, analysis, Use::Move);
            let Produced::Region {
                qualifier,
                root,
                splits,
            } = region.clone()
            else {
                analysis.report(
                    "BLOT_REGION_SPLIT_NOT_OWNED",
                    "Region split requires one owned Region authority.",
                    analysis.module.arena.expression_span(arguments[0]),
                );
                return Produced::None;
            };
            let mut left_splits = splits.clone();
            left_splits.push((span, 0));
            let mut right_splits = splits;
            right_splits.push((span, 1));
            return Produced::Choice(BTreeMap::from([
                (
                    "Split".to_owned(),
                    Produced::Variant(Box::new(Produced::Sequence(vec![
                        Produced::Region {
                            qualifier,
                            root,
                            splits: left_splits,
                        },
                        Produced::Region {
                            qualifier,
                            root,
                            splits: right_splits,
                        },
                    ]))),
                ),
                (
                    "SplitOutOfBounds".to_owned(),
                    Produced::Variant(Box::new(region)),
                ),
            ]));
        }
        if name == "@region.array.join" && arguments.len() == 2 {
            let left = walk(arguments[0], scope, analysis, Use::Move);
            let right = walk(arguments[1], scope, analysis, Use::Move);
            return join_region(left, right, span, analysis);
        }
        if name == "@region.array.freeze" && arguments.len() == 1 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            match region {
                Produced::Region { splits, .. } if splits.is_empty() => {}
                _ => analysis.report(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region authority can be frozen. Rejoin every split first.",
                    analysis.module.arena.expression_span(arguments[0]),
                ),
            }
            return Produced::None;
        }
'''
replace_once(path, anchor, region_rules + anchor)
replace_once(
    path,
    '''        Produced::Leaf(_) => Obligation::None,
        Produced::Closure { captures, .. } | Produced::Variant(captures) => obligation(captures),
''',
    '''        Produced::Leaf(_) => Obligation::None,
        Produced::Region { qualifier, .. } => match qualifier {
            Qualifier::Linear => Obligation::Linear,
            Qualifier::Affine => Obligation::Affine,
            _ => Obligation::None,
        },
        Produced::Closure { captures, .. } | Produced::Variant(captures) => obligation(captures),
        Produced::Choice(cases) => cases.values().fold(Obligation::None, |found, value| {
            merge_obligation(found, obligation(value))
        }),
''',
)
replace_once(
    path,
    '''        Produced::None | Produced::Leaf(_) => false,
''',
    '''        Produced::None | Produced::Leaf(_) | Produced::Region { .. } => false,
''',
)
replace_once(
    path,
    '''        Produced::Shape(fields) => fields.values().any(contains_borrow),
        Produced::Variant(payload) => contains_borrow(payload),
''',
    '''        Produced::Shape(fields) => fields.values().any(contains_borrow),
        Produced::Variant(payload) => contains_borrow(payload),
        Produced::Choice(cases) => cases.values().any(contains_borrow),
''',
)
replace_once(
    path,
    '''fn combine(left: Produced, right: Produced) -> Produced {
    if !relevant(&left) {
''',
    '''fn combine(left: Produced, right: Produced) -> Produced {
    if left == right {
        return left;
    }
    if !relevant(&left) {
''',
)
helper_anchor = '''fn pattern_binds(pattern: PatternId, module: &Module) -> bool {
'''
helpers = r'''fn choice_for_pattern(target: &Produced, pattern: PatternId, module: &Module) -> Produced {
    let Produced::Choice(cases) = target else {
        return target.clone();
    };
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Constructor { name, .. } => cases.get(name).cloned().unwrap_or(Produced::None),
        _ => join(cases.values().cloned()),
    }
}

fn join_region(left: Produced, right: Produced, span: Span, analysis: &mut Analysis) -> Produced {
    let (
        Produced::Region {
            qualifier: left_qualifier,
            root: left_root,
            splits: mut left_splits,
        },
        Produced::Region {
            qualifier: right_qualifier,
            root: right_root,
            splits: right_splits,
        },
    ) = (left, right)
    else {
        analysis.report(
            "BLOT_REGION_JOIN_UNPROVED",
            "Region join needs exactly one authority on each side.",
            span,
        );
        return Produced::None;
    };
    let Some((left_split, left_part)) = left_splits.last().copied() else {
        analysis.report(
            "BLOT_REGION_JOIN_UNPROVED",
            "Region join needs two sibling authorities produced by a split.",
            span,
        );
        return Produced::None;
    };
    let Some((right_split, right_part)) = right_splits.last().copied() else {
        analysis.report(
            "BLOT_REGION_JOIN_UNPROVED",
            "Region join needs two sibling authorities produced by a split.",
            span,
        );
        return Produced::None;
    };
    let siblings = left_qualifier == right_qualifier
        && left_root == right_root
        && left_splits.len() == right_splits.len()
        && left_splits[..left_splits.len() - 1] == right_splits[..right_splits.len() - 1]
        && left_split == right_split
        && left_part == 0
        && right_part == 1;
    if !siblings {
        analysis.report(
            "BLOT_REGION_JOIN_UNPROVED",
            "Region join accepts only the ordered sibling pair produced by one Region split.",
            span,
        );
        return Produced::None;
    }
    left_splits.pop();
    Produced::Region {
        qualifier: left_qualifier,
        root: left_root,
        splits: left_splits,
    }
}

'''
replace_once(path, helper_anchor, helpers + helper_anchor)
replace_once(
    path,
    '''                || matches!(name.as_str(), "@array.len" | "@shape.has")
''',
    '''                || matches!(
                    name.as_str(),
                    "@array.len" | "@shape.has" | "@region.array.length" | "@region.array.get"
                )
''',
)
print("applied Rust Region path-sensitive ownership proof")
