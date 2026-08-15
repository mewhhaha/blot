use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId, Module, Pattern,
    PatternId, Qualifier, ShapeMember, Span,
};
use crate::diagnostic::Diagnostic;

type BindingRef = Rc<RefCell<Binding>>;
type ScopeRef = Rc<RefCell<Scope>>;

#[derive(Clone, PartialEq)]
enum Produced {
    None,
    Borrow(Box<Produced>),
    Leaf(Qualifier),
    Parameter {
        qualifier: Qualifier,
        source: PatternId,
    },
    Closure {
        captures: Box<Produced>,
        parameter: PatternId,
        result: Box<Produced>,
    },
    Many(Vec<Produced>),
    Sequence(Vec<Produced>),
    Shape(BTreeMap<String, Produced>),
    Variant(Box<Produced>),
    Choice(BTreeMap<String, Produced>),
    Region {
        qualifier: Qualifier,
        root: Option<PatternId>,
        splits: Vec<(Span, u8)>,
    },
    /// The recombination witness a split mints: which two part authorities
    /// rejoin into which parent. Pairing is by produced-value identity, so the
    /// proof travels through bindings and calls like any linear value.
    RegionWitness {
        left: Box<Produced>,
        right: Box<Produced>,
        parent: Box<Produced>,
    },
    /// A join whose components are still symbolic parameters. The obligation
    /// defers to the call site, where substitution makes them concrete.
    PendingJoin {
        witness: Box<Produced>,
        left: Box<Produced>,
        right: Box<Produced>,
    },
    /// A freeze whose region is still a symbolic parameter. The full-root
    /// proof defers to the call site, where substitution makes it concrete.
    PendingFreeze {
        region: Box<Produced>,
    },
}

struct Binding {
    pattern: PatternId,
    name: String,
    qualifier: Qualifier,
    owned: Produced,
    parameter: Option<PatternId>,
    result: Produced,
    value: Option<ExpressionId>,
    moved: Option<Span>,
    partial: bool,
}

struct Scope {
    bindings: BTreeMap<String, BindingRef>,
    parent: Option<ScopeRef>,
    lambda: bool,
    captures: Vec<BindingRef>,
    borrowed_captures: Vec<BindingRef>,
}

#[derive(Clone, Copy)]
enum Use {
    Move,
    Borrow,
    Project,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Obligation {
    None,
    Affine,
    Linear,
}

struct Analysis<'a> {
    module: &'a Module,
    diagnostics: Vec<Diagnostic>,
    function_results: HashMap<ExpressionId, Produced>,
}

pub fn check(module: &Module) -> Vec<Diagnostic> {
    let mut analysis = Analysis {
        module,
        diagnostics: Vec::new(),
        function_results: HashMap::new(),
    };
    let scope = child_scope(None, false);
    if let Some(parameter) = module.parameter {
        declare(parameter, Produced::None, &scope, &mut analysis);
    }
    walk_declarations(&module.declarations, &scope, &mut analysis);
    let result = walk(module.result, &scope, &mut analysis, Use::Move);
    if contains_borrow(&result) {
        analysis.report(
            "BLOT_BORROW_RESULT_ESCAPES",
            "The module result contains a borrowed view.",
            module.arena.expression_span(module.result),
        );
    }
    if obligation(&result) != Obligation::None {
        analysis.report(
            "BLOT_LINEAR_RESULT_ESCAPES",
            "The module result still owns a resource.",
            module.arena.expression_span(module.result),
        );
    }
    close_scope(&scope, &mut analysis);
    analysis.diagnostics
}

impl Analysis<'_> {
    fn report(&mut self, code: &'static str, message: impl Into<String>, span: Span) {
        self.diagnostics
            .push(Diagnostic::new(code, message.into(), span));
    }

    fn lookup(&self, scope: &ScopeRef, name: &str) -> Option<(BindingRef, Option<ScopeRef>)> {
        let mut current = Some(scope.clone());
        let mut captured_by = None;
        while let Some(scope) = current {
            let borrowed = scope.borrow();
            if let Some(binding) = borrowed.bindings.get(name) {
                return Some((binding.clone(), captured_by));
            }
            if borrowed.lambda {
                captured_by = Some(scope.clone());
            }
            current = borrowed.parent.clone();
        }
        None
    }
}

fn child_scope(parent: Option<ScopeRef>, lambda: bool) -> ScopeRef {
    Rc::new(RefCell::new(Scope {
        bindings: BTreeMap::new(),
        parent,
        lambda,
        captures: Vec::new(),
        borrowed_captures: Vec::new(),
    }))
}

fn declare(pattern: PatternId, produced: Produced, scope: &ScopeRef, analysis: &mut Analysis) {
    match &analysis.module.arena.patterns[pattern.0 as usize] {
        Pattern::Name {
            name, qualifier, ..
        } => {
            let written = written_obligation(*qualifier);
            let mut owned = if relevant(&produced) {
                produced
            } else {
                written
            };
            if let Produced::Region { root, .. } = &mut owned
                && root.is_none()
            {
                *root = Some(pattern);
            }
            let qualifier = inherited(*qualifier, &owned);
            scope.borrow_mut().bindings.insert(
                name.clone(),
                Rc::new(RefCell::new(Binding {
                    pattern,
                    name: name.clone(),
                    qualifier,
                    owned,
                    parameter: None,
                    result: Produced::None,
                    value: None,
                    moved: None,
                    partial: false,
                })),
            );
        }
        Pattern::Pin { name, span } => {
            use_name(name, *span, scope, analysis, Use::Project);
        }
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
            let produced_elements = match produced {
                Produced::Sequence(elements) => elements,
                _ => Vec::new(),
            };
            for (index, pattern) in elements.iter().enumerate() {
                let element = produced_elements
                    .get(index)
                    .cloned()
                    .unwrap_or(Produced::None);
                declare(*pattern, element, scope, analysis);
            }
            let discarded = join(produced_elements.into_iter().skip(elements.len()));
            report_discarded(pattern, &discarded, analysis);
        }
        Pattern::Constructor { payload, .. } => {
            if let Some(payload) = payload {
                let payload_value = match produced {
                    Produced::Variant(payload) => *payload,
                    _ => Produced::None,
                };
                declare(*payload, payload_value, scope, analysis);
            } else if let Produced::Variant(payload) = produced {
                report_discarded(pattern, &payload, analysis);
            }
        }
        Pattern::Shape { fields, .. } => {
            let produced_fields = match produced {
                Produced::Shape(fields) => fields,
                _ => BTreeMap::new(),
            };
            let names = fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<HashSet<_>>();
            for field in fields {
                let value = produced_fields
                    .get(&field.name)
                    .cloned()
                    .unwrap_or(Produced::None);
                declare(field.pattern, value, scope, analysis);
            }
            let discarded = join(
                produced_fields
                    .into_iter()
                    .filter(|(name, _)| !names.contains(name.as_str()))
                    .map(|(_, value)| value),
            );
            report_discarded(pattern, &discarded, analysis);
        }
        _ => {}
    }
}

fn report_discarded(pattern: PatternId, produced: &Produced, analysis: &mut Analysis) {
    if obligation(produced) != Obligation::Linear {
        return;
    }
    analysis.report(
        "BLOT_LINEAR_PATTERN_DISCARDS",
        "This pattern discards part of a linear value.",
        pattern_span(analysis.module, pattern),
    );
}

fn use_name(
    name: &str,
    span: Span,
    scope: &ScopeRef,
    analysis: &mut Analysis,
    kind: Use,
) -> Produced {
    let Some((binding, captured_by)) = analysis.lookup(scope, name) else {
        return Produced::None;
    };
    let qualifier = binding.borrow().qualifier;
    if qualifier == Qualifier::Borrow && matches!(kind, Use::Move) {
        analysis.report(
            "BLOT_BORROW_MOVED",
            format!("`{name}` is borrowed and cannot be moved."),
            span,
        );
        return Produced::None;
    }
    if let Some(captured_by) = captured_by {
        if qualifier == Qualifier::Borrow || matches!(kind, Use::Borrow) {
            push_unique(&mut captured_by.borrow_mut().borrowed_captures, &binding);
            install_capture(&captured_by, &binding, Qualifier::Borrow);
            return use_name(name, span, scope, analysis, kind);
        }
        if spendable(qualifier) {
            push_unique(&mut captured_by.borrow_mut().captures, &binding);
            install_capture(&captured_by, &binding, qualifier);
            return use_name(name, span, scope, analysis, kind);
        }
    }
    if matches!(kind, Use::Borrow) || qualifier == Qualifier::Borrow {
        return Produced::Borrow(Box::new(binding.borrow().owned.clone()));
    }
    if spendable(qualifier) {
        if binding.borrow().partial {
            analysis.report(
                "BLOT_LINEAR_PARTIAL_REUSE",
                format!("`{name}` has a moved field and cannot be used as a whole value."),
                span,
            );
            consume(&binding, span, analysis);
            return Produced::None;
        }
        consume(&binding, span, analysis);
        return binding.borrow().owned.clone();
    }
    Produced::None
}

fn install_capture(scope: &ScopeRef, source: &BindingRef, qualifier: Qualifier) {
    let source = source.borrow();
    scope.borrow_mut().bindings.insert(
        source.name.clone(),
        Rc::new(RefCell::new(Binding {
            pattern: source.pattern,
            name: source.name.clone(),
            qualifier,
            owned: source.owned.clone(),
            parameter: source.parameter,
            result: source.result.clone(),
            value: source.value,
            moved: None,
            partial: source.partial,
        })),
    );
}

fn push_unique(bindings: &mut Vec<BindingRef>, binding: &BindingRef) {
    if !bindings
        .iter()
        .any(|candidate| Rc::ptr_eq(candidate, binding))
    {
        bindings.push(binding.clone());
    }
}

fn consume(binding: &BindingRef, span: Span, analysis: &mut Analysis) {
    let mut binding = binding.borrow_mut();
    if binding.moved.is_some() {
        analysis.report(
            "BLOT_LINEAR_CONSUMED_TWICE",
            format!("`{}` was already consumed.", binding.name),
            span,
        );
        return;
    }
    binding.moved = Some(span);
}

fn walk_declarations(declarations: &[DeclarationId], scope: &ScopeRef, analysis: &mut Analysis) {
    let mut index = 0;
    while index < declarations.len() {
        if recursive_declaration(analysis.module, declarations[index]) {
            let start = index;
            while index < declarations.len() {
                if recursive_declaration(analysis.module, declarations[index]) {
                    index += 1;
                    continue;
                }
                if signature_declaration(analysis.module, declarations[index])
                    && index + 1 < declarations.len()
                    && recursive_declaration(analysis.module, declarations[index + 1])
                {
                    index += 1;
                    continue;
                }
                break;
            }
            walk_recursive_group(&declarations[start..index], scope, analysis);
            continue;
        }
        walk_declaration(declarations[index], scope, analysis);
        index += 1;
    }
}

fn walk_declaration(declaration_id: DeclarationId, scope: &ScopeRef, analysis: &mut Analysis) {
    let declaration = analysis.module.arena.declarations[declaration_id.0 as usize].clone();
    match declaration {
        Declaration::Binding {
            kind: DeclarationKind::Sig,
            ..
        } => {}
        Declaration::Binding {
            pattern,
            value,
            span,
            ..
        } => {
            let produced = walk(value, scope, analysis, Use::Move);
            if contains_borrow(&produced) {
                analysis.report(
                    "BLOT_BORROW_STORED",
                    "This declaration stores a borrowed view.",
                    span,
                );
            }
            declare(pattern, produced.clone(), scope, analysis);
            if let Pattern::Name { name, .. } = &analysis.module.arena.patterns[pattern.0 as usize]
                && let Some(binding) = scope.borrow().bindings.get(name).cloned()
            {
                let (parameter, result) = function_contract(value, &produced, scope, analysis);
                let mut binding = binding.borrow_mut();
                binding.parameter = parameter;
                binding.result = result;
                binding.value = Some(value);
            }
        }
        Declaration::Shadow { value, span, .. } | Declaration::Open { value, span, .. } => {
            let produced = walk(value, scope, analysis, Use::Move);
            if contains_borrow(&produced) {
                analysis.report(
                    "BLOT_BORROW_STORED",
                    "This declaration stores a borrowed view.",
                    span,
                );
            }
            if obligation(&produced) != Obligation::None {
                analysis.report(
                    "BLOT_LINEAR_CLOSURE_ESCAPES",
                    "This declaration form cannot retain an owned value.",
                    span,
                );
            }
        }
    }
}

fn walk_recursive_group(declarations: &[DeclarationId], scope: &ScopeRef, analysis: &mut Analysis) {
    let mut members = Vec::new();
    for declaration_id in declarations {
        let Declaration::Binding {
            pattern,
            value,
            span,
            ..
        } = analysis.module.arena.declarations[declaration_id.0 as usize].clone()
        else {
            continue;
        };
        let Pattern::Name {
            name, qualifier, ..
        } = &analysis.module.arena.patterns[pattern.0 as usize]
        else {
            continue;
        };
        let Expression::Rec { lambda, .. } = analysis.module.arena.expressions[value.0 as usize]
        else {
            continue;
        };
        members.push((name.clone(), *qualifier, pattern, value, lambda, span));
    }
    for (name, qualifier, pattern, value, lambda, _) in &members {
        let parameter = match analysis.module.arena.expressions[lambda.0 as usize] {
            Expression::Lambda { parameter, .. } => Some(parameter),
            _ => None,
        };
        scope.borrow_mut().bindings.insert(
            name.clone(),
            Rc::new(RefCell::new(Binding {
                pattern: *pattern,
                name: name.clone(),
                qualifier: *qualifier,
                owned: written_obligation(*qualifier),
                parameter,
                result: Produced::None,
                value: Some(*value),
                moved: None,
                partial: false,
            })),
        );
    }
    let names = members
        .iter()
        .map(|(name, ..)| name.clone())
        .collect::<HashSet<_>>();
    let mut captures = HashSet::new();
    for (_, _, _, _, lambda, _) in &members {
        for name in free_names(*lambda, analysis.module) {
            if names.contains(&name) {
                continue;
            }
            if let Some((binding, _)) = analysis.lookup(scope, &name)
                && spendable(binding.borrow().qualifier)
            {
                captures.insert(name);
            }
        }
    }
    if !captures.is_empty()
        && members.iter().any(|(_, _, _, _, lambda, _)| {
            let Expression::Lambda { body, .. } =
                analysis.module.arena.expressions[lambda.0 as usize]
            else {
                return true;
            };
            !recursive_calls_are_tail(body, &names, true, analysis.module)
        })
    {
        analysis.report(
            "BLOT_RECURSIVE_OWNERSHIP_UNPROVED",
            "A recursive ownership transfer is not in tail position.",
            members[0].5,
        );
        return;
    }
    // A tail call is not by itself a transfer. The capture is consumed once
    // here, on behalf of every iteration, so a body that spends it and then
    // recurses spends it again on the next entry. Only a path that ends the
    // recursion may spend it; a path that continues must hand it to the call.
    if !captures.is_empty()
        && members.iter().any(|(_, _, _, _, lambda, _)| {
            let Expression::Lambda { body, .. } =
                analysis.module.arena.expressions[lambda.0 as usize]
            else {
                return true;
            };
            recursion_spends_a_capture(body, &names, &captures, analysis.module)
        })
    {
        // The same code the checker reports for two written consumptions: this
        // is that program, with the repetition supplied by the recursion.
        analysis.report(
            "BLOT_LINEAR_CONSUMED_TWICE",
            "A recursive body spends a captured resource on a path that recurses, so every iteration after the first spends it again. Pass it to the recursive call instead, or spend it only where the recursion ends.",
            members[0].5,
        );
        return;
    }
    if captures.is_empty() {
        for (_, _, pattern, value, _, _) in members {
            let produced = walk(value, scope, analysis, Use::Move);
            if let Pattern::Name { name, .. } = &analysis.module.arena.patterns[pattern.0 as usize]
                && let Some(binding) = scope.borrow().bindings.get(name).cloned()
            {
                let (parameter, result) = function_contract(value, &produced, scope, analysis);
                let mut binding = binding.borrow_mut();
                binding.qualifier = inherited(binding.qualifier, &produced);
                binding.owned = produced;
                binding.parameter = parameter;
                binding.result = result;
            }
        }
        return;
    }

    let shared = members
        .first()
        .and_then(|(name, ..)| scope.borrow().bindings.get(name).cloned())
        .expect("recursive group binding disappeared");
    {
        let mut shared = shared.borrow_mut();
        shared.qualifier = Qualifier::Linear;
        shared.owned = Produced::Leaf(Qualifier::Linear);
    }
    for (name, ..) in &members {
        scope
            .borrow_mut()
            .bindings
            .insert(name.clone(), shared.clone());
    }
    for capture in captures {
        if let Some((binding, _)) = analysis.lookup(scope, &capture) {
            consume(&binding, members[0].5, analysis);
        }
    }
}

fn walk(
    expression: ExpressionId,
    scope: &ScopeRef,
    analysis: &mut Analysis,
    kind: Use,
) -> Produced {
    let expression_node = analysis.module.arena.expressions[expression.0 as usize].clone();
    match expression_node {
        Expression::Var { name, span } => use_name(&name, span, scope, analysis, kind),
        Expression::Apply {
            function,
            argument,
            span,
        } => walk_apply(expression, function, argument, span, scope, analysis),
        Expression::Field { target, name, span } => {
            if let Some(projected) = project_owned_path(expression, scope, analysis, kind) {
                return projected;
            }
            let target = walk(target, scope, analysis, Use::Project);
            let target = match target {
                Produced::Borrow(inner) => {
                    let selected = select_field(*inner, &name, span, analysis);
                    return Produced::Borrow(Box::new(selected));
                }
                target => target,
            };
            select_field(target, &name, span, analysis)
        }
        Expression::Lambda {
            parameter,
            body,
            span,
            ..
        } => {
            let inner = child_scope(Some(scope.clone()), true);
            declare(
                parameter,
                written_pattern(parameter, analysis.module),
                &inner,
                analysis,
            );
            let result = walk(body, &inner, analysis, Use::Move);
            if contains_borrow(&result) {
                analysis.report(
                    "BLOT_BORROW_RESULT_ESCAPES",
                    "This function returns a borrowed view.",
                    analysis.module.arena.expression_span(body),
                );
            }
            analysis.function_results.insert(expression, result.clone());
            close_scope(&inner, analysis);
            let captures = inner.borrow().captures.clone();
            let borrowed_captures = inner.borrow().borrowed_captures.clone();
            let mut produced = Produced::None;
            for captured in captures {
                consume(&captured, span, analysis);
                produced = combine(produced, captured.borrow().owned.clone());
            }
            for captured in borrowed_captures {
                produced = combine(
                    produced,
                    Produced::Borrow(Box::new(captured.borrow().owned.clone())),
                );
            }
            if relevant(&produced) {
                Produced::Closure {
                    captures: Box::new(produced),
                    parameter,
                    result: Box::new(result),
                }
            } else {
                Produced::None
            }
        }
        Expression::Rec { lambda, .. } => walk(lambda, scope, analysis, kind),
        Expression::Comptime { body, .. } => walk(body, scope, analysis, kind),
        Expression::Tuple { elements, .. } => Produced::Sequence(
            elements
                .into_iter()
                .map(|element| walk(element, scope, analysis, Use::Move))
                .collect(),
        ),
        Expression::Array { elements, span } => {
            let spread = elements.iter().any(|element| element.spread);
            let produced = Produced::Sequence(
                elements
                    .into_iter()
                    .map(|element| walk(element.value, scope, analysis, Use::Move))
                    .collect(),
            );
            if spread && obligation(&produced) != Obligation::None {
                analysis.report(
                    "BLOT_LINEAR_ARRAY_SPREAD",
                    "An array spread makes owned positions unknown.",
                    span,
                );
            }
            produced
        }
        Expression::Shape { members, span } => {
            let mut fields = BTreeMap::new();
            let mut spread = Produced::None;
            let has_spread = members
                .iter()
                .any(|member| matches!(member, ShapeMember::Spread { .. }));
            for member in members {
                match member {
                    ShapeMember::Field { name, value } => {
                        fields.insert(name, walk(value, scope, analysis, Use::Move));
                    }
                    ShapeMember::Spread { value } => {
                        spread = combine(spread, walk(value, scope, analysis, Use::Move));
                    }
                }
            }
            let shape = Produced::Shape(fields);
            if has_spread && obligation(&combine(spread.clone(), shape.clone())) != Obligation::None
            {
                analysis.report(
                    "BLOT_LINEAR_SHAPE_SPREAD",
                    "A record spread makes owned field provenance ambiguous.",
                    span,
                );
            }
            combine(spread, shape)
        }
        Expression::If {
            branches,
            fallback,
            span,
        } => {
            for branch in &branches {
                walk(branch.condition, scope, analysis, Use::Project);
            }
            let before = snapshot(scope);
            let mut outcomes = Vec::new();
            let mut produced = Vec::new();
            for branch in branches {
                restore(&before);
                produced.push(walk(branch.consequence, scope, analysis, kind));
                outcomes.push(snapshot(scope));
            }
            if let Some(fallback) = fallback {
                restore(&before);
                produced.push(walk(fallback, scope, analysis, kind));
                outcomes.push(snapshot(scope));
            }
            agree(&outcomes, &before, span, analysis);
            join(produced)
        }
        Expression::Case { target, arms, span } => {
            let target = walk(target, scope, analysis, Use::Project);
            let before = snapshot(scope);
            let mut outcomes = Vec::new();
            let mut produced = Vec::new();
            for arm in arms {
                restore(&before);
                let inner = child_scope(Some(scope.clone()), false);
                if contains_borrow(&target) && pattern_binds(arm.pattern, analysis.module) {
                    analysis.report(
                        "BLOT_BORROW_STORED",
                        "This pattern stores part of a borrowed view.",
                        pattern_span(analysis.module, arm.pattern),
                    );
                }
                let arm_target = choice_for_pattern(&target, arm.pattern, analysis.module);
                declare(arm.pattern, arm_target, &inner, analysis);
                produced.push(walk(arm.body, &inner, analysis, kind));
                close_scope(&inner, analysis);
                outcomes.push(snapshot(scope));
            }
            agree(&outcomes, &before, span, analysis);
            join(produced)
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            let inner = child_scope(Some(scope.clone()), false);
            walk_declarations(&declarations, &inner, analysis);
            let result = walk(result, &inner, analysis, kind);
            close_scope(&inner, analysis);
            result
        }
        _ => Produced::None,
    }
}

fn project_owned_path(
    expression: ExpressionId,
    scope: &ScopeRef,
    analysis: &mut Analysis,
    kind: Use,
) -> Option<Produced> {
    let mut current = expression;
    let mut path = Vec::new();
    let span = analysis.module.arena.expression_span(expression);
    loop {
        match &analysis.module.arena.expressions[current.0 as usize] {
            Expression::Field { target, name, .. } => {
                path.push(name.clone());
                current = *target;
            }
            Expression::Var { name, .. } => {
                path.reverse();
                let (binding, captured_by) = analysis.lookup(scope, name)?;
                if captured_by.is_some() || !spendable(binding.borrow().qualifier) {
                    return None;
                }
                if binding.borrow().moved.is_some() {
                    consume(&binding, span, analysis);
                    return Some(Produced::None);
                }
                let projected = remove_owned_path(&binding.borrow().owned, &path)?;
                if matches!(kind, Use::Borrow) {
                    return Some(Produced::Borrow(Box::new(projected.0)));
                }
                if !relevant(&projected.0) {
                    return Some(projected.0);
                }
                {
                    let mut binding = binding.borrow_mut();
                    binding.owned = projected.1;
                    binding.partial = true;
                }
                if !relevant(&binding.borrow().owned) {
                    consume(&binding, span, analysis);
                }
                return Some(projected.0);
            }
            _ => return None,
        }
    }
}

fn remove_owned_path(produced: &Produced, path: &[String]) -> Option<(Produced, Produced)> {
    let Produced::Shape(fields) = produced else {
        return None;
    };
    let (name, rest) = path.split_first()?;
    let selected = fields.get(name)?.clone();
    let mut remaining = fields.clone();
    if rest.is_empty() {
        remaining.insert(name.clone(), Produced::None);
        return Some((selected, Produced::Shape(remaining)));
    }
    let (selected, nested) = remove_owned_path(&selected, rest)?;
    remaining.insert(name.clone(), nested);
    Some((selected, Produced::Shape(remaining)))
}

fn ownership_primitive_name<'a>(
    analysis: &'a Analysis<'_>,
    scope: &ScopeRef,
    callee: ExpressionId,
) -> Option<&'a str> {
    match &analysis.module.arena.expressions[callee.0 as usize] {
        Expression::Intrinsic { name, .. } => Some(name.as_str()),
        Expression::Field { target, name, .. }
            if analysis.lookup(scope, "Slice").is_none()
                && matches!(
                    &analysis.module.arena.expressions[target.0 as usize],
                    Expression::Var { name: namespace, .. } if namespace == "Slice"
                ) =>
        {
            match name.as_str() {
                "claim" => Some("@region.claim"),
                "length" => Some("@region.length"),
                "get" => Some("@region.get"),
                "set" => Some("@region.set"),
                "swap" => Some("@region.swap"),
                "split" => Some("@region.split"),
                "join" => Some("@region.join"),
                "freeze" => Some("@region.freeze"),
                _ => None,
            }
        }
        _ => None,
    }
}

fn ownership_primitive_arguments(
    analysis: &Analysis<'_>,
    callee: ExpressionId,
    arguments: &[ExpressionId],
    name: Option<&str>,
) -> Vec<ExpressionId> {
    let Some(name) = name else {
        return arguments.to_vec();
    };
    let Expression::Field { target, .. } = &analysis.module.arena.expressions[callee.0 as usize]
    else {
        return arguments.to_vec();
    };
    if !matches!(
        &analysis.module.arena.expressions[target.0 as usize],
        Expression::Var { name, .. } if name == "Slice"
    ) {
        return arguments.to_vec();
    }
    let arity = match name {
        "@region.get" | "@region.split" => 2,
        "@region.set" | "@region.swap" | "@region.join" => 3,
        _ => 1,
    };
    if arity == 1 || arguments.len() != 1 {
        return arguments.to_vec();
    }
    match &analysis.module.arena.expressions[arguments[0].0 as usize] {
        Expression::Tuple { elements, .. } if elements.len() == arity => elements.clone(),
        _ => arguments.to_vec(),
    }
}

fn walk_apply(
    expression: ExpressionId,
    function: ExpressionId,
    argument: ExpressionId,
    span: Span,
    scope: &ScopeRef,
    analysis: &mut Analysis,
) -> Produced {
    if let Expression::Intrinsic { name, .. } =
        &analysis.module.arena.expressions[function.0 as usize]
    {
        if name == "@linear.borrow" {
            return walk(argument, scope, analysis, Use::Borrow);
        }
        if name == "@linear.own" {
            return walk(argument, scope, analysis, Use::Move);
        }
    }
    if matches!(
        analysis.module.arena.expressions[function.0 as usize],
        Expression::Tag { .. }
    ) {
        return Produced::Variant(Box::new(walk(argument, scope, analysis, Use::Move)));
    }
    let (callee, arguments) = application_spine(expression, analysis.module);
    let ownership_primitive = ownership_primitive_name(analysis, scope, callee);
    let ownership_arguments =
        ownership_primitive_arguments(analysis, callee, &arguments, ownership_primitive);
    if let Some(name) = ownership_primitive {
        let arguments = &ownership_arguments;
        let handle_arguments = if name == "@handle" && arguments.len() == 1 {
            match &analysis.module.arena.expressions[arguments[0].0 as usize] {
                Expression::Tuple { elements, .. }
                    if elements.len() == 2 || elements.len() == 3 =>
                {
                    elements.clone()
                }
                _ => Vec::new(),
            }
        } else {
            arguments.clone()
        };
        if name == "@handle" && (handle_arguments.len() == 2 || handle_arguments.len() == 3) {
            let computation_index = 1;
            let computation = walk(
                handle_arguments[computation_index],
                scope,
                analysis,
                Use::Move,
            );
            if handle_arguments.len() == 3 {
                require_continuation_ownership(
                    handle_arguments[2],
                    obligation(&computation),
                    scope,
                    analysis,
                );
            }
            walk(handle_arguments[0], scope, analysis, Use::Move);
            if handle_arguments.len() == 3 {
                walk(handle_arguments[2], scope, analysis, Use::Move);
            }
            return Produced::None;
        }
        if name == "@region.claim" && arguments.len() == 1 {
            let source = walk(arguments[0], scope, analysis, Use::Project);
            // A linear array binding is claimable: the claim consumes the
            // whole array, which is what proves its Store reusable. Only
            // elements that carry their own obligations are refused, because
            // the acquisition copy would duplicate them.
            let owned_elements = match &source {
                Produced::Leaf(_) | Produced::Parameter { .. } => false,
                produced => obligation(produced) != Obligation::None,
            };
            if owned_elements {
                analysis.report(
                    "BLOT_REGION_OWNED_ELEMENT",
                    "The first Region implementation copies its input, so arrays containing owned elements cannot be claimed yet.",
                    analysis.module.arena.expression_span(arguments[0]),
                );
            }
            return Produced::Region {
                qualifier: Qualifier::Linear,
                root: None,
                splits: Vec::new(),
            };
        }
        if name == "@region.length" && arguments.len() == 1 {
            walk(arguments[0], scope, analysis, Use::Borrow);
            return Produced::None;
        }
        if name == "@region.get" && arguments.len() == 2 {
            walk(arguments[0], scope, analysis, Use::Borrow);
            walk(arguments[1], scope, analysis, Use::Move);
            return Produced::None;
        }
        if name == "@region.set" && arguments.len() == 3 {
            let region = region_authority(walk(arguments[0], scope, analysis, Use::Move));
            walk(arguments[1], scope, analysis, Use::Move);
            let replacement = walk(arguments[2], scope, analysis, Use::Move);
            if obligation(&replacement) != Obligation::None {
                analysis.report(
                    "BLOT_REGION_OWNED_ELEMENT",
                    "Region replacement cannot move an owned element in the first implementation.",
                    analysis.module.arena.expression_span(arguments[2]),
                );
            }
            return Produced::Choice(BTreeMap::from([
                (
                    "Updated".to_owned(),
                    Produced::Variant(Box::new(region.clone())),
                ),
                (
                    "SetOutOfBounds".to_owned(),
                    Produced::Variant(Box::new(region)),
                ),
            ]));
        }
        if name == "@region.swap" && arguments.len() == 3 {
            let region = region_authority(walk(arguments[0], scope, analysis, Use::Move));
            walk(arguments[1], scope, analysis, Use::Move);
            walk(arguments[2], scope, analysis, Use::Move);
            return Produced::Choice(BTreeMap::from([
                (
                    "Updated".to_owned(),
                    Produced::Variant(Box::new(region.clone())),
                ),
                (
                    "SwapOutOfBounds".to_owned(),
                    Produced::Variant(Box::new(region)),
                ),
            ]));
        }
        if name == "@region.split" && arguments.len() == 2 {
            let region = region_authority(walk(arguments[0], scope, analysis, Use::Move));
            walk(arguments[1], scope, analysis, Use::Move);
            let (qualifier, root, splits) = match region.clone() {
                Produced::Region {
                    qualifier,
                    root,
                    splits,
                } => (qualifier, root, splits),
                _ => {
                    analysis.report(
                        "BLOT_REGION_SPLIT_NOT_OWNED",
                        "Region split requires one owned Region authority.",
                        analysis.module.arena.expression_span(arguments[0]),
                    );
                    return Produced::None;
                }
            };
            let mut left_splits = splits.clone();
            left_splits.push((span, 0));
            let mut right_splits = splits;
            right_splits.push((span, 1));
            let left = Produced::Region {
                qualifier,
                root,
                splits: left_splits,
            };
            let right = Produced::Region {
                qualifier,
                root,
                splits: right_splits,
            };
            // The witness is the recombination proof as a value: it records
            // which two part authorities rejoin into which parent.
            let witness = Produced::RegionWitness {
                left: Box::new(left.clone()),
                right: Box::new(right.clone()),
                parent: Box::new(region.clone()),
            };
            return Produced::Choice(BTreeMap::from([
                (
                    "Split".to_owned(),
                    Produced::Variant(Box::new(Produced::Sequence(vec![left, right, witness]))),
                ),
                (
                    "SplitOutOfBounds".to_owned(),
                    Produced::Variant(Box::new(region)),
                ),
            ]));
        }
        if name == "@region.join" && arguments.len() == 3 {
            let witness = walk(arguments[0], scope, analysis, Use::Move);
            let left = walk(arguments[1], scope, analysis, Use::Move);
            let right = walk(arguments[2], scope, analysis, Use::Move);
            return join_region(witness, left, right, span, analysis);
        }
        if name == "@region.freeze" && arguments.len() == 1 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            // A symbolic authority defers the full-root proof to the call
            // site, where substitution makes the caller's region concrete.
            if symbolic_authority(&region) {
                return Produced::PendingFreeze {
                    region: Box::new(region),
                };
            }
            match region {
                Produced::Region { splits, .. } if splits.is_empty() => {}
                _ => analysis.report(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region authority can be frozen. Rejoin every split first.",
                    analysis.module.arena.expression_span(arguments[0]),
                ),
            }
            return Produced::None;
        }
        if name == "@array.get" && arguments.len() == 2 {
            let array = walk(arguments[0], scope, analysis, Use::Project);
            walk(arguments[1], scope, analysis, Use::Move);
            if obligation(&array) != Obligation::None {
                analysis.report(
                    "BLOT_LINEAR_ARRAY_READ",
                    "Reading an array element would copy an owned value.",
                    span,
                );
            }
            return Produced::None;
        }
        if name == "@array.push" && arguments.len() == 2 {
            let array = walk(arguments[0], scope, analysis, Use::Move);
            let value = walk(arguments[1], scope, analysis, Use::Move);
            if let Produced::Sequence(mut elements) = array {
                elements.push(value);
                return Produced::Sequence(elements);
            }
            return combine(array, value);
        }
    }
    let cancels_continuation = matches!(
        &analysis.module.arena.expressions[callee.0 as usize],
        Expression::Intrinsic { name, .. } if name == "@continuation.cancel"
    ) || matches!(
        &analysis.module.arena.expressions[callee.0 as usize],
        Expression::Field { target, name, .. }
            if name == "cancel"
                && matches!(
                    &analysis.module.arena.expressions[target.0 as usize],
                    Expression::Var { name, .. } if name == "Continuation"
                )
    );
    if cancels_continuation && arguments.len() == 1 {
        walk(arguments[0], scope, analysis, Use::Move);
        return Produced::None;
    }

    let callee = walk(function, scope, analysis, Use::Project);
    let argument_value = walk(argument, scope, analysis, Use::Move);
    let (parameter, result) = function_contract(function, &callee, scope, analysis);
    if contains_borrow(&argument_value)
        && !parameter_accepts_borrow(parameter, &argument_value, analysis.module)
        && !trusted_borrow_operation(function, analysis.module)
    {
        analysis.report(
            "BLOT_BORROW_ARGUMENT_ESCAPES",
            "The called function does not promise to borrow this argument.",
            analysis.module.arena.expression_span(argument),
        );
    }
    if obligation(&argument_value) != Obligation::None
        && !parameter_accepts_ownership(parameter, &argument_value, analysis.module)
        && !trusted_scalar_operation(function, analysis.module)
    {
        analysis.report(
            "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
            "The called function does not promise to consume this owned argument.",
            analysis.module.arena.expression_span(argument),
        );
    }
    let result = substitute_parameters(result, parameter, &argument_value, analysis.module);
    resolve_pending(result, span, analysis)
}

fn function_contract(
    expression: ExpressionId,
    produced: &Produced,
    scope: &ScopeRef,
    analysis: &Analysis,
) -> (Option<PatternId>, Produced) {
    if let Produced::Closure {
        parameter, result, ..
    } = produced
    {
        return (Some(*parameter), (**result).clone());
    }
    match analysis.module.arena.expressions[expression.0 as usize] {
        Expression::Lambda { parameter, .. } => (
            Some(parameter),
            analysis
                .function_results
                .get(&expression)
                .cloned()
                .unwrap_or(Produced::None),
        ),
        Expression::Rec { lambda, .. } => {
            match analysis.module.arena.expressions[lambda.0 as usize] {
                Expression::Lambda { parameter, .. } => (
                    Some(parameter),
                    analysis
                        .function_results
                        .get(&lambda)
                        .cloned()
                        .unwrap_or(Produced::None),
                ),
                _ => (None, Produced::None),
            }
        }
        Expression::Var { ref name, .. } => analysis
            .lookup(scope, name)
            .map(|(binding, _)| {
                let binding = binding.borrow();
                (binding.parameter, binding.result.clone())
            })
            .unwrap_or((None, Produced::None)),
        _ => (None, Produced::None),
    }
}

fn substitute_parameters(
    produced: Produced,
    parameter: Option<PatternId>,
    argument: &Produced,
    module: &Module,
) -> Produced {
    let Some(parameter) = parameter else {
        return produced;
    };
    match (&module.arena.patterns[parameter.0 as usize], argument) {
        (Pattern::Name { .. }, _) => substitute_parameter_source(produced, parameter, argument),
        (
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. },
            Produced::Sequence(values),
        ) => elements
            .iter()
            .zip(values)
            .fold(produced, |current, (pattern, value)| {
                substitute_parameters(current, Some(*pattern), value, module)
            }),
        (
            Pattern::Constructor {
                payload: Some(payload),
                ..
            },
            Produced::Variant(value),
        ) => substitute_parameters(produced, Some(*payload), value, module),
        (Pattern::Shape { fields, .. }, Produced::Shape(values)) => {
            fields.iter().fold(produced, |current, field| {
                values.get(&field.name).map_or(current.clone(), |value| {
                    substitute_parameters(current, Some(field.pattern), value, module)
                })
            })
        }
        _ => produced,
    }
}

fn substitute_parameter_source(
    produced: Produced,
    source: PatternId,
    argument: &Produced,
) -> Produced {
    match produced {
        Produced::None => Produced::None,
        Produced::Borrow(value) => Produced::Borrow(Box::new(substitute_parameter_source(
            *value, source, argument,
        ))),
        Produced::Leaf(qualifier) => Produced::Leaf(qualifier),
        Produced::Parameter {
            qualifier,
            source: found,
        } => {
            if found == source {
                argument.clone()
            } else {
                Produced::Parameter {
                    qualifier,
                    source: found,
                }
            }
        }
        Produced::Closure {
            captures,
            parameter,
            result,
        } => Produced::Closure {
            captures: Box::new(substitute_parameter_source(*captures, source, argument)),
            parameter,
            result: Box::new(substitute_parameter_source(*result, source, argument)),
        },
        Produced::Many(values) => join(
            values
                .into_iter()
                .map(|value| substitute_parameter_source(value, source, argument)),
        ),
        Produced::Sequence(values) => Produced::Sequence(
            values
                .into_iter()
                .map(|value| substitute_parameter_source(value, source, argument))
                .collect(),
        ),
        Produced::Shape(fields) => Produced::Shape(
            fields
                .into_iter()
                .map(|(name, value)| (name, substitute_parameter_source(value, source, argument)))
                .collect(),
        ),
        Produced::Variant(payload) => Produced::Variant(Box::new(substitute_parameter_source(
            *payload, source, argument,
        ))),
        Produced::Choice(cases) => Produced::Choice(
            cases
                .into_iter()
                .map(|(name, value)| (name, substitute_parameter_source(value, source, argument)))
                .collect(),
        ),
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => Produced::RegionWitness {
            left: Box::new(substitute_parameter_source(*left, source, argument)),
            right: Box::new(substitute_parameter_source(*right, source, argument)),
            parent: Box::new(substitute_parameter_source(*parent, source, argument)),
        },
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => Produced::PendingJoin {
            witness: Box::new(substitute_parameter_source(*witness, source, argument)),
            left: Box::new(substitute_parameter_source(*left, source, argument)),
            right: Box::new(substitute_parameter_source(*right, source, argument)),
        },
        Produced::PendingFreeze { region } => Produced::PendingFreeze {
            region: Box::new(substitute_parameter_source(*region, source, argument)),
        },
        Produced::Region {
            qualifier,
            root,
            splits,
        } => {
            if root != Some(source) {
                return Produced::Region {
                    qualifier,
                    root,
                    splits,
                };
            }
            match argument {
                Produced::Region {
                    root: argument_root,
                    splits: argument_splits,
                    ..
                } => {
                    let mut composed = argument_splits.clone();
                    composed.extend(splits);
                    Produced::Region {
                        qualifier,
                        root: *argument_root,
                        splits: composed,
                    }
                }
                Produced::Parameter {
                    source: argument_source,
                    ..
                } => Produced::Region {
                    qualifier,
                    root: Some(*argument_source),
                    splits,
                },
                _ => Produced::Region {
                    qualifier,
                    root,
                    splits,
                },
            }
        }
    }
}

fn require_continuation_ownership(
    handler: ExpressionId,
    computation: Obligation,
    scope: &ScopeRef,
    analysis: &mut Analysis,
) {
    if computation != Obligation::Linear {
        return;
    }
    let handler = static_expression(handler, scope, analysis);
    let Expression::Shape { members, .. } =
        analysis.module.arena.expressions[handler.0 as usize].clone()
    else {
        analysis.report(
            "BLOT_LINEAR_HANDLER_UNKNOWN",
            "A linear computation needs a statically known handler.",
            analysis.module.arena.expression_span(handler),
        );
        return;
    };
    for member in members {
        let ShapeMember::Field { name, value } = member else {
            continue;
        };
        if name == "return" {
            continue;
        }
        let Expression::Lambda { parameter, .. } =
            analysis.module.arena.expressions[value.0 as usize]
        else {
            continue;
        };
        let Pattern::Tuple { elements, .. } = &analysis.module.arena.patterns[parameter.0 as usize]
        else {
            continue;
        };
        let linear_resume = elements.get(1).is_some_and(|resume| {
            matches!(
                analysis.module.arena.patterns[resume.0 as usize],
                Pattern::Name {
                    qualifier: Qualifier::Linear,
                    ..
                }
            )
        });
        if !linear_resume {
            analysis.report(
                "BLOT_LINEAR_HANDLER_MAY_ABORT",
                format!("Handler clause `.{name}` may abort a linear continuation."),
                analysis.module.arena.expression_span(value),
            );
        }
    }
}

fn static_expression(
    expression: ExpressionId,
    scope: &ScopeRef,
    analysis: &Analysis,
) -> ExpressionId {
    let Expression::Var { ref name, .. } = analysis.module.arena.expressions[expression.0 as usize]
    else {
        return expression;
    };
    analysis
        .lookup(scope, name)
        .and_then(|(binding, _)| binding.borrow().value)
        .unwrap_or(expression)
}

fn select_field(target: Produced, name: &str, span: Span, analysis: &mut Analysis) -> Produced {
    let Produced::Shape(mut fields) = target else {
        return target;
    };
    let selected = fields.remove(name).unwrap_or(Produced::None);
    if obligation(&join(fields.into_values())) == Obligation::Linear {
        analysis.report(
            "BLOT_LINEAR_PARTIAL_MOVE",
            format!("Projecting `.{name}` discards another owned field."),
            span,
        );
    }
    selected
}

fn close_scope(scope: &ScopeRef, analysis: &mut Analysis) {
    let bindings = scope
        .borrow()
        .bindings
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    for binding in bindings {
        let address = Rc::as_ptr(&binding) as usize;
        if !seen.insert(address) {
            continue;
        }
        let binding = binding.borrow();
        if binding.qualifier != Qualifier::Linear || binding.moved.is_some() {
            continue;
        }
        analysis.report(
            "BLOT_LINEAR_NOT_CONSUMED",
            format!("`{}` is linear and is never consumed.", binding.name),
            pattern_span(analysis.module, binding.pattern),
        );
    }
}

type Snapshot = Vec<(BindingRef, Option<Span>, Produced, bool)>;

fn snapshot(scope: &ScopeRef) -> Snapshot {
    let mut snapshot = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(scope.clone());
    while let Some(scope) = current {
        let scope = scope.borrow();
        for binding in scope.bindings.values() {
            let address = Rc::as_ptr(binding) as usize;
            if seen.insert(address) && spendable(binding.borrow().qualifier) {
                let binding_state = binding.borrow();
                snapshot.push((
                    binding.clone(),
                    binding_state.moved,
                    binding_state.owned.clone(),
                    binding_state.partial,
                ));
            }
        }
        current = scope.parent.clone();
    }
    snapshot
}

fn restore(snapshot: &Snapshot) {
    for (binding, moved, owned, partial) in snapshot {
        let mut binding = binding.borrow_mut();
        binding.moved = *moved;
        binding.owned = owned.clone();
        binding.partial = *partial;
    }
}

fn agree(outcomes: &[Snapshot], before: &Snapshot, span: Span, analysis: &mut Analysis) {
    if outcomes.is_empty() {
        return;
    }
    for (binding, _, prior_owned, prior_partial) in before {
        let states = outcomes
            .iter()
            .map(|outcome| {
                outcome
                    .iter()
                    .find(|(candidate, ..)| Rc::ptr_eq(candidate, binding))
                    .map(|(_, moved, owned, partial)| (*moved, owned.clone(), *partial))
                    .unwrap_or((None, prior_owned.clone(), *prior_partial))
            })
            .collect::<Vec<_>>();
        let some = states.iter().any(|(moved, ..)| moved.is_some());
        let every = states.iter().all(|(moved, ..)| moved.is_some());
        if some && !every && binding.borrow().qualifier == Qualifier::Linear {
            analysis.report(
                "BLOT_LINEAR_BRANCH_DISAGREEMENT",
                format!(
                    "`{}` is consumed on some branches but not others.",
                    binding.borrow().name
                ),
                span,
            );
        }
        let first = &states[0];
        if binding.borrow().qualifier == Qualifier::Linear
            && states
                .iter()
                .any(|(_, owned, partial)| owned != &first.1 || partial != &first.2)
        {
            analysis.report(
                "BLOT_LINEAR_BRANCH_DISAGREEMENT",
                format!(
                    "`{}` has different live fields on continuing branches.",
                    binding.borrow().name
                ),
                span,
            );
        }
        let chosen = states
            .iter()
            .find(|(moved, ..)| moved.is_some())
            .unwrap_or(first);
        let mut binding = binding.borrow_mut();
        binding.moved = chosen.0;
        binding.owned = chosen.1.clone();
        binding.partial = chosen.2;
    }
}

fn written_obligation(qualifier: Qualifier) -> Produced {
    if spendable(qualifier) {
        Produced::Leaf(qualifier)
    } else {
        Produced::None
    }
}

fn written_parameter_obligation(qualifier: Qualifier, source: PatternId) -> Produced {
    if spendable(qualifier) {
        Produced::Parameter { qualifier, source }
    } else {
        Produced::None
    }
}

fn written_pattern(pattern: PatternId, module: &Module) -> Produced {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { qualifier, .. } => written_parameter_obligation(*qualifier, pattern),
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => Produced::Sequence(
            elements
                .iter()
                .map(|pattern| written_pattern(*pattern, module))
                .collect(),
        ),
        Pattern::Constructor { payload, .. } => Produced::Variant(Box::new(
            payload
                .map(|payload| written_pattern(payload, module))
                .unwrap_or(Produced::None),
        )),
        Pattern::Shape { fields, .. } => Produced::Shape(
            fields
                .iter()
                .map(|field| (field.name.clone(), written_pattern(field.pattern, module)))
                .collect(),
        ),
        _ => Produced::None,
    }
}

fn inherited(written: Qualifier, produced: &Produced) -> Qualifier {
    match obligation(produced) {
        Obligation::Linear => Qualifier::Linear,
        Obligation::Affine if written != Qualifier::Linear => Qualifier::Affine,
        _ if contains_borrow(produced) => Qualifier::Borrow,
        _ => written,
    }
}

fn spendable(qualifier: Qualifier) -> bool {
    matches!(qualifier, Qualifier::Linear | Qualifier::Affine)
}

fn obligation(produced: &Produced) -> Obligation {
    match produced {
        Produced::None | Produced::Borrow(_) => Obligation::None,
        Produced::Leaf(Qualifier::Linear)
        | Produced::Parameter {
            qualifier: Qualifier::Linear,
            ..
        } => Obligation::Linear,
        Produced::Leaf(Qualifier::Affine)
        | Produced::Parameter {
            qualifier: Qualifier::Affine,
            ..
        } => Obligation::Affine,
        Produced::Leaf(_) | Produced::Parameter { .. } => Obligation::None,
        Produced::Region { qualifier, .. } => match qualifier {
            Qualifier::Linear => Obligation::Linear,
            Qualifier::Affine => Obligation::Affine,
            _ => Obligation::None,
        },
        Produced::Closure { captures, .. } | Produced::Variant(captures) => obligation(captures),
        Produced::Choice(cases) => cases.values().fold(Obligation::None, |found, value| {
            merge_obligation(found, obligation(value))
        }),
        Produced::Many(values) | Produced::Sequence(values) => {
            values.iter().fold(Obligation::None, |found, value| {
                merge_obligation(found, obligation(value))
            })
        }
        Produced::Shape(fields) => fields.values().fold(Obligation::None, |found, value| {
            merge_obligation(found, obligation(value))
        }),
        // A witness owes exactly one join; losing it forfeits reassembly.
        Produced::RegionWitness { .. } => Obligation::Linear,
        // A pending join still carries its live part authorities.
        Produced::PendingJoin { .. } => Obligation::Linear,
        // A pending freeze already consumed its authority; only the deferred
        // full-root proof remains, discharged where substitution lands.
        Produced::PendingFreeze { .. } => Obligation::None,
    }
}

fn merge_obligation(left: Obligation, right: Obligation) -> Obligation {
    if left == Obligation::Linear || right == Obligation::Linear {
        return Obligation::Linear;
    }
    if left == Obligation::Affine || right == Obligation::Affine {
        return Obligation::Affine;
    }
    Obligation::None
}

fn contains_borrow(produced: &Produced) -> bool {
    match produced {
        Produced::Borrow(_) => true,
        Produced::None
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::Region { .. }
        | Produced::RegionWitness { .. }
        | Produced::PendingJoin { .. }
        | Produced::PendingFreeze { .. } => false,
        Produced::Closure {
            captures, result, ..
        } => contains_borrow(captures) || contains_borrow(result),
        Produced::Many(values) | Produced::Sequence(values) => values.iter().any(contains_borrow),
        Produced::Shape(fields) => fields.values().any(contains_borrow),
        Produced::Variant(payload) => contains_borrow(payload),
        Produced::Choice(cases) => cases.values().any(contains_borrow),
    }
}

fn relevant(produced: &Produced) -> bool {
    obligation(produced) != Obligation::None || contains_borrow(produced)
}

fn combine(left: Produced, right: Produced) -> Produced {
    if left == right {
        return left;
    }
    if !relevant(&left) {
        return right;
    }
    if !relevant(&right) {
        return left;
    }
    let mut values = Vec::new();
    match left {
        Produced::Many(left) => values.extend(left),
        left => values.push(left),
    }
    match right {
        Produced::Many(right) => values.extend(right),
        right => values.push(right),
    }
    Produced::Many(values)
}

fn join(values: impl IntoIterator<Item = Produced>) -> Produced {
    values.into_iter().fold(Produced::None, combine)
}

fn choice_for_pattern(target: &Produced, pattern: PatternId, module: &Module) -> Produced {
    let Produced::Choice(cases) = target else {
        return target.clone();
    };
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Constructor { name, .. } => cases.get(name).cloned().unwrap_or(Produced::None),
        _ => join(cases.values().cloned()),
    }
}

fn region_authority(produced: Produced) -> Produced {
    match produced {
        Produced::Parameter { qualifier, source } => Produced::Region {
            qualifier,
            root: Some(source),
            splits: Vec::new(),
        },
        produced => produced,
    }
}

/// Whether a produced value may still become concrete through parameter
/// substitution at a call site. A rooted Region is concrete even when its
/// root names a binding pattern; only a parameter awaits a caller.
fn symbolic_authority(produced: &Produced) -> bool {
    matches!(
        produced,
        Produced::Parameter { .. } | Produced::PendingJoin { .. } | Produced::PendingFreeze { .. }
    )
}

fn join_region(
    witness: Produced,
    left: Produced,
    right: Produced,
    span: Span,
    analysis: &mut Analysis,
) -> Produced {
    match witness {
        Produced::RegionWitness {
            left: witness_left,
            right: witness_right,
            parent,
        } => {
            // A part that is still a parameter defers: the outermost call
            // substitutes the caller's concrete authorities.
            if symbolic_authority(&left) || symbolic_authority(&right) {
                return Produced::PendingJoin {
                    witness: Box::new(Produced::RegionWitness {
                        left: witness_left,
                        right: witness_right,
                        parent,
                    }),
                    left: Box::new(left),
                    right: Box::new(right),
                };
            }
            if *witness_left != left || *witness_right != right {
                analysis.report(
                    "BLOT_REGION_JOIN_UNPROVED",
                    "Region join requires the witness minted with these two parts.",
                    span,
                );
                return Produced::None;
            }
            *parent
        }
        Produced::Parameter { .. } => Produced::PendingJoin {
            witness: Box::new(witness),
            left: Box::new(left),
            right: Box::new(right),
        },
        _ => {
            analysis.report(
                "BLOT_REGION_JOIN_UNPROVED",
                "Region join requires the rejoin witness a split minted.",
                span,
            );
            Produced::None
        }
    }
}

/// Discharges pending join and freeze proofs whose components became
/// concrete through parameter substitution. Components that are still
/// symbolic stay pending for the next call boundary out.
fn resolve_pending(produced: Produced, span: Span, analysis: &mut Analysis) -> Produced {
    match produced {
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => {
            let witness = resolve_pending(*witness, span, analysis);
            let left = resolve_pending(*left, span, analysis);
            let right = resolve_pending(*right, span, analysis);
            join_region(witness, left, right, span, analysis)
        }
        Produced::PendingFreeze { region } => {
            let region = resolve_pending(*region, span, analysis);
            match region {
                Produced::Region { ref splits, .. } if splits.is_empty() => Produced::None,
                region if symbolic_authority(&region) => Produced::PendingFreeze {
                    region: Box::new(region),
                },
                _ => {
                    analysis.report(
                        "BLOT_REGION_PARTIAL_FREEZE",
                        "Only a complete root Region authority can be frozen. Rejoin every split first.",
                        span,
                    );
                    Produced::None
                }
            }
        }
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => Produced::RegionWitness {
            left: Box::new(resolve_pending(*left, span, analysis)),
            right: Box::new(resolve_pending(*right, span, analysis)),
            parent: Box::new(resolve_pending(*parent, span, analysis)),
        },
        Produced::Borrow(value) => {
            Produced::Borrow(Box::new(resolve_pending(*value, span, analysis)))
        }
        Produced::Closure {
            captures,
            parameter,
            result,
        } => Produced::Closure {
            captures: Box::new(resolve_pending(*captures, span, analysis)),
            parameter,
            result: Box::new(resolve_pending(*result, span, analysis)),
        },
        Produced::Many(values) => join(
            values
                .into_iter()
                .map(|value| resolve_pending(value, span, analysis))
                .collect::<Vec<_>>(),
        ),
        Produced::Sequence(values) => Produced::Sequence(
            values
                .into_iter()
                .map(|value| resolve_pending(value, span, analysis))
                .collect(),
        ),
        Produced::Shape(fields) => Produced::Shape(
            fields
                .into_iter()
                .map(|(name, value)| (name, resolve_pending(value, span, analysis)))
                .collect(),
        ),
        Produced::Variant(payload) => {
            Produced::Variant(Box::new(resolve_pending(*payload, span, analysis)))
        }
        Produced::Choice(cases) => Produced::Choice(
            cases
                .into_iter()
                .map(|(name, value)| (name, resolve_pending(value, span, analysis)))
                .collect(),
        ),
        produced => produced,
    }
}

fn pattern_binds(pattern: PatternId, module: &Module) -> bool {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { .. } => true,
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => elements
            .iter()
            .any(|pattern| pattern_binds(*pattern, module)),
        Pattern::Constructor { payload, .. } => {
            payload.is_some_and(|payload| pattern_binds(payload, module))
        }
        Pattern::Shape { fields, .. } => fields
            .iter()
            .any(|field| pattern_binds(field.pattern, module)),
        _ => false,
    }
}

fn parameter_accepts_ownership(
    parameter: Option<PatternId>,
    argument: &Produced,
    module: &Module,
) -> bool {
    if obligation(argument) == Obligation::None {
        return true;
    }
    let Some(parameter) = parameter else {
        return false;
    };
    match (&module.arena.patterns[parameter.0 as usize], argument) {
        (
            Pattern::Name {
                qualifier: Qualifier::Linear,
                ..
            },
            _,
        ) => true,
        (
            Pattern::Name {
                qualifier: Qualifier::Affine,
                ..
            },
            _,
        ) => obligation(argument) == Obligation::Affine,
        (
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. },
            Produced::Sequence(values),
        ) => {
            elements.len() == values.len()
                && elements.iter().zip(values).all(|(pattern, value)| {
                    parameter_accepts_ownership(Some(*pattern), value, module)
                })
        }
        (Pattern::Constructor { payload, .. }, Produced::Variant(value)) => {
            parameter_accepts_ownership(*payload, value, module)
        }
        (Pattern::Shape { fields, .. }, Produced::Shape(values)) => {
            values.iter().all(|(name, value)| {
                fields
                    .iter()
                    .find(|field| &field.name == name)
                    .is_some_and(|field| {
                        parameter_accepts_ownership(Some(field.pattern), value, module)
                    })
            })
        }
        _ => false,
    }
}

fn parameter_accepts_borrow(
    parameter: Option<PatternId>,
    argument: &Produced,
    module: &Module,
) -> bool {
    if !contains_borrow(argument) {
        return true;
    }
    let Some(parameter) = parameter else {
        return false;
    };
    match (&module.arena.patterns[parameter.0 as usize], argument) {
        (
            Pattern::Name {
                qualifier: Qualifier::Borrow,
                ..
            },
            Produced::Borrow(_),
        ) => true,
        (
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. },
            Produced::Sequence(values),
        ) => {
            elements.len() == values.len()
                && elements
                    .iter()
                    .zip(values)
                    .all(|(pattern, value)| parameter_accepts_borrow(Some(*pattern), value, module))
        }
        (Pattern::Constructor { payload, .. }, Produced::Variant(value)) => {
            parameter_accepts_borrow(*payload, value, module)
        }
        (Pattern::Shape { fields, .. }, Produced::Shape(values)) => {
            values.iter().all(|(name, value)| {
                fields
                    .iter()
                    .find(|field| &field.name == name)
                    .is_some_and(|field| {
                        parameter_accepts_borrow(Some(field.pattern), value, module)
                    })
            })
        }
        _ => false,
    }
}

fn trusted_borrow_operation(function: ExpressionId, module: &Module) -> bool {
    let (callee, _) = application_spine(function, module);
    match &module.arena.expressions[callee.0 as usize] {
        Expression::Intrinsic { name, .. } => {
            name.starts_with("@int.")
                || name.starts_with("@float.")
                || name.starts_with("@f32.")
                || name.starts_with("@f32x4.")
                || name.starts_with("@i32x4.")
                || name.starts_with("@i16x8.")
                || name.starts_with("@i8x16.")
                || name.starts_with("@text.")
                || matches!(
                    name.as_str(),
                    "@array.len" | "@shape.has" | "@region.length" | "@region.get"
                )
        }
        Expression::Field { target, name, .. } => {
            matches!(
                &module.arena.expressions[target.0 as usize],
                Expression::Var { name: namespace, .. }
                    if (namespace == "Num" || namespace == "Text")
                        || ((namespace == "Array" || namespace == "Arena")
                            && matches!(name.as_str(), "get" | "length"))
            )
        }
        _ => false,
    }
}

fn trusted_scalar_operation(function: ExpressionId, module: &Module) -> bool {
    let (callee, _) = application_spine(function, module);
    match &module.arena.expressions[callee.0 as usize] {
        Expression::Intrinsic { .. } => true,
        Expression::Field { target, .. } => matches!(
            &module.arena.expressions[target.0 as usize],
            Expression::Var { name, .. } if name == "Num" || name == "Array"
        ),
        _ => false,
    }
}

fn application_spine(
    expression: ExpressionId,
    module: &Module,
) -> (ExpressionId, Vec<ExpressionId>) {
    let mut callee = expression;
    let mut arguments = Vec::new();
    while let Expression::Apply {
        function, argument, ..
    } = module.arena.expressions[callee.0 as usize]
    {
        arguments.push(argument);
        callee = function;
    }
    arguments.reverse();
    (callee, arguments)
}

fn signature_declaration(module: &Module, declaration: DeclarationId) -> bool {
    matches!(
        module.arena.declarations[declaration.0 as usize],
        Declaration::Binding {
            kind: DeclarationKind::Sig,
            ..
        }
    )
}

fn recursive_declaration(module: &Module, declaration: DeclarationId) -> bool {
    let Declaration::Binding { value, .. } = &module.arena.declarations[declaration.0 as usize]
    else {
        return false;
    };
    matches!(
        module.arena.expressions[value.0 as usize],
        Expression::Rec { .. }
    )
}

/// What one path through a recursive body does with the group's captures.
#[derive(Clone, Copy, Default)]
struct RecursionPath {
    /// Reads a capture other than by handing it to the recursive call.
    spends: bool,
    /// Can reach a recursive call.
    recurses: bool,
}

impl RecursionPath {
    /// Both subtrees run on the same path, so their facts accumulate.
    fn then(self, next: Self) -> Self {
        Self {
            spends: self.spends || next.spends,
            recurses: self.recurses || next.recurses,
        }
    }

    /// Alternatives are separate paths; upward, either may have happened.
    fn or(self, other: Self) -> Self {
        Self {
            spends: self.spends || other.spends,
            recurses: self.recurses || other.recurses,
        }
    }
}

/// Does some path through this recursive body both spend a capture and recurse?
///
/// The group already consumed each capture once, which is what makes the
/// transfer sound for a body that hands the capture to its own tail call. A
/// body that instead spends the capture and then continues would spend it again
/// on the next entry, so the two facts must not meet on one path.
fn recursion_spends_a_capture(
    body: ExpressionId,
    names: &HashSet<String>,
    captures: &HashSet<String>,
    module: &Module,
) -> bool {
    recursion_paths(body, names, captures, module).1
}

fn recursion_paths(
    expression: ExpressionId,
    names: &HashSet<String>,
    captures: &HashSet<String>,
    module: &Module,
) -> (RecursionPath, bool) {
    let leaf = |path: RecursionPath| (path, path.spends && path.recurses);
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => leaf(RecursionPath {
            spends: captures.contains(name),
            recurses: names.contains(name),
        }),
        Expression::Apply { .. } => {
            let (callee, arguments) = application_spine(expression, module);
            let recursive = matches!(
                &module.arena.expressions[callee.0 as usize],
                Expression::Var { name, .. } if names.contains(name)
            );
            let mut path = RecursionPath {
                recurses: recursive,
                ..RecursionPath::default()
            };
            let mut violated = false;
            if !recursive {
                let (callee_path, callee_violated) =
                    recursion_paths(callee, names, captures, module);
                path = path.then(callee_path);
                violated = violated || callee_violated;
            }
            for argument in arguments {
                // Handing a capture straight to the recursive call is the
                // transfer this rule exists to permit.
                if recursive && transferred_capture(argument, captures, module) {
                    continue;
                }
                let (argument_path, argument_violated) =
                    recursion_paths(argument, names, captures, module);
                path = path.then(argument_path);
                violated = violated || argument_violated;
            }
            (path, violated || (path.spends && path.recurses))
        }
        Expression::Field { target, .. } => recursion_paths(*target, names, captures, module),
        Expression::Lambda { body, .. } | Expression::Comptime { body, .. } => {
            recursion_paths(*body, names, captures, module)
        }
        Expression::Rec { lambda, .. } => recursion_paths(*lambda, names, captures, module),
        Expression::Tuple { elements, .. } => {
            sequential(elements.iter().copied(), names, captures, module)
        }
        Expression::Array { elements, .. } => sequential(
            elements.iter().map(|element| element.value),
            names,
            captures,
            module,
        ),
        Expression::Shape { members, .. } => sequential(
            members.iter().map(|member| match member {
                ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
            }),
            names,
            captures,
            module,
        ),
        Expression::If {
            branches, fallback, ..
        } => {
            let mut before = RecursionPath::default();
            let mut violated = false;
            let mut taken = Vec::new();
            for branch in branches {
                let (condition, condition_violated) =
                    recursion_paths(branch.condition, names, captures, module);
                before = before.then(condition);
                violated = violated || condition_violated;
                let (consequence, consequence_violated) =
                    recursion_paths(branch.consequence, names, captures, module);
                violated = violated || consequence_violated;
                taken.push(before.then(consequence));
            }
            if let Some(fallback) = fallback {
                let (path, fallback_violated) = recursion_paths(*fallback, names, captures, module);
                violated = violated || fallback_violated;
                taken.push(before.then(path));
            }
            alternatives(taken, before, violated)
        }
        Expression::Case { target, arms, .. } => {
            let (before, mut violated) = recursion_paths(*target, names, captures, module);
            let mut taken = Vec::new();
            for arm in arms {
                let (path, arm_violated) = recursion_paths(arm.body, names, captures, module);
                violated = violated || arm_violated;
                taken.push(before.then(path));
            }
            alternatives(taken, before, violated)
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            let values = declarations.iter().map(|declaration| {
                match &module.arena.declarations[declaration.0 as usize] {
                    Declaration::Binding { value, .. }
                    | Declaration::Shadow { value, .. }
                    | Declaration::Open { value, .. } => *value,
                }
            });
            let (path, violated) = sequential(values, names, captures, module);
            let (result_path, result_violated) = recursion_paths(*result, names, captures, module);
            let path = path.then(result_path);
            (
                path,
                violated || result_violated || (path.spends && path.recurses),
            )
        }
        _ => (RecursionPath::default(), false),
    }
}

fn sequential(
    expressions: impl IntoIterator<Item = ExpressionId>,
    names: &HashSet<String>,
    captures: &HashSet<String>,
    module: &Module,
) -> (RecursionPath, bool) {
    let mut path = RecursionPath::default();
    let mut violated = false;
    for expression in expressions {
        let (next, next_violated) = recursion_paths(expression, names, captures, module);
        path = path.then(next);
        violated = violated || next_violated;
    }
    (path, violated || (path.spends && path.recurses))
}

fn alternatives(
    taken: Vec<RecursionPath>,
    before: RecursionPath,
    violated: bool,
) -> (RecursionPath, bool) {
    let violated = violated || taken.iter().any(|path| path.spends && path.recurses);
    let path = taken.into_iter().fold(before, RecursionPath::or);
    (path, violated)
}

/// Is this argument the capture itself, handed to the recursive call?
fn transferred_capture(
    argument: ExpressionId,
    captures: &HashSet<String>,
    module: &Module,
) -> bool {
    match &module.arena.expressions[argument.0 as usize] {
        Expression::Var { name, .. } => captures.contains(name),
        Expression::Apply {
            function, argument, ..
        } => {
            matches!(
                &module.arena.expressions[function.0 as usize],
                Expression::Intrinsic { name, .. } if name == "@linear.own" || name == "@linear.borrow"
            ) && transferred_capture(*argument, captures, module)
        }
        _ => false,
    }
}

fn recursive_calls_are_tail(
    expression: ExpressionId,
    names: &HashSet<String>,
    tail: bool,
    module: &Module,
) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => !names.contains(name),
        Expression::Apply {
            function, argument, ..
        } => {
            let (callee, arguments) = application_spine(expression, module);
            if let Expression::Var { name, .. } = &module.arena.expressions[callee.0 as usize]
                && names.contains(name)
            {
                return tail
                    && arguments
                        .iter()
                        .all(|argument| recursive_calls_are_tail(*argument, names, false, module));
            }
            recursive_calls_are_tail(*function, names, false, module)
                && recursive_calls_are_tail(*argument, names, false, module)
        }
        Expression::Field { target, .. } => recursive_calls_are_tail(*target, names, false, module),
        Expression::Lambda { body, .. } => recursive_calls_are_tail(*body, names, tail, module),
        Expression::Rec { lambda, .. } => recursive_calls_are_tail(*lambda, names, tail, module),
        Expression::Comptime { body, .. } => recursive_calls_are_tail(*body, names, false, module),
        Expression::Tuple { elements, .. } => elements
            .iter()
            .all(|element| recursive_calls_are_tail(*element, names, false, module)),
        Expression::Array { elements, .. } => elements
            .iter()
            .all(|element| recursive_calls_are_tail(element.value, names, false, module)),
        Expression::Shape { members, .. } => members.iter().all(|member| {
            let value = match member {
                ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
            };
            recursive_calls_are_tail(value, names, false, module)
        }),
        Expression::If {
            branches, fallback, ..
        } => {
            branches.iter().all(|branch| {
                recursive_calls_are_tail(branch.condition, names, false, module)
                    && recursive_calls_are_tail(branch.consequence, names, tail, module)
            }) && fallback
                .is_none_or(|fallback| recursive_calls_are_tail(fallback, names, tail, module))
        }
        Expression::Case { target, arms, .. } => {
            recursive_calls_are_tail(*target, names, false, module)
                && arms
                    .iter()
                    .all(|arm| recursive_calls_are_tail(arm.body, names, tail, module))
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            declarations.iter().all(|declaration| {
                let value = match &module.arena.declarations[declaration.0 as usize] {
                    Declaration::Binding { value, .. }
                    | Declaration::Shadow { value, .. }
                    | Declaration::Open { value, .. } => *value,
                };
                recursive_calls_are_tail(value, names, false, module)
            }) && recursive_calls_are_tail(*result, names, tail, module)
        }
        _ => true,
    }
}

fn free_names(expression: ExpressionId, module: &Module) -> HashSet<String> {
    let mut names = HashSet::new();
    collect_free_names(expression, module, &mut Vec::new(), &mut names);
    names
}

fn collect_free_names(
    expression: ExpressionId,
    module: &Module,
    bound: &mut Vec<HashSet<String>>,
    names: &mut HashSet<String>,
) {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } if !bound.iter().rev().any(|scope| scope.contains(name)) => {
            names.insert(name.clone());
        }
        Expression::Apply {
            function, argument, ..
        } => {
            collect_free_names(*function, module, bound, names);
            collect_free_names(*argument, module, bound, names);
        }
        Expression::Field { target, .. } => collect_free_names(*target, module, bound, names),
        Expression::Lambda {
            parameter, body, ..
        } => {
            bound.push(pattern_names(*parameter, module).into_iter().collect());
            collect_free_names(*body, module, bound, names);
            bound.pop();
        }
        Expression::Rec { lambda, .. } => collect_free_names(*lambda, module, bound, names),
        Expression::Comptime { body, .. } => collect_free_names(*body, module, bound, names),
        Expression::Tuple { elements, .. } => {
            for expression in elements {
                collect_free_names(*expression, module, bound, names);
            }
        }
        Expression::Array { elements, .. } => {
            for element in elements {
                collect_free_names(element.value, module, bound, names);
            }
        }
        Expression::Shape { members, .. } => {
            for member in members {
                let value = match member {
                    ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
                };
                collect_free_names(value, module, bound, names);
            }
        }
        Expression::If {
            branches, fallback, ..
        } => {
            for branch in branches {
                collect_free_names(branch.condition, module, bound, names);
                collect_free_names(branch.consequence, module, bound, names);
            }
            if let Some(fallback) = fallback {
                collect_free_names(*fallback, module, bound, names);
            }
        }
        Expression::Case { target, arms, .. } => {
            collect_free_names(*target, module, bound, names);
            for arm in arms {
                bound.push(pattern_names(arm.pattern, module).into_iter().collect());
                collect_free_names(arm.body, module, bound, names);
                bound.pop();
            }
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            bound.push(HashSet::new());
            for declaration in declarations {
                let declaration = &module.arena.declarations[declaration.0 as usize];
                let value = match declaration {
                    Declaration::Binding { value, .. }
                    | Declaration::Shadow { value, .. }
                    | Declaration::Open { value, .. } => *value,
                };
                collect_free_names(value, module, bound, names);
                if let Declaration::Binding { pattern, .. } = declaration {
                    bound
                        .last_mut()
                        .expect("block scope exists")
                        .extend(pattern_names(*pattern, module));
                }
            }
            collect_free_names(*result, module, bound, names);
            bound.pop();
        }
        _ => {}
    }
}

fn pattern_names(pattern: PatternId, module: &Module) -> Vec<String> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => vec![name.clone()],
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => elements
            .iter()
            .flat_map(|pattern| pattern_names(*pattern, module))
            .collect(),
        Pattern::Constructor { payload, .. } => payload
            .map(|payload| pattern_names(payload, module))
            .unwrap_or_default(),
        Pattern::Shape { fields, .. } => fields
            .iter()
            .flat_map(|field| pattern_names(field.pattern, module))
            .collect(),
        _ => Vec::new(),
    }
}

fn pattern_span(module: &Module, pattern: PatternId) -> Span {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { span, .. }
        | Pattern::Wildcard { span }
        | Pattern::Pin { span, .. }
        | Pattern::Int { span, .. }
        | Pattern::Float { span, .. }
        | Pattern::Text { span, .. }
        | Pattern::Unit { span }
        | Pattern::Tuple { span, .. }
        | Pattern::Array { span, .. }
        | Pattern::Constructor { span, .. }
        | Pattern::Shape { span, .. } => *span,
    }
}
