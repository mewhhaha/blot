use super::*;

fn signature(checker: &Checker, discard: bool) -> Type {
    checker.level.set(1);
    let receiver = checker.fresh();
    let argument = checker.fresh();
    let result = checker.fresh();
    checker.register_member_requirement(MemberRequirement {
        name: "add".to_owned(),
        subject: receiver.clone(),
        member: curried(vec![receiver.clone(), argument.clone()], result.clone()),
    });
    checker.level.set(0);
    checker.qualify_type(curried(
        vec![receiver, argument],
        if discard { Type::Unit } else { result },
    ))
}

fn application(
    checker: &Checker,
    function: Type,
    left: Type,
    right: Type,
) -> Result<Type, Diagnostic> {
    let result = checker.fresh();
    checker.constrain(
        function,
        curried(vec![left, right], result.clone()),
        Span { start: 1, end: 4 },
    )?;
    Ok(checker.settle(result, true))
}

#[test]
fn qualified_scheme_instantiates_independently_without_source_specialization() {
    let checker = Checker::new(Rc::new(Context::default()));
    let body = signature(&checker, false);
    let principal = checker.residual_signature(body.clone());
    assert_eq!(
        checker.show_settled(&principal),
        "forall 'q0 'q1 'q2. ('q0.add :: 'q0 -> 'q1 -> 'q2) => 'q0 -> 'q1 -> 'q2"
    );
    assert!(closed_checked_type(&principal, &mut HashSet::new()));
    assert!(
        matches!(principal, Type::Forall { ref body, .. } if matches!(body.as_ref(), Type::Qualified { .. }))
    );
    for operand in [int_type(), float_type(), float32_type()] {
        let instance = checker.instantiate(Typing::Scheme {
            level: 0,
            body: body.clone(),
        });
        let result = application(&checker, instance, operand.clone(), operand.clone())
            .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        assert!(
            same_type(&result, &operand),
            "{}",
            checker.show_settled(&result)
        );
    }
}

#[test]
fn qualified_requirement_rejects_missing_or_mixed_members() {
    for (left, right, code) in [
        (Type::Unit, Type::Unit, "BLOT_NO_TYPE_MEMBER"),
        (int_type(), float_type(), "BLOT_TYPE_ERROR"),
    ] {
        let checker = Checker::new(Rc::new(Context::default()));
        let body = signature(&checker, true);
        let instance = checker.instantiate(Typing::Scheme { level: 0, body });
        let error = application(&checker, instance, left, right)
            .expect_err("discarding the result must not discard requirements");
        assert_eq!(error.code, code, "{}", error.message);
    }
}

#[test]
fn qualified_interface_round_trip_keeps_requirements() {
    let producer = Checker::new(Rc::new(Context::default()));
    let signature = signature(&producer, false);
    let principal = producer.residual_signature(signature);
    let mut builder = FlatTypeBuilder::default();
    let root = flatten_interface_type(&principal, &mut HashSet::new(), &mut builder)
        .expect("closed qualified type flattens");
    let encoded = serde_json::to_vec(&builder.nodes).unwrap();
    let arena = FlatTypeArena {
        nodes: serde_json::from_slice(&encoded).unwrap(),
    };
    let consumer = Checker::new(Rc::new(Context::default()));
    let hydrated = consumer.inflate_interface_type(&arena, root, &mut HashMap::new());
    assert!(same_type(&principal, &hydrated));
    for operand in [int_type(), float_type(), float32_type()] {
        let Type::Forall { variables, body } = hydrated.clone() else {
            panic!("quantifiers were lost")
        };
        let instance = consumer.instantiate_forall(variables, Rc::unwrap_or_clone(body));
        let result = application(&consumer, instance, operand.clone(), operand.clone())
            .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        assert!(
            same_type(&result, &operand),
            "{}",
            consumer.show_settled(&result)
        );
    }
}

#[test]
fn failed_qualified_speculation_restores_pending_requirements() {
    let checker = Checker::new(Rc::new(Context::default()));
    let body = signature(&checker, false);
    let instance = checker.instantiate(Typing::Scheme { level: 0, body });
    let result = checker.fresh();
    let rejected = curried(vec![int_type(), float_type()], result.clone());
    assert!(!checker.can_constrain(instance.clone(), rejected, Span { start: 1, end: 4 }));
    let result = application(&checker, instance, float_type(), float_type())
        .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
    assert!(
        same_type(&result, &float_type()),
        "{}",
        checker.show_settled(&result)
    );
}

#[test]
fn projected_scheme_keeps_intermediate_member_application_constraints() {
    let checker = Checker::new(Rc::new(Context::default()));
    checker.level.set(1);
    let receiver = checker.fresh();
    let argument = checker.fresh();
    let member = checker.fresh();
    let partial = checker.fresh();
    let result = checker.fresh();
    let span = Span { start: 1, end: 4 };
    checker.register_member_requirement(MemberRequirement {
        name: "add".to_owned(),
        subject: receiver.clone(),
        member: member.clone(),
    });
    checker
        .constrain(
            member,
            curried(vec![receiver.clone()], partial.clone()),
            span,
        )
        .unwrap();
    checker
        .constrain(
            partial,
            curried(vec![argument.clone()], result.clone()),
            span,
        )
        .unwrap();
    let body = curried(vec![receiver, argument], result);
    checker.level.set(0);
    let replacements = checker.project_scheme_constraints(&body, 0);
    let body = substitute_inference_variables(checker.qualify_type(body), &replacements);
    for operand in [int_type(), float_type(), float32_type()] {
        let instance = checker.instantiate(Typing::Scheme {
            level: 0,
            body: body.clone(),
        });
        let result = application(&checker, instance, operand.clone(), operand.clone())
            .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        assert!(
            same_type(&result, &operand),
            "{}",
            checker.show_settled(&result)
        );
    }
}

#[test]
fn upper_domain_evidence_resolves_members_without_defaulting_unknowns() {
    let checker = Checker::new(Rc::new(Context::default()));
    let subject = checker.fresh();
    let result = checker.fresh();
    checker.register_member_requirement(MemberRequirement {
        name: "add".to_owned(),
        subject: subject.clone(),
        member: curried(vec![subject.clone(), int_type()], result.clone()),
    });
    assert!(checker.member_lookup_subject(&subject).is_none());
    checker
        .constrain(subject.clone(), int_type(), Span { start: 1, end: 4 })
        .unwrap();
    assert!(same_type(
        &checker.member_lookup_subject(&subject).unwrap(),
        &int_type()
    ));
    assert!(same_type(&checker.settle(result, true), &int_type()));
    assert!(!checker.has_member_requirements(&subject));
}

#[test]
fn refinement_does_not_invent_an_integer_domain() {
    let checker = Checker::new(Rc::new(Context::default()));
    for type_ in [checker.fresh(), float_type(), float32_type()] {
        let mut environment = TypeEnvironment::default();
        Rc::make_mut(&mut environment.names).insert("value".to_owned(), Typing::Mono(type_));
        assert!(refined_original_integer_type(&checker, &environment, "value").is_none());
    }
}

#[test]
fn member_upper_evidence_survives_repeated_bounds_and_alias_cycles() {
    for domain in [int_type(), float_type(), float32_type()] {
        let checker = Checker::new(Rc::new(Context::default()));
        let subject = checker.fresh();
        let alias = checker.fresh();
        let result = checker.fresh();
        let span = Span { start: 1, end: 4 };
        checker
            .constrain(subject.clone(), alias.clone(), span)
            .unwrap();
        checker.constrain(alias, subject.clone(), span).unwrap();
        checker.register_member_requirement(MemberRequirement {
            name: "add".to_owned(),
            subject: subject.clone(),
            member: curried(vec![subject.clone(), domain.clone()], result.clone()),
        });
        assert!(checker.member_lookup_subject(&subject).is_none());
        checker
            .constrain(subject.clone(), domain.clone(), span)
            .unwrap();
        checker
            .constrain(subject.clone(), domain.clone(), span)
            .unwrap();
        assert!(same_type(
            &checker.member_lookup_subject(&subject).unwrap(),
            &domain
        ));
        assert!(same_type(&checker.settle(result, true), &domain));
        assert!(!checker.has_member_requirements(&subject));
    }
}

#[test]
fn member_upper_evidence_does_not_default_cycles_or_project_container_elements() {
    let checker = Checker::new(Rc::new(Context::default()));
    let subject = checker.fresh();
    let alias = checker.fresh();
    let span = Span { start: 1, end: 4 };
    checker
        .constrain(subject.clone(), alias.clone(), span)
        .unwrap();
    checker.constrain(alias, subject.clone(), span).unwrap();
    assert!(checker.member_lookup_subject(&subject).is_none());
    checker
        .constrain(subject.clone(), Type::Array(Rc::new(int_type())), span)
        .unwrap();
    assert!(checker.member_lookup_subject(&subject).is_none());
}
