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
    Closure {
        captures: Box<Produced>,
        parameter: PatternId,
        result: Box<Produced>,
    },
    Many(Vec<Produced>),
    Sequence(Vec<Produced>),
    Shape(BTreeMap<String, Produced>),
    Variant(Box<Produced>),
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
            let owned = if relevant(&produced) {
                produced
            } else {
                written
            };
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
            } else {
                if let Produced::Variant(payload) = produced {
                    report_discarded(pattern, &payload, analysis);
                }
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
            while index < declarations.len()
                && recursive_declaration(analysis.module, declarations[index])
            {
                index += 1;
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
                declare(arm.pattern, target.clone(), &inner, analysis);
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
    if let Expression::Intrinsic { name, .. } =
        &analysis.module.arena.expressions[callee.0 as usize]
    {
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
    result
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

fn written_pattern(pattern: PatternId, module: &Module) -> Produced {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { qualifier, .. } => written_obligation(*qualifier),
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
        Produced::Leaf(Qualifier::Linear) => Obligation::Linear,
        Produced::Leaf(Qualifier::Affine) => Obligation::Affine,
        Produced::Leaf(_) => Obligation::None,
        Produced::Closure { captures, .. } | Produced::Variant(captures) => obligation(captures),
        Produced::Many(values) | Produced::Sequence(values) => {
            values.iter().fold(Obligation::None, |found, value| {
                merge_obligation(found, obligation(value))
            })
        }
        Produced::Shape(fields) => fields.values().fold(Obligation::None, |found, value| {
            merge_obligation(found, obligation(value))
        }),
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
        Produced::None | Produced::Leaf(_) => false,
        Produced::Closure {
            captures, result, ..
        } => contains_borrow(captures) || contains_borrow(result),
        Produced::Many(values) | Produced::Sequence(values) => values.iter().any(contains_borrow),
        Produced::Shape(fields) => fields.values().any(contains_borrow),
        Produced::Variant(payload) => contains_borrow(payload),
    }
}

fn relevant(produced: &Produced) -> bool {
    obligation(produced) != Obligation::None || contains_borrow(produced)
}

fn combine(left: Produced, right: Produced) -> Produced {
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
                || matches!(name.as_str(), "@array.len" | "@shape.has")
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
