use crate::session::CompilerSession;
use std::collections::BTreeMap;

fn compiler_with_prelude(source: &str) -> CompilerSession {
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
    session
}

fn check(source: &str) -> serde_json::Value {
    compiler_with_prelude(source).check_module("main.blot")
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
    assert!(
        !checked["type"].as_str().unwrap().contains('⊥'),
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
  let compare :: (schema, schema) -> Int
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
}

#[test]
fn quantified_context_does_not_accept_a_concrete_implementation() {
    let checked = check(
        "open import \"blot:prelude\"\nconst identity :: @forall (fn T => T -> T)\nconst identity = fn _ => 1\nreturn identity\n",
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
        + "const Request = @effect { .send = Int -> Int; }\nconst perform :: Int -> Int ~ { Request }\nconst perform = fn value => Request.send value\nconst erased :: Int -> Int ~ { Trace, Metrics }\nconst erased = instrument perform\nreturn erased\n";
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
    let session = compiler_with_prelude(include_str!("../../examples/lib/record_selection.blot"));
    let checked = session.check_module("main.blot");
    assert_eq!(checked["ok"], true, "{checked}");
    let prepared = session.prepare_runtime_hir("main.blot");
    assert_eq!(prepared["ok"], true, "{prepared}");
}

#[test]
fn open_export_refusals_name_the_field_and_parameter() {
    let session = compiler_with_prelude(
        "let compare = fn left => fn right => left\nreturn { .compare = compare; }\n",
    );
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
}
