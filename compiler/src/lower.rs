use std::collections::HashMap;
use std::str::FromStr;

use num_bigint::BigInt;

use crate::ast::{
    Arm, ArrayElement, Associativity, AstArena, Branch, Declaration, DeclarationId,
    DeclarationKind, DeclarationTag, Expression, ExpressionId, Fixity, Module, Pattern, PatternId,
    Qualifier, ResultEffects, ShapeMember, ShapePatternField, Span,
};
use crate::cst::{CompactCst, Cursor};
use crate::fixity::{ChainStep, FixityTable, target_expression};

#[derive(Clone, Copy, Eq, PartialEq)]
enum EscapeBoundary {
    None,
    ValueCondition,
}

#[derive(Clone)]
struct LoopControl {
    carried: Vec<String>,
    break_constructor: String,
}

#[derive(Clone)]
struct LoweringContext<'a> {
    table: &'a FixityTable,
    loop_control: Option<LoopControl>,
    return_scope: bool,
    escape_boundary: EscapeBoundary,
    pattern_head: bool,
}

impl<'a> LoweringContext<'a> {
    fn root(table: &'a FixityTable) -> Self {
        Self {
            table,
            loop_control: None,
            return_scope: true,
            escape_boundary: EscapeBoundary::None,
            pattern_head: false,
        }
    }

    fn body(&self) -> Self {
        Self {
            table: self.table,
            loop_control: None,
            return_scope: false,
            escape_boundary: EscapeBoundary::None,
            pattern_head: false,
        }
    }

    fn value_condition(&self) -> Self {
        Self {
            table: self.table,
            loop_control: None,
            return_scope: false,
            escape_boundary: EscapeBoundary::ValueCondition,
            pattern_head: false,
        }
    }
}

pub fn lower_module(cst: &CompactCst<'_>) -> Result<Module, String> {
    let root = as_rule(cst.root())?;
    require_rule(cst, root, "program")?;
    let span = cst.span(Cursor::Rule(root))?;
    let mut arena = AstArena::default();
    let parameter = match cst.field(root, "header")? {
        Some(header) => {
            let header = as_rule(header)?;
            Some(lower_pattern(
                cst,
                required(cst, header, "parameter")?,
                &mut arena,
            )?)
        }
        None => None,
    };
    let fixities = match cst.field(root, "operators")? {
        Some(section) => {
            let section = as_rule(section)?;
            cst.field_list(section, "declarations")?
                .into_iter()
                .map(|cursor| lower_fixity(cst, cursor))
                .collect::<Result<Vec<_>, _>>()?
        }
        None => Vec::new(),
    };
    let table = FixityTable::new(&fixities);
    let context = LoweringContext::root(&table);
    let mut statements = cst.field_list(root, "declarations")?;
    let mut result = arena.expression(Expression::Unit { span });
    let mut result_effects = ResultEffects::Pure;
    if let Some(last) = statements.last().copied()
        && let Some(terminal_return) = lower_terminal_return(cst, last, &context, &mut arena)?
    {
        result = terminal_return;
        result_effects = ResultEffects::Ambient;
        statements.pop();
    }
    let (lowered_declarations, result_effects) = if statements_need_control(cst, &statements)? {
        let pure_result = arena.expression(Expression::Block {
            declarations: Vec::new(),
            result,
            result_effects,
            span: arena.expression_span(result),
        });
        result =
            resolve_control_sequence(cst, &statements, pure_result, &context, span, &mut arena)?;
        (Vec::new(), ResultEffects::Ambient)
    } else {
        let mut lowered = Vec::new();
        for declaration in statements {
            let declaration = unwrapped_rule(cst, declaration)?;
            let name = cst.rule_name(declaration)?;
            lowered.push(
                lower_declaration(cst, declaration, &context, &mut arena)
                    .map_err(|error| format!("while lowering {name}: {error}"))?,
            );
        }
        (lowered, result_effects)
    };
    elaborate_handler_steps(&mut arena);
    Ok(Module {
        parameter,
        fixities,
        declarations: lowered_declarations,
        result,
        result_effects,
        span,
        arena,
    })
}

/// Mirrors the handler rules source elaboration applies in
/// `src/syntax/surface.ts`. Both compilers must hand the checker the same
/// tree, so the two-argument `@handle` step and the `|>` that saturates it are
/// resolved here rather than in either backend.
///
/// Lowering allocates a node after its children, so walking the arena forward
/// visits an inner step before the pipe that consumes it — the order the
/// recursive elaboration has for free.
fn elaborate_handler_steps(arena: &mut AstArena) {
    let mut steps: HashMap<u32, (ExpressionId, ExpressionId)> = HashMap::new();
    for index in 0..arena.expressions.len() {
        let Expression::Apply {
            function,
            argument,
            span,
        } = arena.expressions[index]
        else {
            continue;
        };
        if let Some(&(effect, handler)) = steps.get(&argument.0)
            && let Expression::Apply {
                function: piped,
                argument: computation,
                ..
            } = arena.expressions[function.0 as usize]
            && is_pipe(arena, piped)
        {
            arena.expressions[index] =
                handled_computation(effect, computation, handler, span, arena);
            continue;
        }
        if !matches!(
            &arena.expressions[function.0 as usize],
            Expression::Intrinsic { name, .. } if name == "@handle"
        ) {
            continue;
        }
        let Expression::Tuple { elements, .. } = &arena.expressions[argument.0 as usize] else {
            continue;
        };
        let [effect, handler] = elements[..] else {
            continue;
        };
        arena.expressions[index] = handler_transformer(effect, handler, span, arena);
        steps.insert(index as u32, (effect, handler));
    }
}

fn is_pipe(arena: &AstArena, expression: ExpressionId) -> bool {
    let Expression::Field { target, name, .. } = &arena.expressions[expression.0 as usize] else {
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

/// `@handle (effect, handler)` as a value: the computation is still to come,
/// and the parameter owns it because the step consumes it exactly once.
fn handler_transformer(
    effect: ExpressionId,
    handler: ExpressionId,
    span: Span,
    arena: &mut AstArena,
) -> Expression {
    let name = format!("handlerInput${}${}", span.start, span.end);
    let parameter = arena.pattern(Pattern::Name {
        name: name.clone(),
        qualifier: Qualifier::Linear,
        span,
    });
    let computation = variable(&name, span, arena);
    let body = handled_computation(effect, computation, handler, span, arena);
    let body = arena.expression(body);
    Expression::Lambda {
        parameter,
        body,
        reuse: false,
        deferred: false,
        span,
    }
}

/// The nullary computation a step produces around a known computation. The
/// computation reaches `@handle` as itself rather than through the step's
/// parameter, so a handler clause answers to what the program owns.
fn handled_computation(
    effect: ExpressionId,
    computation: ExpressionId,
    handler: ExpressionId,
    span: Span,
    arena: &mut AstArena,
) -> Expression {
    let name = format!("handlerResult${}${}", span.start, span.end);
    let intrinsic = arena.expression(Expression::Intrinsic {
        name: "@handle".to_owned(),
        span,
    });
    let argument = arena.expression(Expression::Tuple {
        elements: vec![effect, computation, handler],
        span,
    });
    let saturated = arena.expression(Expression::Apply {
        function: intrinsic,
        argument,
        span,
    });
    let pattern = arena.pattern(Pattern::Name {
        name: name.clone(),
        qualifier: Qualifier::None,
        span,
    });
    let binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Effect,
        tags: Vec::new(),
        pattern,
        value: saturated,
        span,
    });
    let result = variable(&name, span, arena);
    let body = arena.expression(Expression::Block {
        declarations: vec![binding],
        result,
        result_effects: ResultEffects::Ambient,
        span,
    });
    let parameter = arena.pattern(Pattern::Unit { span });
    Expression::Lambda {
        parameter,
        body,
        reuse: false,
        deferred: false,
        span,
    }
}

fn lower_fixity(cst: &CompactCst<'_>, cursor: Cursor) -> Result<Fixity, String> {
    let rule = as_rule(cursor)?;
    let associativity = match token_text(cst, required(cst, rule, "associativity")?)?.as_str() {
        "infixl" => Associativity::Left,
        "infixr" => Associativity::Right,
        "infix" => Associativity::None,
        "prefix" => Associativity::Prefix,
        value => return Err(format!("unknown associativity {value}")),
    };
    let precedence = token_text(cst, required(cst, rule, "precedence")?)?
        .parse::<u32>()
        .map_err(|error| format!("invalid fixity precedence: {error}"))?;
    let target_rule = as_rule(required(cst, rule, "target")?)?;
    let mut target = vec![token_text(cst, required(cst, target_rule, "root")?)?];
    for part in cst.field_list(target_rule, "rest")? {
        target.push(token_text(cst, required(cst, as_rule(part)?, "name")?)?);
    }
    Ok(Fixity {
        operator: token_text(cst, required(cst, rule, "operator")?)?,
        associativity,
        precedence,
        target,
        span: cst.span(Cursor::Rule(rule))?,
    })
}

#[derive(Clone)]
struct EffectRowTailUse {
    name: String,
    count: usize,
    span: Span,
}

fn effect_row_tail_uses(
    cst: &CompactCst<'_>,
    cursor: Cursor,
) -> Result<Vec<EffectRowTailUse>, String> {
    fn visit(
        cst: &CompactCst<'_>,
        cursor: Cursor,
        uses: &mut Vec<EffectRowTailUse>,
    ) -> Result<(), String> {
        let Cursor::Rule(rule) = cursor else {
            return Ok(());
        };
        let name = cst.rule_name(rule)?;
        if name == "binding" {
            return Ok(());
        }
        if name == "effect_row_tail" {
            let name_cursor = required(cst, rule, "name")?;
            let name = token_text(cst, name_cursor)?;
            if let Some(existing) = uses.iter_mut().find(|use_| use_.name == name) {
                existing.count += 1;
            } else {
                uses.push(EffectRowTailUse {
                    name,
                    count: 1,
                    span: cst.span(name_cursor)?,
                });
            }
            return Ok(());
        }
        if name == "effect_row" {
            let children = cst.children(rule)?;
            let mut index = 0;
            while index < children.len() {
                let child = children[index];
                if matches!(child, Cursor::Token(_))
                    && cst.text(child)? == ".."
                    && let Some(Cursor::Token(name_cursor)) = children.get(index + 1).copied()
                {
                    let name = cst.text(Cursor::Token(name_cursor))?;
                    if let Some(existing) = uses.iter_mut().find(|use_| use_.name == name) {
                        existing.count += 1;
                    } else {
                        uses.push(EffectRowTailUse {
                            name,
                            count: 1,
                            span: cst.span(Cursor::Token(name_cursor))?,
                        });
                    }
                    index += 2;
                    continue;
                }
                visit(cst, child, uses)?;
                index += 1;
            }
            return Ok(());
        }
        for child in cst.children(rule)? {
            visit(cst, child, uses)?;
        }
        Ok(())
    }

    let mut uses = Vec::new();
    visit(cst, cursor, &mut uses)?;
    Ok(uses)
}

fn quantify_effect_row_tails(
    mut value: ExpressionId,
    tails: &[EffectRowTailUse],
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    for tail in tails.iter().rev() {
        let parameter = arena.pattern(Pattern::Name {
            name: tail.name.clone(),
            qualifier: Qualifier::None,
            span: tail.span,
        });
        let lambda = arena.expression(Expression::Lambda {
            parameter,
            body: value,
            reuse: false,
            deferred: false,
            span,
        });
        let function = arena.expression(Expression::Intrinsic {
            name: "@forall".to_owned(),
            span: tail.span,
        });
        value = arena.expression(Expression::Apply {
            function,
            argument: lambda,
            span,
        });
    }
    value
}

fn finish_source_block(
    phase: &str,
    body: ExpressionId,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    if phase == "compdo" {
        return arena.expression(Expression::Comptime { body, span });
    }
    body
}

fn lower_declaration(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<DeclarationId, String> {
    let span = cst.span(Cursor::Rule(rule))?;
    match cst.rule_name(rule)? {
        "binding" => {
            let kind = match token_text(cst, required(cst, rule, "kind")?)?.as_str() {
                "let" => DeclarationKind::Let,
                "const" => DeclarationKind::Const,
                "sig" => DeclarationKind::Sig,
                value => return Err(format!("unknown binding kind {value}")),
            };
            let mut tags = Vec::new();
            for tag in cst.field_list(rule, "tags")? {
                let tag = as_rule(tag)?;
                tags.push(DeclarationTag {
                    descriptor: lower_value(
                        cst,
                        required(cst, tag, "descriptor")?,
                        context,
                        arena,
                    )?,
                    span: cst.span(Cursor::Rule(tag))?,
                });
            }
            if kind == DeclarationKind::Sig && !tags.is_empty() {
                return Err(
                    "BLOT_TAGGED_SIG: a signature cannot carry a declaration tag".to_owned(),
                );
            }
            let pattern = lower_pattern(cst, required(cst, rule, "pattern")?, arena)
                .map_err(|error| format!("while lowering its pattern: {error}"))?;
            let value_cursor = required(cst, rule, "value")?;
            if let Cursor::Token(_) = value_cursor {
                return Err(format!(
                    "binding value field is token `{}`",
                    cst.text(value_cursor)?
                ));
            }
            let row_tails = effect_row_tail_uses(cst, value_cursor)?;
            if !row_tails.is_empty() && kind != DeclarationKind::Sig {
                return Err(
                    "BLOT_EFFECT_ROW_TAIL_OUTSIDE_SIG: an effect-row tail is scoped by a `sig`"
                        .to_owned(),
                );
            }
            if kind == DeclarationKind::Sig
                && let Some(unconstrained) = row_tails.iter().find(|tail| tail.count < 2)
            {
                return Err(format!(
                    "BLOT_EFFECT_ROW_TAIL_UNCONSTRAINED: effect-row tail `..{}` must occur at least twice in one `sig`",
                    unconstrained.name
                ));
            }
            let mut value = lower_value(cst, value_cursor, context, arena)
                .map_err(|error| format!("while lowering its value: {error}"))?;
            if let Some(recursive) = cst.field(rule, "recursive")? {
                let value_span = arena.expression_span(value);
                value = arena.expression(Expression::Rec {
                    lambda: value,
                    span: Span {
                        start: cst.span(recursive)?.start,
                        end: value_span.end,
                    },
                });
            }
            if kind == DeclarationKind::Sig && !row_tails.is_empty() {
                value = quantify_effect_row_tails(value, &row_tails, span, arena);
            }
            if !tags.is_empty() {
                value = lower_tagged_value(kind, pattern, value, &tags, span, arena);
            }
            Ok(arena.declaration(Declaration::Binding {
                kind,
                tags,
                pattern,
                value,
                span,
            }))
        }
        "opening" => {
            let value = lower_value(cst, required(cst, rule, "value")?, context, arena)?;
            Ok(arena.declaration(Declaration::Open { value, span }))
        }
        "rebinding" => {
            let name = token_text(cst, required(cst, rule, "name")?)?;
            let value = lower_value(cst, required(cst, rule, "value")?, context, arena)?;
            if token_text(cst, required(cst, rule, "arrow")?)? == ":=" {
                return Ok(arena.declaration(Declaration::Shadow { name, value, span }));
            }
            let pattern = arena.pattern(Pattern::Name {
                name,
                qualifier: Qualifier::None,
                span,
            });
            Ok(arena.declaration(Declaration::Binding {
                kind: DeclarationKind::Effect,
                tags: Vec::new(),
                pattern,
                value,
                span,
            }))
        }
        "sequencing" => {
            let value = lower_value(cst, required(cst, rule, "value")?, context, arena)?;
            let pattern = arena.pattern(Pattern::Name {
                name: "_".to_owned(),
                qualifier: Qualifier::None,
                span,
            });
            Ok(arena.declaration(Declaration::Binding {
                kind: DeclarationKind::Effect,
                tags: Vec::new(),
                pattern,
                value,
                span,
            }))
        }
        "iteration" => lower_iteration(cst, rule, context, arena),
        "breaking" => {
            if context.escape_boundary == EscapeBoundary::ValueCondition {
                return Err(
                    "BLOT_BREAK_IN_VALUE_CONDITION: `break` cannot escape a value-producing `if` or `case`."
                        .to_owned(),
                );
            }
            if context.loop_control.is_none() {
                return Err("BLOT_BREAK_OUTSIDE_LOOP: `break` has no enclosing `for`.".to_owned());
            }
            Err("control break reached declaration lowering".to_owned())
        }
        "result" => Err(
            "BLOT_RETURN_OUTSIDE_SCOPE: `return` has no enclosing module or explicit block."
                .to_owned(),
        ),
        "conditional_statement" => {
            let body = as_rule(required(cst, rule, "body")?)?;
            if cst.rule_name(body)? == "conditional_statement_guard" {
                return Err("conditional guard control lowering is not implemented yet".to_owned());
            }
            let nested = nested_statement_lists(cst, rule)?;
            let flattened = nested.iter().flatten().copied().collect::<Vec<_>>();
            let rebound = rebound_names(cst, &flattened)?;
            let mut branches = Vec::new();
            branches.push(Branch {
                condition: lower_expression(
                    cst,
                    as_rule(required(cst, body, "condition")?)?,
                    context,
                    arena,
                )?,
                consequence: lower_statement_block(
                    cst,
                    statement_suite(cst, body, "consequence")?,
                    &rebound,
                    span,
                    context,
                    arena,
                )?,
            });
            for alternative in cst.field_list(body, "alternatives")? {
                let alternative = as_rule(alternative)?;
                let alternative_span = cst.span(Cursor::Rule(alternative))?;
                branches.push(Branch {
                    condition: lower_expression(
                        cst,
                        as_rule(required(cst, alternative, "condition")?)?,
                        context,
                        arena,
                    )?,
                    consequence: lower_statement_block(
                        cst,
                        statement_suite(cst, alternative, "consequence")?,
                        &rebound,
                        alternative_span,
                        context,
                        arena,
                    )?,
                });
            }
            let fallback = match cst.field(body, "fallback")? {
                Some(fallback) => {
                    let fallback = as_rule(fallback)?;
                    lower_statement_block(
                        cst,
                        statement_suite(cst, fallback, "alternative")?,
                        &rebound,
                        cst.span(Cursor::Rule(fallback))?,
                        context,
                        arena,
                    )?
                }
                None => loop_state(&rebound, span, arena),
            };
            let value = arena.expression(Expression::If {
                branches,
                fallback: Some(fallback),
                span,
            });
            let pattern = loop_pattern(&rebound, span, arena);
            Ok(arena.declaration(Declaration::Binding {
                kind: if statements_contain_effect(cst, &flattened)? {
                    DeclarationKind::Effect
                } else {
                    DeclarationKind::Let
                },
                tags: Vec::new(),
                pattern,
                value,
                span,
            }))
        }
        name => Err(format!(
            "Rust middle has not lowered declaration `{name}` yet"
        )),
    }
}

fn lower_tagged_value(
    kind: DeclarationKind,
    pattern: PatternId,
    value: ExpressionId,
    tags: &[DeclarationTag],
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    let mut declarations = Vec::new();
    for (index, tag) in tags.iter().enumerate() {
        let tag_pattern = arena.pattern(Pattern::Name {
            name: format!("tag${index}"),
            qualifier: Qualifier::None,
            span: tag.span,
        });
        declarations.push(arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Const,
            tags: Vec::new(),
            pattern: tag_pattern,
            value: tag.descriptor,
            span: tag.span,
        }));
    }
    let recursive = matches!(arena.expressions[value.0 as usize], Expression::Rec { .. });
    let raw_name = match (&arena.patterns[pattern.0 as usize], recursive) {
        (Pattern::Name { name, .. }, true) => name.clone(),
        _ => "tag$value$".to_owned(),
    };
    let raw_pattern = arena.pattern(Pattern::Name {
        name: raw_name.clone(),
        qualifier: Qualifier::None,
        span: arena.expression_span(value),
    });
    declarations.push(arena.declaration(Declaration::Binding {
        kind,
        tags: Vec::new(),
        pattern: raw_pattern,
        value,
        span: arena.expression_span(value),
    }));
    let mut transformed = variable(&raw_name, arena.expression_span(value), arena);
    for (index, tag) in tags.iter().enumerate().rev() {
        let descriptor = variable(&format!("tag${index}"), tag.span, arena);
        let transformer = field_expression(descriptor, "transform", tag.span, arena);
        let applied_span = Span {
            start: tag.span.start,
            end: arena.expression_span(transformed).end,
        };
        transformed = arena.expression(Expression::Apply {
            function: transformer,
            argument: transformed,
            span: applied_span,
        });
    }
    arena.expression(Expression::Block {
        declarations,
        result: transformed,
        result_effects: ResultEffects::Ambient,
        span,
    })
}

#[derive(Clone)]
struct ControlConstructors {
    return_constructor: String,
    continue_constructor: String,
}

fn synthetic_constructor(label: &str, span: Span) -> String {
    format!("{label}${}${}", span.start, span.end)
}

fn control_payload(value: ExpressionId, span: Span, arena: &mut AstArena) -> ExpressionId {
    arena.expression(Expression::Shape {
        members: vec![ShapeMember::Field {
            name: "value".to_owned(),
            value,
        }],
        span,
    })
}

fn control_state_pattern(carried: &[String], span: Span, arena: &mut AstArena) -> PatternId {
    let pattern = loop_pattern(carried, span, arena);
    arena.pattern(Pattern::Shape {
        fields: vec![ShapePatternField {
            name: "value".to_owned(),
            pattern,
        }],
        span,
    })
}

fn control_payload_pattern(name: Option<&str>, span: Span, arena: &mut AstArena) -> PatternId {
    let pattern = match name {
        Some(name) => arena.pattern(Pattern::Name {
            name: name.to_owned(),
            qualifier: Qualifier::None,
            span,
        }),
        None => arena.pattern(Pattern::Wildcard { span }),
    };
    arena.pattern(Pattern::Shape {
        fields: vec![ShapePatternField {
            name: "value".to_owned(),
            pattern,
        }],
        span,
    })
}

fn control_outcome(
    constructor: &str,
    value: ExpressionId,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    let function = arena.expression(Expression::Tag {
        name: constructor.to_owned(),
        span,
    });
    let argument = control_payload(value, span, arena);
    arena.expression(Expression::Apply {
        function,
        argument,
        span,
    })
}

fn resolve_control_sequence(
    cst: &CompactCst<'_>,
    cursors: &[Cursor],
    normal_result: ExpressionId,
    context: &LoweringContext<'_>,
    span: Span,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let constructors = ControlConstructors {
        return_constructor: synthetic_constructor("ScopeReturn", span),
        continue_constructor: synthetic_constructor("ScopeContinue", span),
    };
    let outcome = lower_control_outcome(
        cst,
        cursors,
        context,
        span,
        normal_result,
        &constructors,
        arena,
    )?;
    let mut arms = Vec::new();
    if statements_contain_return(cst, cursors)? {
        let payload = control_payload_pattern(Some("returned$"), span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: constructors.return_constructor.clone(),
            payload: Some(payload),
            span,
        });
        let body = variable("returned$", span, arena);
        arms.push(Arm { pattern, body });
    }
    if statements_can_continue(cst, cursors)? {
        let payload = control_payload_pattern(Some("continued$"), span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: constructors.continue_constructor,
            payload: Some(payload),
            span,
        });
        let body = variable("continued$", span, arena);
        arms.push(Arm { pattern, body });
    }
    Ok(arena.expression(Expression::Case {
        target: outcome,
        arms,
        span,
    }))
}

fn lower_control_outcome(
    cst: &CompactCst<'_>,
    cursors: &[Cursor],
    context: &LoweringContext<'_>,
    span: Span,
    continue_value: ExpressionId,
    constructors: &ControlConstructors,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let Some(first) = cursors.first().copied() else {
        return Ok(control_outcome(
            &constructors.continue_constructor,
            continue_value,
            span,
            arena,
        ));
    };
    let rule = statement_rule(cst, first)?;
    let rule_span = cst.span(Cursor::Rule(rule))?;
    if cst.rule_name(rule)? == "result" {
        if !context.return_scope {
            return Err(
                "BLOT_RETURN_OUTSIDE_SCOPE: `return` has no enclosing module or explicit block."
                    .to_owned(),
            );
        }
        let value = lower_value(cst, required(cst, rule, "value")?, context, arena)?;
        return Ok(control_outcome(
            &constructors.return_constructor,
            value,
            rule_span,
            arena,
        ));
    }
    if cst.rule_name(rule)? == "breaking" {
        if let Some(loop_control) = &context.loop_control {
            let state = loop_state(&loop_control.carried, rule_span, arena);
            return Ok(control_outcome(
                &loop_control.break_constructor,
                state,
                rule_span,
                arena,
            ));
        }
        if context.escape_boundary == EscapeBoundary::ValueCondition {
            return Err(
                "BLOT_BREAK_IN_VALUE_CONDITION: `break` cannot escape a value-producing `if` or `case`."
                    .to_owned(),
            );
        }
        return Err("BLOT_BREAK_OUTSIDE_LOOP: `break` has no enclosing `for`.".to_owned());
    }

    let remaining = &cursors[1..];
    if cst.rule_name(rule)? == "conditional_statement" {
        return lower_control_statement(
            cst,
            rule,
            remaining,
            context,
            span,
            continue_value,
            constructors,
            arena,
        );
    }
    if cst.rule_name(rule)? == "iteration" {
        let loop_result = lower_control_loop(cst, rule, context, arena)?;
        let mut arms = Vec::new();
        if loop_result.returns {
            let payload = control_payload_pattern(Some("returned$"), rule_span, arena);
            let pattern = arena.pattern(Pattern::Constructor {
                name: loop_result.constructors.return_constructor,
                payload: Some(payload),
                span: rule_span,
            });
            let returned = variable("returned$", rule_span, arena);
            let body =
                control_outcome(&constructors.return_constructor, returned, rule_span, arena);
            arms.push(Arm { pattern, body });
        }
        let payload = control_payload_pattern(Some("loopState$"), rule_span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: loop_result.constructors.continue_constructor,
            payload: Some(payload),
            span: rule_span,
        });
        let loop_state_value = variable("loopState$", rule_span, arena);
        let binding = arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Let,
            tags: Vec::new(),
            pattern: loop_result.pattern,
            value: loop_state_value,
            span: rule_span,
        });
        let result = lower_control_outcome(
            cst,
            remaining,
            context,
            span,
            continue_value,
            constructors,
            arena,
        )?;
        let body = arena.expression(Expression::Block {
            declarations: vec![binding],
            result,
            result_effects: ResultEffects::Ambient,
            span: rule_span,
        });
        arms.push(Arm { pattern, body });
        return Ok(arena.expression(Expression::Case {
            target: loop_result.value,
            arms,
            span: rule_span,
        }));
    }

    let mut declarations = vec![lower_declaration(cst, rule, context, arena)?];
    let mut next_control = remaining;
    while let Some(next) = next_control.first().copied() {
        let next_rule = statement_rule(cst, next)?;
        match cst.rule_name(next_rule)? {
            "result" | "breaking" | "conditional_statement" | "iteration" => break,
            _ => {
                declarations.push(lower_declaration(cst, next_rule, context, arena)?);
                next_control = &next_control[1..];
            }
        }
    }
    let result = lower_control_outcome(
        cst,
        next_control,
        context,
        span,
        continue_value,
        constructors,
        arena,
    )?;
    Ok(arena.expression(Expression::Block {
        declarations,
        result,
        result_effects: ResultEffects::Ambient,
        span: Span {
            start: rule_span.start,
            end: span.end,
        },
    }))
}

#[allow(clippy::too_many_arguments)]
fn lower_control_statement(
    cst: &CompactCst<'_>,
    rule: u32,
    remaining: &[Cursor],
    context: &LoweringContext<'_>,
    span: Span,
    continue_value: ExpressionId,
    constructors: &ControlConstructors,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let rule_span = cst.span(Cursor::Rule(rule))?;
    let body = as_rule(required(cst, rule, "body")?)?;
    let body_span = cst.span(Cursor::Rule(body))?;
    if cst.rule_name(body)? == "conditional_statement_guard" {
        let alternative = statement_suite(cst, body, "alternative")?;
        if statements_can_continue(cst, &alternative)? {
            return Err(
                "BLOT_GUARD_MAY_CONTINUE: the `else` branch of `if let` must `return` or `break`."
                    .to_owned(),
            );
        }
        let target = lower_value(cst, required(cst, body, "value")?, context, arena)?;
        let matched_pattern = lower_pattern(cst, required(cst, body, "pattern")?, arena)?;
        let matched_body = lower_control_outcome(
            cst,
            remaining,
            context,
            span,
            continue_value,
            constructors,
            arena,
        )?;
        let wildcard = arena.pattern(Pattern::Wildcard { span: body_span });
        let unit = arena.expression(Expression::Unit { span: body_span });
        let unmatched_body = lower_control_outcome(
            cst,
            &alternative,
            context,
            body_span,
            unit,
            constructors,
            arena,
        )?;
        return Ok(arena.expression(Expression::Case {
            target,
            arms: vec![
                Arm {
                    pattern: matched_pattern,
                    body: matched_body,
                },
                Arm {
                    pattern: wildcard,
                    body: unmatched_body,
                },
            ],
            span: rule_span,
        }));
    }

    let nested = nested_statement_lists(cst, rule)?;
    let flattened = nested.iter().flatten().copied().collect::<Vec<_>>();
    let rebound = rebound_names(cst, &flattened)?;
    let branch_continue = if remaining.is_empty() {
        continue_value
    } else {
        loop_state(&rebound, rule_span, arena)
    };
    let mut branch_constructors = constructors.clone();
    let mut branch_context = context.clone();
    if !remaining.is_empty() {
        branch_constructors = ControlConstructors {
            return_constructor: synthetic_constructor("ConditionalReturn", rule_span),
            continue_constructor: synthetic_constructor("ConditionalContinue", rule_span),
        };
        if let Some(loop_control) = &mut branch_context.loop_control {
            loop_control.break_constructor = synthetic_constructor("ConditionalBreak", rule_span);
        }
    }
    let conditional = lower_control_conditional(
        cst,
        body,
        &branch_context,
        branch_continue,
        &branch_constructors,
        arena,
    )?;
    if remaining.is_empty() {
        return Ok(conditional);
    }

    let mut arms = Vec::new();
    if statements_contain_return(cst, &[Cursor::Rule(rule)])? {
        let payload = control_payload_pattern(Some("returned$"), rule_span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: branch_constructors.return_constructor.clone(),
            payload: Some(payload),
            span: rule_span,
        });
        let returned = variable("returned$", rule_span, arena);
        let body = control_outcome(&constructors.return_constructor, returned, rule_span, arena);
        arms.push(Arm { pattern, body });
    }
    if statements_can_continue(cst, &[Cursor::Rule(rule)])? {
        let payload = control_state_pattern(&rebound, rule_span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: branch_constructors.continue_constructor,
            payload: Some(payload),
            span: rule_span,
        });
        let body = lower_control_outcome(
            cst,
            remaining,
            context,
            span,
            continue_value,
            constructors,
            arena,
        )?;
        arms.push(Arm { pattern, body });
    }
    if statements_contain_loop_break(cst, &[Cursor::Rule(rule)])? {
        let Some(outer_loop) = &context.loop_control else {
            return Err("BLOT_BREAK_OUTSIDE_LOOP: `break` has no enclosing `for`.".to_owned());
        };
        let branch_loop = branch_context
            .loop_control
            .as_ref()
            .ok_or_else(|| "conditional break lost its loop context".to_owned())?;
        let payload = control_payload_pattern(Some("stopped$"), rule_span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: branch_loop.break_constructor.clone(),
            payload: Some(payload),
            span: rule_span,
        });
        let stopped = variable("stopped$", rule_span, arena);
        let body = control_outcome(&outer_loop.break_constructor, stopped, rule_span, arena);
        arms.push(Arm { pattern, body });
    }
    Ok(arena.expression(Expression::Case {
        target: conditional,
        arms,
        span: rule_span,
    }))
}

fn lower_control_conditional(
    cst: &CompactCst<'_>,
    body: u32,
    context: &LoweringContext<'_>,
    continue_value: ExpressionId,
    constructors: &ControlConstructors,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let body_span = cst.span(Cursor::Rule(body))?;
    let condition = lower_expression(
        cst,
        as_rule(required(cst, body, "condition")?)?,
        context,
        arena,
    )?;
    let consequence = lower_control_outcome(
        cst,
        &statement_suite(cst, body, "consequence")?,
        context,
        body_span,
        continue_value,
        constructors,
        arena,
    )?;
    let mut branches = vec![Branch {
        condition,
        consequence,
    }];
    for alternative in cst.field_list(body, "alternatives")? {
        let alternative = as_rule(alternative)?;
        let alternative_span = cst.span(Cursor::Rule(alternative))?;
        let condition = lower_expression(
            cst,
            as_rule(required(cst, alternative, "condition")?)?,
            context,
            arena,
        )?;
        let consequence = lower_control_outcome(
            cst,
            &statement_suite(cst, alternative, "consequence")?,
            context,
            alternative_span,
            continue_value,
            constructors,
            arena,
        )?;
        branches.push(Branch {
            condition,
            consequence,
        });
    }
    let mut fallback = control_outcome(
        &constructors.continue_constructor,
        continue_value,
        body_span,
        arena,
    );
    if let Some(alternative) = cst.field(body, "fallback")? {
        let alternative = as_rule(alternative)?;
        fallback = lower_control_outcome(
            cst,
            &statement_suite(cst, alternative, "alternative")?,
            context,
            cst.span(Cursor::Rule(alternative))?,
            continue_value,
            constructors,
            arena,
        )?;
    }
    Ok(arena.expression(Expression::If {
        branches,
        fallback: Some(fallback),
        span: body_span,
    }))
}

fn lower_statement_block(
    cst: &CompactCst<'_>,
    statements: Vec<Cursor>,
    rebound: &[String],
    span: Span,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let mut declarations = Vec::new();
    for statement in statements {
        declarations.push(lower_declaration(
            cst,
            unwrapped_rule(cst, statement)?,
            context,
            arena,
        )?);
    }
    let result = loop_state(rebound, span, arena);
    Ok(arena.expression(Expression::Block {
        declarations,
        result,
        result_effects: ResultEffects::Ambient,
        span,
    }))
}

struct LoweredControlLoop {
    pattern: PatternId,
    value: ExpressionId,
    constructors: ControlConstructors,
    returns: bool,
}

fn lower_control_loop(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<LoweredControlLoop, String> {
    let span = cst.span(Cursor::Rule(rule))?;
    let statements = statement_suite(cst, rule, "body")?;
    let carried = rebound_names(cst, &statements)?;
    let constructors = ControlConstructors {
        return_constructor: synthetic_constructor("LoopReturn", span),
        continue_constructor: synthetic_constructor("LoopContinue", span),
    };
    let body_constructors = ControlConstructors {
        return_constructor: synthetic_constructor("LoopBodyReturn", span),
        continue_constructor: synthetic_constructor("LoopBodyContinue", span),
    };
    let break_constructor = synthetic_constructor("LoopBreak", span);
    let returns = statements_contain_return(cst, &statements)?;
    let continues = statements_can_continue(cst, &statements)?;
    let breaks = statements_contain_loop_break(cst, &statements)?;
    let mut body_context = context.clone();
    body_context.loop_control = Some(LoopControl {
        carried: carried.clone(),
        break_constructor: break_constructor.clone(),
    });
    let continue_value = loop_state(&carried, span, arena);
    let outcome = lower_control_outcome(
        cst,
        &statements,
        &body_context,
        span,
        continue_value,
        &body_constructors,
        arena,
    )?;

    let drawn = cst.field(rule, "drawn")?;
    let mut head_context = context.clone();
    head_context.pattern_head = drawn.is_some();
    let head = lower_value(cst, required(cst, rule, "head")?, &head_context, arena)?;
    let (binder, source) = match drawn {
        None => (None, head),
        Some(drawn) => {
            let binder = pattern_from_expression(head, arena)?;
            let drawn = as_rule(drawn)?;
            let source = lower_value(cst, required(cst, drawn, "source")?, context, arena)?;
            (Some(binder), source)
        }
    };
    let (pattern, value) = desugar_loop(
        binder,
        source,
        LoopBody::Control(ControlLoopBody {
            outcome,
            carried,
            constructors: body_constructors,
            result_constructors: constructors.clone(),
            break_constructor,
            returns,
            continues,
            breaks,
        }),
        statements_contain_effect(cst, &statements)?,
        LoopCompletion::Control,
        span,
        arena,
    )?;
    Ok(LoweredControlLoop {
        pattern,
        value,
        constructors,
        returns,
    })
}

fn lower_iteration(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<DeclarationId, String> {
    let span = cst.span(Cursor::Rule(rule))?;
    let statements = statement_suite(cst, rule, "body")?;
    if statements_need_control(cst, &statements)? {
        let loop_result = lower_control_loop(cst, rule, context, arena)?;
        if loop_result.returns {
            return Err("a local control loop contains a return".to_owned());
        }
        let state_name = "loopState$";
        let payload = control_payload_pattern(Some(state_name), span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: loop_result.constructors.continue_constructor,
            payload: Some(payload),
            span,
        });
        let body = variable(state_name, span, arena);
        let value = arena.expression(Expression::Case {
            target: loop_result.value,
            arms: vec![Arm { pattern, body }],
            span,
        });
        return Ok(arena.declaration(Declaration::Binding {
            kind: if statements_contain_effect(cst, &statements)? {
                DeclarationKind::Effect
            } else {
                DeclarationKind::Let
            },
            tags: Vec::new(),
            pattern: loop_result.pattern,
            value,
            span,
        }));
    }
    let carried = rebound_names(cst, &statements)?;
    let effectful = statements_contain_effect(cst, &statements)?;
    let drawn = cst.field(rule, "drawn")?;
    let mut head_context = context.clone();
    head_context.pattern_head = drawn.is_some();
    let head = lower_value(cst, required(cst, rule, "head")?, &head_context, arena)?;
    let (binder, source) = match drawn {
        None => (None, head),
        Some(drawn) => {
            let binder = pattern_from_expression(head, arena)?;
            let drawn = as_rule(drawn)?;
            let source = lower_value(cst, required(cst, drawn, "source")?, context, arena)?;
            (Some(binder), source)
        }
    };
    let mut body = Vec::new();
    for statement in statements {
        let statement = unwrapped_rule(cst, statement)?;
        body.push(lower_declaration(cst, statement, &context.body(), arena)?);
    }
    let (pattern, value) = desugar_loop(
        binder,
        source,
        LoopBody::Plain {
            declarations: body,
            carried,
        },
        effectful,
        LoopCompletion::Iterate,
        span,
        arena,
    )?;
    Ok(arena.declaration(Declaration::Binding {
        kind: if effectful {
            DeclarationKind::Effect
        } else {
            DeclarationKind::Let
        },
        tags: Vec::new(),
        pattern,
        value,
        span,
    }))
}

struct ControlLoopBody {
    outcome: ExpressionId,
    carried: Vec<String>,
    constructors: ControlConstructors,
    result_constructors: ControlConstructors,
    break_constructor: String,
    returns: bool,
    continues: bool,
    breaks: bool,
}

enum LoopBody {
    Plain {
        declarations: Vec<DeclarationId>,
        carried: Vec<String>,
    },
    Control(ControlLoopBody),
}

enum LoopCompletion {
    Iterate,
    Control,
}

fn desugar_loop(
    binder: Option<PatternId>,
    source: ExpressionId,
    body: LoopBody,
    effectful: bool,
    completion: LoopCompletion,
    span: Span,
    arena: &mut AstArena,
) -> Result<(PatternId, ExpressionId), String> {
    let carried = match &body {
        LoopBody::Plain { carried, .. } => carried,
        LoopBody::Control(body) => &body.carried,
    };
    let state_pattern = loop_pattern(carried, span, arena);
    let state = loop_state(carried, span, arena);
    let carried_in = "loop$";
    let pair_in = "pair$";
    let iter_in = "iter$";
    let state_in = "state$";
    let go_in = "go$";

    let pair = variable(pair_in, span, arena);
    let element = field_expression(pair, "0", span, arena);
    let mut declarations = Vec::new();
    if !carried.is_empty() {
        let carried_value = variable(carried_in, span, arena);
        declarations.push(arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Let,
            tags: Vec::new(),
            pattern: state_pattern,
            value: carried_value,
            span,
        }));
    }
    let filtering = match binder {
        Some(pattern) => refutable(pattern, arena),
        None => false,
    };
    if let Some(pattern) = binder
        && !filtering
    {
        declarations.push(arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Let,
            tags: Vec::new(),
            pattern,
            value: element,
            span,
        }));
    }
    if let LoopBody::Plain {
        declarations: body_declarations,
        ..
    } = &body
    {
        declarations.extend(body_declarations.iter().copied());
    }
    let step_result = match &body {
        LoopBody::Plain { .. } => state,
        LoopBody::Control(body) => body.outcome,
    };
    let step = arena.expression(Expression::Block {
        declarations,
        result: step_result,
        result_effects: ResultEffects::Ambient,
        span,
    });
    let visited = if filtering {
        let pattern = binder.expect("filtering loop omitted its binder");
        let wildcard = arena.pattern(Pattern::Wildcard { span });
        let carried_value = variable(carried_in, span, arena);
        let skipped = match &body {
            LoopBody::Plain { .. } => carried_value,
            LoopBody::Control(body) => control_outcome(
                &body.constructors.continue_constructor,
                carried_value,
                span,
                arena,
            ),
        };
        arena.expression(Expression::Case {
            target: element,
            arms: vec![
                Arm {
                    pattern,
                    body: step,
                },
                Arm {
                    pattern: wildcard,
                    body: skipped,
                },
            ],
            span,
        })
    } else {
        step
    };

    let next_iterator = {
        let pair = variable(pair_in, span, arena);
        field_expression(pair, "1", span, arena)
    };
    let completed_visit = match &body {
        LoopBody::Plain { .. } => continue_loop(next_iterator, visited, span, arena),
        LoopBody::Control(body) => {
            resolve_loop_visit(visited, next_iterator, body, &completion, span, arena)
        }
    };

    let iterator = variable(iter_in, span, arena);
    let step_function = field_expression(iterator, "step", span, arena);
    let iterator_state = variable(state_in, span, arena);
    let stepped = arena.expression(Expression::Apply {
        function: step_function,
        argument: iterator_state,
        span,
    });
    let none = arena.pattern(Pattern::Constructor {
        name: "None".to_owned(),
        payload: None,
        span,
    });
    let pair_pattern = arena.pattern(Pattern::Name {
        name: pair_in.to_owned(),
        qualifier: Qualifier::None,
        span,
    });
    let some = arena.pattern(Pattern::Constructor {
        name: "Some".to_owned(),
        payload: Some(pair_pattern),
        span,
    });
    let carried_value = variable(carried_in, span, arena);
    let exhausted = match &body {
        LoopBody::Plain { .. } => carried_value,
        LoopBody::Control(body) => control_outcome(
            &body.result_constructors.continue_constructor,
            carried_value,
            span,
            arena,
        ),
    };
    let go_result = arena.expression(Expression::Case {
        target: stepped,
        arms: vec![
            Arm {
                pattern: none,
                body: exhausted,
            },
            Arm {
                pattern: some,
                body: completed_visit,
            },
        ],
        span,
    });
    let go_body = if effectful {
        let result_pattern = arena.pattern(Pattern::Name {
            name: "loopResult$".to_owned(),
            qualifier: Qualifier::None,
            span,
        });
        let result_binding = arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Effect,
            tags: Vec::new(),
            pattern: result_pattern,
            value: go_result,
            span,
        });
        let result = variable("loopResult$", span, arena);
        arena.expression(Expression::Block {
            declarations: vec![result_binding],
            result,
            result_effects: ResultEffects::Ambient,
            span,
        })
    } else {
        go_result
    };
    let state_parameter = arena.pattern(Pattern::Name {
        name: state_in.to_owned(),
        qualifier: Qualifier::None,
        span,
    });
    let carried_parameter = arena.pattern(Pattern::Name {
        name: carried_in.to_owned(),
        qualifier: Qualifier::None,
        span,
    });
    let go_parameter = arena.pattern(Pattern::Tuple {
        elements: vec![state_parameter, carried_parameter],
        span,
    });
    let lambda = arena.expression(Expression::Lambda {
        parameter: go_parameter,
        body: go_body,
        reuse: false,
        deferred: false,
        span,
    });
    let recursive_go = arena.expression(Expression::Rec { lambda, span });
    let iterator_pattern = arena.pattern(Pattern::Name {
        name: iter_in.to_owned(),
        qualifier: Qualifier::None,
        span,
    });
    let iterator_binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Let,
        tags: Vec::new(),
        pattern: iterator_pattern,
        value: source,
        span,
    });
    let go_pattern = arena.pattern(Pattern::Name {
        name: go_in.to_owned(),
        qualifier: Qualifier::None,
        span,
    });
    let go_binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Let,
        tags: Vec::new(),
        pattern: go_pattern,
        value: recursive_go,
        span,
    });
    let initial_iterator = {
        let iterator = variable(iter_in, span, arena);
        field_expression(iterator, "state", span, arena)
    };
    let initial_arguments = arena.expression(Expression::Tuple {
        elements: vec![initial_iterator, state],
        span,
    });
    let initial_go = variable(go_in, span, arena);
    let result = arena.expression(Expression::Apply {
        function: initial_go,
        argument: initial_arguments,
        span,
    });
    let value = arena.expression(Expression::Block {
        declarations: vec![iterator_binding, go_binding],
        result,
        result_effects: ResultEffects::Ambient,
        span,
    });
    Ok((state_pattern, value))
}

fn continue_loop(
    next_iterator: ExpressionId,
    next_state: ExpressionId,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    let function = variable("go$", span, arena);
    let argument = arena.expression(Expression::Tuple {
        elements: vec![next_iterator, next_state],
        span,
    });
    arena.expression(Expression::Apply {
        function,
        argument,
        span,
    })
}

fn resolve_loop_visit(
    outcome: ExpressionId,
    next_iterator: ExpressionId,
    body: &ControlLoopBody,
    completion: &LoopCompletion,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    let mut arms = Vec::new();
    if body.returns {
        let payload = control_payload_pattern(Some("returned$"), span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: body.constructors.return_constructor.clone(),
            payload: Some(payload),
            span,
        });
        let returned = variable("returned$", span, arena);
        let resolved = control_outcome(
            &body.result_constructors.return_constructor,
            returned,
            span,
            arena,
        );
        arms.push(Arm {
            pattern,
            body: resolved,
        });
    }
    if body.continues {
        let payload = control_payload_pattern(Some("continued$"), span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: body.constructors.continue_constructor.clone(),
            payload: Some(payload),
            span,
        });
        let continued = variable("continued$", span, arena);
        let resolved = continue_loop(next_iterator, continued, span, arena);
        arms.push(Arm {
            pattern,
            body: resolved,
        });
    }
    if matches!(completion, LoopCompletion::Control) && body.breaks {
        let payload = control_payload_pattern(Some("stopped$"), span, arena);
        let pattern = arena.pattern(Pattern::Constructor {
            name: body.break_constructor.clone(),
            payload: Some(payload),
            span,
        });
        let stopped = variable("stopped$", span, arena);
        let resolved = control_outcome(
            &body.result_constructors.continue_constructor,
            stopped,
            span,
            arena,
        );
        arms.push(Arm {
            pattern,
            body: resolved,
        });
    }
    arena.expression(Expression::Case {
        target: outcome,
        arms,
        span,
    })
}

fn loop_pattern(carried: &[String], span: Span, arena: &mut AstArena) -> PatternId {
    if carried.is_empty() {
        return arena.pattern(Pattern::Wildcard { span });
    }
    let fields = carried
        .iter()
        .map(|name| ShapePatternField {
            name: name.clone(),
            pattern: arena.pattern(Pattern::Name {
                name: name.clone(),
                qualifier: Qualifier::None,
                span,
            }),
        })
        .collect();
    arena.pattern(Pattern::Shape { fields, span })
}

fn loop_state(carried: &[String], span: Span, arena: &mut AstArena) -> ExpressionId {
    if carried.is_empty() {
        return arena.expression(Expression::Unit { span });
    }
    let members = carried
        .iter()
        .map(|name| ShapeMember::Field {
            name: name.clone(),
            value: variable(name, span, arena),
        })
        .collect();
    arena.expression(Expression::Shape { members, span })
}

fn variable(name: &str, span: Span, arena: &mut AstArena) -> ExpressionId {
    arena.expression(Expression::Var {
        name: name.to_owned(),
        span,
    })
}

fn field_expression(
    target: ExpressionId,
    name: &str,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    arena.expression(Expression::Field {
        target,
        name: name.to_owned(),
        span,
    })
}

fn refutable(pattern: PatternId, arena: &AstArena) -> bool {
    match &arena.patterns[pattern.0 as usize] {
        Pattern::Name { .. } | Pattern::Wildcard { .. } => false,
        Pattern::Tuple { elements, .. } => {
            elements.iter().any(|pattern| refutable(*pattern, arena))
        }
        Pattern::Shape { fields, .. } => fields.iter().any(|field| refutable(field.pattern, arena)),
        _ => true,
    }
}

fn pattern_from_expression(
    expression: ExpressionId,
    arena: &mut AstArena,
) -> Result<PatternId, String> {
    let node = arena.expressions[expression.0 as usize].clone();
    match node {
        Expression::Var { name, span } if name == "_" => {
            Ok(arena.pattern(Pattern::Wildcard { span }))
        }
        Expression::Var { name, span } => Ok(arena.pattern(Pattern::Name {
            name,
            qualifier: Qualifier::None,
            span,
        })),
        Expression::Unit { span } => Ok(arena.pattern(Pattern::Unit { span })),
        Expression::Int { value, span } => Ok(arena.pattern(Pattern::Int { value, span })),
        Expression::Float { value, span } => Ok(arena.pattern(Pattern::Float { value, span })),
        Expression::Text { value, span } => Ok(arena.pattern(Pattern::Text { value, span })),
        Expression::Tuple { elements, span } => {
            let elements = elements
                .into_iter()
                .map(|element| pattern_from_expression(element, arena))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(arena.pattern(Pattern::Tuple { elements, span }))
        }
        Expression::Array { elements, span } => {
            if elements.iter().any(|element| element.spread) {
                return Err("BLOT_BAD_BINDER: a binder cannot spread".to_owned());
            }
            let elements = elements
                .into_iter()
                .map(|element| pattern_from_expression(element.value, arena))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(arena.pattern(Pattern::Array { elements, span }))
        }
        Expression::Shape { members, span } => {
            let mut fields = Vec::new();
            for member in members {
                let ShapeMember::Field { name, value } = member else {
                    return Err("BLOT_BAD_BINDER: a binder cannot spread".to_owned());
                };
                fields.push(ShapePatternField {
                    name,
                    pattern: pattern_from_expression(value, arena)?,
                });
            }
            Ok(arena.pattern(Pattern::Shape { fields, span }))
        }
        Expression::Tag { name, span } => Ok(arena.pattern(Pattern::Constructor {
            name,
            payload: None,
            span,
        })),
        Expression::Apply {
            function,
            argument,
            span,
        } => {
            let function_node = arena.expressions[function.0 as usize].clone();
            if let Expression::Intrinsic { name, .. } = &function_node
                && name == "@pattern.pin"
            {
                let Expression::Var { name, .. } = arena.expressions[argument.0 as usize].clone()
                else {
                    return Err(
                        "BLOT_BAD_PIN: a pinned pattern is `^name`, naming one existing binding"
                            .to_owned(),
                    );
                };
                if name == "_" {
                    return Err(
                        "BLOT_BAD_PIN: a pinned pattern is `^name`, naming one existing binding"
                            .to_owned(),
                    );
                }
                return Ok(arena.pattern(Pattern::Pin { name, span }));
            }
            if let Expression::Tag { name, .. } = function_node {
                let payload = pattern_from_expression(argument, arena)?;
                return Ok(arena.pattern(Pattern::Constructor {
                    name,
                    payload: Some(payload),
                    span,
                }));
            }
            if let Expression::Intrinsic { name, .. } = function_node {
                let qualifier = match name.as_str() {
                    "@linear.own" => Some(Qualifier::Linear),
                    "@linear.maybe" => Some(Qualifier::Affine),
                    "@linear.borrow" => Some(Qualifier::Borrow),
                    _ => None,
                };
                if let Some(qualifier) = qualifier {
                    let pattern = pattern_from_expression(argument, arena)?;
                    let Pattern::Name { name, .. } = arena.patterns[pattern.0 as usize].clone()
                    else {
                        return Err(
                            "BLOT_BAD_BINDER: an ownership qualifier requires a name".to_owned()
                        );
                    };
                    return Ok(arena.pattern(Pattern::Name {
                        name,
                        qualifier,
                        span,
                    }));
                }
            }
            Err("BLOT_BAD_BINDER: expression is not a valid binder".to_owned())
        }
        _ => Err("BLOT_BAD_BINDER: expression is not a valid binder".to_owned()),
    }
}

fn statement_rule(cst: &CompactCst<'_>, cursor: Cursor) -> Result<u32, String> {
    let rule = as_rule(cursor)?;
    match cst.rule_name(rule)? {
        "statement" | "declaration" => unwrapped_rule(cst, cursor),
        _ => Ok(rule),
    }
}

fn statement_suite(cst: &CompactCst<'_>, rule: u32, field: &str) -> Result<Vec<Cursor>, String> {
    let suite = as_rule(required(cst, rule, field)?)?;
    require_rule(cst, suite, "statement_suite")?;
    cst.field_list(suite, "statements")
}

fn statements_need_control(cst: &CompactCst<'_>, statements: &[Cursor]) -> Result<bool, String> {
    for statement in statements {
        let statement = statement_rule(cst, *statement)?;
        match cst.rule_name(statement)? {
            "result" | "breaking" => return Ok(true),
            "conditional_statement" => {
                let body = as_rule(required(cst, statement, "body")?)?;
                if cst.rule_name(body)? == "conditional_statement_guard" {
                    return Ok(true);
                }
                for nested in nested_statement_lists(cst, statement)? {
                    if statements_need_control(cst, &nested)? {
                        return Ok(true);
                    }
                }
            }
            "iteration" => {
                let body = statement_suite(cst, statement, "body")?;
                if statements_contain_return(cst, &body)? {
                    return Ok(true);
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

fn statements_contain_return(cst: &CompactCst<'_>, statements: &[Cursor]) -> Result<bool, String> {
    for statement in statements {
        let statement = statement_rule(cst, *statement)?;
        if cst.rule_name(statement)? == "result" {
            return Ok(true);
        }
        for nested in nested_statement_lists(cst, statement)? {
            if statements_contain_return(cst, &nested)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn statements_contain_loop_break(
    cst: &CompactCst<'_>,
    statements: &[Cursor],
) -> Result<bool, String> {
    for statement in statements {
        let statement = statement_rule(cst, *statement)?;
        if cst.rule_name(statement)? == "breaking" {
            return Ok(true);
        }
        if cst.rule_name(statement)? == "iteration" {
            continue;
        }
        for nested in nested_statement_lists(cst, statement)? {
            if statements_contain_loop_break(cst, &nested)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn statements_can_continue(cst: &CompactCst<'_>, statements: &[Cursor]) -> Result<bool, String> {
    for statement in statements {
        let statement = statement_rule(cst, *statement)?;
        let name = cst.rule_name(statement)?;
        if name == "result" || name == "breaking" {
            return Ok(false);
        }
        if name != "conditional_statement" {
            continue;
        }
        let body = as_rule(required(cst, statement, "body")?)?;
        if cst.rule_name(body)? == "conditional_statement_guard" {
            continue;
        }
        if cst.field(body, "fallback")?.is_none() {
            continue;
        }
        let nested = nested_statement_lists(cst, statement)?;
        let mut every_branch_leaves = true;
        for branch in nested {
            if statements_can_continue(cst, &branch)? {
                every_branch_leaves = false;
                break;
            }
        }
        if every_branch_leaves {
            return Ok(false);
        }
    }
    Ok(true)
}

fn statements_contain_effect(cst: &CompactCst<'_>, statements: &[Cursor]) -> Result<bool, String> {
    for statement in statements {
        let statement = statement_rule(cst, *statement)?;
        if cst.rule_name(statement)? == "sequencing"
            || (cst.rule_name(statement)? == "rebinding"
                && token_text(cst, required(cst, statement, "arrow")?)? == "<-")
        {
            return Ok(true);
        }
        for nested in nested_statement_lists(cst, statement)? {
            if statements_contain_effect(cst, &nested)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn nested_statement_lists(
    cst: &CompactCst<'_>,
    statement: u32,
) -> Result<Vec<Vec<Cursor>>, String> {
    if cst.rule_name(statement)? == "iteration" {
        return Ok(vec![statement_suite(cst, statement, "body")?]);
    }
    if cst.rule_name(statement)? != "conditional_statement" {
        return Ok(Vec::new());
    }
    let body = as_rule(required(cst, statement, "body")?)?;
    if cst.rule_name(body)? == "conditional_statement_guard" {
        return Ok(vec![statement_suite(cst, body, "alternative")?]);
    }
    let mut nested = vec![statement_suite(cst, body, "consequence")?];
    for alternative in cst.field_list(body, "alternatives")? {
        nested.push(statement_suite(cst, as_rule(alternative)?, "consequence")?);
    }
    if let Some(fallback) = cst.field(body, "fallback")? {
        nested.push(statement_suite(cst, as_rule(fallback)?, "alternative")?);
    }
    Ok(nested)
}

fn rebound_names(cst: &CompactCst<'_>, statements: &[Cursor]) -> Result<Vec<String>, String> {
    let mut rebound = Vec::new();
    collect_rebound_names(cst, statements, &[], &mut rebound)?;
    Ok(rebound)
}

fn collect_rebound_names(
    cst: &CompactCst<'_>,
    statements: &[Cursor],
    outer_shadowed: &[String],
    rebound: &mut Vec<String>,
) -> Result<(), String> {
    let mut shadowed = outer_shadowed.to_owned();
    for statement in statements {
        let statement = statement_rule(cst, *statement)?;
        if cst.rule_name(statement)? == "rebinding"
            && token_text(cst, required(cst, statement, "arrow")?)? == ":="
        {
            let name = token_text(cst, required(cst, statement, "name")?)?;
            if !shadowed.contains(&name) && !rebound.contains(&name) {
                rebound.push(name);
            }
            continue;
        }
        if cst.rule_name(statement)? == "rebinding"
            && token_text(cst, required(cst, statement, "arrow")?)? == "<-"
        {
            shadowed.push(token_text(cst, required(cst, statement, "name")?)?);
            continue;
        }
        if cst.rule_name(statement)? != "iteration" {
            for nested in nested_statement_lists(cst, statement)? {
                collect_rebound_names(cst, &nested, &shadowed, rebound)?;
            }
        }
        if cst.rule_name(statement)? != "binding" {
            continue;
        }
        let kind = token_text(cst, required(cst, statement, "kind")?)?;
        if kind != "let" && kind != "const" {
            continue;
        }
        let mut names = Vec::new();
        pattern_names_from_cst(cst, required(cst, statement, "pattern")?, &mut names)?;
        for name in &names {
            if rebound.contains(name) {
                return Err(format!(
                    "BLOT_SHADOWED_ACCUMULATOR: `{name}` is rebound with `:=` earlier in this block, so it leaves the block; a `let` here would shadow the name that carries it out. Rename the local, or move the `let` above the first `:=`."
                ));
            }
        }
        shadowed.extend(names);
    }
    Ok(())
}

fn pattern_names_from_cst(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    names: &mut Vec<String>,
) -> Result<(), String> {
    let rule = as_rule(cursor)?;
    let qualifier = match cst.field(rule, "qualifier")? {
        Some(qualifier) => Some(token_text(cst, qualifier)?),
        None => None,
    };
    if qualifier.as_deref() == Some("^") {
        return Ok(());
    }
    let core = cst.unwrap(required(cst, rule, "value")?)?;
    if let Cursor::Token(token) = core {
        let kind = cst.token_kind(token)?;
        let name = cst.text(core)?;
        if (kind == "IDENT" || kind == "TYPE_IDENT") && name != "_" {
            names.push(name);
        }
        return Ok(());
    }
    let core = as_rule(core)?;
    match cst.rule_name(core)? {
        "tuple_pattern" => {
            if let Some(first) = cst.field(core, "first")? {
                pattern_names_from_cst(cst, first, names)?;
            }
            for rest in cst.field_list(core, "rest")? {
                pattern_names_from_cst(cst, rest, names)?;
            }
        }
        "array_pattern" => {
            for element in cst.field_list(core, "elements")? {
                pattern_names_from_cst(cst, element, names)?;
            }
        }
        "constructor_pattern" => {
            if let Some(payload) = cst.field(core, "payload")? {
                pattern_names_from_cst(cst, payload, names)?;
            }
        }
        "shape_pattern" => {
            for field in cst.field_list(core, "fields")? {
                let field = as_rule(field)?;
                let values = cst.field_list(field, "value")?;
                if let Some(pattern) = values.last().copied() {
                    pattern_names_from_cst(cst, pattern, names)?;
                } else {
                    names.push(token_text(cst, required(cst, field, "name")?)?);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn lower_pattern(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    arena: &mut AstArena,
) -> Result<PatternId, String> {
    let rule = as_rule(cursor)?;
    require_rule(cst, rule, "binding_pattern")?;
    let span = cst.span(Cursor::Rule(rule))?;
    let qualifier_text = cst
        .field(rule, "qualifier")?
        .map(|cursor| token_text(cst, cursor))
        .transpose()?;
    let core = cst.unwrap(required(cst, rule, "value")?)?;
    if qualifier_text.as_deref() == Some("^") {
        let Cursor::Token(token) = core else {
            return Err(
                "BLOT_BAD_PIN: a pinned pattern is `^name`, naming one existing binding".to_owned(),
            );
        };
        let kind = cst.token_kind(token)?;
        let name = cst.text(core)?;
        if !matches!(kind.as_str(), "IDENT" | "TYPE_IDENT") || name == "_" {
            return Err(
                "BLOT_BAD_PIN: a pinned pattern is `^name`, naming one existing binding".to_owned(),
            );
        }
        return Ok(arena.pattern(Pattern::Pin { name, span }));
    }
    if qualifier_text.as_deref() == Some("-") {
        let Cursor::Token(token) = core else {
            return Err("BLOT_BAD_NEGATION: `-` applies only to an integer pattern".to_owned());
        };
        if cst.token_kind(token)? != "INTEGER" {
            return Err("BLOT_BAD_NEGATION: `-` applies only to an integer pattern".to_owned());
        }
        let value = -BigInt::from_str(&cst.text(core)?).map_err(|error| error.to_string())?;
        return Ok(arena.pattern(Pattern::Int { value, span }));
    }
    let qualifier = match qualifier_text.as_deref() {
        None => Qualifier::None,
        Some("!") => Qualifier::Linear,
        Some("?") => Qualifier::Affine,
        Some("&") => Qualifier::Borrow,
        Some(value) => return Err(format!("BLOT_BAD_PATTERN_QUALIFIER: `{value}`")),
    };
    if let Cursor::Token(token) = core {
        let text = cst.text(core)?;
        return match cst.token_kind(token)?.as_str() {
            "IDENT" | "TYPE_IDENT" if text == "_" => Ok(arena.pattern(Pattern::Wildcard { span })),
            "IDENT" | "TYPE_IDENT" => Ok(arena.pattern(Pattern::Name {
                name: text,
                qualifier,
                span,
            })),
            "INTEGER" => Ok(arena.pattern(Pattern::Int {
                value: BigInt::from_str(&text).map_err(|error| error.to_string())?,
                span,
            })),
            "FLOAT" => Ok(arena.pattern(Pattern::Float {
                value: text
                    .parse()
                    .map_err(|error| format!("invalid float: {error}"))?,
                span,
            })),
            "TEXT" => Ok(arena.pattern(Pattern::Text {
                value: decode_text(&text)?,
                span,
            })),
            _ => Err(format!("BLOT_BAD_PATTERN: `{text}`")),
        };
    }
    let core = as_rule(core)?;
    match cst.rule_name(core)? {
        "unit_pattern" => Ok(arena.pattern(Pattern::Unit { span })),
        "tuple_pattern" | "array_pattern" => {
            let mut elements = Vec::new();
            if let Some(first) = cst.field(core, "first")? {
                elements.push(lower_pattern(cst, first, arena)?);
            }
            for element in cst.field_list(
                core,
                if cst.rule_name(core)? == "tuple_pattern" {
                    "rest"
                } else {
                    "elements"
                },
            )? {
                elements.push(lower_pattern(cst, element, arena)?);
            }
            if cst.rule_name(core)? == "tuple_pattern" {
                Ok(arena.pattern(Pattern::Tuple { elements, span }))
            } else {
                Ok(arena.pattern(Pattern::Array { elements, span }))
            }
        }
        "constructor_pattern" => {
            let payload = cst
                .field(core, "payload")?
                .map(|payload| lower_pattern(cst, payload, arena))
                .transpose()?;
            let name = token_text(cst, required(cst, core, "constructor")?)?;
            Ok(arena.pattern(Pattern::Constructor {
                name,
                payload,
                span,
            }))
        }
        "shape_pattern" => {
            let mut fields = Vec::new();
            for field in cst.field_list(core, "fields")? {
                let field = as_rule(field)?;
                let name = token_text(cst, required(cst, field, "name")?)?;
                let values = cst.field_list(field, "value")?;
                let pattern = match values.last().copied() {
                    Some(pattern) => lower_pattern(cst, pattern, arena)?,
                    None => arena.pattern(Pattern::Name {
                        name: name.clone(),
                        qualifier: Qualifier::None,
                        span: cst.span(Cursor::Rule(field))?,
                    }),
                };
                fields.push(ShapePatternField { name, pattern });
            }
            Ok(arena.pattern(Pattern::Shape { fields, span }))
        }
        name => Err(format!("BLOT_BAD_PATTERN: `{name}`")),
    }
}

fn lower_value(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let wrapper = as_rule(cursor)?;
    let wrapper_name = cst.rule_name(wrapper)?;
    let target = if wrapper_name == "indented_value" {
        required(cst, wrapper, "value")?
    } else {
        cst.unwrap(cursor)?
    };
    let target_rule = match target {
        Cursor::Rule(rule) => rule,
        Cursor::Token(_) => {
            return Err(format!(
                "value wrapper {wrapper_name} unwrapped to token `{}`",
                cst.text(target)?
            ));
        }
    };
    if cst.rule_name(target_rule)? == "lambda" {
        return lower_lambda(cst, target_rule, context, arena);
    }
    let name = cst.rule_name(target_rule)?;
    lower_expression(cst, target_rule, context, arena)
        .map_err(|error| format!("while lowering value rule {name}: {error}"))
}

fn lower_lambda(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let parameters = cst.field_list(rule, "parameters")?;
    if parameters.is_empty() {
        return Err("a lambda has no parameter".to_owned());
    }
    let body = required(cst, rule, "body")?;
    let body = match body {
        Cursor::Rule(body) => body,
        Cursor::Token(_) => return Err(format!("lambda body is token `{}`", cst.text(body)?)),
    };
    let mut result = lower_expression(cst, body, &context.body(), arena)
        .map_err(|error| format!("while lowering lambda body: {error}"))?;
    let reuse = cst.field(rule, "reuse")?.is_some();
    for parameter in parameters.into_iter().rev() {
        let parameter = as_rule(parameter)?;
        let pattern_cursor = required(cst, parameter, "pattern")?;
        if let Cursor::Token(_) = pattern_cursor {
            return Err(format!(
                "lambda pattern field is token `{}`",
                cst.text(pattern_cursor)?
            ));
        }
        let deferred = deferred_parameter(cst, as_rule(pattern_cursor)?)?;
        let pattern = lower_lambda_pattern(cst, pattern_cursor, deferred, arena)
            .map_err(|error| format!("while lowering lambda parameter: {error}"))?;
        let span = Span {
            start: cst.span(Cursor::Rule(parameter))?.start,
            end: cst.span(Cursor::Rule(rule))?.end,
        };
        result = arena.expression(Expression::Lambda {
            parameter: pattern,
            body: result,
            reuse,
            deferred,
            span,
        });
    }
    Ok(result)
}

/// `~` is a qualifier only here: it defers one named parameter, where every
/// other qualifier describes ownership of a pattern. Source elaboration reads
/// it the same way, and every compiler entry point must expose the same tree.
fn deferred_parameter(cst: &CompactCst<'_>, pattern: u32) -> Result<bool, String> {
    let Some(qualifier) = cst.field(pattern, "qualifier")? else {
        return Ok(false);
    };
    // The qualifier arrives as a token or as the rule that wraps one, the same
    // way every other operator token in this grammar does.
    Ok(token_text(cst, qualifier)? == "~")
}

/// Lowers a lambda's parameter, with the deferring `~` already read off it.
/// The name it binds is an ordinary one: deferral belongs to the arrow, not to
/// the pattern, so nothing downstream sees a new qualifier.
fn lower_lambda_pattern(
    cst: &CompactCst<'_>,
    pattern: Cursor,
    deferred: bool,
    arena: &mut AstArena,
) -> Result<PatternId, String> {
    if !deferred {
        return lower_pattern(cst, pattern, arena);
    }
    let rule = as_rule(pattern)?;
    let span = cst.span(Cursor::Rule(rule))?;
    let core = cst.unwrap(required(cst, rule, "value")?)?;
    let Cursor::Token(token) = core else {
        return Err(deferred_parameter_error());
    };
    let kind = cst.token_kind(token)?;
    if kind != "IDENT" && kind != "TYPE_IDENT" {
        return Err(deferred_parameter_error());
    }
    let name = cst.text(core)?;
    if name == "_" {
        return Ok(arena.pattern(Pattern::Wildcard { span }));
    }
    Ok(arena.pattern(Pattern::Name {
        name,
        qualifier: Qualifier::None,
        span,
    }))
}

fn deferred_parameter_error() -> String {
    concat!(
        "BLOT_BAD_DEFERRED_PARAMETER: `~` defers one name parameter. Bind a ",
        "name, then destructure the value after it is demanded."
    )
    .to_owned()
}

fn lower_expression(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let rule_name = cst.rule_name(rule)?;
    if rule_name != "expression" && rule_name != "continued_expression" {
        return Err(format!("expected expression, found `{rule_name}`"));
    }
    let first = lower_operand(cst, as_rule(required(cst, rule, "first")?)?, context, arena)
        .map_err(|error| format!("while lowering first operand: {error}"))?;
    let mut steps = Vec::new();
    for step in cst.field_list(rule, "rest")? {
        let step = as_rule(step)?;
        steps.push(ChainStep {
            operator: token_text(cst, required(cst, step, "operator")?)?,
            right: lower_operand(cst, as_rule(required(cst, step, "right")?)?, context, arena)?,
            span: cst.span(Cursor::Rule(step))?,
        });
    }
    context.table.fold_chain(first, &steps, arena)
}

fn lower_operand(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let postfix = as_rule(required(cst, rule, "value")?)?;
    let mut result = lower_postfix(cst, postfix, context, arena)
        .map_err(|error| format!("while lowering postfix expression: {error}"))?;
    let mut prefixes = cst.field_list(rule, "prefixes")?;
    prefixes.reverse();
    for prefix in prefixes {
        let text = token_text(cst, prefix)?;
        let span = Span {
            start: cst.span(Cursor::Rule(rule))?.start,
            end: arena.expression_span(result).end,
        };
        if text == "-"
            && let Expression::Int { value, .. } = &arena.expressions[result.0 as usize]
        {
            let value = -value.clone();
            result = arena.expression(Expression::Int { value, span });
            continue;
        }
        if text == "^" && context.pattern_head {
            let function = arena.expression(Expression::Intrinsic {
                name: "@pattern.pin".to_owned(),
                span: cst.span(prefix)?,
            });
            result = arena.expression(Expression::Apply {
                function,
                argument: result,
                span,
            });
            continue;
        }
        let fixity = context
            .table
            .prefix(&text)
            .ok_or_else(|| format!("BLOT_UNKNOWN_OPERATOR: `{text}`"))?;
        let function = target_expression(fixity, span, arena)?;
        result = arena.expression(Expression::Apply {
            function,
            argument: result,
            span,
        });
    }
    Ok(result)
}

fn lower_postfix(
    cst: &CompactCst<'_>,
    rule: u32,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let value = cst.unwrap(required(cst, rule, "value")?)?;
    let mut result = lower_primary(cst, value, context, arena)
        .map_err(|error| format!("while lowering primary: {error}"))?;
    result = apply_suffixes(cst, result, cst.field_list(rule, "suffixes")?, arena)?;
    for argument in cst.field_list(rule, "arguments")? {
        let argument = as_rule(argument)?;
        let value = cst.unwrap(required(cst, argument, "value")?)?;
        let mut lowered = lower_primary(cst, value, context, arena)?;
        lowered = apply_suffixes(cst, lowered, cst.field_list(argument, "suffixes")?, arena)?;
        let span = Span {
            start: arena.expression_span(result).start,
            end: arena.expression_span(lowered).end,
        };
        result = arena.expression(Expression::Apply {
            function: result,
            argument: lowered,
            span,
        });
    }
    Ok(result)
}

fn apply_suffixes(
    cst: &CompactCst<'_>,
    mut target: ExpressionId,
    suffixes: Vec<Cursor>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    for suffix in suffixes {
        let suffix = as_rule(suffix)?;
        let span = Span {
            start: arena.expression_span(target).start,
            end: cst.span(Cursor::Rule(suffix))?.end,
        };
        target = arena.expression(Expression::Field {
            target,
            name: token_text(cst, required(cst, suffix, "field")?)?,
            span,
        });
    }
    Ok(target)
}

fn lower_primary(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let span = cst.span(cursor)?;
    if let Cursor::Token(token) = cursor {
        let text = cst.text(cursor)?;
        return match cst.token_kind(token)?.as_str() {
            "IDENT" | "TYPE_IDENT" => Ok(arena.expression(Expression::Var { name: text, span })),
            "INTEGER" => Ok(arena.expression(Expression::Int {
                value: BigInt::from_str(&text).map_err(|error| error.to_string())?,
                span,
            })),
            "FLOAT" => Ok(arena.expression(Expression::Float {
                value: text
                    .parse()
                    .map_err(|error| format!("invalid float: {error}"))?,
                span,
            })),
            "TEXT" => Ok(arena.expression(Expression::Text {
                value: decode_text(&text)?,
                span,
            })),
            "INTRINSIC" if text == "@import" => Err(concat!(
                "BLOT_RETIRED_IMPORT: `@import` is retired; write ",
                "`import \"path\"` or `import \"path\" with value`."
            )
            .to_owned()),
            "INTRINSIC" => Ok(arena.expression(Expression::Intrinsic { name: text, span })),
            _ => Err(format!("BLOT_BAD_EXPRESSION: `{text}`")),
        };
    }
    let rule = as_rule(cursor)?;
    match cst.rule_name(rule)? {
        "import_expression" => {
            let specifier_cursor = required(cst, rule, "specifier")?;
            let specifier_span = cst.span(specifier_cursor)?;
            let specifier = arena.expression(Expression::Text {
                value: decode_text(&cst.text(specifier_cursor)?)?,
                span: specifier_span,
            });
            let intrinsic = arena.expression(Expression::Intrinsic {
                name: "@import".to_owned(),
                span,
            });
            let loaded = arena.expression(Expression::Apply {
                function: intrinsic,
                argument: specifier,
                span: Span {
                    start: span.start,
                    end: specifier_span.end,
                },
            });
            let input_field = cst.field_list(rule, "input")?;
            let input = if input_field.is_empty() {
                arena.expression(Expression::Unit { span })
            } else {
                let input = input_field
                    .get(1)
                    .copied()
                    .ok_or_else(|| "import input has no value".to_owned())?;
                lower_value(cst, input, context, arena)?
            };
            Ok(arena.expression(Expression::Apply {
                function: loaded,
                argument: input,
                span,
            }))
        }
        "constructor_expression" => Ok(arena.expression(Expression::Tag {
            name: token_text(cst, required(cst, rule, "constructor")?)?,
            span,
        })),
        "unit" => Ok(arena.expression(Expression::Unit { span })),
        "parenthesized_or_tuple" => {
            let first = lower_value(cst, required(cst, rule, "first")?, context, arena)?;
            if cst.field(rule, "tail")?.is_none() {
                return Ok(first);
            }
            let mut elements = vec![first];
            for element in cst.field_list(rule, "rest")? {
                elements.push(lower_value(cst, element, context, arena)?);
            }
            if elements.len() == 1 {
                return Ok(first);
            }
            Ok(arena.expression(Expression::Tuple { elements, span }))
        }
        "array" => {
            let mut elements = Vec::new();
            for element in cst.field_list(rule, "elements")? {
                let element = as_rule(element)?;
                elements.push(ArrayElement {
                    spread: cst.field(element, "spread")?.is_some(),
                    value: lower_value(cst, required(cst, element, "value")?, context, arena)?,
                });
            }
            Ok(arena.expression(Expression::Array { elements, span }))
        }
        "effect_row" => {
            let children = cst.children(rule)?;
            let mut members: Vec<Vec<Cursor>> = Vec::new();
            let mut current = Vec::new();
            for child in children
                .iter()
                .copied()
                .skip(1)
                .take(children.len().saturating_sub(2))
            {
                if matches!(child, Cursor::Token(_)) && cst.text(child)? == "," {
                    members.push(current);
                    current = Vec::new();
                } else {
                    current.push(child);
                }
            }
            if !current.is_empty() {
                members.push(current);
            }
            let mut elements = Vec::new();
            let mut saw_tail = false;
            for (index, member) in members.iter().enumerate() {
                let tail_name = match member.first().copied() {
                    Some(Cursor::Rule(member)) if cst.rule_name(member)? == "effect_row_tail" => {
                        Some(required(cst, member, "name")?)
                    }
                    Some(Cursor::Token(token)) if cst.text(Cursor::Token(token))? == ".." => {
                        member.get(1).copied()
                    }
                    _ => None,
                };
                if let Some(name_cursor) = tail_name {
                    if saw_tail || index + 1 != members.len() {
                        return Err(
                            "BLOT_EFFECT_ROW_TAIL_POSITION: an effect row has at most one tail, and it must be its final member"
                                .to_owned(),
                        );
                    }
                    saw_tail = true;
                    let value = arena.expression(Expression::Var {
                        name: token_text(cst, name_cursor)?,
                        span: cst.span(name_cursor)?,
                    });
                    elements.push(ArrayElement {
                        spread: false,
                        value,
                    });
                    continue;
                }
                let member = member
                    .iter()
                    .copied()
                    .find(|cursor| {
                        matches!(cursor, Cursor::Rule(rule) if cst.rule_name(*rule).ok() == Some("expression"))
                    })
                    .ok_or_else(|| "unknown effect-row member".to_owned())?;
                elements.push(ArrayElement {
                    spread: false,
                    value: lower_expression(cst, as_rule(member)?, context, arena)?,
                });
            }
            Ok(arena.expression(Expression::Array { elements, span }))
        }
        "shape" => {
            let mut members = Vec::new();
            for member in cst.field_list(rule, "members")? {
                let member = unwrapped_rule(cst, member)?;
                if cst.rule_name(member)? == "shape_spread" {
                    members.push(ShapeMember::Spread {
                        value: lower_expression(
                            cst,
                            as_rule(required(cst, member, "value")?)?,
                            context,
                            arena,
                        )?,
                    });
                    continue;
                }
                let name = token_text(cst, required(cst, member, "name")?)?;
                let mut value =
                    lower_value(cst, required(cst, member, "value")?, context, arena)
                        .map_err(|error| format!("while lowering field `{name}`: {error}"))?;
                if cst.field(member, "optional")?.is_some() {
                    let function = arena.expression(Expression::Intrinsic {
                        name: "@type.union".to_owned(),
                        span: cst.span(Cursor::Rule(member))?,
                    });
                    let applied = arena.expression(Expression::Apply {
                        function,
                        argument: value,
                        span: cst.span(Cursor::Rule(member))?,
                    });
                    let unit = arena.expression(Expression::Unit {
                        span: cst.span(Cursor::Rule(member))?,
                    });
                    value = arena.expression(Expression::Apply {
                        function: applied,
                        argument: unit,
                        span: cst.span(Cursor::Rule(member))?,
                    });
                }
                members.push(ShapeMember::Field { name, value });
            }
            Ok(arena.expression(Expression::Shape { members, span }))
        }
        "case_expression" => {
            let target = lower_expression(
                cst,
                as_rule(required(cst, rule, "target")?)?,
                &context.value_condition(),
                arena,
            )?;
            let mut arm_cursors = vec![required(cst, rule, "first")?];
            arm_cursors.extend(cst.field_list(rule, "rest")?);
            let mut arms = Vec::new();
            for arm in arm_cursors {
                let arm = as_rule(arm)?;
                let guard = match cst.field(arm, "guard")? {
                    Some(guard) => {
                        let guard = as_rule(guard)?;
                        Some(lower_expression(
                            cst,
                            as_rule(required(cst, guard, "condition")?)?,
                            &context.value_condition(),
                            arena,
                        )?)
                    }
                    None => None,
                };
                arms.push(GuardedArm {
                    pattern: lower_pattern(cst, required(cst, arm, "pattern")?, arena)?,
                    guard,
                    body: lower_value(
                        cst,
                        required(cst, arm, "body")?,
                        &context.value_condition(),
                        arena,
                    )?,
                });
            }
            lower_guards(target, &arms, span, arena)
        }
        // `do:` and `compdo:` share one statement scope. `compdo:` wraps the
        // completed block in the existing internal comptime expression.
        "block" | "do_block" => {
            let phase = if cst.rule_name(rule)? == "do_block" {
                token_text(cst, required(cst, rule, "phase")?)?
            } else {
                "do".to_owned()
            };
            if phase != "do" && phase != "compdo" {
                return Err(format!("unknown block phase `{phase}`"));
            }
            let mut statements = cst.field_list(rule, "statements")?;
            let mut result = arena.expression(Expression::Unit { span });
            let mut result_effects = ResultEffects::Pure;
            let mut block_context = context.clone();
            block_context.return_scope = true;
            let mut contains_only_result = false;
            if let Some(last) = statements.last().copied()
                && let Some(terminal_return) =
                    lower_terminal_return(cst, last, &block_context, arena)?
            {
                result = terminal_return;
                result_effects = ResultEffects::Ambient;
                statements.pop();
                contains_only_result = statements.is_empty();
            }
            if contains_only_result {
                return Ok(finish_source_block(&phase, result, span, arena));
            }
            if statements_need_control(cst, &statements)? {
                let result = resolve_control_sequence(
                    cst,
                    &statements,
                    result,
                    &block_context,
                    span,
                    arena,
                )?;
                let block = arena.expression(Expression::Block {
                    declarations: Vec::new(),
                    result,
                    result_effects: ResultEffects::Ambient,
                    span,
                });
                return Ok(finish_source_block(&phase, block, span, arena));
            }
            let mut declarations = Vec::new();
            for statement in statements {
                let statement = unwrapped_rule(cst, statement)?;
                declarations.push(lower_declaration(cst, statement, &block_context, arena)?);
            }
            let block = arena.expression(Expression::Block {
                declarations,
                result,
                result_effects,
                span,
            });
            Ok(finish_source_block(&phase, block, span, arena))
        }
        name => Err(format!(
            "Rust middle has not lowered expression `{name}` yet"
        )),
    }
}

fn lower_terminal_return(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<Option<ExpressionId>, String> {
    let rule = statement_rule(cst, cursor)?;
    if cst.rule_name(rule)? == "result" {
        return lower_value(cst, required(cst, rule, "value")?, context, arena).map(Some);
    }
    if cst.rule_name(rule)? != "conditional_statement" {
        return Ok(None);
    }

    let body = as_rule(required(cst, rule, "body")?)?;
    if cst.rule_name(body)? != "conditional_statement_branches" {
        return Ok(None);
    }
    let Some(fallback) = cst.field(body, "fallback")? else {
        return Ok(None);
    };

    let mut clauses = vec![Cursor::Rule(body)];
    clauses.extend(cst.field_list(body, "alternatives")?);
    let mut branches = Vec::new();
    for clause in clauses {
        let clause = as_rule(clause)?;
        let statements = statement_suite(cst, clause, "consequence")?;
        let Some(consequence) = lower_terminal_suite(cst, &statements, context, arena)? else {
            return Ok(None);
        };
        let condition = lower_expression(
            cst,
            as_rule(required(cst, clause, "condition")?)?,
            context,
            arena,
        )?;
        branches.push(Branch {
            condition,
            consequence,
        });
    }

    let fallback = as_rule(fallback)?;
    let statements = statement_suite(cst, fallback, "alternative")?;
    let Some(alternative) = lower_terminal_suite(cst, &statements, context, arena)? else {
        return Ok(None);
    };
    Ok(Some(arena.expression(Expression::If {
        branches,
        fallback: Some(alternative),
        span: cst.span(Cursor::Rule(body))?,
    })))
}

fn lower_terminal_suite(
    cst: &CompactCst<'_>,
    cursors: &[Cursor],
    context: &LoweringContext<'_>,
    arena: &mut AstArena,
) -> Result<Option<ExpressionId>, String> {
    let Some(last) = cursors.last().copied() else {
        return Ok(None);
    };
    let Some(result) = lower_terminal_return(cst, last, context, arena)? else {
        return Ok(None);
    };

    let declarations = &cursors[..cursors.len() - 1];
    if statements_need_control(cst, declarations)? {
        return Ok(None);
    }
    if declarations.is_empty() {
        return Ok(Some(result));
    }

    let mut lowered = Vec::new();
    for declaration in declarations {
        let declaration = statement_rule(cst, *declaration)?;
        lowered.push(lower_declaration(cst, declaration, context, arena)?);
    }
    let start = cst.span(Cursor::Rule(statement_rule(cst, declarations[0])?))?;
    let end = cst.span(Cursor::Rule(statement_rule(cst, last)?))?;
    Ok(Some(arena.expression(Expression::Block {
        declarations: lowered,
        result,
        result_effects: ResultEffects::Ambient,
        span: Span {
            start: start.start,
            end: end.end,
        },
    })))
}

#[derive(Clone, Copy)]
struct GuardedArm {
    pattern: PatternId,
    guard: Option<ExpressionId>,
    body: ExpressionId,
}

/// Builds a `case`, folding the two-arm Boolean form into the internal
/// conditional the way source elaboration does. `case` is the source
/// value-selection form; the conditional node is what the checker's branch
/// refinement already reads, and every compiler entry point must expose the same tree.
fn case_expression(
    target: ExpressionId,
    arms: Vec<Arm>,
    span: Span,
    arena: &mut AstArena,
) -> ExpressionId {
    if arms.len() == 2 {
        let consequence = boolean_arm(&arms, "True", arena);
        let fallback = boolean_arm(&arms, "False", arena);
        if let (Some(consequence), Some(fallback)) = (consequence, fallback) {
            return arena.expression(Expression::If {
                branches: vec![Branch {
                    condition: target,
                    consequence,
                }],
                fallback: Some(fallback),
                span,
            });
        }
    }
    arena.expression(Expression::Case { target, arms, span })
}

fn boolean_arm(arms: &[Arm], name: &str, arena: &AstArena) -> Option<ExpressionId> {
    arms.iter()
        .find(|arm| match &arena.patterns[arm.pattern.0 as usize] {
            Pattern::Constructor {
                name: constructor,
                payload: None,
                ..
            } => constructor == name,
            _ => false,
        })
        .map(|arm| arm.body)
}

fn lower_guards(
    target: ExpressionId,
    arms: &[GuardedArm],
    span: Span,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    if arms.iter().all(|arm| arm.guard.is_none()) {
        let arms: Vec<Arm> = arms
            .iter()
            .map(|arm| Arm {
                pattern: arm.pattern,
                body: arm.body,
            })
            .collect();
        return Ok(case_expression(target, arms, span, arena));
    }
    if matches!(arena.expressions[target.0 as usize], Expression::Var { .. }) {
        return guard_level(target, arms, span, 0, arena);
    }
    let subject_name = format!("subject${}${}", span.start, span.end);
    let subject_pattern = arena.pattern(Pattern::Name {
        name: subject_name.clone(),
        qualifier: Qualifier::None,
        span,
    });
    let binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Let,
        tags: Vec::new(),
        pattern: subject_pattern,
        value: target,
        span,
    });
    let subject = variable(&subject_name, span, arena);
    let result = guard_level(subject, arms, span, 0, arena)?;
    Ok(arena.expression(Expression::Block {
        declarations: vec![binding],
        result,
        result_effects: ResultEffects::Ambient,
        span,
    }))
}

fn guard_level(
    subject: ExpressionId,
    arms: &[GuardedArm],
    span: Span,
    depth: usize,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let Some(index) = arms.iter().position(|arm| arm.guard.is_some()) else {
        let arms: Vec<Arm> = arms
            .iter()
            .map(|arm| Arm {
                pattern: arm.pattern,
                body: arm.body,
            })
            .collect();
        return Ok(case_expression(subject, arms, span, arena));
    };
    let guarded = arms[index];
    let condition = guarded
        .guard
        .ok_or_else(|| "guarded arm omitted its condition".to_owned())?;
    let name = format!("fallthrough${}${}${depth}", span.start, span.end);
    let mut level = Vec::new();
    for arm in &arms[..index] {
        level.push(Arm {
            pattern: erase_binders(arm.pattern, arena),
            body: fallthrough(&name, span, arena),
        });
    }
    let fallback = fallthrough(&name, span, arena);
    let guarded_body = arena.expression(Expression::If {
        branches: vec![Branch {
            condition,
            consequence: guarded.body,
        }],
        fallback: Some(fallback),
        span,
    });
    level.push(Arm {
        pattern: guarded.pattern,
        body: guarded_body,
    });
    let wildcard = arena.pattern(Pattern::Wildcard { span });
    let fallback = fallthrough(&name, span, arena);
    level.push(Arm {
        pattern: wildcard,
        body: fallback,
    });

    let mut remaining = arms.to_vec();
    remaining.remove(index);
    let body = guard_level(subject, &remaining, span, depth + 1, arena)?;
    let unit = arena.pattern(Pattern::Unit { span });
    let lambda = arena.expression(Expression::Lambda {
        parameter: unit,
        body,
        reuse: false,
        deferred: false,
        span,
    });
    let pattern = arena.pattern(Pattern::Name {
        name: name.clone(),
        qualifier: Qualifier::None,
        span,
    });
    let binding = arena.declaration(Declaration::Binding {
        kind: DeclarationKind::Let,
        tags: Vec::new(),
        pattern,
        value: lambda,
        span,
    });
    let result = arena.expression(Expression::Case {
        target: subject,
        arms: level,
        span,
    });
    Ok(arena.expression(Expression::Block {
        declarations: vec![binding],
        result,
        result_effects: ResultEffects::Ambient,
        span,
    }))
}

fn fallthrough(name: &str, span: Span, arena: &mut AstArena) -> ExpressionId {
    let function = variable(name, span, arena);
    let argument = arena.expression(Expression::Unit { span });
    arena.expression(Expression::Apply {
        function,
        argument,
        span,
    })
}

fn erase_binders(pattern: PatternId, arena: &mut AstArena) -> PatternId {
    match arena.patterns[pattern.0 as usize].clone() {
        Pattern::Name { span, .. } => arena.pattern(Pattern::Wildcard { span }),
        Pattern::Tuple { elements, span } => {
            let elements = elements
                .into_iter()
                .map(|pattern| erase_binders(pattern, arena))
                .collect();
            arena.pattern(Pattern::Tuple { elements, span })
        }
        Pattern::Array { elements, span } => {
            let elements = elements
                .into_iter()
                .map(|pattern| erase_binders(pattern, arena))
                .collect();
            arena.pattern(Pattern::Array { elements, span })
        }
        Pattern::Constructor {
            name,
            payload: Some(payload),
            span,
        } => {
            let payload = erase_binders(payload, arena);
            arena.pattern(Pattern::Constructor {
                name,
                payload: Some(payload),
                span,
            })
        }
        Pattern::Shape { fields, span } => {
            let fields = fields
                .into_iter()
                .map(|field| ShapePatternField {
                    name: field.name,
                    pattern: erase_binders(field.pattern, arena),
                })
                .collect();
            arena.pattern(Pattern::Shape { fields, span })
        }
        pattern => arena.pattern(pattern),
    }
}

fn decode_text(literal: &str) -> Result<String, String> {
    if !literal.starts_with('"') || !literal.ends_with('"') {
        return Err(format!("invalid text literal {literal}"));
    }
    let mut result = String::new();
    let mut characters = literal[1..literal.len() - 1].chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            result.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => result.push('\n'),
            Some('t') => result.push('\t'),
            Some('r') => result.push('\r'),
            Some('"') => result.push('"'),
            Some('\\') => result.push('\\'),
            Some(escape) => return Err(format!("BLOT_BAD_ESCAPE: \\{escape}")),
            None => return Err("BLOT_BAD_ESCAPE: trailing backslash".to_owned()),
        }
    }
    Ok(result)
}

fn required(cst: &CompactCst<'_>, rule: u32, field: &str) -> Result<Cursor, String> {
    cst.field(rule, field)?
        .ok_or_else(|| format!("{rule} omitted required field `{field}`"))
}

fn require_rule(cst: &CompactCst<'_>, rule: u32, expected: &str) -> Result<(), String> {
    let actual = cst.rule_name(rule)?;
    if actual != expected {
        return Err(format!("expected {expected}, got {actual}"));
    }
    Ok(())
}

fn unwrapped_rule(cst: &CompactCst<'_>, cursor: Cursor) -> Result<u32, String> {
    as_rule(cst.unwrap(cursor)?)
}

fn as_rule(cursor: Cursor) -> Result<u32, String> {
    match cursor {
        Cursor::Rule(rule) => Ok(rule),
        Cursor::Token(_) => Err("expected a rule, got a token".to_owned()),
    }
}

fn token_text(cst: &CompactCst<'_>, mut cursor: Cursor) -> Result<String, String> {
    while let Cursor::Rule(rule) = cursor {
        let name = cst.rule_name(rule)?;
        cursor = cst
            .child(rule, 0)?
            .ok_or_else(|| format!("rule {name} has no child"))?;
    }
    cst.text(cursor)
}
