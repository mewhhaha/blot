use super::*;

fn compile(source: &str) -> Artifact {
    let a = PrototypeSession::default().compile(source).unwrap();
    wasmparser::Validator::new().validate_all(&a.wasm).unwrap();
    a
}
const PRE: &str = "const Int = @staged.int\nconst Bool = @staged.bool\n";
const DEMO: &str = r#"const Int = @staged.int
const makeSchema = @staged.static (fn (A, B) => @staged.record { .left = A; .right = B; })
const Pair = @staged.static (makeSchema (Int, Int))
const makeGetter = @staged.static (fn schema => @staged.getter (schema, "left"))
const getLeft = @staged.splice (makeGetter Pair)
const id = fn x => x
const apply = fn (f, x) => f x
const makeAdder = fn x => fn y => @staged.add (x, y)
const work = fn x => apply (makeAdder 10, getLeft { .left = id x; .right = 99; })
return { .run = fn (x: Int) -> Int => work x; }
"#;

#[test]
fn smoke() {
    let a = compile(&format!(
        "{PRE}const id = fn x => x\nreturn {{ .run = fn (x: Int) -> Int => id x; }}\n"
    ));
    assert_eq!(a.interfaces["id"], "(a0 -> a0)");
}
#[test]
fn computed_schema_and_generated_accessor_compile() {
    let a = compile(DEMO);
    assert!(a.work.static_calls > 0);
    assert!(a.interfaces["getLeft"].contains("left: Int64"));
}
#[test]
fn local_runtime_edit_reuses_interfaces_static_generators_and_fragments() {
    let mut s = PrototypeSession::default();
    let a = s.compile(DEMO).unwrap();
    let changed = DEMO.replace("makeAdder 10", "makeAdder 20");
    let b = s.compile(&changed).unwrap();
    assert_eq!(b.work.checked_definitions, 1);
    assert_eq!(b.work.reused_definitions, 8);
    assert_eq!(b.work.static_calls, 0);
    assert!(b.work.reused_functions > 0);
    assert!(b.work.emitted_functions < a.work.emitted_functions);
    assert_ne!(a.wasm, b.wasm);
    wasmparser::Validator::new().validate_all(&b.wasm).unwrap();
}
#[test]
fn unchanged_request_does_not_reinfer_named_bodies_or_execute_static_calls() {
    let mut s = PrototypeSession::default();
    let a = s.compile(DEMO).unwrap();
    let b = s.compile(DEMO).unwrap();
    assert_eq!(a.wasm, b.wasm);
    assert_eq!(b.work.checked_definitions, 0);
    assert_eq!(b.work.static_calls, 0);
    assert_eq!(b.work.emitted_functions, 0);
    assert!(b.work.parsed_expressions > 0);
}
#[test]
fn global_implementation_edit_rechecks_static_consumers_not_runtime_callers() {
    let source = format!(
        "{PRE}const helper = fn x => @staged.add (x, 1)\nconst fixed = @staged.static (helper 5)\nconst dynamic = fn x => helper x\nreturn {{ .run = fn (x: Int) -> Int => @staged.add (dynamic x, fixed); }}\n"
    );
    let mut s = PrototypeSession::default();
    let a = s.compile(&source).unwrap();
    let b = s.compile(&source.replace("(x, 1)", "(x, 2)")).unwrap();
    assert_eq!(b.work.checked_definitions, 2);
    assert!(b.work.static_calls > 0);
    assert_ne!(a.wasm, b.wasm);
}
#[test]
fn schema_changes_invalidate_generated_code_and_reject_bad_new_uses() {
    let mut s = PrototypeSession::default();
    s.compile(DEMO).unwrap();
    let bad = DEMO.replace("makeSchema (Int, Int)", "makeSchema (@staged.bool, Int)");
    let err = s.compile(&bad).unwrap_err();
    assert_eq!(err.class, FailureClass::Source);
    assert_eq!(err, PrototypeSession::default().compile(&bad).unwrap_err());
    s.compile(DEMO).unwrap();
}
#[test]
fn changing_a_dependency_interface_rechecks_callers() {
    let source = format!(
        "{PRE}const f = fn x => @staged.add (x, 1)\nconst g = fn x => f x\nreturn {{ .run = fn (x: Int) -> Int => g x; }}\n"
    );
    let mut s = PrototypeSession::default();
    s.compile(&source).unwrap();
    let bad = source.replace("@staged.add (x, 1)", "@staged.eq (x, 1)");
    assert_eq!(
        s.compile(&bad).unwrap_err(),
        PrototypeSession::default().compile(&bad).unwrap_err()
    );
}
#[test]
fn generative_calls_are_not_memoized_or_coalesced() {
    let source = "const make = @staged.static (fn () => @staged.fresh ())\nconst A = @staged.static (make ())\nconst B = @staged.static (make ())\nreturn {}\n";
    let mut s = PrototypeSession::default();
    let a = s.compile(source).unwrap();
    assert_eq!(a.work.fresh_identities, 2);
    let mut nominal = Vec::new();
    for v in &s.values.nodes {
        if let Value::Type(t) = v
            && matches!(s.types.nodes[*t], Type::Nominal(_))
        {
            nominal.push(t);
        }
    }
    assert_eq!(nominal.len(), 2);
    assert_ne!(nominal[0], nominal[1]);
    let b = s.compile(source).unwrap();
    assert_eq!(b.work.fresh_identities, 0);
}
#[test]
fn runtime_bindings_cannot_enter_comptime() {
    let source =
        format!("{PRE}const bad = fn x => @staged.static (@staged.add (x, 1))\nreturn {{}}\n");
    let err = PrototypeSession::default().compile(&source).unwrap_err();
    assert_eq!(err.class, FailureClass::Source);
    assert!(err.message.contains("runtime"));
    assert!(err.site.start > 0);
}
#[test]
fn closed_quotation_splices_without_source_rechecking() {
    let a = compile(&format!(
        "{PRE}const generated = @staged.static (@staged.quote (fn x => @staged.add (x, 3)))\nconst f = @staged.splice generated\nreturn {{ .run = fn (x: Int) -> Int => f x; }}\n"
    ));
    assert_eq!(a.interfaces["f"], "(Int64 -> Int64)");
}
#[test]
fn quotation_does_not_capture_a_static_local_implicitly() {
    let source = "const bad = @staged.static ((fn n => @staged.quote (fn x => @staged.add (x, n))) 3)\nreturn {}\n";
    assert_eq!(
        PrototypeSession::default()
            .compile(source)
            .unwrap_err()
            .class,
        FailureClass::Source
    );
}
#[test]
fn inference_supports_open_records_and_distinct_instantiations() {
    let a = compile(&format!(
        "{PRE}const get = fn r => r.value\nconst id = fn x => x\nconst a = id 3\nconst b = id @staged.true\nconst x = get {{ .value = a; .extra = b; }}\nconst y = get {{ .other = a; .value = b; }}\nconst run = fn (n: Int) -> Int => do:\n  if y:\n    return @staged.add (n, x)\n  else:\n    return n\nreturn {{ .run = run; }}\n"
    ));
    assert!(a.interfaces["get"].contains("..r"));
}
#[test]
fn local_let_generalizes_only_unbound_variables() {
    compile(&format!(
        "{PRE}const f = fn n => do:\n  let id = fn x => x\n  let a = id 2\n  let b = id @staged.true\n  if b:\n    return @staged.add (n, a)\n  else:\n    return n\nreturn {{ .run = fn (x: Int) -> Int => f x; }}\n"
    ));
    let bad = format!(
        "{PRE}const f = fn x => do:\n  let g = fn _ => x\n  let a = @staged.add (g (), 1)\n  if g ():\n    return a\n  else:\n    return 0\nreturn {{}}\n"
    );
    assert_eq!(
        PrototypeSession::default().compile(&bad).unwrap_err().class,
        FailureClass::Source
    );
}
#[test]
fn occurs_check_rejects_self_application() {
    let err = PrototypeSession::default()
        .compile("const omega = fn x => x x\nreturn {}\n")
        .unwrap_err();
    assert_eq!(err.class, FailureClass::Source);
    assert!(err.message.contains("infinite"));
}
#[test]
fn missing_field_is_not_a_runtime_trap_or_invariant_failure() {
    let source = "const get = fn r => r.x\nconst wrong = get { .y = 1; }\nreturn {}\n";
    assert_eq!(
        PrototypeSession::default()
            .compile(source)
            .unwrap_err()
            .class,
        FailureClass::Source
    );
}
#[test]
fn unused_invalid_definitions_are_checked() {
    assert_eq!(
        PrototypeSession::default()
            .compile("const invalid = @staged.add (1, @staged.true)\nreturn {}\n")
            .unwrap_err()
            .class,
        FailureClass::Source
    );
}
#[test]
fn invalid_computed_type_fails_at_the_bridge() {
    let err = PrototypeSession::default()
        .compile("const Invalid = @staged.static (@staged.record { .x = 3; })\nreturn {}\n")
        .unwrap_err();
    assert_eq!(err.class, FailureClass::Source);
    assert!(err.message.contains("not a Type"));
}
#[test]
fn unsupported_forms_never_fall_back_to_production() {
    let err = PrototypeSession::default()
        .compile("open import \"blot:prelude\"\nreturn {}\n")
        .unwrap_err();
    assert_eq!(err.class, FailureClass::Unsupported);
}
#[test]
fn budget_exhaustion_is_not_a_source_diagnostic() {
    let mut s = PrototypeSession::with_limits(Limits {
        work: 1,
        ..Limits::default()
    });
    assert_eq!(s.compile(DEMO).unwrap_err().class, FailureClass::Limit);
}
#[test]
fn missing_name_recovery_and_moved_diagnostics_agree_with_fresh_compilation() {
    let bad = "const invalid = missing\nreturn {}\n";
    let mut s = PrototypeSession::default();
    assert_eq!(s.compile(bad).unwrap_err().class, FailureClass::Source);
    let valid = "const missing = 42\nconst invalid = missing\nreturn {}\n";
    s.compile(valid).unwrap();
    let moved = format!("// new location\n{bad}");
    assert_eq!(
        s.compile(&moved).unwrap_err(),
        PrototypeSession::default().compile(&moved).unwrap_err()
    );
}
#[test]
fn bindings_resolve_to_their_original_shadowed_symbol() {
    compile(&format!(
        "{PRE}const amount = 1\nconst f = fn x => @staged.add (x, amount)\nconst amount = 100\nreturn {{ .run = fn (x: Int) -> Int => f x; }}\n"
    ));
}
#[test]
fn shared_type_diamonds_remain_linear_through_import_and_freeze() {
    use types::{Inference, Types};
    let mut types = Types::default();
    let mut root = types::INT;
    for _ in 0..24 {
        root = types.intern(Type::Function(root, root));
    }
    let limits = Limits {
        work: 1000,
        ..Limits::default()
    };
    let budget = Budget::new(&limits);
    let mut inf = Inference::new(budget.clone());
    let imported = inf.import(&types, root, Site::default()).unwrap();
    let result = inf
        .freeze(
            &mut types,
            imported,
            &mut HashMap::new(),
            &mut HashMap::new(),
            Site::default(),
        )
        .unwrap();
    assert_eq!(root, result);
    assert!(limits.work - budget.remaining.get() < 150);
    assert_eq!(types.nodes.len(), 30);
}

#[test]
fn static_iteration_builds_a_shared_computed_schema_without_tree_expansion() {
    let source = "const double = @staged.static (fn t => @staged.record { .left = t; .right = t; })\nconst Tree = @staged.static (@staged.iterate (24, double, @staged.int))\nreturn {}\n";
    let a = compile(source);
    let empty = compile(&source.replace("(24, double,", "(0, double,"));
    // Each layer adds exactly one field row and its record type wrapper.
    assert_eq!(a.work.retained_types - empty.work.retained_types, 2 * 24);
    assert!(a.work.work_units < 4000, "{:?}", a.work);
}

#[test]
fn many_pure_generator_calls_reuse_checked_results() {
    let source = "const make = @staged.static (fn x => @staged.record { .x = x; })\nconst A = @staged.static (make @staged.int)\nconst B = @staged.static (make @staged.int)\nreturn {}\n";
    let a = compile(source);
    assert!(a.work.static_cache_hits >= 1);
}

#[test]
fn known_runtime_arguments_do_not_trigger_implicit_partial_evaluation() {
    let a = compile(
        "const n = @staged.add (20, 22)\nreturn { .run = fn (x: @staged.int) -> @staged.int => @staged.add (x, n); }\n",
    );
    assert_eq!(a.work.static_calls, 0);
    assert!(a.work.emitted_functions >= 2);
}

#[test]
fn source_fixity_changes_are_cache_dependencies() {
    let prefix = "infixl 5 (+) = add\nconst add = fn x => fn y => @staged.add (x, y)\nconst sub = fn x => fn y => @staged.sub (x, y)\n";
    let source = format!(
        "{prefix}const Int = @staged.int\nconst f = fn (x: Int) -> Int => x + 3\nreturn {{ .run = f; }}\n"
    );
    let mut s = PrototypeSession::default();
    let before = s.compile(&source).unwrap();
    let after = s
        .compile(&source.replace("(+) = add", "(+) = sub"))
        .unwrap();
    assert_ne!(before.wasm, after.wasm);
    assert_eq!(after.work.checked_definitions, 4);
}

#[test]
fn unsupported_effects_and_ownership_are_not_silently_erased() {
    for source in [
        "const f = fn (?x) => x\nreturn {}\n",
        "const e = @effect { .read = @staged.int; }\nreturn {}\n",
    ] {
        assert_eq!(
            PrototypeSession::default()
                .compile(source)
                .unwrap_err()
                .class,
            FailureClass::Unsupported
        );
    }
}

#[test]
fn invalid_stage_results_cannot_be_forged_into_typed_code() {
    for source in [
        "const f = @staged.splice 1\nreturn {}\n",
        "const f = @staged.splice { .type = @staged.int; }\nreturn {}\n",
    ] {
        assert_eq!(
            PrototypeSession::default()
                .compile(source)
                .unwrap_err()
                .class,
            FailureClass::Source
        );
    }
}

#[test]
fn static_iteration_has_a_deterministic_work_limit() {
    let source =
        "const loop = @staged.static (@staged.iterate (100000, (fn x => x), 0))\nreturn {}\n";
    let mut s = PrototypeSession::with_limits(Limits {
        work: 1000,
        ..Limits::default()
    });
    assert_eq!(s.compile(source).unwrap_err().class, FailureClass::Limit);
}

#[test]
fn shared_static_record_values_are_not_expanded_during_runtime_emission() {
    let mut tree = "0".to_owned();
    for _ in 0..20 {
        tree = format!("double ({tree})");
    }
    let field = "tree".to_owned() + &".left".repeat(20);
    let source = format!(
        "const double = fn x => {{ .left = x; .right = x; }}\nconst tree = @staged.static ({tree})\nreturn {{ .run = fn (x: @staged.int) -> @staged.int => @staged.add (x, {field}); }}\n"
    );
    let a = compile(&source);
    assert!(a.wasm.len() < 10000);
    assert!(a.work.work_units < 20000, "{:?}", a.work);
}

#[test]
fn retained_storage_is_bounded_and_reset_releases_query_state() {
    let mut s = PrototypeSession::with_limits(Limits {
        retained_storage_bytes: 1,
        ..Limits::default()
    });
    assert_eq!(s.compile(DEMO).unwrap_err().class, FailureClass::Limit);
    let mut s = PrototypeSession::default();
    s.compile(DEMO).unwrap();
    assert!(!s.definitions.is_empty());
    s.reset();
    assert_eq!(s.types.nodes.len(), 6);
    assert!(s.terms.nodes.is_empty());
    assert!(s.values.nodes.is_empty());
    assert!(s.definitions.is_empty());
    assert!(s.static_cache.is_empty());
    assert!(s.fragments.is_empty());
    assert!(s.symbols.is_empty());
}

#[test]
fn nominally_distinct_generated_types_cannot_be_unified() {
    let source = "const A = @staged.static (@staged.fresh ())\nconst B = @staged.static (@staged.fresh ())\nconst impossible = fn (x: A) -> B => x\nreturn {}\n";
    assert_eq!(
        PrototypeSession::default()
            .compile(source)
            .unwrap_err()
            .class,
        FailureClass::Source
    );
}

#[test]
fn many_generic_callers_reuse_one_body_and_one_local_edit_rechecks_one_definition() {
    let mut source = "const id = fn x => x\n".to_owned();
    for i in 0..128 {
        source.push_str(&format!("const f{i} = fn x => id (@staged.add (x, {i}))\n"));
    }
    source.push_str("return {\n");
    for i in 0..128 {
        source.push_str(&format!(".f{i} = f{i};\n"));
    }
    source.push_str("}\n");
    let mut s = PrototypeSession::default();
    let first = s.compile(&source).unwrap();
    assert_eq!(first.work.checked_definitions, 129);
    // 128 caller bodies, one shared polymorphic id body, one add primitive.
    assert_eq!(first.work.emitted_functions, 130);
    assert_eq!(first.work.static_calls, 0);
    let edited = source.replace("(x, 64)", "(x, 999)");
    let second = s.compile(&edited).unwrap();
    assert_eq!(second.work.checked_definitions, 1);
    assert_eq!(second.work.reused_definitions, 128);
    assert_eq!(second.work.emitted_functions, 1);
    assert_eq!(second.work.reused_functions, 129);
    assert_eq!(second.work.static_calls, 0);
    wasmparser::Validator::new()
        .validate_all(&second.wasm)
        .unwrap();
}

#[test]
fn transitive_static_dependencies_are_replayed_through_memo_hits() {
    let source = "const leaf = fn n => @staged.add (n, 1)\nconst mid = fn n => leaf n\nconst a = @staged.static (mid 2)\nconst b = @staged.static (mid 2)\nreturn {}\n";
    let mut s = PrototypeSession::default();
    let first = s.compile(source).unwrap();
    assert!(first.work.static_cache_hits >= 1);
    let second = s.compile(&source.replace("(n, 1)", "(n, 2)")).unwrap();
    // The dynamic middle wrapper keeps its interface; both static consumers
    // must nevertheless see the changed leaf implementation, even after a hit.
    assert_eq!(second.work.checked_definitions, 3);
    assert_eq!(second.work.reused_definitions, 1);
    assert!(second.work.static_calls > 0);
}

#[test]
fn frontend_failure_classification_and_spans_survive_the_research_boundary() {
    for (code, expected) in [
        ("BLOT_TYPE_ERROR", FailureClass::Source),
        ("BLOT_EVALUATION_LIMIT", FailureClass::Limit),
        ("BLOT_UNSUPPORTED_LOWERING", FailureClass::Unsupported),
        ("BLOT_RUST_INVARIANT", FailureClass::Invariant),
    ] {
        let d = crate::diagnostic::Diagnostic::new(code, "failure", Span { start: 7, end: 13 });
        let converted = Failure::from_diagnostic(&d);
        assert_eq!(converted.class, expected);
        assert_eq!(converted.site, Site { start: 7, end: 13 });
    }
}
