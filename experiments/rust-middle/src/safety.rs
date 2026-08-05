use std::collections::{BTreeMap, HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{
    Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember,
    Span,
};
use crate::diagnostic::Diagnostic;
use crate::eval::Context;
use crate::recognise::{self, Comparison, Junction};
use crate::value::{Environment, Value, lookup};

type Identity = u32;

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
    Choice(BTreeMap<String, Option<Relation>>),
}

#[derive(Clone)]
struct Constraint {
    left: Node,
    right: Node,
    bound: BigInt,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Node {
    Zero,
    Variable(Identity),
}

#[derive(Clone, Default)]
struct Scope {
    identities: HashMap<String, Identity>,
    lengths: HashMap<String, Term>,
    relations: HashMap<String, Relation>,
    constraints: Vec<Constraint>,
    shadowed: HashSet<String>,
    top_level: bool,
}

struct Analysis<'a> {
    module: &'a Module,
    context: &'a std::rc::Rc<Context>,
    values: &'a Environment,
    next_identity: Identity,
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
                Declaration::Binding { pattern, value, .. } => {
                    self.walk(value, scope, false)?;
                    let length = self.array_length(value, scope);
                    let relation = self.relation(value, scope);
                    self.bind_pattern(pattern, scope);
                    if scope.top_level {
                        self.trust_pattern(pattern, scope);
                    }
                    if let Pattern::Name { name, .. } =
                        &self.module.arena.patterns[pattern.0 as usize]
                        && let Some(length) = length
                    {
                        scope.lengths.insert(name.clone(), length);
                    }
                    self.bind_relation(pattern, relation, scope);
                }
                Declaration::Shadow { name, value, .. } => {
                    self.walk(value, scope, false)?;
                    let length = self.array_length(value, scope);
                    let relation = self.relation(value, scope);
                    let identity = self.identity();
                    scope.identities.insert(name.clone(), identity);
                    scope.lengths.remove(&name);
                    scope.relations.remove(&name);
                    scope.shadowed.insert(name.clone());
                    if scope.top_level && lookup(self.values, &name).is_some() {
                        scope.shadowed.remove(&name);
                    }
                    if let Some(length) = length {
                        scope.lengths.insert(name.clone(), length);
                    }
                    if let Some(relation) = relation {
                        scope.relations.insert(name, relation);
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
                if !applied && matches!(name.as_str(), "@array.get" | "@array.set") =>
            {
                return Err(Diagnostic::new(
                    "BLOT_ARRAY_ACCESS_NOT_DIRECT",
                    "Direct array access must be fully applied where it is proved safe.",
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
                    && matches!(name.as_str(), "@array.get" | "@array.set")
                {
                    let arity = if name == "@array.get" { 2 } else { 3 };
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
                    let value = match member {
                        ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => value,
                    };
                    self.walk(value, scope, false)?;
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
            Expression::Comptime { body, .. } => self.walk(body, scope, false)?,
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
        let Some(left) = self.term(arguments[0], scope) else {
            return (Vec::new(), Vec::new());
        };
        let Some(right) = self.term(arguments[1], scope) else {
            return (Vec::new(), Vec::new());
        };
        match recognise::comparison(self.context, &callee_value) {
            Some(Comparison::Less) => (
                constraints_less_than(&left, &right),
                constraints_at_least(&left, &right),
            ),
            Some(Comparison::LessOrEqual) => (
                constraints_at_most(&left, &right),
                constraints_greater_than(&left, &right),
            ),
            Some(Comparison::Equal) => (Vec::new(), Vec::new()),
            Some(Comparison::Greater) => (
                constraints_greater_than(&left, &right),
                constraints_at_most(&left, &right),
            ),
            Some(Comparison::GreaterOrEqual) => (
                constraints_at_least(&left, &right),
                constraints_less_than(&left, &right),
            ),
            None => (Vec::new(), Vec::new()),
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
                let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[callee.0 as usize]
                else {
                    return None;
                };
                if name == "@array.len" && arguments.len() == 1 {
                    return self.array_length(arguments[0], scope);
                }
                if matches!(name.as_str(), "@int.add" | "@int.sub") && arguments.len() == 2 {
                    let left = self.term(arguments[0], scope)?;
                    let Term::Literal(right) = self.term(arguments[1], scope)? else {
                        return None;
                    };
                    let offset = if name == "@int.sub" { -right } else { right };
                    return Some(shift(left, offset));
                }
                None
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

    fn relation(&self, expression: ExpressionId, scope: &Scope) -> Option<Relation> {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => scope.relations.get(name).cloned(),
            Expression::Field { target, name, .. } => {
                let Relation::Tuple(elements) = self.relation(*target, scope)? else {
                    return None;
                };
                let index = name.parse::<usize>().ok()?;
                elements.get(index).cloned().flatten()
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, self.module);
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
                None
            }
            _ => None,
        }
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
    let distances = shortest_paths(constraints);
    required.iter().all(|required| {
        distances
            .get(&required.right)
            .and_then(|from| from.get(&required.left))
            .is_some_and(|distance| distance <= &required.bound)
    })
}

fn shortest_paths(constraints: &[Constraint]) -> HashMap<Node, HashMap<Node, BigInt>> {
    let mut nodes = HashSet::from([Node::Zero]);
    for constraint in constraints {
        nodes.insert(constraint.left);
        nodes.insert(constraint.right);
    }
    let mut result = HashMap::new();
    for source in &nodes {
        let mut distances = HashMap::from([(*source, BigInt::from(0))]);
        for _ in 0..nodes.len() {
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
        result.insert(*source, distances);
    }
    result
}

fn unproven(span: Span) -> Diagnostic {
    Diagnostic::new(
        "BLOT_UNPROVEN_INDEX",
        "Direct array access needs an index proved against this array's length.",
        span,
    )
}
