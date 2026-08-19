use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{Expression, ExpressionId, Module, Pattern};
use crate::eval::Context;
use crate::value::{Environment, Value, lookup};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Measure {
    ArrayLength,
    RegionLength,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Summary {
    pub measure: Measure,
    pub parameter: usize,
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
            let measure = primitive_measure(name)?;
            if applied.is_empty() {
                return Some(Summary {
                    measure,
                    parameter: 0,
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
        let first = match &loaded.module.arena.patterns[parameter.0 as usize] {
            Pattern::Name { name, .. } => Some(name.clone()),
            Pattern::Wildcard { .. } => None,
            _ => {
                active.remove(&key);
                self.closures.borrow_mut().insert(key, None);
                return None;
            }
        };
        let result = result_measure(
            self,
            &loaded.module,
            *body,
            vec![first],
            environment,
            context,
            active,
        );
        active.remove(&key);
        self.closures.borrow_mut().insert(key, result.clone());
        result
    }
}

fn result_measure(
    summaries: &Summaries,
    module: &Module,
    expression: ExpressionId,
    mut parameters: Vec<Option<String>>,
    environment: &Environment,
    context: &Context,
    active: &mut HashSet<(String, ExpressionId, usize)>,
) -> Option<Summary> {
    if let Expression::Lambda {
        parameter, body, ..
    } = &module.arena.expressions[expression.0 as usize]
    {
        let parameter = match &module.arena.patterns[parameter.0 as usize] {
            Pattern::Name { name, .. } => Some(name.clone()),
            Pattern::Wildcard { .. } => None,
            _ => return None,
        };
        parameters.push(parameter);
        return result_measure(
            summaries,
            module,
            *body,
            parameters,
            environment,
            context,
            active,
        );
    }

    let (callee, arguments) = application_spine(expression, module);
    if arguments.is_empty() {
        return None;
    }
    if let Expression::Intrinsic { name, .. } = &module.arena.expressions[callee.0 as usize] {
        if arguments.len() == 1
            && let Some(measure) = primitive_measure(name)
            && let Some(parameter) = parameter_index(module, arguments[0], &parameters)
        {
            return Some(Summary {
                measure,
                parameter,
                offset: BigInt::from(0),
            });
        }
        if matches!(name.as_str(), "@int.add" | "@int.sub") && arguments.len() == 2 {
            if let Some(mut left) = result_measure(
                summaries,
                module,
                arguments[0],
                parameters.clone(),
                environment,
                context,
                active,
            ) && let Some(right) = integer(module, arguments[1], environment)
            {
                if name == "@int.sub" {
                    left.offset -= right;
                } else {
                    left.offset += right;
                }
                return Some(left);
            }
            if name == "@int.add"
                && let Some(mut right) = result_measure(
                    summaries,
                    module,
                    arguments[1],
                    parameters.clone(),
                    environment,
                    context,
                    active,
                )
                && let Some(left) = integer(module, arguments[0], environment)
            {
                right.offset += left;
                return Some(right);
            }
            return None;
        }
    }

    let callee = value_at(module, callee, environment)?;
    let mut summary = summaries.derive_with(&callee, context, active)?;
    let argument = *arguments.get(summary.parameter)?;
    summary.parameter = parameter_index(module, argument, &parameters)?;
    Some(summary)
}

fn parameter_index(
    module: &Module,
    expression: ExpressionId,
    parameters: &[Option<String>],
) -> Option<usize> {
    parameters.iter().position(|parameter| {
        parameter
            .as_deref()
            .is_some_and(|name| is_parameter(module, expression, name))
    })
}

fn primitive_measure(name: &str) -> Option<Measure> {
    match name {
        "@array.len" => Some(Measure::ArrayLength),
        "@region.length" => Some(Measure::RegionLength),
        _ => None,
    }
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
