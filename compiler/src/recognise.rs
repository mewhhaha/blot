use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

use num_bigint::BigInt;

use crate::ast::{Declaration, Expression, ExpressionId, Module, Pattern, PatternId, Span};
use crate::eval::{Context, Phase, Runtime, apply, run};
use crate::value::Value;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Ordering {
    Less,
    Equal,
    Greater,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Junction {
    And,
    Or,
}

pub fn comparison(context: &Rc<Context>, value: &Value) -> Option<BTreeSet<Ordering>> {
    if !factored(context, value) {
        return None;
    }
    let less = probe_int(context, value, 0, 1)?;
    let equal = probe_int(context, value, 1, 1)?;
    let greater = probe_int(context, value, 1, 0)?;
    Some(orderings_from_answers(less, equal, greater))
}

fn orderings_from_answers(less: bool, equal: bool, greater: bool) -> BTreeSet<Ordering> {
    let mut orderings = BTreeSet::new();
    if less {
        orderings.insert(Ordering::Less);
    }
    if equal {
        orderings.insert(Ordering::Equal);
    }
    if greater {
        orderings.insert(Ordering::Greater);
    }
    orderings
}

pub fn junction(context: &Rc<Context>, value: &Value) -> Option<Junction> {
    let true_true = probe_bool(context, value, true, true)?;
    let true_false = probe_bool(context, value, true, false)?;
    let false_true = probe_bool(context, value, false, true)?;
    let false_false = probe_bool(context, value, false, false)?;
    match (true_true, true_false, false_true, false_false) {
        (true, false, false, false) => Some(Junction::And),
        (true, true, true, false) => Some(Junction::Or),
        _ => None,
    }
}

pub fn negation(context: &Rc<Context>, value: &Value) -> bool {
    probe_bool_unary(context, value, true) == Some(false)
        && probe_bool_unary(context, value, false) == Some(true)
}

fn factored(context: &Rc<Context>, value: &Value) -> bool {
    let Value::Closure {
        module,
        parameter,
        body,
        self_name: None,
        ..
    } = value
    else {
        return false;
    };
    let Some(module) = context
        .modules
        .borrow()
        .get(module.as_str())
        .map(|loaded| loaded.module.clone())
    else {
        return false;
    };
    let Some(first) = pattern_name(&module, *parameter) else {
        return false;
    };
    let Expression::Lambda {
        parameter, body, ..
    } = &module.arena.expressions[body.0 as usize]
    else {
        return false;
    };
    let Some(second) = pattern_name(&module, *parameter) else {
        return false;
    };
    if first == second {
        return false;
    }
    let mut scan = FactorScan {
        module: &module,
        first,
        second,
        uses: HashMap::new(),
        comparisons: 0,
        refused: false,
    };
    scan.expression(*body);
    !scan.refused
        && scan.comparisons == 1
        && scan.uses.get(first) == Some(&1)
        && scan.uses.get(second) == Some(&1)
}

struct FactorScan<'a> {
    module: &'a Module,
    first: &'a str,
    second: &'a str,
    uses: HashMap<String, usize>,
    comparisons: usize,
    refused: bool,
}

impl FactorScan<'_> {
    fn expression(&mut self, expression: ExpressionId) {
        if self.refused {
            return;
        }
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => {
                *self.uses.entry(name.clone()).or_default() += 1;
            }
            Expression::Int { .. }
            | Expression::Float { .. }
            | Expression::Text { .. }
            | Expression::Unit { .. }
            | Expression::Intrinsic { .. }
            | Expression::Tag { .. } => {}
            Expression::Apply {
                function, argument, ..
            } => {
                if self.int_comparison(*function, *argument) {
                    return;
                }
                self.expression(*function);
                self.expression(*argument);
            }
            Expression::Field { target, .. } => self.expression(*target),
            Expression::Lambda {
                parameter, body, ..
            } => {
                self.pattern(*parameter);
                self.expression(*body);
            }
            Expression::Array { elements, .. } => {
                for element in elements {
                    self.expression(element.value);
                }
            }
            Expression::Tuple { elements, .. } => {
                for element in elements {
                    self.expression(*element);
                }
            }
            Expression::Shape { members, .. } => {
                for member in members {
                    let value = match member {
                        crate::ast::ShapeMember::Field { value, .. }
                        | crate::ast::ShapeMember::Spread { value } => value,
                    };
                    self.expression(*value);
                }
            }
            Expression::If {
                branches, fallback, ..
            } => {
                for branch in branches {
                    self.expression(branch.condition);
                    self.expression(branch.consequence);
                }
                if let Some(fallback) = fallback {
                    self.expression(*fallback);
                }
            }
            Expression::Case { target, arms, .. } => {
                self.expression(*target);
                for arm in arms {
                    self.pattern(arm.pattern);
                    self.expression(arm.body);
                }
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                for declaration in declarations {
                    match &self.module.arena.declarations[declaration.0 as usize] {
                        Declaration::Binding { pattern, value, .. } => {
                            self.pattern(*pattern);
                            self.expression(*value);
                        }
                        Declaration::Shadow { name, value, .. } => {
                            if name == self.first || name == self.second {
                                self.refused = true;
                            }
                            self.expression(*value);
                        }
                        Declaration::Open { .. } => self.refused = true,
                    }
                }
                self.expression(*result);
            }
            Expression::Rec { .. } => self.refused = true,
            Expression::Comptime { body, .. } => self.expression(*body),
        }
    }

    fn pattern(&mut self, pattern: PatternId) {
        match &self.module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } if name == self.first || name == self.second => {
                self.refused = true;
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for pattern in elements {
                    self.pattern(*pattern);
                }
            }
            Pattern::Constructor {
                payload: Some(payload),
                ..
            } => self.pattern(*payload),
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    self.pattern(field.pattern);
                }
            }
            _ => {}
        }
    }

    fn int_comparison(&mut self, function: ExpressionId, right: ExpressionId) -> bool {
        let Expression::Apply {
            function,
            argument: left,
            ..
        } = &self.module.arena.expressions[function.0 as usize]
        else {
            return false;
        };
        let Expression::Intrinsic { name, .. } =
            &self.module.arena.expressions[function.0 as usize]
        else {
            return false;
        };
        if name != "@int.cmp" {
            return false;
        }
        let Expression::Var { name: left, .. } = &self.module.arena.expressions[left.0 as usize]
        else {
            return false;
        };
        let Expression::Var { name: right, .. } = &self.module.arena.expressions[right.0 as usize]
        else {
            return false;
        };
        if left == right {
            return false;
        }
        let arguments_are_parameters = (left == self.first && right == self.second)
            || (left == self.second && right == self.first);
        if !arguments_are_parameters {
            return false;
        }
        self.comparisons += 1;
        *self.uses.entry(left.clone()).or_default() += 1;
        *self.uses.entry(right.clone()).or_default() += 1;
        true
    }
}

fn pattern_name(module: &Module, pattern: PatternId) -> Option<&str> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => Some(name),
        _ => None,
    }
}

fn probe_int(context: &Rc<Context>, value: &Value, left: i64, right: i64) -> Option<bool> {
    let runtime = probe_runtime(value);
    let partial = run(apply(
        context.clone(),
        value.clone(),
        Value::Int(BigInt::from(left)),
        nowhere(),
        runtime.clone(),
    ))
    .ok()?;
    let answer = run(apply(
        context.clone(),
        partial,
        Value::Int(BigInt::from(right)),
        nowhere(),
        runtime,
    ))
    .ok()?;
    boolean(answer)
}

fn probe_bool(context: &Rc<Context>, value: &Value, left: bool, right: bool) -> Option<bool> {
    let runtime = probe_runtime(value);
    let partial = run(apply(
        context.clone(),
        value.clone(),
        boolean_value(left),
        nowhere(),
        runtime.clone(),
    ))
    .ok()?;
    let answer = run(apply(
        context.clone(),
        partial,
        boolean_value(right),
        nowhere(),
        runtime,
    ))
    .ok()?;
    boolean(answer)
}

fn probe_bool_unary(context: &Rc<Context>, value: &Value, argument: bool) -> Option<bool> {
    let runtime = probe_runtime(value);
    let answer = run(apply(
        context.clone(),
        value.clone(),
        boolean_value(argument),
        nowhere(),
        runtime,
    ))
    .ok()?;
    boolean(answer)
}

fn probe_runtime(value: &Value) -> Runtime {
    let module = match value {
        Value::Closure { module, .. } => module.as_ref().clone(),
        _ => String::new(),
    };
    let runtime = Runtime::new(Phase::Comptime, module);
    runtime.fuel.set(2_000);
    runtime
}

fn boolean(value: Value) -> Option<bool> {
    match value {
        Value::Tag {
            name,
            payload: None,
        } if name == "True" => Some(true),
        Value::Tag {
            name,
            payload: None,
        } if name == "False" => Some(false),
        _ => None,
    }
}

fn boolean_value(value: bool) -> Value {
    let name = if value { "True" } else { "False" };
    Value::Tag {
        name: name.to_owned(),
        payload: None,
    }
}

fn nowhere() -> Span {
    Span { start: 0, end: 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_truth_table_is_a_semantic_ordering_set() {
        assert_eq!(
            orderings_from_answers(true, false, true),
            BTreeSet::from([Ordering::Less, Ordering::Greater])
        );
        assert!(orderings_from_answers(false, false, false).is_empty());
        assert_eq!(
            orderings_from_answers(true, true, true),
            BTreeSet::from([Ordering::Less, Ordering::Equal, Ordering::Greater])
        );
    }
}
