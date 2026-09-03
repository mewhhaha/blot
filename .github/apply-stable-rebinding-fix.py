from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one replacement in {path}, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "compiler/src/typecheck.rs",
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred_type = stable_rebinding_type(inferred.type_.clone());
                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                self.constrain(previous.clone(), inferred_type, span)?;
""",
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred_type = stable_rebinding_type(inferred.type_.clone());
                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                let inferred_type = stable_variant_rebinding_type(inferred_type, &previous);
                self.constrain(previous.clone(), inferred_type, span)?;
""",
)

replace_once(
    "compiler/src/typecheck.rs",
    """fn stable_rebinding_type(type_: Type) -> Type {
    match type_ {
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(low)),
            high: Some(Scalar::Int(high)),
        } if low == high => int_type(),
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(low)),
            high: Some(Scalar::Text(high)),
        } if low == high => text_type(),
        type_ => type_,
    }
}
""",
    """fn stable_rebinding_type(type_: Type) -> Type {
    match type_ {
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(low)),
            high: Some(Scalar::Int(high)),
        } if low == high => int_type(),
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(low)),
            high: Some(Scalar::Text(high)),
        } if low == high => text_type(),
        type_ => type_,
    }
}

fn stable_variant_rebinding_type(replacement: Type, previous: &Type) -> Type {
    let (
        Type::Variant {
            cases: replacement_cases,
            open: false,
        },
        Type::Variant {
            cases: previous_cases,
            open: false,
        },
    ) = (&replacement, previous)
    else {
        return replacement;
    };
    let distinct_previous = previous_cases
        .iter()
        .map(|(name, _)| name)
        .collect::<BTreeSet<_>>();
    if distinct_previous.len() < 2
        || replacement_cases
            .iter()
            .any(|(name, _)| previous_cases.get(name).is_none())
    {
        return replacement;
    }
    previous.clone()
}

fn join_loop_parameter_types(inferred: Type, initial: Type) -> Type {
    if same_type(&inferred, &initial) {
        return inferred;
    }
    match (inferred, initial) {
        (Type::Record(inferred), Type::Record(initial)) => {
            let mut initial = initial.into_iter().collect::<Vec<_>>();
            let mut fields = Vec::with_capacity(inferred.len().max(initial.len()));
            for (name, inferred) in inferred {
                if let Some(index) = initial
                    .iter()
                    .position(|(candidate, _)| candidate == &name)
                {
                    let (_, initial) = initial.remove(index);
                    fields.push((name, join_loop_parameter_types(inferred, initial)));
                } else {
                    fields.push((name, inferred));
                }
            }
            fields.extend(initial);
            Type::Record(fields.into())
        }
        (Type::Array(inferred), Type::Array(initial)) => Type::Array(Rc::new(
            join_loop_parameter_types(Rc::unwrap_or_clone(inferred), Rc::unwrap_or_clone(initial)),
        )),
        (Type::Region(inferred), Type::Region(initial)) => Type::Region(Rc::new(
            join_loop_parameter_types(Rc::unwrap_or_clone(inferred), Rc::unwrap_or_clone(initial)),
        )),
        (Type::Scratch(inferred), Type::Scratch(initial)) => Type::Scratch(Rc::new(
            join_loop_parameter_types(Rc::unwrap_or_clone(inferred), Rc::unwrap_or_clone(initial)),
        )),
        (inferred, initial) => join_types(vec![inferred, initial]),
    }
}
""",
)

replace_once(
    "compiler/src/typecheck.rs",
    """                let statically_known = statically_known_callee(module, function, environment);
                let contextual_argument = if self.specialization_depth.get() == 0
                    && statically_known
                {
                    Some(self.infer(path, module, argument, environment, values, dependencies)?)
                } else {
                    None
                };
                let evaluated_function = if statically_known {
                    self.evaluate(path, function, values, Phase::Comptime).ok()
                } else {
                    None
                };
""",
    """                let synthetic_loop_callee = self.specialization_depth.get() == 0
                    && matches!(
                        &module.arena.expressions[function.0 as usize],
                        Expression::Var { name, .. } if name == \"go$\"
                    );
                let statically_known = synthetic_loop_callee
                    || statically_known_callee(module, function, environment);
                let contextual_argument = if self.specialization_depth.get() == 0
                    && statically_known
                {
                    Some(self.infer(path, module, argument, environment, values, dependencies)?)
                } else {
                    None
                };
                let evaluated_function = if synthetic_loop_callee {
                    self.evaluate(path, function, values, Phase::Runtime).ok()
                } else if statically_known {
                    self.evaluate(path, function, values, Phase::Comptime).ok()
                } else {
                    None
                };
""",
)

replace_once(
    "compiler/src/typecheck.rs",
    """                let synthetic_expression =
                    module.arena.synthetic_expressions.contains(&expression_id);
                if let Some(Value::Closure {
""",
    """                let synthetic_expression =
                    module.arena.synthetic_expressions.contains(&expression_id);
                if synthetic_loop_callee
                    && let Some(Value::Closure {
                        module: closure_module,
                        parameter,
                        body,
                        environment: closure_values,
                        self_name: Some(self_name),
                        deferred,
                        ..
                    }) = evaluated_function.as_ref()
                    && let Some(argument) = contextual_argument.as_ref()
                {
                    let inferred_function = self.infer(
                        path,
                        module,
                        function,
                        environment,
                        values,
                        dependencies,
                    )?;
                    let initial_parameter =
                        stable_loop_signature(self.settle(argument.type_.clone(), true));
                    let contextual_parameter =
                        match self.settle(inferred_function.type_, true) {
                            Type::Function { parameter, .. } => join_loop_parameter_types(
                                stable_loop_signature(Rc::unwrap_or_clone(parameter)),
                                initial_parameter,
                            ),
                            _ => initial_parameter,
                        };
                    self.constrain(
                        argument.type_.clone(),
                        contextual_parameter.clone(),
                        span,
                    )?;
                    let function = self.infer_evaluated_closure(
                        path,
                        module,
                        EvaluatedClosure {
                            module_path: closure_module,
                            parameter: *parameter,
                            body: *body,
                            captures: closure_values,
                            self_name: Some(self_name.as_str()),
                            deferred: *deferred,
                        },
                        environment,
                        dependencies,
                        Some(contextual_parameter.clone()),
                    )?;
                    self.closure_types.borrow_mut().insert(
                        closure_module.to_string(),
                        *body,
                        function.clone(),
                    );
                    let result = self.fresh();
                    let performed = self.fresh();
                    let deferred = self.deferred_call(&function);
                    self.constrain(
                        function,
                        Type::Function {
                            deferred,
                            parameter: Rc::new(contextual_parameter),
                            effects: Rc::new(performed.clone()),
                            result: Rc::new(result.clone()),
                        },
                        span,
                    )?;
                    return Ok(Inferred {
                        type_: result,
                        effects: self.join_effects(argument.effects.clone(), performed)?,
                    });
                }
                if let Some(Value::Closure {
""",
)

replace_once(
    "LANGUAGE.md",
    """The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. The previous polymorphic scheme is
retained. Use another `let` or `const` to shadow a name with a different type.
""",
    """The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. A replacement whose constructors
are a subset of an existing closed multi-constructor variant is first checked
against that variant, then widened back to the existing stable type. Thus
rebinding a `#True | #False` value with `#True` preserves the Boolean type. The
previous polymorphic scheme is retained. Use another `let` or `const` to shadow a
name with a different type.
""",
)

replace_once(
    "docs/inference.md",
    """`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name, but the old and new types must flow into one another. Singleton
integer and text literals widen to their domains at that boundary, so
`value := value + 1` preserves `Int`; changing an integer binding to text
requires another `let value = ...`. The existing binding's scheme is retained,
so rebinding a polymorphic function does not accidentally make it monomorphic.
""",
    """`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name, but the old and new stable types must agree. A constructor subset
of an existing closed variant is checked against that variant and then widened
to it, so assigning `#True` to a `Bool` binding preserves `#True | #False`.
Singleton integer and text literals likewise widen to their domains at that
boundary, so `value := value + 1` preserves `Int`; changing an integer binding
to text requires another `let value = ...`. The existing binding's scheme is
retained, so rebinding a polymorphic function does not accidentally make it
monomorphic.
""",
)

replace_once(
    "compiler/src/session.rs",
    """    fn source(value: &str) -> Vec<u16> {
""",
    r'''    #[test]
    fn stable_rebinding_preserves_a_declared_variant_inside_a_loop() {
        run_with_compiler_test_stack(|| {
            let prelude_snapshot = snapshot_from_source(
                "prelude.blot",
                include_str!("../../src/prelude/prelude.blot"),
            );
            let mut session = CompilerSession::default();
            session
                .install_trusted_module_snapshot("prelude.blot", &prelude_snapshot)
                .expect("prelude snapshot should install");
            session
                .add_source(
                    "main.blot".to_owned(),
                    source(concat!(
                        "open import \"blot:prelude\"\n",
                        "\n",
                        "let flag :: Bool\n",
                        "let flag = #False\n",
                        "\n",
                        "for _ in Iter.items [()]:\n",
                        "  flag := #True\n",
                        "\n",
                        "return flag\n",
                    )),
                )
                .expect("stable variant rebinding source should load");
            session
                .configure_module(
                    "main.blot",
                    BTreeMap::from([("blot:prelude".to_owned(), "prelude.blot".to_owned())]),
                    BTreeMap::new(),
                )
                .expect("stable variant rebinding source should configure");

            let checked = session.check_module("main.blot");
            let prepared = session.prepare_runtime_hir("main.blot");

            assert_eq!(checked["ok"], true, "{checked}");
            assert_eq!(checked["type"], "#True | #False", "{checked}");
            assert_eq!(prepared["ok"], true, "{prepared}");
        });
    }

    fn source(value: &str) -> Vec<u16> {
''',
)
