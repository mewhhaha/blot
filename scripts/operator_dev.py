"""Branch-only development patch driver; removed before publishing the draft."""
from pathlib import Path
import subprocess

BASE = "2816fbc82f0201614463fd64a5e99361beb6e961"


def original(path):
    return subprocess.check_output(["git", "show", f"{BASE}:{path}"], text=True)


def once(text, before, after):
    assert text.count(before) == 1, (before[:150], text.count(before))
    return text.replace(before, after, 1)


def between(text, start, end, replacement):
    assert text.count(start) == 1, (start, text.count(start))
    left = text.index(start)
    right = text.index(end, left)
    return text[:left] + replacement + text[right:]


t = original("compiler/src/typecheck.rs")
t = "mod operators;\n\n" + t
t = between(t,
    "                if member_arguments.len() == 2\n                    && let Expression::Field { target, name, .. } =",
    "                if member_arguments.len() == 2\n                    && let Ok(Value::Primitive { name, .. }) =",
    """                if let Some(inferred) = self.infer_source_member_application(
                    path, module, expression_id, member_callee, &member_arguments,
                    environment, values, dependencies, span,
                )? {
                    return Ok(inferred);
                }
""")
t = between(t,
    "                if member_arguments.len() > 1\n",
    "                if let Expression::Apply {\n                    function: projection,",
    "")
t = once(t,
    """        if let Some(closure) = self.active_closures.borrow().last() {
            self.deferred_predicate_closures
                .borrow_mut()
                .insert(closure.clone());
        }
""",
    """        // A curried body carries the requirement through every enclosing
        // source closure, not just its final parameter.
        self.deferred_predicate_closures.borrow_mut().extend(
            self.active_closures.borrow().iter().cloned(),
        );
""")
# Open bootstrap calls must not commit a polymorphic function to integers.
start = "        if !matches!(settled_left, Type::Bottom) && !matches!(settled_right, Type::Bottom) {"
end = "        match settled_left {\n            Type::Opaque(ref name) if name == \"F32x4\""
t = between(t, start, end, """        if matches!(settled_left, Type::Bottom | Type::Top | Type::Variable(_) | Type::Rigid(_))
            || matches!(settled_right, Type::Bottom | Type::Top | Type::Variable(_) | Type::Rigid(_))
        {
            self.defer_current_closure();
            return Ok(Inferred { type_: self.fresh(), effects });
        }

""")
Path("compiler/src/typecheck.rs").write_text(t)

p = original("src/prelude/prelude.blot")
p = once(p, "prefix 90 (-) = Int.negate", "prefix 90 (-) = Op.negate")
p = once(p,
    "    .rem = fn left => fn right => (@type.inferred left).rem left right;",
    "    .rem = fn left => fn right => (@type.inferred left).rem left right;\n    .negate = fn value => (@type.inferred value).negate value;")
Path("src/prelude/prelude.blot").write_text(p)

e = original("compiler/src/eval.rs")
e = between(e,
    "fn operator_type_with_members(value: Value) -> Value {",
    "fn recognition_argument_type(runtime: &Runtime, span: Span) -> Option<Value> {",
    """fn operator_type_with_members(value: Value) -> Value {
    let members = OPERATOR_MEMBER_NAMES
        .iter()
        .filter_map(|name| {
            let implementation = if *name == "negate" {
                let primitive = match &value {
                    Value::Range { domain: Some(ValueDomain::Int), .. } => "@int.neg",
                    Value::Range { domain: Some(ValueDomain::Float), .. } => "@float.neg",
                    Value::Range { domain: Some(ValueDomain::Float32), .. } => "@f32.neg",
                    _ => return None,
                };
                Value::Primitive {
                    name: primitive.to_owned(), arity: 1, applied: Vec::new(),
                }
            } else {
                Value::Primitive {
                    name: "@type.resolve_member".to_owned(), arity: 3,
                    applied: vec![Value::Text((*name).to_owned())],
                }
            };
            Some(((*name).to_owned(), implementation))
        })
        .collect();
    Value::Extended { inner: Box::new(value), members }
}

""")
Path("compiler/src/eval.rs").write_text(e)

s = original("compiler/src/session.rs")
s = once(s, "    fn source(value: &str) -> Vec<u16> {", r'''
    #[test]
    fn source_operator_regressions() {
        run_with_compiler_test_stack(|| {
            let cases = [
                ("generic-int-and-float", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const Int = @type.attach @type.int \"add\" @int.add\n",
                    "const Float = @type.attach @type.float \"add\" @float.add\n",
                    "const add = fn left => fn right => left + right\n",
                    "const integer = add 2 3\n",
                    "const float = add 2.0 3.0\n",
                    "return float\n",
                ), true),
                ("custom-result", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const answer :: @type.int -> @type.int -> @type.text\n",
                    "const answer = fn left => fn right => \"custom\"\n",
                    "const Int = @type.attach @type.int \"add\" answer\n",
                    "return 2 + 3\n",
                ), true),
                ("refined-result", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const Seven = @type.range 7 7\n",
                    "const answer :: @type.int -> @type.int -> Seven\n",
                    "const answer = fn left => fn right => 7\n",
                    "const Int = @type.attach @type.int \"add\" answer\n",
                    "let result :: Seven\n",
                    "let result = 2 + 3\n",
                    "return result\n",
                ), true),
                ("custom-argument-rejection", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const answer :: @type.int -> @type.text -> @type.text\n",
                    "const answer = fn left => fn right => right\n",
                    "const Int = @type.attach @type.int \"add\" answer\n",
                    "return 2 + 3\n",
                ), false),
                ("mixed-bound-values-rejected", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const Int = @type.attach @type.int \"add\" @int.add\n",
                    "const Float = @type.attach @type.float \"add\" @float.add\n",
                    "let integer = 2\n",
                    "let float = 3.0\n",
                    "return integer + float\n",
                ), false),
                ("generic-unary", concat!(
                    "const Op = { .negate = fn value => (@type.inferred value).negate value; }\n",
                    "const negate = fn value => -value\n",
                    "const integer = negate 2\n",
                    "const float = negate 2.0\n",
                    "return float\n",
                ), true),
            ];
            for (label, text, expected) in cases {
                let mut session = CompilerSession::default();
                session.add_source("main.blot".to_owned(), source(text)).expect(label);
                session.configure_module("main.blot", BTreeMap::new(), BTreeMap::new()).expect(label);
                let checked = session.check_module("main.blot");
                eprintln!("{label}: {checked}");
                assert_eq!(checked["ok"], expected, "{label}: {checked}");
                if expected {
                    let prepared = session.prepare_runtime_hir("main.blot");
                    assert_eq!(prepared["ok"], true, "{label}: {prepared}");
                }
            }
        });
    }

    fn source(value: &str) -> Vec<u16> {
''')
Path("compiler/src/session.rs").write_text(s)

for path, terms in {
    "compiler/src/typecheck.rs": ["fn expression_contains", "fn static_member", "fn bridge_closed_attached", "fn integer_intervals", "fn is_operator_member", "fn is_resolve_member"],
    "compiler/src/eval.rs": ["decorate_operator_type", "@type.resolve_member", "operator_type_key"],
    "compiler/src/primitives.rs": ["@int.add", "@type.range"],
    "compiler/src/hir.rs": ["@type.inferred", "@type.resolve_member"],
}.items():
    if Path(path).exists():
        for number, line in enumerate(Path(path).read_text().splitlines(), 1):
            if any(term in line for term in terms):
                print(f"{path}:{number}: {line.strip()}")
