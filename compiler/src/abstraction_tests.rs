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
fn fold_rejects_an_incompatible_callback_input_during_checking() {
    let checked = check(include_str!("../../experiments/pr-triage/fold_input.blot"));
    assert_eq!(checked["diagnostic"]["code"], "BLOT_TYPE_ERROR", "{checked}");
}

#[test]
fn generic_composition_preserves_inhabited_result_payloads() {
    let checked = check(include_str!("../../experiments/pr-triage/generic_result.blot"));
    assert_eq!(checked["ok"], true, "{checked}");
    assert!(!checked["type"].as_str().unwrap().contains('⊥'), "{checked}");
}

#[test]
fn quantified_array_length_checks_in_its_parameter_context() {
    let checked = check(include_str!("../../experiments/pr-triage/quantified_length.blot"));
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
    let checked = check(include_str!("../../experiments/pr-triage/effect_composition.blot"));
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn immutable_projections_retain_guard_refinements() {
    let checked = check(include_str!("../../experiments/pr-triage/projected_refinement.blot"));
    assert_eq!(checked["ok"], true, "{checked}");
}

#[test]
fn constructor_payload_unions_have_visible_grouping() {
    let checked = check(include_str!("../../experiments/pr-triage/nested_variant_display.blot"));
    assert_eq!(checked["ok"], true, "{checked}");
    let printed = checked["type"].as_str().unwrap();
    assert!(printed.contains("#User (#Registered Text | #Deleted)"), "{printed}");
    assert!(printed.contains("#User #Registered Text | #Deleted | #System Text"), "{printed}");
}
