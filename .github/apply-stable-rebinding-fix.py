from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one replacement in {path}, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "compiler/src/typecheck.rs",
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred_type = stable_rebinding_type(inferred.type_.clone());
                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                self.constrain(previous.clone(), inferred_type, span)?;
""",
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred_type = stable_rebinding_type(inferred.type_.clone());
                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                let inferred_type = stable_variant_rebinding_type(inferred_type, &previous);
                self.constrain(previous.clone(), inferred_type, span)?;
""",
)

replace_once(
    "compiler/src/typecheck.rs",
    """fn stable_rebinding_type(type_: Type) -> Type {
    match type_ {
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(low)),
            high: Some(Scalar::Int(high)),
        } if low == high => int_type(),
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(low)),
            high: Some(Scalar::Text(high)),
        } if low == high => text_type(),
        type_ => type_,
    }
}
""",
    """fn stable_rebinding_type(type_: Type) -> Type {
    match type_ {
        Type::Range {
            domain: Domain::Int,
            low: Some(Scalar::Int(low)),
            high: Some(Scalar::Int(high)),
        } if low == high => int_type(),
        Type::Range {
            domain: Domain::Text,
            low: Some(Scalar::Text(low)),
            high: Some(Scalar::Text(high)),
        } if low == high => text_type(),
        type_ => type_,
    }
}

fn stable_variant_rebinding_type(replacement: Type, previous: &Type) -> Type {
    let (
        Type::Variant {
            cases: replacement_cases,
            open: false,
        },
        Type::Variant {
            cases: previous_cases,
            open: false,
        },
    ) = (&replacement, previous)
    else {
        return replacement;
    };
    let distinct_previous = previous_cases
        .iter()
        .map(|(name, _)| name)
        .collect::<BTreeSet<_>>();
    if distinct_previous.len() < 2
        || replacement_cases
            .iter()
            .any(|(name, _)| previous_cases.get(name).is_none())
    {
        return replacement;
    }
    previous.clone()
}
""",
)

replace_once(
    "LANGUAGE.md",
    """The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. The previous polymorphic scheme is
retained. Use another `let` or `const` to shadow a name with a different type.
""",
    """The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. A replacement whose constructors
are a subset of an existing closed multi-constructor variant is first checked
against that variant, then widened back to the existing stable type. Thus
rebinding a `#True | #False` value with `#True` preserves the Boolean type. The
previous polymorphic scheme is retained. Use another `let` or `const` to shadow a
name with a different type.
""",
)

replace_once(
    "docs/inference.md",
    """`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name, but the old and new types must flow into one another. Singleton
integer and text literals widen to their domains at that boundary, so
`value := value + 1` preserves `Int`; changing an integer binding to text
requires another `let value = ...`. The existing binding's scheme is retained,
so rebinding a polymorphic function does not accidentally make it monomorphic.
""",
    """`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name, but the old and new stable types must agree. A constructor subset
of an existing closed variant is checked against that variant and then widened
to it, so assigning `#True` to a `Bool` binding preserves `#True | #False`.
Singleton integer and text literals likewise widen to their domains at that
boundary, so `value := value + 1` preserves `Int`; changing an integer binding
to text requires another `let value = ...`. The existing binding's scheme is
retained, so rebinding a polymorphic function does not accidentally make it
monomorphic.
""",
)

replace_once(
    "compiler/src/session.rs",
    """    fn source(value: &str) -> Vec<u16> {
""",
    r'''    #[test]
    fn stable_rebinding_preserves_a_declared_variant_inside_a_loop() {
        run_with_compiler_test_stack(|| {
            let prelude_snapshot = snapshot_from_source(
                "prelude.blot",
                include_str!("../../src/prelude/prelude.blot"),
            );
            let mut session = CompilerSession::default();
            session
                .install_trusted_module_snapshot("prelude.blot", &prelude_snapshot)
                .expect("prelude snapshot should install");
            session
                .add_source(
                    "main.blot".to_owned(),
                    source(concat!(
                        "open import \"blot:prelude\"\n",
                        "\n",
                        "let flag :: Bool\n",
                        "let flag = #False\n",
                        "\n",
                        "for _ in Iter.items [()]:\n",
                        "  flag := #True\n",
                        "\n",
                        "return flag\n",
                    )),
                )
                .expect("stable variant rebinding source should load");
            session
                .configure_module(
                    "main.blot",
                    BTreeMap::from([("blot:prelude".to_owned(), "prelude.blot".to_owned())]),
                    BTreeMap::new(),
                )
                .expect("stable variant rebinding source should configure");

            let checked = session.check_module("main.blot");
            let prepared = session.prepare_runtime_hir("main.blot");

            assert_eq!(checked["ok"], true, "{checked}");
            assert_eq!(checked["type"], "#True | #False", "{checked}");
            assert_eq!(prepared["ok"], true, "{prepared}");
        });
    }

    fn source(value: &str) -> Vec<u16> {
''',
)
