//! Normalizes surface conveniences that are intentionally absent from Core.
//!
//! Two rules live here, matching `src/syntax/surface.ts` node for node:
//!
//! - `@handle (Effect, handler)` is a computation transformer. Applying the
//!   resulting value to a nullary computation produces another nullary
//!   computation containing the ordinary saturated
//!   `@handle (Effect, computation, handler)` call. A `|>` whose right operand
//!   is one of these compiler-local transformers becomes direct application so
//!   an owned computation never passes through generic `Fn.pipe`.
//! - a two-arm `case` over `#True` and `#False` becomes the existing internal
//!   conditional node. `case` is the source value-selection form, while this
//!   keeps the checker's existing branch-refinement machinery and does not add
//!   a second Boolean semantics downstream.
//!
//! Every rewrite overwrites the node at its own arena identity, so the arena
//! keeps exactly the nodes the module reaches.

use crate::ast::{
    AstArena, Branch, Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId,
    Module, Pattern, PatternId, Qualifier, ResultEffects, ShapeMember, Span,
};

pub fn elaborate_surface(module: &mut Module) {
    for declaration in module.declarations.clone() {
        elaborate_declaration(&mut module.arena, declaration);
    }
    elaborate_expression(&mut module.arena, module.result);
}

fn elaborate_declaration(arena: &mut AstArena, id: DeclarationId) {
    let declaration = arena.declarations[id.0 as usize].clone();
    match &declaration {
        Declaration::Binding { tags, value, .. } => {
            for tag in tags {
                elaborate_expression(arena, tag.descriptor);
            }
            elaborate_expression(arena, *value);
        }
        Declaration::Shadow { value, .. } | Declaration::Open { value, .. } => {
            elaborate_expression(arena, *value);
        }
    }
}

fn elaborate_expression(arena: &mut AstArena, id: ExpressionId) {
    let expression = arena.expressions[id.0 as usize].clone();
    match expression {
        Expression::Var { .. }
        | Expression::Int { .. }
        | Expression::Float { .. }
        | Expression::Text { .. }
        | Expression::Unit { .. }
        | Expression::Intrinsic { .. }
        | Expression::Tag { .. } => {}
        Expression::Apply {
            function,
            argument,
            span,
        } => {
            elaborate_expression(arena, function);
            elaborate_expression(arena, argument);
            if let Some((effect, handler)) = handled_pair(arena, function, argument) {
                let transformer = handler_transformer(arena, effect, handler, span);
                arena.expressions[id.0 as usize] = transformer;
                return;
            }
            if let Some(piped) = handler_pipeline(arena, function, argument, span) {
                arena.expressions[id.0 as usize] = piped;
            }
        }
        Expression::Field { target, .. } => elaborate_expression(arena, target),
        Expression::Lambda { body, .. } => elaborate_expression(arena, body),
        Expression::Rec { lambda, .. } => elaborate_expression(arena, lambda),
        Expression::Comptime { body, .. } => elaborate_expression(arena, body),
        Expression::Array { elements, .. } => {
            for element in elements {
                elaborate_expression(arena, element.value);
            }
        }
        Expression::Tuple { elements, .. } => {
            for element in elements {
                elaborate_expression(arena, element);
            }
        }
        Expression::Shape { members, .. } => {
            for member in members {
                match member {
                    ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                        elaborate_expression(arena, value)
                    }
                }
            }
        }
        Expression::If {
            branches, fallback, ..
        } => {
            for branch in branches {
                elaborate_expression(arena, branch.condition);
                elaborate_expression(arena, branch.consequence);
            }
            if let Some(fallback) = fallback {
                elaborate_expression(arena, fallback);
            }
        }
        Expression::Case { target, arms, span } => {
            elaborate_expression(arena, target);
            for arm in &arms {
                elaborate_expression(arena, arm.body);
            }
            let consequence = arms
                .iter()
                .find(|arm| boolean_pattern(arena, arm.pattern, "True"));
            let fallback = arms
                .iter()
                .find(|arm| boolean_pattern(arena, arm.pattern, "False"));
            if let (2, Some(consequence), Some(fallback)) = (arms.len(), consequence, fallback) {
                arena.expressions[id.0 as usize] = Expression::If {
                    branches: vec![Branch {
                        condition: target,
                        consequence: consequence.body,
                    }],
                    fallback: Some(fallback.body),
                    span,
                };
            }
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            for declaration in declarations {
                elaborate_declaration(arena, declaration);
            }
            elaborate_expression(arena, result);
        }
    }
}

fn boolean_pattern(arena: &AstArena, id: PatternId, name: &str) -> bool {
    matches!(
        &arena.patterns[id.0 as usize],
        Pattern::Constructor {
            name: candidate,
            payload: None,
            ..
        } if candidate == name
    )
}

/// The `(Effect, handler)` pair of an unsaturated `@handle` application.
fn handled_pair(
    arena: &AstArena,
    function: ExpressionId,
    argument: ExpressionId,
) -> Option<(ExpressionId, ExpressionId)> {
    let Expression::Intrinsic { name, .. } = &arena.expressions[function.0 as usize] else {
        return None;
    };
    if name != "@handle" {
        return None;
    }
    let Expression::Tuple { elements, .. } = &arena.expressions[argument.0 as usize] else {
        return None;
    };
    let [effect, handler] = elements.as_slice() else {
        return None;
    };
    Some((*effect, *handler))
}

fn handler_pipeline(
    arena: &AstArena,
    function: ExpressionId,
    argument: ExpressionId,
    span: Span,
) -> Option<Expression> {
    if !is_handler_transformer(arena, argument) {
        return None;
    }
    let Expression::Apply {
        function: piped,
        argument: value,
        ..
    } = &arena.expressions[function.0 as usize]
    else {
        return None;
    };
    if !is_fn_pipe(arena, *piped) {
        return None;
    }
    Some(Expression::Apply {
        function: argument,
        argument: *value,
        span,
    })
}

fn is_fn_pipe(arena: &AstArena, id: ExpressionId) -> bool {
    let Expression::Field { target, name, .. } = &arena.expressions[id.0 as usize] else {
        return false;
    };
    if name != "pipe" {
        return false;
    }
    matches!(
        &arena.expressions[target.0 as usize],
        Expression::Var { name, .. } if name == "Fn"
    )
}

fn is_handler_transformer(arena: &AstArena, id: ExpressionId) -> bool {
    let Expression::Lambda { parameter, .. } = &arena.expressions[id.0 as usize] else {
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
    arena: &mut AstArena,
    effect: ExpressionId,
    handler: ExpressionId,
    span: Span,
) -> Expression {
    let computation_name = format!("handlerInput${}${}", span.start, span.end);
    let result_name = format!("handlerResult${}${}", span.start, span.end);
    let computation = arena.expression(Expression::Var {
        name: computation_name.clone(),
        span,
    });
    let handle = arena.expression(Expression::Intrinsic {
        name: "@handle".to_owned(),
        span,
    });
    let arguments = arena.expression(Expression::Tuple {
        elements: vec![effect, computation, handler],
        span,
    });
    let saturated = arena.expression(Expression::Apply {
        function: handle,
        argument: arguments,
        span,
    });
    let result_pattern = arena.pattern(Pattern::Name {
        name: result_name.clone(),
        qualifier: Qualifier::None,
        span,
    });
    let binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Effect,
        tags: Vec::new(),
        pattern: result_pattern,
        value: saturated,
        span,
    });
    let result = arena.expression(Expression::Var {
        name: result_name,
        span,
    });
    let block = arena.expression(Expression::Block {
        declarations: vec![binding],
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
    Expression::Lambda {
        parameter,
        body: delayed,
        span,
    }
}
