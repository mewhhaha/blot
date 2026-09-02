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
    """                let result =
                    self.constrain_ids(candidate_id, variable_id, span, &mut HashSet::new());
                self.bound_insertions.borrow_mut().clear();
                result?;
""",
    """                let result = self
                    .constrain_ids(candidate_id, variable_id, span, &mut HashSet::new())
                    .and_then(|()| {
                        self.constrain_ids(variable_id, candidate_id, span, &mut HashSet::new())
                    });
                self.bound_insertions.borrow_mut().clear();
                result?;
""",
)
