use crate::session::CompilerSession;
use std::collections::BTreeMap;

fn with_compiler<T: Send + 'static>(
    source: &str,
    observe: impl FnOnce(CompilerSession) -> T + Send + 'static,
) -> T {
    let source = source.to_owned();
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
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
            observe(session)
        })
        .expect("compiler test thread should start")
        .join()
        .expect("compiler test thread should finish")
}

fn check(source: &str) -> serde_json::Value {
    with_compiler(source, |session| session.check_module("main.blot"))
}

#[test]
fn shared_effects_use_the_key_and_complete_operation_contract() {
    with_compiler(
        r#"open import "blot:prelude"
const First = @effect.shared "test.counter" { .get = Unit -> Int; }
const Second = @effect.shared "test.counter" { .get = Unit -> Int; }
const OtherKey = @effect.shared "test.other" { .get = Unit -> Int; }
const OtherType = @effect.shared "test.counter" { .get = Unit -> Text; }
const Suspending = @effect.shared "test.counter" { .get = Effect.suspends (Unit -> Int); }
const Owned = @effect.shared "test.counter" { .get = Effect.produces (Unit -> Int); }
const Fresh = @effect { .get = Unit -> Int; }
const FreshAgain = @effect { .get = Unit -> Int; }
const Generic = @effect.shared "test.identity" { .apply = @forall (fn a => a -> a); }
const RenamedGeneric = @effect.shared "test.identity" { .apply = @forall (fn b => b -> b); }
return @type.equal First Second
  && not (@type.equal First OtherKey)
  && not (@type.equal First OtherType)
  && not (@type.equal First Suspending)
  && not (@type.equal First Owned)
  && not (@type.equal First Fresh)
  && not (@type.equal Fresh FreshAgain)
  && @type.equal Generic RenamedGeneric
"#,
        |session| {
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            let evaluated = session.evaluate_module("main.blot");
            assert_eq!(evaluated["display"], "#True", "{evaluated}");
            session.compile_module("main.blot").unwrap();
        },
    );
}

#[test]
fn shared_effects_reject_invalid_keys_and_unhandled_operations() {
    for source in [
        "const Read = @effect.shared \"\" { .get = @type.unit -> @type.int; }\nreturn Read",
        "const Read = @effect.shared 42 { .get = @type.unit -> @type.int; }\nreturn Read",
        "const Read = @effect.shared \"test.unhandled\" { .get = @type.unit -> @type.int; }\nreturn Read.get ()",
    ] {
        let checked = check(source);
        assert_eq!(checked["ok"], false, "{checked}");
        assert!(
            matches!(
                checked["diagnostic"]["code"].as_str(),
                Some("BLOT_TYPE" | "BLOT_TYPE_ERROR" | "BLOT_UNHANDLED_EFFECT")
            ),
            "{checked}"
        );
    }
}

#[test]
fn shared_effects_connect_independent_imports_and_snapshots() {
    with_compiler("return ()", |mut session| {
        let left = r#"const Read = @effect.shared "test.shared.read" { .get = @type.unit -> @type.int; }
return { .Read; .get = Read.get; }
"#;
        let right = left.replace("Read", "ReadElsewhere");
        for (path, source) in [("left.blot", left), ("right.blot", right.as_str())] {
            session
                .add_source(path.into(), source.encode_utf16().collect())
                .unwrap();
            session
                .configure_module(path, BTreeMap::new(), BTreeMap::new())
                .unwrap();
        }
        let caller = r#"const Left = import "./left.blot"
const Right = import "./right.blot"
return @handle (Left.Read, fn () => Right.get (), {
  .get = fn ((), ?resume) => resume 42;
})
"#;
        session
            .add_source("caller.blot".into(), caller.encode_utf16().collect())
            .unwrap();
        session
            .configure_module(
                "caller.blot",
                BTreeMap::from([
                    ("./left.blot".into(), "left.blot".into()),
                    ("./right.blot".into(), "right.blot".into()),
                ]),
                BTreeMap::new(),
            )
            .unwrap();
        for use_snapshots in [false, true] {
            if use_snapshots {
                for path in ["left.blot", "right.blot"] {
                    let snapshot = session.module_snapshot(path).unwrap();
                    session
                        .install_trusted_module_snapshot(path, &snapshot)
                        .unwrap();
                }
            }
            let checked = session.check_module("caller.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            let evaluated = session.evaluate_module("caller.blot");
            assert_eq!(evaluated["display"], "42", "{evaluated}");
            session.compile_module("caller.blot").unwrap();
        }
    });
}

#[test]
fn traversal_specialization_rejects_a_changed_element_carrier() {
    with_compiler(
        "open import \"blot:prelude\"\nconst T = import \"traversal.blot\"\nconst values: [Text]\nconst values = [\"a\", \"b\"]\nreturn T.over (T.each, values, fn _ => 1)\n",
        |mut session| {
            session
                .add_source(
                    "traversal.blot".into(),
                    include_str!("../../examples/lib/traversal.blot")
                        .encode_utf16()
                        .collect(),
                )
                .unwrap();
            session
                .configure_module(
                    "traversal.blot",
                    BTreeMap::from([("blot:prelude".into(), "prelude.blot".into())]),
                    BTreeMap::new(),
                )
                .unwrap();
            session
                .configure_module(
                    "main.blot",
                    BTreeMap::from([
                        ("blot:prelude".into(), "prelude.blot".into()),
                        ("traversal.blot".into(), "traversal.blot".into()),
                    ]),
                    BTreeMap::new(),
                )
                .unwrap();
            let checked = session.check_module("main.blot");
            assert_eq!(
                checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
                "{checked}"
            );
            assert_eq!(checked["diagnostic"]["origin"], "main.blot", "{checked}");
        },
    );
}

#[test]
fn nested_quantifiers_have_distinct_display_names() {
    let checked = check(
        "const pair: @forall (fn Left => @forall (fn Right => (Left, Right) -> (Right, Left)))\nconst pair = fn (left, right) => (right, left)\nreturn pair\n",
    );
    assert_eq!(checked["ok"], true, "{checked}");
    assert_eq!(
        checked["type"], "forall 'q0. forall 'q1. { .0 = 'q0; .1 = 'q1 } -> { .0 = 'q1; .1 = 'q0 }",
        "{checked}"
    );
}

#[test]
fn reflected_missing_fields_point_to_the_generator_call() {
    let source = "open import \"blot:prelude\"\nconst select = fn (Whole, names) => Reflect.pick (Whole, names)\nconst projected = select ({ .port = Int; }, [\"missing\"])\nreturn projected\n";
    let checked = check(source);
    assert_eq!(checked["diagnostic"]["code"], "BLOT_NO_FIELD", "{checked}");
    assert_eq!(checked["diagnostic"]["origin"], "main.blot", "{checked}");
    let span = &checked["diagnostic"]["span"];
    let selected =
        &source[span["start"].as_u64().unwrap() as usize..span["end"].as_u64().unwrap() as usize];
    assert!(selected.contains("[\"missing\"]"), "{checked}");
}

#[test]
fn fold_rejects_an_incompatible_callback_input_during_checking() {
    let source = include_str!("../../experiments/pr-triage/fold_input.blot");
    let checked = check(source);
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
    assert_eq!(checked["diagnostic"]["origin"], "main.blot", "{checked}");
    let span = &checked["diagnostic"]["span"];
    let caller =
        &source[span["start"].as_u64().unwrap() as usize..span["end"].as_u64().unwrap() as usize];
    assert!(caller.contains("fold"), "{checked}");
}

#[test]
fn generic_composition_preserves_inhabited_result_payloads() {
    let checked = check(include_str!(
        "../../experiments/pr-triage/generic_result.blot"
    ));
    assert_eq!(checked["ok"], true, "{checked}");
    assert_eq!(
        checked["type"], "#Ok { .value = #Health; .rest = Text } | #Error Text",
        "{checked}"
    );
}

#[test]
fn quantified_array_length_checks_in_its_parameter_context() {
    let checked = check(include_str!(
        "../../experiments/pr-triage/quantified_length.blot"
    ));
    assert_eq!(checked["ok"], true, "{checked}");
    assert_eq!(checked["type"], "Int", "{checked}");
}

#[test]
fn tuple_parameters_retain_case_coverage_context() {
    let checked = check(include_str!("../../experiments/pr-triage/tuple_case.blot"));
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn generic_middleware_preserves_its_open_effect_tail() {
    let checked = check(include_str!(
        "../../experiments/pr-triage/effect_composition.blot"
    ));
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn nested_resource_updates_preserve_unmodified_fields() {
    with_compiler(
        r#"open import "blot:prelude"
const update = fn access => fn () => do:
  let current = access.read ()
  return access.write { ...current; .count = current.count + 1; }
let run = fn (count: Int) => update {
  .read = fn () => { .count; .label = "kept"; };
  .write = fn value => value;
} ()
return { .run; }
"#,
        |session| {
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            assert_eq!(
                checked["type"], "{ .run = Int -> { .count = Int; .label = \"kept\" } }",
                "{checked}",
            );
            session
                .compile_module("main.blot")
                .expect("resource update should compile");
        },
    );
}

#[test]
fn generic_effect_handlers_defer_operation_ownership_until_specialization() {
    let checked = check(
        "const provide = fn (capability, work) => @handle (capability.Read, work, {\n\
           .get = fn ((), ?resume) => resume 1;\n\
         })\n\
         return { .provide; }\n",
    );
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn specialized_generic_handlers_still_check_operation_ownership() {
    for (parameter, expected) in [("value", false), ("!value", true)] {
        let source = format!(
            "open import \"blot:prelude\"\n\
             const consume = fn !value => value + 0\n\
             const provide = fn (capability, work) => @handle (capability, work, {{\n\
               .release = fn ({parameter}, ?resume) => resume (consume value);\n\
             }})\n\
             const Release = @effect {{ .release = Effect.consumes (Int -> Int); }}\n\
             const work = fn () => do:\n\
             \x20 let !value = 7\n\
             \x20 return Release.release (!value)\n\
             return provide (Release, work)\n",
        );
        let checked = check(&source);
        assert_eq!(checked["ok"], expected, "{checked}");
        if !expected {
            assert_eq!(
                checked["diagnostic"]["code"], "BLOT_EFFECT_HANDLER_OWNERSHIP",
                "{checked}"
            );
        }
    }
}

#[test]
fn imported_generic_handlers_check_specialized_operation_ownership() {
    with_compiler("return ()", |mut session| {
        let library = "open import \"blot:prelude\"\n\
            const consume = fn !value => value + 0\n\
            const provide = fn (capability, work) => @handle (capability, work, {\n\
              .release = fn (value, ?resume) => resume (consume value);\n\
            })\n\
            return { .provide; }\n";
        session
            .add_source("handler.blot".into(), library.encode_utf16().collect())
            .unwrap();
        session
            .configure_module(
                "handler.blot",
                BTreeMap::from([("blot:prelude".into(), "prelude.blot".into())]),
                BTreeMap::new(),
            )
            .unwrap();
        let checked = session.check_module("handler.blot");
        assert_eq!(checked["ok"], true, "{checked}");
        let caller = "open import \"blot:prelude\"\n\
            const Handler = import \"./handler.blot\"\n\
            const Release = @effect { .release = Effect.consumes (Int -> Int); }\n\
            const work = fn () => do:\n\
            \x20 let !value = 7\n\
            \x20 return Release.release (!value)\n\
            return Handler.provide (Release, work)\n";
        session
            .add_source("caller.blot".into(), caller.encode_utf16().collect())
            .unwrap();
        session
            .configure_module(
                "caller.blot",
                BTreeMap::from([
                    ("blot:prelude".into(), "prelude.blot".into()),
                    ("./handler.blot".into(), "handler.blot".into()),
                ]),
                BTreeMap::new(),
            )
            .unwrap();
        let checked = session.check_module("caller.blot");
        assert_eq!(
            checked["diagnostic"]["code"], "BLOT_EFFECT_HANDLER_OWNERSHIP",
            "{checked}"
        );
    });
}

#[test]
fn imported_system_reflection_retains_generated_effects() {
    with_compiler("return ()", |mut session| {
        let factory = r#"open import "blot:prelude"
const resource_type = fn (T, initial) => do:
  const Read = @effect { .get = Unit -> T; }
  const Write = @effect { .set = T -> Unit; }
  return { .Read; .Write; .initial; .get = Read.get; .set = Write.set; }
const component = fn prototype => do:
  const T = @type.of prototype
  const column = resource_type ([T], @satisfies [] [T])
  return { .column; .insert = fn (value: T) => do:
    use previous <- column.get ()
    return column.set (@linear.freeze (@array.push (Array.copy (&previous)) value))
  ; }
return { .component; }
"#;
        let reexport = r#"const Factory = import "./factory.blot"
return { .component = Factory.component; }
"#;
        let scene = r#"open import "blot:prelude"
const Loop = import "./loop.blot"
const Position = Loop.component 0.0
const Velocity = Loop.component 0.0
const setup = fn () => do:
  use Position.insert 1.0
  return Velocity.insert 2.0
return { .Position; .Velocity; .setup; }
"#;
        let caller = r#"open import "blot:prelude"
const Scene = import "./scene.blot"
const rec effects_of = fn T => case @type.reflect T of
  #Forall => effects_of (@type.probe T)
  #Arrow arrow => arrow.effects
  _ => @fail "not a function"
const effects = @linear.freeze (effects_of (@type.of Scene.setup))
const contains = fn effect => any ((&effects), fn candidate => @type.equal candidate effect)
const verified = case (contains Scene.Position.column.Read, contains Scene.Position.column.Write, contains Scene.Velocity.column.Read, contains Scene.Velocity.column.Write) of
  (#True, #True, #True, #True) => True
  _ => @fail "reflected effects lost their module instance"
return verified
"#;
        for (path, source, dependencies) in [
            ("factory.blot", factory, vec![]),
            (
                "loop.blot",
                reexport,
                vec![("./factory.blot", "factory.blot")],
            ),
            ("scene.blot", scene, vec![("./loop.blot", "loop.blot")]),
            ("caller.blot", caller, vec![("./scene.blot", "scene.blot")]),
        ] {
            session
                .add_source(path.into(), source.encode_utf16().collect())
                .unwrap();
            let mut imports = BTreeMap::from([("blot:prelude".into(), "prelude.blot".into())]);
            imports.extend(
                dependencies
                    .into_iter()
                    .map(|(specifier, target)| (specifier.into(), target.into())),
            );
            session
                .configure_module(path, imports, BTreeMap::new())
                .unwrap();
        }
        let checked = session.check_module("caller.blot");
        assert_eq!(checked["ok"], true, "{checked}");
        assert_eq!(checked["type"], "#True", "{checked}");
        session.compile_module("caller.blot").unwrap();
    });
}

#[test]
fn immutable_projections_retain_guard_refinements() {
    let checked = check(include_str!(
        "../../experiments/pr-triage/projected_refinement.blot"
    ));
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn constructor_payload_unions_have_visible_grouping() {
    let checked = check(include_str!(
        "../../experiments/pr-triage/nested_variant_display.blot"
    ));
    assert_eq!(checked["ok"], true, "{checked}");
    let printed = checked["type"].as_str().unwrap();
    assert!(
        printed.contains("#User (#Registered Text | #Deleted)"),
        "{printed}"
    );
    assert!(
        printed.contains("#User #Registered Text | #Deleted | #System Text"),
        "{printed}"
    );
}

#[test]
fn multiline_syntax_errors_point_to_the_continuation() {
    for (source, token, guidance) in [
        (
            include_str!("../../experiments/pr-triage/multiline_lambda.blot"),
            "=>",
            "`do:`",
        ),
        (
            include_str!("../../experiments/pr-triage/multiline_union.blot"),
            "|",
            "parentheses",
        ),
    ] {
        let mut session = CompilerSession::default();
        let crate::session::AddSourceError::Diagnostics(diagnostics) = session
            .add_source("main.blot".into(), source.encode_utf16().collect())
            .unwrap_err()
        else {
            panic!("the parser must return source evidence")
        };
        let diagnostic = &diagnostics[0];
        assert!(diagnostic.message.contains(guidance), "{diagnostic:?}");
        assert_eq!(
            &source[diagnostic.span.start as usize..diagnostic.span.end as usize],
            token
        );
    }
}

#[test]
fn generic_composition_rejects_an_incompatible_transform() {
    let source = include_str!("../../experiments/pr-triage/generic_result.blot")
        .replace("fn _ => #Health", "fn value => @int.add value 1");
    let checked = check(&source);
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
}

#[test]
fn forwarded_schema_factory_preserves_its_result_parameter_contract() {
    let source = r#"open import "blot:prelude"
const derive = fn schema => do:
  let compare: (schema, schema) -> Int
  let compare = fn _ => 1
  return { .compare = compare; }
const forward = fn derive => fn schema => derive schema
const selected = forward derive { .id = Int; }
return selected.compare ({ .wrong = "oops"; }, { .id = 7; })
"#;
    let checked = check(source);
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
    let checked = check(&source.replace(".wrong = \"oops\"", ".id = 4"));
    assert_eq!(checked["ok"], true, "{checked}");
    let source = source
        .split("return selected.compare")
        .next()
        .unwrap()
        .to_owned()
        + "return selected\n";
    let checked = check(&source);
    assert_eq!(
        checked["type"], "{ .compare = { .0 = { .id = Int }; .1 = { .id = Int } } -> Int }",
        "{checked}"
    );
}

#[test]
fn quantified_context_does_not_accept_a_concrete_implementation() {
    let checked = check(
        "open import \"blot:prelude\"\nconst identity: @forall (fn T => T -> T)\nconst identity = fn _ => 1\nreturn identity\n",
    );
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
}

#[test]
fn tuple_context_still_requires_every_constructor() {
    let source = include_str!("../../experiments/pr-triage/tuple_case.blot")
        .replace("    #None => left\n", "");
    let checked = check(&source);
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
    assert!(
        checked["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("#None"),
        "{checked}"
    );
}

#[test]
fn middleware_cannot_discard_its_inherited_effect_tail() {
    let source = include_str!("../../experiments/pr-triage/effect_composition.blot")
        .split("return { .instrument")
        .next()
        .unwrap()
        .to_owned()
        + "const Request = @effect { .send = Int -> Int; }\nconst perform: Int -> Int ~ { Request }\nconst perform = fn value => Request.send value\nconst erased: Int -> Int ~ { Trace, Metrics }\nconst erased = instrument perform\nreturn erased\n";
    let checked = check(&source);
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
}

#[test]
fn projection_refinements_do_not_transfer_to_another_field() {
    let source = include_str!("../../experiments/pr-triage/projected_refinement.blot")
        .replace("{ .port = Int; }", "{ .port = Int; .other = Int; }")
        .replace("#Some raw.port", "#Some raw.other")
        .replace("{ .port = 42; }", "{ .port = 42; .other = 0; }");
    let checked = check(&source);
    assert_eq!(
        checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
        "{checked}"
    );
}

#[test]
fn projection_refinements_follow_nested_paths() {
    let source = include_str!("../../experiments/pr-triage/projected_refinement.blot")
        .replace("{ .port = Int; }", "{ .network = { .port = Int; }; }")
        .replace("raw.port", "raw.network.port")
        .replace("{ .port = 42; }", "{ .network = { .port = 42; }; }");
    let checked = check(&source);
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn record_selection_loop_retains_its_nested_variant_representation() {
    with_compiler(
        include_str!("../../examples/lib/record_selection.blot"),
        |session| {
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(prepared["ok"], true, "{prepared}");
        },
    );
}

#[test]
fn shape_updates_preserve_fields_outside_the_checked_parameter_row() {
    let source = include_str!("../../examples/lib/shape_update.blot");
    with_compiler(source, |session| {
        let evaluated = session.evaluate_module("main.blot");
        assert_eq!(evaluated["ok"], true, "{evaluated}");
        assert_eq!(evaluated["display"], "3", "{evaluated}");
        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
    with_compiler(
        include_str!("../../examples/lib/shape_update_runtime.blot"),
        |session| {
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(prepared["ok"], true, "{prepared}");
        },
    );
}

#[test]
fn inferred_development_provider_closes_aggregate_result_representations() {
    with_compiler(
        r#"open import "blot:prelude"
const codec = import "./codec.blot"
const Distance = @type.seal "Distance" Int
const Source = @effect.host { .value = Unit -> Int; .distance = Unit -> Distance; }
use value <- Source.value ()
use distance <- Source.distance ()
let values = [value, value + 1]
let response = codec.expand {
  .choice = #Some (value + 2);
  .label = "oak";
  .seed = value + 3;
  .values = values;
}
let reflected = codec.reflect { .distance = distance; .value = value; }
return (response, Array.length values, reflected)
"#,
        |mut session| {
            session
                .add_source(
                    "codec.blot".into(),
                    r#"open import "blot:prelude"
let expand = fn request => {
  .choice = request.choice;
  .label = request.label;
  .values = [...request.values, request.seed];
}
let reflect = fn value => value
return { .expand = expand; .reflect = reflect; }
"#
                    .encode_utf16()
                    .collect(),
                )
                .unwrap();
            session
                .configure_module(
                    "codec.blot",
                    BTreeMap::from([("blot:prelude".into(), "prelude.blot".into())]),
                    BTreeMap::new(),
                )
                .unwrap();
            session
                .configure_module(
                    "main.blot",
                    BTreeMap::from([
                        ("blot:prelude".into(), "prelude.blot".into()),
                        ("./codec.blot".into(), "codec.blot".into()),
                    ]),
                    BTreeMap::new(),
                )
                .unwrap();
            let program = session
                .compile_development_program(
                    "main.blot",
                    "game",
                    &BTreeMap::from([
                        ("game".into(), "main.blot".into()),
                        ("codec".into(), "codec.blot".into()),
                    ]),
                )
                .unwrap();
            assert_eq!(program.edges.len(), 2, "{:?}", program.edges);
        },
    );
}

#[test]
fn open_export_refusals_name_the_field_and_parameter() {
    with_compiler(
        "let compare = fn left => fn right => left\nreturn { .compare = compare; }\n",
        |session| {
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(
                prepared["targetRefusal"]["code"], "BLOT_UNSUPPORTED_LOWERING",
                "{prepared}"
            );
            assert!(prepared.get("diagnostic").is_none(), "{prepared}");
            let message = prepared["targetRefusal"]["message"].as_str().unwrap();
            assert!(
                message.contains("Parameter 1 of export 'compare'"),
                "{message}"
            );
            assert!(message.contains("concrete function signature"), "{message}");
        },
    );
}

#[test]
fn deep_rebinding_preserves_old_values_and_threads_the_root_through_loops() {
    with_compiler(
        include_str!("../../examples/deep_rebinding.blot"),
        |session| {
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            let evaluated = session.evaluate_module("main.blot");
            assert_eq!(evaluated["display"], "[0, 9, 7, 9, 3]", "{evaluated}");
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(prepared["ok"], true, "{prepared}");
        },
    );
}

#[test]
fn deep_rebinding_uses_existing_field_type_and_bounds_checks() {
    for (source, code) in [
        (
            "let record = { .x = 1; }\nrecord.missing := 2\nreturn record\n",
            "BLOT_TYPE_ERROR",
        ),
        (
            "let record: { .x = @type.int; }\nlet record = { .x = 1; }\nrecord.x := \"bad\"\nreturn record\n",
            "BLOT_TYPE_ERROR",
        ),
        (
            "let record: { .x = 0; }\nlet record = { .x = 0; }\nrecord.x := 3\nreturn record\n",
            "BLOT_TYPE_ERROR",
        ),
        (
            "let values = [1, 2]\nvalues[2] := 1\nreturn values\n",
            "BLOT_OUT_OF_BOUNDS",
        ),
        (
            "let values = [1, 2]\nlet update = fn index => do:\n  let values = values\n  values[index] := 1\n  return values\nreturn update\n",
            "BLOT_UNPROVEN_INDEX",
        ),
    ] {
        let checked = check(source);
        assert_eq!(checked["diagnostic"]["code"], code, "{source}\n{checked}");
    }
}

#[test]
fn deep_rebinding_cannot_advance_a_captured_root() {
    let source = "let record = { .x = 1; }\nlet update = fn () => do:\n  record.x := 1\n  return record\nreturn update\n";
    let mut session = CompilerSession::default();
    let crate::session::AddSourceError::Diagnostics(diagnostics) = session
        .add_source("main.blot".into(), source.encode_utf16().collect())
        .expect_err("a captured root cannot be rebound")
    else {
        panic!("captured root failed without a source diagnostic");
    };
    assert_eq!(diagnostics[0].code, "BLOT_REBINDING_FRAME");
    assert_eq!(
        source[diagnostics[0].span.start as usize..diagnostics[0].span.end as usize].trim(),
        "record.x := 1"
    );
}

#[test]
fn deep_rebinding_runtime_paths_have_closed_representations() {
    with_compiler(
        include_str!("../../examples/lib/deep_rebinding_runtime.blot"),
        |session| {
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(prepared["ok"], true, "{prepared}");
        },
    );
}

#[test]
fn deep_rebinding_preserves_captures_aliases_and_owned_siblings() {
    let sources = [
        (
            "let state = { .values = [1, 2]; .tick = 0; }\nstate.tick := @int.add state.tick 1\nstate.values[@int.sub (@array.len state.values) 1] := @int.add (@array.get state.values 0) 2\nreturn (@array.get state.values 1, state.tick)\n",
            "(3, 1)",
        ),
        (
            "let record = { .x = 0; .label = \"Ada\"; }\nlet saved = fn () => record.x\nlet alias = record\nalias.label := \"Lin\"\nrecord.x := 3\nreturn (@int.add (saved ()) record.x, alias.label)\n",
            "(3, \"Lin\")",
        ),
        (
            "let box = { .nested = { .values = [1, 2]; .keep = [7]; }; .tick = 0; }\nbox.nested.values[0] := 3\nbox.nested.values[1] := 4\nreturn (@array.get box.nested.values 0, @array.get box.nested.values 1, @array.get box.nested.keep 0)\n",
            "(3, 4, 7)",
        ),
        (
            "let consume = fn !value => @int.add value 1\nlet !token = 41\nlet holder = { .go = fn () => consume (!token); .count = 0; }\nholder.count := 1\nlet count = holder.count\nreturn @int.add (holder.go ()) count\n",
            "43",
        ),
    ];
    for (source, expected) in sources {
        with_compiler(source, move |session| {
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            let evaluated = session.evaluate_module("main.blot");
            assert_eq!(evaluated["display"], expected, "{evaluated}");
            let prepared = session.prepare_runtime_hir("main.blot");
            assert_eq!(prepared["ok"], true, "{prepared}");
        });
    }
}

#[test]
fn deep_rebinding_rejects_lost_or_copied_resources_and_explicit_refinements() {
    for source in [
        "open import \"blot:prelude\"\nlet update = fn (values, replacement) => do:\n  if Array.length values > 0:\n    values[0] := replacement\n  return values\nlet consume = fn !value => value + 1\nlet !token = 41\nlet values = [fn () => consume (!token)]\nreturn update (values, fn () => 1)\n",
        "let consume = fn !value => @int.add value 1\nlet !token = 41\nlet values = [fn () => consume (!token)]\nvalues[0] := fn () => 1\nreturn values\n",
        "let update = fn flag => do:\n  let box = { .left = [1]; .right = [2]; }\n  let removed = case flag of\n    #True => box.left\n    #False => box.right\n  let rebuilt = { ...box; .left = [3]; }\n  return (removed, rebuilt)\nreturn update\n",
        "let record = { .x = @satisfies 0 0; }\nrecord.x := 3\nreturn record\n",
        "let consume = fn !value => @int.add value 1\nlet !token = 41\nlet holder = { .go = fn () => consume (!token); .count = 0; }\nholder.go := fn () => 1\nreturn holder.go ()\n",
        "let consume = fn !value => @int.add value 1\nlet !token = 41\nlet values = [fn () => consume (!token)]\nvalues[0] := fn () => 1\nreturn (@array.get values 0) ()\n",
        "let source = { .values = [1]; .tick = 0; }\nlet moved = source.values\nlet rebuilt = { ...source; .tick = 1; }\nreturn (@array.get moved 0, rebuilt)\n",
    ] {
        let checked = check(source);
        assert_eq!(checked["ok"], false, "{source}\n{checked}");
        assert!(checked.get("diagnostic").is_some(), "{checked}");
    }
}
