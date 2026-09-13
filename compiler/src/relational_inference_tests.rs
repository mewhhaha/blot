use crate::session::CompilerSession;
use std::collections::BTreeMap;

fn check(source: &str) -> serde_json::Value {
    let mut session = CompilerSession::default();
    session
        .add_source(
            "prelude.blot".into(),
            include_str!("../../src/prelude/prelude.blot")
                .encode_utf16()
                .collect(),
        )
        .unwrap();
    session
        .configure_module("prelude.blot", BTreeMap::new(), BTreeMap::new())
        .unwrap();
    session
        .add_source("main.blot".into(), source.encode_utf16().collect())
        .unwrap();
    session
        .configure_module(
            "main.blot",
            BTreeMap::from([("blot:prelude".into(), "prelude.blot".into())]),
            BTreeMap::new(),
        )
        .unwrap();
    session.check_module("main.blot")
}

#[test]
fn relational_helpers_and_loops_prove_their_accesses() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let checked = check(include_str!("../../examples/lib/relational_inference.blot"));
            assert_eq!(checked["ok"], true, "{checked}");
            let offset = include_str!("../../examples/lib/relational_inference.blot")
                .replacen(
                    "if index >= Array.length values:",
                    "if index >= Array.length values + 2:",
                    1,
                )
                .replace(
                    "let value = @array.get values index",
                    "let value = @array.get values (index - 2)",
                )
                .replace("visit (0, 0)", "visit (2, 0)");
            let checked = check(&offset);
            assert_eq!(checked["ok"], true, "nonzero initial state: {checked}");
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn relational_inference_rejects_invalid_loop_and_helper_guarantees() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let original = include_str!("../../examples/lib/relational_inference.blot");
            for (name, source) in [
                (
                    "wrong constructor payload",
                    original.replace("return #Some index", "return #Some (-1)"),
                ),
                (
                    "escaping recursive closure",
                    original.replace(
                        "return visit (0, 0)",
                        "let escaped = visit\n  return escaped (0, 0)",
                    ),
                ),
                (
                    "negative entry",
                    original.replace("visit (0, 0)", "visit (-1, 0)"),
                ),
                (
                    "decreasing back edge",
                    original.replace(
                        "visit (index + 1, total + value)",
                        "visit (index - 1, total + value)",
                    ),
                ),
                (
                    "wrong helper offset",
                    original.replace("fn value => value + 1", "fn value => value + 2"),
                ),
                (
                    "false nonnegative guarantee",
                    original.replace("#True => 0", "#True => -1"),
                ),
                (
                    "wrong array",
                    original.replace("@array.get values next", "@array.get [1] next"),
                ),
            ] {
                let checked = check(&source);
                assert_eq!(checked["ok"], false, "{name}: {checked}");
                assert!(
                    matches!(
                        checked["diagnostic"]["code"].as_str(),
                        Some("BLOT_UNPROVEN_INDEX" | "BLOT_OUT_OF_BOUNDS")
                    ),
                    "{name}: {checked}"
                );
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn relational_replay_rejects_forged_back_edge_evidence() {
    use crate::ast::{AstArena, Expression, Module, Pattern, ResultEffects, Span};
    use crate::eval::Context;
    use crate::relational::inference::{Closure, Inference, LoopProof, Operand, Refusal, integer};
    use crate::relational::proof::*;
    use std::rc::Rc;

    let span = Span { start: 0, end: 1 };
    let mut arena = AstArena::default();
    let parameter = arena.pattern(Pattern::Name {
        name: "index".into(),
        qualifier: crate::ast::Qualifier::None,
        span,
    });
    let function = arena.expression(Expression::Var {
        name: "again".into(),
        span,
    });
    let argument = arena.expression(Expression::Int {
        value: (-1).into(),
        span,
    });
    let body = arena.expression(Expression::Apply {
        function,
        argument,
        span,
    });
    let module = Rc::new(Module {
        parameter: None,
        declarations: Vec::new(),
        result: body,
        result_effects: ResultEffects::Ambient,
        span,
        arena,
    });
    let context = Rc::new(Context::default());
    let environment = crate::value::child_env(None);
    let closure = Rc::new(Closure {
        module: module.clone(),
        parameter,
        body,
        environment: environment.clone(),
        bindings: BTreeMap::new(),
        recursive: Some("again".into()),
        deferred: false,
    });
    let formal = Term::Variable {
        identity: 1,
        offset: 0.into(),
    };
    let proof = LoopProof {
        closure,
        argument: Operand {
            scalar: Some(formal.clone()),
            ..Operand::default()
        },
        initial: integer(0.into()),
        invariants: constraints_at_least(&formal, &Term::Literal(0.into())),
        entry: constraints_at_least(&Term::Literal(0.into()), &Term::Literal(0.into())),
        context: Constraints::default(),
        transitions: vec![(Vec::new(), Vec::new())],
    };
    let mut shared = Operand {
        scalar: Some(formal),
        ..Operand::default()
    };
    for _ in 0..100 {
        let mut closure = (*proof.closure).clone();
        closure.bindings =
            BTreeMap::from([("left".into(), shared.clone()), ("right".into(), shared)]);
        shared = Operand {
            closure: Some(Rc::new(closure)),
            ..Operand::default()
        };
    }
    assert!(crate::relational::inference::references(&shared, 1));
    assert!(!crate::relational::inference::references(&shared, 2));
    let mut inference = Inference::new(&context, 1);
    assert_eq!(inference.replay_loop(&proof), Err(Refusal::Unsupported));
    inference.remaining = 0;
    assert!(matches!(
        inference.evaluate(&module, &environment, body, Default::default()),
        Err(Refusal::Budget)
    ));
}

#[test]
fn relational_certificate_rejects_an_unproved_access() {
    use crate::ast::ExpressionId;
    use crate::refinement_evidence::RefinementFact;
    use crate::relational::proof::Term;
    let forged = RefinementFact::ArrayIndex {
        expression: ExpressionId(0),
        index: Term::Literal(1.into()),
        length: Term::Literal(1.into()),
        premises: Vec::new(),
    };
    assert!(forged.validate().is_err());
}
