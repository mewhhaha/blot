//! Pure predicate-defined integer types.
//!
//! Accepted predicates are normalized into the existing range/union value
//! domain. Nothing from this module crosses the Runtime HIR boundary.

use std::cmp::Ordering as SortOrdering;
use std::collections::BTreeSet;
use std::rc::Rc;

use num_bigint::BigInt;

use crate::ast::{Expression, ExpressionId, Module, Pattern, PatternId, Qualifier, Span};
use crate::diagnostic::Diagnostic;
use crate::eval::Context;
use crate::recognise::{Junction, Ordering, comparison, junction, negation};
use crate::value::{Domain, Environment, Value, lookup};

const MAX_PREDICATE_NODES: usize = 256;

#[derive(Clone, Debug)]
struct Interval {
    low: Option<BigInt>,
    high: Option<BigInt>,
}

pub fn refine(
    context: &Rc<Context>,
    base: &Value,
    predicate: &Value,
    span: Span,
) -> Result<Value, Diagnostic> {
    let base_intervals = base_intervals(base, span)?;
    let base_domain = runtime_integer_domain();
    let base_intervals = intersection(&base_intervals, &base_domain);
    let Value::Closure {
        module,
        parameter,
        body,
        environment,
        self_name: None,
        ..
    } = predicate
    else {
        return Err(unsupported(
            span,
            "The predicate must be a non-recursive unary function.",
        ));
    };
    let loaded = context
        .modules
        .borrow()
        .get(module.as_str())
        .cloned()
        .ok_or_else(|| unsupported(span, "The predicate's module is not loaded."))?;
    let subject = pattern_name(&loaded.module, *parameter).ok_or_else(|| {
        unsupported(
            span,
            "The predicate parameter must be one unqualified name.",
        )
    })?;
    let mut budget = MAX_PREDICATE_NODES;
    let accepted = predicate_intervals(
        context,
        &loaded.module,
        *body,
        subject,
        environment,
        span,
        &mut budget,
    )?;
    let refined = intersection(&base_intervals, &accepted);
    if refined.is_empty() {
        return Err(Diagnostic::new(
            "BLOT_EMPTY_REFINEMENT",
            "The predicate accepts no value from its base integer type.",
            span,
        ));
    }
    Ok(preserve_extensions(base, interval_value(refined)))
}

fn runtime_integer_domain() -> Vec<Interval> {
    vec![Interval {
        low: Some(minimum_i64()),
        high: Some(maximum_i64()),
    }]
}

fn preserve_extensions(base: &Value, refined: Value) -> Value {
    match base {
        Value::Extended { inner, members } => Value::Extended {
            inner: Box::new(preserve_extensions(inner, refined)),
            members: members.clone(),
        },
        _ => refined,
    }
}

#[allow(clippy::too_many_arguments)]
fn predicate_intervals(
    context: &Rc<Context>,
    module: &Module,
    expression: ExpressionId,
    subject: &str,
    environment: &Environment,
    span: Span,
    budget: &mut usize,
) -> Result<Vec<Interval>, Diagnostic> {
    if *budget == 0 {
        return Err(unsupported(
            span,
            &format!("A predicate may contain at most {MAX_PREDICATE_NODES} expression nodes."),
        ));
    }
    *budget -= 1;
    if let Expression::If {
        branches,
        fallback: Some(fallback),
        ..
    } = &module.arena.expressions[expression.0 as usize]
        && let [branch] = branches.as_slice()
    {
        let left = predicate_intervals(
            context,
            module,
            branch.condition,
            subject,
            environment,
            span,
            budget,
        )?;
        if tag_named(module, *fallback, "False") {
            let right = predicate_intervals(
                context,
                module,
                branch.consequence,
                subject,
                environment,
                span,
                budget,
            )?;
            return Ok(intersection(&left, &right));
        }
        if tag_named(module, branch.consequence, "True") {
            let right = predicate_intervals(
                context,
                module,
                *fallback,
                subject,
                environment,
                span,
                budget,
            )?;
            let mut either = left;
            either.extend(right);
            return Ok(normalize(either));
        }
    }
    let (callee, arguments) = application(module, expression).ok_or_else(|| {
        unsupported(
            expression_span(module, expression),
            "The predicate must be built from integer comparisons and boolean operators.",
        )
    })?;
    let callee_value = resolve(module, callee, subject, environment).ok_or_else(|| {
        unsupported(
            expression_span(module, callee),
            "This predicate function is not compile-time-known.",
        )
    })?;

    if arguments.len() == 2 {
        if let Some(shape) = junction(context, &callee_value) {
            let left = predicate_intervals(
                context,
                module,
                arguments[0],
                subject,
                environment,
                span,
                budget,
            )?;
            let right = predicate_intervals(
                context,
                module,
                arguments[1],
                subject,
                environment,
                span,
                budget,
            )?;
            return Ok(match shape {
                Junction::And => intersection(&left, &right),
                Junction::Or => {
                    let mut both = left;
                    both.extend(right);
                    normalize(both)
                }
            });
        }

        if let Some(mut relation) = comparison(context, &callee_value) {
            let left = arguments[0];
            let right = arguments[1];
            if is_subject(module, left, subject) {
                let witness =
                    integer_witness(module, right, subject, environment).ok_or_else(|| {
                        unsupported(
                            expression_span(module, right),
                            "A comparison witness must be a compile-time integer.",
                        )
                    })?;
                return Ok(comparison_intervals(relation, witness));
            }
            if is_subject(module, right, subject) {
                let witness =
                    integer_witness(module, left, subject, environment).ok_or_else(|| {
                        unsupported(
                            expression_span(module, left),
                            "A comparison witness must be a compile-time integer.",
                        )
                    })?;
                relation = mirror(relation);
                return Ok(comparison_intervals(relation, witness));
            }
        }
    }

    if arguments.len() == 1 && negation(context, &callee_value) {
        let inner = predicate_intervals(
            context,
            module,
            arguments[0],
            subject,
            environment,
            span,
            budget,
        )?;
        return Ok(complement(&inner));
    }

    Err(unsupported(
        expression_span(module, expression),
        "This call is not a recognized comparison, conjunction, disjunction, or negation.",
    ))
}

fn tag_named(module: &Module, expression: ExpressionId, expected: &str) -> bool {
    matches!(
        &module.arena.expressions[expression.0 as usize],
        Expression::Tag { name, .. } if name == expected
    )
}

fn pattern_name(module: &Module, pattern: PatternId) -> Option<&str> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name {
            name,
            qualifier: Qualifier::None,
            ..
        } => Some(name),
        _ => None,
    }
}

fn application(
    module: &Module,
    expression: ExpressionId,
) -> Option<(ExpressionId, Vec<ExpressionId>)> {
    let mut arguments = Vec::new();
    let mut current = expression;
    while let Expression::Apply {
        function, argument, ..
    } = &module.arena.expressions[current.0 as usize]
    {
        arguments.push(*argument);
        current = *function;
    }
    if arguments.is_empty() {
        return None;
    }
    arguments.reverse();
    Some((current, arguments))
}

fn resolve(
    module: &Module,
    expression: ExpressionId,
    subject: &str,
    environment: &Environment,
) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } if name != subject => lookup(environment, name),
        Expression::Field { target, name, .. } => {
            let target = resolve(module, *target, subject, environment)?;
            match target {
                Value::Shape(fields) => fields.get(name).cloned(),
                Value::Extended { members, .. } => members.get(name).cloned(),
                _ => None,
            }
        }
        _ => None,
    }
}

fn is_subject(module: &Module, expression: ExpressionId, subject: &str) -> bool {
    matches!(
        &module.arena.expressions[expression.0 as usize],
        Expression::Var { name, .. } if name == subject
    )
}

fn integer_witness(
    module: &Module,
    expression: ExpressionId,
    subject: &str,
    environment: &Environment,
) -> Option<BigInt> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Int { value, .. } => Some(value.clone()),
        Expression::Var { name, .. } if name != subject => match lookup(environment, name) {
            Some(Value::Int(value)) => Some(value),
            _ => None,
        },
        _ => None,
    }
}

fn comparison_intervals(orderings: BTreeSet<Ordering>, witness: BigInt) -> Vec<Interval> {
    let one = BigInt::from(1_u8);
    let mut intervals = Vec::new();
    if orderings.contains(&Ordering::Less) {
        intervals.push(Interval {
            low: None,
            high: Some(witness.clone() - one.clone()),
        });
    }
    if orderings.contains(&Ordering::Equal) {
        intervals.push(Interval {
            low: Some(witness.clone()),
            high: Some(witness.clone()),
        });
    }
    if orderings.contains(&Ordering::Greater) {
        intervals.push(Interval {
            low: Some(witness + one),
            high: None,
        });
    }
    normalize(intervals)
}

fn mirror(orderings: BTreeSet<Ordering>) -> BTreeSet<Ordering> {
    let mut mirrored = BTreeSet::new();
    if orderings.contains(&Ordering::Less) {
        mirrored.insert(Ordering::Greater);
    }
    if orderings.contains(&Ordering::Equal) {
        mirrored.insert(Ordering::Equal);
    }
    if orderings.contains(&Ordering::Greater) {
        mirrored.insert(Ordering::Less);
    }
    mirrored
}

fn base_intervals(base: &Value, span: Span) -> Result<Vec<Interval>, Diagnostic> {
    match base {
        Value::Extended { inner, .. } => base_intervals(inner, span),
        Value::Int(value) => Ok(vec![Interval {
            low: Some(value.clone()),
            high: Some(value.clone()),
        }]),
        Value::Union(members) => {
            let mut intervals = Vec::new();
            for member in members {
                intervals.extend(base_intervals(member, span)?);
            }
            Ok(normalize(intervals))
        }
        Value::Range { low, high, domain } => {
            let domain = domain.unwrap_or_else(|| {
                if matches!(**low, Value::Text(_)) || matches!(**high, Value::Text(_)) {
                    Domain::Text
                } else {
                    Domain::Int
                }
            });
            if domain != Domain::Int {
                return Err(unsupported(
                    span,
                    "The first predicate-refinement slice accepts integer bases only.",
                ));
            }
            Ok(vec![Interval {
                low: bound(low, span)?,
                high: bound(high, span)?,
            }])
        }
        _ => Err(unsupported(
            span,
            "The refinement base must be an integer type.",
        )),
    }
}

fn bound(value: &Value, span: Span) -> Result<Option<BigInt>, Diagnostic> {
    match value {
        Value::Unbounded => Ok(None),
        Value::Int(value) => Ok(Some(value.clone())),
        _ => Err(unsupported(
            span,
            "An integer range has a non-integer bound.",
        )),
    }
}

fn normalize(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.retain(|interval| match (&interval.low, &interval.high) {
        (Some(low), Some(high)) => low <= high,
        _ => true,
    });
    intervals.sort_by(|left, right| match (&left.low, &right.low) {
        (None, None) => SortOrdering::Equal,
        (None, Some(_)) => SortOrdering::Less,
        (Some(_), None) => SortOrdering::Greater,
        (Some(left), Some(right)) => left.cmp(right),
    });
    let mut merged: Vec<Interval> = Vec::new();
    for next in intervals {
        let Some(previous) = merged.last_mut() else {
            merged.push(next);
            continue;
        };
        let touches = match (&previous.high, &next.low) {
            (None, _) | (_, None) => true,
            (Some(high), Some(low)) => low <= &(high + BigInt::from(1_u8)),
        };
        if !touches {
            merged.push(next);
            continue;
        }
        previous.high = match (&previous.high, next.high) {
            (None, _) | (_, None) => None,
            (Some(left), Some(right)) => Some(std::cmp::max(left.clone(), right)),
        };
    }
    merged
}

fn intersection(left: &[Interval], right: &[Interval]) -> Vec<Interval> {
    let mut overlaps = Vec::new();
    for one in left {
        for other in right {
            let low = maximum_low(&one.low, &other.low);
            let high = minimum_high(&one.high, &other.high);
            let inhabited = match (&low, &high) {
                (Some(low), Some(high)) => low <= high,
                _ => true,
            };
            if inhabited {
                overlaps.push(Interval { low, high });
            }
        }
    }
    normalize(overlaps)
}

fn complement(intervals: &[Interval]) -> Vec<Interval> {
    let intervals = normalize(intervals.to_vec());
    let mut pieces = Vec::new();
    let mut low = None;
    for interval in intervals {
        if let Some(interval_low) = interval.low {
            pieces.push(Interval {
                low,
                high: Some(interval_low - BigInt::from(1_u8)),
            });
        }
        let Some(interval_high) = interval.high else {
            return normalize(pieces);
        };
        low = Some(interval_high + BigInt::from(1_u8));
    }
    pieces.push(Interval { low, high: None });
    normalize(pieces)
}

fn maximum_low(left: &Option<BigInt>, right: &Option<BigInt>) -> Option<BigInt> {
    match (left, right) {
        (None, value) | (value, None) => value.clone(),
        (Some(left), Some(right)) => Some(std::cmp::max(left.clone(), right.clone())),
    }
}

fn minimum_high(left: &Option<BigInt>, right: &Option<BigInt>) -> Option<BigInt> {
    match (left, right) {
        (None, value) | (value, None) => value.clone(),
        (Some(left), Some(right)) => Some(std::cmp::min(left.clone(), right.clone())),
    }
}

fn minimum_i64() -> BigInt {
    -(BigInt::from(1_u8) << 63_usize)
}

fn maximum_i64() -> BigInt {
    (BigInt::from(1_u8) << 63_usize) - BigInt::from(1_u8)
}

fn interval_value(intervals: Vec<Interval>) -> Value {
    let minimum = minimum_i64();
    let maximum = maximum_i64();
    let mut values = intervals.into_iter().map(|interval| {
        let low = interval.low.unwrap_or_else(|| minimum.clone());
        let high = interval.high.unwrap_or_else(|| maximum.clone());
        if low == high {
            Value::Int(low)
        } else {
            Value::Range {
                low: Box::new(Value::Int(low)),
                high: Box::new(Value::Int(high)),
                domain: Some(Domain::Int),
            }
        }
    });
    let first = values
        .next()
        .expect("an inhabited refinement has one interval");
    let remaining: Vec<Value> = values.collect();
    if remaining.is_empty() {
        return first;
    }
    let mut members = vec![first];
    members.extend(remaining);
    Value::Union(members)
}

fn expression_span(module: &Module, expression: ExpressionId) -> Span {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { span, .. }
        | Expression::Int { span, .. }
        | Expression::Float { span, .. }
        | Expression::Text { span, .. }
        | Expression::Unit { span }
        | Expression::Intrinsic { span, .. }
        | Expression::Tag { span, .. }
        | Expression::Apply { span, .. }
        | Expression::Field { span, .. }
        | Expression::Lambda { span, .. }
        | Expression::Array { span, .. }
        | Expression::Tuple { span, .. }
        | Expression::Shape { span, .. }
        | Expression::If { span, .. }
        | Expression::Case { span, .. }
        | Expression::Block { span, .. }
        | Expression::Rec { span, .. }
        | Expression::Comptime { span, .. } => *span,
    }
}

fn unsupported(span: Span, reason: &str) -> Diagnostic {
    Diagnostic::new("BLOT_REFINEMENT_PREDICATE", reason, span)
}
