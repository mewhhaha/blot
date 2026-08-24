use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember};
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RelationshipTransform {
    Parameter(usize),
    Tuple(Vec<Option<RelationshipTransform>>),
    Record(BTreeMap<String, Option<RelationshipTransform>>),
    Choice(BTreeMap<String, Option<RelationshipTransform>>),
    Project {
        target: Box<RelationshipTransform>,
        field: String,
    },
    Payload {
        target: Box<RelationshipTransform>,
        constructor: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelationshipSummary {
    pub arity: usize,
    pub result: RelationshipTransform,
}

#[derive(Default)]
pub struct Summaries {
    closures: RefCell<HashMap<(String, ExpressionId, usize), Option<Summary>>>,
    relationships: RefCell<HashMap<(String, ExpressionId, usize), Option<RelationshipSummary>>>,
}

impl Summaries {
    pub fn derive(&self, value: &Value, context: &Context) -> Option<Summary> {
        self.derive_with(value, context, &mut HashSet::new())
    }

    pub fn derive_relationship(
        &self,
        value: &Value,
        context: &Context,
    ) -> Option<RelationshipSummary> {
        self.derive_relationship_with(value, context, &mut HashSet::new())
    }

    fn derive_relationship_with(
        &self,
        value: &Value,
        context: &Context,
        active: &mut HashSet<(String, ExpressionId, usize)>,
    ) -> Option<RelationshipSummary> {
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
        if let Some(cached) = self.relationships.borrow().get(&key) {
            return cached.clone();
        }
        if !active.insert(key.clone()) {
            return None;
        }
        let loaded = context.modules.borrow().get(module.as_ref()).cloned()?;
        let mut bindings = HashMap::new();
        bind_transform_pattern(
            &loaded.module,
            *parameter,
            Some(RelationshipTransform::Parameter(0)),
            &mut bindings,
        );
        let mut traversal = RelationshipTraversal {
            environment,
            context,
            active,
        };
        let result = relationship_result(self, &loaded.module, *body, bindings, 1, &mut traversal);
        active.remove(&key);
        self.relationships.borrow_mut().insert(key, result.clone());
        result
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

struct RelationshipTraversal<'a> {
    environment: &'a Environment,
    context: &'a Context,
    active: &'a mut HashSet<(String, ExpressionId, usize)>,
}

fn relationship_result(
    summaries: &Summaries,
    module: &Module,
    expression: ExpressionId,
    mut bindings: HashMap<String, RelationshipTransform>,
    arity: usize,
    traversal: &mut RelationshipTraversal,
) -> Option<RelationshipSummary> {
    if let Expression::Lambda {
        parameter, body, ..
    } = &module.arena.expressions[expression.0 as usize]
    {
        bind_transform_pattern(
            module,
            *parameter,
            Some(RelationshipTransform::Parameter(arity)),
            &mut bindings,
        );
        return relationship_result(summaries, module, *body, bindings, arity + 1, traversal);
    }
    let result = transform_expression(
        summaries,
        module,
        expression,
        &bindings,
        traversal.environment,
        traversal.context,
        traversal.active,
    )?;
    Some(RelationshipSummary { arity, result })
}

fn transform_expression(
    summaries: &Summaries,
    module: &Module,
    expression: ExpressionId,
    bindings: &HashMap<String, RelationshipTransform>,
    environment: &Environment,
    context: &Context,
    active: &mut HashSet<(String, ExpressionId, usize)>,
) -> Option<RelationshipTransform> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } => bindings.get(name).cloned(),
        Expression::Field { target, name, .. } => Some(RelationshipTransform::Project {
            target: Box::new(transform_expression(
                summaries,
                module,
                *target,
                bindings,
                environment,
                context,
                active,
            )?),
            field: name.clone(),
        }),
        Expression::Tuple { elements, .. } => {
            let elements = elements
                .iter()
                .map(|element| {
                    transform_expression(
                        summaries,
                        module,
                        *element,
                        bindings,
                        environment,
                        context,
                        active,
                    )
                })
                .collect::<Vec<_>>();
            elements
                .iter()
                .any(Option::is_some)
                .then_some(RelationshipTransform::Tuple(elements))
        }
        Expression::Shape { members, .. } => {
            let mut fields = BTreeMap::new();
            for member in members {
                let ShapeMember::Field { name, value } = member else {
                    return None;
                };
                fields.insert(
                    name.clone(),
                    transform_expression(
                        summaries,
                        module,
                        *value,
                        bindings,
                        environment,
                        context,
                        active,
                    ),
                );
            }
            fields
                .values()
                .any(Option::is_some)
                .then_some(RelationshipTransform::Record(fields))
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            let mut nested = bindings.clone();
            for declaration in declarations {
                match &module.arena.declarations[declaration.0 as usize] {
                    crate::ast::Declaration::Signature { .. } => {}
                    crate::ast::Declaration::Binding { pattern, value, .. } => {
                        let relation = transform_expression(
                            summaries,
                            module,
                            *value,
                            &nested,
                            environment,
                            context,
                            active,
                        );
                        bind_transform_pattern(module, *pattern, relation, &mut nested);
                    }
                    crate::ast::Declaration::Shadow { name, value, .. } => {
                        let relation = transform_expression(
                            summaries,
                            module,
                            *value,
                            &nested,
                            environment,
                            context,
                            active,
                        );
                        if let Some(relation) = relation {
                            nested.insert(name.clone(), relation);
                        } else {
                            nested.remove(name);
                        }
                    }
                    crate::ast::Declaration::Open { .. } => return None,
                }
            }
            transform_expression(
                summaries,
                module,
                *result,
                &nested,
                environment,
                context,
                active,
            )
        }
        Expression::If {
            branches, fallback, ..
        } => {
            let mut results = branches
                .iter()
                .map(|branch| {
                    transform_expression(
                        summaries,
                        module,
                        branch.consequence,
                        bindings,
                        environment,
                        context,
                        active,
                    )
                })
                .collect::<Vec<_>>();
            results.push(fallback.and_then(|fallback| {
                transform_expression(
                    summaries,
                    module,
                    fallback,
                    bindings,
                    environment,
                    context,
                    active,
                )
            }));
            common_transform(results)
        }
        Expression::Case { target, arms, .. } => {
            let target = transform_expression(
                summaries,
                module,
                *target,
                bindings,
                environment,
                context,
                active,
            );
            let results = arms
                .iter()
                .map(|arm| {
                    let mut nested = bindings.clone();
                    bind_transform_pattern(module, arm.pattern, target.clone(), &mut nested);
                    transform_expression(
                        summaries,
                        module,
                        arm.body,
                        &nested,
                        environment,
                        context,
                        active,
                    )
                })
                .collect::<Vec<_>>();
            common_transform(results)
        }
        Expression::Apply { .. } => {
            let (callee, arguments) = application_spine(expression, module);
            if let Expression::Tag { name, .. } = &module.arena.expressions[callee.0 as usize]
                && arguments.len() == 1
            {
                let payload = transform_expression(
                    summaries,
                    module,
                    arguments[0],
                    bindings,
                    environment,
                    context,
                    active,
                )?;
                return Some(RelationshipTransform::Choice(BTreeMap::from([(
                    name.clone(),
                    Some(payload),
                )])));
            }
            if let Expression::Intrinsic { name, .. } = &module.arena.expressions[callee.0 as usize]
                && matches!(
                    name.as_str(),
                    "@linear.borrow" | "@linear.own" | "@linear.maybe"
                )
                && arguments.len() == 1
            {
                return transform_expression(
                    summaries,
                    module,
                    arguments[0],
                    bindings,
                    environment,
                    context,
                    active,
                );
            }
            let callee = value_at(module, callee, environment)?;
            let summary = summaries.derive_relationship_with(&callee, context, active)?;
            if summary.arity != arguments.len() {
                return None;
            }
            let arguments = arguments
                .iter()
                .map(|argument| {
                    transform_expression(
                        summaries,
                        module,
                        *argument,
                        bindings,
                        environment,
                        context,
                        active,
                    )
                })
                .collect::<Vec<_>>();
            substitute_transform(summary.result, &arguments)
        }
        _ => None,
    }
}

fn common_transform(
    transforms: Vec<Option<RelationshipTransform>>,
) -> Option<RelationshipTransform> {
    let first = transforms.first()?.clone()?;
    transforms
        .iter()
        .all(|transform| transform.as_ref() == Some(&first))
        .then_some(first)
}

fn bind_transform_pattern(
    module: &Module,
    pattern: PatternId,
    relation: Option<RelationshipTransform>,
    bindings: &mut HashMap<String, RelationshipTransform>,
) {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => {
            if let Some(relation) = relation {
                bindings.insert(name.clone(), relation);
            } else {
                bindings.remove(name);
            }
        }
        Pattern::Tuple { elements, .. } => {
            for (index, pattern) in elements.iter().enumerate() {
                bind_transform_pattern(
                    module,
                    *pattern,
                    relation
                        .clone()
                        .map(|target| RelationshipTransform::Project {
                            target: Box::new(target),
                            field: index.to_string(),
                        }),
                    bindings,
                );
            }
        }
        Pattern::Shape { fields, .. } => {
            for field in fields {
                bind_transform_pattern(
                    module,
                    field.pattern,
                    relation
                        .clone()
                        .map(|target| RelationshipTransform::Project {
                            target: Box::new(target),
                            field: field.name.clone(),
                        }),
                    bindings,
                );
            }
        }
        Pattern::Constructor {
            name,
            payload: Some(payload),
            ..
        } => bind_transform_pattern(
            module,
            *payload,
            relation.map(|target| RelationshipTransform::Payload {
                target: Box::new(target),
                constructor: name.clone(),
            }),
            bindings,
        ),
        _ => {}
    }
}

fn substitute_transform(
    transform: RelationshipTransform,
    arguments: &[Option<RelationshipTransform>],
) -> Option<RelationshipTransform> {
    match transform {
        RelationshipTransform::Parameter(parameter) => arguments.get(parameter).cloned().flatten(),
        RelationshipTransform::Project { target, field } => Some(RelationshipTransform::Project {
            target: Box::new(substitute_transform(*target, arguments)?),
            field,
        }),
        RelationshipTransform::Payload {
            target,
            constructor,
        } => Some(RelationshipTransform::Payload {
            target: Box::new(substitute_transform(*target, arguments)?),
            constructor,
        }),
        RelationshipTransform::Tuple(elements) => {
            let elements = elements
                .into_iter()
                .map(|element| element.and_then(|value| substitute_transform(value, arguments)))
                .collect::<Vec<_>>();
            elements
                .iter()
                .any(Option::is_some)
                .then_some(RelationshipTransform::Tuple(elements))
        }
        RelationshipTransform::Record(fields) => {
            let fields = fields
                .into_iter()
                .map(|(name, value)| {
                    (
                        name,
                        value.and_then(|value| substitute_transform(value, arguments)),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            fields
                .values()
                .any(Option::is_some)
                .then_some(RelationshipTransform::Record(fields))
        }
        RelationshipTransform::Choice(cases) => {
            let cases = cases
                .into_iter()
                .map(|(name, value)| {
                    (
                        name,
                        value.and_then(|value| substitute_transform(value, arguments)),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            cases
                .values()
                .any(Option::is_some)
                .then_some(RelationshipTransform::Choice(cases))
        }
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
