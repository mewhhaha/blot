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
    """    fn constrain(&self, left: Type, right: Type, span: Span) -> Result<(), Diagnostic> {
        debug_assert!(self.bound_insertions.borrow().is_empty());
        let left = self.constraint_type(&left);
        let right = self.constraint_type(&right);
        let result = self
            .constrain_ids(left, right, span, &mut HashSet::new())
            .and_then(|()| self.resolve_numeric_literals(false, span));
        self.bound_insertions.borrow_mut().clear();
        result
    }
""",
    """    fn constrain(&self, left: Type, right: Type, span: Span) -> Result<(), Diagnostic> {
        debug_assert!(self.bound_insertions.borrow().is_empty());
        let left = self.constraint_type(&left);
        let right = self.constraint_type(&right);
        let result = self.constrain_ids(left, right, span, &mut HashSet::new());
        self.bound_insertions.borrow_mut().clear();
        result?;
        self.resolve_numeric_literals(false, span)
    }
""",
)

replace_once(
    path,
    """                self.constrain_ids(candidate_id, variable_id, span, &mut HashSet::new())?;
                {
""",
    """                let result =
                    self.constrain_ids(candidate_id, variable_id, span, &mut HashSet::new());
                self.bound_insertions.borrow_mut().clear();
                result?;
                {
""",
)
