from pathlib import Path

path = Path("experiments/rust-middle/src/lower.rs")
text = path.read_text()

case_marker = """fn lower_guards(
    target: ExpressionId,
    arms: &[GuardedArm],
    span: Span,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    if arms.iter().all(|arm| arm.guard.is_none()) {
"""
case_replacement = """fn lower_guards(
    target: ExpressionId,
    arms: &[GuardedArm],
    span: Span,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    if arms.len() == 2 && arms.iter().all(|arm| arm.guard.is_none()) {
        let mut true_body = None;
        let mut false_body = None;
        for arm in arms {
            match &arena.patterns[arm.pattern.0 as usize] {
                Pattern::Constructor {
                    name,
                    payload: None,
                    ..
                } if name == "True" => true_body = Some(arm.body),
                Pattern::Constructor {
                    name,
                    payload: None,
                    ..
                } if name == "False" => false_body = Some(arm.body),
                _ => {}
            }
        }
        if let (Some(consequence), Some(fallback)) = (true_body, false_body) {
            return Ok(arena.expression(Expression::If {
                branches: vec![Branch {
                    condition: target,
                    consequence,
                }],
                fallback: Some(fallback),
                span,
            }));
        }
    }
    if arms.iter().all(|arm| arm.guard.is_none()) {
"""
if text.count(case_marker) != 1:
    raise SystemExit("Rust case lowering marker changed")
path.write_text(text.replace(case_marker, case_replacement, 1))
