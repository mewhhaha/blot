//! Source member application and specialization.
//!
//! Fixities do not participate in typing. The receiver's checked type selects an
//! ordinary member value; that value's signature/body owns the call contract.

use super::*;

impl Checker {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn infer_source_member_application(
        &self,
        path: &str,
        module: &Module,
        expression: ExpressionId,
        callee: ExpressionId,
        arguments: &[ExpressionId],
        environment: &TypeEnvironment,
        values: &ValueEnvironment,
        dependencies: &BTreeMap<String, Type>,
        span: Span,
    ) -> Result<Option<Inferred>, Diagnostic> {
        if let Expression::Field { target, name, .. } = &module.arena.expressions[callee.0 as usize]
            && let Some(subject) = inferred_type_subject(module, *target)
        {
            let mut inferred_arguments = Vec::new();
            let mut effects = Type::Effects(BTreeSet::new());
            for argument in arguments {
                let inferred =
                    self.infer(path, module, *argument, environment, values, dependencies)?;
                effects = self.join_effects(effects, inferred.effects)?;
                inferred_arguments.push(inferred.type_);
            }
            let subject = self.infer(path, module, subject, environment, values, dependencies)?;
            effects = self.join_effects(effects, subject.effects)?;
            // Only a literal may select a numeric representation from another
            // operand. A bound value is never implicitly converted.
            if self.mentions_pending_numeric_literal(&subject.type_) {
                let contextual_domain = inferred_arguments
                    .iter()
                    .find_map(|argument| self.resolve_type_domain(argument));
                if let Some(domain) = contextual_domain {
                    let expected = match domain {
                        Domain::Int => int_type(),
                        Domain::Text => text_type(),
                        Domain::Float => float_type(),
                        Domain::Float32 => float32_type(),
                    };
                    self.constrain(subject.type_.clone(), expected, span)?;
                }
                self.resolve_numeric_literals()?;
            }
            let mut settled = self.settle(subject.type_.clone(), true);
            if contains_bottom(&settled) {
                let upper = self.settle(subject.type_.clone(), false);
                if !matches!(upper, Type::Top | Type::Bottom)
                    && closed_checked_type(&upper, &mut HashSet::new())
                    && operator_dispatch_type_is_concrete(&upper)
                {
                    settled = upper;
                }
            }
            if matches!(
                settled,
                Type::Top | Type::Bottom | Type::Variable(_) | Type::Rigid(_)
            ) || contains_bottom(&settled)
                || !closed_checked_type(&settled, &mut HashSet::new())
                || !operator_dispatch_type_is_concrete(&settled)
            {
                if self.active_closures.borrow().is_empty() {
                    return Err(Diagnostic::new(
                        "BLOT_TYPE_NOT_REIFIABLE",
                        "The receiver type must be known before its member can be applied.",
                        span,
                    ));
                }
                self.defer_current_closure();
                return Ok(Some(Inferred {
                    type_: self.fresh(),
                    effects: self.join_effects(effects, self.fresh())?,
                }));
            }
            let type_value = self.reify_runtime_type(&settled).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_TYPE_NOT_REIFIABLE",
                    format!(
                        "`{}` has no compile-time type value for member lookup.",
                        self.show(&settled)
                    ),
                    span,
                )
            })?;
            let type_value = self.context.decorate_operator_type(type_value);
            let member = static_member(&type_value, name).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_NO_TYPE_MEMBER",
                    format!(
                        "Type `{}` has no attached `{name}` operation.",
                        self.show(&settled)
                    ),
                    span,
                )
            })?;
            if let Value::Primitive {
                name: primitive,
                arity: 3,
                applied,
            } = &member
                && primitive == "@type.resolve_member"
                && let [Value::Text(member_name)] = applied.as_slice()
                && let [left, right] = arguments
            {
                // This is the bootstrap implementation itself, not an alias
                // inferred from the source field's spelling.
                return self
                    .infer_resolve_member(
                        path,
                        module,
                        expression,
                        member_name.clone(),
                        *left,
                        *right,
                        environment,
                        values,
                        dependencies,
                        span,
                    )
                    .map(Some);
            }
            let result = self.infer_member_value_application(
                path,
                module,
                &member,
                &inferred_arguments,
                environment,
                dependencies,
                span,
            )?;
            return Ok(Some(Inferred {
                type_: result.type_,
                effects: self.join_effects(effects, result.effects)?,
            }));
        }

        let selected = comptime_expression_value(module, callee, values);
        let Some(member) = selected else {
            return Ok(None);
        };
        let attached = matches!(
            &module.arena.expressions[callee.0 as usize],
            Expression::Field { target, .. }
                if matches!(comptime_expression_value(module, *target, values), Some(Value::Extended { .. }))
        );
        let needs_specialization =
            self.member_value_needs_specialization(&member, &mut HashSet::new());
        if !attached && !needs_specialization {
            return Ok(None);
        }
        if matches!(
            &member,
            Value::Closure {
                self_name: Some(_),
                ..
            }
        ) {
            return Ok(None);
        }
        let mut types = Vec::new();
        let mut effects = Type::Effects(BTreeSet::new());
        for argument in arguments {
            let inferred =
                self.infer(path, module, *argument, environment, values, dependencies)?;
            effects = self.join_effects(effects, inferred.effects)?;
            types.push(inferred.type_);
        }
        let result = self.infer_member_value_application(
            path,
            module,
            &member,
            &types,
            environment,
            dependencies,
            span,
        )?;
        Ok(Some(Inferred {
            type_: result.type_,
            effects: self.join_effects(effects, result.effects)?,
        }))
    }

    fn member_value_needs_specialization(
        &self,
        value: &Value,
        visited: &mut HashSet<(String, ExpressionId)>,
    ) -> bool {
        let Value::Closure {
            module,
            body,
            environment,
            ..
        } = value
        else {
            return false;
        };
        let key = (module.as_ref().clone(), *body);
        if !visited.insert(key.clone()) {
            return false;
        }
        if self.deferred_predicate_closures.borrow().contains(&key) {
            return true;
        }
        let Some(loaded) = self.context.modules.borrow().get(module.as_str()).cloned() else {
            return false;
        };
        if expression_contains_intrinsic(&loaded.module, *body, "@type.inferred") {
            return true;
        }
        // Follow the actual captured binding, not an operator name. This also
        // retains specialization requirements across module/snapshot boundaries.
        let candidates = RefCell::new(Vec::new());
        expression_contains(&loaded.module, *body, &|expression| {
            match expression {
                Expression::Var { name, .. } => {
                    if let Some(value) = lookup(environment, name) {
                        candidates.borrow_mut().push(value);
                    }
                }
                Expression::Field { target, name, .. } => {
                    if let Some(target) =
                        comptime_expression_value(&loaded.module, *target, environment)
                        && let Some(value) = static_member(&target, name)
                    {
                        candidates.borrow_mut().push(value);
                    }
                }
                _ => {}
            }
            false
        });
        candidates
            .into_inner()
            .iter()
            .any(|value| self.member_value_needs_specialization(value, visited))
    }

    #[allow(clippy::too_many_arguments)]
    fn infer_member_value_application(
        &self,
        path: &str,
        module: &Module,
        value: &Value,
        arguments: &[Type],
        environment: &TypeEnvironment,
        dependencies: &BTreeMap<String, Type>,
        span: Span,
    ) -> Result<Inferred, Diagnostic> {
        let Value::Closure {
            module: closure_module,
            parameter,
            body,
            environment: captures,
            self_name,
            deferred,
            ..
        } = value
        else {
            let mut type_ = self.static_member_type(value).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_TYPE_ERROR",
                    "The selected member has no callable signature.",
                    span,
                )
            })?;
            if let Value::Primitive { applied, .. } = value {
                for argument in applied {
                    let applied_type = self.bridge_runtime_value(argument);
                    type_ = self
                        .apply_member_signature(type_, &[applied_type], span)?
                        .type_;
                }
            }
            return self.apply_member_signature(type_, arguments, span);
        };
        if self_name.is_some() {
            let type_ = self.static_member_type(value).ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_TYPE_ERROR",
                    "A recursive member needs a checked signature.",
                    span,
                )
            })?;
            return self.apply_member_signature(type_, arguments, span);
        }
        if self.specialization_depth.get() >= 64 {
            return Err(Diagnostic::new(
                "BLOT_SPECIALIZATION_LIMIT",
                "Member specialization exceeded the source call-depth limit.",
                span,
            ));
        }
        // An explicitly checked signature remains a contract even when the
        // implementation could accept a broader argument after specialization.
        let declared = self
            .bridge_closed_attached_signature(value)
            .map(|signature| self.apply_member_signature(signature, arguments, span))
            .transpose()?;
        let loaded = self
            .context
            .modules
            .borrow()
            .get(closure_module.as_str())
            .cloned()
            .ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_UNRESOLVED_IMPORT",
                    "The member's source module was not loaded.",
                    span,
                )
            })?;
        let mut scope = TypeEnvironment::child(Rc::new(environment.clone()));
        for name in closure_free_names(&self.context, closure_module, *parameter, *body, None)? {
            if let Some(value) = lookup(captures, &name) {
                let type_ = self.bridge(&value).unwrap_or_else(|| self.fresh());
                Rc::make_mut(&mut scope.names).insert(name.clone(), Typing::Mono(type_));
                Rc::make_mut(&mut scope.phases).insert(name, Phase::Comptime);
            }
        }
        let root_body = *body;
        let mut parameter = *parameter;
        let mut body = *body;
        let mut deferred = *deferred;
        let mut consumed = 0;
        let mut bodies = Vec::new();
        for (index, argument) in arguments.iter().enumerate() {
            // Deferred argument demand is handled by ordinary application. The
            // current operator source members are strict, but user members need
            // the same convention check rather than an eager reinterpretation.
            self.bind_pattern_at_phase(
                &loaded.module,
                parameter,
                argument.clone(),
                &mut scope,
                Phase::Runtime,
            );
            bodies.push((closure_module.as_ref().clone(), body));
            consumed += 1;
            if index + 1 == arguments.len() {
                break;
            }
            let Expression::Lambda {
                parameter: next,
                body: next_body,
                deferred: next_deferred,
                ..
            } = &loaded.module.arena.expressions[body.0 as usize]
            else {
                break;
            };
            parameter = *next;
            body = *next_body;
            deferred = *next_deferred;
        }
        let _ = deferred;
        if let Some(argument) = arguments.first() {
            self.record_specialization(closure_module, root_body, argument, path, span)?;
        }
        let previous_depth = self.specialization_depth.get();
        self.specialization_depth.set(previous_depth + 1);
        let previous_active = self.active_closures.borrow().len();
        self.active_closures.borrow_mut().extend(bodies);
        let result = self.infer(
            closure_module,
            &loaded.module,
            body,
            &scope,
            captures,
            dependencies,
        );
        self.active_closures.borrow_mut().truncate(previous_active);
        self.specialization_depth.set(previous_depth);
        let mut result = result?;
        if consumed < arguments.len() {
            let rest = self.apply_member_signature(result.type_, &arguments[consumed..], span)?;
            result = Inferred {
                type_: rest.type_,
                effects: self.join_effects(result.effects, rest.effects)?,
            };
        }
        if let Some(declared) = declared {
            self.constrain(result.type_.clone(), declared.type_, span)?;
            self.constrain(result.effects.clone(), declared.effects, span)?;
        }
        // Keep the caller's source span as the application evidence. No member
        // spelling or compile-time sample value contributes a result type.
        let _ = module;
        Ok(result)
    }

    fn apply_member_signature(
        &self,
        mut signature: Type,
        arguments: &[Type],
        span: Span,
    ) -> Result<Inferred, Diagnostic> {
        let mut effects = Type::Effects(BTreeSet::new());
        for argument in arguments {
            let result = self.fresh();
            let performed = self.fresh();
            let deferred = self.deferred_call(&signature);
            self.constrain(
                signature,
                Type::Function {
                    deferred,
                    parameter: Rc::new(argument.clone()),
                    effects: Rc::new(performed.clone()),
                    result: Rc::new(result.clone()),
                },
                span,
            )?;
            effects = self.join_effects(effects, performed)?;
            signature = result;
        }
        Ok(Inferred {
            type_: signature,
            effects,
        })
    }
}
