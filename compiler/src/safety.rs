#[path = "predicate_summary.rs"]
mod predicate_summary;

use std::collections::{BTreeMap, HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{
    Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember,
    Span,
};
use crate::diagnostic::Diagnostic;
use crate::eval::Context;
use crate::recognise::{self, Junction, Ordering};
use crate::refinement_evidence::RefinementFact;
use crate::relational::inference::{self, Inference, Operand, State};
use crate::relational::proof::*;
use crate::relational::{Measure, RelationshipTransform, Summaries};
use crate::value::{Environment, Value, lookup};
use std::rc::Rc;

#[derive(Default)]
pub(crate) struct Report {
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) facts: Vec<RefinementFact>,
}

#[derive(Clone)]
enum Relation {
    IndexedIterator(Term),
    Index(Term),
    Tuple(Vec<Option<Relation>>),
    Record(BTreeMap<String, Option<Relation>>),
    Choice(BTreeMap<String, Option<Relation>>),
}

#[derive(Clone, Default)]
struct Scope {
    inferred: BTreeMap<String, Operand>,
    identities: HashMap<String, Identity>,
    projections: HashMap<(Identity, String), Identity>,
    affines: HashMap<String, Term>,
    lengths: HashMap<String, Term>,
    relations: HashMap<String, Relation>,
    constraints: Constraints,
    shadowed: HashSet<String>,
    top_level: bool,
}

struct Analysis<'a> {
    infer_relations: bool,
    module: &'a Module,
    inference_module: Rc<Module>,
    context: &'a std::rc::Rc<Context>,
    values: &'a Environment,
    next_identity: Identity,
    summaries: Summaries,
    parameter_types: &'a HashMap<ExpressionId, Value>,
    recursive: HashMap<ExpressionId, (ExpressionId, Scope)>,
    active_recursion: HashSet<ExpressionId>,
    checked_recursion: HashSet<ExpressionId>,
    exhausted: bool,
    facts: Vec<RefinementFact>,
}

pub fn check(
    module: &Module,
    context: &std::rc::Rc<Context>,
    values: &Environment,
    parameter_types: &HashMap<ExpressionId, Value>,
) -> Report {
    let baseline = check_with_relations(module, context, values, parameter_types, false);
    if baseline
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "BLOT_UNPROVEN_INDEX")
    {
        return check_with_relations(module, context, values, parameter_types, true);
    }
    baseline
}

fn check_with_relations(
    module: &Module,
    context: &Rc<Context>,
    values: &Environment,
    parameter_types: &HashMap<ExpressionId, Value>,
    infer_relations: bool,
) -> Report {
    let mut analysis = Analysis {
        infer_relations,
        module,
        inference_module: Rc::new(module.clone()),
        context,
        values,
        next_identity: 0,
        summaries: Summaries::default(),
        parameter_types,
        recursive: HashMap::new(),
        active_recursion: HashSet::new(),
        checked_recursion: HashSet::new(),
        exhausted: false,
        facts: Vec::new(),
    };
    let mut scope = Scope {
        top_level: true,
        ..Scope::default()
    };
    if let Some(parameter) = module.parameter {
        analysis.bind_pattern(parameter, &mut scope);
    }
    match analysis.walk_declarations(&module.declarations, &mut scope) {
        Ok(()) => {}
        Err(diagnostic) => {
            return Report {
                diagnostics: vec![diagnostic],
                ..Report::default()
            };
        }
    }
    match analysis.walk(module.result, &mut scope, false) {
        Ok(()) => {
            let pending = analysis.recursive.clone();
            for (body, (lambda, mut scope)) in pending {
                if !analysis.checked_recursion.contains(&body)
                    && let Err(diagnostic) = analysis.walk(lambda, &mut scope, false)
                {
                    return Report {
                        diagnostics: vec![diagnostic],
                        ..Report::default()
                    };
                }
            }
            Report {
                diagnostics: Vec::new(),
                facts: analysis.facts,
            }
        }
        Err(diagnostic) => Report {
            diagnostics: vec![diagnostic],
            ..Report::default()
        },
    }
}

impl Analysis<'_> {
    fn identity(&mut self) -> Identity {
        self.next_identity += 1;
        self.next_identity
    }

    fn bind_pattern(&mut self, pattern: PatternId, scope: &mut Scope) {
        match &self.module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => {
                let identity = self.identity();
                scope.identities.insert(name.clone(), identity);
                scope.inferred.insert(name.clone(), Operand::default());
                scope.affines.remove(name);
                scope.lengths.remove(name);
                scope.relations.remove(name);
                scope.shadowed.insert(name.clone());
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for pattern in elements {
                    self.bind_pattern(*pattern, scope);
                }
            }
            Pattern::Constructor {
                payload: Some(payload),
                ..
            } => self.bind_pattern(*payload, scope),
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    self.bind_pattern(field.pattern, scope);
                }
            }
            _ => {}
        }
    }

    fn bind_relation(&mut self, pattern: PatternId, relation: Option<Relation>, scope: &mut Scope) {
        let Some(relation) = relation else {
            return;
        };
        match (&self.module.arena.patterns[pattern.0 as usize], relation) {
            (Pattern::Name { name, .. }, relation) => {
                if let Relation::Index(length) = &relation
                    && let Some(identity) = scope.identities.get(name).copied()
                {
                    scope.constraints.push(Constraint {
                        left: Node::Zero,
                        right: Node::Variable(identity),
                        bound: BigInt::from(0),
                    });
                    match length {
                        Term::Literal(length) => scope.constraints.push(Constraint {
                            left: Node::Variable(identity),
                            right: Node::Zero,
                            bound: length - 1,
                        }),
                        Term::Variable {
                            identity: length,
                            offset,
                        } => scope.constraints.push(Constraint {
                            left: Node::Variable(identity),
                            right: Node::Variable(*length),
                            bound: offset - 1,
                        }),
                    }
                }
                scope.relations.insert(name.clone(), relation);
            }
            (Pattern::Tuple { elements, .. }, Relation::Tuple(relations))
            | (Pattern::Array { elements, .. }, Relation::Tuple(relations)) => {
                for (index, pattern) in elements.iter().enumerate() {
                    self.bind_relation(*pattern, relations.get(index).cloned().flatten(), scope);
                }
            }
            (Pattern::Shape { fields, .. }, Relation::Record(mut relations)) => {
                for field in fields {
                    self.bind_relation(
                        field.pattern,
                        relations.remove(&field.name).flatten(),
                        scope,
                    );
                }
            }
            (
                Pattern::Constructor {
                    name,
                    payload: Some(payload),
                    ..
                },
                Relation::Choice(mut choices),
            ) => self.bind_relation(*payload, choices.remove(name).flatten(), scope),
            _ => {}
        }
    }

    fn trust_pattern(&self, pattern: PatternId, scope: &mut Scope) {
        match &self.module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } if lookup(self.values, name).is_some() => {
                scope.shadowed.remove(name);
                if let Some(value) = lookup(self.values, name) {
                    scope.inferred.insert(name.clone(), inference::known(value));
                }
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for pattern in elements {
                    self.trust_pattern(*pattern, scope);
                }
            }
            Pattern::Constructor {
                payload: Some(payload),
                ..
            } => self.trust_pattern(*payload, scope),
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    self.trust_pattern(field.pattern, scope);
                }
            }
            _ => {}
        }
    }

    fn walk_declarations(
        &mut self,
        declarations: &[DeclarationId],
        scope: &mut Scope,
    ) -> Result<(), Diagnostic> {
        for declaration in declarations {
            let declaration = self.module.arena.declarations[declaration.0 as usize].clone();
            match declaration {
                Declaration::Signature { value, .. } => {
                    self.walk(value, scope, false)?;
                }
                Declaration::Binding { pattern, value, .. } => {
                    let recursive = match (
                        &self.module.arena.expressions[value.0 as usize],
                        &self.module.arena.patterns[pattern.0 as usize],
                    ) {
                        (Expression::Rec { lambda, .. }, Pattern::Name { name, .. })
                            if self.infer_relations && !scope.top_level =>
                        {
                            let Expression::Lambda { body, .. } =
                                self.module.arena.expressions[lambda.0 as usize]
                            else {
                                unreachable!()
                            };
                            self.recursive.insert(body, (*lambda, scope.clone()));
                            Some(name.clone())
                        }
                        _ => {
                            self.walk(value, scope, false)?;
                            None
                        }
                    };
                    let mut inferred = self.infer_value(value, scope);
                    if let (Some(name), Some(outcome)) = (recursive, &mut inferred)
                        && let Some(closure) = &mut outcome.value.closure
                    {
                        Rc::make_mut(closure).recursive = Some(name);
                    }
                    let affine = self.term(value, scope);
                    let length = self.array_length(value, scope);
                    let relation = self.relation(value, scope);
                    let alias = self.aliased_identity(value, scope);
                    self.bind_pattern(pattern, scope);
                    match &self.module.arena.patterns[pattern.0 as usize] {
                        Pattern::Name { name, .. } => {
                            let root = scope
                                .identities
                                .get(name)
                                .copied()
                                .expect("a bound name has an identity");
                            self.record_expression_projection_aliases(value, root, scope);
                        }
                        _ => {
                            if let Some(root) = alias {
                                self.bind_pattern_projection_identities(pattern, root, scope);
                            }
                        }
                    }
                    if scope.top_level {
                        self.trust_pattern(pattern, scope);
                    }
                    if let Pattern::Name { name, .. } =
                        &self.module.arena.patterns[pattern.0 as usize]
                    {
                        if let Some(affine) = affine {
                            let identity = scope
                                .identities
                                .get(name)
                                .copied()
                                .expect("a bound name has an affine identity");
                            let subject = Term::Variable {
                                identity,
                                offset: BigInt::from(0),
                            };
                            scope
                                .constraints
                                .extend(constraints_equal(&subject, &affine));
                            scope.affines.insert(name.clone(), affine);
                        }
                        if let Some(length) = length {
                            scope.lengths.insert(name.clone(), length);
                        }
                    }
                    self.bind_relation(pattern, relation, scope);
                    if let Some(inferred) = inferred {
                        scope.constraints.extend(inferred.state.constraints.edges);
                        inference::bind(self.module, pattern, &inferred.value, &mut scope.inferred);
                        self.bind_inferred_scalars(pattern, &inferred.value, scope);
                    }
                }
                Declaration::Shadow { name, value, .. } => {
                    self.walk(value, scope, false)?;
                    let inferred = self.infer_value(value, scope);
                    let affine = self.term(value, scope);
                    let length = self.array_length(value, scope);
                    let relation = self.relation(value, scope);
                    let identity = self.identity();
                    let previous = scope.identities.insert(name.clone(), identity);
                    scope.affines.remove(&name);
                    scope.lengths.remove(&name);
                    scope.relations.remove(&name);
                    scope.shadowed.insert(name.clone());
                    scope.inferred.remove(&name);
                    if scope.top_level && lookup(self.values, &name).is_some() {
                        scope.shadowed.remove(&name);
                    }
                    if let Some(affine) = affine {
                        let subject = Term::Variable {
                            identity,
                            offset: BigInt::from(0),
                        };
                        scope
                            .constraints
                            .extend(constraints_equal(&subject, &affine));
                        scope.affines.insert(name.clone(), affine);
                    }
                    if let Some(length) = length {
                        scope.lengths.insert(name.clone(), length);
                    }
                    if let Some(relation) = relation {
                        scope.relations.insert(name.clone(), relation);
                    }
                    if let Some(inferred) = inferred {
                        scope.constraints.extend(inferred.state.constraints.edges);
                        if let Some(term) = &inferred.value.scalar {
                            scope.constraints.extend(constraints_equal(
                                &Term::Variable {
                                    identity,
                                    offset: 0.into(),
                                },
                                term,
                            ));
                        }
                        scope.inferred.insert(name.clone(), inferred.value);
                    }
                    if let Some(previous) = previous
                        && !identity_referenced(scope, previous)
                    {
                        scope.constraints.forget(previous);
                    }
                }
                Declaration::Open { value, .. } => {
                    self.walk(value, scope, false)?;
                }
            }
        }
        Ok(())
    }

    fn walk(
        &mut self,
        expression: ExpressionId,
        scope: &mut Scope,
        applied: bool,
    ) -> Result<(), Diagnostic> {
        let node = self.module.arena.expressions[expression.0 as usize].clone();
        match node {
            Expression::Intrinsic { name, span }
                if !applied
                    && matches!(
                        name.as_str(),
                        "@array.get" | "@array.set" | "@array.take" | "@array.split"
                    ) =>
            {
                return Err(Diagnostic::new(
                    "BLOT_ARRAY_ACCESS_NOT_DIRECT",
                    "Proof-required array access must be fully applied where it is proved safe.",
                    span,
                ));
            }
            Expression::Apply {
                function,
                argument,
                span,
            } => {
                let (callee, arguments) = application_spine(expression, self.module);
                if let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                    && matches!(
                        name.as_str(),
                        "@array.get" | "@array.set" | "@array.take" | "@array.split"
                    )
                {
                    let arity = if name == "@array.set" { 3 } else { 2 };
                    if arguments.len() != arity {
                        return Err(Diagnostic::new(
                            "BLOT_ARRAY_ACCESS_NOT_DIRECT",
                            format!("`{name}` must be applied to all {arity} arguments."),
                            span,
                        ));
                    }
                    for argument in &arguments {
                        self.walk(*argument, scope, false)?;
                    }
                    self.require_proven_index(expression, arguments[0], arguments[1], scope, span)?;
                    return Ok(());
                }
                self.walk(function, scope, true)?;
                self.walk(argument, scope, false)?;
                if self.infer_relations
                    && let Some(closure) = self
                        .inferred_operand(function, scope)
                        .and_then(|value| value.closure)
                    && Rc::ptr_eq(&closure.module, &self.inference_module)
                    && closure.recursive.is_some()
                    && !self.active_recursion.contains(&closure.body)
                {
                    self.check_recursive_call(expression, &closure, scope)?;
                }
            }
            Expression::Var { .. } if !applied => {
                if let Some(closure) = self
                    .inferred_operand(expression, scope)
                    .and_then(|value| value.closure)
                    && Rc::ptr_eq(&closure.module, &self.inference_module)
                    && closure.recursive.is_some()
                    && !self.active_recursion.contains(&closure.body)
                    && let Some((lambda, mut captured)) = self.recursive.get(&closure.body).cloned()
                {
                    self.active_recursion.insert(closure.body);
                    let checked = self.walk(lambda, &mut captured, false);
                    self.active_recursion.remove(&closure.body);
                    checked?;
                }
            }
            Expression::Field { target, .. } => self.walk(target, scope, false)?,
            Expression::Lambda {
                parameter, body, ..
            } => {
                let mut inner = scope.clone();
                inner.top_level = false;
                self.bind_pattern(parameter, &mut inner);
                if self.infer_relations
                    && let Some(parameter_type) = self.parameter_types.get(&body)
                {
                    self.seed_parameter(parameter, parameter_type, &mut inner);
                }
                self.walk(body, &mut inner, false)?;
            }
            Expression::Array { elements, .. } => {
                for element in elements {
                    self.walk(element.value, scope, false)?;
                }
            }
            Expression::Tuple { elements, .. } => {
                for element in elements {
                    self.walk(element, scope, false)?;
                }
            }
            Expression::Shape { members, .. } => {
                for member in members {
                    match member {
                        ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                            self.walk(value, scope, false)?;
                        }
                        ShapeMember::Computed { name, value } => {
                            self.walk(name, scope, false)?;
                            self.walk(value, scope, false)?;
                        }
                    }
                }
            }
            Expression::If {
                branches, fallback, ..
            } => {
                let mut remaining = scope.clone();
                for branch in branches {
                    self.walk(branch.condition, &mut remaining, false)?;
                    let (taken, untaken) = self.branch_constraints(branch.condition, &remaining);
                    let mut consequence = remaining.clone();
                    consequence.constraints.extend(taken);
                    self.walk(branch.consequence, &mut consequence, false)?;
                    remaining.constraints.extend(untaken);
                }
                if let Some(fallback) = fallback {
                    self.walk(fallback, &mut remaining, false)?;
                }
            }
            Expression::Case { target, arms, .. } => {
                self.walk(target, scope, false)?;
                let relation = self.relation(target, scope);
                let mut engine = Inference::new(self.context, self.next_identity);
                let outcomes = if self.infer_relations {
                    engine.evaluate(
                        &self.inference_module,
                        self.values,
                        target,
                        State {
                            bindings: scope.inferred.clone(),
                            constraints: scope.constraints.clone(),
                        },
                    )
                } else {
                    Err(inference::Refusal::Unsupported)
                };
                self.next_identity = engine.next_identity;
                self.exhausted |= matches!(outcomes, Err(inference::Refusal::Budget));
                for arm in arms {
                    let mut inner = scope.clone();
                    inner.top_level = false;
                    self.bind_pattern(arm.pattern, &mut inner);
                    self.bind_relation(arm.pattern, relation.clone(), &mut inner);
                    if let Ok(outcomes) = &outcomes {
                        let matching = outcomes
                            .iter()
                            .filter(|outcome| {
                                inference::matches_pattern(self.module, arm.pattern, &outcome.value)
                                    != Some(false)
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        if matching.is_empty() {
                            continue;
                        }
                        let mut join = Inference::new(self.context, self.next_identity);
                        let joined =
                            join.join(&matching, self.module.arena.expression_span(target));
                        self.exhausted |= matches!(joined, Err(inference::Refusal::Budget));
                        if let Ok(Some(outcome)) = joined {
                            inner.constraints.extend(outcome.state.constraints.edges);
                            inference::bind(
                                self.module,
                                arm.pattern,
                                &outcome.value,
                                &mut inner.inferred,
                            );
                            self.bind_inferred_scalars(arm.pattern, &outcome.value, &mut inner);
                        }
                        self.next_identity = join.next_identity;
                    }
                    self.walk(arm.body, &mut inner, false)?;
                }
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                let mut inner = scope.clone();
                inner.top_level = false;
                self.walk_declarations(&declarations, &mut inner)?;
                self.walk(result, &mut inner, false)?;
            }
            Expression::Rec { lambda, .. } => self.walk(lambda, scope, false)?,
            _ => {}
        }
        Ok(())
    }

    fn require_proven_index(
        &mut self,
        expression: ExpressionId,
        array: ExpressionId,
        index: ExpressionId,
        scope: &Scope,
        span: Span,
    ) -> Result<(), Diagnostic> {
        let mut constraints = std::borrow::Cow::Borrowed(&scope.constraints);
        let length = self.array_length(array, scope).or_else(|| {
            let inferred = self.infer_value(array, scope)?;
            constraints
                .to_mut()
                .extend(inferred.state.constraints.edges);
            inferred.value.length
        });
        let index = self.term(index, scope).or_else(|| {
            let inferred = self.infer_value(index, scope)?;
            constraints
                .to_mut()
                .extend(inferred.state.constraints.edges);
            inferred.value.scalar
        });
        let (Some(length), Some(index)) = (length, index) else {
            if self.exhausted {
                return Err(Diagnostic::new(
                    "BLOT_REFINEMENT_BUDGET",
                    "Relational inference exhausted its budget before deriving this array access's operands.",
                    span,
                ));
            }
            return Err(unproven(span));
        };
        let constraints = constraints.proof(&index, &length, span)?;
        if term_at_least(&index, &length, &constraints) {
            return Err(Diagnostic::new(
                "BLOT_OUT_OF_BOUNDS",
                "The direct array index is at or past the array length.",
                span,
            ));
        }
        if term_at_least_zero(&index, &constraints) && term_less_than(&index, &length, &constraints)
        {
            self.facts.push(RefinementFact::ArrayIndex {
                expression,
                index,
                length,
                premises: constraints,
            });
            return Ok(());
        }
        if self.exhausted {
            return Err(Diagnostic::new(
                "BLOT_REFINEMENT_BUDGET",
                "Relational inference exhausted its finite candidate or transfer budget before proving this array access.",
                span,
            ));
        }
        Err(unproven(span))
    }

    fn comparison_constraints(
        &self,
        expression: ExpressionId,
        scope: &Scope,
    ) -> (Vec<Constraint>, Vec<Constraint>) {
        if let Expression::If {
            branches,
            fallback: Some(fallback),
            ..
        } = &self.module.arena.expressions[expression.0 as usize]
            && let [branch] = branches.as_slice()
        {
            if matches!(
                &self.module.arena.expressions[fallback.0 as usize],
                Expression::Tag { name, .. } if name == "False"
            ) {
                let (mut left, _) = self.comparison_constraints(branch.condition, scope);
                let (right, _) = self.comparison_constraints(branch.consequence, scope);
                left.extend(right);
                return (left, Vec::new());
            }
            if matches!(
                &self.module.arena.expressions[branch.consequence.0 as usize],
                Expression::Tag { name, .. } if name == "True"
            ) {
                let (_, mut left) = self.comparison_constraints(branch.condition, scope);
                let (_, right) = self.comparison_constraints(*fallback, scope);
                left.extend(right);
                return (Vec::new(), left);
            }
        }
        let (callee, arguments) = application_spine(expression, self.module);
        let Some(callee_value) = self.callee_value(callee, scope) else {
            return (Vec::new(), Vec::new());
        };
        if arguments.len() == 2 {
            match recognise::junction(self.context, &callee_value) {
                Some(Junction::And) => {
                    let (mut left, _) = self.comparison_constraints(arguments[0], scope);
                    let (right, _) = self.comparison_constraints(arguments[1], scope);
                    left.extend(right);
                    return (left, Vec::new());
                }
                Some(Junction::Or) => {
                    let (_, mut left) = self.comparison_constraints(arguments[0], scope);
                    let (_, right) = self.comparison_constraints(arguments[1], scope);
                    left.extend(right);
                    return (Vec::new(), left);
                }
                None => {}
            }
        }
        if arguments.len() == 1 && recognise::negation(self.context, &callee_value) {
            let (taken, untaken) = self.comparison_constraints(arguments[0], scope);
            return (untaken, taken);
        }
        if arguments.len() != 2 {
            return predicate_summary::constraints(self, &callee_value, &arguments, scope)
                .unwrap_or_default();
        }
        let Some(orderings) = recognise::comparison(self.context, &callee_value) else {
            return predicate_summary::constraints(self, &callee_value, &arguments, scope)
                .unwrap_or_default();
        };
        let left_witness = self.witness(arguments[0], scope);
        let right_witness = self.witness(arguments[1], scope);
        let integer_operands = arguments
            .iter()
            .all(|argument| self.integer_operand(*argument, scope));
        if left_witness.is_none() && right_witness.is_none() && !integer_operands {
            return (Vec::new(), Vec::new());
        }
        if matches!(left_witness, Some(Term::Variable { .. }))
            && matches!(right_witness, Some(Term::Variable { .. }))
            && !integer_operands
        {
            return (Vec::new(), Vec::new());
        }
        let Some(left) = self.term(arguments[0], scope) else {
            return (Vec::new(), Vec::new());
        };
        let Some(right) = self.term(arguments[1], scope) else {
            return (Vec::new(), Vec::new());
        };
        let answers = (
            orderings.contains(&Ordering::Less),
            orderings.contains(&Ordering::Equal),
            orderings.contains(&Ordering::Greater),
        );
        match answers {
            (true, false, false) => (
                constraints_less_than(&left, &right),
                constraints_at_least(&left, &right),
            ),
            (true, true, false) => (
                constraints_at_most(&left, &right),
                constraints_greater_than(&left, &right),
            ),
            (false, false, true) => (
                constraints_greater_than(&left, &right),
                constraints_at_most(&left, &right),
            ),
            (false, true, true) => (
                constraints_at_least(&left, &right),
                constraints_less_than(&left, &right),
            ),
            _ => (Vec::new(), Vec::new()),
        }
    }

    fn callee_value(&self, expression: ExpressionId, scope: &Scope) -> Option<Value> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => {
                if scope.shadowed.contains(name) {
                    return None;
                }
                lookup(self.values, name)
            }
            Expression::Field { target, name, .. } => {
                let target = self.callee_value(*target, scope)?;
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

    fn term(&self, expression: ExpressionId, scope: &Scope) -> Option<Term> {
        if let Some(value) = self.inferred_operand(expression, scope)
            && value.scalar.is_some()
        {
            return value.scalar;
        }
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Int { value, .. } => Some(Term::Literal(value.clone())),
            Expression::Var { name, .. } => {
                scope
                    .identities
                    .get(name)
                    .copied()
                    .map(|identity| Term::Variable {
                        identity,
                        offset: BigInt::from(0),
                    })
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                if let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                {
                    if name == "@array.len" && arguments.len() == 1 {
                        return self.array_length(arguments[0], scope);
                    }
                    if name == "@region.length" && arguments.len() == 1 {
                        return self.region_length(arguments[0], scope);
                    }
                    if matches!(name.as_str(), "@int.add" | "@int.sub") && arguments.len() == 2 {
                        let left = self.term(arguments[0], scope)?;
                        let Term::Literal(right) = self.term(arguments[1], scope)? else {
                            return None;
                        };
                        let offset = if name == "@int.sub" { -right } else { right };
                        return Some(shift(left, offset));
                    }
                    if name == "@type.resolve_member"
                        && arguments.len() == 3
                        && let Expression::Text { value: member, .. } =
                            &self.module.arena.expressions[arguments[0].0 as usize]
                        && (member == "add" || member == "sub")
                    {
                        let left = self.term(arguments[1], scope)?;
                        let Term::Literal(right) = self.term(arguments[2], scope)? else {
                            return None;
                        };
                        let offset = if member == "sub" { -right } else { right };
                        return Some(shift(left, offset));
                    }
                }
                let callee = self.callee_value(callee, scope)?;
                let summary = self.summaries.derive(&callee, self.context)?;
                let argument = *arguments.get(summary.parameter)?;
                match summary.measure {
                    Measure::ArrayLength => self.array_length(argument, scope),
                    Measure::RegionLength => self.region_length(argument, scope),
                }
                .map(|length| shift(length, summary.offset))
            }
            _ => None,
        }
    }

    fn witness(&self, expression: ExpressionId, scope: &Scope) -> Option<Term> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Int { value, .. } => Some(Term::Literal(value.clone())),
            Expression::Var { name, .. } => scope.affines.get(name).cloned(),
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                if let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                {
                    if matches!(name.as_str(), "@int.add" | "@int.sub") && arguments.len() == 2 {
                        let left = self.witness(arguments[0], scope)?;
                        let Term::Literal(right) = self.witness(arguments[1], scope)? else {
                            return None;
                        };
                        let offset = if name == "@int.sub" { -right } else { right };
                        return Some(shift(left, offset));
                    }
                    if name == "@type.resolve_member"
                        && arguments.len() == 3
                        && let Expression::Text { value: member, .. } =
                            &self.module.arena.expressions[arguments[0].0 as usize]
                        && (member == "add" || member == "sub")
                    {
                        let left = self.witness(arguments[1], scope)?;
                        let Term::Literal(right) = self.witness(arguments[2], scope)? else {
                            return None;
                        };
                        let offset = if member == "sub" { -right } else { right };
                        return Some(shift(left, offset));
                    }
                }
                self.term(expression, scope)
            }
            _ => None,
        }
    }

    fn array_length(&self, expression: ExpressionId, scope: &Scope) -> Option<Term> {
        if let Some(value) = self.inferred_operand(expression, scope)
            && value.length.is_some()
        {
            return value.length;
        }
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Array { elements, .. }
                if elements.iter().all(|element| !element.spread) =>
            {
                Some(Term::Literal(BigInt::from(elements.len())))
            }
            Expression::Var { name, .. } => scope.lengths.get(name).cloned().or_else(|| {
                scope
                    .identities
                    .get(name)
                    .copied()
                    .map(|identity| Term::Variable {
                        identity,
                        offset: BigInt::from(0),
                    })
            }),
            Expression::Field { target, name, .. } => {
                let parent = existing_identity(self.module, *target, scope)?;
                scope
                    .projections
                    .get(&(parent, name.clone()))
                    .copied()
                    .map(|identity| Term::Variable {
                        identity,
                        offset: BigInt::from(0),
                    })
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                else {
                    return None;
                };
                if matches!(
                    name.as_str(),
                    "@linear.own" | "@linear.borrow" | "@linear.maybe"
                ) && arguments.len() == 1
                {
                    return self.array_length(arguments[0], scope);
                }
                if name == "@array.set" && arguments.len() == 3 {
                    return self.array_length(arguments[0], scope);
                }
                if name == "@array.push" && arguments.len() == 2 {
                    return self
                        .array_length(arguments[0], scope)
                        .map(|length| shift(length, BigInt::from(1)));
                }
                None
            }
            _ => None,
        }
    }

    fn region_length(&self, expression: ExpressionId, scope: &Scope) -> Option<Term> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => {
                scope
                    .identities
                    .get(name)
                    .copied()
                    .map(|identity| Term::Variable {
                        identity,
                        offset: BigInt::from(0),
                    })
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                else {
                    return None;
                };
                if matches!(
                    name.as_str(),
                    "@linear.own" | "@linear.borrow" | "@linear.maybe"
                ) && arguments.len() == 1
                {
                    return self.region_length(arguments[0], scope);
                }
                None
            }
            _ => None,
        }
    }

    fn relation(&self, expression: ExpressionId, scope: &Scope) -> Option<Relation> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => scope.relations.get(name).cloned(),
            Expression::Field { target, name, .. } => {
                project_relation(self.relation(*target, scope)?, name)
            }
            Expression::Tuple { elements, .. } => {
                let elements = elements
                    .iter()
                    .map(|element| self.relation(*element, scope))
                    .collect::<Vec<_>>();
                elements
                    .iter()
                    .any(Option::is_some)
                    .then_some(Relation::Tuple(elements))
            }
            Expression::Shape { members, .. } => {
                let mut fields = BTreeMap::new();
                for member in members {
                    match member {
                        ShapeMember::Field { name, value } => {
                            fields.insert(name.clone(), self.relation(*value, scope));
                        }
                        ShapeMember::Spread { value } => {
                            let Some(Relation::Record(spread)) = self.relation(*value, scope)
                            else {
                                fields.clear();
                                continue;
                            };
                            fields.extend(spread);
                        }
                        ShapeMember::Computed { .. } => {
                            fields.clear();
                        }
                    }
                }
                fields
                    .values()
                    .any(Option::is_some)
                    .then_some(Relation::Record(fields))
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                if let Expression::Tag { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                    && arguments.len() == 1
                    && let Some(payload) = self.relation(arguments[0], scope)
                {
                    return Some(Relation::Choice(BTreeMap::from([(
                        name.clone(),
                        Some(payload),
                    )])));
                }
                if let Expression::Field { target, name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                {
                    if name == "indexed" && arguments.len() == 1 {
                        return self
                            .array_length(arguments[0], scope)
                            .map(Relation::IndexedIterator);
                    }
                    if name == "step" && arguments.len() == 1 {
                        let Relation::IndexedIterator(length) = self.relation(*target, scope)?
                        else {
                            return None;
                        };
                        let mut choices = BTreeMap::new();
                        choices.insert("None".to_owned(), None);
                        choices.insert(
                            "Some".to_owned(),
                            Some(Relation::Tuple(vec![
                                Some(Relation::Tuple(vec![Some(Relation::Index(length)), None])),
                                None,
                            ])),
                        );
                        return Some(Relation::Choice(choices));
                    }
                }
                let callee = self.callee_value(callee, scope)?;
                let summary = self.summaries.derive_relationship(&callee, self.context)?;
                if summary.arity != arguments.len() {
                    return None;
                }
                let arguments = arguments
                    .iter()
                    .map(|argument| self.relation(*argument, scope))
                    .collect::<Vec<_>>();
                instantiate_relationship(summary.result, &arguments)
            }
            _ => None,
        }
    }

    fn projected_identity(&mut self, parent: Identity, field: &str, scope: &mut Scope) -> Identity {
        let key = (parent, field.to_owned());
        if let Some(identity) = scope.projections.get(&key) {
            return *identity;
        }
        let identity = self.identity();
        scope.projections.insert(key, identity);
        identity
    }

    fn aliased_identity(
        &mut self,
        expression: ExpressionId,
        scope: &mut Scope,
    ) -> Option<Identity> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => scope.identities.get(name).copied(),
            Expression::Field { target, name, .. } => {
                let target = *target;
                let name = name.clone();
                let parent = self.aliased_identity(target, scope)?;
                Some(self.projected_identity(parent, &name, scope))
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                if let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                    && matches!(
                        name.as_str(),
                        "@linear.borrow" | "@linear.own" | "@linear.maybe"
                    )
                    && arguments.len() == 1
                {
                    return self.aliased_identity(arguments[0], scope);
                }
                let callee = self.callee_value(callee, scope)?;
                let summary = self.summaries.derive_relationship(&callee, self.context)?;
                if summary.arity != arguments.len() {
                    return None;
                }
                self.alias_from_transform(&summary.result, &arguments, scope)
            }
            _ => None,
        }
    }

    fn alias_from_transform(
        &mut self,
        transform: &RelationshipTransform,
        arguments: &[ExpressionId],
        scope: &mut Scope,
    ) -> Option<Identity> {
        match transform {
            RelationshipTransform::Parameter(parameter) => {
                self.aliased_identity(*arguments.get(*parameter)?, scope)
            }
            RelationshipTransform::Project { target, field } => {
                let parent = self.alias_from_transform(target, arguments, scope)?;
                Some(self.projected_identity(parent, field, scope))
            }
            RelationshipTransform::Payload {
                target,
                constructor,
            } => {
                let parent = self.alias_from_transform(target, arguments, scope)?;
                Some(self.projected_identity(parent, &format!("#{constructor}"), scope))
            }
            _ => None,
        }
    }

    fn record_transform_projection_aliases(
        &mut self,
        transform: &RelationshipTransform,
        root: Identity,
        arguments: &[ExpressionId],
        scope: &mut Scope,
    ) {
        let entries = match transform {
            RelationshipTransform::Tuple(elements) => elements
                .iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), value))
                .collect::<Vec<_>>(),
            RelationshipTransform::Record(fields) => fields
                .iter()
                .map(|(name, value)| (name.clone(), value))
                .collect::<Vec<_>>(),
            _ => return,
        };
        for (field, value) in entries {
            let Some(value) = value else {
                continue;
            };
            if let Some(alias) = self.alias_from_transform(value, arguments, scope) {
                scope.projections.insert((root, field), alias);
                continue;
            }
            let projected = self.projected_identity(root, &field, scope);
            self.record_transform_projection_aliases(value, projected, arguments, scope);
        }
    }

    fn record_expression_projection_aliases(
        &mut self,
        expression: ExpressionId,
        root: Identity,
        scope: &mut Scope,
    ) {
        match self.module.arena.expressions[expression.0 as usize].clone() {
            Expression::Tuple { elements, .. } => {
                for (index, element) in elements.into_iter().enumerate() {
                    let field = index.to_string();
                    if let Some(alias) = self.aliased_identity(element, scope) {
                        scope.projections.insert((root, field), alias);
                    } else {
                        let projected = self.projected_identity(root, &field, scope);
                        self.record_expression_projection_aliases(element, projected, scope);
                    }
                }
            }
            Expression::Shape { members, .. } => {
                for member in members {
                    let ShapeMember::Field { name, value } = member else {
                        continue;
                    };
                    if let Some(alias) = self.aliased_identity(value, scope) {
                        scope.projections.insert((root, name), alias);
                    } else {
                        let projected = self.projected_identity(root, &name, scope);
                        self.record_expression_projection_aliases(value, projected, scope);
                    }
                }
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
                let Some(callee) = self.callee_value(callee, scope) else {
                    return;
                };
                let Some(summary) = self.summaries.derive_relationship(&callee, self.context)
                else {
                    return;
                };
                if summary.arity != arguments.len() {
                    return;
                }
                self.record_transform_projection_aliases(&summary.result, root, &arguments, scope);
            }
            _ => {}
        }
    }

    fn bind_pattern_projection_identities(
        &mut self,
        pattern: PatternId,
        parent: Identity,
        scope: &mut Scope,
    ) {
        match self.module.arena.patterns[pattern.0 as usize].clone() {
            Pattern::Name { name, .. } => {
                scope.identities.insert(name, parent);
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for (index, element) in elements.into_iter().enumerate() {
                    let projected = self.projected_identity(parent, &index.to_string(), scope);
                    self.bind_pattern_projection_identities(element, projected, scope);
                }
            }
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    let projected = self.projected_identity(parent, &field.name, scope);
                    self.bind_pattern_projection_identities(field.pattern, projected, scope);
                }
            }
            Pattern::Constructor {
                name,
                payload: Some(payload),
                ..
            } => {
                let projected = self.projected_identity(parent, &format!("#{name}"), scope);
                self.bind_pattern_projection_identities(payload, projected, scope);
            }
            _ => {}
        }
    }
}

fn existing_identity(module: &Module, expression: ExpressionId, scope: &Scope) -> Option<Identity> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => scope.identities.get(name).copied(),
        Expression::Field { target, name, .. } => {
            let parent = existing_identity(module, *target, scope)?;
            scope.projections.get(&(parent, name.clone())).copied()
        }
        _ => None,
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

fn identity_referenced(scope: &Scope, identity: Identity) -> bool {
    scope
        .inferred
        .values()
        .any(|operand| inference::references(operand, identity))
        || scope.identities.values().any(|found| *found == identity)
        || scope
            .affines
            .values()
            .any(|term| term_references(term, identity))
        || scope
            .lengths
            .values()
            .any(|term| term_references(term, identity))
        || scope
            .relations
            .values()
            .any(|relation| relation_references(relation, identity))
}

fn term_references(term: &Term, identity: Identity) -> bool {
    matches!(term, Term::Variable { identity: found, .. } if *found == identity)
}

fn relation_references(relation: &Relation, identity: Identity) -> bool {
    match relation {
        Relation::IndexedIterator(term) | Relation::Index(term) => term_references(term, identity),
        Relation::Tuple(elements) => elements
            .iter()
            .flatten()
            .any(|relation| relation_references(relation, identity)),
        Relation::Record(fields) => fields
            .values()
            .flatten()
            .any(|relation| relation_references(relation, identity)),
        Relation::Choice(cases) => cases
            .values()
            .flatten()
            .any(|relation| relation_references(relation, identity)),
    }
}

fn project_relation(relation: Relation, field: &str) -> Option<Relation> {
    match relation {
        Relation::Tuple(elements) => {
            let index = field.parse::<usize>().ok()?;
            elements.get(index).cloned().flatten()
        }
        Relation::Record(mut fields) => fields.remove(field).flatten(),
        _ => None,
    }
}

fn instantiate_relationship(
    transform: RelationshipTransform,
    arguments: &[Option<Relation>],
) -> Option<Relation> {
    match transform {
        RelationshipTransform::Parameter(parameter) => arguments.get(parameter).cloned().flatten(),
        RelationshipTransform::Project { target, field } => {
            project_relation(instantiate_relationship(*target, arguments)?, &field)
        }
        RelationshipTransform::Payload {
            target,
            constructor,
        } => {
            let Relation::Choice(mut choices) = instantiate_relationship(*target, arguments)?
            else {
                return None;
            };
            choices.remove(&constructor).flatten()
        }
        RelationshipTransform::Tuple(elements) => {
            let elements = elements
                .into_iter()
                .map(|element| element.and_then(|value| instantiate_relationship(value, arguments)))
                .collect::<Vec<_>>();
            elements
                .iter()
                .any(Option::is_some)
                .then_some(Relation::Tuple(elements))
        }
        RelationshipTransform::Record(fields) => {
            let fields = fields
                .into_iter()
                .map(|(name, value)| {
                    (
                        name,
                        value.and_then(|value| instantiate_relationship(value, arguments)),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            fields
                .values()
                .any(Option::is_some)
                .then_some(Relation::Record(fields))
        }
        RelationshipTransform::Choice(cases) => {
            let cases = cases
                .into_iter()
                .map(|(name, value)| {
                    (
                        name,
                        value.and_then(|value| instantiate_relationship(value, arguments)),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            cases
                .values()
                .any(Option::is_some)
                .then_some(Relation::Choice(cases))
        }
    }
}

fn unproven(span: Span) -> Diagnostic {
    Diagnostic::new(
        "BLOT_UNPROVEN_INDEX",
        "Direct array access needs an index proved against this array's length.",
        span,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(identity: Identity) -> Term {
        Term::Variable {
            identity,
            offset: 0.into(),
        }
    }

    #[test]
    fn proof_dependencies_do_not_expand_through_zero() {
        let mut constraints = Constraints::default();
        for identity in 1..5000 {
            for edge in constraints_equal(&variable(identity), &Term::Literal(1.into())) {
                constraints.push(edge);
            }
        }
        let index = variable(1);
        let length = Term::Literal(2.into());
        let proof = constraints
            .proof(&index, &length, Span { start: 1, end: 2 })
            .unwrap();
        assert_eq!(proof.len(), 2);
        assert!(term_at_least_zero(&index, &proof));
        assert!(term_less_than(&index, &length, &proof));
        assert!(
            constraints
                .proof(&Term::Literal(0.into()), &length, Span { start: 1, end: 2 })
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn proof_dependencies_preserve_relations_between_distinct_roots() {
        let mut constraints = Constraints::default();
        for (left, right) in [(variable(1), variable(2)), (variable(2), variable(3))] {
            for edge in constraints_less_than(&left, &right) {
                constraints.push(edge);
            }
        }
        for edge in constraints_at_least(&variable(1), &Term::Literal(0.into())) {
            constraints.push(edge);
        }
        let proof = constraints
            .proof(&variable(1), &variable(3), Span { start: 1, end: 2 })
            .unwrap();
        assert!(term_at_least_zero(&variable(1), &proof));
        assert!(term_less_than(&variable(1), &variable(3), &proof));
        assert!(!term_less_than(&variable(3), &variable(1), &proof));
    }

    #[test]
    fn proof_dependencies_report_limits_for_relevant_terms_and_edges() {
        for dense in [false, true] {
            let mut constraints = Constraints::default();
            let count = if dense {
                REFINEMENT_EDGE_BUDGET + 1
            } else {
                REFINEMENT_TERM_BUDGET as usize + 1
            };
            for index in 1..=count {
                let right = if dense { 2 } else { index as Identity + 1 };
                let left = if dense { 1 } else { index as Identity };
                constraints.push(Constraint {
                    left: Node::Variable(left),
                    right: Node::Variable(right),
                    bound: 0.into(),
                });
            }
            let failure = constraints
                .proof(
                    &variable(1),
                    &Term::Literal(2.into()),
                    Span { start: 3, end: 7 },
                )
                .unwrap_err();
            assert_eq!(failure.code, "BLOT_REFINEMENT_BUDGET");
            assert_eq!(
                failure.failure_class(),
                crate::diagnostic::FailureClass::Limit
            );
            assert_eq!(failure.span, Span { start: 3, end: 7 });
        }
    }

    #[test]
    fn forgetting_an_identity_preserves_live_transitive_bounds() {
        let mut constraints = vec![
            Constraint {
                left: Node::Variable(1),
                right: Node::Variable(2),
                bound: BigInt::from(3),
            },
            Constraint {
                left: Node::Variable(2),
                right: Node::Variable(3),
                bound: BigInt::from(4),
            },
        ];

        forget_identity(&mut constraints, 2);

        assert!(entails(
            &[Constraint {
                left: Node::Variable(1),
                right: Node::Variable(3),
                bound: BigInt::from(7),
            }],
            &constraints,
        ));
        assert!(constraints.iter().all(|constraint| {
            constraint.left != Node::Variable(2) && constraint.right != Node::Variable(2)
        }));
    }

    #[test]
    fn forgetting_an_identity_does_not_close_unrelated_paths() {
        let mut constraints = (10..110)
            .map(|identity| Constraint {
                left: Node::Variable(identity),
                right: Node::Variable(identity + 1),
                bound: BigInt::from(1),
            })
            .collect::<Vec<_>>();
        constraints.extend([
            Constraint {
                left: Node::Variable(1),
                right: Node::Variable(2),
                bound: BigInt::from(3),
            },
            Constraint {
                left: Node::Variable(2),
                right: Node::Variable(3),
                bound: BigInt::from(4),
            },
        ]);

        forget_identity(&mut constraints, 2);

        assert_eq!(constraints.len(), 101);
        assert!(entails(
            &[Constraint {
                left: Node::Variable(1),
                right: Node::Variable(3),
                bound: BigInt::from(7),
            }],
            &constraints,
        ));
    }
}

impl Analysis<'_> {
    fn branch_constraints(
        &mut self,
        expression: ExpressionId,
        scope: &Scope,
    ) -> (Vec<Constraint>, Vec<Constraint>) {
        let legacy = self.comparison_constraints(expression, scope);
        if !self.infer_relations {
            return legacy;
        }
        let mut inference = Inference::new(self.context, self.next_identity);
        let state = State {
            bindings: scope.inferred.clone(),
            constraints: scope.constraints.clone(),
        };
        let result = inference.evaluate(&self.inference_module, self.values, expression, state);
        self.next_identity = inference.next_identity;
        let Ok(outcomes) = result else {
            self.exhausted |= matches!(result, Err(inference::Refusal::Budget));
            return legacy;
        };
        let mut branches = [legacy.0, legacy.1];
        for (index, tag) in ["True", "False"].iter().enumerate() {
            let outcomes = outcomes
                .iter()
                .filter(|outcome| {
                    outcome
                        .value
                        .constructor
                        .as_deref()
                        .is_none_or(|name| name == *tag)
                })
                .collect::<Vec<_>>();
            let Some(first) = outcomes.first() else {
                continue;
            };
            for constraint in &first.state.constraints.edges {
                if scope.constraints.edges.contains(constraint) {
                    continue;
                }
                if outcomes.iter().all(|outcome| {
                    entails(
                        std::slice::from_ref(constraint),
                        &outcome.state.constraints.edges,
                    )
                }) {
                    branches[index].push(constraint.clone());
                }
            }
        }
        let [positive, negative] = branches;
        (positive, negative)
    }

    fn integer_operand(&self, expression: ExpressionId, scope: &Scope) -> bool {
        if self
            .inferred_operand(expression, scope)
            .is_some_and(|operand| operand.scalar.is_some())
        {
            return true;
        }
        let (callee, arguments) = application_spine(expression, self.module);
        if let Expression::Intrinsic { name, .. } =
            &self.module.arena.expressions[callee.0 as usize]
            && matches!(name.as_str(), "@array.len" | "@region.length")
        {
            return arguments.len() == 1;
        }
        self.callee_value(callee, scope)
            .is_some_and(|callee| self.summaries.derive(&callee, self.context).is_some())
    }

    fn inferred_operand(&self, expression: ExpressionId, scope: &Scope) -> Option<Operand> {
        if !self.infer_relations {
            return None;
        }
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => scope.inferred.get(name).cloned(),
            Expression::Int { value, .. } => Some(inference::integer(value.clone())),
            Expression::Field { target, name, .. } => {
                inference::project(&self.inferred_operand(*target, scope)?, name)
            }
            _ => None,
        }
    }

    fn infer_value(
        &mut self,
        expression: ExpressionId,
        scope: &Scope,
    ) -> Option<inference::Outcome> {
        if !self.infer_relations || scope.top_level {
            return None;
        }
        let mut inference = Inference::new(self.context, self.next_identity);
        let state = State {
            bindings: scope.inferred.clone(),
            constraints: scope.constraints.clone(),
        };
        let module = self.inference_module.clone();
        let outcomes = inference.evaluate(&module, self.values, expression, state);
        let result = outcomes.and_then(|outcomes| {
            inference.join(&outcomes, self.module.arena.expression_span(expression))
        });
        self.next_identity = inference.next_identity;
        self.exhausted |= matches!(result, Err(inference::Refusal::Budget));
        let mut result = result.ok().flatten()?;
        let existing = scope.constraints.edges.iter().collect::<HashSet<_>>();
        let constraints = result
            .state
            .constraints
            .edges
            .into_iter()
            .filter(|edge| !existing.contains(edge))
            .collect::<Vec<_>>();
        result.state.constraints = Constraints::default();
        result.state.constraints.extend(constraints);
        Some(result)
    }

    fn seed_parameter(&mut self, pattern: PatternId, type_: &Value, scope: &mut Scope) {
        let value = self.typed_operand(type_);
        inference::bind(self.module, pattern, &value, &mut scope.inferred);
        self.bind_inferred_scalars(pattern, &value, scope);
    }

    fn typed_operand(&mut self, type_: &Value) -> Operand {
        match type_ {
            Value::Extended { inner, .. } => {
                let mut operand = self.typed_operand(inner);
                operand.type_value = Some(type_.clone());
                operand
            }
            Value::Forall { body: inner, .. } => self.typed_operand(inner),
            Value::Range {
                domain: Some(crate::value::Domain::Int),
                ..
            }
            | Value::Int(_) => Operand {
                scalar: Some(Term::Variable {
                    identity: self.identity(),
                    offset: 0.into(),
                }),
                ..Operand::default()
            },
            Value::Array(_) | Value::RegionType(_) => Operand {
                length: Some(Term::Variable {
                    identity: self.identity(),
                    offset: 0.into(),
                }),
                ..Operand::default()
            },
            Value::Shape(fields) => Operand {
                fields: fields
                    .iter()
                    .map(|(name, type_)| (name.clone(), self.typed_operand(type_)))
                    .collect(),
                ..Operand::default()
            },
            _ => Operand::default(),
        }
    }

    fn bind_inferred_scalars(&self, pattern: PatternId, value: &Operand, scope: &mut Scope) {
        match &self.module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => {
                if let Some(term) = &value.scalar {
                    let identity = scope.identities[name];
                    scope.constraints.extend(constraints_equal(
                        &Term::Variable {
                            identity,
                            offset: 0.into(),
                        },
                        term,
                    ));
                }
                if let Some(length) = &value.length {
                    scope.lengths.insert(name.clone(), length.clone());
                }
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for (index, pattern) in elements.iter().enumerate() {
                    if let Some(field) = value.fields.get(&index.to_string()) {
                        self.bind_inferred_scalars(*pattern, field, scope);
                    }
                }
            }
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    if let Some(value) = value.fields.get(&field.name) {
                        self.bind_inferred_scalars(field.pattern, value, scope);
                    }
                }
            }
            Pattern::Constructor {
                payload: Some(payload),
                ..
            } => {
                if let Some(value) = &value.payload {
                    self.bind_inferred_scalars(*payload, value, scope);
                }
            }
            _ => {}
        }
    }
}

impl Analysis<'_> {
    fn check_recursive_call(
        &mut self,
        expression: ExpressionId,
        closure: &Rc<inference::Closure>,
        scope: &Scope,
    ) -> Result<(), Diagnostic> {
        let Some((lambda, captured)) = self.recursive.get(&closure.body).cloned() else {
            return Ok(());
        };
        let mut engine = Inference::new(self.context, self.next_identity);
        let result = engine.evaluate(
            &self.inference_module,
            self.values,
            expression,
            State {
                bindings: scope.inferred.clone(),
                constraints: scope.constraints.clone(),
            },
        );
        self.next_identity = engine.next_identity;
        self.exhausted |= matches!(result, Err(inference::Refusal::Budget));
        let proof = if result.is_ok() {
            engine
                .loop_proofs
                .into_iter()
                .find(|proof| Rc::ptr_eq(&proof.closure, closure))
        } else {
            None
        };
        let mut inner = captured;
        inner.top_level = false;
        self.active_recursion.insert(closure.body);
        let checked = if let Some(proof) = proof {
            self.facts.push(RefinementFact::RecursiveInvariant {
                expression: closure.body,
                invariants: proof.invariants.clone(),
                entry: proof.entry.clone(),
                context: proof.context.edges.clone(),
                transitions: proof.transitions.clone(),
            });
            self.bind_pattern(closure.parameter, &mut inner);
            inner.inferred = proof.closure.bindings.clone();
            inference::bind(
                self.module,
                closure.parameter,
                &proof.argument,
                &mut inner.inferred,
            );
            inner.inferred.insert(
                closure
                    .recursive
                    .clone()
                    .expect("recursive closure has a name"),
                Operand {
                    closure: Some(closure.clone()),
                    ..Operand::default()
                },
            );
            inner.constraints = proof.context;
            inner.constraints.extend(proof.invariants);
            self.bind_inferred_scalars(closure.parameter, &proof.argument, &mut inner);
            self.walk(closure.body, &mut inner, false)
        } else {
            self.walk(lambda, &mut inner, false)
        };
        self.active_recursion.remove(&closure.body);
        checked?;
        self.checked_recursion.insert(closure.body);
        Ok(())
    }
}
