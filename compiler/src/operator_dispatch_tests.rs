//! Regression coverage for source-defined inferred-type member dispatch.
use super::*;

const DISPATCH: &str = concat!(
    "infixl 60 (+) = Op.add\n",
    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
);

fn with_stack(test: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(test)
        .expect("operator regression thread should start")
        .join()
        .expect("operator regression should not panic");
}

fn session(text: &str) -> CompilerSession {
    let mut session = CompilerSession::default();
    session
        .add_source("main.blot".to_owned(), text.encode_utf16().collect())
        .expect("operator fixture should parse");
    session
        .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
        .expect("operator fixture should configure");
    session
}

fn with_prelude(text: &str) -> CompilerSession {
    let mut session = session(text);
    session
        .add_source(
            "prelude.blot".to_owned(),
            include_str!("../../src/prelude/prelude.blot")
                .encode_utf16()
                .collect(),
        )
        .expect("prelude should parse");
    session
        .configure_module("prelude.blot", BTreeMap::new(), BTreeMap::new())
        .expect("prelude should configure");
    session
        .configure_module(
            "main.blot",
            BTreeMap::from([("blot:prelude".to_owned(), "prelude.blot".to_owned())]),
            BTreeMap::new(),
        )
        .expect("prelude import should configure");
    session
}

fn assert_result(session: &mut CompilerSession, type_: &str, display: &str) {
    let checked = session.check_module("main.blot");
    assert_eq!(checked["ok"], true, "{checked}");
    assert_eq!(checked["type"], type_, "{checked}");
    let evaluated = session.evaluate_module("main.blot");
    assert_eq!(evaluated["ok"], true, "{evaluated}");
    assert_eq!(evaluated["display"], display, "{evaluated}");
}

#[test]
fn source_member_result_is_not_replaced_by_operator_spelling() {
    with_stack(|| {
        let mut compiler = session(&format!(
            "{DISPATCH}const Int = @type.attach @type.int \"add\" (fn left => fn right => \"custom\")\nreturn 1 + 2\n"
        ));
        assert_result(&mut compiler, "\"custom\"", "\"custom\"");
    });
}

#[test]
fn source_member_refined_result_survives_dispatch() {
    with_stack(|| {
        let mut compiler = session(&format!(
            "{DISPATCH}const custom :: @type.int -> @type.int -> 7\nconst custom = fn left => fn right => 7\nconst Int = @type.attach @type.int \"add\" custom\nreturn 1 + 2\n"
        ));
        assert_result(&mut compiler, "7", "7");
    });
}

#[test]
fn source_member_parameter_signature_is_checked_even_when_body_ignores_it() {
    with_stack(|| {
        let compiler = session(&format!(
            "{DISPATCH}const custom :: @type.text -> @type.text -> 7\nconst custom = fn left => fn right => 7\nconst Int = @type.attach @type.int \"add\" custom\nreturn 1 + 2\n"
        ));
        let checked = compiler.check_module("main.blot");
        assert_eq!(checked["ok"], false, "{checked}");
        assert_eq!(
            checked["diagnostic"]["code"], "BLOT_TYPE_ERROR",
            "{checked}"
        );
    });
}

#[test]
fn partially_applied_primitive_member_retains_its_arguments() {
    with_stack(|| {
        let mut compiler = session(&format!(
            "{DISPATCH}const Int = @type.attach @type.int \"add\" (@text.slice \"abcd\")\nreturn 0 + 2\n"
        ));
        assert_result(&mut compiler, "Text", "\"ab\"");
    });
}

#[test]
fn one_inferred_operator_function_is_reusable_across_numeric_domains() {
    with_stack(|| {
        let compiler = with_prelude(concat!(
            "open import \"blot:prelude\"\n",
            "const sum = fn left => fn right => left + right\n",
            "let integer :: Int\nlet integer = sum 2 3\n",
            "let double :: F64\nlet double = sum (F64.of_int 2) (F64.of_int 3)\n",
            "let single :: F32\nlet single = sum (F32.of_int 2) (F32.of_int 3)\n",
            "return { .integer = integer; .double = double; .single = single; }\n",
        ));
        let checked = compiler.check_module("main.blot");
        assert_eq!(checked["ok"], true, "{checked}");
        let evaluated = compiler.evaluate_module("main.blot");
        assert_eq!(evaluated["ok"], true, "{evaluated}");
        let prepared = compiler.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
}

#[test]
fn prefix_negation_uses_the_selected_numeric_member() {
    with_stack(|| {
        for (source, type_, display) in [
            ("return -(F64.of_int 2)\n", "F64", "-2"),
            ("return -(F32.of_int 2)\n", "F32", "-2f32"),
        ] {
            let mut compiler = with_prelude(&format!("open import \"blot:prelude\"\n{source}"));
            assert_result(&mut compiler, type_, display);
        }
    });
}

#[test]
fn generic_dispatch_keeps_call_site_domains_without_prelude() {
    with_stack(|| {
        let mut compiler = session(&format!(
            "{DISPATCH}const sum = fn left => fn right => left + right\nreturn (sum 2 3, sum (@float.of_int 2) (@float.of_int 3), sum (@f32.of_int 2) (@f32.of_int 3))\n"
        ));
        assert_result(
            &mut compiler,
            "{ .0 = Int; .1 = F64; .2 = F32 }",
            "(5, 5, 5f32)",
        );
        let prepared = compiler.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
}

#[test]
fn generic_dispatch_rejects_unsupported_operands_even_with_unused_result() {
    with_stack(|| {
        for call in ["sum () ()", "sum integer (@float.of_int 3)"] {
            let compiler = session(&format!(
                "{DISPATCH}const sum = fn left => fn right => left + right\nlet integer :: @type.int\nlet integer = 2\nlet unused = {call}\nreturn ()\n"
            ));
            let checked = compiler.check_module("main.blot");
            assert_eq!(checked["ok"], false, "{call}: {checked}");
        }
    });
}

#[test]
fn generic_attached_members_select_each_call_site_domain() {
    with_stack(|| {
        let mut compiler = session(&format!(
            "{DISPATCH}const Int = @type.attach @type.int \"add\" @int.add\nconst F64 = @type.attach @type.float \"add\" @float.add\nconst F32 = @type.attach @type.float32 \"add\" @f32.add\nconst sum = fn left => fn right => left + right\nreturn (sum 2 3, sum (@float.of_int 2) (@float.of_int 3), sum (@f32.of_int 2) (@f32.of_int 3))\n"
        ));
        assert_result(
            &mut compiler,
            "{ .0 = Int; .1 = F64; .2 = F32 }",
            "(5, 5, 5f32)",
        );
        let prepared = compiler.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
}

#[test]
fn imported_dispatcher_does_not_reuse_an_earlier_specialization() {
    with_stack(|| {
        let mut compiler = session(concat!(
            "open import \"operators\"\n",
            "const sum = fn left => fn right => left + right\n",
            "let integer :: @type.int\nlet integer = sum 2 3\n",
            "let double :: @type.float\nlet double = sum (@float.of_int 2) (@float.of_int 3)\n",
            "let single :: @type.float32\nlet single = sum (@f32.of_int 2) (@f32.of_int 3)\n",
            "return (integer, double, single)\n",
        ));
        compiler.add_source("operators.blot".to_owned(), format!(
            "{DISPATCH}const Int = @type.attach @type.int \"add\" @int.add\nconst F64 = @type.attach @type.float \"add\" @float.add\nconst F32 = @type.attach @type.float32 \"add\" @f32.add\nconst warmup = Op.add 1 1\nreturn {{ .Op = Op; .Int = Int; .F64 = F64; .F32 = F32; .warmup = warmup; }}\n"
        ).encode_utf16().collect()).unwrap();
        compiler
            .configure_module("operators.blot", BTreeMap::new(), BTreeMap::new())
            .unwrap();
        compiler
            .configure_module(
                "main.blot",
                BTreeMap::from([("operators".to_owned(), "operators.blot".to_owned())]),
                BTreeMap::new(),
            )
            .unwrap();
        assert_result(
            &mut compiler,
            "{ .0 = Int; .1 = F64; .2 = F32 }",
            "(5, 5, 5f32)",
        );
        let prepared = compiler.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
}

#[test]
fn inferred_members_are_not_limited_to_standard_operator_names() {
    with_stack(|| {
        let mut compiler = session(concat!(
            "infixl 60 (+) = Op.combine\n",
            "const Op = { .combine = fn left => fn right => (@type.inferred left).combine left right; }\n",
            "const custom :: @type.int -> @type.int -> 7\n",
            "const custom = fn left => fn right => 7\n",
            "const Int = @type.attach @type.int \"combine\" custom\n",
            "return 1 + 2\n",
        ));
        assert_result(&mut compiler, "7", "7");
        let prepared = compiler.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
}
