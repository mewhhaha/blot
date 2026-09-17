//! Type-evidence demand must not change source evaluation or residual facts.
use super::*;
use crate::ast::{ArrayElement, AstArena, ResultEffects};

const PATH: &str = "type-demand.blot";
const SPAN: Span = Span { start: 7, end: 11 };

fn context(arena: AstArena, result: ExpressionId) -> Rc<Context> {
    let module = Rc::new(Module {
        parameter: None,
        declarations: Vec::new(),
        result,
        result_effects: ResultEffects::Pure,
        span: SPAN,
        arena,
    });
    module.validate().expect("test AST is valid");
    let context = Rc::new(Context::default());
    context.modules.borrow_mut().insert(
        PATH.to_owned(),
        LoadedModule::new(PATH, module, BTreeMap::new(), BTreeMap::new()),
    );
    context
}

fn one_expression(expression: Expression) -> (Rc<Context>, ExpressionId) {
    let mut arena = AstArena::default();
    let result = arena.expression(expression);
    (context(arena, result), result)
}

fn evaluate(context: Rc<Context>, expression: ExpressionId, runtime: Runtime) -> Computation {
    evaluate_expression(
        context,
        Rc::new(PATH.to_owned()),
        expression,
        child_env(None),
        runtime,
    )
}

fn runtime() -> Runtime {
    Runtime::new(Phase::Comptime, PATH.to_owned())
}

#[test]
fn untraced_text_neither_materializes_types_nor_schedules_evidence_continuations() {
    let (context, expression) = one_expression(Expression::Text {
        value: "typed values, not type copies".to_owned(),
        span: SPAN,
    });
    context.expression_type_resolvers.borrow_mut().insert(
        PATH.to_owned(),
        Rc::new(|_| panic!("an untraced Text has no representation consumer")),
    );
    let runtime = runtime();
    let fuel = runtime.fuel.clone();
    let initial = fuel.get();
    let computation = evaluate(context, expression, runtime);
    assert!(matches!(computation, Computation::Done(Ok(Value::Text(_)))));
    assert_eq!(
        fuel.get(),
        initial - 1,
        "source evaluation still costs fuel"
    );
}

#[test]
fn untraced_aggregate_does_not_materialize_unused_type_evidence() {
    let mut arena = AstArena::default();
    let text = arena.expression(Expression::Text {
        value: "payload".to_owned(),
        span: SPAN,
    });
    let array = arena.expression(Expression::Array {
        elements: vec![
            ArrayElement {
                spread: false,
                value: text
            };
            2
        ],
        span: SPAN,
    });
    let record = arena.expression(Expression::Shape {
        members: vec![ShapeMember::Field {
            name: "items".to_owned(),
            value: array,
        }],
        span: SPAN,
    });
    let context = context(arena, record);
    context.expression_type_resolvers.borrow_mut().insert(
        PATH.to_owned(),
        Rc::new(|_| panic!("untraced aggregate evidence is not consumed")),
    );
    let runtime = runtime();
    let fuel = runtime.fuel.clone();
    let initial = fuel.get();
    let value = run(evaluate(context, record, runtime)).expect("aggregate evaluates");
    assert_eq!(show(&value), "{ .items = [\"payload\", \"payload\"]; }");
    assert_eq!(fuel.get(), initial - 4, "both array elements execute");
}

#[test]
fn checked_numeric_representations_are_still_demanded() {
    for (expression, primitive, expected) in [
        (
            Expression::Int {
                value: 42.into(),
                span: SPAN,
            },
            "@type.float",
            Value::Float(42.0),
        ),
        (
            Expression::Int {
                value: 42.into(),
                span: SPAN,
            },
            "@type.float32",
            Value::Float32(42.0),
        ),
        (
            Expression::Float {
                value: 1.25,
                span: SPAN,
            },
            "@type.float32",
            Value::Float32(1.25),
        ),
    ] {
        let (context, expression) = one_expression(expression);
        let calls = Rc::new(Cell::new(0));
        let observed = calls.clone();
        context.expression_type_resolvers.borrow_mut().insert(
            PATH.to_owned(),
            Rc::new(move |_| {
                observed.set(observed.get() + 1);
                constant(primitive)
            }),
        );
        let value = run(evaluate(context, expression, runtime())).expect("numeric value");
        assert!(
            equal(&value, &expected),
            "wrong numeric representation: {value:?}"
        );
        // Equality permits numeric comparisons; assert the representation too.
        assert_eq!(
            std::mem::discriminant(&value),
            std::mem::discriminant(&expected)
        );
        assert_eq!(calls.get(), 1);
    }
}

#[test]
fn residual_evaluation_still_materializes_checked_evidence() {
    let (context, expression) = one_expression(Expression::Text {
        value: "residual payload".to_owned(),
        span: SPAN,
    });
    let calls = Rc::new(Cell::new(0));
    let observed = calls.clone();
    context.expression_type_resolvers.borrow_mut().insert(
        PATH.to_owned(),
        Rc::new(move |_| {
            observed.set(observed.get() + 1);
            constant("@type.text")
        }),
    );
    let trace = Rc::new(RefCell::new(crate::hir::ResidualTrace::new(PATH)));
    let runtime = Runtime::residual(Phase::Comptime, PATH.to_owned(), trace.clone());
    let computation = evaluate(context, expression, runtime);
    assert!(
        matches!(computation, Computation::Step(_)),
        "evidence has a consumer"
    );
    let value = run(computation).expect("residual Text evaluates");
    assert_eq!(calls.get(), 1);
    let type_ = trace
        .borrow()
        .conservative_value_type(&value)
        .expect("checked evidence");
    // A known constant retains its singleton, not a widened Text carrier.
    assert!(equal(&type_, &value));
}

#[test]
fn application_queries_its_result_once_even_when_type_evidence_is_absent() {
    let mut arena = AstArena::default();
    let function = arena.expression(Expression::Intrinsic {
        name: "@text.len".to_owned(),
        span: SPAN,
    });
    let argument = arena.expression(Expression::Text {
        value: "abc".to_owned(),
        span: SPAN,
    });
    let application = arena.expression(Expression::Apply {
        function,
        argument,
        span: SPAN,
    });
    let context = context(arena, application);
    let calls = Rc::new(RefCell::new(HashMap::<ExpressionId, usize>::new()));
    let observed = calls.clone();
    context.expression_type_resolvers.borrow_mut().insert(
        PATH.to_owned(),
        Rc::new(move |expression| {
            *observed.borrow_mut().entry(expression).or_default() += 1;
            None
        }),
    );
    let value = run(evaluate(context, application, runtime())).expect("application evaluates");
    assert!(equal(&value, &Value::Int(3.into())));
    assert_eq!(calls.borrow().get(&application), Some(&1));
    assert_eq!(
        calls.borrow().get(&argument),
        Some(&1),
        "call argument evidence remains demanded"
    );
    assert_eq!(calls.borrow().get(&function), None);
}

#[test]
fn signature_fallbacks_are_lazy_but_keep_their_precedence() {
    for source in 0..3 {
        let mut arena = AstArena::default();
        let body = arena.expression(Expression::Unit { span: SPAN });
        let parameter = arena.pattern(Pattern::Unit { span: SPAN });
        let context = context(arena, body);
        let signature = Value::Arrow {
            deferred: false,
            domain: TypeValue::new(Value::Unit),
            codomain: TypeValue::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: None,
        };
        let calls = Rc::new(Cell::new(0));
        let observed = calls.clone();
        let fallback = signature.clone();
        context.closure_signature_resolvers.borrow_mut().insert(
            PATH.to_owned(),
            Rc::new(move |_| {
                observed.set(observed.get() + 1);
                assert_eq!(
                    source, 2,
                    "attached/recursive signature must win before resolution"
                );
                Some(fallback.clone())
            }),
        );
        let environment = child_env(None);
        if source == 1 {
            environment
                .signatures
                .borrow_mut()
                .insert("self".to_owned(), signature.clone());
        }
        let attached = if source == 0 {
            Some(Rc::new(signature))
        } else {
            None
        };
        let closure = Value::Closure {
            module: Rc::new(PATH.to_owned()),
            module_instances: Rc::new(Vec::new()),
            effect_scope: Rc::new(Vec::new()),
            parameter,
            body,
            environment,
            self_name: Some("self".to_owned()),
            imports: None,
            signature: attached,
            reuse_assertion: None,
            deferred: false,
        };
        let application = ApplicationSite::for_expression(&context, PATH, body).unwrap();
        let value = run(apply(
            context,
            closure,
            Value::Unit,
            SPAN,
            runtime(),
            application,
        ))
        .expect("closure evaluates");
        assert!(matches!(value, Value::Unit));
        assert_eq!(calls.get(), usize::from(source == 2));
    }
}

#[test]
fn no_evidence_continuation_does_not_hide_errors_or_change_fuel_limits() {
    let (context, expression) = one_expression(Expression::Var {
        name: "missing".to_owned(),
        span: SPAN,
    });
    let error = run(evaluate(context, expression, runtime())).expect_err("unbound variable");
    assert_eq!(error.code, "BLOT_UNBOUND");
    assert_eq!(error.origin.as_deref(), Some(PATH));
    assert_eq!(error.span, SPAN);

    let (context, expression) = one_expression(Expression::Unit { span: SPAN });
    let runtime = runtime();
    runtime.fuel.set(0);
    let error = run(evaluate(context, expression, runtime)).expect_err("no source fuel remains");
    assert_eq!(error.code, "BLOT_EVALUATION_LIMIT");
    assert_eq!(error.origin.as_deref(), Some(PATH));
    assert_eq!(error.span, SPAN);
}

#[test]
fn residual_aggregate_records_refined_runtime_field_evidence() {
    let mut arena = AstArena::default();
    let input = arena.expression(Expression::Var {
        name: "input".to_owned(),
        span: SPAN,
    });
    let record = arena.expression(Expression::Shape {
        members: vec![ShapeMember::Field {
            name: "field".to_owned(),
            value: input,
        }],
        span: SPAN,
    });
    let context = context(arena, record);
    let refined = Value::Range {
        low: TypeValue::new(Value::Int(1.into())),
        high: TypeValue::new(Value::Int(10.into())),
        domain: Some(ValueDomain::Int),
    };
    let expected = Value::Shape(vec![("field".to_owned(), refined)].into_iter().collect());
    let evidence = expected.clone();
    context.expression_type_resolvers.borrow_mut().insert(
        PATH.to_owned(),
        Rc::new(move |expression| (expression == record).then(|| evidence.clone())),
    );
    let trace = Rc::new(RefCell::new(crate::hir::ResidualTrace::new(PATH)));
    let (symbolic, _) = trace
        .borrow_mut()
        .export_parameter(
            &crate::typecheck::Type::Range {
                domain: crate::typecheck::Domain::Int,
                low: None,
                high: None,
            },
            SPAN,
        )
        .expect("runtime integer parameter");
    let environment = child_env(None);
    environment
        .names
        .borrow_mut()
        .insert("input".to_owned(), symbolic);
    let runtime = Runtime::residual(Phase::Comptime, PATH.to_owned(), trace.clone());
    let value = run(evaluate_expression(
        context,
        Rc::new(PATH.to_owned()),
        record,
        environment,
        runtime,
    ))
    .expect("residual record evaluates");
    let actual = trace
        .borrow()
        .conservative_value_type(&value)
        .expect("record evidence");
    assert!(
        equal(&actual, &expected),
        "lost field refinement: {actual:?}"
    );
}
