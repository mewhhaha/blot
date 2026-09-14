use super::*;
use crate::value::lookup_unobserved;

const LIBRARY_OPERATIONS: &[(&str, &str)] = &[
    ("Some", "Some"),
    ("None", "None"),
    ("not", "not"),
    ("Logic.not", "not"),
    ("Option.map", "option_map"),
    ("Option.and_then", "option_and_then"),
    ("Option.unwrap_or_else", "option_unwrap_or_else"),
    ("Result.map", "result_map"),
    ("Result.map_error", "result_map_error"),
    ("Result.and_then", "result_and_then"),
    ("Result.unwrap_or_else", "result_unwrap_or_else"),
    ("Array.find", "array_find"),
    ("Array.filter", "filter"),
    ("Array.partition", "partition"),
    ("Iter.items", "array_items"),
    ("Iter.fold_with", "iter_fold_with"),
    ("fold", "fold"),
    ("filter", "filter"),
    ("partition", "partition"),
];

const PRIMITIVE_ALIASES: &[(&str, &str)] = &[
    ("@int.add", "Int.add"),
    ("@int.sub", "Int.sub"),
    ("@int.mul", "Int.mul"),
    ("@int.div", "Int.div"),
    ("@int.rem", "Int.rem"),
    ("@int.cmp", "Int.cmp"),
    ("@text.len", "Text.length"),
    ("@text.concat", "Text.append"),
    ("@float.add", "Float.add"),
    ("@float.sub", "Float.sub"),
    ("@float.mul", "Float.mul"),
    ("@float.div", "Float.div"),
];

impl Checker {
    pub(super) fn source_operations(
        &self,
        module: &Module,
        expression: ExpressionId,
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
        path: &str,
    ) -> Option<ReadabilityFact> {
        if self.context.modules.borrow().values().any(|loaded| {
            loaded
                .imports
                .get("blot:prelude")
                .is_some_and(|prelude| prelude == path)
        }) {
            return None;
        }
        let mut operations = Vec::new();
        let (head, _) = application_spine_ids(module, expression);
        let resolved = inspected_expression(module, head, environment, values);
        let mut callee = None;
        for (spelling, declaration) in LIBRARY_OPERATIONS {
            let Some(value) = scoped_value(spelling, environment, values) else {
                continue;
            };
            if !library_declaration(&self.context, &value, declaration) {
                continue;
            }
            operations.push((*spelling).to_owned());
            if resolved
                .as_ref()
                .is_some_and(|resolved| same_callable(resolved, &value))
            {
                callee = Some((*spelling).to_owned());
            }
        }
        let primitive_alias = if let Expression::Intrinsic { name, .. } =
            &module.arena.expressions[expression.0 as usize]
        {
            PRIMITIVE_ALIASES.iter().find_map(|(primitive, spelling)| {
                if name != primitive { return None; }
                let value = scoped_value(spelling, environment, values)?;
                matches!(value, Value::Primitive { name: alias, applied, .. } if alias == *primitive && applied.is_empty())
                    .then(|| (*spelling).to_owned())
            })
        } else {
            None
        };
        let forwarding = self.strict_forwarder(module, expression, environment);
        let total_predicate = self.total_comparison_predicate(module, expression, values, path);
        if operations.is_empty() && primitive_alias.is_none() && !forwarding && !total_predicate {
            return None;
        }
        Some(ReadabilityFact::SourceOperations {
            expression,
            operations,
            callee,
            primitive_alias,
            forwarding,
            total_predicate,
        })
    }

    fn strict_forwarder(
        &self,
        module: &Module,
        expression: ExpressionId,
        environment: &TypeEnvironment,
    ) -> bool {
        let Expression::Lambda {
            parameter,
            body,
            deferred: false,
            ..
        } = module.arena.expressions[expression.0 as usize]
        else {
            return false;
        };
        let Pattern::Name {
            name,
            qualifier: Qualifier::None,
            ..
        } = &module.arena.patterns[parameter.0 as usize]
        else {
            return false;
        };
        let Expression::Apply {
            function, argument, ..
        } = module.arena.expressions[body.0 as usize]
        else {
            return false;
        };
        let Expression::Var {
            name: forwarded, ..
        } = &module.arena.expressions[argument.0 as usize]
        else {
            return false;
        };
        let Expression::Var {
            name: function_name,
            ..
        } = &module.arena.expressions[function.0 as usize]
        else {
            return false;
        };
        if forwarded != name || function_name == name {
            return false;
        }
        let Some(type_) = environment.lookup(function_name, self) else {
            return false;
        };
        let mut type_ = match type_ {
            Typing::Mono(type_) | Typing::Scheme { body: type_, .. } => type_,
        };
        loop {
            match self.settle(type_, true) {
                Type::Forall { body, .. } | Type::Qualified { body, .. } => {
                    type_ = Rc::unwrap_or_clone(body);
                }
                Type::Function {
                    deferred: false, ..
                } => return true,
                _ => return false,
            }
        }
    }

    fn total_comparison_predicate(
        &self,
        module: &Module,
        expression: ExpressionId,
        values: &ValueEnvironment,
        path: &str,
    ) -> bool {
        let Expression::Lambda {
            parameter,
            body,
            deferred: false,
            ..
        } = module.arena.expressions[expression.0 as usize]
        else {
            return false;
        };
        if !matches!(
            module.arena.patterns[parameter.0 as usize],
            Pattern::Name {
                qualifier: Qualifier::None,
                ..
            }
        ) {
            return false;
        }
        let (callee, arguments) = application_spine_ids(module, body);
        if arguments.len() != 2 {
            return false;
        }
        let Some(function) = comptime_expression_value(module, callee, values) else {
            return false;
        };
        if crate::recognise::comparison(&self.context, &function).is_none() {
            return false;
        }
        arguments.iter().all(
            |argument| match &module.arena.expressions[argument.0 as usize] {
                Expression::Int { .. } => true,
                Expression::Var { .. } => self
                    .analysis_expression_types
                    .borrow()
                    .get(path, argument)
                    .is_some_and(|type_| integer_only(&self.settle(type_.clone(), false))),
                _ => false,
            },
        )
    }
}

fn integer_only(type_: &Type) -> bool {
    match type_ {
        Type::Range {
            domain: Domain::Int,
            ..
        } => true,
        Type::Union(members) => !members.is_empty() && members.iter().all(integer_only),
        _ => false,
    }
}

fn scoped_value(
    spelling: &str,
    environment: &TypeEnvironment,
    values: &ValueEnvironment,
) -> Option<Value> {
    let mut segments = spelling.split('.');
    let root = segments.next()?;
    if environment.binding_phase(root) != Some(Phase::Comptime) {
        return None;
    }
    let mut value = lookup_unobserved(values, root)?;
    for member in segments {
        value = match value {
            Value::Shape(fields) => fields.get(member)?.clone(),
            Value::Extended { members, .. } => members.get(member)?.clone(),
            _ => return None,
        };
    }
    Some(value)
}

fn inspected_expression(
    module: &Module,
    expression: ExpressionId,
    environment: &TypeEnvironment,
    values: &ValueEnvironment,
) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Intrinsic { name, .. } => crate::primitives::constant(name),
        _ => scoped_value(
            &expression_field_path(module, expression)?.join("."),
            environment,
            values,
        ),
    }
}

fn library_declaration(context: &Context, value: &Value, declaration_name: &str) -> bool {
    if declaration_name == "None" {
        return matches!(value, Value::Tag { name, payload: None } if name == "None");
    }
    let Value::Closure {
        module,
        body,
        self_name: None,
        ..
    } = value
    else {
        return false;
    };
    let modules = context.modules.borrow();
    // The source graph identifies the ordinary prelude module. A spelling or
    // matching type in the caller is not evidence of library behavior.
    if !modules
        .values()
        .any(|loaded| loaded.imports.get("blot:prelude") == Some(module.as_ref()))
    {
        return false;
    }
    let Some(loaded) = modules.get(module.as_str()) else {
        return false;
    };
    loaded.module.declarations.iter().any(|id| {
        let Declaration::Binding { pattern, value, .. } = &loaded.module.arena.declarations[id.0 as usize] else { return false };
        let Pattern::Name { name, .. } = &loaded.module.arena.patterns[pattern.0 as usize] else { return false };
        name == declaration_name && matches!(&loaded.module.arena.expressions[value.0 as usize], Expression::Lambda { body: declared, .. } if declared == body)
    })
}

fn same_callable(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (
            Value::Tag {
                name: left_name,
                payload: None,
            },
            Value::Tag {
                name: right_name,
                payload: None,
            },
        ) => left_name == right_name,
        (
            Value::Closure {
                module: left_module,
                body: left_body,
                environment: left_environment,
                ..
            },
            Value::Closure {
                module: right_module,
                body: right_body,
                environment: right_environment,
                ..
            },
        ) => {
            left_module == right_module
                && left_body == right_body
                && Rc::ptr_eq(left_environment, right_environment)
        }
        (
            Value::Primitive {
                name: left_name,
                applied: left_applied,
                ..
            },
            Value::Primitive {
                name: right_name,
                applied: right_applied,
                ..
            },
        ) => left_name == right_name && left_applied.is_empty() && right_applied.is_empty(),
        _ => false,
    }
}
