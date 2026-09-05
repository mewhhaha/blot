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
        let mut compiler = session(&format!(
            "{DISPATCH}const custom :: @type.text -> @type.text -> 7\nconst custom = fn left => fn right => 7\nconst Int = @type.attach @type.int \"add\" custom\nreturn 1 + 2\n"
        ));
        let checked = compiler.check_module("main.blot");
        assert_eq!(checked["ok"], false, "{checked}");
        assert_eq!(checked["diagnostic"]["code"], "BLOT_TYPE_ERROR", "{checked}");
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
        let mut compiler = with_prelude(concat!(
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
