use std::collections::{BTreeMap, HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{
    Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember,
    Span,
};
use crate::diagnostic::Diagnostic;
use crate::eval::Context;
use crate::recognise::{self, Junction, Ordering};
use crate::relational::{Measure, RelationshipTransform, Summaries};
use crate::value::{Environment, Value, lookup};

type Identity = u32;

const REFINEMENT_TERM_BUDGET: Identity = 512;
const REFINEMENT_EDGE_BUDGET: usize = 2_048;

#[derive(Clone, Debug)]
enum Term {
    Literal(BigInt),
    Variable { identity: Identity, offset: BigInt },
}

#[derive(Clone)]
enum Relation {
    IndexedIterator(Term),
    Index(Term),
    Tuple(Vec<Option<Relation>>),
    Record(BTreeMap<String, Option<Relation>>),
    Choice(BTreeMap<String, Option<Relation>>),
}

#[derive(Clone)]
struct Constraint {
    left: Node,
    right: Node,
    bound: BigInt,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
enum Node {
    Zero,
    Variable(Identity),
}

#[derive(Clone, Default)]
struct Scope {
    identities: HashMap<String, Identity>,
    projections: HashMap<(Identity, String), Identity>,
    affines: HashMap<String, Term>,
    lengths: HashMap<String, Term>,
    relations: HashMap<String, Relation>,
    constraints: Vec<Constraint>,
    refinement_budget_exhausted: bool,
    shadowed: HashSet<String>,
    top_level: bool,
}

struct Analysis<'a> {
    module: &'a Module,
    context: &'a std::rc::Rc<Context>,
    values: &'a Environment,
    next_identity: Identity,
    summaries: Summaries,
}

pub fn check(
    module: &Module,
    context: &std::rc::Rc<Context>,
    values: &Environment,
) -> Vec<Diagnostic> {
    let mut analysis = Analysis {
        module,
        context,
        values,
        next_identity: 0,
        summaries: Summaries::default(),
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
        Err(diagnostic) => return vec![diagnostic],
    }
    match analysis.walk(module.result, &mut scope, false) {
        Ok(()) => Vec::new(),
        Err(diagnostic) => vec![diagnostic],
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
                    scope.push_constraint(Constraint {
                        left: Node::Zero,
                        right: Node::Variable(identity),
                        bound: BigInt::from(0),
                    });
                    match length {
                        Term::Literal(length) => scope.push_constraint(Constraint {
                            left: Node::Variable(identity),
                            right: Node::Zero,
                            bound: length - 1,
                        }),
                        Term::Variable {
                            identity: length,
                            offset,
                        } => scope.push_constraint(Constraint {
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
                    self.walk(value, scope, false)?;
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
                            scope.extend_constraints(constraints_equal(&subject, &affine));
                            scope.affines.insert(name.clone(), affine);
                        }
                        if let Some(length) = length {
                            scope.lengths.insert(name.clone(), length);
                        }
                    }
                    self.bind_relation(pattern, relation, scope);
                }
                Declaration::Shadow { name, value, .. } => {
                    self.walk(value, scope, false)?;
                    let affine = self.term(value, scope);
                    let length = self.array_length(value, scope);
                    let relation = self.relation(value, scope);
                    let identity = self.identity();
                    let previous = scope.identities.insert(name.clone(), identity);
                    scope.affines.remove(&name);
                    scope.lengths.remove(&name);
                    scope.relations.remove(&name);
                    scope.shadowed.insert(name.clone());
                    if scope.top_level && lookup(self.values, &name).is_some() {
                        scope.shadowed.remove(&name);
                    }
                    if let Some(affine) = affine {
                        let subject = Term::Variable {
                            identity,
                            offset: BigInt::from(0),
                        };
                        scope.extend_constraints(constraints_equal(&subject, &affine));
                        scope.affines.insert(name.clone(), affine);
                    }
                    if let Some(length) = length {
                        scope.lengths.insert(name.clone(), length);
                    }
                    if let Some(relation) = relation {
                        scope.relations.insert(name, relation);
                    }
                    if let Some(previous) = previous
                        && !identity_referenced(scope, previous)
                    {
                        forget_identity(&mut scope.constraints, previous);
                        scope.enforce_edge_budget();
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
                    self.require_proven_index(arguments[0], arguments[1], scope, span)?;
                    return Ok(());
                }
                self.walk(function, scope, true)?;
                self.walk(argument, scope, false)?;
            }
            Expression::Field { target, .. } => self.walk(target, scope, false)?,
            Expression::Lambda {
                parameter, body, ..
            } => {
                let mut inner = scope.clone();
                inner.top_level = false;
                self.bind_pattern(parameter, &mut inner);
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
                    let (taken, untaken) =
                        self.comparison_constraints(branch.condition, &remaining);
                    let mut consequence = remaining.clone();
                    consequence.extend_constraints(taken);
                    self.walk(branch.consequence, &mut consequence, false)?;
                    remaining.extend_constraints(untaken);
                }
                if let Some(fallback) = fallback {
                    self.walk(fallback, &mut remaining, false)?;
                }
            }
            Expression::Case { target, arms, .. } => {
                self.walk(target, scope, false)?;
                let relation = self.relation(target, scope);
                for arm in arms {
                    let mut inner = scope.clone();
                    inner.top_level = false;
                    self.bind_pattern(arm.pattern, &mut inner);
                    self.bind_relation(arm.pattern, relation.clone(), &mut inner);
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
        &self,
        array: ExpressionId,
        index: ExpressionId,
        scope: &Scope,
        span: Span,
    ) -> Result<(), Diagnostic> {
        if constraint_term_count(&scope.constraints) > REFINEMENT_TERM_BUDGET as usize
            || scope.refinement_budget_exhausted
        {
            return Err(Diagnostic::new(
                "BLOT_REFINEMENT_BUDGET",
                format!(
                    "The bounded affine refinement budget was exceeded (maximum {REFINEMENT_TERM_BUDGET} terms and {REFINEMENT_EDGE_BUDGET} edges per module). Split the proof into a verified helper or reduce the number of simultaneously live affine facts."
                ),
                span,
            ));
        }
        let Some(length) = self.array_length(array, scope) else {
            return Err(unproven(span));
        };
        let Some(index) = self.term(index, scope) else {
            return Err(unproven(span));
        };
        if term_at_least(&index, &length, &scope.constraints) {
            return Err(Diagnostic::new(
                "BLOT_OUT_OF_BOUNDS",
                "The direct array index is at or past the array length.",
                span,
            ));
        }
        if term_at_least_zero(&index, &scope.constraints)
            && term_less_than(&index, &length, &scope.constraints)
        {
            return Ok(());
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
        if arguments.len() != 2 {
            return (Vec::new(), Vec::new());
        }
        let left_witness = self.witness(arguments[0], scope);
        let right_witness = self.witness(arguments[1], scope);
        if left_witness.is_none() && right_witness.is_none() {
            return (Vec::new(), Vec::new());
        }
        if matches!(left_witness, Some(Term::Variable { .. }))
            && matches!(right_witness, Some(Term::Variable { .. }))
        {
            return (Vec::new(), Vec::new());
        }
        let Some(left) = self.term(arguments[0], scope) else {
            return (Vec::new(), Vec::new());
        };
        let Some(right) = self.term(arguments[1], scope) else {
            return (Vec::new(), Vec::new());
        };
        let Some(orderings) = recognise::comparison(self.context, &callee_value) else {
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
                    && matches!(name.as_str(), "@int.add" | "@int.sub")
                    && arguments.len() == 2
                {
                    let left = self.witness(arguments[0], scope)?;
                    let Term::Literal(right) = self.witness(arguments[1], scope)? else {
                        return None;
                    };
                    let offset = if name == "@int.sub" { -right } else { right };
                    return Some(shift(left, offset));
                }
                self.term(expression, scope)
            }
            _ => None,
        }
    }

    fn array_length(&self, expression: ExpressionId, scope: &Scope) -> Option<Term> {
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

impl Scope {
    fn push_constraint(&mut self, constraint: Constraint) {
        if self.constraints.len() >= REFINEMENT_EDGE_BUDGET {
            self.refinement_budget_exhausted = true;
            return;
        }
        self.constraints.push(constraint);
    }

    fn extend_constraints(&mut self, constraints: impl IntoIterator<Item = Constraint>) {
        for constraint in constraints {
            self.push_constraint(constraint);
        }
    }

    fn enforce_edge_budget(&mut self) {
        if self.constraints.len() <= REFINEMENT_EDGE_BUDGET {
            return;
        }
        self.constraints.truncate(REFINEMENT_EDGE_BUDGET);
        self.refinement_budget_exhausted = true;
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

fn shift(term: Term, offset: BigInt) -> Term {
    match term {
        Term::Literal(value) => Term::Literal(value + offset),
        Term::Variable {
            identity,
            offset: current,
        } => Term::Variable {
            identity,
            offset: current + offset,
        },
    }
}

fn constraints_less_than(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(left, right, BigInt::from(-1))
}

fn constraints_at_least(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(right, left, BigInt::from(0))
}

fn constraints_at_most(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(left, right, BigInt::from(0))
}

fn constraints_greater_than(left: &Term, right: &Term) -> Vec<Constraint> {
    constraints_difference(right, left, BigInt::from(-1))
}

fn constraints_equal(left: &Term, right: &Term) -> Vec<Constraint> {
    let mut constraints = constraints_difference(left, right, BigInt::from(0));
    constraints.extend(constraints_difference(right, left, BigInt::from(0)));
    constraints
}

fn constraints_difference(left: &Term, right: &Term, delta: BigInt) -> Vec<Constraint> {
    let (left_node, left_offset) = term_node(left);
    let (right_node, right_offset) = term_node(right);
    vec![Constraint {
        left: left_node,
        right: right_node,
        bound: right_offset - left_offset + delta,
    }]
}

fn term_node(term: &Term) -> (Node, BigInt) {
    match term {
        Term::Literal(value) => (Node::Zero, value.clone()),
        Term::Variable { identity, offset } => (Node::Variable(*identity), offset.clone()),
    }
}

fn term_at_least_zero(term: &Term, constraints: &[Constraint]) -> bool {
    term_at_least(term, &Term::Literal(BigInt::from(0)), constraints)
}

fn term_less_than(left: &Term, right: &Term, constraints: &[Constraint]) -> bool {
    entails(&constraints_less_than(left, right), constraints)
}

fn term_at_least(left: &Term, right: &Term, constraints: &[Constraint]) -> bool {
    entails(&constraints_at_least(left, right), constraints)
}

fn entails(required: &[Constraint], constraints: &[Constraint]) -> bool {
    let node_count = constraints
        .iter()
        .flat_map(|constraint| [constraint.left, constraint.right])
        .chain(std::iter::once(Node::Zero))
        .collect::<HashSet<_>>()
        .len();
    let mut distances = HashMap::<Node, HashMap<Node, BigInt>>::new();
    for required in required {
        let from = distances
            .entry(required.right)
            .or_insert_with(|| shortest_paths_from(required.right, constraints, node_count));
        if !from
            .get(&required.left)
            .is_some_and(|distance| distance <= &required.bound)
        {
            return false;
        }
    }
    true
}

fn shortest_paths_from(
    source: Node,
    constraints: &[Constraint],
    node_count: usize,
) -> HashMap<Node, BigInt> {
    let mut distances = HashMap::from([(source, BigInt::from(0))]);
    for _ in 0..node_count {
        let mut changed = false;
        for constraint in constraints {
            let Some(right) = distances.get(&constraint.right).cloned() else {
                continue;
            };
            let candidate = right + &constraint.bound;
            if distances
                .get(&constraint.left)
                .is_some_and(|current| current <= &candidate)
            {
                continue;
            }
            distances.insert(constraint.left, candidate);
            changed = true;
        }
        if !changed {
            break;
        }
    }
    distances
}

fn constraint_term_count(constraints: &[Constraint]) -> usize {
    constraints
        .iter()
        .flat_map(|constraint| [constraint.left, constraint.right])
        .collect::<HashSet<_>>()
        .len()
}

fn identity_referenced(scope: &Scope, identity: Identity) -> bool {
    scope.identities.values().any(|found| *found == identity)
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

fn forget_identity(constraints: &mut Vec<Constraint>, identity: Identity) {
    let dead = Node::Variable(identity);
    if !constraints
        .iter()
        .any(|constraint| constraint.left == dead || constraint.right == dead)
    {
        return;
    }
    let mut into_dead = BTreeMap::<Node, BigInt>::new();
    let mut from_dead = BTreeMap::<Node, BigInt>::new();
    let mut projected = BTreeMap::<(Node, Node), BigInt>::new();
    for constraint in constraints.iter() {
        if constraint.left == dead && constraint.right != dead {
            into_dead
                .entry(constraint.right)
                .and_modify(|bound| {
                    if constraint.bound < *bound {
                        *bound = constraint.bound.clone();
                    }
                })
                .or_insert_with(|| constraint.bound.clone());
            continue;
        }
        if constraint.right == dead && constraint.left != dead {
            from_dead
                .entry(constraint.left)
                .and_modify(|bound| {
                    if constraint.bound < *bound {
                        *bound = constraint.bound.clone();
                    }
                })
                .or_insert_with(|| constraint.bound.clone());
            continue;
        }
        if constraint.left == dead || constraint.right == dead {
            continue;
        }
        projected
            .entry((constraint.left, constraint.right))
            .and_modify(|bound| {
                if constraint.bound < *bound {
                    *bound = constraint.bound.clone();
                }
            })
            .or_insert_with(|| constraint.bound.clone());
    }
    for (right, into_bound) in into_dead {
        for (left, from_bound) in &from_dead {
            if *left == right {
                continue;
            }
            let bound = &into_bound + from_bound;
            projected
                .entry((*left, right))
                .and_modify(|current| {
                    if bound < *current {
                        *current = bound.clone();
                    }
                })
                .or_insert(bound);
        }
    }
    *constraints = projected
        .into_iter()
        .map(|((left, right), bound)| Constraint { left, right, bound })
        .collect();
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
