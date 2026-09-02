from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one replacement, found {count}: {old[:160]!r}"
        )
    target.write_text(text.replace(old, new, 1))


path = "compiler/src/typecheck.rs"
replace_once(
    path,
    """        if self
            .expression_types
            .borrow()
            .contains_key(path, &expression)
            && !matches!(
                module.arena.expressions[expression.0 as usize],
                Expression::Int { .. } | Expression::Float { .. }
            )
        {
""",
    """        if self
            .expression_types
            .borrow()
            .contains_key(path, &expression)
        {
""",
)
