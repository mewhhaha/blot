//! Cold semantic benchmark for the staged-type boundary.
//! Run explicitly with `cargo test --release cold_staged_types -- --ignored --nocapture`.
use crate::session::CompilerSession;
use std::collections::BTreeMap;

fn fixture_session(source: &str) -> CompilerSession {
    let mut session = CompilerSession::default();
    for (path, text, imports) in [
        (
            "prelude.blot",
            include_str!("../../src/prelude/prelude.blot"),
            BTreeMap::new(),
        ),
        (
            "framework.blot",
            include_str!("../../experiments/compiler-bench/cold-semantic/framework.blot"),
            BTreeMap::from([("blot:prelude".into(), "prelude.blot".into())]),
        ),
        (
            "main.blot",
            source,
            BTreeMap::from([
                ("blot:prelude".into(), "prelude.blot".into()),
                ("./framework.blot".into(), "framework.blot".into()),
            ]),
        ),
    ] {
        session
            .add_source(path.into(), text.encode_utf16().collect())
            .unwrap();
        session
            .configure_module(path, imports, BTreeMap::new())
            .unwrap();
    }
    session
}

#[test]
#[ignore = "explicit cold semantic performance measurement"]
fn cold_staged_types() {
    let selected = std::env::var("BLOT_BENCH_FIXTURE").unwrap_or_else(|_| "full".into());
    let source = match selected.as_str() {
        "prefix" => include_str!("../../experiments/compiler-bench/cold-semantic/prefix.blot"),
        "full" => include_str!("../../experiments/compiler-bench/cold-semantic/full.blot"),
        other => panic!("unknown fixture {other}"),
    };
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(move || {
            let session = fixture_session(source);
            let start = std::time::Instant::now();
            let mut result = session.analyze_module_traced("main.blot");
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(result["effects"], serde_json::json!(""), "{result}");
            let telemetry = result
                .as_object_mut()
                .unwrap()
                .remove("phaseTelemetry")
                .unwrap();
            println!(
                "STAGED_TYPE_BENCH {}",
                serde_json::json!({
                    "fixture": selected,
                    "analyzeMs": elapsed,
                    "type": result["type"],
                    "effects": result["effects"],
                    "interfaceKey": result["interfaceKey"],
                    "targetPreflight": result["targetPreflight"],
                    "telemetry": telemetry,
                })
            );
        })
        .unwrap()
        .join()
        .unwrap();
}
