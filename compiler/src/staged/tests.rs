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

#[test]
fn recursive_functions_are_checked_once_and_static_recursion_executes_typed_core() {
    let source = format!(
        "{PRE}const rec factorial = fn n => do:\n  if @staged.lt (n, 2):\n    return 1\n  else:\n    return @staged.mul (n, factorial (@staged.sub (n, 1)))\nconst value = @staged.static (factorial 8)\nreturn {{ .run = fn (x: Int) -> Int => @staged.add (x, value); }}\n"
    );
    let mut session = PrototypeSession::default();
    let artifact = session.compile(&source).unwrap();
    assert_eq!(artifact.interfaces["factorial"], "(Int64 -> Int64)");
    assert!(session.values.nodes.contains(&Value::Int(40320)));
    let edited = session
        .compile(&source.replace("factorial 8", "factorial 7"))
        .unwrap();
    assert_eq!(edited.work.checked_definitions, 1);
    assert!(edited.work.static_cache_hits > 0);
    assert_ne!(artifact.wasm, edited.wasm);
}

#[test]
fn recursive_static_divergence_is_a_limit_and_does_not_cache_failure() {
    let source = "const rec forever = fn x => forever x\nconst result = @staged.static (forever 0)\nreturn {}\n";
    let mut session = PrototypeSession::default();
    let failure = session.compile(source).unwrap_err();
    assert_eq!(failure.class, FailureClass::Limit);
    assert!(session.static_cache.is_empty());
    assert_eq!(
        failure,
        PrototypeSession::default().compile(source).unwrap_err()
    );
    assert!(session.compile("return {}\n").is_ok());
}

#[test]
fn recursive_static_calls_observe_transitive_implementation_edits() {
    let source = format!(
        "{PRE}const step = fn x => @staged.add (x, 1)\nconst rec f = fn n => do:\n  if @staged.lt (n, 1):\n    return 0\n  else:\n    return step (f (@staged.sub (n, 1)))\nconst value = @staged.static (f 6)\nreturn {{ .run = fn (x: Int) -> Int => @staged.add (x, value); }}\n"
    );
    let mut session = PrototypeSession::default();
    let before = session.compile(&source).unwrap();
    let source = source.replace("(x, 1)", "(x, 2)");
    let after = session.compile(&source).unwrap();
    assert_eq!(after.work.checked_definitions, 2);
    assert_ne!(before.wasm, after.wasm);
    assert!(session.values.nodes.contains(&Value::Int(12)));
}

#[test]
fn immutable_array_fold_and_variant_cases_work_in_both_phases() {
    let source = format!(
        "{PRE}const values = @staged.static [#Some 2, #None, #Some 4]\nconst step = fn (sum, value) => case value of\n  #Some x => @staged.add (sum, x)\n  #None => sum\nconst total = @staged.static (@staged.array_fold (values, step, 0))\nreturn {{ .run = fn (x: Int) -> Int => @staged.array_fold ([#Some x, #None], step, total); }}\n"
    );
    let mut session = PrototypeSession::default();
    let artifact = session.compile(&source).unwrap();
    assert!(session.values.nodes.contains(&Value::Int(6)));
    assert!(artifact.interfaces["values"].contains("Variant"));
    assert_eq!(artifact.interfaces["total"], "Int64");
}

#[test]
fn variants_enforce_payload_arity_and_exhaustiveness_without_dropping_unknown_cases() {
    for source in [
        "const f = fn x => case x of\n  #Some n => n\nconst bad = f #None\nreturn {}\n",
        "const f = fn x => case x of\n  #Some => 1\nconst bad = f (#Some ())\nreturn {}\n",
        "const f = fn x => case x of\n  #Some a => a\n  #Some b => b\nreturn {}\n",
        "const f = fn x => case x of\n  _ => 0\n  #Some n => n\nreturn {}\n",
    ] {
        let err = PrototypeSession::default().compile(source).unwrap_err();
        assert_eq!(err.class, FailureClass::Source, "{err:?}");
    }
    compile(
        "const Int = @staged.int\nconst f = fn x => case x of\n  #Some n => n\n  _ => 0\nreturn { .run = fn (x: Int) -> Int => f (#Other x); }\n",
    );
}

#[test]
fn array_inference_is_homogeneous_and_empty_arrays_generalize() {
    compile(&format!(
        "{PRE}const empty = []\nconst a = @staged.array_push (empty, 3)\nconst b = @staged.array_push (empty, @staged.true)\nreturn {{ .run = fn (x: Int) -> Int => @staged.add (x, @staged.array_len b); }}\n"
    ));
    let err = PrototypeSession::default()
        .compile("const bad = [1, @staged.true]\nreturn {}\n")
        .unwrap_err();
    assert_eq!(err.class, FailureClass::Source);
    let a = compile("const n = @staged.static (@staged.array_at ([1, 2], -1))\nreturn {}\n");
    assert!(a.interfaces["n"].contains("None"));
}

#[test]
fn type_reflection_and_collection_processing_build_checked_schemas() {
    let source = format!(
        "{PRE}const A = @staged.static (@staged.record {{ .a = Int; .b = Int; }})\nconst convert = @staged.static (fn schema => @staged.record_fields (@staged.array_fold (@staged.fields schema, fn (fields, pair) => do:\n  let (name, T) = pair\n  return @staged.array_push (fields, (name, @staged.array_type T))\n, [])))\nconst B = @staged.static (convert A)\nconst get = @staged.splice (@staged.getter (B, \"a\"))\nreturn {{ .run = fn (x: Int) -> Int => @staged.array_len (get {{ .a = [x, 2]; .b = []; }}); }}\n"
    );
    // Destructured local bindings are not yet admitted. Use a tuple-pattern
    // callback to exercise the same field-processing operation.
    let source = source.replace("fn (fields, pair) => do:\n  let (name, T) = pair\n  return @staged.array_push (fields, (name, @staged.array_type T))\n", "fn (fields, (name, T)) => @staged.array_push (fields, (name, @staged.array_type T))");
    let mut session = PrototypeSession::default();
    let before = session.compile(&source).unwrap();
    assert!(before.interfaces["get"].contains("a: [Int64]"));
    let after = session
        .compile(&source.replace("[x, 2]", "[x, 2, 3]"))
        .unwrap();
    assert_eq!(after.work.static_calls, 0);
    assert_ne!(before.wasm, after.wasm);
}

#[test]
fn generated_schema_fields_reject_duplicates_and_wrong_inputs() {
    for source in [
        "const T = @staged.static (@staged.record_fields [(\"x\", @staged.int), (\"x\", @staged.bool)])\nreturn {}\n",
        "const T = @staged.static (@staged.fields @staged.int)\nreturn {}\n",
        "const T = @staged.static (@staged.record_fields [(\"x\", 1)])\nreturn {}\n",
    ] {
        let err = PrototypeSession::default().compile(source).unwrap_err();
        assert_eq!(err.class, FailureClass::Source);
    }
}

const GENERATED: &str = r#"const Int = @staged.int
const make = @staged.static (fn amount => @staged.code_lambda (Int, fn x => @staged.code_apply (
  @staged.quote (fn (a, b) => @staged.add (a, b)),
  @staged.code_tuple [x, @staged.code_lift amount]
)))
const add = @staged.splice (make 4)
return { .run = fn (x: Int) -> Int => add x; }
"#;

#[test]
fn generated_binders_allow_explicit_lifting_without_implicit_capture() {
    let mut session = PrototypeSession::default();
    let artifact = session.compile(GENERATED).unwrap();
    assert_eq!(artifact.interfaces["add"], "(Int64 -> Int64)");
    let edited = GENERATED.replace("make 4", "make 5");
    let after = session.compile(&edited).unwrap();
    assert_eq!(after.work.checked_definitions, 1);
    assert_ne!(artifact.wasm, after.wasm);
    assert!(after.work.reused_functions > 0);
}

#[test]
fn nested_generated_binders_are_distinct_and_outer_capture_remains_scoped() {
    let source = r#"const Int = @staged.int
const generated = @staged.splice (@staged.code_lambda (Int, fn x => @staged.code_lambda (Int, fn y => @staged.code_apply (
  @staged.quote (fn (a,b) => @staged.sub (a,b)), @staged.code_tuple [x,y]
))))
return { .run = fn (x: Int) -> Int => generated x 3; }
"#;
    let mut session = PrototypeSession::default();
    let a = session.compile(source).unwrap();
    assert_eq!(a.interfaces["generated"], "(Int64 -> (Int64 -> Int64))");
    assert_eq!(session.next_code_local, 2);
    let b = session.compile(source).unwrap();
    assert_eq!(b.work.static_calls, 0);
    assert_eq!(session.next_code_local, 2);
}

#[test]
fn typed_code_constructors_reject_mismatches_before_emission() {
    for source in [
        "const bad = @staged.splice (@staged.code_apply (@staged.code_lift 1, @staged.code_lift 2))\nreturn {}\n",
        "const bad = @staged.splice (@staged.code_if (@staged.code_lift 1, @staged.code_lift 2, @staged.code_lift 3))\nreturn {}\n",
        "const bad = @staged.splice (@staged.code_if (@staged.code_lift @staged.true, @staged.code_lift 2, @staged.code_lift @staged.false))\nreturn {}\n",
        "const bad = @staged.static (@staged.code_record [(\"a\", @staged.code_lift 1), (\"a\", @staged.code_lift 2)])\nreturn {}\n",
        "const bad = @staged.static (@staged.code_lift @staged.int)\nreturn {}\n",
        "const bad = @staged.static (@staged.code_field (@staged.code_lift { .a = 1; }, \"b\"))\nreturn {}\n",
    ] {
        let e = PrototypeSession::default().compile(source).unwrap_err();
        assert_eq!(e.class, FailureClass::Source, "{e:?}");
    }
}

#[test]
fn escaped_generated_code_locals_cannot_cross_the_splice_bridge() {
    let mut session = PrototypeSession::default();
    let term = session.terms.intern(core::Node::Local(1 << 31), types::INT);
    let value = session.values.intern(Value::Code(term));
    let value_term = session
        .terms
        .intern(core::Node::Constant(value), types::CODE);
    let symbol = session.symbol("escape", 0);
    let source = "return { .run = @staged.splice escape; }\n";
    let units = source.encode_utf16().collect::<Vec<_>>();
    let module = crate::source::lower_incremental(&units, None, None)
        .unwrap()
        .module;
    let Expression::Shape { ref members, .. } = module.arena.expressions[module.result.0 as usize]
    else {
        panic!()
    };
    let crate::ast::ShapeMember::Field { value, .. } = members[0] else {
        panic!()
    };
    let result = check::definition(
        &mut session,
        check::Input {
            module: &module,
            names: &BTreeMap::from([("escape".into(), symbol)]),
            globals: &BTreeMap::from([(
                symbol,
                Global {
                    term: value_term,
                    ty: types::CODE,
                },
            )]),
            expression: value,
            annotation: None,
            binding_name: None,
        },
        &Budget::new(&Limits::default()),
        &mut Work::default(),
    );
    let e = result.unwrap_err();
    assert_eq!(e.class, FailureClass::Source);
    assert!(e.message.contains("escaping"));
}

#[test]
fn typeof_waits_for_inference_without_executing_the_runtime_subject() {
    let source = r#"const Int = @staged.int
const rec diverge = fn n => diverge n
const f = fn x => do:
  let T = @staged.typeof (diverge x)
  let value = @staged.static 3
  return @staged.add (value, x)
return { .run = fn (x: Int) -> Int => f x; }
"#;
    // A diverging function's result is unconstrained here, so its result type
    // cannot be manufactured from the later constraint on its argument.
    assert!(
        PrototypeSession::default()
            .compile(source)
            .unwrap_err()
            .message
            .contains("blocked")
    );
    let source = source.replace(
        "@staged.typeof (diverge x)",
        "@staged.typeof (@staged.add (diverge x, 0))",
    );
    let artifact = compile(&source);
    assert_eq!(artifact.work.static_calls, 0);
    assert_eq!(
        artifact.work.static_obligations,
        artifact.work.resolved_static_obligations
    );
}

#[test]
fn a_late_annotation_wakes_a_typeof_and_its_static_consumer_once() {
    let source = r#"const Int = @staged.int
const f: Int -> Bool
const f = fn x => @staged.static (@staged.type_equal (@staged.typeof x, Int))
const Bool = @staged.bool
return {}
"#;
    // Bind Bool before the signature; there are no implicit prelude bindings.
    let source = source
        .replace("const Int = @staged.int\n", PRE)
        .replace("\nconst Bool = @staged.bool\nreturn", "\nreturn");
    let mut session = PrototypeSession::default();
    let a = session.compile(&source).unwrap();
    assert_eq!(a.interfaces["f"], "(Int64 -> Bool)");
    assert!(a.work.static_obligation_wakeups >= 1);
    assert_eq!(
        a.work.static_obligations,
        a.work.resolved_static_obligations
    );
    assert!(session.values.nodes.contains(&Value::Bool(true)));
    let b = session
        .compile(&source.replace("f: Int -> Bool", "f: Bool -> Bool"))
        .unwrap();
    assert!(session.values.nodes.contains(&Value::Bool(false)));
    assert_eq!(b.work.checked_definitions, 1);
}

#[test]
fn unresolved_static_obligations_require_evidence_instead_of_inverting_type_programs() {
    let bad = "const f = fn x => @staged.typeof x\nreturn {}\n";
    let mut session = PrototypeSession::default();
    let failure = session.compile(bad).unwrap_err();
    assert_eq!(failure.class, FailureClass::Source);
    assert!(failure.message.contains("blocked"));
    let fixed = "const Int = @staged.int\nconst f = fn x => @staged.static (@staged.type_equal (@staged.typeof x, Int))\nconst g = fn (x: Int) -> Int => @staged.add (x, 1)\nreturn {}\n";
    // An unrelated annotation must not solve f's own unknown argument.
    assert!(
        session
            .compile(fixed)
            .unwrap_err()
            .message
            .contains("blocked")
    );
    assert!(session.compile("return {}\n").is_ok());
}

#[test]
fn a_local_pending_result_is_not_generalized_away_from_its_obligation() {
    let bad = "const f = fn x => do:\n  let a = @staged.static 1\n  let b = @staged.add (a, 1)\n  if a:\n    return b\n  else:\n    return 0\nreturn {}\n";
    let failure = PrototypeSession::default().compile(bad).unwrap_err();
    assert_eq!(failure.class, FailureClass::Source);
}

#[test]
fn local_type_aliases_share_pending_holes_and_do_not_lose_their_evidence() {
    let source = r#"const Int = @staged.int
const f: Int -> Int
const f = fn x => do:
  let T = @staged.typeof x
  let y: T = x
  return @staged.add (y, 3)
return { .run = f; }
"#;
    let a = compile(source);
    assert_eq!(a.interfaces["f"], "(Int64 -> Int64)");
    assert_eq!(
        a.work.static_obligations,
        a.work.resolved_static_obligations
    );
    let bad = source.replace("let y: T = x", "let y: T = @staged.true");
    assert_eq!(
        PrototypeSession::default().compile(&bad).unwrap_err().class,
        FailureClass::Source
    );
}

#[test]
fn generated_code_uses_current_global_implementations_after_relocation() {
    let source = r#"const Int = @staged.int
const value = 2
const generated = @staged.splice (@staged.code_lambda (Int, fn x => @staged.code_apply (
  @staged.quote (fn a => @staged.add (a, value)), x
)))
return { .run = fn (x: Int) -> Int => generated x; }
"#;
    let mut session = PrototypeSession::default();
    let before = session.compile(source).unwrap();
    let changed = source.replace("const value = 2", "const inserted = 19\nconst value = 4");
    let after = session.compile(&changed).unwrap();
    let fresh = compile(&changed);
    // Within-session compact IDs may differ, so output equivalence is also
    // exercised by verify.mjs; the key work promise is no generator replay.
    assert_ne!(before.wasm, after.wasm);
    assert_eq!(after.interfaces, fresh.interfaces);
    assert_eq!(after.work.static_calls, 0);
    assert!(after.work.reused_functions > 0);
}

#[test]
fn recursive_bindings_remain_monomorphic_within_their_own_body() {
    let bad = "const rec f = fn x => f [x]\nreturn {}\n";
    assert_eq!(
        PrototypeSession::default().compile(bad).unwrap_err().class,
        FailureClass::Source
    );
    let source = format!(
        "{PRE}const rec f = fn (n, x) => do:\n  if @staged.lt (n, 1):\n    return x\n  else:\n    return f (@staged.sub (n, 1), x)\nconst a = f (2, 7)\nconst b = f (3, @staged.true)\nreturn {{ .run = fn (x: Int) -> Int => @staged.add (x, a); }}\n"
    );
    compile(&source);
}

#[test]
fn static_tail_calls_do_not_spend_depth_per_iteration_or_cache_fresh_identities() {
    let source = r#"const Int = @staged.int
const rec count = fn (n, sum) => do:
  if @staged.lt (n, 1):
    return sum
  else:
    return count (@staged.sub (n, 1), @staged.add (sum, n))
const answer = @staged.static (count (10000, 0))
return { .run = fn (x: Int) -> Int => @staged.add (x, answer); }
"#;
    let mut session = PrototypeSession::default();
    let a = session.compile(source).unwrap();
    assert!(a.work.static_tail_calls >= 10000);
    assert!(session.values.nodes.contains(&Value::Int(50005000)));
    let source = "const fresh = @staged.static (do:\n  const rec f = fn n => do:\n    if @staged.lt (n, 1):\n      return @staged.fresh ()\n    else:\n      return f (@staged.sub (n, 1))\n  return f\n)\nconst A = @staged.static (fresh 10)\nconst B = @staged.static (fresh 10)\nreturn {}\n";
    let a = compile(source);
    assert_eq!(a.work.fresh_identities, 2);
}

#[test]
fn wildcard_only_cases_do_not_require_variant_subjects() {
    compile(
        "const Int = @staged.int\nconst f = fn x => case x of\n  y => @staged.add (y, 1)\nreturn { .run = fn (x: Int) -> Int => f x; }\n",
    );
}

#[test]
fn blocked_queries_only_wake_for_changed_dependencies_not_every_local_binding() {
    let mut baseline_wakeups = None;
    for count in [0, 40] {
        let mut source = String::from(
            "const Int = @staged.int\nconst f: Int -> Int\nconst f = fn x => do:\n  let T = @staged.typeof x\n",
        );
        for i in 0..count {
            source.push_str(&format!("  let unused{i} = @staged.static {i}\n"));
        }
        source.push_str("  let y: T = x\n  return @staged.add (y, 2)\nreturn { .run = f; }\n");
        let a = compile(&source);
        assert_eq!(
            a.work.static_obligations,
            a.work.resolved_static_obligations
        );
        if let Some(wakeups) = baseline_wakeups {
            assert_eq!(a.work.static_obligation_wakeups, wakeups);
        } else {
            baseline_wakeups = Some(a.work.static_obligation_wakeups);
        }
        // One initial attempt plus only explicit dependency-driven wakeups.
        assert_eq!(
            a.work.static_obligation_attempts,
            a.work.static_obligations + a.work.static_obligation_wakeups
        );
    }
}

#[test]
fn baba_syntax_reuse_does_not_reuse_changed_literal_meaning() {
    let mut session = PrototypeSession::default();
    let first = session.compile(DEMO).unwrap();
    assert!(first.work.frontend_parser_executed);
    let changed = DEMO.replace("makeAdder 10", "makeAdder 20");
    let edited = session.compile(&changed).unwrap();
    assert!(!edited.work.frontend_parser_executed);
    assert!(edited.work.frontend_reused_nodes > 0);
    assert_eq!(edited.work.checked_definitions, 1);
    assert_ne!(first.wasm, edited.wasm);
    assert_eq!(edited.wasm, compile(&changed).wasm);
    assert!(edited.work.frontend_storage_bytes > 0);
    assert!(edited.work.charged_storage_bytes >= edited.work.frontend_storage_bytes);
    session.reset();
    assert!(session.frontend.is_none());
    assert!(
        session
            .compile(&changed)
            .unwrap()
            .work
            .frontend_parser_executed
    );
}

#[test]
fn failed_frontend_and_type_edits_preserve_fresh_agreement_after_recovery() {
    let mut session = PrototypeSession::default();
    session.compile(DEMO).unwrap();
    let before = session.frontend.as_ref().unwrap() as *const _;
    for bad in [
        DEMO.replace("makeAdder 10", "makeAdder )"),
        DEMO.replace("makeAdder 10", "makeAdder ()"),
    ] {
        let error = session.compile(&bad).unwrap_err();
        assert_eq!(
            error,
            PrototypeSession::default().compile(&bad).unwrap_err()
        );
        assert_eq!(before, session.frontend.as_ref().unwrap() as *const _);
    }
    let changed = format!(
        "const inserted = 7\n{}",
        DEMO.replace("makeAdder 10", "makeAdder 101")
    );
    assert_eq!(
        session.compile(&changed).unwrap().wasm,
        compile(&changed).wasm
    );
}

#[test]
fn optional_phase_observation_does_not_change_compilation_or_failure() {
    let mut phases = Vec::new();
    let observed = PrototypeSession::default()
        .compile_observed(DEMO, |p| phases.push(p))
        .unwrap();
    let ordinary = compile(DEMO);
    assert_eq!(observed.wasm, ordinary.wasm);
    assert_eq!(observed.interfaces, ordinary.interfaces);
    assert_eq!(
        phases,
        [
            "frontend",
            "checking-and-staging",
            "lowering-emission-validation",
            "retention-accounting"
        ]
    );
    let bad = "const bad = @staged.splice 1\nreturn {}\n";
    assert_eq!(
        PrototypeSession::default()
            .compile_observed(bad, |_| {})
            .unwrap_err(),
        PrototypeSession::default().compile(bad).unwrap_err()
    );
}
