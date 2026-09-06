//! Derive residual instance facts using the ordinary source checker and caller evidence.
use super::*;

impl Checker {
    pub(crate) fn residual_instance_signature(
        context: Rc<Context>,
        closure: EvaluatedClosure<'_>,
        argument: &Value,
        checked_argument: Option<&Value>,
        runtime_types: &[crate::hir::RuntimeType],
    ) -> Result<Option<Rc<ResidualInstanceFacts>>, Diagnostic> {
        let checker = Checker::with_caches(
            context.clone(),
            Rc::new(RefCell::new(HashMap::new())),
            Rc::new(RefCell::new(HashMap::new())),
        );
        checker.phase.set(Phase::Runtime);
        let loaded = context
            .modules
            .borrow()
            .get(closure.module_path)
            .cloned()
            .expect("a residual instance retains its checked source module");
        // A specialized source check must not read an outer binding with the
        // same spelling as an unknown parameter (including generated loop names).
        // Close the value environment over lexical free names, just as the type
        // environment is closed below. Captured closures retain their own scopes.
        let captures = child_env(None);
        for name in closure_free_names(
            &context,
            closure.module_path,
            closure.parameter,
            closure.body,
            closure.self_name,
        )? {
            if let Some(value) = lookup(closure.captures, &name) {
                captures.names.borrow_mut().insert(name.clone(), value);
            }
            if let Some(signature) = crate::value::lookup_signature(closure.captures, &name) {
                captures.signatures.borrow_mut().insert(
                    name,
                    crate::eval::substitute_signature(&signature, closure.captures),
                );
            }
        }
        let mut scope = Some(closure.captures.clone());
        while let Some(current) = scope {
            for (variable, type_) in current.type_substitutions.borrow().iter() {
                captures
                    .type_substitutions
                    .borrow_mut()
                    .entry(*variable)
                    .or_insert_with(|| type_.clone());
            }
            scope = current.parent.borrow().clone();
        }
        let closure = EvaluatedClosure {
            captures: &captures,
            ..closure
        };
        let Some(evidence) = checked_argument
            .filter(|value| !crate::value::contains_type_variables(value))
            .and_then(|type_| checker.bridge(type_))
            .or_else(|| {
                (!crate::hir::contains_runtime(argument))
                    .then(|| checker.bridge(argument))
                    .flatten()
            })
            .or_else(|| {
                checker.residual_argument_carrier(argument, runtime_types, &mut HashMap::new())
            })
        else {
            return Ok(None);
        };
        let parameter = checker.fresh();
        checker.constrain(evidence, parameter.clone(), loaded.module.span)?;
        let path = closure.module_path.to_owned();
        let signature = checker.infer_evaluated_closure(
            &path,
            &loaded.module,
            closure,
            &TypeEnvironment::default(),
            &BTreeMap::new(),
            Some(parameter),
        )?;
        checker.resolve_numeric_literals()?;
        checker.constrain(Type::Unit, Type::Unit, loaded.module.span)?;
        let signature = checker.residual_signature(signature);
        let Some(signature) = checker.reify_runtime_type(&signature) else {
            return Ok(None);
        };
        let expression_types = checker
            .expression_types
            .borrow()
            .module(&path)
            .into_iter()
            .flatten()
            .filter_map(|(expression, type_)| {
                let type_ = checker.residual_signature(type_.clone());
                checker
                    .reify_runtime_type(&type_)
                    .map(|type_| (*expression, type_))
            })
            .collect();
        let closure_signatures = checker
            .closure_types_for_path(&path)
            .into_iter()
            .filter_map(|(body, type_)| {
                let signature = checker.residual_signature(type_);
                let signature = if loaded.module.arena.synthetic_closure_bodies.contains(&body) {
                    stable_loop_signature(signature)
                } else {
                    signature
                };
                checker
                    .reify_runtime_type(&signature)
                    .map(|signature| (body, signature))
            })
            .collect();
        Ok(Some(Rc::new(ResidualInstanceFacts {
            module: path,
            signature,
            expression_types,
            closure_signatures,
        })))
    }

    pub(super) fn residual_capture_type(&self, value: &Value) -> Type {
        match value {
            Value::Shape(fields) => Type::Record(
                fields
                    .iter()
                    .map(|(name, value)| (name.clone(), self.residual_capture_type(value)))
                    .collect(),
            ),
            Value::Array(values) => Type::Array(Rc::new(join_types(
                values
                    .iter()
                    .map(|value| self.residual_capture_type(value))
                    .collect(),
            ))),
            Value::Tag { name, payload } => Type::Variant {
                cases: vec![(
                    name.clone(),
                    payload
                        .as_deref()
                        .map(|value| self.residual_capture_type(value))
                        .unwrap_or(Type::Unit),
                )]
                .into(),
                open: false,
            },
            Value::Closure {
                environment,
                signature,
                ..
            } => signature
                .as_deref()
                .map(|signature| crate::eval::substitute_signature(signature, environment))
                .and_then(|signature| self.bridge(&signature))
                .or_else(|| self.static_member_type(value, None))
                .filter(|signature| closed_checked_type(signature, &mut HashSet::new()))
                .unwrap_or_else(|| self.fresh()),
            _ => self
                .static_member_type(value, None)
                .unwrap_or_else(|| self.fresh()),
        }
    }

    fn residual_argument_carrier(
        &self,
        value: &Value,
        types: &[crate::hir::RuntimeType],
        memo: &mut HashMap<usize, Type>,
    ) -> Option<Type> {
        match value {
            Value::Runtime(value) => self.residual_carrier(value.type_id, types, memo),
            Value::Shape(fields) => Some(Type::Record(
                fields
                    .iter()
                    .map(|(name, value)| {
                        Some((
                            name.clone(),
                            self.residual_argument_carrier(value, types, memo)?,
                        ))
                    })
                    .collect::<Option<Vec<_>>>()?
                    .into(),
            )),
            Value::Array(values) => Some(Type::Array(Rc::new(join_types(
                values
                    .iter()
                    .map(|value| self.residual_argument_carrier(value, types, memo))
                    .collect::<Option<Vec<_>>>()?,
            )))),
            Value::Tag { name, payload } => Some(Type::Variant {
                cases: vec![(
                    name.clone(),
                    match payload {
                        Some(payload) => self.residual_argument_carrier(payload, types, memo)?,
                        None => Type::Unit,
                    },
                )]
                .into(),
                open: false,
            }),
            _ => self.bridge(value),
        }
    }

    fn residual_carrier(
        &self,
        id: usize,
        types: &[crate::hir::RuntimeType],
        memo: &mut HashMap<usize, Type>,
    ) -> Option<Type> {
        use crate::hir::RuntimeType;
        if let Some(type_) = memo.get(&id) {
            return Some(type_.clone());
        }
        let source = types.get(id)?;
        let variable = self.fresh();
        memo.insert(id, variable.clone());
        let body =
            match source {
                RuntimeType::Unit => Type::Unit,
                RuntimeType::Integer32 | RuntimeType::SignedInteger64 => int_type(),
                RuntimeType::Float32 => float32_type(),
                RuntimeType::Float64 => float_type(),
                RuntimeType::Boolean => bool_type(),
                RuntimeType::Text => text_type(),
                RuntimeType::Store { element_type } => Type::Array(Rc::new(
                    self.residual_carrier(*element_type, types, memo)?,
                )),
                RuntimeType::Scratch { element_type } => Type::Scratch(Rc::new(
                    self.residual_carrier(*element_type, types, memo)?,
                )),
                RuntimeType::Indirect { target_type } => {
                    self.residual_carrier(*target_type, types, memo)?
                }
                RuntimeType::Product { fields, .. } => Type::Record(
                    fields
                        .iter()
                        .map(|field| {
                            Some((
                                field.name.clone(),
                                self.residual_carrier(field.type_id, types, memo)?,
                            ))
                        })
                        .collect::<Option<Vec<_>>>()?
                        .into(),
                ),
                RuntimeType::Sum { cases, .. } => Type::Variant {
                    cases: cases
                        .iter()
                        .map(|case| {
                            Some((
                                case.name.clone(),
                                self.residual_carrier(case.payload_type, types, memo)?,
                            ))
                        })
                        .collect::<Option<Vec<_>>>()?
                        .into(),
                    open: false,
                },
                // A physical seal or SIMD lane layout is not enough source evidence.
                RuntimeType::Sealed { .. }
                | RuntimeType::Vector { .. }
                | RuntimeType::Mask { .. } => return None,
            };
        let Type::Variable(variable_id) = variable else {
            unreachable!()
        };
        let bound = self.constraint_type(&body);
        let mut variables = self.variables.borrow_mut();
        variables[variable_id as usize].lower.push(bound);
        variables[variable_id as usize].upper.push(bound);
        Some(Type::Variable(variable_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_carrier_evidence_does_not_invent_refinements() {
        let checker = Checker::new(Rc::new(Context::default()));
        let carrier = checker
            .residual_carrier(
                0,
                &[crate::hir::RuntimeType::SignedInteger64],
                &mut HashMap::new(),
            )
            .unwrap();
        let positive = Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(BigInt::from(1))),
            high: Some(Scalar::Int(BigInt::from(i64::MAX))),
        };
        assert!(
            checker
                .constrain(carrier, positive, Span { start: 1, end: 2 })
                .is_err(),
            "a physical integer carrier cannot prove positivity"
        );
    }
}
