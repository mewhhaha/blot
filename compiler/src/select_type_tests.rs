use crate::session::CompilerSession;
use std::collections::BTreeMap;

fn session(source: &str) -> CompilerSession {
    let modules = [
        ("prelude", include_str!("../../src/prelude/prelude.blot")),
        ("channel", include_str!("../../src/prelude/channel.blot")),
        ("events", include_str!("../../src/prelude/events.blot")),
        ("io", include_str!("../../src/prelude/io.blot")),
        ("select", include_str!("../../src/prelude/select.blot")),
        ("spark", include_str!("../../src/prelude/spark.blot")),
        ("main", source),
    ];
    let imports = modules
        .iter()
        .map(|(name, _)| (format!("blot:{name}"), format!("{name}.blot")))
        .collect::<BTreeMap<_, _>>();
    let mut session = CompilerSession::default();
    for (name, source) in modules {
        let path = format!("{name}.blot");
        session
            .add_source(path.clone(), source.encode_utf16().collect())
            .expect("source parses");
        session
            .configure_module(
                &path,
                imports
                    .iter()
                    .filter(|(name, _)| source.contains(&format!("import \"{name}\"")))
                    .map(|(name, path)| (name.clone(), path.clone()))
                    .collect(),
                BTreeMap::new(),
            )
            .expect("imports resolve");
    }
    session
}

#[test]
fn select_resource_payloads_close_through_array_and_variant_signatures() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let session = session(concat!(
                "open import \"blot:prelude\"\n",
                "const Channel = import \"blot:channel\"\n",
                "const Select = import \"blot:select\"\n",
                "let run :: Channel.Receiver Int -> Select.Selection Int ~ { Select.Effect }\n",
                "let run = fn receiver => Select.wait [Select.channel receiver]\n",
                "return { .run = run; }\n",
            ));
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            session
                .compile_module("main.blot")
                .expect("checked Select closes");
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn partial_primitive_resource_constructor_consumes_its_family_parameter() {
    std::thread::Builder::new().stack_size(32 * 1024 * 1024).spawn(|| {
        let session = session(concat!(
            "open import \"blot:prelude\"\n",
            "const Channel = import \"blot:channel\"\n",
            "const SelectRuntime = @effect.host {\n",
            "  .wait = Effect.suspends ([#Channel (Channel.Receiver Int)] -> { .index = Int; .outcome = #Message (Option Int) | #Timeout; });\n",
            "}\n",
            "let run :: Channel.Receiver Int -> { .index = Int; .outcome = #Message (Option Int) | #Timeout; } ~ { SelectRuntime }\n",
            "let run = fn receiver => SelectRuntime.wait [#Channel receiver]\n",
            "return { .run = run; }\n",
        ));
        let checked = session.check_module("main.blot");
        assert_eq!(checked["ok"], true, "{checked}");
        session.compile_module("main.blot").expect("monomorphic Select closes");
    }).unwrap().join().unwrap();
}

#[test]
fn select_all_source_examples_close() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let session = session(include_str!("../../examples/lib/select.blot"));
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            session
                .compile_module("main.blot")
                .expect("all Select examples close");
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn host_array_arguments_retain_checked_variant_representations() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let session = session(concat!(
                "open import \"blot:prelude\"\n",
                "const Accept = @effect.host { .arms = [#One Int | #Two Int] -> Int; }\n",
                "let run :: Int -> Int ~ { Accept }\n",
                "let run = fn count => Accept.arms [#One count, #Two 2]\n",
                "return { .run = run; }\n",
            ));
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            session
                .compile_module("main.blot")
                .expect("mixed host arms close");
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn browser_actor_selects_input_while_child_work_is_pending() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let source = include_str!("../../case-studies/spark-browser/main.blot").replace(
                "const formula = import \"./formula.blot\"",
                "const formula = { .score = fn quantity => quantity * 2; }",
            );
            let session = session(&source);
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            session
                .compile_module("main.blot")
                .expect("browser actor closes");
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn nested_case_payloads_and_dynamic_sum_results_close() {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let session = session(include_str!("../../examples/lib/nested_case_joins.blot"));
            let checked = session.check_module("main.blot");
            assert_eq!(checked["ok"], true, "{checked}");
            session
                .compile_module("main.blot")
                .expect("nested case joins close");
        })
        .unwrap()
        .join()
        .unwrap();
}
