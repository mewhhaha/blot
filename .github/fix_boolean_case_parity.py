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
text = text.replace(case_marker, case_replacement, 1)

fold_marker = """    context.table.fold_chain(first, &steps, arena)
}

fn lower_operand(
"""
fold_replacement = """    let expression = context.table.fold_chain(first, &steps, arena)?;
    Ok(elaborate_surface_application(expression, arena))
}

fn elaborate_surface_application(
    expression: ExpressionId,
    arena: &mut AstArena,
) -> ExpressionId {
    let node = arena.expressions[expression.0 as usize].clone();
    let Expression::Apply {
        function,
        argument,
        span,
    } = node
    else {
        return expression;
    };
    let function = elaborate_surface_application(function, arena);
    let argument = elaborate_surface_application(argument, arena);
    if is_handle_intrinsic(function, arena)
        && let Expression::Tuple { elements, .. } =
            arena.expressions[argument.0 as usize].clone()
        && elements.len() == 2
    {
        return handler_transformer(elements[0], elements[1], span, arena);
    }
    if is_handler_transformer(argument, arena)
        && let Expression::Apply {
            function: pipe,
            argument: input,
            ..
        } = arena.expressions[function.0 as usize].clone()
        && is_fn_pipe(pipe, arena)
    {
        return arena.expression(Expression::Apply {
            function: argument,
            argument: input,
            span,
        });
    }
    arena.expression(Expression::Apply {
        function,
        argument,
        span,
    })
}

fn is_handle_intrinsic(expression: ExpressionId, arena: &AstArena) -> bool {
    matches!(
        &arena.expressions[expression.0 as usize],
        Expression::Intrinsic { name, .. } if name == "@handle"
    )
}

fn is_fn_pipe(expression: ExpressionId, arena: &AstArena) -> bool {
    let Expression::Field { target, name, .. } =
        &arena.expressions[expression.0 as usize]
    else {
        return false;
    };
    name == "pipe"
        && matches!(
            &arena.expressions[target.0 as usize],
            Expression::Var { name, .. } if name == "Fn"
        )
}

fn is_handler_transformer(expression: ExpressionId, arena: &AstArena) -> bool {
    let Expression::Lambda { parameter, .. } =
        &arena.expressions[expression.0 as usize]
    else {
        return false;
    };
    matches!(
        &arena.patterns[parameter.0 as usize],
        Pattern::Name {
            name,
            qualifier: Qualifier::Linear,
            ..
        } if name.starts_with("handlerInput$")
    )
}

fn handler_transformer(
    effect: ExpressionId,
    handler: ExpressionId,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    let computation_name = format!("handlerInput${}${}", span.start, span.end);
    let result_name = format!("handlerResult${}${}", span.start, span.end);
    let computation = variable(&computation_name, span, arena);
    let tuple = arena.expression(Expression::Tuple {
        elements: vec![effect, computation, handler],
        span,
    });
    let intrinsic = arena.expression(Expression::Intrinsic {
        name: "@handle".to_owned(),
        span,
    });
    let saturated = arena.expression(Expression::Apply {
        function: intrinsic,
        argument: tuple,
        span,
    });
    let result_pattern = arena.pattern(Pattern::Name {
        name: result_name.clone(),
        qualifier: Qualifier::None,
        span,
    });
    let result_binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Effect,
        tags: Vec::new(),
        pattern: result_pattern,
        value: saturated,
        span,
    });
    let result = variable(&result_name, span, arena);
    let block = arena.expression(Expression::Block {
        declarations: vec![result_binding],
        result,
        result_effects: ResultEffects::Ambient,
        span,
    });
    let unit = arena.pattern(Pattern::Unit { span });
    let delayed = arena.expression(Expression::Lambda {
        parameter: unit,
        body: block,
        span,
    });
    let parameter = arena.pattern(Pattern::Name {
        name: computation_name,
        qualifier: Qualifier::Linear,
        span,
    });
    arena.expression(Expression::Lambda {
        parameter,
        body: delayed,
        span,
    })
}

fn lower_operand(
"""
if text.count(fold_marker) != 1:
    raise SystemExit("Rust fixity lowering marker changed")
text = text.replace(fold_marker, fold_replacement, 1)

path.write_text(text)
