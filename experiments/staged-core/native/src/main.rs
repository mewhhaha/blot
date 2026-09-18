//! Explicit native laboratory entry point; normal Blot commands never call it.
use blot_staged_prototype::staged::PrototypeSession;
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 && args.len() != 3 {
        return Err("usage: staged-prototype INPUT.blot OUTPUT.wasm [EDITED.blot]".into());
    }
    let original = std::fs::read_to_string(&args[0]).map_err(|e| e.to_string())?;
    let edited = args
        .get(2)
        .map(std::fs::read_to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    if edited.as_ref() == Some(&original) {
        return Err("edited input must differ from the original source".into());
    }
    let initialization = Instant::now();
    let mut session = PrototypeSession::default();
    let initialization_ms = initialization.elapsed().as_secs_f64() * 1000.0;
    for (index, source) in std::iter::once(&original)
        .chain(edited.as_ref())
        .enumerate()
    {
        let start = Instant::now();
        let mut phase_start = start;
        let mut phases_ms = std::collections::BTreeMap::new();
        let artifact = session
            .compile_observed(source, |name| {
                let now = Instant::now();
                phases_ms.insert(name, now.duration_since(phase_start).as_secs_f64() * 1000.0);
                phase_start = now;
            })
            .map_err(|e| serde_json::to_string(&e).unwrap())?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let output = if index == 0 {
            PathBuf::from(&args[1])
        } else {
            PathBuf::from(format!("{}.edited.wasm", args[1]))
        };
        std::fs::write(&output, &artifact.wasm).map_err(|e| e.to_string())?;
        println!(
            "{}",
            serde_json::json!({"mode":if index==0{"cold"}else{"edited"},"compilationMs":elapsed,"phasesMs":phases_ms,"initializationMs":initialization_ms,"wasmBytes":artifact.wasm.len(),"artifact":artifact})
        );
    }
    Ok(())
}
