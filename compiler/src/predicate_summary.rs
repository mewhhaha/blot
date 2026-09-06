//! Bounded, environment-sensitive expansion of known predicate helpers.
//!
//! This projects existing comparison evidence onto caller terms. It does not
//! evaluate a helper by name, synthesize an integer domain, or reuse a summary
//! across environments. Unsupported syntax and exhausted fuel produce no facts.

use std::collections::HashMap;

use super::{
    Analysis, Constraint, Scope, Term, application_spine, constraints_at_least,
    constraints_at_most, constraints_equal, constraints_greater_than, constraints_less_than,
};
use crate::ast::{Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember};
use crate::recognise::{self, Junction, Ordering};
use crate::value::{Environment, Value, lookup};

type Facts = (Vec<Constraint>, Vec<Constraint>);

#[derive(Clone, Default)]
struct Operand {
    term: Option<Term>,
    witness: Option<Term>,
    length: Option<Term>,
    fields: HashMap<String, Operand>,
}

struct Expansion<'a> {
    analysis: &'a Analysis<'a>,
    remaining: usize,
}

pub(super) fn constraints(
    analysis: &Analysis<'_>,
    callee: &Value,
    arguments: &[ExpressionId],
    scope: &Scope,
) -> Option<Facts> {
    let mut expansion = Expansion {
        analysis,
        remaining: 128,
    };
    let operands = arguments
        .iter()
        .map(|argument| expansion.caller_operand(*argument, scope))
        .collect::<Option<Vec<_>>>()?;
    expansion.call(callee, &operands)
}

impl Expansion<'_> {
    fn step(&mut self) -> Option<()> {
        self.remaining = self.remaining.checked_sub(1)?;
        Some(())
    }

    fn caller_operand(&mut self, expression: ExpressionId, scope: &Scope) -> Option<Operand> {
        self.step()?;
        let mut operand = Operand {
            term: self.analysis.term(expression, scope),
            witness: self.analysis.witness(expression, scope),
            length: self.analysis.array_length(expression, scope),
            fields: HashMap::new(),
        };
        match &self.analysis.module.arena.expressions[expression.0 as usize] {
            Expression::Tuple { elements, .. } => {
                for (index, element) in elements.iter().enumerate() {
                    operand
                        .fields
                        .insert(index.to_string(), self.caller_operand(*element, scope)?);
                }
            }
            Expression::Shape { members, .. } => {
                for member in members {
                    let ShapeMember::Field { name, value } = member else {
                        return None;
                    };
                    operand
                        .fields
                        .insert(name.clone(), self.caller_operand(*value, scope)?);
                }
            }
            _ => {}
        }
        Some(operand)
    }

    fn call(&mut self, callee: &Value, arguments: &[Operand]) -> Option<Facts> {
        self.step()?;
        let Value::Closure {
            module,
            parameter,
            body,
            environment,
            self_name: None,
            deferred: false,
            ..
        } = callee
        else {
            return None;
        };
        let loaded = self
            .analysis
            .context
            .modules
            .borrow()
            .get(module.as_ref())
            .cloned()?;
        let mut bindings = HashMap::new();
        let mut parameter = *parameter;
        let mut body = *body;
        for (index, argument) in arguments.iter().enumerate() {
            bind(&loaded.module, parameter, argument, &mut bindings)?;
            if index + 1 < arguments.len() {
                let Expression::Lambda {
                    parameter: next_parameter,
                    body: next_body,
                    deferred: false,
                    ..
                } = &loaded.module.arena.expressions[body.0 as usize]
                else {
                    return None;
                };
                parameter = *next_parameter;
                body = *next_body;
            }
        }
        if arguments.is_empty() {
            return None;
        }
        self.condition(&loaded.module, body, environment, &bindings)
    }

    fn condition(
        &mut self,
        module: &Module,
        expression: ExpressionId,
        environment: &Environment,
        bindings: &HashMap<String, Operand>,
    ) -> Option<Facts> {
        self.step()?;
        if let Expression::Block {
            declarations,
            result,
            ..
        } = &module.arena.expressions[expression.0 as usize]
        {
            if !declarations.is_empty() {
                return None;
            }
            return self.condition(module, *result, environment, bindings);
        }
        if let Expression::If {
            branches,
            fallback: Some(fallback),
            ..
        } = &module.arena.expressions[expression.0 as usize]
        {
            let [branch] = branches.as_slice() else {
                return None;
            };
            if matches!(&module.arena.expressions[fallback.0 as usize], Expression::Tag { name, .. } if name == "False")
            {
                let (mut left, _) =
                    self.condition(module, branch.condition, environment, bindings)?;
                let (right, _) =
                    self.condition(module, branch.consequence, environment, bindings)?;
                left.extend(right);
                return Some((left, Vec::new()));
            }
            if matches!(&module.arena.expressions[branch.consequence.0 as usize], Expression::Tag { name, .. } if name == "True")
            {
                let (_, mut left) =
                    self.condition(module, branch.condition, environment, bindings)?;
                let (_, right) = self.condition(module, *fallback, environment, bindings)?;
                left.extend(right);
                return Some((Vec::new(), left));
            }
            return None;
        }
        let (callee, arguments) = application_spine(expression, module);
        let value = resolved_value(module, callee, environment, bindings)?;
        if let [left, right] = arguments.as_slice() {
            match recognise::junction(self.analysis.context, &value) {
                Some(Junction::And) => {
                    let (mut left, _) = self.condition(module, *left, environment, bindings)?;
                    let (right, _) = self.condition(module, *right, environment, bindings)?;
                    left.extend(right);
                    return Some((left, Vec::new()));
                }
                Some(Junction::Or) => {
                    let (_, mut left) = self.condition(module, *left, environment, bindings)?;
                    let (_, right) = self.condition(module, *right, environment, bindings)?;
                    left.extend(right);
                    return Some((Vec::new(), left));
                }
                None => {}
            }
            if let Some(orderings) = recognise::comparison(self.analysis.context, &value) {
                let left = self.operand(module, *left, environment, bindings)?;
                let right = self.operand(module, *right, environment, bindings)?;
                // Retain the existing affine analysis's evidence restriction.
                if left.witness.is_none() && right.witness.is_none() {
                    return None;
                }
                if matches!(left.witness, Some(Term::Variable { .. }))
                    && matches!(right.witness, Some(Term::Variable { .. }))
                {
                    return None;
                }
                let left = left.term?;
                let right = right.term?;
                return Some(
                    match (
                        orderings.contains(&Ordering::Less),
                        orderings.contains(&Ordering::Equal),
                        orderings.contains(&Ordering::Greater),
                    ) {
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
                        (false, true, false) => (constraints_equal(&left, &right), Vec::new()),
                        (true, false, true) => (Vec::new(), constraints_equal(&left, &right)),
                        _ => (Vec::new(), Vec::new()),
                    },
                );
            }
        }
        // Only recognized negation exchanges positive and negative evidence.
        if let [argument] = arguments.as_slice()
            && recognise::negation(self.analysis.context, &value)
        {
            let (positive, negative) = self.condition(module, *argument, environment, bindings)?;
            return Some((negative, positive));
        }
        let arguments = arguments
            .iter()
            .map(|argument| self.operand(module, *argument, environment, bindings))
            .collect::<Option<Vec<_>>>()?;
        self.call(&value, &arguments)
    }

    fn operand(
        &mut self,
        module: &Module,
        expression: ExpressionId,
        environment: &Environment,
        bindings: &HashMap<String, Operand>,
    ) -> Option<Operand> {
        self.step()?;
        match &module.arena.expressions[expression.0 as usize] {
            Expression::Int { value, .. } => Some(integer(value.clone())),
            Expression::Var { name, .. } => {
                if let Some(value) = bindings.get(name) {
                    return Some(value.clone());
                }
                let Value::Int(value) = lookup(environment, name)? else {
                    return None;
                };
                Some(integer(value))
            }
            Expression::Field { target, name, .. } => self
                .operand(module, *target, environment, bindings)?
                .fields
                .get(name)
                .cloned(),
            Expression::Tuple { elements, .. } => {
                let mut fields = HashMap::new();
                for (index, element) in elements.iter().enumerate() {
                    fields.insert(
                        index.to_string(),
                        self.operand(module, *element, environment, bindings)?,
                    );
                }
                Some(Operand {
                    fields,
                    ..Operand::default()
                })
            }
            Expression::Apply { .. } => {
                let (callee, arguments) = application_spine(expression, module);
                let Expression::Intrinsic { name, .. } =
                    &module.arena.expressions[callee.0 as usize]
                else {
                    return None;
                };
                let [argument] = arguments.as_slice() else {
                    return None;
                };
                let operand = self.operand(module, *argument, environment, bindings)?;
                if name == "@array.len" {
                    let length = operand.length?;
                    return Some(Operand {
                        term: Some(length.clone()),
                        witness: Some(length),
                        ..Operand::default()
                    });
                }
                if name == "@linear.borrow" {
                    return Some(operand);
                }
                None
            }
            _ => None,
        }
    }
}

fn integer(value: num_bigint::BigInt) -> Operand {
    let term = Term::Literal(value);
    Operand {
        term: Some(term.clone()),
        witness: Some(term),
        ..Operand::default()
    }
}

fn bind(
    module: &Module,
    pattern: PatternId,
    operand: &Operand,
    bindings: &mut HashMap<String, Operand>,
) -> Option<()> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => {
            bindings.insert(name.clone(), operand.clone());
        }
        Pattern::Wildcard { .. } | Pattern::Unit { .. } => {}
        Pattern::Tuple { elements, .. } => {
            for (index, pattern) in elements.iter().enumerate() {
                bind(
                    module,
                    *pattern,
                    operand.fields.get(&index.to_string())?,
                    bindings,
                )?;
            }
        }
        Pattern::Shape { fields, .. } => {
            for field in fields {
                bind(
                    module,
                    field.pattern,
                    operand.fields.get(&field.name)?,
                    bindings,
                )?;
            }
        }
        _ => return None,
    }
    Some(())
}

fn resolved_value(
    module: &Module,
    expression: ExpressionId,
    environment: &Environment,
    bindings: &HashMap<String, Operand>,
) -> Option<Value> {
    match &module.arena.expressions[expression.0 as usize] {
        Expression::Var { name, .. } if !bindings.contains_key(name) => lookup(environment, name),
        Expression::Field { target, name, .. } => {
            match resolved_value(module, *target, environment, bindings)? {
                Value::Shape(fields) => fields.get(name).cloned(),
                Value::Extended { members, .. } => members.get(name).cloned(),
                _ => None,
            }
        }
        Expression::Intrinsic { name, .. } => Some(Value::Primitive {
            name: name.clone(),
            arity: crate::primitives::primitive_arity(name)?,
            applied: Vec::new(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use crate::session::CompilerSession;
    use std::collections::BTreeMap;

    fn check_predicate(definition: &str, condition: &str, consequence: &str) -> serde_json::Value {
        let mut session = CompilerSession::default();
        session
            .install_trusted_module_snapshot(
                "snapshot:prelude",
                include_bytes!("../../generated/compiler/prelude.snapshot"),
            )
            .unwrap();
        let source = format!(
            "open import \"blot:prelude\"\n{definition}\nlet run :: Int -> Int\nlet run = fn index => do:\n  let values = [10, 20]\n  if {condition}:\n{consequence}\n  return 0\nreturn run\n"
        );
        session
            .add_source("main.blot".to_owned(), source.encode_utf16().collect())
            .unwrap();
        session
            .configure_module(
                "main.blot",
                BTreeMap::from([("blot:prelude".to_owned(), "snapshot:prelude".to_owned())]),
                BTreeMap::new(),
            )
            .unwrap();
        let checked = session.check_module("main.blot");
        if checked["ok"] == true {
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(prepared["ok"], true, "{prepared}");
        }
        checked
    }

    #[test]
    fn extracted_bounds_predicates_retain_caller_relations() {
        std::thread::Builder::new().stack_size(16 * 1024 * 1024).spawn(|| {
            for (definition, condition) in [
                ("const fits = fn (index, length) => index >= 0 && index < length", "fits (index, @array.len values)"),
                ("const fits = fn index => fn values => index >= 0 && index < @array.len values", "fits index values"),
                ("const outside = fn (index, length) => index < 0 || index >= length", "not (outside (index, @array.len values))"),
                ("const fits = fn (index, length) => index >= 0 && index < length\nconst wrapped = fn pair => fits pair", "wrapped (index, @array.len values)"),
                ("const make = fn lower => fn (index, length) => index >= lower && index < length\nconst fits = make 0", "fits (index, @array.len values)"),
            ] {
                let checked = check_predicate(definition, condition, "    return @array.get values index");
                assert_eq!(checked["ok"], true, "{condition}: {checked}");
            }
        }).unwrap().join().unwrap();
    }

    #[test]
    fn unsafe_helpers_never_manufacture_bounds() {
        std::thread::Builder::new().stack_size(16 * 1024 * 1024).spawn(|| {
            for (definition, condition, consequence) in [
                ("const fits = fn pair => True", "fits (index, @array.len values)", "    return @array.get values index"),
                ("const fits = fn (index, length) => index >= 0 || index < length", "fits (index, @array.len values)", "    return @array.get values index"),
                ("const fits = fn (index, length) => index >= 0 && index <= length", "fits (index, @array.len values)", "    return @array.get values index"),
                ("const fits = fn (index, length) => index >= 0 && index < length", "fits (index, @array.len values)", "    let next = @int.add index 1\n    return @array.get values next"),
                ("const make = fn lower => fn (index, length) => index >= lower && index < length\nconst safe = make 0\nconst fits = make (-1)", "fits (index, @array.len values)", "    return @array.get values index"),
            ] {
                let checked = check_predicate(definition, condition, consequence);
                assert_eq!(checked["ok"], false, "{definition}: {checked}");
                assert_eq!(checked["diagnostic"]["code"], "BLOT_UNPROVEN_INDEX", "{definition}: {checked}");
            }
        }).unwrap().join().unwrap();
    }
}
