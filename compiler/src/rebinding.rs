use std::collections::HashSet;

use crate::cst::{CompactCst, Cursor};
use crate::diagnostic::Diagnostic;

#[derive(Clone)]
struct ScopeLayer {
    frame: u32,
    names: HashSet<String>,
}

#[derive(Clone)]
struct Scope {
    layers: Vec<ScopeLayer>,
}

struct Validation {
    diagnostics: Vec<Diagnostic>,
    next_frame: u32,
}

pub(crate) fn diagnostics(cst: &CompactCst<'_>) -> Result<Vec<Diagnostic>, String> {
    let mut validation = Validation {
        diagnostics: Vec::new(),
        next_frame: 0,
    };
    let mut scope = new_frame(None, &mut validation);
    let root = rule(cst.root())?;
    if let Some(header) = field(cst, root, "header")?
        && let Cursor::Rule(header) = header
        && let Some(parameter) = field(cst, header, "parameter")?
    {
        bind_names(&mut scope, bound_pattern_names(cst, parameter)?);
    }
    visit_statements(
        cst,
        &field_list(cst, root, "declarations")?,
        &mut scope,
        &mut validation,
    )?;
    Ok(validation.diagnostics)
}

fn new_frame(parent: Option<&Scope>, validation: &mut Validation) -> Scope {
    validation.next_frame += 1;
    let mut layers = parent.map_or_else(Vec::new, |parent| parent.layers.clone());
    layers.push(ScopeLayer {
        frame: validation.next_frame,
        names: HashSet::new(),
    });
    Scope { layers }
}

fn child_scope(parent: &Scope) -> Result<Scope, String> {
    let frame = parent
        .layers
        .last()
        .map(|layer| layer.frame)
        .ok_or_else(|| "rebinding scope has no frame".to_owned())?;
    let mut layers = parent.layers.clone();
    layers.push(ScopeLayer {
        frame,
        names: HashSet::new(),
    });
    Ok(Scope { layers })
}

fn bind_names(scope: &mut Scope, names: Vec<String>) {
    let layer = scope
        .layers
        .last_mut()
        .expect("rebinding scope has a layer");
    layer.names.extend(names);
}

fn visible(scope: &Scope, name: &str) -> bool {
    scope.layers.iter().any(|layer| layer.names.contains(name))
}

fn rebindable(scope: &Scope, name: &str) -> bool {
    let Some(frame) = scope.layers.last().map(|layer| layer.frame) else {
        return false;
    };
    for layer in scope.layers.iter().rev() {
        if layer.frame != frame {
            break;
        }
        if layer.names.contains(name) {
            return true;
        }
    }
    false
}

fn visit_statements(
    cst: &CompactCst<'_>,
    cursors: &[Cursor],
    scope: &mut Scope,
    validation: &mut Validation,
) -> Result<(), String> {
    for cursor in cursors {
        let statement = statement_rule(cst, *cursor)?;
        visit_statement(cst, statement, scope, validation)?;
    }
    Ok(())
}

fn visit_statement(
    cst: &CompactCst<'_>,
    rule_id: u32,
    scope: &mut Scope,
    validation: &mut Validation,
) -> Result<(), String> {
    let name = cst.rule_name(rule_id)?;
    if name == "binding" {
        for tag in field_list(cst, rule_id, "tags")? {
            if let Cursor::Rule(tag) = tag
                && let Some(descriptor) = field(cst, tag, "descriptor")?
            {
                visit_cursor(cst, descriptor, scope, validation)?;
            }
        }
        if let Some(value) = field(cst, rule_id, "value")? {
            visit_cursor(cst, value, scope, validation)?;
        }
        let kind = field(cst, rule_id, "kind")?
            .map(|cursor| token_text(cst, cursor))
            .transpose()?
            .flatten();
        if matches!(kind.as_deref(), Some("let" | "const"))
            && let Some(pattern) = field(cst, rule_id, "pattern")?
        {
            bind_names(scope, bound_pattern_names(cst, pattern)?);
        }
        return Ok(());
    }

    if name == "rebinding" {
        if let Some(value) = field(cst, rule_id, "value")? {
            visit_cursor(cst, value, scope, validation)?;
        }
        let name = field(cst, rule_id, "name")?
            .map(|cursor| token_text(cst, cursor))
            .transpose()?
            .flatten();
        let Some(name) = name else {
            return Ok(());
        };
        if visible(scope, &name) && !rebindable(scope, &name) {
            validation.diagnostics.push(Diagnostic::new(
                "BLOT_REBINDING_FRAME",
                format!(
                    "`{name} := ...` requires a binding introduced in this rebinding frame. Start a local lineage with `let {name} = {name}` before rebinding it."
                ),
                cst.span(Cursor::Rule(rule_id))?,
            ));
        }
        return Ok(());
    }

    if name == "sequencing" {
        let head = field(cst, rule_id, "head")?;
        let value = field(cst, rule_id, "value")?;
        if let Some(value) = value {
            visit_cursor(cst, value, scope, validation)?;
            if let Some(head) = head {
                bind_names(scope, bound_expression_names(cst, head)?);
            }
            return Ok(());
        }
        if let Some(head) = head {
            visit_cursor(cst, head, scope, validation)?;
        }
        return Ok(());
    }

    if name == "conditional_statement" {
        return visit_conditional(cst, rule_id, scope, validation);
    }
    if name == "iteration" {
        return visit_iteration(cst, rule_id, scope, validation);
    }
    for field_name in ["value", "head", "source"] {
        if let Some(value) = field(cst, rule_id, field_name)? {
            visit_cursor(cst, value, scope, validation)?;
        }
    }
    Ok(())
}

fn visit_conditional(
    cst: &CompactCst<'_>,
    rule_id: u32,
    scope: &mut Scope,
    validation: &mut Validation,
) -> Result<(), String> {
    let Some(Cursor::Rule(body)) = field(cst, rule_id, "body")? else {
        return Ok(());
    };
    if cst.rule_name(body)? == "conditional_statement_guard" {
        if let Some(value) = field(cst, body, "value")? {
            visit_cursor(cst, value, scope, validation)?;
        }
        let mut alternative_scope = child_scope(scope)?;
        visit_statements(
            cst,
            &statement_suite(cst, body, "alternative")?,
            &mut alternative_scope,
            validation,
        )?;
        if let Some(pattern) = field(cst, body, "pattern")? {
            bind_names(scope, bound_pattern_names(cst, pattern)?);
        }
        return Ok(());
    }

    if let Some(condition) = field(cst, body, "condition")? {
        visit_cursor(cst, condition, scope, validation)?;
    }
    let mut consequence_scope = child_scope(scope)?;
    visit_statements(
        cst,
        &statement_suite(cst, body, "consequence")?,
        &mut consequence_scope,
        validation,
    )?;
    for alternative in field_list(cst, body, "alternatives")? {
        let Cursor::Rule(alternative) = alternative else {
            continue;
        };
        if let Some(condition) = field(cst, alternative, "condition")? {
            visit_cursor(cst, condition, scope, validation)?;
        }
        let mut consequence_scope = child_scope(scope)?;
        visit_statements(
            cst,
            &statement_suite(cst, alternative, "consequence")?,
            &mut consequence_scope,
            validation,
        )?;
    }
    if let Some(Cursor::Rule(fallback)) = field(cst, body, "fallback")? {
        let mut alternative_scope = child_scope(scope)?;
        visit_statements(
            cst,
            &statement_suite(cst, fallback, "alternative")?,
            &mut alternative_scope,
            validation,
        )?;
    }
    Ok(())
}

fn visit_iteration(
    cst: &CompactCst<'_>,
    rule_id: u32,
    scope: &mut Scope,
    validation: &mut Validation,
) -> Result<(), String> {
    let head = field(cst, rule_id, "head")?;
    let drawn = field(cst, rule_id, "drawn")?;
    let mut body_scope = child_scope(scope)?;
    if drawn.is_none() {
        if let Some(head) = head {
            visit_cursor(cst, head, scope, validation)?;
        }
    } else {
        if let Some(head) = head {
            bind_names(&mut body_scope, bound_expression_names(cst, head)?);
        }
        if let Some(Cursor::Rule(drawn)) = drawn
            && let Some(source) = field(cst, drawn, "source")?
        {
            visit_cursor(cst, source, scope, validation)?;
        }
    }
    visit_statements(
        cst,
        &statement_suite(cst, rule_id, "body")?,
        &mut body_scope,
        validation,
    )
}

fn visit_cursor(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    scope: &mut Scope,
    validation: &mut Validation,
) -> Result<(), String> {
    let Cursor::Rule(rule_id) = cursor else {
        return Ok(());
    };
    let name = cst.rule_name(rule_id)?;
    if name == "lambda" {
        let mut frame = scope.clone();
        for parameter in field_list(cst, rule_id, "parameters")? {
            let Cursor::Rule(parameter) = parameter else {
                continue;
            };
            frame = new_frame(Some(&frame), validation);
            if let Some(pattern) = field(cst, parameter, "pattern")? {
                bind_names(&mut frame, bound_pattern_names(cst, pattern)?);
            }
        }
        if let Some(body) = field(cst, rule_id, "body")? {
            visit_frame_body(cst, body, &mut frame, validation)?;
        }
        return Ok(());
    }
    if matches!(name, "do_block" | "block") {
        let mut frame = new_frame(Some(scope), validation);
        return visit_statements(
            cst,
            &field_list(cst, rule_id, "statements")?,
            &mut frame,
            validation,
        );
    }
    if name == "case_expression" {
        if let Some(target) = field(cst, rule_id, "target")? {
            visit_cursor(cst, target, scope, validation)?;
        }
        let mut arms = Vec::new();
        if let Some(first) = field(cst, rule_id, "first")? {
            arms.push(first);
        }
        arms.extend(field_list(cst, rule_id, "rest")?);
        for arm in arms {
            let Cursor::Rule(arm) = arm else {
                continue;
            };
            let mut frame = new_frame(Some(scope), validation);
            if let Some(pattern) = field(cst, arm, "pattern")? {
                bind_names(&mut frame, bound_pattern_names(cst, pattern)?);
            }
            if let Some(guard) = field(cst, arm, "guard")? {
                visit_cursor(cst, guard, &mut frame, validation)?;
            }
            if let Some(body) = field(cst, arm, "body")? {
                visit_frame_body(cst, body, &mut frame, validation)?;
            }
        }
        return Ok(());
    }
    for child in cst.children(rule_id)? {
        visit_cursor(cst, child, scope, validation)?;
    }
    Ok(())
}

fn visit_frame_body(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    frame: &mut Scope,
    validation: &mut Validation,
) -> Result<(), String> {
    if let Some(direct) = direct_statement_scope(cst, cursor)? {
        return visit_statements(
            cst,
            &field_list(cst, direct, "statements")?,
            frame,
            validation,
        );
    }
    visit_cursor(cst, cursor, frame, validation)
}

fn direct_statement_scope(cst: &CompactCst<'_>, mut cursor: Cursor) -> Result<Option<u32>, String> {
    loop {
        let Cursor::Rule(rule_id) = cursor else {
            return Ok(None);
        };
        if matches!(cst.rule_name(rule_id)?, "do_block" | "block") {
            return Ok(Some(rule_id));
        }
        let children = cst
            .children(rule_id)?
            .into_iter()
            .filter(|child| matches!(child, Cursor::Rule(_)))
            .collect::<Vec<_>>();
        if children.len() != 1 {
            return Ok(None);
        }
        cursor = children[0];
    }
}

fn statement_rule(cst: &CompactCst<'_>, cursor: Cursor) -> Result<u32, String> {
    let mut rule_id = rule(cursor)?;
    while matches!(cst.rule_name(rule_id)?, "statement" | "declaration") {
        let Some(Cursor::Rule(next)) = cst.child(rule_id, 0)? else {
            break;
        };
        rule_id = next;
    }
    Ok(rule_id)
}

fn statement_suite(cst: &CompactCst<'_>, rule_id: u32, name: &str) -> Result<Vec<Cursor>, String> {
    let Some(Cursor::Rule(suite)) = field(cst, rule_id, name)? else {
        return Ok(Vec::new());
    };
    if cst.rule_name(suite)? != "statement_suite" {
        return Ok(Vec::new());
    }
    field_list(cst, suite, "statements")
}

fn bound_pattern_names(cst: &CompactCst<'_>, cursor: Cursor) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    collect_pattern_names(cst, cursor, &mut found)?;
    Ok(found)
}

fn collect_pattern_names(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    found: &mut Vec<String>,
) -> Result<(), String> {
    if let Cursor::Token(token) = cursor {
        let kind = cst.token_kind(token)?;
        let text = cst.text(cursor)?;
        if matches!(kind.as_str(), "IDENT" | "TYPE_IDENT") && text != "_" {
            found.push(text);
        }
        return Ok(());
    }
    let Cursor::Rule(rule_id) = cursor else {
        unreachable!()
    };
    match cst.rule_name(rule_id)? {
        "binding_pattern" => {
            let qualifier = match field(cst, rule_id, "qualifier")? {
                Some(qualifier) => token_text(cst, qualifier)?,
                None => None,
            };
            if qualifier.as_deref() == Some("^") {
                return Ok(());
            }
            if let Some(value) = field(cst, rule_id, "value")?.or(cst.child(rule_id, 0)?) {
                collect_pattern_names(cst, value, found)?;
            }
        }
        "pattern_core" => {
            if let Some(value) = field(cst, rule_id, "value")?.or(cst.child(rule_id, 0)?) {
                collect_pattern_names(cst, value, found)?;
            }
        }
        "unit_pattern" => {}
        "constructor_pattern" => {
            if let Some(payload) = field(cst, rule_id, "payload")? {
                collect_pattern_names(cst, payload, found)?;
            }
        }
        "tuple_pattern" => {
            if let Some(first) = field(cst, rule_id, "first")? {
                collect_pattern_names(cst, first, found)?;
            }
            for rest in field_list(cst, rule_id, "rest")? {
                collect_pattern_names(cst, rest, found)?;
            }
        }
        "array_pattern" => {
            for element in field_list(cst, rule_id, "elements")? {
                collect_pattern_names(cst, element, found)?;
            }
        }
        "shape_pattern" => {
            for field_cursor in field_list(cst, rule_id, "fields")? {
                let Cursor::Rule(field_rule) = field_cursor else {
                    continue;
                };
                let values = field_list(cst, field_rule, "value")?;
                if let Some(explicit) = values
                    .iter()
                    .rev()
                    .copied()
                    .find(|value| matches!(value, Cursor::Rule(_)))
                {
                    collect_pattern_names(cst, explicit, found)?;
                    continue;
                }
                if let Some(name) = field(cst, field_rule, "name")?
                    && let Some(name) = token_text(cst, name)?
                    && name != "_"
                {
                    found.push(name);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn bound_expression_names(cst: &CompactCst<'_>, cursor: Cursor) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    collect_binder_expression_names(cst, cursor, &mut found)?;
    Ok(found)
}

fn collect_binder_expression_names(
    cst: &CompactCst<'_>,
    cursor: Cursor,
    found: &mut Vec<String>,
) -> Result<(), String> {
    if let Cursor::Token(token) = cursor {
        let kind = cst.token_kind(token)?;
        let text = cst.text(cursor)?;
        if matches!(kind.as_str(), "IDENT" | "TYPE_IDENT") && text != "_" {
            found.push(text);
        }
        return Ok(());
    }
    let Cursor::Rule(rule_id) = cursor else {
        unreachable!()
    };
    let name = cst.rule_name(rule_id)?;
    if matches!(
        name,
        "value"
            | "expression"
            | "continued_expression"
            | "operand"
            | "continued_operand"
            | "primary_expression"
            | "continued_primary_expression"
            | "application_primary"
    ) {
        let children = cst
            .children(rule_id)?
            .into_iter()
            .filter(|child| matches!(child, Cursor::Rule(_)))
            .collect::<Vec<_>>();
        if children.len() == 1 {
            collect_binder_expression_names(cst, children[0], found)?;
        }
        return Ok(());
    }
    if matches!(name, "postfix_expression" | "continued_postfix_expression") {
        let Some(value) = field(cst, rule_id, "value")? else {
            return Ok(());
        };
        let arguments = field_list(cst, rule_id, "arguments")?;
        if arguments.is_empty() {
            collect_binder_expression_names(cst, value, found)?;
            return Ok(());
        }
        if direct_named_rule(cst, value, "constructor_expression")?.is_none() {
            return Ok(());
        }
        for argument in arguments {
            let Cursor::Rule(argument) = argument else {
                continue;
            };
            if let Some(value) = field(cst, argument, "value")? {
                collect_binder_expression_names(cst, value, found)?;
            }
        }
        return Ok(());
    }
    if name == "parenthesized_or_tuple" {
        if let Some(first) = field(cst, rule_id, "first")? {
            collect_binder_expression_names(cst, first, found)?;
        }
        for rest in field_list(cst, rule_id, "rest")? {
            collect_binder_expression_names(cst, rest, found)?;
        }
        return Ok(());
    }
    if name == "array" {
        for element in field_list(cst, rule_id, "elements")? {
            let Cursor::Rule(element) = element else {
                continue;
            };
            if field(cst, element, "spread")?.is_some() {
                continue;
            }
            if let Some(value) = field(cst, element, "value")? {
                collect_binder_expression_names(cst, value, found)?;
            }
        }
        return Ok(());
    }
    if name == "shape" {
        for member in field_list(cst, rule_id, "members")? {
            let member = if let Cursor::Rule(member_rule) = member
                && cst.rule_name(member_rule)? == "shape_member"
            {
                direct_rule_child(cst, member_rule)?.unwrap_or(member)
            } else {
                member
            };
            let Cursor::Rule(member) = member else {
                continue;
            };
            let rule_name = cst.rule_name(member)?;
            if rule_name != "shape_field" && rule_name != "computed_shape_field" {
                continue;
            }
            if rule_name == "computed_shape_field"
                && let Some(name) = field(cst, member, "name")?
            {
                collect_binder_expression_names(cst, name, found)?;
            }
            if let Some(value) = field(cst, member, "value")? {
                collect_binder_expression_names(cst, value, found)?;
            }
        }
    }
    Ok(())
}

fn direct_named_rule(
    cst: &CompactCst<'_>,
    mut cursor: Cursor,
    name: &str,
) -> Result<Option<u32>, String> {
    loop {
        let Cursor::Rule(rule_id) = cursor else {
            return Ok(None);
        };
        if cst.rule_name(rule_id)? == name {
            return Ok(Some(rule_id));
        }
        let Some(child) = direct_rule_child(cst, rule_id)? else {
            return Ok(None);
        };
        cursor = child;
    }
}

fn direct_rule_child(cst: &CompactCst<'_>, rule_id: u32) -> Result<Option<Cursor>, String> {
    let children = cst
        .children(rule_id)?
        .into_iter()
        .filter(|child| matches!(child, Cursor::Rule(_)))
        .collect::<Vec<_>>();
    Ok((children.len() == 1).then(|| children[0]))
}

fn field(cst: &CompactCst<'_>, rule_id: u32, name: &str) -> Result<Option<Cursor>, String> {
    Ok(cst.field_list(rule_id, name)?.last().copied())
}

fn field_list(cst: &CompactCst<'_>, rule_id: u32, name: &str) -> Result<Vec<Cursor>, String> {
    cst.field_list(rule_id, name)
}

fn token_text(cst: &CompactCst<'_>, mut cursor: Cursor) -> Result<Option<String>, String> {
    loop {
        match cursor {
            Cursor::Token(_) => return cst.text(cursor).map(Some),
            Cursor::Rule(rule_id) => {
                let Some(child) = cst.child(rule_id, 0)? else {
                    return Ok(None);
                };
                cursor = child;
            }
        }
    }
}

fn rule(cursor: Cursor) -> Result<u32, String> {
    match cursor {
        Cursor::Rule(rule) => Ok(rule),
        Cursor::Token(_) => Err("expected a rule".to_owned()),
    }
}
