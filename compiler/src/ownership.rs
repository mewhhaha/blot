use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, DeclarationTag, Expression, ExpressionId, Module,
    Pattern, PatternId, Qualifier, ShapeMember, Span,
};
use crate::diagnostic::Diagnostic;
use crate::eval::Context;
use crate::partition::{
    Direction as PartitionDirection, PartitionError, PartitionWitness, combine_partition,
    reassociate_partition,
};
use crate::typecheck::Type;
use crate::value::{Environment as ValueEnvironment, Value, lookup};

type BindingRef = Rc<RefCell<Binding>>;
type ScopeRef = Rc<RefCell<Scope>>;
type FunctionContract = (
    Option<PatternId>,
    Produced,
    Produced,
    Vec<CallbackRequirement>,
    Option<Rc<Module>>,
);

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub(crate) enum Produced {
    None,
    Borrow(Box<Produced>),
    Leaf(Qualifier),
    Parameter {
        qualifier: Qualifier,
        source: PatternId,
    },
    /// Symbolic unique Store authority introduced by an unqualified Array
    /// parameter. Unlike written `?`, this may be frozen as shareable.
    StoreParameter {
        source: PatternId,
        path: Vec<String>,
        shareable: bool,
    },
    Closure {
        captures: Box<Produced>,
        parameter: PatternId,
        result: Box<Produced>,
    },
    Many(Vec<Produced>),
    Sequence(Vec<Produced>),
    /// One uniquely owned runtime Store and the obligations of its elements.
    /// This authority is affine even though `Array T` remains an ordinary type.
    Store(Box<Produced>),
    /// The allocation-free polymorphic empty array. It is freely shareable,
    /// but its first successful grow creates a fresh owned Store.
    EmptyStore,
    /// An Array Store that may have aliases. It can be borrowed, frozen, or
    /// copied, but never silently upgraded to destructive-update authority.
    SharedStore,
    Shape(BTreeMap<String, Produced>),
    Variant(Box<Produced>),
    Choice(BTreeMap<String, Produced>),
    /// An owned call through a function-valued parameter. Its result must be
    /// exposed immediately by a qualified binding or named `case`, which
    /// turns the opaque result into a checked callback requirement.
    PendingCallback {
        source: PatternId,
        path: Vec<String>,
        input: Box<Produced>,
    },
    Region {
        qualifier: Qualifier,
        root: Option<PatternId>,
        splits: Vec<(Span, u8)>,
        elements: Box<Produced>,
    },
    /// The element-free recombination witness a split mints: which two
    /// interval authorities rejoin into which parent. It travels through
    /// bindings and calls like any linear value while current element
    /// obligations stay on the Regions.
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
    /// A recycle whose source Store is still a symbolic parameter. Whether
    /// its elements are droppable is checked after call-site substitution.
    PendingScratchRecycle {
        source: Box<Produced>,
    },
    PendingReassociate {
        direction: u8,
        part: u8,
        outer: Box<Produced>,
        inner: Box<Produced>,
    },
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub(crate) struct CallbackRequirement {
    pub(crate) source: PatternId,
    pub(crate) path: Vec<String>,
    pub(crate) input: Produced,
    pub(crate) result: Produced,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct OwnershipContract {
    pub(crate) parameter: PatternId,
    pub(crate) input: Produced,
    pub(crate) result: Produced,
    #[serde(default)]
    pub(crate) callback_requirements: Vec<CallbackRequirement>,
}

pub(crate) struct OwnershipCheck {
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) contracts: Vec<(ExpressionId, OwnershipContract)>,
    pub(crate) facts: Vec<OwnershipFact>,
}

#[derive(Clone, Serialize)]
pub(crate) struct OwnershipFact {
    pub(crate) name: String,
    pub(crate) span: Span,
    pub(crate) last_use: Option<Span>,
    pub(crate) spent: bool,
}

pub(crate) fn validate_contracts(
    module: &Module,
    contracts: &[(ExpressionId, OwnershipContract)],
) -> Result<(), String> {
    let mut bodies = HashSet::new();
    for (body, contract) in contracts {
        if body.0 as usize >= module.arena.expressions.len() {
            return Err(format!(
                "ownership contract references missing closure body {}",
                body.0
            ));
        }
        if contract.parameter.0 as usize >= module.arena.patterns.len() {
            return Err(format!(
                "ownership contract for body {} references missing parameter {}",
                body.0, contract.parameter.0
            ));
        }
        if !bodies.insert(*body) {
            return Err(format!(
                "ownership contract repeats closure body {}",
                body.0
            ));
        }
        let defining_lambda = module.arena.expressions.iter().any(|expression| {
            let Expression::Lambda {
                parameter,
                body: lambda_body,
                ..
            } = expression
            else {
                return false;
            };
            parameter == &contract.parameter && lambda_body == body
        });
        if !defining_lambda {
            return Err(format!(
                "ownership contract for body {} does not match lambda parameter {}",
                body.0, contract.parameter.0
            ));
        }
        validate_produced(module, &contract.input)?;
        validate_produced(module, &contract.result)?;
        for requirement in &contract.callback_requirements {
            validate_pattern_member(module, contract.parameter, requirement.source)?;
            validate_produced(module, &requirement.input)?;
            validate_produced(module, &requirement.result)?;
        }
    }
    Ok(())
}

fn validate_pattern_member(
    module: &Module,
    root: PatternId,
    expected: PatternId,
) -> Result<(), String> {
    if pattern_contains(module, root, expected) {
        return Ok(());
    }
    Err(format!(
        "ownership callback requirement references pattern {} outside parameter {}",
        expected.0, root.0
    ))
}

fn pattern_contains(module: &Module, root: PatternId, expected: PatternId) -> bool {
    if root == expected {
        return true;
    }
    match &module.arena.patterns[root.0 as usize] {
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => elements
            .iter()
            .any(|child| pattern_contains(module, *child, expected)),
        Pattern::Constructor { payload, .. } => {
            payload.is_some_and(|child| pattern_contains(module, child, expected))
        }
        Pattern::Shape { fields, .. } => fields
            .iter()
            .any(|field| pattern_contains(module, field.pattern, expected)),
        _ => false,
    }
}

fn validate_produced(module: &Module, produced: &Produced) -> Result<(), String> {
    let validate_pattern = |pattern: PatternId| {
        if pattern.0 as usize >= module.arena.patterns.len() {
            return Err(format!(
                "ownership contract references missing pattern {}",
                pattern.0
            ));
        }
        Ok(())
    };
    match produced {
        Produced::None | Produced::SharedStore | Produced::EmptyStore | Produced::Leaf(_) => Ok(()),
        Produced::Borrow(value)
        | Produced::Store(value)
        | Produced::Variant(value)
        | Produced::PendingFreeze { region: value }
        | Produced::PendingScratchRecycle { source: value } => validate_produced(module, value),
        Produced::Parameter { source, .. } | Produced::StoreParameter { source, .. } => {
            validate_pattern(*source)
        }
        Produced::Closure {
            captures,
            parameter,
            result,
        } => {
            validate_pattern(*parameter)?;
            validate_produced(module, captures)?;
            validate_produced(module, result)
        }
        Produced::Many(values) | Produced::Sequence(values) => {
            for value in values {
                validate_produced(module, value)?;
            }
            Ok(())
        }
        Produced::Shape(fields) | Produced::Choice(fields) => {
            for value in fields.values() {
                validate_produced(module, value)?;
            }
            Ok(())
        }
        Produced::Region {
            root,
            splits,
            elements,
            ..
        } => {
            if let Some(root) = root {
                validate_pattern(*root)?;
            }
            for (span, part) in splits {
                if span.start < module.span.start
                    || span.start > span.end
                    || span.end > module.span.end
                {
                    return Err("ownership contract contains an invalid split span".to_owned());
                }
                if *part > 1 {
                    return Err("ownership contract contains an invalid split part".to_owned());
                }
            }
            validate_produced(module, elements)
        }
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => {
            validate_produced(module, left)?;
            validate_produced(module, right)?;
            validate_produced(module, parent)
        }
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => {
            validate_produced(module, witness)?;
            validate_produced(module, left)?;
            validate_produced(module, right)
        }
        Produced::PendingReassociate { outer, inner, .. } => {
            validate_produced(module, outer)?;
            validate_produced(module, inner)
        }
        Produced::PendingCallback { source, input, .. } => {
            validate_pattern(*source)?;
            validate_produced(module, input)
        }
    }
}

struct Binding {
    pattern: PatternId,
    name: String,
    qualifier: Qualifier,
    owned: Produced,
    parameter: Option<PatternId>,
    input: Produced,
    contract_module: Option<Rc<Module>>,
    result: Produced,
    callback_requirements: Vec<CallbackRequirement>,
    recursive_result: Option<Produced>,
    value: Option<ExpressionId>,
    moved: Option<Span>,
    last_use: Option<Span>,
    partial: bool,
    /// The current binding may be live again after `:=`; the function contract
    /// still remembers whether any predecessor authority was consumed.
    ownership_demanded: bool,
    function_parameter: bool,
    parameter_source: Option<(PatternId, Vec<String>)>,
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
    Share,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Obligation {
    None,
    Affine,
    Linear,
}

struct Analysis<'a> {
    module: &'a Module,
    context: &'a Context,
    values: &'a ValueEnvironment,
    closure_types: &'a HashMap<ExpressionId, Type>,
    expression_types: &'a HashMap<ExpressionId, Type>,
    diagnostics: Vec<Diagnostic>,
    function_results: HashMap<ExpressionId, Produced>,
    contracts: HashMap<ExpressionId, OwnershipContract>,
    callback_requirements: Vec<CallbackRequirement>,
    bindings: Vec<BindingRef>,
}

pub(crate) fn check(
    module: &Module,
    context: &Context,
    values: &ValueEnvironment,
    closure_types: &HashMap<ExpressionId, Type>,
    expression_types: &HashMap<ExpressionId, Type>,
) -> OwnershipCheck {
    let mut analysis = Analysis {
        module,
        context,
        values,
        closure_types,
        expression_types,
        diagnostics: Vec::new(),
        function_results: HashMap::new(),
        contracts: HashMap::new(),
        callback_requirements: Vec::new(),
        bindings: Vec::new(),
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
    if contains_pending_callback(&result) {
        analysis.report(
            "BLOT_HIGHER_ORDER_OWNERSHIP_RELATION",
            "An owned callback result must be eliminated immediately by a qualified binding or named `case`.",
            module.arena.expression_span(module.result),
        );
    }
    if obligation_without_stores(&result) == Obligation::Linear {
        analysis.report(
            "BLOT_LINEAR_RESULT_ESCAPES",
            "The module result still owns a resource.",
            module.arena.expression_span(module.result),
        );
    }
    close_scope(&scope, &mut analysis);
    let mut contracts = analysis.contracts.into_iter().collect::<Vec<_>>();
    contracts.sort_by_key(|(body, _)| body.0);
    let mut facts = analysis
        .bindings
        .iter()
        .map(|binding| {
            let binding = binding.borrow();
            OwnershipFact {
                name: binding.name.clone(),
                span: pattern_span(module, binding.pattern),
                last_use: binding.last_use,
                spent: binding.moved.is_some(),
            }
        })
        .collect::<Vec<_>>();
    facts.sort_by_key(|fact| (fact.span.start, fact.span.end));
    OwnershipCheck {
        diagnostics: analysis.diagnostics,
        contracts,
        facts,
    }
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

    fn callee_value(&self, expression: ExpressionId) -> Option<Value> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => lookup(self.values, name),
            Expression::Field { target, name, .. } => {
                let target = self.callee_value(*target)?;
                match target {
                    Value::Shape(fields) => fields.get(name).cloned(),
                    Value::Extended { members, .. } => members.get(name).cloned(),
                    Value::Sealed { inner, .. } => match *inner {
                        Value::Shape(fields) => fields.get(name).cloned(),
                        _ => None,
                    },
                    _ => None,
                }
            }
            _ => None,
        }
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
            let binding = Rc::new(RefCell::new(Binding {
                pattern,
                name: name.clone(),
                qualifier,
                owned,
                parameter: None,
                input: Produced::None,
                contract_module: None,
                result: Produced::None,
                callback_requirements: Vec::new(),
                recursive_result: None,
                value: None,
                moved: None,
                last_use: None,
                partial: false,
                ownership_demanded: false,
                function_parameter: false,
                parameter_source: None,
            }));
            analysis.bindings.push(binding.clone());
            scope.borrow_mut().bindings.insert(name.clone(), binding);
        }
        Pattern::Pin { name, span } => {
            use_name(name, *span, scope, analysis, Use::Project);
        }
        Pattern::Tuple { elements, .. } => {
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
        Pattern::Array { elements, .. } => {
            let produced_elements = match produced {
                Produced::Store(elements) => match *elements {
                    Produced::Sequence(elements) => elements,
                    _ => Vec::new(),
                },
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
        Pattern::Constructor { name, payload, .. } => {
            let produced = match produced {
                Produced::Choice(mut cases) => cases.remove(name).unwrap_or(Produced::None),
                produced => produced,
            };
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
    binding.borrow_mut().last_use = Some(span);
    let qualifier = binding.borrow().qualifier;
    if qualifier == Qualifier::Borrow && matches!(kind, Use::Move) {
        analysis.report(
            "BLOT_BORROW_MOVED",
            format!("`{name}` is borrowed and cannot be moved."),
            span,
        );
        return Produced::None;
    }
    if matches!(kind, Use::Share)
        && matches!(
            analysis.module.arena.patterns[binding.borrow().pattern.0 as usize],
            Pattern::Name {
                qualifier: Qualifier::None,
                ..
            }
        )
        && contains_concrete_store(&binding.borrow().owned)
        && obligation_without_stores(&binding.borrow().owned) == Obligation::None
    {
        let shared = share_concrete_stores(binding.borrow().owned.clone());
        {
            let mut binding = binding.borrow_mut();
            binding.owned = shared.clone();
            binding.qualifier = Qualifier::None;
        }
        if let Some(captured_by) = captured_by {
            install_capture(&captured_by, &binding, Qualifier::None);
        }
        return shared;
    }
    if let Some(captured_by) = captured_by {
        if matches!(kind, Use::Borrow)
            && matches!(
                analysis.module.arena.patterns[binding.borrow().pattern.0 as usize],
                Pattern::Name {
                    qualifier: Qualifier::None,
                    ..
                }
            )
            && contains_concrete_store(&binding.borrow().owned)
            && obligation_without_stores(&binding.borrow().owned) == Obligation::None
        {
            // Keep the capture provisionally owned while its body is checked.
            // A later move upgrades it to an owning closure; a read-only body
            // shares it only after the complete capture use is known.
            push_unique(&mut captured_by.borrow_mut().borrowed_captures, &binding);
            install_capture(&captured_by, &binding, qualifier);
            return use_name(name, span, scope, analysis, kind);
        }
        if matches!(kind, Use::Borrow)
            && qualifier == Qualifier::None
            && contains_shared(&binding.borrow().owned)
        {
            install_capture(&captured_by, &binding, Qualifier::None);
            return use_name(name, span, scope, analysis, kind);
        }
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
        return borrowed(binding.borrow().owned.clone());
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
    if contains_shared(&binding.borrow().owned) || contains_empty_store(&binding.borrow().owned) {
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
            input: source.input.clone(),
            contract_module: source.contract_module.clone(),
            result: source.result.clone(),
            callback_requirements: source.callback_requirements.clone(),
            recursive_result: source.recursive_result.clone(),
            value: source.value,
            moved: None,
            last_use: source.last_use,
            partial: source.partial,
            ownership_demanded: source.ownership_demanded,
            function_parameter: source.function_parameter,
            parameter_source: source.parameter_source.clone(),
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
    binding.ownership_demanded = true;
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
            tags,
            ..
        } => {
            let use_kind = if matches!(
                analysis.module.arena.patterns[pattern.0 as usize],
                Pattern::Array { .. }
            ) {
                Use::Share
            } else {
                Use::Move
            };
            let produced = walk(value, scope, analysis, use_kind);
            let produced = materialize_callback_binding(produced, pattern, span, analysis);
            if contains_borrow(&produced) {
                analysis.report(
                    "BLOT_BORROW_STORED",
                    "This declaration stores a borrowed view.",
                    span,
                );
            }
            declare(pattern, produced.clone(), scope, analysis);
            if let Some((source, path)) = expression_parameter_source(value, scope, analysis) {
                assign_parameter_source(pattern, source, &path, scope, analysis.module);
            }
            if let Pattern::Name { name, .. } = &analysis.module.arena.patterns[pattern.0 as usize]
                && let Some(binding) = scope.borrow().bindings.get(name).cloned()
            {
                let (parameter, input, result, callback_requirements, contract_module) =
                    declaration_function_contract(value, &produced, &tags, scope, analysis);
                let mut binding = binding.borrow_mut();
                binding.parameter = parameter;
                binding.input = input;
                binding.contract_module = contract_module;
                binding.result = result;
                binding.callback_requirements = callback_requirements;
                binding.value = Some(value);
            }
        }
        Declaration::Shadow {
            name, value, span, ..
        } => {
            let produced = walk(value, scope, analysis, Use::Move);
            if contains_borrow(&produced) {
                analysis.report(
                    "BLOT_BORROW_STORED",
                    "This rebinding stores a borrowed view.",
                    span,
                );
            }
            if let Some((binding, _)) = analysis.lookup(scope, &name) {
                let mut binding = binding.borrow_mut();
                binding.qualifier = inherited(binding.qualifier, &produced);
                binding.owned = produced;
                binding.moved = None;
                binding.partial = false;
            }
        }
        Declaration::Open { value, span } => {
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

fn expression_parameter_source(
    expression: ExpressionId,
    scope: &ScopeRef,
    analysis: &Analysis<'_>,
) -> Option<(PatternId, Vec<String>)> {
    match &analysis.module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => analysis
            .lookup(scope, name)
            .and_then(|(binding, _)| binding.borrow().parameter_source.clone()),
        Expression::Field { target, name, .. } => {
            let (source, mut path) = expression_parameter_source(*target, scope, analysis)?;
            path.push(name.clone());
            Some((source, path))
        }
        _ => None,
    }
}

fn assign_parameter_source(
    pattern: PatternId,
    source: PatternId,
    path: &[String],
    scope: &ScopeRef,
    module: &Module,
) {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => {
            if let Some(binding) = scope.borrow().bindings.get(name) {
                let mut binding = binding.borrow_mut();
                binding.function_parameter = true;
                binding.parameter_source = Some((source, path.to_vec()));
            }
        }
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
            for (index, pattern) in elements.iter().enumerate() {
                let mut element_path = path.to_vec();
                element_path.push(index.to_string());
                assign_parameter_source(*pattern, source, &element_path, scope, module);
            }
        }
        Pattern::Shape { fields, .. } => {
            for field in fields {
                let mut field_path = path.to_vec();
                field_path.push(field.name.clone());
                assign_parameter_source(field.pattern, source, &field_path, scope, module);
            }
        }
        _ => {}
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
        let (parameter, input, result) = match analysis.module.arena.expressions[lambda.0 as usize]
        {
            Expression::Lambda {
                parameter, body, ..
            } => {
                let input = written_parameter_pattern(
                    parameter,
                    analysis.module,
                    closure_parameter_type(body, analysis),
                );
                let result = recursive_owned_result(&input, closure_result_type(body, analysis));
                (Some(parameter), input, result)
            }
            _ => (None, Produced::None, None),
        };
        let binding = Rc::new(RefCell::new(Binding {
            pattern: *pattern,
            name: name.clone(),
            qualifier: *qualifier,
            owned: written_obligation(*qualifier),
            parameter,
            input,
            contract_module: None,
            result: result.clone().unwrap_or(Produced::None),
            callback_requirements: Vec::new(),
            recursive_result: result,
            value: Some(*value),
            moved: None,
            last_use: None,
            partial: false,
            ownership_demanded: false,
            function_parameter: false,
            parameter_source: None,
        }));
        analysis.bindings.push(binding.clone());
        scope.borrow_mut().bindings.insert(name.clone(), binding);
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
                if matches!(
                    analysis.module.arena.patterns[binding.borrow().pattern.0 as usize],
                    Pattern::Name {
                        qualifier: Qualifier::None,
                        ..
                    }
                ) && contains_concrete_store(&binding.borrow().owned)
                    && obligation_without_stores(&binding.borrow().owned) == Obligation::None
                {
                    let shared = share_concrete_stores(binding.borrow().owned.clone());
                    let mut binding = binding.borrow_mut();
                    binding.owned = shared;
                    binding.qualifier = Qualifier::None;
                    continue;
                }
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
                let (parameter, input, result, callback_requirements, contract_module) =
                    function_contract(value, &produced, scope, analysis);
                let mut binding = binding.borrow_mut();
                if let Some(expected) = &binding.recursive_result
                    && !recursive_result_matches(expected, &result)
                {
                    analysis.report(
                        "BLOT_RECURSIVE_OWNERSHIP_RESULT",
                        "This recursive function does not return the authority its recursive calls assume.",
                        analysis.module.arena.expression_span(value),
                    );
                }
                binding.qualifier = inherited(binding.qualifier, &produced);
                binding.owned = produced;
                binding.parameter = parameter;
                binding.input = input;
                binding.contract_module = contract_module;
                binding.result = result;
                binding.callback_requirements = callback_requirements;
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
        Expression::Var { name, span } => {
            prepare_array_binding(expression, &name, scope, analysis);
            shared_array_result(
                expression,
                use_name(&name, span, scope, analysis, kind),
                analysis,
            )
        }
        Expression::Apply {
            function,
            argument,
            span,
        } => {
            let produced = walk_apply(expression, function, argument, span, scope, analysis);
            if matches!(kind, Use::Borrow) {
                borrowed(produced)
            } else {
                produced
            }
        }
        Expression::Field { target, name, span } => {
            if let Some(projected) = project_owned_path(expression, scope, analysis, kind) {
                return projected;
            }
            let target = walk(target, scope, analysis, Use::Project);
            let target = match target {
                Produced::Borrow(inner) => {
                    let selected = select_field(*inner, &name, span, analysis);
                    return borrowed(selected);
                }
                target => target,
            };
            shared_array_result(
                expression,
                select_field(target, &name, span, analysis),
                analysis,
            )
        }
        Expression::Lambda {
            parameter,
            body,
            span,
            ..
        } => {
            let inner = child_scope(Some(scope.clone()), true);
            let input = written_parameter_pattern(
                parameter,
                analysis.module,
                closure_parameter_type(body, analysis),
            );
            declare(parameter, input.clone(), &inner, analysis);
            mark_function_parameters(parameter, &inner, analysis.module);
            let result = normalize_unrestricted_region_result(
                walk(body, &inner, analysis, Use::Move),
                closure_result_type(body, analysis),
            );
            if contains_borrow(&result) {
                analysis.report(
                    "BLOT_BORROW_RESULT_ESCAPES",
                    "This function returns a borrowed view.",
                    analysis.module.arena.expression_span(body),
                );
            }
            if contains_pending_callback(&result) {
                analysis.report(
                    "BLOT_HIGHER_ORDER_OWNERSHIP_RELATION",
                    "An owned callback result must be eliminated immediately by a qualified binding or named `case`.",
                    analysis.module.arena.expression_span(body),
                );
            }
            analysis.function_results.insert(expression, result.clone());
            let input = scope_pattern_owned(parameter, &inner, analysis.module);
            let callback_requirements = analysis
                .callback_requirements
                .iter()
                .filter(|requirement| {
                    pattern_contains(analysis.module, parameter, requirement.source)
                })
                .cloned()
                .collect();
            analysis.contracts.insert(
                body,
                OwnershipContract {
                    parameter,
                    input,
                    result: result.clone(),
                    callback_requirements,
                },
            );
            close_scope(&inner, analysis);
            let captures = inner.borrow().captures.clone();
            let borrowed_captures = inner.borrow().borrowed_captures.clone();
            let mut produced = Produced::None;
            for captured in captures {
                consume(&captured, span, analysis);
                produced = combine(produced, captured.borrow().owned.clone());
            }
            for captured in borrowed_captures {
                let local = inner
                    .borrow()
                    .bindings
                    .get(&captured.borrow().name)
                    .cloned();
                if local
                    .as_ref()
                    .is_some_and(|binding| binding.borrow().ownership_demanded)
                {
                    // The provisional capture was eventually consumed.
                    consume(&captured, span, analysis);
                    produced = combine(produced, captured.borrow().owned.clone());
                    continue;
                }
                if matches!(
                    analysis.module.arena.patterns[captured.borrow().pattern.0 as usize],
                    Pattern::Name {
                        qualifier: Qualifier::None,
                        ..
                    }
                ) && contains_concrete_store(&captured.borrow().owned)
                    && obligation_without_stores(&captured.borrow().owned) == Obligation::None
                {
                    // An escaping read-only closure cannot retain a lexical
                    // borrow, so relinquish only the Store authority in O(1).
                    let shared = share_concrete_stores(captured.borrow().owned.clone());
                    let mut captured = captured.borrow_mut();
                    captured.owned = shared;
                    captured.qualifier = Qualifier::None;
                    continue;
                }
                produced = combine(produced, borrowed(captured.borrow().owned.clone()));
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
            let mut values = Vec::new();
            for element in elements {
                let produced = walk(element.value, scope, analysis, Use::Move);
                if !element.spread {
                    values.push(produced);
                    continue;
                }
                match produced {
                    Produced::Store(elements) => match *elements {
                        Produced::Sequence(elements) => values.extend(elements),
                        elements => values.push(elements),
                    },
                    Produced::Sequence(elements) => values.extend(elements),
                    Produced::None
                    | Produced::SharedStore
                    | Produced::EmptyStore
                    | Produced::StoreParameter {
                        shareable: true, ..
                    } => {}
                    produced => {
                        if obligation(&produced) != Obligation::None {
                            analysis.report(
                                "BLOT_LINEAR_ARRAY_SPREAD",
                                "An array spread makes owned positions unknown.",
                                span,
                            );
                        }
                    }
                }
            }
            let elements = Produced::Sequence(values);
            if runtime_array_expression(expression, analysis) {
                Produced::Store(Box::new(elements))
            } else {
                elements
            }
        }
        Expression::Intrinsic { name, .. } if name == "@array.empty" => Produced::EmptyStore,
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
            join_alternatives(produced)
        }
        Expression::Case { target, arms, span } => {
            let target = walk(target, scope, analysis, Use::Project);
            let target = materialize_callback_case(target, &arms, span, analysis);
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
            join_alternatives(produced)
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

fn mark_function_parameters(pattern: PatternId, scope: &ScopeRef, module: &Module) {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => {
            if let Some(binding) = scope.borrow().bindings.get(name) {
                let mut binding = binding.borrow_mut();
                binding.function_parameter = true;
                binding.parameter_source = Some((pattern, Vec::new()));
            }
        }
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
            for pattern in elements {
                mark_function_parameters(*pattern, scope, module);
            }
        }
        Pattern::Constructor {
            payload: Some(pattern),
            ..
        } => mark_function_parameters(*pattern, scope, module),
        Pattern::Shape { fields, .. } => {
            for field in fields {
                mark_function_parameters(field.pattern, scope, module);
            }
        }
        _ => {}
    }
}

fn scope_pattern_owned(pattern: PatternId, scope: &ScopeRef, module: &Module) -> Produced {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name {
            name, qualifier, ..
        } => scope
            .borrow()
            .bindings
            .get(name)
            .map(|binding| {
                let binding = binding.borrow();
                if binding.ownership_demanded || spendable(*qualifier) {
                    binding.owned.clone()
                } else {
                    Produced::None
                }
            })
            .unwrap_or(Produced::None),
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => Produced::Sequence(
            elements
                .iter()
                .map(|pattern| scope_pattern_owned(*pattern, scope, module))
                .collect(),
        ),
        Pattern::Constructor { payload, .. } => Produced::Variant(Box::new(
            payload
                .map(|pattern| scope_pattern_owned(pattern, scope, module))
                .unwrap_or(Produced::None),
        )),
        Pattern::Shape { fields, .. } => Produced::Shape(
            fields
                .iter()
                .map(|field| {
                    (
                        field.name.clone(),
                        scope_pattern_owned(field.pattern, scope, module),
                    )
                })
                .collect(),
        ),
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
                if binding.borrow().moved.is_some() {
                    consume(&binding, span, analysis);
                    return Some(Produced::None);
                }
                let projected = remove_owned_path(&binding.borrow().owned, &path)?;
                if matches!(kind, Use::Share)
                    && matches!(
                        analysis.module.arena.patterns[binding.borrow().pattern.0 as usize],
                        Pattern::Name {
                            qualifier: Qualifier::None,
                            ..
                        }
                    )
                    && contains_concrete_store(&projected.0)
                    && obligation_without_stores(&projected.0) == Obligation::None
                {
                    let shared = share_concrete_stores(projected.0);
                    let owned = replace_owned_path(&binding.borrow().owned, &path, shared.clone())?;
                    let mut binding = binding.borrow_mut();
                    binding.owned = owned;
                    binding.qualifier = inherited(Qualifier::None, &binding.owned);
                    return Some(shared);
                }
                if captured_by.is_some() || !spendable(binding.borrow().qualifier) {
                    if obligation(&projected.0) != Obligation::None || contains_borrow(&projected.0)
                    {
                        return None;
                    }
                    if matches!(kind, Use::Borrow) {
                        return Some(borrowed(projected.0));
                    }
                    return Some(projected.0);
                }
                if matches!(kind, Use::Borrow) {
                    return Some(borrowed(projected.0));
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
    let (name, rest) = path.split_first()?;
    match produced {
        Produced::Shape(fields) => {
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
        Produced::Sequence(values) => {
            let index = name.parse::<usize>().ok()?;
            let selected = values.get(index)?.clone();
            let mut remaining = values.clone();
            if rest.is_empty() {
                remaining[index] = Produced::None;
                return Some((selected, Produced::Sequence(remaining)));
            }
            let (selected, nested) = remove_owned_path(&selected, rest)?;
            remaining[index] = nested;
            Some((selected, Produced::Sequence(remaining)))
        }
        _ => None,
    }
}

fn replace_owned_path(
    produced: &Produced,
    path: &[String],
    replacement: Produced,
) -> Option<Produced> {
    let (name, rest) = path.split_first()?;
    match produced {
        Produced::Shape(fields) => {
            let mut fields = fields.clone();
            if rest.is_empty() {
                fields.insert(name.clone(), replacement);
            } else {
                let nested = replace_owned_path(fields.get(name)?, rest, replacement)?;
                fields.insert(name.clone(), nested);
            }
            Some(Produced::Shape(fields))
        }
        Produced::Sequence(values) => {
            let index = name.parse::<usize>().ok()?;
            let mut values = values.clone();
            if rest.is_empty() {
                *values.get_mut(index)? = replacement;
            } else {
                let nested = replace_owned_path(values.get(index)?, rest, replacement)?;
                values[index] = nested;
            }
            Some(Produced::Sequence(values))
        }
        _ => None,
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
        if name == "@linear.own" || name == "@linear.maybe" {
            return walk(argument, scope, analysis, Use::Move);
        }
        if name == "@linear.freeze" {
            let value = walk(argument, scope, analysis, Use::Move);
            if obligation_without_stores(&value) != Obligation::None {
                analysis.report(
                    "BLOT_LINEAR_FREEZE",
                    "A shareable array cannot retain a linear resource.",
                    span,
                );
            }
            return Produced::SharedStore;
        }
    }
    if let Expression::Tag { name, .. } = &analysis.module.arena.expressions[function.0 as usize] {
        return Produced::Choice(BTreeMap::from([(
            name.clone(),
            Produced::Variant(Box::new(walk(argument, scope, analysis, Use::Move))),
        )]));
    }
    let (callee, arguments) = application_spine(expression, analysis.module);
    if let Expression::Intrinsic { name, .. } =
        &analysis.module.arena.expressions[callee.0 as usize]
    {
        let name = name.as_str();
        let arguments = &arguments;
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
            return shared_array_result(expression, Produced::None, analysis);
        }
        if name == "@region.copy" && arguments.len() == 1 {
            let source = walk(arguments[0], scope, analysis, Use::Project);
            let elements = match source {
                Produced::Store(elements) => *elements,
                Produced::None
                | Produced::SharedStore
                | Produced::EmptyStore
                | Produced::StoreParameter {
                    shareable: true, ..
                } => Produced::None,
                source => source,
            };
            return Produced::Region {
                qualifier: Qualifier::Linear,
                root: None,
                splits: Vec::new(),
                elements: Box::new(elements),
            };
        }
        if name == "@scratch.with_capacity" && arguments.len() == 1 {
            walk(arguments[0], scope, analysis, Use::Move);
            return Produced::Store(Box::new(Produced::Sequence(Vec::new())));
        }
        if name == "@scratch.push" && arguments.len() == 2 {
            let scratch = walk(arguments[0], scope, analysis, Use::Move);
            let value = walk(arguments[1], scope, analysis, Use::Move);
            if let Produced::Store(elements) = scratch {
                let mut elements = *elements;
                if let Produced::Sequence(values) = &mut elements {
                    values.push(value);
                } else {
                    elements = combine(elements, value);
                }
                return Produced::Store(Box::new(elements));
            }
            if let Produced::StoreParameter { .. } = scratch {
                return Produced::Store(Box::new(value));
            }
            analysis.report(
                "BLOT_SCRATCH_NOT_OWNED",
                "Scratch.push requires one owned Scratch authority.",
                analysis.module.arena.expression_span(arguments[0]),
            );
            return combine(scratch, value);
        }
        if name == "@scratch.finish" && arguments.len() == 1 {
            return walk(arguments[0], scope, analysis, Use::Move);
        }
        if name == "@scratch.recycle" && arguments.len() == 1 {
            let source = walk(arguments[0], scope, analysis, Use::Move);
            return recycle_scratch(
                source,
                analysis.module.arena.expression_span(arguments[0]),
                analysis,
            );
        }
        if name == "@region.length" && arguments.len() == 1 {
            walk(arguments[0], scope, analysis, Use::Borrow);
            return Produced::None;
        }
        if name == "@region.get" && arguments.len() == 2 {
            let region = walk(arguments[0], scope, analysis, Use::Borrow);
            let inspected = match &region {
                Produced::Borrow(value) => value.as_ref(),
                value => value,
            };
            if let Produced::Region { elements, .. } = inspected
                && obligation(elements) != Obligation::None
            {
                analysis.report(
                    "BLOT_REGION_OWNED_ELEMENT_READ",
                    "Borrowed Region.get cannot copy an owned element. Use Region.replace.",
                    span,
                );
            }
            walk(arguments[1], scope, analysis, Use::Move);
            return Produced::None;
        }
        if name == "@region.set" && arguments.len() == 3 {
            // A polymorphic prelude wrapper carries its Region as a symbolic
            // parameter until a concrete call substitutes the caller's
            // authority. Do not synthesize owned element lineage here: set is
            // precisely the unrestricted-element operation, and doing so
            // would falsely classify every generic Region as owned.
            let region = walk(arguments[0], scope, analysis, Use::Move);
            walk(arguments[1], scope, analysis, Use::Move);
            let replacement = walk(arguments[2], scope, analysis, Use::Move);
            let owned_contents = matches!(
                &region,
                Produced::Region { elements, .. }
                    if obligation(elements) != Obligation::None
            );
            if owned_contents || obligation(&replacement) != Obligation::None {
                analysis.report(
                    "BLOT_REGION_OWNED_ELEMENT",
                    "Region.set may discard an owned element. Use Region.replace.",
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
        if name == "@region.replace" && arguments.len() == 3 {
            let region = region_authority(walk(arguments[0], scope, analysis, Use::Move));
            walk(arguments[1], scope, analysis, Use::Move);
            let replacement = walk(arguments[2], scope, analysis, Use::Move);
            let (displaced, successor) = match &region {
                Produced::Region {
                    qualifier,
                    root,
                    splits,
                    elements,
                } => {
                    let (displaced, remainder) = ownership_parts(elements, span);
                    (
                        displaced,
                        Produced::Region {
                            qualifier: *qualifier,
                            root: *root,
                            splits: splits.clone(),
                            elements: Box::new(combine(remainder, replacement.clone())),
                        },
                    )
                }
                _ => (Produced::None, region.clone()),
            };
            return Produced::Choice(BTreeMap::from([
                (
                    "Replaced".to_owned(),
                    Produced::Variant(Box::new(Produced::Sequence(vec![displaced, successor]))),
                ),
                (
                    "ReplaceOutOfBounds".to_owned(),
                    Produced::Variant(Box::new(Produced::Sequence(vec![replacement, region]))),
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
            let (qualifier, root, splits, elements) = match region.clone() {
                Produced::Region {
                    qualifier,
                    root,
                    splits,
                    elements,
                } => (qualifier, root, splits, elements),
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
            let (left_elements, right_elements) = ownership_parts(&elements, span);
            let left = Produced::Region {
                qualifier,
                root,
                splits: left_splits,
                elements: Box::new(left_elements),
            };
            let right = Produced::Region {
                qualifier,
                root,
                splits: right_splits,
                elements: Box::new(right_elements),
            };
            // The witness is the recombination proof as a value: it records
            // which two element-free part authorities rejoin into which
            // element-free parent. Live element obligations travel with the
            // regions and are recombined when the witness is consumed.
            let witness = Produced::RegionWitness {
                left: Box::new(region_proof_part(&left).expect("split produced a left Region")),
                right: Box::new(region_proof_part(&right).expect("split produced a right Region")),
                parent: Box::new(region_proof_part(&region).expect("split consumed a Region")),
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
        if (name == "@region.reassociate_left" || name == "@region.reassociate_right")
            && arguments.len() == 2
        {
            let outer = walk(arguments[0], scope, analysis, Use::Move);
            let inner = walk(arguments[1], scope, analysis, Use::Move);
            let direction = u8::from(name == "@region.reassociate_right");
            return reassociate_region(direction, outer, inner, span, analysis);
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
                Produced::Region {
                    splits, elements, ..
                } if splits.is_empty() => return *elements,
                _ => analysis.report(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region authority can be frozen. Rejoin every split first.",
                    analysis.module.arena.expression_span(arguments[0]),
                ),
            }
            return Produced::None;
        }
        if (name == "@array.take" || name == "@array.split") && arguments.len() == 2 {
            let array = walk(arguments[0], scope, analysis, Use::Move);
            walk(arguments[1], scope, analysis, Use::Move);
            if name == "@array.take" {
                if let Produced::Store(elements) = &array
                    && let Produced::Sequence(elements) = elements.as_ref()
                    && let Expression::Int { value, .. } =
                        &analysis.module.arena.expressions[arguments[1].0 as usize]
                    && let Some(position) = num_traits::ToPrimitive::to_usize(value)
                    && let Some(selected) = elements.get(position)
                {
                    let remainder = elements
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| *index != position)
                        .map(|(_, value)| value.clone())
                        .collect();
                    return Produced::Sequence(vec![
                        selected.clone(),
                        Produced::Store(Box::new(Produced::Sequence(remainder))),
                    ]);
                }
                if let Produced::Sequence(elements) = &array
                    && let Expression::Int { value, .. } =
                        &analysis.module.arena.expressions[arguments[1].0 as usize]
                    && let Some(position) = num_traits::ToPrimitive::to_usize(value)
                    && let Some(selected) = elements.get(position)
                {
                    let remainder = elements
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| *index != position)
                        .map(|(_, value)| value.clone())
                        .collect();
                    return Produced::Sequence(vec![
                        selected.clone(),
                        Produced::Sequence(remainder),
                    ]);
                }
                if matches!(
                    &array,
                    Produced::StoreParameter {
                        shareable: true,
                        ..
                    }
                ) {
                    return Produced::Sequence(vec![Produced::None, array]);
                }
                if let Produced::Store(elements) = &array
                    && obligation_without_stores(elements) == Obligation::None
                {
                    return Produced::Sequence(vec![
                        Produced::None,
                        Produced::Store(elements.clone()),
                    ]);
                }
                let qualifier = match obligation(&array) {
                    Obligation::Linear => Qualifier::Linear,
                    Obligation::Affine => Qualifier::Affine,
                    Obligation::None => return Produced::Sequence(vec![Produced::None; 2]),
                };
                return Produced::Sequence(vec![Produced::Leaf(qualifier); 2]);
            }
            if let Produced::Store(elements) = &array
                && let Produced::Sequence(elements) = elements.as_ref()
                && let Expression::Int { value, .. } =
                    &analysis.module.arena.expressions[arguments[1].0 as usize]
                && let Some(position) = num_traits::ToPrimitive::to_usize(value)
                && let Some(selected) = elements.get(position)
            {
                let before =
                    Produced::Store(Box::new(Produced::Sequence(elements[..position].to_vec())));
                let after = Produced::Store(Box::new(Produced::Sequence(
                    elements[position + 1..].to_vec(),
                )));
                return Produced::Sequence(vec![before, selected.clone(), after]);
            }
            if let Produced::Sequence(elements) = &array
                && let Expression::Int { value, .. } =
                    &analysis.module.arena.expressions[arguments[1].0 as usize]
                && let Some(position) = num_traits::ToPrimitive::to_usize(value)
                && let Some(selected) = elements.get(position)
            {
                let before = elements[..position].to_vec();
                let after = elements[position + 1..].to_vec();
                return Produced::Sequence(vec![
                    Produced::Sequence(before),
                    selected.clone(),
                    Produced::Sequence(after),
                ]);
            }
            let qualifier = match obligation(&array) {
                Obligation::Linear => Qualifier::Linear,
                Obligation::Affine => Qualifier::Affine,
                Obligation::None => return Produced::Sequence(vec![Produced::None; 3]),
            };
            return Produced::Sequence(vec![Produced::Leaf(qualifier); 3]);
        }
        if name == "@array.len" && arguments.len() == 1 {
            prepare_array_operand(arguments[0], scope, analysis);
            walk(arguments[0], scope, analysis, Use::Borrow);
            return Produced::None;
        }
        if name == "@shape.names" && arguments.len() == 1 {
            walk(arguments[0], scope, analysis, Use::Project);
            return Produced::Store(Box::new(Produced::None));
        }
        if name == "@array.get" && arguments.len() == 2 {
            prepare_array_operand(arguments[0], scope, analysis);
            let array = walk(arguments[0], scope, analysis, Use::Borrow);
            walk(arguments[1], scope, analysis, Use::Move);
            let elements = match &array {
                Produced::Borrow(array) => match array.as_ref() {
                    Produced::Store(elements) => elements.as_ref(),
                    value => value,
                },
                value => value,
            };
            if obligation_without_stores(elements) != Obligation::None {
                analysis.report(
                    "BLOT_LINEAR_ARRAY_READ",
                    "Reading an array element would copy an owned value.",
                    span,
                );
            }
            return shared_array_result(expression, Produced::None, analysis);
        }
        if name == "@array.set" && arguments.len() == 3 {
            let array = walk(arguments[0], scope, analysis, Use::Move);
            walk(arguments[1], scope, analysis, Use::Move);
            let replacement = walk(arguments[2], scope, analysis, Use::Move);
            if matches!(array, Produced::SharedStore) {
                analysis.report(
                    "BLOT_SHARED_ARRAY_UPDATE",
                    "This array may be shared. Use `Array.copy` before updating it.",
                    analysis.module.arena.expression_span(arguments[0]),
                );
                return Produced::SharedStore;
            }
            if matches!(array, Produced::EmptyStore) {
                return Produced::EmptyStore;
            }
            if let Produced::Store(elements) = array {
                let mut elements = *elements;
                if let Produced::Sequence(values) = &mut elements
                    && let Expression::Int { value, .. } =
                        &analysis.module.arena.expressions[arguments[1].0 as usize]
                    && let Some(index) = num_traits::ToPrimitive::to_usize(value)
                    && let Some(displaced) = values.get_mut(index)
                {
                    if obligation_without_stores(displaced) == Obligation::Linear {
                        analysis.report(
                            "BLOT_LINEAR_ARRAY_OVERWRITE",
                            "Replacing this array element would discard a linear resource.",
                            span,
                        );
                    }
                    *displaced = replacement;
                } else {
                    elements = combine(elements, replacement);
                }
                return Produced::Store(Box::new(elements));
            }
            return combine(array, replacement);
        }
        if name == "@array.push" && arguments.len() == 2 {
            let array = walk(arguments[0], scope, analysis, Use::Move);
            let value = walk(arguments[1], scope, analysis, Use::Move);
            if matches!(array, Produced::SharedStore) {
                analysis.report(
                    "BLOT_SHARED_ARRAY_UPDATE",
                    "This array may be shared. Use `Array.copy` before updating it.",
                    analysis.module.arena.expression_span(arguments[0]),
                );
                return Produced::SharedStore;
            }
            if matches!(array, Produced::EmptyStore) {
                return Produced::Store(Box::new(Produced::Sequence(vec![value])));
            }
            if let Produced::Store(elements) = array {
                let mut elements = *elements;
                if let Produced::Sequence(values) = &mut elements {
                    values.push(value);
                } else {
                    elements = combine(elements, value);
                }
                return Produced::Store(Box::new(elements));
            }
            return combine(array, value);
        }
        if name == "@array.copy" && arguments.len() == 1 {
            let source = walk(arguments[0], scope, analysis, Use::Move);
            return match source {
                Produced::Store(_) => source,
                Produced::EmptyStore => Produced::Store(Box::new(Produced::Sequence(Vec::new()))),
                _ => Produced::Store(Box::new(Produced::None)),
            };
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
    let (parameter, input, result, callback_requirements, defining_module) =
        function_contract(function, &callee, scope, analysis);
    let contract_module = defining_module.as_deref().unwrap_or(analysis.module);
    let opaque_callback = if parameter.is_none() {
        expression_parameter_source(function, scope, analysis)
    } else {
        None
    };
    let relational_callback =
        opaque_callback.is_some() && contains_explicit_ownership_handoff(argument, analysis.module);
    let argument_value = if relational_callback {
        walk(argument, scope, analysis, Use::Move)
    } else {
        walk_call_argument(
            argument,
            parameter,
            &input,
            contract_module,
            scope,
            analysis,
        )
    };
    if contains_borrow(&argument_value)
        && !parameter_accepts_borrow(parameter, &argument_value, contract_module)
        && !trusted_borrow_operation(function, analysis.module)
    {
        analysis.report(
            "BLOT_BORROW_ARGUMENT_ESCAPES",
            "The called function does not promise to borrow this argument.",
            analysis.module.arena.expression_span(argument),
        );
    }
    if let Some((source, path)) = opaque_callback
        && relational_callback
        && obligation(&argument_value) != Obligation::None
    {
        return Produced::PendingCallback {
            source,
            path,
            input: Box::new(argument_value),
        };
    }
    if (obligation(&argument_value) != Obligation::None
        || (contains_shared(&argument_value) && demands_ownership(&input)))
        && !parameter_accepts_ownership(&input, &argument_value)
        && !trusted_scalar_operation(function, analysis.module)
        && !(obligation(&argument_value) == Obligation::Affine
            && local_recursive_call(function, scope, analysis))
    {
        analysis.report(
            "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
            "The called function does not promise to consume this owned argument.",
            analysis.module.arena.expression_span(argument),
        );
    }
    validate_callback_requirements(
        &callback_requirements,
        parameter,
        argument,
        contract_module,
        scope,
        analysis,
    );
    let result = substitute_parameters(result, parameter, &argument_value, contract_module);
    shared_array_result(
        expression,
        resolve_pending(result, span, analysis),
        analysis,
    )
}

fn contains_explicit_ownership_handoff(expression: ExpressionId, module: &Module) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Apply { .. } => {
            let (callee, arguments) = application_spine(expression, module);
            if matches!(
                &module.arena.expressions[callee.0 as usize],
                Expression::Intrinsic { name, .. }
                    if name == "@linear.own" || name == "@linear.maybe"
            ) {
                return true;
            }
            arguments
                .iter()
                .any(|argument| contains_explicit_ownership_handoff(*argument, module))
        }
        Expression::Tuple { elements, .. } => elements
            .iter()
            .any(|element| contains_explicit_ownership_handoff(*element, module)),
        Expression::Array { elements, .. } => elements
            .iter()
            .any(|element| contains_explicit_ownership_handoff(element.value, module)),
        Expression::Shape { members, .. } => members.iter().any(|member| match member {
            ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                contains_explicit_ownership_handoff(*value, module)
            }
        }),
        _ => false,
    }
}

fn validate_callback_requirements(
    requirements: &[CallbackRequirement],
    parameter: Option<PatternId>,
    argument: ExpressionId,
    parameter_module: &Module,
    scope: &ScopeRef,
    analysis: &mut Analysis<'_>,
) {
    let Some(parameter) = parameter else {
        return;
    };
    for requirement in requirements {
        let Some(callback) = callback_argument_expression(
            parameter,
            argument,
            requirement.source,
            parameter_module,
            analysis.module,
        ) else {
            analysis.report(
                "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
                "The callback argument cannot be resolved to discharge its ownership relation.",
                analysis.module.arena.expression_span(argument),
            );
            continue;
        };
        let Some(callback) = expression_at_path(callback, &requirement.path, analysis.module)
        else {
            analysis.report(
                "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
                "The selected callback value cannot be resolved to discharge its ownership relation.",
                analysis.module.arena.expression_span(argument),
            );
            continue;
        };
        let (callback_parameter, callback_input, callback_result, _, defining_module) =
            function_contract(callback, &Produced::None, scope, analysis);
        let callback_module = defining_module.as_deref().unwrap_or(analysis.module);
        if analysis
            .expression_types
            .get(&callback)
            .and_then(function_parameter_type)
            .is_some_and(|type_| !relation_may_carry_ownership(&requirement.input, type_))
        {
            continue;
        }
        let Some(expected_result) = instantiate_callback_requirement(
            &requirement.input,
            &requirement.result,
            &callback_input,
        ) else {
            analysis.report(
                "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
                "This callback does not consume the authorities required by the higher-order function.",
                analysis.module.arena.expression_span(callback),
            );
            continue;
        };
        if callback_parameter.is_none() {
            analysis.report(
                "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
                "The callback has no checked ownership contract.",
                analysis.module.arena.expression_span(callback),
            );
            continue;
        }
        let substituted = substitute_parameters(
            callback_result,
            callback_parameter,
            &callback_input,
            callback_module,
        );
        let substituted = resolve_pending(
            substituted,
            analysis.module.arena.expression_span(callback),
            analysis,
        );
        if substituted != expected_result {
            analysis.report(
                "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
                "This callback does not return each consumed authority in the required result alternative.",
                analysis.module.arena.expression_span(callback),
            );
        }
    }
}

fn instantiate_callback_requirement(
    input: &Produced,
    result: &Produced,
    actual: &Produced,
) -> Option<Produced> {
    let mut result = result.clone();
    if match_callback_requirement_input(input, actual, &mut result) {
        Some(result)
    } else {
        None
    }
}

fn match_callback_requirement_input(
    expected: &Produced,
    actual: &Produced,
    result: &mut Produced,
) -> bool {
    match (expected, actual) {
        (Produced::None, _) => true,
        (Produced::Parameter { source, .. }, actual)
            if obligation(expected) != Obligation::None
                && obligation(actual) != Obligation::None =>
        {
            *result = substitute_parameter_source(result.clone(), *source, actual);
            true
        }
        (Produced::StoreParameter { source, .. }, actual)
            if obligation(actual) != Obligation::None =>
        {
            *result = substitute_parameter_source(result.clone(), *source, actual);
            true
        }
        (Produced::Sequence(expected), Produced::Sequence(actual)) => {
            expected.len() == actual.len()
                && expected.iter().zip(actual).all(|(expected, actual)| {
                    match_callback_requirement_input(expected, actual, result)
                })
        }
        (Produced::Shape(expected), Produced::Shape(actual)) => {
            expected.iter().all(|(name, expected)| {
                actual.get(name).is_some_and(|actual| {
                    match_callback_requirement_input(expected, actual, result)
                })
            })
        }
        (Produced::Variant(expected), Produced::Variant(actual)) => {
            match_callback_requirement_input(expected, actual, result)
        }
        _ => parameter_accepts_ownership(expected, actual),
    }
}

fn function_parameter_type(type_: &Type) -> Option<&Type> {
    match type_ {
        Type::Forall { body, .. } => function_parameter_type(body),
        Type::Function { parameter, .. } => Some(parameter),
        _ => None,
    }
}

fn relation_may_carry_ownership(produced: &Produced, type_: &Type) -> bool {
    match produced {
        Produced::None | Produced::SharedStore | Produced::EmptyStore | Produced::Borrow(_) => {
            false
        }
        Produced::Sequence(values) => values.iter().enumerate().any(|(index, value)| {
            let field = match type_ {
                Type::Record(fields) => fields
                    .iter()
                    .find(|(name, _)| name == &index.to_string())
                    .map(|(_, type_)| type_),
                _ => None,
            };
            field.map_or_else(
                || demands_ownership(value),
                |type_| relation_may_carry_ownership(value, type_),
            )
        }),
        Produced::Shape(values) => values.iter().any(|(name, value)| {
            let field = match type_ {
                Type::Record(fields) => fields
                    .iter()
                    .find(|(field, _)| field == name)
                    .map(|(_, type_)| type_),
                _ => None,
            };
            field.map_or_else(
                || demands_ownership(value),
                |type_| relation_may_carry_ownership(value, type_),
            )
        }),
        Produced::Many(values) => values
            .iter()
            .any(|value| relation_may_carry_ownership(value, type_)),
        Produced::Variant(value) => relation_may_carry_ownership(value, type_),
        Produced::Choice(cases) => cases
            .values()
            .any(|value| relation_may_carry_ownership(value, type_)),
        _ => type_may_carry_ownership(type_),
    }
}

fn callback_argument_expression(
    parameter: PatternId,
    argument: ExpressionId,
    expected: PatternId,
    parameter_module: &Module,
    argument_module: &Module,
) -> Option<ExpressionId> {
    if parameter == expected {
        return Some(argument);
    }
    match (
        &parameter_module.arena.patterns[parameter.0 as usize],
        &argument_module.arena.expressions[argument.0 as usize],
    ) {
        (
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. },
            Expression::Tuple {
                elements: values, ..
            },
        ) => elements
            .iter()
            .zip(values)
            .find_map(|(parameter, argument)| {
                callback_argument_expression(
                    *parameter,
                    *argument,
                    expected,
                    parameter_module,
                    argument_module,
                )
            }),
        (Pattern::Shape { fields, .. }, Expression::Shape { members, .. }) => {
            fields.iter().find_map(|field| {
                let value = members.iter().find_map(|member| match member {
                    ShapeMember::Field { name, value, .. } if name == &field.name => Some(*value),
                    _ => None,
                })?;
                callback_argument_expression(
                    field.pattern,
                    value,
                    expected,
                    parameter_module,
                    argument_module,
                )
            })
        }
        _ => None,
    }
}

fn expression_at_path(
    mut expression: ExpressionId,
    path: &[String],
    module: &Module,
) -> Option<ExpressionId> {
    for expected in path {
        let selected = match &module.arena.expressions[expression.0 as usize] {
            Expression::Shape { members, .. } => members.iter().find_map(|member| match member {
                ShapeMember::Field { name, value, .. } if name == expected => Some(*value),
                _ => None,
            }),
            Expression::Tuple { elements, .. } => expected
                .parse::<usize>()
                .ok()
                .and_then(|index| elements.get(index).copied()),
            Expression::Array { elements, .. } => expected
                .parse::<usize>()
                .ok()
                .and_then(|index| elements.get(index).map(|element| element.value)),
            _ => None,
        };
        expression = selected?;
    }
    Some(expression)
}

fn demands_ownership(input: &Produced) -> bool {
    match input {
        Produced::Leaf(Qualifier::Linear | Qualifier::Affine)
        | Produced::Parameter {
            qualifier: Qualifier::Linear | Qualifier::Affine,
            ..
        }
        | Produced::StoreParameter { .. } => true,
        Produced::Sequence(values) | Produced::Many(values) => values.iter().any(demands_ownership),
        Produced::Shape(fields) | Produced::Choice(fields) => {
            fields.values().any(demands_ownership)
        }
        Produced::Variant(value) => demands_ownership(value),
        _ => false,
    }
}

fn local_recursive_call(function: ExpressionId, scope: &ScopeRef, analysis: &Analysis<'_>) -> bool {
    let Expression::Var { name, .. } = &analysis.module.arena.expressions[function.0 as usize]
    else {
        return false;
    };
    analysis
        .lookup(scope, name)
        .and_then(|(binding, _)| binding.borrow().value)
        .is_some_and(|value| {
            matches!(
                analysis.module.arena.expressions[value.0 as usize],
                Expression::Rec { .. }
            )
        })
}

fn walk_call_argument(
    argument: ExpressionId,
    parameter: Option<PatternId>,
    input: &Produced,
    parameter_module: &Module,
    scope: &ScopeRef,
    analysis: &mut Analysis,
) -> Produced {
    let Some(parameter) = parameter else {
        return walk_unowned_argument(argument, input, scope, analysis);
    };
    let no_input = Produced::None;
    match (
        &parameter_module.arena.patterns[parameter.0 as usize],
        &analysis.module.arena.expressions[argument.0 as usize],
    ) {
        (
            Pattern::Name {
                qualifier: Qualifier::Borrow,
                ..
            },
            _,
        ) => {
            let value = walk(argument, scope, analysis, Use::Borrow);
            if matches!(value, Produced::Borrow(_)) {
                value
            } else {
                borrowed(value)
            }
        }
        (
            Pattern::Tuple { elements, .. },
            Expression::Tuple {
                elements: values, ..
            },
        ) if elements.len() == values.len() => Produced::Sequence(
            elements
                .iter()
                .zip(values)
                .enumerate()
                .map(|(index, (parameter, argument))| {
                    let input = match input {
                        Produced::Sequence(inputs) => inputs.get(index).unwrap_or(&no_input),
                        _ => &no_input,
                    };
                    walk_call_argument(
                        *argument,
                        Some(*parameter),
                        input,
                        parameter_module,
                        scope,
                        analysis,
                    )
                })
                .collect(),
        ),
        _ => walk_unowned_argument(argument, input, scope, analysis),
    }
}

fn walk_unowned_argument(
    argument: ExpressionId,
    input: &Produced,
    scope: &ScopeRef,
    analysis: &mut Analysis,
) -> Produced {
    if demands_ownership(input) {
        return walk(argument, scope, analysis, Use::Move);
    }
    share_concrete_stores(walk(argument, scope, analysis, Use::Share))
}

fn shared_array_result(
    expression: ExpressionId,
    produced: Produced,
    analysis: &Analysis<'_>,
) -> Produced {
    if !matches!(produced, Produced::None) {
        return produced;
    }
    if matches!(
        analysis.callee_value(expression),
        Some(Value::Array(elements)) if elements.is_empty()
    ) || matches!(
        analysis.callee_value(expression),
        Some(Value::EmptyArray { .. })
    ) {
        return Produced::EmptyStore;
    }
    if matches!(
        analysis.expression_types.get(&expression),
        Some(Type::Array(_))
    ) {
        return Produced::SharedStore;
    }
    produced
}

fn prepare_array_binding(
    expression: ExpressionId,
    name: &str,
    scope: &ScopeRef,
    analysis: &Analysis<'_>,
) {
    if !matches!(
        analysis.expression_types.get(&expression),
        Some(Type::Array(_))
    ) {
        return;
    }
    let Some((binding, _)) = analysis.lookup(scope, name) else {
        return;
    };
    let mut binding = binding.borrow_mut();
    if !matches!(binding.owned, Produced::None) || binding.qualifier != Qualifier::None {
        return;
    }
    if let Some((source, path)) = binding.parameter_source.clone() {
        let shareable = array_parameter_shareable(expression, analysis);
        binding.qualifier = Qualifier::Affine;
        binding.owned = Produced::StoreParameter {
            source,
            path: path.clone(),
            shareable,
        };
        drop(binding);
        record_store_parameter_authority(source, &path, shareable, analysis);
    } else {
        binding.owned = Produced::SharedStore;
    }
}

fn prepare_array_operand(expression: ExpressionId, scope: &ScopeRef, analysis: &Analysis<'_>) {
    let Expression::Var { name, .. } = &analysis.module.arena.expressions[expression.0 as usize]
    else {
        return;
    };
    let Some((binding, _)) = analysis.lookup(scope, name) else {
        return;
    };
    let mut binding = binding.borrow_mut();
    if !matches!(binding.owned, Produced::None) || binding.qualifier != Qualifier::None {
        return;
    }
    if let Some((source, path)) = binding.parameter_source.clone() {
        let shareable = array_parameter_shareable(expression, analysis);
        binding.qualifier = Qualifier::Affine;
        binding.owned = Produced::StoreParameter {
            source,
            path: path.clone(),
            shareable,
        };
        drop(binding);
        record_store_parameter_authority(source, &path, shareable, analysis);
    } else {
        binding.owned = Produced::SharedStore;
    }
}

fn record_store_parameter_authority(
    source: PatternId,
    path: &[String],
    shareable: bool,
    analysis: &Analysis<'_>,
) {
    let Some(root) = analysis
        .bindings
        .iter()
        .find(|binding| binding.borrow().pattern == source)
        .cloned()
    else {
        return;
    };
    let authority = Produced::StoreParameter {
        source,
        path: path.to_vec(),
        shareable,
    };
    let mut root = root.borrow_mut();
    root.owned = insert_parameter_authority(root.owned.clone(), path, authority);
    root.qualifier = inherited(root.qualifier, &root.owned);
    if !path.is_empty() {
        root.partial = true;
    }
}

fn insert_parameter_authority(
    produced: Produced,
    path: &[String],
    authority: Produced,
) -> Produced {
    let Some((name, rest)) = path.split_first() else {
        return authority;
    };
    let mut fields = match produced {
        Produced::Shape(fields) => fields,
        _ => BTreeMap::new(),
    };
    let current = fields.remove(name).unwrap_or(Produced::None);
    fields.insert(
        name.clone(),
        insert_parameter_authority(current, rest, authority),
    );
    Produced::Shape(fields)
}

fn runtime_array_expression(expression: ExpressionId, analysis: &Analysis<'_>) -> bool {
    let Some(Type::Array(element)) = analysis.expression_types.get(&expression) else {
        return false;
    };
    !contains_type_value(element)
}

fn array_parameter_shareable(expression: ExpressionId, analysis: &Analysis<'_>) -> bool {
    let Some(Type::Array(element)) = analysis.expression_types.get(&expression) else {
        return false;
    };
    !type_may_carry_ownership(element)
}

fn type_may_carry_ownership(type_: &Type) -> bool {
    match type_ {
        Type::Variable(_) | Type::Rigid(_) | Type::Top => true,
        Type::Forall { body, .. } => type_may_carry_ownership(body),
        Type::Function { .. } | Type::Array(_) | Type::Region(_) | Type::Scratch(_) => true,
        Type::Record(fields) => fields
            .iter()
            .any(|(_, type_)| type_may_carry_ownership(type_)),
        Type::Variant { cases, .. } => cases
            .iter()
            .any(|(_, type_)| type_may_carry_ownership(type_)),
        Type::Union(types) => types.iter().any(type_may_carry_ownership),
        Type::Range { .. }
        | Type::Unit
        | Type::Effects(_)
        | Type::OpenEffects { .. }
        | Type::Opaque(_)
        | Type::Bottom => false,
    }
}

fn contains_type_value(type_: &Type) -> bool {
    match type_ {
        Type::Opaque(name) => name == "Type",
        Type::Forall { body, .. }
        | Type::Array(body)
        | Type::Region(body)
        | Type::Scratch(body) => contains_type_value(body),
        Type::Function {
            parameter,
            effects,
            result,
        } => {
            contains_type_value(parameter)
                || contains_type_value(effects)
                || contains_type_value(result)
        }
        Type::Record(fields) => fields.iter().any(|(_, field)| contains_type_value(field)),
        Type::Variant { cases, .. } => cases
            .iter()
            .any(|(_, payload)| contains_type_value(payload)),
        Type::OpenEffects { tail, .. } => contains_type_value(tail),
        Type::Union(members) => members.iter().any(contains_type_value),
        _ => false,
    }
}

fn function_contract(
    expression: ExpressionId,
    produced: &Produced,
    scope: &ScopeRef,
    analysis: &Analysis,
) -> FunctionContract {
    if let Produced::Closure {
        parameter, result, ..
    } = produced
    {
        let contract = analysis
            .contracts
            .values()
            .find(|contract| contract.parameter == *parameter && contract.result == **result)
            .cloned();
        let input = contract
            .as_ref()
            .map(|contract| contract.input.clone())
            .unwrap_or(Produced::None);
        let requirements = contract
            .map(|contract| contract.callback_requirements)
            .unwrap_or_default();
        return (
            Some(*parameter),
            input,
            (**result).clone(),
            requirements,
            None,
        );
    }
    match analysis.module.arena.expressions[expression.0 as usize] {
        Expression::Lambda {
            parameter, body, ..
        } => (
            Some(parameter),
            analysis
                .contracts
                .get(&body)
                .map(|contract| contract.input.clone())
                .unwrap_or(Produced::None),
            analysis
                .function_results
                .get(&expression)
                .cloned()
                .unwrap_or(Produced::None),
            analysis
                .contracts
                .get(&body)
                .map(|contract| contract.callback_requirements.clone())
                .unwrap_or_default(),
            None,
        ),
        Expression::Rec { lambda, .. } => {
            match analysis.module.arena.expressions[lambda.0 as usize] {
                Expression::Lambda {
                    parameter, body, ..
                } => (
                    Some(parameter),
                    analysis
                        .contracts
                        .get(&body)
                        .map(|contract| contract.input.clone())
                        .unwrap_or(Produced::None),
                    analysis
                        .function_results
                        .get(&lambda)
                        .cloned()
                        .unwrap_or(Produced::None),
                    analysis
                        .contracts
                        .get(&body)
                        .map(|contract| contract.callback_requirements.clone())
                        .unwrap_or_default(),
                    None,
                ),
                _ => (None, Produced::None, Produced::None, Vec::new(), None),
            }
        }
        Expression::Var { ref name, .. } => {
            let local = analysis.lookup(scope, name).map(|(binding, _)| {
                let binding = binding.borrow();
                (
                    binding.parameter,
                    binding.input.clone(),
                    binding.result.clone(),
                    binding.callback_requirements.clone(),
                    binding.contract_module.clone(),
                )
            });
            if matches!(local, Some((Some(_), _, _, _, _))) {
                return local.expect("matched local ownership contract");
            }
            imported_function_contract(expression, analysis)
                .or(local)
                .unwrap_or((None, Produced::None, Produced::None, Vec::new(), None))
        }
        _ => imported_function_contract(expression, analysis).unwrap_or((
            None,
            Produced::None,
            Produced::None,
            Vec::new(),
            None,
        )),
    }
}

fn declaration_function_contract(
    expression: ExpressionId,
    produced: &Produced,
    tags: &[DeclarationTag],
    scope: &ScopeRef,
    analysis: &Analysis,
) -> FunctionContract {
    let contract = function_contract(expression, produced, scope, analysis);
    if contract.0.is_some()
        || tags.is_empty()
        || !tags.iter().all(|tag| reuse_identity_tag(tag, analysis))
    {
        return contract;
    }
    let Expression::Block { declarations, .. } =
        &analysis.module.arena.expressions[expression.0 as usize]
    else {
        return contract;
    };
    let Some(Declaration::Binding { value, .. }) = declarations
        .last()
        .map(|declaration| &analysis.module.arena.declarations[declaration.0 as usize])
    else {
        return contract;
    };
    function_contract(*value, &Produced::None, scope, analysis)
}

fn reuse_identity_tag(tag: &DeclarationTag, analysis: &Analysis<'_>) -> bool {
    let Some(Value::Shape(fields)) = analysis.callee_value(tag.descriptor) else {
        return false;
    };
    matches!(
        fields.get("transform"),
        Some(Value::Primitive {
            name,
            arity: 1,
            applied,
        }) if name == "@assert.reuse" && applied.is_empty()
    )
}

fn imported_function_contract(
    expression: ExpressionId,
    analysis: &Analysis,
) -> Option<FunctionContract> {
    let Value::Closure { module, body, .. } = analysis.callee_value(expression)? else {
        return None;
    };
    let defining_module = analysis
        .context
        .modules
        .borrow()
        .get(module.as_str())?
        .module
        .clone();
    let contract = if std::ptr::eq(defining_module.as_ref(), analysis.module) {
        analysis.contracts.get(&body).cloned()
    } else {
        analysis
            .context
            .ownership_contracts
            .borrow()
            .get(&(module.as_ref().clone(), body))
            .cloned()
    }?;
    Some((
        Some(contract.parameter),
        contract.input,
        contract.result,
        contract.callback_requirements,
        Some(defining_module),
    ))
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
                name: _,
                payload: Some(payload),
                ..
            },
            Produced::Variant(value),
        ) => substitute_parameters(produced, Some(*payload), value, module),
        (
            Pattern::Constructor {
                name,
                payload: Some(payload),
                ..
            },
            Produced::Choice(cases),
        ) => cases.get(name).map_or(produced.clone(), |value| {
            let Produced::Variant(value) = value else {
                return produced.clone();
            };
            substitute_parameters(produced, Some(*payload), value, module)
        }),
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
        Produced::SharedStore => Produced::SharedStore,
        Produced::EmptyStore => Produced::EmptyStore,
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
        Produced::StoreParameter {
            source: found,
            path,
            shareable,
        } => {
            if found == source {
                project_parameter_argument(argument, &path)
            } else {
                Produced::StoreParameter {
                    source: found,
                    path,
                    shareable,
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
        Produced::Store(elements) => Produced::Store(Box::new(substitute_parameter_source(
            *elements, source, argument,
        ))),
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
        Produced::PendingCallback {
            source: found,
            path,
            input,
        } => Produced::PendingCallback {
            source: found,
            path,
            input: Box::new(substitute_parameter_source(*input, source, argument)),
        },
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
        Produced::PendingScratchRecycle {
            source: recycle_source,
        } => Produced::PendingScratchRecycle {
            source: Box::new(substitute_parameter_source(
                *recycle_source,
                source,
                argument,
            )),
        },
        Produced::PendingReassociate {
            direction,
            part,
            outer,
            inner,
        } => Produced::PendingReassociate {
            direction,
            part,
            outer: Box::new(substitute_parameter_source(*outer, source, argument)),
            inner: Box::new(substitute_parameter_source(*inner, source, argument)),
        },
        Produced::Region {
            qualifier,
            root,
            splits,
            elements,
        } => {
            if root != Some(source) {
                let elements = substitute_store_contents(*elements, source, argument);
                return Produced::Region {
                    qualifier,
                    root,
                    splits,
                    elements: Box::new(elements),
                };
            }
            match argument {
                Produced::Region {
                    root: argument_root,
                    splits: argument_splits,
                    elements: argument_elements,
                    ..
                } => {
                    let mut composed = argument_splits.clone();
                    composed.extend(splits);
                    let transferred_elements = Box::new(substitute_element_source(
                        *elements,
                        source,
                        argument_elements,
                    ));
                    Produced::Region {
                        qualifier,
                        root: *argument_root,
                        splits: composed,
                        elements: transferred_elements,
                    }
                }
                Produced::Parameter {
                    source: argument_source,
                    ..
                } => Produced::Region {
                    qualifier,
                    root: Some(*argument_source),
                    splits,
                    elements: Box::new(substitute_parameter_source(*elements, source, argument)),
                },
                _ => Produced::Region {
                    qualifier,
                    root,
                    splits,
                    elements: Box::new(substitute_parameter_source(*elements, source, argument)),
                },
            }
        }
    }
}

fn project_parameter_argument(argument: &Produced, path: &[String]) -> Produced {
    let Some((name, rest)) = path.split_first() else {
        return argument.clone();
    };
    let Produced::Shape(fields) = argument else {
        return Produced::SharedStore;
    };
    fields.get(name).map_or(Produced::SharedStore, |value| {
        project_parameter_argument(value, rest)
    })
}

fn substitute_store_contents(
    produced: Produced,
    source: PatternId,
    argument: &Produced,
) -> Produced {
    if let Produced::StoreParameter {
        source: found,
        path,
        ..
    } = &produced
        && *found == source
    {
        return match project_parameter_argument(argument, path) {
            Produced::Store(elements) => *elements,
            Produced::None
            | Produced::SharedStore
            | Produced::EmptyStore
            | Produced::StoreParameter {
                shareable: true, ..
            } => Produced::None,
            argument => argument,
        };
    }
    substitute_parameter_source(produced, source, argument)
}

fn substitute_element_source(
    produced: Produced,
    source: PatternId,
    argument_elements: &Produced,
) -> Produced {
    match produced {
        Produced::None => Produced::None,
        Produced::SharedStore => Produced::SharedStore,
        Produced::EmptyStore => Produced::EmptyStore,
        Produced::Borrow(value) => Produced::Borrow(Box::new(substitute_element_source(
            *value,
            source,
            argument_elements,
        ))),
        Produced::Leaf(qualifier) => Produced::Leaf(qualifier),
        Produced::Parameter {
            qualifier,
            source: found,
        } => {
            if found == source {
                argument_elements.clone()
            } else {
                Produced::Parameter {
                    qualifier,
                    source: found,
                }
            }
        }
        Produced::StoreParameter {
            source: found,
            path,
            shareable,
        } => {
            if found == source {
                project_parameter_argument(argument_elements, &path)
            } else {
                Produced::StoreParameter {
                    source: found,
                    path,
                    shareable,
                }
            }
        }
        Produced::Closure {
            captures,
            parameter,
            result,
        } => Produced::Closure {
            captures: Box::new(substitute_element_source(
                *captures,
                source,
                argument_elements,
            )),
            parameter,
            result: Box::new(substitute_element_source(
                *result,
                source,
                argument_elements,
            )),
        },
        Produced::Many(values) => join(
            values
                .into_iter()
                .map(|value| substitute_element_source(value, source, argument_elements)),
        ),
        Produced::Sequence(values) => Produced::Sequence(
            values
                .into_iter()
                .map(|value| substitute_element_source(value, source, argument_elements))
                .collect(),
        ),
        Produced::Store(elements) => Produced::Store(Box::new(substitute_element_source(
            *elements,
            source,
            argument_elements,
        ))),
        Produced::Shape(fields) => Produced::Shape(
            fields
                .into_iter()
                .map(|(name, value)| {
                    (
                        name,
                        substitute_element_source(value, source, argument_elements),
                    )
                })
                .collect(),
        ),
        Produced::Variant(payload) => Produced::Variant(Box::new(substitute_element_source(
            *payload,
            source,
            argument_elements,
        ))),
        Produced::Choice(cases) => Produced::Choice(
            cases
                .into_iter()
                .map(|(name, value)| {
                    (
                        name,
                        substitute_element_source(value, source, argument_elements),
                    )
                })
                .collect(),
        ),
        Produced::PendingCallback {
            source: found,
            path,
            input,
        } => Produced::PendingCallback {
            source: found,
            path,
            input: Box::new(substitute_element_source(*input, source, argument_elements)),
        },
        Produced::Region {
            qualifier: _,
            root: Some(found),
            splits,
            ..
        } if found == source => {
            let mut selected = argument_elements.clone();
            for (span, part) in splits {
                let (left, right) = ownership_parts(&selected, span);
                selected = if part == 0 { left } else { right };
            }
            selected
        }
        Produced::Region {
            qualifier,
            root,
            splits,
            elements,
        } => Produced::Region {
            qualifier,
            root,
            splits,
            elements: Box::new(substitute_element_source(
                *elements,
                source,
                argument_elements,
            )),
        },
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => Produced::RegionWitness {
            left: Box::new(substitute_element_source(*left, source, argument_elements)),
            right: Box::new(substitute_element_source(*right, source, argument_elements)),
            parent: Box::new(substitute_element_source(
                *parent,
                source,
                argument_elements,
            )),
        },
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => Produced::PendingJoin {
            witness: Box::new(substitute_element_source(
                *witness,
                source,
                argument_elements,
            )),
            left: Box::new(substitute_element_source(*left, source, argument_elements)),
            right: Box::new(substitute_element_source(*right, source, argument_elements)),
        },
        Produced::PendingFreeze { region } => Produced::PendingFreeze {
            region: Box::new(substitute_element_source(
                *region,
                source,
                argument_elements,
            )),
        },
        Produced::PendingScratchRecycle {
            source: recycle_source,
        } => Produced::PendingScratchRecycle {
            source: Box::new(substitute_element_source(
                *recycle_source,
                source,
                argument_elements,
            )),
        },
        Produced::PendingReassociate {
            direction,
            part,
            outer,
            inner,
        } => Produced::PendingReassociate {
            direction,
            part,
            outer: Box::new(substitute_element_source(*outer, source, argument_elements)),
            inner: Box::new(substitute_element_source(*inner, source, argument_elements)),
        },
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

type Snapshot = Vec<(BindingRef, Option<Span>, Produced, bool, bool)>;

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
                    binding_state.ownership_demanded,
                ));
            }
        }
        current = scope.parent.clone();
    }
    snapshot
}

fn restore(snapshot: &Snapshot) {
    for (binding, moved, owned, partial, ownership_demanded) in snapshot {
        let mut binding = binding.borrow_mut();
        binding.moved = *moved;
        binding.owned = owned.clone();
        binding.partial = *partial;
        binding.ownership_demanded = *ownership_demanded;
    }
}

fn agree(outcomes: &[Snapshot], before: &Snapshot, span: Span, analysis: &mut Analysis) {
    if outcomes.is_empty() {
        return;
    }
    for (binding, _, prior_owned, prior_partial, prior_ownership_demanded) in before {
        let states = outcomes
            .iter()
            .map(|outcome| {
                outcome
                    .iter()
                    .find(|(candidate, ..)| Rc::ptr_eq(candidate, binding))
                    .map(|(_, moved, owned, partial, ownership_demanded)| {
                        (*moved, owned.clone(), *partial, *ownership_demanded)
                    })
                    .unwrap_or((
                        None,
                        prior_owned.clone(),
                        *prior_partial,
                        *prior_ownership_demanded,
                    ))
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
                .any(|(_, owned, partial, _)| owned != &first.1 || partial != &first.2)
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
        binding.ownership_demanded = states.iter().any(|state| state.3);
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

fn closure_parameter_type<'a>(body: ExpressionId, analysis: &'a Analysis<'_>) -> Option<&'a Type> {
    let mut type_ = analysis.closure_types.get(&body)?;
    while let Type::Forall { body, .. } = type_ {
        type_ = body;
    }
    let Type::Function { parameter, .. } = type_ else {
        return None;
    };
    Some(parameter)
}

fn closure_result_type<'a>(body: ExpressionId, analysis: &'a Analysis<'_>) -> Option<&'a Type> {
    let mut type_ = analysis.closure_types.get(&body)?;
    while let Type::Forall { body, .. } = type_ {
        type_ = body;
    }
    let Type::Function { result, .. } = type_ else {
        return None;
    };
    Some(result)
}

fn recursive_owned_result(input: &Produced, result_type: Option<&Type>) -> Option<Produced> {
    if !matches!(result_type, Some(Type::Array(_) | Type::Region(_))) {
        return None;
    }
    let mut candidates = Vec::new();
    recursive_owned_candidates(input, &mut candidates);
    if candidates.len() == 1 {
        let candidate = candidates.pop()?;
        if let Some(Type::Region(element)) = result_type {
            let region = region_authority(candidate);
            if type_may_carry_ownership(element) {
                Some(region)
            } else {
                Some(clear_region_elements(region))
            }
        } else {
            Some(candidate)
        }
    } else {
        None
    }
}

fn normalize_unrestricted_region_result(result: Produced, result_type: Option<&Type>) -> Produced {
    match result_type {
        Some(Type::Region(element)) if !type_may_carry_ownership(element) => {
            clear_region_elements(region_authority(result))
        }
        _ => result,
    }
}

fn clear_region_elements(produced: Produced) -> Produced {
    match produced {
        Produced::Region {
            qualifier,
            root,
            splits,
            ..
        } => Produced::Region {
            qualifier,
            root,
            splits,
            elements: Box::new(Produced::None),
        },
        produced => produced,
    }
}

fn recursive_owned_candidates(produced: &Produced, candidates: &mut Vec<Produced>) {
    match produced {
        Produced::StoreParameter { .. }
        | Produced::Parameter {
            qualifier: Qualifier::Linear | Qualifier::Affine,
            ..
        } => candidates.push(produced.clone()),
        Produced::Sequence(values) | Produced::Many(values) => {
            for value in values {
                recursive_owned_candidates(value, candidates);
            }
        }
        Produced::Shape(fields) | Produced::Choice(fields) => {
            for value in fields.values() {
                recursive_owned_candidates(value, candidates);
            }
        }
        Produced::Variant(value) => recursive_owned_candidates(value, candidates),
        _ => {}
    }
}

fn recursive_result_matches(expected: &Produced, result: &Produced) -> bool {
    match (region_proof_part(expected), region_proof_part(result)) {
        (Some(expected), Some(result)) => expected == result,
        _ => expected == result,
    }
}

fn written_parameter_pattern(
    pattern: PatternId,
    module: &Module,
    type_: Option<&Type>,
) -> Produced {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { qualifier, .. } => {
            let written = written_parameter_obligation(*qualifier, pattern);
            if relevant(&written) || !matches!(qualifier, Qualifier::None) {
                return written;
            }
            type_.map_or(Produced::None, |type_| {
                owned_parameter_type(type_, pattern, &[])
            })
        }
        Pattern::Tuple { elements, .. } => {
            let fields = match type_ {
                Some(Type::Record(fields)) => Some(fields),
                _ => None,
            };
            Produced::Sequence(
                elements
                    .iter()
                    .enumerate()
                    .map(|(index, pattern)| {
                        let type_ = fields.and_then(|fields| {
                            fields
                                .iter()
                                .find(|(name, _)| name == &index.to_string())
                                .map(|(_, type_)| type_)
                        });
                        written_parameter_pattern(*pattern, module, type_)
                    })
                    .collect(),
            )
        }
        Pattern::Array { elements, .. } => Produced::Sequence(
            elements
                .iter()
                .map(|pattern| written_parameter_pattern(*pattern, module, None))
                .collect(),
        ),
        Pattern::Constructor { payload, .. } => Produced::Variant(Box::new(
            payload
                .map(|payload| written_parameter_pattern(payload, module, None))
                .unwrap_or(Produced::None),
        )),
        Pattern::Shape { fields, .. } => Produced::Shape(
            fields
                .iter()
                .map(|field| {
                    let field_type = match type_ {
                        Some(Type::Record(types)) => types
                            .iter()
                            .find(|(name, _)| name == &field.name)
                            .map(|(_, type_)| type_),
                        _ => None,
                    };
                    (
                        field.name.clone(),
                        written_parameter_pattern(field.pattern, module, field_type),
                    )
                })
                .collect(),
        ),
        _ => Produced::None,
    }
}

fn owned_parameter_type(type_: &Type, source: PatternId, path: &[String]) -> Produced {
    match type_ {
        Type::Forall { body, .. } => owned_parameter_type(body, source, path),
        Type::Array(element) => Produced::StoreParameter {
            source,
            path: path.to_vec(),
            shareable: !type_may_carry_ownership(element),
        },
        Type::Scratch(_) => Produced::StoreParameter {
            source,
            path: path.to_vec(),
            shareable: false,
        },
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
        Produced::None | Produced::SharedStore | Produced::EmptyStore | Produced::Borrow(_) => {
            Obligation::None
        }
        Produced::Leaf(Qualifier::Linear)
        | Produced::Parameter {
            qualifier: Qualifier::Linear,
            ..
        } => Obligation::Linear,
        Produced::Leaf(Qualifier::Affine)
        | Produced::Parameter {
            qualifier: Qualifier::Affine,
            ..
        }
        | Produced::StoreParameter { .. } => Obligation::Affine,
        Produced::Leaf(_) | Produced::Parameter { .. } => Obligation::None,
        Produced::Store(elements) => merge_obligation(Obligation::Affine, obligation(elements)),
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
        Produced::PendingReassociate { .. } => Obligation::Linear,
        Produced::PendingCallback { input, .. } => obligation(input),
        // A pending freeze already consumed its authority; only the deferred
        // full-root proof remains, discharged where substitution lands.
        Produced::PendingFreeze { .. } => Obligation::None,
        // Recycle consumed its input and promises a fresh affine Scratch.
        Produced::PendingScratchRecycle { .. } => Obligation::Affine,
    }
}

fn obligation_without_stores(produced: &Produced) -> Obligation {
    match produced {
        Produced::Store(elements) => obligation_without_stores(elements),
        Produced::StoreParameter { .. } => Obligation::None,
        Produced::Borrow(_)
        | Produced::None
        | Produced::SharedStore
        | Produced::EmptyStore
        | Produced::PendingFreeze { .. } => Obligation::None,
        Produced::PendingScratchRecycle { .. } => Obligation::Affine,
        Produced::Closure { captures, .. } | Produced::Variant(captures) => {
            obligation_without_stores(captures)
        }
        Produced::Many(values) | Produced::Sequence(values) => {
            values.iter().fold(Obligation::None, |found, value| {
                merge_obligation(found, obligation_without_stores(value))
            })
        }
        Produced::Shape(fields) | Produced::Choice(fields) => {
            fields.values().fold(Obligation::None, |found, value| {
                merge_obligation(found, obligation_without_stores(value))
            })
        }
        value => obligation(value),
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
        | Produced::SharedStore
        | Produced::EmptyStore
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::StoreParameter { .. }
        | Produced::Region { .. }
        | Produced::RegionWitness { .. }
        | Produced::PendingJoin { .. }
        | Produced::PendingFreeze { .. }
        | Produced::PendingScratchRecycle { .. }
        | Produced::PendingReassociate { .. } => false,
        Produced::PendingCallback { input, .. } => contains_borrow(input),
        Produced::Closure {
            captures, result, ..
        } => contains_borrow(captures) || contains_borrow(result),
        Produced::Store(elements) => contains_borrow(elements),
        Produced::Many(values) | Produced::Sequence(values) => values.iter().any(contains_borrow),
        Produced::Shape(fields) => fields.values().any(contains_borrow),
        Produced::Variant(payload) => contains_borrow(payload),
        Produced::Choice(cases) => cases.values().any(contains_borrow),
    }
}

fn contains_pending_callback(produced: &Produced) -> bool {
    match produced {
        Produced::PendingCallback { .. } => true,
        Produced::Borrow(value)
        | Produced::Store(value)
        | Produced::Variant(value)
        | Produced::PendingFreeze { region: value }
        | Produced::PendingScratchRecycle { source: value } => contains_pending_callback(value),
        Produced::Closure {
            captures, result, ..
        } => contains_pending_callback(captures) || contains_pending_callback(result),
        Produced::Many(values) | Produced::Sequence(values) => {
            values.iter().any(contains_pending_callback)
        }
        Produced::Shape(fields) | Produced::Choice(fields) => {
            fields.values().any(contains_pending_callback)
        }
        Produced::Region { elements, .. } => contains_pending_callback(elements),
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => {
            contains_pending_callback(left)
                || contains_pending_callback(right)
                || contains_pending_callback(parent)
        }
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => {
            contains_pending_callback(witness)
                || contains_pending_callback(left)
                || contains_pending_callback(right)
        }
        Produced::PendingReassociate { outer, inner, .. } => {
            contains_pending_callback(outer) || contains_pending_callback(inner)
        }
        Produced::None
        | Produced::SharedStore
        | Produced::EmptyStore
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::StoreParameter { .. } => false,
    }
}

fn contains_shared(produced: &Produced) -> bool {
    match produced {
        Produced::SharedStore => true,
        Produced::Borrow(_) => false,
        Produced::Store(value)
        | Produced::Variant(value)
        | Produced::PendingFreeze { region: value }
        | Produced::PendingScratchRecycle { source: value } => contains_shared(value),
        Produced::Closure {
            captures, result, ..
        } => contains_shared(captures) || contains_shared(result),
        Produced::Many(values) | Produced::Sequence(values) => values.iter().any(contains_shared),
        Produced::Shape(fields) | Produced::Choice(fields) => fields.values().any(contains_shared),
        Produced::Region { elements, .. } => contains_shared(elements),
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => contains_shared(left) || contains_shared(right) || contains_shared(parent),
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => contains_shared(witness) || contains_shared(left) || contains_shared(right),
        Produced::PendingReassociate { outer, inner, .. } => {
            contains_shared(outer) || contains_shared(inner)
        }
        Produced::PendingCallback { input, .. } => contains_shared(input),
        Produced::None
        | Produced::EmptyStore
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::StoreParameter { .. } => false,
    }
}

fn contains_empty_store(produced: &Produced) -> bool {
    match produced {
        Produced::EmptyStore => true,
        Produced::Borrow(value)
        | Produced::Store(value)
        | Produced::Variant(value)
        | Produced::PendingFreeze { region: value }
        | Produced::PendingScratchRecycle { source: value } => contains_empty_store(value),
        Produced::Closure {
            captures, result, ..
        } => contains_empty_store(captures) || contains_empty_store(result),
        Produced::Many(values) | Produced::Sequence(values) => {
            values.iter().any(contains_empty_store)
        }
        Produced::Shape(fields) | Produced::Choice(fields) => {
            fields.values().any(contains_empty_store)
        }
        Produced::Region { elements, .. } => contains_empty_store(elements),
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => {
            contains_empty_store(left)
                || contains_empty_store(right)
                || contains_empty_store(parent)
        }
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => {
            contains_empty_store(witness)
                || contains_empty_store(left)
                || contains_empty_store(right)
        }
        Produced::PendingReassociate { outer, inner, .. } => {
            contains_empty_store(outer) || contains_empty_store(inner)
        }
        Produced::PendingCallback { input, .. } => contains_empty_store(input),
        Produced::None
        | Produced::SharedStore
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::StoreParameter { .. } => false,
    }
}

fn contains_concrete_store(produced: &Produced) -> bool {
    match produced {
        Produced::Store(_) => true,
        Produced::StoreParameter {
            shareable: true, ..
        } => true,
        Produced::Borrow(value)
        | Produced::Variant(value)
        | Produced::PendingFreeze { region: value }
        | Produced::PendingScratchRecycle { source: value } => contains_concrete_store(value),
        Produced::Closure {
            captures, result, ..
        } => contains_concrete_store(captures) || contains_concrete_store(result),
        Produced::Many(values) | Produced::Sequence(values) => {
            values.iter().any(contains_concrete_store)
        }
        Produced::Shape(fields) | Produced::Choice(fields) => {
            fields.values().any(contains_concrete_store)
        }
        Produced::Region { elements, .. } => contains_concrete_store(elements),
        Produced::RegionWitness {
            left,
            right,
            parent,
        } => {
            contains_concrete_store(left)
                || contains_concrete_store(right)
                || contains_concrete_store(parent)
        }
        Produced::PendingJoin {
            witness,
            left,
            right,
        } => {
            contains_concrete_store(witness)
                || contains_concrete_store(left)
                || contains_concrete_store(right)
        }
        Produced::PendingReassociate { outer, inner, .. } => {
            contains_concrete_store(outer) || contains_concrete_store(inner)
        }
        Produced::PendingCallback { input, .. } => contains_concrete_store(input),
        Produced::None
        | Produced::SharedStore
        | Produced::EmptyStore
        | Produced::Leaf(_)
        | Produced::Parameter { .. }
        | Produced::StoreParameter {
            shareable: false, ..
        } => false,
    }
}

fn share_concrete_stores(produced: Produced) -> Produced {
    match produced {
        Produced::Store(_) => Produced::SharedStore,
        Produced::StoreParameter {
            shareable: true, ..
        } => Produced::SharedStore,
        Produced::Borrow(value) => Produced::Borrow(Box::new(share_concrete_stores(*value))),
        Produced::Closure {
            captures,
            parameter,
            result,
        } => Produced::Closure {
            captures: Box::new(share_concrete_stores(*captures)),
            parameter,
            result: Box::new(share_concrete_stores(*result)),
        },
        Produced::Many(values) => {
            Produced::Many(values.into_iter().map(share_concrete_stores).collect())
        }
        Produced::Sequence(values) => {
            Produced::Sequence(values.into_iter().map(share_concrete_stores).collect())
        }
        Produced::Shape(fields) => Produced::Shape(
            fields
                .into_iter()
                .map(|(name, value)| (name, share_concrete_stores(value)))
                .collect(),
        ),
        Produced::Variant(value) => Produced::Variant(Box::new(share_concrete_stores(*value))),
        Produced::Choice(fields) => Produced::Choice(
            fields
                .into_iter()
                .map(|(name, value)| (name, share_concrete_stores(value)))
                .collect(),
        ),
        produced => produced,
    }
}

fn borrowed(produced: Produced) -> Produced {
    if relevant(&produced) {
        Produced::Borrow(Box::new(produced))
    } else {
        Produced::None
    }
}

fn relevant(produced: &Produced) -> bool {
    obligation(produced) != Obligation::None
        || contains_borrow(produced)
        || contains_shared(produced)
        || contains_empty_store(produced)
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

fn join_alternatives(values: Vec<Produced>) -> Produced {
    if values.is_empty() || values.iter().all(|value| *value == Produced::None) {
        return Produced::None;
    }
    let first = values[0].clone();
    if values.iter().all(|value| value == &first) {
        return first;
    }
    if values
        .iter()
        .all(|value| matches!(value, Produced::Sequence(_)))
    {
        let length = match &values[0] {
            Produced::Sequence(elements) => elements.len(),
            _ => unreachable!(),
        };
        if values
            .iter()
            .all(|value| matches!(value, Produced::Sequence(elements) if elements.len() == length))
        {
            return Produced::Sequence(
                (0..length)
                    .map(|index| {
                        join_alternatives(
                            values
                                .iter()
                                .map(|value| match value {
                                    Produced::Sequence(elements) => elements[index].clone(),
                                    _ => unreachable!(),
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            );
        }
    }
    if values
        .iter()
        .all(|value| matches!(value, Produced::Shape(_)))
    {
        let names = match &values[0] {
            Produced::Shape(fields) => fields.keys().cloned().collect::<Vec<_>>(),
            _ => unreachable!(),
        };
        if values.iter().all(|value| {
            matches!(value, Produced::Shape(fields)
                if fields.len() == names.len()
                    && names.iter().all(|name| fields.contains_key(name)))
        }) {
            return Produced::Shape(
                names
                    .into_iter()
                    .map(|name| {
                        let alternatives = values
                            .iter()
                            .map(|value| match value {
                                Produced::Shape(fields) => fields[&name].clone(),
                                _ => unreachable!(),
                            })
                            .collect();
                        (name, join_alternatives(alternatives))
                    })
                    .collect(),
            );
        }
    }
    if values
        .iter()
        .any(|value| matches!(value, Produced::Region { .. }))
        && values.iter().all(|value| {
            matches!(
                value,
                Produced::Region { .. }
                    | Produced::Parameter {
                        qualifier: Qualifier::Linear | Qualifier::Affine,
                        ..
                    }
            )
        })
    {
        let values = values
            .iter()
            .cloned()
            .map(region_authority)
            .collect::<Vec<_>>();
        let authority = region_proof_part(&values[0]);
        if authority.is_some()
            && values
                .iter()
                .all(|value| region_proof_part(value) == authority)
        {
            let Produced::Region {
                qualifier,
                root,
                splits,
                ..
            } = &values[0]
            else {
                unreachable!();
            };
            let elements = values
                .iter()
                .map(|value| match value {
                    Produced::Region { elements, .. } => (**elements).clone(),
                    _ => unreachable!(),
                })
                .collect();
            return Produced::Region {
                qualifier: *qualifier,
                root: *root,
                splits: splits.clone(),
                elements: Box::new(join_alternatives(elements)),
            };
        }
    }
    if values
        .iter()
        .all(|value| matches!(value, Produced::Variant(_)))
    {
        return Produced::Variant(Box::new(join_alternatives(
            values
                .into_iter()
                .map(|value| match value {
                    Produced::Variant(payload) => *payload,
                    _ => unreachable!(),
                })
                .collect(),
        )));
    }
    if values
        .iter()
        .all(|value| matches!(value, Produced::Choice(_)))
    {
        let names = values
            .iter()
            .flat_map(|value| match value {
                Produced::Choice(cases) => cases.keys().cloned().collect::<Vec<_>>(),
                _ => unreachable!(),
            })
            .collect::<BTreeSet<_>>();
        return Produced::Choice(
            names
                .into_iter()
                .map(|name| {
                    let alternatives = values
                        .iter()
                        .filter_map(|value| match value {
                            Produced::Choice(cases) => cases.get(&name).cloned(),
                            _ => unreachable!(),
                        })
                        .collect();
                    (name, join_alternatives(alternatives))
                })
                .collect(),
        );
    }
    join(values)
}

fn ownership_parts(source: &Produced, span: Span) -> (Produced, Produced) {
    let qualifier = match obligation(source) {
        Obligation::Linear => Qualifier::Linear,
        Obligation::Affine => Qualifier::Affine,
        Obligation::None => return (Produced::None, Produced::None),
    };
    let root = match source {
        Produced::Parameter { source, .. } => Some(*source),
        _ => None,
    };
    let part = |index| Produced::Region {
        qualifier,
        root,
        splits: vec![(span, index)],
        elements: Box::new(source.clone()),
    };
    (part(0), part(1))
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

fn materialize_callback_case(
    target: Produced,
    arms: &[crate::ast::Arm],
    span: Span,
    analysis: &mut Analysis<'_>,
) -> Produced {
    let Produced::PendingCallback {
        source,
        path,
        input,
    } = target
    else {
        return target;
    };
    let mut authorities = Vec::new();
    callback_authority_leaves(&input, &mut authorities);
    let mut cases = BTreeMap::new();
    let mut valid = !authorities.is_empty();
    for arm in arms {
        let Pattern::Constructor { name, payload, .. } =
            &analysis.module.arena.patterns[arm.pattern.0 as usize]
        else {
            valid = false;
            continue;
        };
        let mut next = 0;
        let payload = payload.map_or(Produced::None, |payload| {
            callback_pattern_result(
                payload,
                &authorities,
                &mut next,
                analysis.module,
                &mut valid,
            )
        });
        if next != authorities.len() {
            valid = false;
        }
        cases.insert(name.clone(), Produced::Variant(Box::new(payload)));
    }
    if !valid || cases.len() != arms.len() {
        analysis.report(
            "BLOT_HIGHER_ORDER_OWNERSHIP_RELATION",
            "Every named callback result arm must bind each consumed authority once with `!` or `?`, in structural order.",
            span,
        );
        return Produced::None;
    }
    let result = Produced::Choice(cases);
    analysis.callback_requirements.push(CallbackRequirement {
        source,
        path,
        input: (*input).clone(),
        result: result.clone(),
    });
    result
}

fn materialize_callback_binding(
    target: Produced,
    pattern: PatternId,
    span: Span,
    analysis: &mut Analysis<'_>,
) -> Produced {
    let Produced::PendingCallback {
        source,
        path,
        input,
    } = target
    else {
        return target;
    };
    let mut authorities = Vec::new();
    callback_authority_leaves(&input, &mut authorities);
    let mut next = 0;
    let mut valid = !authorities.is_empty();
    let result = callback_pattern_result(
        pattern,
        &authorities,
        &mut next,
        analysis.module,
        &mut valid,
    );
    if !valid || next != authorities.len() {
        analysis.report(
            "BLOT_HIGHER_ORDER_OWNERSHIP_RELATION",
            "An owned callback result binding must receive each consumed authority once with `!` or `?`, in structural order.",
            span,
        );
        return Produced::None;
    }
    analysis.callback_requirements.push(CallbackRequirement {
        source,
        path,
        input: (*input).clone(),
        result: result.clone(),
    });
    result
}

fn callback_authority_leaves(produced: &Produced, leaves: &mut Vec<Produced>) {
    match produced {
        Produced::Sequence(values) | Produced::Many(values) => {
            for value in values {
                callback_authority_leaves(value, leaves);
            }
        }
        Produced::Shape(fields) => {
            for value in fields.values() {
                callback_authority_leaves(value, leaves);
            }
        }
        Produced::Variant(value) => callback_authority_leaves(value, leaves),
        value if obligation(value) != Obligation::None => leaves.push(value.clone()),
        _ => {}
    }
}

fn callback_pattern_result(
    pattern: PatternId,
    authorities: &[Produced],
    next: &mut usize,
    module: &Module,
    valid: &mut bool,
) -> Produced {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { qualifier, .. }
            if matches!(qualifier, Qualifier::Linear | Qualifier::Affine) =>
        {
            let Some(authority) = authorities.get(*next).cloned() else {
                *valid = false;
                return Produced::None;
            };
            let accepts = match qualifier {
                Qualifier::Linear => obligation(&authority) == Obligation::Linear,
                Qualifier::Affine => obligation(&authority) != Obligation::None,
                _ => false,
            };
            if !accepts {
                *valid = false;
            }
            *next += 1;
            authority
        }
        Pattern::Name { .. }
        | Pattern::Wildcard { .. }
        | Pattern::Pin { .. }
        | Pattern::Int { .. }
        | Pattern::Float { .. }
        | Pattern::Text { .. }
        | Pattern::Unit { .. } => Produced::None,
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => Produced::Sequence(
            elements
                .iter()
                .map(|pattern| callback_pattern_result(*pattern, authorities, next, module, valid))
                .collect(),
        ),
        Pattern::Constructor { name, payload, .. } => Produced::Choice(BTreeMap::from([(
            name.clone(),
            Produced::Variant(Box::new(payload.map_or(Produced::None, |payload| {
                callback_pattern_result(payload, authorities, next, module, valid)
            }))),
        )])),
        Pattern::Shape { fields, .. } => Produced::Shape(
            fields
                .iter()
                .map(|field| {
                    (
                        field.name.clone(),
                        callback_pattern_result(field.pattern, authorities, next, module, valid),
                    )
                })
                .collect(),
        ),
    }
}

fn region_authority(produced: Produced) -> Produced {
    match produced {
        Produced::Parameter { qualifier, source } => Produced::Region {
            qualifier,
            root: Some(source),
            splits: Vec::new(),
            elements: Box::new(Produced::Parameter { qualifier, source }),
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
        Produced::Parameter { .. }
            | Produced::PendingJoin { .. }
            | Produced::PendingFreeze { .. }
            | Produced::PendingScratchRecycle { .. }
            | Produced::PendingReassociate { .. }
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
            let Some(parent) =
                join_concrete_regions(&witness_left, &witness_right, &parent, &left, &right)
            else {
                analysis.report(
                    "BLOT_REGION_JOIN_UNPROVED",
                    "Region join requires the witness minted with these two parts.",
                    span,
                );
                return Produced::None;
            };
            parent
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

const ARRAY_INTERVAL_FAMILY: &str = "array-interval";

fn region_proof_part(produced: &Produced) -> Option<Produced> {
    let Produced::Region {
        qualifier,
        root,
        splits,
        ..
    } = produced
    else {
        return None;
    };
    Some(Produced::Region {
        qualifier: *qualifier,
        root: *root,
        splits: splits.clone(),
        elements: Box::new(Produced::None),
    })
}

fn combine_region_elements(left: Produced, right: Produced) -> Produced {
    match (left, right) {
        (Produced::Sequence(mut left), Produced::Sequence(right)) => {
            left.extend(right);
            Produced::Sequence(left)
        }
        (left, right) => combine(left, right),
    }
}

fn join_concrete_regions(
    witness_left: &Produced,
    witness_right: &Produced,
    witness_parent: &Produced,
    left: &Produced,
    right: &Produced,
) -> Option<Produced> {
    let proof = PartitionWitness {
        family: ARRAY_INTERVAL_FAMILY,
        parent: region_proof_part(witness_parent)?,
        left: region_proof_part(witness_left)?,
        right: region_proof_part(witness_right)?,
    };
    let left_authority = region_proof_part(left)?;
    let right_authority = region_proof_part(right)?;
    let parent = combine_partition(
        &ARRAY_INTERVAL_FAMILY,
        &proof,
        &left_authority,
        &right_authority,
    )
    .ok()?;
    let Produced::Region {
        qualifier,
        root,
        splits,
        ..
    } = parent
    else {
        return None;
    };
    let (
        Produced::Region { elements: left, .. },
        Produced::Region {
            elements: right, ..
        },
    ) = (left, right)
    else {
        return None;
    };
    Some(Produced::Region {
        qualifier,
        root,
        splits,
        elements: Box::new(combine_region_elements((**left).clone(), (**right).clone())),
    })
}

#[cfg(test)]
mod region_join_tests {
    use super::*;

    fn region(splits: Vec<(Span, u8)>, elements: Produced) -> Produced {
        Produced::Region {
            qualifier: Qualifier::Linear,
            root: Some(PatternId(7)),
            splits,
            elements: Box::new(elements),
        }
    }

    #[test]
    fn join_matches_authority_and_keeps_live_child_elements() {
        let split = Span { start: 10, end: 20 };
        let parent = region(Vec::new(), Produced::Leaf(Qualifier::Affine));
        let witness_left = region(vec![(split, 0)], Produced::Leaf(Qualifier::Affine));
        let witness_right = region(vec![(split, 1)], Produced::Leaf(Qualifier::Affine));
        let left = region(
            vec![(split, 0)],
            Produced::Sequence(vec![Produced::Leaf(Qualifier::Linear)]),
        );
        let right = region(
            vec![(split, 1)],
            Produced::Sequence(vec![Produced::Leaf(Qualifier::Affine)]),
        );

        let joined = join_concrete_regions(&witness_left, &witness_right, &parent, &left, &right)
            .expect("matching sibling authorities should join");
        let Produced::Region {
            splits, elements, ..
        } = joined
        else {
            panic!("join should return a Region");
        };
        assert!(splits.is_empty());
        assert!(
            *elements
                == Produced::Sequence(vec![
                    Produced::Leaf(Qualifier::Linear),
                    Produced::Leaf(Qualifier::Affine),
                ])
        );
    }

    #[test]
    fn control_flow_keeps_one_equal_region_authority() {
        let first = region(Vec::new(), Produced::Leaf(Qualifier::Linear));
        let second = region(Vec::new(), Produced::Leaf(Qualifier::Affine));

        let joined = join_alternatives(vec![first, second]);
        let Produced::Region {
            splits, elements, ..
        } = joined
        else {
            panic!("alternative regions should retain one authority");
        };
        assert!(splits.is_empty());
        assert!(matches!(*elements, Produced::Many(_)));
    }
}

fn combine_adjacent_regions(left: Produced, right: Produced) -> Produced {
    match (left, right) {
        (
            Produced::Region {
                qualifier,
                root,
                mut splits,
                elements,
            },
            Produced::Region {
                splits: right_splits,
                elements: right_elements,
                ..
            },
        ) => {
            splits.extend(right_splits);
            Produced::Region {
                qualifier,
                root,
                splits,
                elements: Box::new(combine_region_elements(*elements, *right_elements)),
            }
        }
        (left, right) => combine(left, right),
    }
}

fn reassociate_region(
    direction: u8,
    outer: Produced,
    inner: Produced,
    span: Span,
    analysis: &mut Analysis,
) -> Produced {
    if let (
        Produced::RegionWitness {
            left: outer_left,
            right: outer_right,
            parent: outer_parent,
        },
        Produced::RegionWitness {
            left: inner_left,
            right: inner_right,
            parent: inner_parent,
        },
    ) = (outer.clone(), inner.clone())
    {
        let partition_direction = if direction == 0 {
            PartitionDirection::Left
        } else {
            PartitionDirection::Right
        };
        let outer_proof = PartitionWitness {
            family: ARRAY_INTERVAL_FAMILY,
            parent: (*outer_parent).clone(),
            left: (*outer_left).clone(),
            right: (*outer_right).clone(),
        };
        let inner_proof = PartitionWitness {
            family: ARRAY_INTERVAL_FAMILY,
            parent: (*inner_parent).clone(),
            left: (*inner_left).clone(),
            right: (*inner_right).clone(),
        };
        let reassociated = reassociate_partition(
            partition_direction,
            &outer_proof,
            &inner_proof,
            |_family, left, right| Some(combine_adjacent_regions(left.clone(), right.clone())),
        );
        let (new_outer, new_inner) = match reassociated {
            Ok(proofs) => proofs,
            Err(error) => {
                let mut message =
                    "Region witness reassociation requires two related split witnesses.";
                if error == PartitionError::InnerParentMismatch {
                    if direction == 0 {
                        message = "Left reassociation requires the witness that split the outer right child.";
                    } else {
                        message = "Right reassociation requires the witness that split the outer left child.";
                    }
                }
                analysis.report("BLOT_REGION_REASSOCIATE_UNPROVED", message, span);
                return Produced::None;
            }
        };
        let produced_witness = |proof: PartitionWitness<&str, Produced>| Produced::RegionWitness {
            left: Box::new(proof.left),
            right: Box::new(proof.right),
            parent: Box::new(proof.parent),
        };
        return Produced::Sequence(vec![
            produced_witness(new_outer),
            produced_witness(new_inner),
        ]);
    }
    if symbolic_authority(&outer) || symbolic_authority(&inner) {
        return Produced::Sequence(vec![
            Produced::PendingReassociate {
                direction,
                part: 0,
                outer: Box::new(outer.clone()),
                inner: Box::new(inner.clone()),
            },
            Produced::PendingReassociate {
                direction,
                part: 1,
                outer: Box::new(outer),
                inner: Box::new(inner),
            },
        ]);
    }
    analysis.report(
        "BLOT_REGION_REASSOCIATE_UNPROVED",
        "Region witness reassociation requires two related split witnesses.",
        span,
    );
    Produced::None
}

fn recycle_scratch(source: Produced, span: Span, analysis: &mut Analysis) -> Produced {
    match source {
        Produced::Store(elements) => {
            if obligation_without_stores(&elements) == Obligation::Linear {
                analysis.report(
                    "BLOT_SCRATCH_RECYCLE_LINEAR",
                    "Scratch.recycle cannot discard an Array containing a linear resource.",
                    span,
                );
            }
            Produced::Store(Box::new(Produced::Sequence(Vec::new())))
        }
        Produced::EmptyStore => Produced::Store(Box::new(Produced::Sequence(Vec::new()))),
        source
            if matches!(source, Produced::StoreParameter { .. }) || symbolic_authority(&source) =>
        {
            Produced::PendingScratchRecycle {
                source: Box::new(source),
            }
        }
        source => {
            analysis.report(
                "BLOT_SCRATCH_NOT_OWNED",
                "Scratch.recycle requires one owned Array authority.",
                span,
            );
            source
        }
    }
}

/// Discharges pending ownership proofs whose components became concrete
/// through parameter substitution. Components that are still symbolic stay
/// pending for the next call boundary out.
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
                Produced::Region {
                    ref splits,
                    ref elements,
                    ..
                } if splits.is_empty() => *elements.clone(),
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
        Produced::PendingScratchRecycle { source } => {
            let source = resolve_pending(*source, span, analysis);
            recycle_scratch(source, span, analysis)
        }
        Produced::PendingReassociate {
            direction,
            part,
            outer,
            inner,
        } => {
            let outer = resolve_pending(*outer, span, analysis);
            let inner = resolve_pending(*inner, span, analysis);
            match reassociate_region(direction, outer, inner, span, analysis) {
                Produced::Sequence(values) => {
                    values.get(part as usize).cloned().unwrap_or(Produced::None)
                }
                produced => produced,
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
        Produced::Region {
            qualifier,
            root,
            splits,
            elements,
        } => Produced::Region {
            qualifier,
            root,
            splits,
            elements: Box::new(resolve_pending(*elements, span, analysis)),
        },
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

fn parameter_accepts_ownership(input: &Produced, argument: &Produced) -> bool {
    if obligation(argument) == Obligation::None && !contains_shared(argument) {
        return true;
    }
    match (input, argument) {
        (
            Produced::StoreParameter { .. },
            Produced::Store(_)
            | Produced::EmptyStore
            | Produced::StoreParameter { .. }
            | Produced::Parameter {
                qualifier: Qualifier::Affine,
                ..
            },
        ) => true,
        (
            Produced::Leaf(Qualifier::Linear)
            | Produced::Parameter {
                qualifier: Qualifier::Linear,
                ..
            },
            _,
        ) => true,
        (
            Produced::Leaf(Qualifier::Affine)
            | Produced::Parameter {
                qualifier: Qualifier::Affine,
                ..
            },
            _,
        ) => obligation(argument) == Obligation::Affine,
        (Produced::Sequence(inputs), Produced::Sequence(values)) => {
            inputs.len() == values.len()
                && inputs
                    .iter()
                    .zip(values)
                    .all(|(input, value)| parameter_accepts_ownership(input, value))
        }
        (Produced::Variant(input), Produced::Variant(value)) => {
            parameter_accepts_ownership(input, value)
        }
        (Produced::Shape(inputs), Produced::Shape(values)) => values.iter().all(|(name, value)| {
            inputs
                .get(name)
                .is_some_and(|input| parameter_accepts_ownership(input, value))
        }),
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
