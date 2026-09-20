use super::*;
use crate::ast::{AstArena, ResultEffects};

const PATH: &str = "instruction-test.blot";
const SPAN: Span = Span { start: 3, end: 17 };

fn context(arena: AstArena, result: ExpressionId) -> Rc<Context> {
    let source = Rc::new(Module {
        arena,
        result,
        parameter: None,
        declarations: Vec::new(),
        result_effects: ResultEffects::Pure,
        span: SPAN,
    });
    let context = Rc::new(Context::default());
    context.modules.borrow_mut().insert(
        PATH.to_owned(),
        LoadedModule::new(PATH, source, BTreeMap::new(), BTreeMap::new()),
    );
    context
}

#[test]
fn cached_instructions_create_fresh_aggregate_values() {
    for name in ["@array.empty", "@shape.empty"] {
        let mut arena = AstArena::default();
        let empty = arena.expression(Expression::Intrinsic {
            name: name.to_owned(),
            span: SPAN,
        });
        let result = arena.expression(Expression::Tuple {
            elements: vec![empty, empty],
            span: SPAN,
        });
        let context = context(arena, result);
        let value = run(evaluate_expression(
            context,
            Rc::new(PATH.to_owned()),
            result,
            child_env(None),
            Runtime::new(Phase::Comptime, PATH.to_owned()),
        ))
        .unwrap();
        let values = as_tuple(&value, 2).unwrap();
        match (&values[0], &values[1]) {
            (Value::Array(a), Value::Array(b)) => assert!(!a.same_identity(b)),
            (Value::Shape(a), Value::Shape(b)) => assert!(!a.same_identity(b)),
            _ => panic!("two empty aggregates expected"),
        }
    }
}

#[test]
fn deep_instruction_execution_preserves_fuel_and_source_evidence() {
    std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(|| {
            let mut arena = AstArena::default();
            let mut result = arena.expression(Expression::Int {
                value: 7.into(),
                span: SPAN,
            });
            for _ in 0..10_000 {
                let shape = arena.expression(Expression::Shape {
                    members: vec![ShapeMember::Field {
                        name: "value".to_owned(),
                        value: result,
                    }],
                    span: SPAN,
                });
                result = arena.expression(Expression::Field {
                    target: shape,
                    name: "value".to_owned(),
                    span: SPAN,
                });
            }
            let context = context(arena, result);
            let runtime = Runtime::new(Phase::Comptime, PATH.to_owned());
            let fuel = runtime.fuel.clone();
            let initial = fuel.get();
            let value = run(evaluate_expression(
                context.clone(),
                Rc::new(PATH.to_owned()),
                result,
                child_env(None),
                runtime,
            ))
            .unwrap();
            assert!(matches!(value, Value::Int(value) if value == 7.into()));
            assert_eq!(initial - fuel.get(), 20_001);
            let runtime = Runtime::new(Phase::Comptime, PATH.to_owned());
            runtime.fuel.set(5);
            let error = run(evaluate_expression(
                context,
                Rc::new(PATH.to_owned()),
                result,
                child_env(None),
                runtime,
            ))
            .err()
            .unwrap();
            assert_eq!(error.code, "BLOT_EVALUATION_LIMIT");
            assert_eq!(error.span, SPAN);
            assert_eq!(error.origin.as_deref(), Some(PATH));
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn invocation_slots_preserve_shadowing_open_scopes_and_captures() {
    let source = "let make = fn value => do:\n  let saved = value\n  let get = fn _ => saved\n  let saved = @int.add saved 1\n  open { .value = 99; }\n  return (get (), value)\nreturn (make 10, make 20)\n";
    let mut session = crate::session::CompilerSession::default();
    session
        .add_source(PATH.to_owned(), source.encode_utf16().collect())
        .unwrap();
    session
        .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
        .unwrap();
    let result = session.evaluate_module(PATH);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["display"], "((10, 99), (20, 99))");
}
