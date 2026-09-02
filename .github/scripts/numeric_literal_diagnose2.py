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


replace_once(
    "compiler/src/hir.rs",
    """        if result.type_id != expected {
            return Err(hir_error(
                "A function export result does not match its checked type.",
            ));
        }
""",
    """        if result.type_id != expected {
            return Err(hir_error(&format!(
                "Function export `{name}` result type {} ({:?}) does not match checked type {} ({:?}); value {}.",
                result.type_id,
                self.types[result.type_id],
                expected,
                self.types[expected],
                crate::value::show(&value),
            )));
        }
""",
)
