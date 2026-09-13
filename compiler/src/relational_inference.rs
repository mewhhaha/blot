//! Symbolic execution of the bounded, normal-return relational fragment.
//! Values retain immutable identities; this analysis never evaluates host effects.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use num_bigint::BigInt;

use super::proof::*;
use crate::ast::{
    Declaration, Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember, Span,
};
use crate::eval::Context;
use crate::value::{Environment, Value, lookup};

pub(crate) const TRANSFER_BUDGET: usize = 65_536;
pub(crate) const CANDIDATE_BUDGET: usize = 256;

#[derive(Clone, Default)]
pub(crate) struct Operand {
    pub(crate) scalar: Option<Term>,
    pub(crate) length: Option<Term>,
    pub(crate) fields: BTreeMap<String, Operand>,
    pub(crate) constructor: Option<String>,
    pub(crate) payload: Option<Box<Operand>>,
    pub(crate) known: Option<Value>,
    pub(crate) type_value: Option<Value>,
    pub(crate) closure: Option<Rc<Closure>>,
    pub(crate) back_edge: Option<Box<Operand>>,
    pub(crate) alternatives: Vec<(Operand, Constraints)>,
}

#[derive(Clone)]
pub(crate) struct Closure {
    pub(crate) module: Rc<Module>,
    pub(crate) parameter: PatternId,
    pub(crate) body: ExpressionId,
    pub(crate) environment: Environment,
    pub(crate) bindings: BTreeMap<String, Operand>,
    pub(crate) recursive: Option<String>,
    pub(crate) deferred: bool,
}

#[derive(Clone, Default)]
pub(crate) struct State {
    pub(crate) bindings: BTreeMap<String, Operand>,
    pub(crate) constraints: Constraints,
}

#[derive(Clone)]
pub(crate) struct Outcome {
    pub(crate) value: Operand,
    pub(crate) state: State,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    Unsupported,
    Budget,
}

type Result<T> = std::result::Result<T, Refusal>;

pub(crate) struct Inference<'a> {
    pub(crate) context: &'a Rc<Context>,
    pub(crate) next_identity: Identity,
    pub(crate) remaining: usize,
    active: HashSet<(usize, ExpressionId)>,
    loop_stack: Vec<(usize, ExpressionId)>,
    pub(crate) loop_proofs: Vec<LoopProof>,
}

impl<'a> Inference<'a> {
    pub(crate) fn new(context: &'a Rc<Context>, next_identity: Identity) -> Self {
        Self {
            context,
            next_identity,
            remaining: TRANSFER_BUDGET,
            active: HashSet::new(),
            loop_stack: Vec::new(),
            loop_proofs: Vec::new(),
        }
    }

    fn step(&mut self) -> Result<()> {
        self.remaining = self.remaining.checked_sub(1).ok_or(Refusal::Budget)?;
        Ok(())
    }

    pub(crate) fn fresh_term(&mut self) -> Term {
        self.next_identity += 1;
        Term::Variable {
            identity: self.next_identity,
            offset: 0.into(),
        }
    }

    fn unknown(&mut self) -> Operand {
        Operand::default()
    }

    pub(crate) fn evaluate(
        &mut self,
        module: &Rc<Module>,
        environment: &Environment,
        expression: ExpressionId,
        state: State,
    ) -> Result<Vec<Outcome>> {
        self.step()?;
        if !state.constraints.within_budget() {
            return Err(Refusal::Budget);
        }
        match &module.arena.expressions[expression.0 as usize] {
            Expression::Int { value, .. } => Ok(vec![Outcome {
                value: integer(value.clone()),
                state,
            }]),
            Expression::Text { value, .. } => Ok(vec![Outcome {
                value: known(Value::Text(value.clone().into())),
                state,
            }]),
            Expression::Unit { .. } => Ok(vec![Outcome {
                value: known(Value::Unit),
                state,
            }]),
            Expression::Tag { name, .. } => Ok(vec![Outcome {
                value: Operand {
                    constructor: Some(name.clone()),
                    ..Operand::default()
                },
                state,
            }]),
            Expression::Var { name, .. } => {
                let value = state
                    .bindings
                    .get(name)
                    .cloned()
                    .or_else(|| lookup(environment, name).map(known))
                    .unwrap_or_else(|| self.unknown());
                if value.alternatives.is_empty() {
                    return Ok(vec![Outcome { value, state }]);
                }
                Ok(value
                    .alternatives
                    .iter()
                    .map(|(value, facts)| {
                        let mut branch = state.clone();
                        branch.constraints.extend(facts.edges.iter().cloned());
                        Outcome {
                            value: value.clone(),
                            state: branch,
                        }
                    })
                    .collect())
            }
            Expression::Intrinsic { name, .. } => Ok(vec![Outcome {
                value: known(match crate::primitives::constant(name) {
                    Some(value) => value,
                    None => Value::Primitive {
                        name: name.clone(),
                        arity: crate::primitives::primitive_arity(name)
                            .ok_or(Refusal::Unsupported)?,
                        applied: Vec::new(),
                    },
                }),
                state,
            }]),
            Expression::Lambda {
                parameter,
                body,
                deferred,
                ..
            } => Ok(vec![Outcome {
                value: Operand {
                    closure: Some(Rc::new(Closure {
                        module: module.clone(),
                        parameter: *parameter,
                        body: *body,
                        environment: environment.clone(),
                        bindings: state.bindings.clone(),
                        recursive: None,
                        deferred: *deferred,
                    })),
                    ..Operand::default()
                },
                state,
            }]),
            Expression::Rec { lambda, .. } => self.evaluate(module, environment, *lambda, state),
            Expression::Field { target, name, .. } => {
                let mut outcomes = self.evaluate(module, environment, *target, state)?;
                for outcome in &mut outcomes {
                    if outcome.value.back_edge.is_some() {
                        return Err(Refusal::Unsupported);
                    }
                    outcome.value = project(&outcome.value, name).unwrap_or_else(|| self.unknown());
                }
                Ok(outcomes)
            }
            Expression::Tuple { elements, .. } => self.aggregate(
                module,
                environment,
                elements
                    .iter()
                    .enumerate()
                    .map(|(i, e)| (i.to_string(), *e))
                    .collect(),
                state,
            ),
            Expression::Shape { members, .. } => {
                let mut paths = vec![Outcome {
                    value: Operand::default(),
                    state,
                }];
                for member in members {
                    let mut next = Vec::new();
                    for path in paths {
                        match member {
                            ShapeMember::Field { name, value } => {
                                for field in
                                    self.evaluate(module, environment, *value, path.state)?
                                {
                                    if field.value.back_edge.is_some() {
                                        return Err(Refusal::Unsupported);
                                    }
                                    let mut record = path.value.clone();
                                    record.fields.insert(name.clone(), field.value);
                                    next.push(Outcome {
                                        value: record,
                                        state: field.state,
                                    });
                                }
                            }
                            ShapeMember::Spread { value } => {
                                for spread in
                                    self.evaluate(module, environment, *value, path.state)?
                                {
                                    if spread.value.back_edge.is_some() {
                                        return Err(Refusal::Unsupported);
                                    }
                                    let mut record = path.value.clone();
                                    record.fields.extend(spread.value.fields);
                                    next.push(Outcome {
                                        value: record,
                                        state: spread.state,
                                    });
                                }
                            }
                            ShapeMember::Computed { .. } => return Err(Refusal::Unsupported),
                        }
                    }
                    paths = next;
                }
                Ok(paths)
            }
            Expression::Array { elements, .. } => {
                if elements.iter().any(|element| element.spread) {
                    return Err(Refusal::Unsupported);
                }
                // Element facts do not establish the array's length or contents.
                Ok(vec![Outcome {
                    value: Operand {
                        length: Some(Term::Literal(elements.len().into())),
                        ..Operand::default()
                    },
                    state,
                }])
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                let mut states = vec![state];
                for declaration in declarations {
                    let mut next = Vec::new();
                    for state in states {
                        match &module.arena.declarations[declaration.0 as usize] {
                            Declaration::Binding { pattern, value, .. } => {
                                for mut outcome in
                                    self.evaluate(module, environment, *value, state)?
                                {
                                    if outcome.value.back_edge.is_some() {
                                        return Err(Refusal::Unsupported);
                                    }
                                    if matches!(
                                        module.arena.expressions[value.0 as usize],
                                        Expression::Rec { .. }
                                    ) && let Pattern::Name { name, .. } =
                                        &module.arena.patterns[pattern.0 as usize]
                                        && let Some(closure) = outcome.value.closure.as_mut()
                                    {
                                        Rc::make_mut(closure).recursive = Some(name.clone());
                                    }
                                    bind(
                                        module,
                                        *pattern,
                                        &outcome.value,
                                        &mut outcome.state.bindings,
                                    );
                                    next.push(outcome.state);
                                }
                            }
                            Declaration::Shadow { name, value, .. } => {
                                for mut outcome in
                                    self.evaluate(module, environment, *value, state)?
                                {
                                    if outcome.value.back_edge.is_some() {
                                        return Err(Refusal::Unsupported);
                                    }
                                    outcome.state.bindings.insert(name.clone(), outcome.value);
                                    next.push(outcome.state);
                                }
                            }
                            Declaration::Signature { .. } => next.push(state),
                            Declaration::Open { .. } => return Err(Refusal::Unsupported),
                        }
                    }
                    states = next;
                }
                let mut outcomes = Vec::new();
                for state in states {
                    outcomes.extend(self.evaluate(module, environment, *result, state)?);
                }
                Ok(outcomes)
            }
            Expression::If {
                branches, fallback, ..
            } => {
                let mut remaining = vec![state];
                let mut outcomes = Vec::new();
                for branch in branches {
                    let mut untaken = Vec::new();
                    for state in remaining {
                        for condition in
                            self.evaluate(module, environment, branch.condition, state)?
                        {
                            if condition.value.back_edge.is_some() {
                                return Err(Refusal::Unsupported);
                            }
                            match condition.value.constructor.as_deref() {
                                Some("True") => outcomes.extend(self.evaluate(
                                    module,
                                    environment,
                                    branch.consequence,
                                    condition.state,
                                )?),
                                Some("False") => untaken.push(condition.state),
                                _ => {
                                    outcomes.extend(self.evaluate(
                                        module,
                                        environment,
                                        branch.consequence,
                                        condition.state.clone(),
                                    )?);
                                    untaken.push(condition.state);
                                }
                            }
                        }
                    }
                    remaining = untaken;
                }
                for state in remaining {
                    if let Some(fallback) = fallback {
                        outcomes.extend(self.evaluate(module, environment, *fallback, state)?);
                    } else {
                        outcomes.push(Outcome {
                            value: Operand::default(),
                            state,
                        });
                    }
                }
                Ok(outcomes)
            }
            Expression::Case { target, arms, .. } => {
                let mut outcomes = Vec::new();
                for target in self.evaluate(module, environment, *target, state)? {
                    if target.value.back_edge.is_some() {
                        return Err(Refusal::Unsupported);
                    }
                    for arm in arms {
                        let matched = matches_pattern(module, arm.pattern, &target.value);
                        if matched == Some(false) {
                            continue;
                        }
                        let mut state = target.state.clone();
                        bind(module, arm.pattern, &target.value, &mut state.bindings);
                        outcomes.extend(self.evaluate(module, environment, arm.body, state)?);
                        if matched == Some(true) {
                            break;
                        }
                    }
                }
                Ok(outcomes)
            }
            Expression::Apply {
                function, argument, ..
            } => {
                let (root, arguments) = super::application_spine(expression, module);
                if arguments.len() == 2
                    && let Some(callee) = static_callee(module, environment, root, &state)
                    && let Some(junction) =
                        crate::recognise::short_circuit_junction(self.context, &callee)
                {
                    let shortcut = match junction {
                        crate::recognise::Junction::And => "False",
                        crate::recognise::Junction::Or => "True",
                    };
                    let mut outcomes = Vec::new();
                    for first in self.evaluate(module, environment, arguments[0], state)? {
                        match first.value.constructor.as_deref() {
                            Some(name) if name == shortcut => outcomes.push(first),
                            Some("True" | "False") => outcomes.extend(self.evaluate(
                                module,
                                environment,
                                arguments[1],
                                first.state,
                            )?),
                            _ => {
                                outcomes.push(Outcome {
                                    value: Operand {
                                        constructor: Some(shortcut.into()),
                                        ..Operand::default()
                                    },
                                    state: first.state.clone(),
                                });
                                outcomes.extend(self.evaluate(
                                    module,
                                    environment,
                                    arguments[1],
                                    first.state,
                                )?);
                            }
                        }
                    }
                    return Ok(outcomes);
                }
                let mut outcomes = Vec::new();
                for callee in self.evaluate(module, environment, *function, state)? {
                    if callee
                        .value
                        .closure
                        .as_ref()
                        .is_some_and(|closure| closure.deferred)
                    {
                        return Err(Refusal::Unsupported);
                    }
                    for argument in self.evaluate(module, environment, *argument, callee.state)? {
                        if argument.value.back_edge.is_some() || callee.value.back_edge.is_some() {
                            return Err(Refusal::Unsupported);
                        }
                        outcomes.extend(self.apply(
                            callee.value.clone(),
                            argument.value,
                            argument.state,
                        )?);
                    }
                }
                Ok(outcomes)
            }
            _ => Ok(vec![Outcome {
                value: self.unknown(),
                state,
            }]),
        }
    }

    fn aggregate(
        &mut self,
        module: &Rc<Module>,
        environment: &Environment,
        elements: Vec<(String, ExpressionId)>,
        state: State,
    ) -> Result<Vec<Outcome>> {
        let mut paths = vec![Outcome {
            value: Operand::default(),
            state,
        }];
        for (name, expression) in elements {
            let mut next = Vec::new();
            for path in paths {
                for element in self.evaluate(module, environment, expression, path.state)? {
                    if element.value.back_edge.is_some() {
                        return Err(Refusal::Unsupported);
                    }
                    let mut record = path.value.clone();
                    record.fields.insert(name.clone(), element.value);
                    next.push(Outcome {
                        value: record,
                        state: element.state,
                    });
                }
            }
            paths = next;
        }
        Ok(paths)
    }

    fn apply(&mut self, callee: Operand, argument: Operand, state: State) -> Result<Vec<Outcome>> {
        self.step()?;
        if let Some(name) = callee.constructor {
            return Ok(vec![Outcome {
                value: Operand {
                    constructor: Some(name),
                    payload: Some(Box::new(argument)),
                    ..Operand::default()
                },
                state,
            }]);
        }
        if let Some(closure) = callee.closure {
            return self.call(&closure, argument, state);
        }
        match callee.known {
            Some(Value::Closure {
                module,
                parameter,
                body,
                environment,
                self_name,
                signature: _,
                deferred,
                ..
            }) => {
                let loaded = self
                    .context
                    .modules
                    .borrow()
                    .get(module.as_str())
                    .cloned()
                    .ok_or(Refusal::Unsupported)?;
                self.call(
                    &Rc::new(Closure {
                        module: loaded.module,
                        parameter,
                        body,
                        environment,
                        bindings: BTreeMap::new(),
                        recursive: self_name,
                        deferred,
                    }),
                    argument,
                    state,
                )
            }
            Some(Value::Primitive { name, applied, .. }) => {
                let mut arguments = callee.fields;
                for (index, value) in applied.into_iter().enumerate() {
                    arguments.insert(index.to_string(), known(value));
                }
                arguments.insert(arguments.len().to_string(), argument);
                self.primitive(&name, arguments, state)
            }
            _ => Ok(vec![Outcome {
                value: self.unknown(),
                state,
            }]),
        }
    }

    pub(crate) fn call(
        &mut self,
        closure: &Rc<Closure>,
        argument: Operand,
        state: State,
    ) -> Result<Vec<Outcome>> {
        if closure.deferred {
            return Err(Refusal::Unsupported);
        }
        let key = (Rc::as_ptr(&closure.module) as usize, closure.body);
        if self.loop_stack.last() == Some(&key) {
            return Ok(vec![Outcome {
                value: Operand {
                    back_edge: Some(Box::new(argument)),
                    ..Operand::default()
                },
                state,
            }]);
        }
        if closure.recursive.is_some() {
            return self.infer_loop(closure, argument, state);
        }
        if !self.active.insert(key) {
            return Err(Refusal::Unsupported);
        }
        let caller = state.bindings;
        let mut state = State {
            bindings: closure.bindings.clone(),
            constraints: state.constraints,
        };
        bind(
            &closure.module,
            closure.parameter,
            &argument,
            &mut state.bindings,
        );
        if let Some(name) = &closure.recursive {
            state.bindings.insert(
                name.clone(),
                Operand {
                    closure: Some(closure.clone()),
                    ..Operand::default()
                },
            );
        }
        let result = self.evaluate(&closure.module, &closure.environment, closure.body, state);
        self.active.remove(&key);
        let mut result = result?;
        for outcome in &mut result {
            outcome.state.bindings = caller.clone();
        }
        Ok(result)
    }

    fn primitive(
        &mut self,
        name: &str,
        arguments: BTreeMap<String, Operand>,
        mut state: State,
    ) -> Result<Vec<Outcome>> {
        let arity = crate::primitives::primitive_arity(name).ok_or(Refusal::Unsupported)?;
        if arguments.len() < arity {
            return Ok(vec![Outcome {
                value: Operand {
                    known: Some(Value::Primitive {
                        name: name.to_owned(),
                        arity,
                        applied: Vec::new(),
                    }),
                    fields: arguments,
                    ..Operand::default()
                },
                state,
            }]);
        }
        let first = &arguments["0"];
        let value = match name {
            "@linear.own" | "@linear.borrow" | "@linear.maybe" => first.clone(),
            "@array.len" | "@region.length" => {
                let length = first.length.clone().unwrap_or_else(|| self.fresh_term());
                state
                    .constraints
                    .extend(constraints_at_least(&length, &Term::Literal(0.into())));
                state.constraints.extend(constraints_at_most(
                    &length,
                    &Term::Literal(2_147_483_647_i64.into()),
                ));
                Operand {
                    scalar: Some(length),
                    ..Operand::default()
                }
            }
            "@int.add" | "@int.sub" => match (&first.scalar, &arguments["1"].scalar) {
                (Some(left), Some(Term::Literal(right))) => Operand {
                    scalar: Some(shift(
                        left.clone(),
                        if name == "@int.sub" {
                            -right
                        } else {
                            right.clone()
                        },
                    )),
                    ..Operand::default()
                },
                (Some(Term::Literal(left)), Some(right)) if name == "@int.add" => Operand {
                    scalar: Some(shift(right.clone(), left.clone())),
                    ..Operand::default()
                },
                _ => Operand {
                    scalar: Some(self.fresh_term()),
                    ..Operand::default()
                },
            },
            "@int.cmp" => {
                let (Some(left), Some(right)) = (&first.scalar, &arguments["1"].scalar) else {
                    return Err(Refusal::Unsupported);
                };
                let mut outcomes = Vec::new();
                for (name, constraints) in [
                    ("Less", constraints_less_than(left, right)),
                    ("Equal", constraints_equal(left, right)),
                    ("Greater", constraints_greater_than(left, right)),
                ] {
                    let mut branch = state.clone();
                    branch.constraints.extend(constraints);
                    if !inconsistent(&branch.constraints.edges) {
                        outcomes.push(Outcome {
                            value: Operand {
                                constructor: Some(name.into()),
                                ..Operand::default()
                            },
                            state: branch,
                        });
                    }
                }
                return Ok(outcomes);
            }
            "@type.inferred" if first.scalar.is_some() => {
                let type_ = match &first.type_value {
                    Some(type_) => type_.clone(),
                    None => crate::primitives::constant("@type.int").ok_or(Refusal::Unsupported)?,
                };
                known(self.context.decorate_operator_type(type_))
            }
            "@type.resolve_member" => {
                if arguments["1"].scalar.is_none() {
                    return Err(Refusal::Unsupported);
                }
                let Some(Value::Text(member)) = &first.known else {
                    return Err(Refusal::Unsupported);
                };
                // This primitive implements the built-in operation directly.
                // Resolving through attachments again can select itself.
                let operands = BTreeMap::from([
                    ("0".into(), arguments["1"].clone()),
                    ("1".into(), arguments["2"].clone()),
                ]);
                match member.as_ref() {
                    "add" => return self.primitive("@int.add", operands, state),
                    "sub" => return self.primitive("@int.sub", operands, state),
                    "eq" | "ne" | "lt" | "le" | "gt" | "ge" => {
                        let mut outcomes = self.primitive("@int.cmp", operands, state)?;
                        for outcome in &mut outcomes {
                            let ordering = outcome
                                .value
                                .constructor
                                .as_deref()
                                .expect("integer comparison has a constructor");
                            let matched = match member.as_ref() {
                                "eq" => ordering == "Equal",
                                "ne" => ordering != "Equal",
                                "lt" => ordering == "Less",
                                "le" => ordering != "Greater",
                                "gt" => ordering == "Greater",
                                "ge" => ordering != "Less",
                                _ => unreachable!(),
                            };
                            let constructor = if matched { "True" } else { "False" };
                            outcome.value.constructor = Some(constructor.into());
                        }
                        return Ok(outcomes);
                    }
                    _ => return Err(Refusal::Unsupported),
                }
            }
            "@array.push" => Operand {
                length: first.length.clone().map(|length| shift(length, 1.into())),
                ..Operand::default()
            },
            "@array.set" => Operand {
                length: first.length.clone(),
                ..Operand::default()
            },
            "@panic" => return Ok(Vec::new()),
            _ => self.unknown(),
        };
        Ok(vec![Outcome { value, state }])
    }
}

pub(crate) fn integer(value: BigInt) -> Operand {
    Operand {
        scalar: Some(Term::Literal(value)),
        ..Operand::default()
    }
}

pub(crate) fn known(value: Value) -> Operand {
    if let Value::Int(integer_value) = value {
        return integer(integer_value);
    }
    if let Value::Tag { name, payload } = value {
        return Operand {
            constructor: Some(name),
            payload: payload.map(|value| Box::new(known(*value))),
            ..Operand::default()
        };
    }
    Operand {
        known: Some(value),
        ..Operand::default()
    }
}

pub(crate) fn project(value: &Operand, name: &str) -> Option<Operand> {
    if let Some(field) = value.fields.get(name) {
        return Some(field.clone());
    }
    let fields = match value.known.as_ref()? {
        Value::Shape(fields) => fields,
        Value::Extended { members, .. } => members,
        Value::Sealed { inner, .. } => return project(&known((**inner).clone()), name),
        _ => return None,
    };
    fields.get(name).cloned().map(known)
}

pub(crate) fn bind(
    module: &Module,
    pattern: PatternId,
    value: &Operand,
    bindings: &mut BTreeMap<String, Operand>,
) {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => {
            bindings.insert(name.clone(), value.clone());
        }
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
            for (index, pattern) in elements.iter().enumerate() {
                bind(
                    module,
                    *pattern,
                    &project(value, &index.to_string()).unwrap_or_default(),
                    bindings,
                );
            }
        }
        Pattern::Shape { fields, .. } => {
            for field in fields {
                bind(
                    module,
                    field.pattern,
                    &project(value, &field.name).unwrap_or_default(),
                    bindings,
                );
            }
        }
        Pattern::Constructor {
            payload: Some(payload),
            ..
        } => bind(
            module,
            *payload,
            value.payload.as_deref().unwrap_or(&Operand::default()),
            bindings,
        ),
        _ => {}
    }
}

pub(crate) fn matches_pattern(
    module: &Module,
    pattern: PatternId,
    value: &Operand,
) -> Option<bool> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { .. } | Pattern::Wildcard { .. } => Some(true),
        Pattern::Constructor { name, payload, .. } => {
            let actual = value.constructor.as_ref()?;
            if actual != name {
                return Some(false);
            }
            match (payload, value.payload.as_deref()) {
                (Some(pattern), Some(payload)) => matches_pattern(module, *pattern, payload),
                (None, _) => Some(true),
                _ => None,
            }
        }
        Pattern::Int {
            value: expected, ..
        } => match &value.scalar {
            Some(Term::Literal(actual)) => Some(actual == expected),
            _ => None,
        },
        _ => None,
    }
}

fn inconsistent(constraints: &[Constraint]) -> bool {
    let nodes = constraints
        .iter()
        .flat_map(|edge| [edge.left, edge.right])
        .collect::<HashSet<_>>();
    let mut distances = nodes
        .iter()
        .map(|node| (*node, BigInt::from(0)))
        .collect::<HashMap<_, _>>();
    for _ in 0..nodes.len() {
        let mut changed = false;
        for edge in constraints {
            let candidate = &distances[&edge.right] + &edge.bound;
            if distances[&edge.left] > candidate {
                distances.insert(edge.left, candidate);
                changed = true;
            }
        }
        if !changed {
            return false;
        }
    }
    !nodes.is_empty()
}

impl Inference<'_> {
    pub(crate) fn join(&mut self, outcomes: &[Outcome], span: Span) -> Result<Option<Outcome>> {
        let Some(first) = outcomes.first() else {
            return Ok(None);
        };
        if outcomes.len() == 1 {
            return Ok(Some(first.clone()));
        }
        let mut outcomes = outcomes.to_vec();
        let mut value = self.join_value(&mut outcomes, span)?;
        if outcomes
            .iter()
            .any(|outcome| outcome.value.constructor != outcomes[0].value.constructor)
        {
            value.alternatives = outcomes
                .iter()
                .map(|outcome| (outcome.value.clone(), outcome.state.constraints.clone()))
                .collect();
        }
        let mut state = first.state.clone();
        state.constraints = Constraints::default();
        // Only universally valid facts survive. Constructor payloads are joined
        // separately by callers that match the constructor before projection.
        for constraint in &outcomes[0].state.constraints.edges {
            if outcomes.iter().all(|outcome| {
                entails(
                    std::slice::from_ref(constraint),
                    &outcome.state.constraints.edges,
                )
            }) {
                state.constraints.push(constraint.clone());
            }
        }
        Ok(Some(Outcome { value, state }))
    }

    fn join_value(&mut self, outcomes: &mut [Outcome], span: Span) -> Result<Operand> {
        let mut value = Operand::default();
        for length in [false, true] {
            let terms = outcomes
                .iter()
                .map(|outcome| {
                    if length {
                        outcome.value.length.clone()
                    } else {
                        outcome.value.scalar.clone()
                    }
                })
                .collect::<Option<Vec<_>>>();
            let Some(terms) = terms else {
                continue;
            };
            if terms.iter().all(|term| term == &terms[0]) {
                if length {
                    value.length = Some(terms[0].clone());
                } else {
                    value.scalar = Some(terms[0].clone());
                }
                continue;
            }
            let result = self.fresh_term();
            let mut nodes = HashSet::from([Node::Zero]);
            for (outcome, term) in outcomes.iter_mut().zip(&terms) {
                outcome
                    .state
                    .constraints
                    .extend(constraints_equal(&result, term));
                let relevant = outcome
                    .state
                    .constraints
                    .proof(&result, &Term::Literal(0.into()), span)
                    .map_err(|_| Refusal::Budget)?;
                nodes.extend(relevant.iter().flat_map(|edge| [edge.left, edge.right]));
            }
            let (result_node, _) = term_node(&result);
            let mut nodes = nodes.into_iter().collect::<Vec<_>>();
            nodes.sort();
            for node in nodes {
                for (left, right) in [(result_node, node), (node, result_node)] {
                    let mut bounds = Vec::new();
                    for outcome in outcomes.iter() {
                        let paths = shortest_paths_from(
                            right,
                            &outcome.state.constraints.edges,
                            REFINEMENT_TERM_BUDGET as usize,
                        );
                        let Some(bound) = paths.get(&left) else {
                            break;
                        };
                        bounds.push(bound.clone());
                    }
                    if bounds.len() == outcomes.len() {
                        let bound = bounds.into_iter().max().expect("return paths are nonempty");
                        for outcome in outcomes.iter_mut() {
                            outcome.state.constraints.push(Constraint {
                                left,
                                right,
                                bound: bound.clone(),
                            });
                        }
                    }
                }
            }
            if length {
                value.length = Some(result);
            } else {
                value.scalar = Some(result);
            }
        }
        let field_names = outcomes[0].value.fields.keys().cloned().collect::<Vec<_>>();
        for name in field_names {
            if !outcomes
                .iter()
                .all(|outcome| outcome.value.fields.contains_key(&name))
            {
                continue;
            }
            let mut projected = outcomes
                .iter()
                .map(|outcome| Outcome {
                    value: outcome.value.fields[&name].clone(),
                    state: outcome.state.clone(),
                })
                .collect::<Vec<_>>();
            let field = self.join_value(&mut projected, span)?;
            for (outcome, projected) in outcomes.iter_mut().zip(projected) {
                outcome.state.constraints = projected.state.constraints;
            }
            value.fields.insert(name, field);
        }
        if let Some(name) = &outcomes[0].value.constructor
            && outcomes
                .iter()
                .all(|outcome| outcome.value.constructor.as_ref() == Some(name))
        {
            value.constructor = Some(name.clone());
            if outcomes
                .iter()
                .all(|outcome| outcome.value.payload.is_some())
            {
                let mut payloads = outcomes
                    .iter()
                    .map(|outcome| Outcome {
                        value: outcome.value.payload.as_deref().unwrap().clone(),
                        state: outcome.state.clone(),
                    })
                    .collect::<Vec<_>>();
                value.payload = Some(Box::new(self.join_value(&mut payloads, span)?));
                for (outcome, payload) in outcomes.iter_mut().zip(payloads) {
                    outcome.state.constraints = payload.state.constraints;
                }
            }
        }
        Ok(value)
    }
}

fn static_callee(
    module: &Module,
    environment: &Environment,
    expression: ExpressionId,
    state: &State,
) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => match state.bindings.get(name) {
            Some(value) => value.known.clone(),
            None => lookup(environment, name),
        },
        Expression::Field { target, name, .. } => {
            project(
                &known(static_callee(module, environment, *target, state)?),
                name,
            )?
            .known
        }
        _ => None,
    }
}

#[derive(Clone)]
pub(crate) struct LoopProof {
    pub(crate) closure: Rc<Closure>,
    pub(crate) argument: Operand,
    pub(crate) initial: Operand,
    pub(crate) invariants: Vec<Constraint>,
    pub(crate) entry: Vec<Constraint>,
    pub(crate) transitions: Vec<(Vec<Constraint>, Vec<Constraint>)>,
    pub(crate) context: Constraints,
}

impl Inference<'_> {
    fn formalize(
        &mut self,
        value: &Operand,
        substitution: &mut HashMap<Identity, Term>,
    ) -> Operand {
        let mut value = value.clone();
        value.known = None;
        value.closure = None;
        value.constructor = None;
        value.payload = None;
        value.alternatives.clear();
        for initial in [&mut value.scalar, &mut value.length].into_iter().flatten() {
            let formal = self.fresh_term();
            let Term::Variable { identity, .. } = &formal else {
                unreachable!()
            };
            substitution.insert(*identity, initial.clone());
            *initial = formal;
        }
        for field in value.fields.values_mut() {
            *field = self.formalize(field, substitution);
        }
        if let Some(payload) = &mut value.payload {
            **payload = self.formalize(payload, substitution);
        }
        value
    }

    fn transfer_loop(
        &mut self,
        closure: &Rc<Closure>,
        argument: &Operand,
        context: &Constraints,
        invariants: &[Constraint],
    ) -> Result<Vec<Outcome>> {
        let key = (Rc::as_ptr(&closure.module) as usize, closure.body);
        if self.loop_stack.contains(&key) {
            return Err(Refusal::Unsupported);
        }
        let mut state = State {
            bindings: closure.bindings.clone(),
            constraints: context.clone(),
        };
        state.constraints.extend(invariants.iter().cloned());
        bind(
            &closure.module,
            closure.parameter,
            argument,
            &mut state.bindings,
        );
        let name = closure.recursive.as_ref().ok_or(Refusal::Unsupported)?;
        state.bindings.insert(
            name.clone(),
            Operand {
                closure: Some(closure.clone()),
                ..Operand::default()
            },
        );
        self.loop_stack.push(key);
        let outcomes = self.evaluate(&closure.module, &closure.environment, closure.body, state);
        self.loop_stack.pop();
        outcomes
    }

    fn infer_loop(
        &mut self,
        closure: &Rc<Closure>,
        initial: Operand,
        caller: State,
    ) -> Result<Vec<Outcome>> {
        let mut initial_substitution = HashMap::new();
        let formal = self.formalize(&initial, &mut initial_substitution);
        let formals = initial_substitution.keys().copied().collect::<HashSet<_>>();
        if initial_substitution.is_empty() {
            return Err(Refusal::Unsupported);
        }
        let mut nodes = HashSet::from([Node::Zero]);
        nodes.extend(
            initial_substitution
                .keys()
                .map(|identity| Node::Variable(*identity)),
        );
        for value in closure.bindings.values() {
            collect_nodes(value, &mut nodes);
        }
        let mut nodes = nodes.into_iter().collect::<Vec<_>>();
        nodes.sort();
        let mut bounds = BTreeSet::from([BigInt::from(-1), BigInt::from(0), BigInt::from(1)]);
        let mut operands = vec![&initial];
        operands.extend(closure.bindings.values());
        while let Some(operand) = operands.pop() {
            self.step()?;
            for term in [&operand.scalar, &operand.length].into_iter().flatten() {
                let offset = match term {
                    Term::Literal(value) => value,
                    Term::Variable { offset, .. } => offset,
                };
                bounds.insert(offset.clone());
                bounds.insert(-offset);
            }
            operands.extend(operand.fields.values());
            operands.extend(operand.payload.as_deref());
        }
        for constraint in &caller.constraints.edges {
            bounds.insert(constraint.bound.clone());
            bounds.insert(-&constraint.bound);
        }
        let mut candidates = Vec::new();
        for left in &nodes {
            for right in &nodes {
                if left == right {
                    continue;
                }
                for bound in &bounds {
                    self.step()?;
                    let candidate = Constraint {
                        left: *left,
                        right: *right,
                        bound: bound.clone(),
                    };
                    let Some(initial) =
                        substitute_constraint(&candidate, &initial_substitution, &formals)
                    else {
                        continue;
                    };
                    if entails(std::slice::from_ref(&initial), &caller.constraints.edges) {
                        candidates.push(candidate);
                        if candidates.len() > CANDIDATE_BUDGET {
                            return Err(Refusal::Budget);
                        }
                    }
                }
            }
        }
        let outcomes = loop {
            self.step()?;
            let outcomes =
                self.transfer_loop(closure, &formal, &caller.constraints, &candidates)?;
            let mut surviving = candidates.clone();
            for outcome in &outcomes {
                let Some(next) = &outcome.value.back_edge else {
                    continue;
                };
                let mut substitution = HashMap::new();
                match_terms(&formal, next, &mut substitution);
                surviving.retain(|candidate| {
                    substitute_constraint(candidate, &substitution, &formals).is_some_and(
                        |required| {
                            entails(
                                std::slice::from_ref(&required),
                                &outcome.state.constraints.edges,
                            )
                        },
                    )
                });
            }
            if surviving == candidates {
                break outcomes;
            }
            candidates = surviving;
        };
        // Replay with the final candidate set; provisional paths never become
        // evidence used by the source safety walk.
        let replay = self.transfer_loop(closure, &formal, &caller.constraints, &candidates)?;
        let entry = candidates
            .iter()
            .map(|candidate| {
                substitute_constraint(candidate, &initial_substitution, &formals)
                    .ok_or(Refusal::Unsupported)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut transitions = Vec::new();
        let mut exits = Vec::new();
        for outcome in replay {
            if let Some(next) = &outcome.value.back_edge {
                let mut substitution = HashMap::new();
                match_terms(&formal, next, &mut substitution);
                let required = candidates
                    .iter()
                    .map(|candidate| {
                        substitute_constraint(candidate, &substitution, &formals)
                            .ok_or(Refusal::Unsupported)
                    })
                    .collect::<Result<Vec<_>>>()?;
                transitions.push((outcome.state.constraints.edges, required));
            } else {
                exits.push(outcome);
            }
        }
        if exits.is_empty()
            || !outcomes
                .iter()
                .any(|outcome| outcome.value.back_edge.is_some())
        {
            return Err(Refusal::Unsupported);
        }
        let proof = LoopProof {
            closure: closure.clone(),
            argument: formal,
            initial,
            invariants: candidates,
            entry,
            transitions,
            context: caller.constraints.clone(),
        };
        self.replay_loop(&proof)?;
        self.loop_proofs.push(proof);
        for exit in &mut exits {
            exit.state.bindings = caller.bindings.clone();
        }
        Ok(exits)
    }
}

impl Inference<'_> {
    pub(crate) fn replay_loop(&mut self, proof: &LoopProof) -> Result<()> {
        let mut substitution = HashMap::new();
        match_terms(&proof.argument, &proof.initial, &mut substitution);
        let mut formal_nodes = HashSet::new();
        collect_nodes(&proof.argument, &mut formal_nodes);
        let formals = formal_nodes
            .into_iter()
            .filter_map(|node| match node {
                Node::Variable(identity) => Some(identity),
                Node::Zero => None,
            })
            .collect();
        let entry = proof
            .invariants
            .iter()
            .map(|candidate| {
                substitute_constraint(candidate, &substitution, &formals)
                    .ok_or(Refusal::Unsupported)
            })
            .collect::<Result<Vec<_>>>()?;
        if entry != proof.entry || !entails(&entry, &proof.context.edges) {
            return Err(Refusal::Unsupported);
        }
        let replay = self.transfer_loop(
            &proof.closure,
            &proof.argument,
            &proof.context,
            &proof.invariants,
        )?;
        let mut transitions = 0;
        for outcome in replay {
            if !outcome.state.constraints.within_budget() {
                return Err(Refusal::Budget);
            }
            let Some(next) = &outcome.value.back_edge else {
                continue;
            };
            transitions += 1;
            let mut substitution = HashMap::new();
            match_terms(&proof.argument, next, &mut substitution);
            let required = proof
                .invariants
                .iter()
                .map(|candidate| {
                    substitute_constraint(candidate, &substitution, &formals)
                        .ok_or(Refusal::Unsupported)
                })
                .collect::<Result<Vec<_>>>()?;
            if !entails(&required, &outcome.state.constraints.edges) {
                return Err(Refusal::Unsupported);
            }
        }
        if transitions == 0 || transitions != proof.transitions.len() {
            return Err(Refusal::Unsupported);
        }
        Ok(())
    }
}

fn collect_nodes(value: &Operand, nodes: &mut HashSet<Node>) {
    for term in [&value.scalar, &value.length].into_iter().flatten() {
        nodes.insert(term_node(term).0);
    }
    for value in value.fields.values() {
        collect_nodes(value, nodes);
    }
    if let Some(payload) = &value.payload {
        collect_nodes(payload, nodes);
    }
}

fn match_terms(formal: &Operand, actual: &Operand, substitution: &mut HashMap<Identity, Term>) {
    for (formal, actual) in [
        (&formal.scalar, &actual.scalar),
        (&formal.length, &actual.length),
    ] {
        if let (Some(Term::Variable { identity, .. }), Some(actual)) = (formal, actual) {
            substitution.insert(*identity, actual.clone());
        }
    }
    for (name, formal) in &formal.fields {
        if let Some(actual) = actual.fields.get(name) {
            match_terms(formal, actual, substitution);
        }
    }
    if let (Some(formal), Some(actual)) = (&formal.payload, &actual.payload) {
        match_terms(formal, actual, substitution);
    }
}

fn substitute_constraint(
    constraint: &Constraint,
    substitution: &HashMap<Identity, Term>,
    formals: &HashSet<Identity>,
) -> Option<Constraint> {
    let translate = |node| match node {
        Node::Zero => Some(Term::Literal(0.into())),
        Node::Variable(identity) => match substitution.get(&identity) {
            Some(term) => Some(term.clone()),
            None if formals.contains(&identity) => None,
            None => Some(Term::Variable {
                identity,
                offset: 0.into(),
            }),
        },
    };
    constraints_difference(
        &translate(constraint.left)?,
        &translate(constraint.right)?,
        constraint.bound.clone(),
    )
    .into_iter()
    .next()
}

pub(crate) fn references(value: &Operand, identity: Identity) -> bool {
    let mut pending = vec![value];
    let mut closures = HashSet::new();
    while let Some(value) = pending.pop() {
        if [&value.scalar, &value.length].into_iter().flatten().any(
            |term| matches!(term, Term::Variable { identity: found, .. } if *found == identity),
        ) {
            return true;
        }
        pending.extend(value.fields.values());
        pending.extend(value.payload.as_deref());
        for (value, facts) in &value.alternatives {
            if facts.edges.iter().any(|edge| {
                edge.left == Node::Variable(identity) || edge.right == Node::Variable(identity)
            }) {
                return true;
            }
            pending.push(value);
        }
        if let Some(closure) = &value.closure
            && closures.insert(Rc::as_ptr(closure))
        {
            pending.extend(closure.bindings.values());
        }
    }
    false
}
