from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement site, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "compiler/src/typecheck.rs",
    """                let names = pattern_names(module, pattern);
                let recursive_name = recursive.then(|| {
""",
    """                let names = pattern_names(module, pattern);
                let loop_stable_names = if matches!(
                    &module.arena.expressions[value.0 as usize],
                    Expression::Var { name, .. } if name == "loop$"
                ) {
                    names
                        .iter()
                        .filter_map(|name| {
                            let typing = types.lookup_stable(name, self)?;
                            let type_ = match &typing {
                                Typing::Mono(type_) => type_,
                                Typing::Scheme { body, .. } => body,
                            };
                            match self.settle(type_.clone(), true) {
                                Type::Variant { cases, open: false } if cases.len() > 1 => {
                                    Some((name.clone(), typing))
                                }
                                _ => None,
                            }
                        })
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
                let recursive_name = recursive.then(|| {
""",
)

replace_once(
    "compiler/src/typecheck.rs",
    """                let synthetic_loop = recursive
                    && names.len() == 1
                    && names[0] == "go$"
                    && module.arena.synthetic_expressions.contains(&value);
                let generalized = !synthetic_loop
                    && kind != DeclarationKind::Effect
                    && names
                        .iter()
                        .all(|name| !name.starts_with(FIXITY_INTERMEDIATE_PREFIX));
""",
    """                let generalized = kind != DeclarationKind::Effect
                    && names
                        .iter()
                        .all(|name| !name.starts_with(FIXITY_INTERMEDIATE_PREFIX));
""",
)

replace_once(
    "compiler/src/typecheck.rs",
    """                self.bind_pattern(module, pattern, inferred.type_.clone(), types);
                if let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] {
""",
    """                self.bind_pattern(module, pattern, inferred.type_.clone(), types);
                for (name, typing) in loop_stable_names {
                    Rc::make_mut(&mut types.stable_names).insert(name, typing);
                }
                if let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] {
""",
)

replace_once(
    "docs/inference.md",
    """A lowered `for` keeps its generated recursive accumulator monomorphic. The first
call therefore contributes the enclosing bindings' stable types to the same
inference variables used by every back edge, instead of generalizing a loop body
from a narrower replacement before the initial state is seen.
""",
    """A lowered `for` keeps an already-wider closed constructor type from the source
binding as stable-lineage context when it destructures the accumulator. The
recursive accumulator itself remains inferred normally. This distinction keeps
an explicitly `Bool` binding Boolean while allowing an unannotated `#False`
accumulator to widen from the values produced by its back edges.
""",
)

replace_once(
    "spec/TYPECHECKING.md",
    """Stable rebinding checks its replacement against the binding lineage's existing
type and retains that existing type in the environment. This is subsumption, not
symmetric unification: a constructor such as `#True` may inhabit the stable
`#True | #False` type without narrowing the lineage. Lowered `for` recursion is
monomorphic so its initial accumulator and every back edge constrain one shared
type graph; generalizing the generated recursive function before its initial
call would lose that context and incorrectly narrow the accumulator to a single
replacement.
""",
    """Stable rebinding checks its replacement against the binding lineage's existing
type and retains that existing type in the environment. This is subsumption, not
symmetric unification: a constructor such as `#True` may inhabit the stable
`#True | #False` type without narrowing the lineage. When `for` lowering
introduces its unspellable `loop$` accumulator binding, a closed
multi-constructor variant already established for a carried source name is
retained separately as that name's stable lineage. The generated recursion is
otherwise inferred normally, so an unannotated singleton accumulator may still
widen from its recursive back edges.
""",
)
