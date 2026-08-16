use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{Expression, ExpressionId, Module, Pattern};
use crate::eval::Context;
use crate::value::{Environment, Value, lookup};

#[derive(Clone)]
pub struct Summary {
    pub offset: BigInt,
}

#[derive(Default)]
pub struct Summaries {
    closures: RefCell<HashMap<(String, ExpressionId, usize), Option<Summary>>>,
}

impl Summaries {
    pub fn derive(&self, value: &Value, context: &Context) -> Option<Summary> {
        self.derive_with(value, context, &mut HashSet::new())
    }

    fn derive_with(
        &self,
        value: &Value,
        context: &Context,
        active: &mut HashSet<(String, ExpressionId, usize)>,
    ) -> Option<Summary> {
        if let Value::Primitive { name, applied, .. } = value {
            if name == "@array.len" && applied.is_empty() {
                return Some(Summary {
                    offset: BigInt::from(0),
                });
            }
            return None;
        }
        let Value::Closure {
            module,
            parameter,
            body,
            environment,
            ..
        } = value
        else {
            return None;
        };
        let key = (
            module.as_ref().clone(),
            *body,
            std::rc::Rc::as_ptr(environment) as usize,
        );
        if let Some(cached) = self.closures.borrow().get(&key) {
            return cached.clone();
        }
        if !active.insert(key.clone()) {
            return None;
        }
        let loaded = context.modules.borrow().get(module.as_ref()).cloned()?;
        let Pattern::Name { name, .. } = &loaded.module.arena.patterns[parameter.0 as usize] else {
            active.remove(&key);
            self.closures.borrow_mut().insert(key, None);
            return None;
        };
        let result = result_offset(
            self,
            &loaded.module,
            *body,
            name,
            environment,
            context,
            active,
        )
        .map(|offset| Summary { offset });
        active.remove(&key);
        self.closures.borrow_mut().insert(key, result.clone());
        result
    }
}

fn result_offset(
    summaries: &Summaries,
    module: &Module,
    expression: ExpressionId,
    parameter: &str,
    environment: &Environment,
    context: &Context,
    active: &mut HashSet<(String, ExpressionId, usize)>,
) -> Option<BigInt> {
    let (callee, arguments) = application_spine(expression, module);
    if arguments.is_empty() {
        return None;
    }
    if let Expression::Intrinsic { name, .. } = &module.arena.expressions[callee.0 as usize] {
        if name == "@array.len"
            && arguments.len() == 1
            && is_parameter(module, arguments[0], parameter)
        {
            return Some(BigInt::from(0));
        }
        if matches!(name.as_str(), "@int.add" | "@int.sub") && arguments.len() == 2 {
            if let Some(left) = result_offset(
                summaries,
                module,
                arguments[0],
                parameter,
                environment,
                context,
                active,
            ) && let Some(right) = integer(module, arguments[1], environment)
            {
                if name == "@int.sub" {
                    return Some(left - right);
                }
                return Some(left + right);
            }
            if name == "@int.add"
                && let Some(right) = result_offset(
                    summaries,
                    module,
                    arguments[1],
                    parameter,
                    environment,
                    context,
                    active,
                )
                && let Some(left) = integer(module, arguments[0], environment)
            {
                return Some(left + right);
            }
            return None;
        }
    }
    if arguments.len() != 1 || !is_parameter(module, arguments[0], parameter) {
        return None;
    }
    let callee = value_at(module, callee, environment)?;
    summaries
        .derive_with(&callee, context, active)
        .map(|summary| summary.offset)
}

fn is_parameter(module: &Module, expression: ExpressionId, parameter: &str) -> bool {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => name == parameter,
        Expression::Apply { .. } => {
            let (callee, arguments) = application_spine(expression, module);
            let Expression::Intrinsic { name, .. } = &module.arena.expressions[callee.0 as usize]
            else {
                return false;
            };
            matches!(
                name.as_str(),
                "@linear.borrow" | "@linear.own" | "@linear.maybe"
            ) && arguments.len() == 1
                && is_parameter(module, arguments[0], parameter)
        }
        _ => false,
    }
}

fn integer(module: &Module, expression: ExpressionId, environment: &Environment) -> Option<BigInt> {
    if let Expression::Int { value, .. } = &module.arena.expressions[expression.0 as usize] {
        return Some(value.clone());
    }
    match value_at(module, expression, environment)? {
        Value::Int(value) => Some(value),
        _ => None,
    }
}

fn value_at(module: &Module, expression: ExpressionId, environment: &Environment) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => lookup(environment, name),
        Expression::Field { target, name, .. } => match value_at(module, *target, environment)? {
            Value::Shape(fields) => fields.get(name).cloned(),
            Value::Extended { members, .. } => members.get(name).cloned(),
            Value::Sealed { inner, .. } => match *inner {
                Value::Shape(fields) => fields.get(name).cloned(),
                _ => None,
            },
            _ => None,
        },
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
