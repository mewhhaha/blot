from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"replacement anchor missing in {path}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


def insert_before(path: str, anchor: str, addition: str) -> None:
    file = Path(path)
    text = file.read_text()
    if anchor not in text:
        raise SystemExit(f"insert anchor missing in {path}: {anchor!r}")
    file.write_text(text.replace(anchor, addition + anchor, 1))


# Refutable for-binders no longer mean an implicit filter.
replace_once(
    "src/syntax/lower.ts",
    '''  // An irrefutable binder is a `let`. A refutable one — `#Some x in src` — is
  // a `case` whose other arm hands the accumulator back untouched, so an
  // element that does not match skips the iteration instead of failing it.
  // That is the filter, and it costs one arm.
  const filtering = binder !== null && refutable(binder);
  if (binder !== null && !filtering) {
    declarations.push({
      tag: "binding",
      kind: "let",
      tags: [],
      pattern: binder,
      value: element,
      span,
    });
  }
  if (body.tag === "plain") declarations.push(...body.declarations);

  let stepResult = state;
  if (body.tag === "control") stepResult = body.outcome;
  const step: Expr = {
    tag: "block",
    declarations,
    result: stepResult,
    resultEffects: "ambient",
    span,
  };
  let skipped: Expr = { tag: "unit", span };
  if (body.tag === "control") {
    skipped = controlOutcome(
      body.constructors.continue,
      name(carriedIn),
      span,
    );
  }
  if (body.tag === "plain") skipped = name(carriedIn);
  const visited: Expr = filtering && binder !== null
    ? {
      tag: "case",
      target: element,
      arms: [
        { pattern: binder, body: step },
        {
          pattern: { tag: "wildcard", span },
          body: skipped,
        },
      ],
      span,
    }
    : step;
''',
    '''  if (binder !== null && refutable(binder)) {
    fail(
      "BLOT_REFUTABLE_FOR_BINDER",
      "A `for` binder must match every element. Bind one name and use `if let` in the body when non-matches should be skipped.",
      binder.span,
    );
  }
  if (binder !== null) {
    declarations.push({
      tag: "binding",
      kind: "let",
      tags: [],
      pattern: binder,
      value: element,
      span,
    });
  }
  if (body.tag === "plain") declarations.push(...body.declarations);

  let stepResult = state;
  if (body.tag === "control") stepResult = body.outcome;
  const step: Expr = {
    tag: "block",
    declarations,
    result: stepResult,
    resultEffects: "ambient",
    span,
  };
  const visited: Expr = step;
''',
)

replace_once(
    "compiler/src/lower.rs",
    '''    let filtering = match binder {
        Some(pattern) => refutable(pattern, arena),
        None => false,
    };
    if let Some(pattern) = binder
        && !filtering
    {
        declarations.push(arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Let,
            tags: Vec::new(),
            pattern,
            value: element,
            span,
        }));
    }
    if let LoopBody::Plain {
        declarations: body_declarations,
        ..
    } = &body
    {
        declarations.extend(body_declarations.iter().copied());
    }
    let step_result = match &body {
        LoopBody::Plain { .. } => state,
        LoopBody::Control(body) => body.outcome,
    };
    let step = arena.expression(Expression::Block {
        declarations,
        result: step_result,
        result_effects: ResultEffects::Ambient,
        span,
    });
    let visited = if filtering {
        let pattern = binder.expect("filtering loop omitted its binder");
        let wildcard = arena.pattern(Pattern::Wildcard { span });
        let carried_value = variable(carried_in, span, arena);
        let skipped = match &body {
            LoopBody::Plain { .. } => carried_value,
            LoopBody::Control(body) => control_outcome(
                &body.constructors.continue_constructor,
                carried_value,
                span,
                arena,
            ),
        };
        arena.expression(Expression::Case {
            target: element,
            arms: vec![
                Arm {
                    pattern,
                    body: step,
                },
                Arm {
                    pattern: wildcard,
                    body: skipped,
                },
            ],
            span,
        })
    } else {
        step
    };
''',
    '''    if let Some(pattern) = binder {
        if refutable(pattern, arena) {
            return Err(
                "BLOT_REFUTABLE_FOR_BINDER: a `for` binder must match every element; bind one name and use `if let` in the body when non-matches should be skipped"
                    .to_owned(),
            );
        }
        declarations.push(arena.declaration(Declaration::Binding {
            kind: DeclarationKind::Let,
            tags: Vec::new(),
            pattern,
            value: element,
            span,
        }));
    }
    if let LoopBody::Plain {
        declarations: body_declarations,
        ..
    } = &body
    {
        declarations.extend(body_declarations.iter().copied());
    }
    let step_result = match &body {
        LoopBody::Plain { .. } => state,
        LoopBody::Control(body) => body.outcome,
    };
    let visited = arena.expression(Expression::Block {
        declarations,
        result: step_result,
        result_effects: ResultEffects::Ambient,
        span,
    });
''',
)

# Reuse ordinary sig syntax for a module parameter. Leading opens are checked
# first so the signature can use prelude type names; the signature itself is
# consumed by the module boundary rather than requiring a same-name binding.
insert_before(
    "src/check/infer.ts",
    "function inferDeclarations(\n",
    '''type SignatureDeclaration = Extract<Decl, { readonly tag: "binding" }> & {
  readonly kind: "sig";
};

interface DeclaredSignature {
  readonly name: string;
  readonly type: SimpleType;
  readonly span: Span;
}

function declaredSignature(
  declaration: SignatureDeclaration,
  context: Context,
): DeclaredSignature {
  if (declaration.pattern.tag !== "name") {
    fail("BLOT_BAD_SIG", "`sig` names a single binding.", declaration.span);
  }
  const value = comptime(declaration.value, context);
  if (value === null) {
    fail(
      "BLOT_SIG_NOT_COMPTIME",
      "A `sig` must evaluate at compile time.",
      declaration.span,
    );
  }
  const bridged = bridge(value);
  if (bridged === null) {
    fail(
      "BLOT_SIG_NOT_A_TYPE",
      `A ` + "`sig`" + ` must evaluate to a type; this one evaluates to ${show(value)}.`,
      declaration.span,
    );
  }
  const unrepresentable = unrepresentableInteger(bridged);
  if (unrepresentable !== null) {
    fail(
      "BLOT_UNREPRESENTABLE_INTEGER",
      `Runtime signature \`${declaration.pattern.name}\` contains ${showType(unrepresentable)}, which has inhabitants outside signed i64 ${I64_LOW}..${I64_HIGH}. Storage widths are compile-time descriptors; they are not wider runtime integers.`,
      declaration.span,
    );
  }
  return {
    name: declaration.pattern.name,
    type: bridged,
    span: declaration.span,
  };
}

function moduleParameterSignature(
  module: Module,
): { readonly index: number; readonly declaration: SignatureDeclaration } | null {
  if (module.parameter === null || module.parameter.tag !== "name") return null;
  for (let index = 0; index < module.declarations.length; index += 1) {
    const declaration = module.declarations[index];
    if (declaration.tag === "open") continue;
    if (
      declaration.tag === "binding" && declaration.kind === "sig" &&
      declaration.pattern.tag === "name" &&
      declaration.pattern.name === module.parameter.name
    ) {
      return { index, declaration: declaration as SignatureDeclaration };
    }
    return null;
  }
  return null;
}

''',
)

replace_once(
    "src/check/infer.ts",
    '''    if (declaration.kind === "sig") {
      if (declaration.pattern.tag !== "name") {
        fail("BLOT_BAD_SIG", "`sig` names a single binding.", declaration.span);
      }
      const value = comptime(declaration.value, context);
      if (value === null) {
        fail(
          "BLOT_SIG_NOT_COMPTIME",
          "A `sig` must evaluate at compile time.",
          declaration.span,
        );
      }
      const bridged = bridge(value);
      if (bridged === null) {
        // Naming what it got matters here: the commonest mistake is reaching
        // for a namespace whose name reads like a type — `Text` is the record
        // of text functions and `Str` is the type — and the old message left
        // the reader to guess which of the two they had.
        fail(
          "BLOT_SIG_NOT_A_TYPE",
          `A \`sig\` must evaluate to a type; this one evaluates to ${
            show(value)
          }.`,
          declaration.span,
        );
      }
      const unrepresentable = unrepresentableInteger(bridged);
      if (unrepresentable !== null) {
        fail(
          "BLOT_UNREPRESENTABLE_INTEGER",
          `Runtime signature \`${declaration.pattern.name}\` contains ${
            showType(unrepresentable)
          }, which has inhabitants outside signed i64 ${I64_LOW}..${I64_HIGH}. Storage widths are compile-time descriptors; they are not wider runtime integers.`,
          declaration.span,
        );
      }
      pendingSig = {
        name: declaration.pattern.name,
        type: bridged,
        span: declaration.span,
      };
      continue;
    }
''',
    '''    if (declaration.kind === "sig") {
      pendingSig = declaredSignature(
        declaration as SignatureDeclaration,
        context,
      );
      continue;
    }
''',
)

replace_once(
    "src/check/infer.ts",
    '''  // The entry module's parameter is the program's whole authority, and its
  // shape is whatever the program actually reaches for — inference discovers
  // the capability requirement rather than the program declaring it. An
  // imported module's parameter is the same variable, and reporting it is what
  // lets an importer's argument be checked against what the module reads.
  const parameter = module.parameter === null
    ? null
    : bindPattern(module.parameter, context, level);

  inferDeclarations(module.declarations, context, level, row);
''',
    '''  // A module parameter remains inferred by default. A matching `sig` in the
  // module preamble makes the boundary explicit instead: leading `open`
  // declarations establish names for the signature, then the parameter is
  // contextually bound to that declared record/type before the body is checked.
  let parameter: SimpleType | null = null;
  const parameterSignature = moduleParameterSignature(module);
  if (module.parameter !== null && parameterSignature !== null) {
    inferDeclarations(
      module.declarations.slice(0, parameterSignature.index),
      context,
      level,
      row,
    );
    const declared = declaredSignature(parameterSignature.declaration, context);
    bindPatternAgainst(module.parameter, declared.type, context, level);
    parameter = declared.type;
    inferDeclarations(
      module.declarations.slice(parameterSignature.index + 1),
      context,
      level,
      row,
    );
  } else {
    if (module.parameter !== null) {
      parameter = bindPattern(module.parameter, context, level);
    }
    inferDeclarations(module.declarations, context, level, row);
  }
''',
)

# Rust production checker: detect and consume the same preamble sig.
insert_before(
    "compiler/src/typecheck.rs",
    "impl Checker {\n",
    '''fn module_parameter_signature(
    module: &Module,
) -> Option<(usize, PatternId, ExpressionId, Span)> {
    let parameter = module.parameter?;
    let Pattern::Name { name, .. } = &module.arena.patterns[parameter.0 as usize] else {
        return None;
    };
    for (index, declaration_id) in module.declarations.iter().enumerate() {
        match &module.arena.declarations[declaration_id.0 as usize] {
            Declaration::Open { .. } => continue,
            Declaration::Binding {
                kind: DeclarationKind::Sig,
                pattern,
                value,
                span,
                ..
            } => {
                let Pattern::Name {
                    name: signature_name,
                    ..
                } = &module.arena.patterns[pattern.0 as usize]
                else {
                    return None;
                };
                if signature_name == name {
                    return Some((index, *pattern, *value, *span));
                }
                return None;
            }
            _ => return None,
        }
    }
    None
}

''',
)

insert_before(
    "compiler/src/typecheck.rs",
    "    #[allow(clippy::too_many_arguments)]\n    fn check_declaration(\n",
    '''    fn signature_type(
        &self,
        path: &str,
        module: &Module,
        pattern: PatternId,
        value: ExpressionId,
        span: Span,
        values: &ValueEnvironment,
    ) -> Result<(String, Type), Diagnostic> {
        let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] else {
            return Err(Diagnostic::new(
                "BLOT_SIG_PATTERN",
                "A signature must name one binding.",
                span,
            ));
        };
        let signature_value = self.evaluate(path, value, values, Phase::Comptime)?;
        let signature = self.bridge(&signature_value).ok_or_else(|| {
            Diagnostic::new(
                "BLOT_SIG_NOT_A_TYPE",
                format!("The signature for `{name}` is not a type value."),
                span,
            )
        })?;
        if let Some(unrepresentable) = unrepresentable_integer(&signature) {
            return Err(Diagnostic::new(
                "BLOT_UNREPRESENTABLE_INTEGER",
                format!(
                    "Runtime signature `{name}` contains {}, which has inhabitants outside signed i64.",
                    self.show(unrepresentable)
                ),
                span,
            ));
        }
        Ok((name.clone(), signature))
    }

''',
)

replace_once(
    "compiler/src/typecheck.rs",
    '''            } => {
                let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] else {
                    return Err(Diagnostic::new(
                        "BLOT_SIG_PATTERN",
                        "A signature must name one binding.",
                        span,
                    ));
                };
                let signature_value = self.evaluate(path, value, values, Phase::Comptime)?;
                let signature = self.bridge(&signature_value).ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_SIG_NOT_A_TYPE",
                        format!("The signature for `{name}` is not a type value."),
                        span,
                    )
                })?;
                if let Some(unrepresentable) = unrepresentable_integer(&signature) {
                    return Err(Diagnostic::new(
                        "BLOT_UNREPRESENTABLE_INTEGER",
                        format!(
                            "Runtime signature `{name}` contains {}, which has inhabitants outside signed i64.",
                            self.show(unrepresentable)
                        ),
                        span,
                    ));
                }
                signatures.insert(name.clone(), signature);
                Ok(Type::Effects(BTreeSet::new()))
            }
''',
    '''            } => {
                let (name, signature) =
                    self.signature_type(path, module, pattern, value, span, values)?;
                signatures.insert(name, signature);
                Ok(Type::Effects(BTreeSet::new()))
            }
''',
)

replace_once(
    "compiler/src/typecheck.rs",
    '''        let mut types = TypeEnvironment::default();
        let values = child_env(None);
        let parameter = loaded.module.parameter.map(|pattern| {
            let parameter = self.fresh();
            self.bind_pattern(&loaded.module, pattern, parameter.clone(), &mut types);
            parameter
        });
        let mut signatures = BTreeMap::<String, Type>::new();
''',
    '''        let mut types = TypeEnvironment::default();
        let values = child_env(None);
        let parameter_signature = module_parameter_signature(&loaded.module);
        let mut parameter = None;
        if parameter_signature.is_none()
            && let Some(pattern) = loaded.module.parameter
        {
            let inferred = self.fresh();
            self.bind_pattern(&loaded.module, pattern, inferred.clone(), &mut types);
            parameter = Some(inferred);
        }
        let mut signatures = BTreeMap::<String, Type>::new();
''',
)

replace_once(
    "compiler/src/typecheck.rs",
    '''            let declaration = loaded.module.arena.declarations[declaration_id.0 as usize].clone();
            let declaration_effects = self.check_declaration(
                path,
                &loaded.module,
                declaration,
                &mut types,
                &values,
                &dependency_types,
                &mut signatures,
            )?;
            effects = self.join_effects(effects, declaration_effects)?;
''',
    '''            if let Some((signature_index, pattern, value, span)) = parameter_signature
                && index == signature_index
            {
                let (_, signature) = self.signature_type(
                    path,
                    &loaded.module,
                    pattern,
                    value,
                    span,
                    &values,
                )?;
                let module_pattern = loaded.module.parameter.ok_or_else(|| {
                    Diagnostic::new(
                        "BLOT_SIG_PATTERN",
                        "A module parameter signature requires a module parameter.",
                        span,
                    )
                })?;
                self.bind_pattern(
                    &loaded.module,
                    module_pattern,
                    signature.clone(),
                    &mut types,
                );
                parameter = Some(signature);
                continue;
            }
            let declaration = loaded.module.arena.declarations[declaration_id.0 as usize].clone();
            let declaration_effects = self.check_declaration(
                path,
                &loaded.module,
                declaration,
                &mut types,
                &values,
                &dependency_types,
                &mut signatures,
            )?;
            effects = self.join_effects(effects, declaration_effects)?;
''',
)

# Catalog: explicit module contract and contextual signed spread.
replace_once(
    "examples/lib/score.blot",
    '''module capabilities

open @import "blot:prelude" ()

return {
  .run = capabilities.base + capabilities.bonus;
  .scaled = capabilities.base * 2;
}
''',
    '''module capabilities

open @import "blot:prelude" ()

sig capabilities = {
  .base = Int;
  .bonus = Int;
}

let settings = {
  ...capabilities;
  .scale = 2;
}

return {
  .run = settings.base + settings.bonus;
  .scaled = settings.base * settings.scale;
}
''',
)

replace_once(
    "examples/modules.blot",
    '''const score = @import "./lib/score.blot"
let result = score { .base = 40; .bonus = 2; }
''',
    '''const score = @import "./lib/score.blot"
let result = score { .base = 40; .bonus = 2; .unused = 99; }
''',
)

Path("examples/rejected/semantics/refutable_for_binder.blot").write_text(
    '''open @import "blot:prelude" ()

for #Some value in Iter.items [#Some 1, #None]:
  let kept = value

return ()
'''
)

replace_once(
    "examples.test.ts",
    '''  "for_type_drift": { code: "BLOT_TYPE_ERROR", stage: "check" },
''',
    '''  "for_type_drift": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "refutable_for_binder": {
    code: "BLOT_REFUTABLE_FOR_BINDER",
    stage: "check",
  },
''',
)

insert_before(
    "module.test.ts",
    'Deno.test("an import cycle reports the complete cycle", async () => {\n',
    '''Deno.test("a module parameter signature bounds its body demand", async () => {
  const directory = await Deno.makeTempDir();
  const library = await writeModule(
    directory,
    "lib",
    `module input
open @import "blot:prelude" ()
sig input = { .zoom = Int; }
return input.angle
`,
  );

  const error = await assertRejects(() => checkFile(library), BlotError);
  assertEquals(error.diagnostic.code, "BLOT_TYPE_ERROR");
});

Deno.test("a signed module parameter spread copies exactly declared fields", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "lib",
    `module input
open @import "blot:prelude" ()
sig input = { .left = Int; .right = Int; }
let copied = { ...input; .sum = input.left + input.right; }
return copied
`,
  );
  const root = await writeModule(
    directory,
    "root",
    `const value = (@import "./lib.blot") { .left = 20; .right = 22; .extra = 7; }
return value.sum
`,
  );

  assertEquals((await checkFile(root)).type, "Int");
});

''',
)

# Authoritative language text.
replace_once(
    "LANGUAGE.md",
    '''Applying an imported module checks the argument against the parameter type
inference found _inside_ that module. Nothing declares that requirement — a
module never writes a signature for its parameter, and the demand is whatever
its bodies reach for — so the rule is that the importer's record must satisfy
every field the module projects off its parameter. A record missing one is
`BLOT_TYPE_ERROR` at the application, naming the field. A fresh variable in the
parameter's place would satisfy every argument, and the program would then read
a field that is not there.
`examples/rejected/semantics/module_argument_missing_field.blot` is the catalog
entry.
''',
    '''Applying an imported module checks the argument against the module parameter's
checked type. By default that type is still inferred from what the body reaches
for. A module may instead declare an upper bound with an ordinary `sig` in its
preamble, after any leading `open` declarations and before other declarations:

```blot
module capabilities
open @import "blot:prelude" ()
sig capabilities = { .base = Int; .bonus = Int; }
```

The parameter is contextually bound to that type while the body is checked, so a
projection not admitted by the signature is a `BLOT_TYPE_ERROR` in the module.
The signature grants no authority: callers must still supply its fields, and may
supply more through ordinary width subtyping. Omitting the `sig` preserves the
inferred-demand rule. A fresh unrelated variable at the import boundary would
satisfy every argument and is therefore never substituted for the checked
parameter type. `examples/rejected/semantics/module_argument_missing_field.blot`
remains the inferred-demand catalog entry; `examples/lib/score.blot` exercises
the explicit form.
''',
)

replace_once(
    "LANGUAGE.md",
    '''A spread contributes the fields its operand is _known_ to have. Where the
operand is a shape written nearby, that is all of them. Where it is a parameter,
it is none of them: `fn r => { ...r; .tag = 1; }` returns a shape with `.tag`
and nothing else, and reading any other field off the result is an error. Width
subtyping says what a function may _read_ from a record it is handed; it does
not carry the unread fields through a spread, which would need a row variable
this lattice does not have. Naming the fields at the spread avoids the limit
entirely.
''',
    '''A spread contributes the fields its operand is _known_ to have. Where the
operand is a shape written nearby, that is all of them. A parameter with no
contextual record type contributes no fields: `fn r => { ...r; .tag = 1; }`
returns a shape with `.tag` and nothing else. A parameter checked against a
written record signature is different because its field set is known there:
`sig copy = { .x = Int; .y = Int; } -> ...` makes `...r` inside `copy` copy
exactly `.x` and `.y`. Module-parameter signatures use the same rule. Extra
fields a caller supplies remain accepted by width subtyping but are not silently
propagated through the signed spread. This is a closed declared copy, not record
row polymorphism. Naming fields explicitly remains the alternative when no
signature provides the set.
''',
)

replace_once(
    "LANGUAGE.md",
    '''The first form ignores each element. The second matches it against `pattern`. An
irrefutable pattern binds normally. A refutable pattern that does not match
skips that element rather than failing the loop.
''',
    '''The first form ignores each element. The second binds `pattern`, which must be
irrefutable for every element. A refutable binder is
`BLOT_REFUTABLE_FOR_BINDER`; filtering is control flow and must be written
explicitly by binding one name and using `if let`/`case` in the body. Adding a
constructor to an element type therefore cannot silently make an existing loop
drop values.
''',
)

# Focused checker contract and suggestion ledger.
insert_before(
    "spec/TYPECHECKING.md",
    "## Conservativity rules\n",
    '''### Module parameter contracts and signed spreads

A module parameter is inferred when no source signature is present. A matching
`sig` in the module preamble instead supplies the parameter's checked upper
bound. Leading `open` declarations are checked first so the signature may use
compile-time type names; the parameter is then bound contextually to the
signature before the rest of the body. The published module interface carries
that checked parameter type, so importer checking and body checking use the same
constraint.

A record spread copies only a statically known field set. Contextual checking of
a function or module parameter against a record signature therefore makes the
spread copy exactly those declared fields. Width-subtyped extra caller fields do
not become part of that set; no record-row variable is introduced.

A `for` binder must be irrefutable. Lowering refuses a refutable binder before
constructing the recursive fold, so iteration has no hidden filter semantics.

''',
)

# Replace the old quiet-behavior section with an implementation record.
path = Path("SUGGESTION.md")
text = path.read_text()
start = text.find("## 15. Close the quiet behaviors")
end = text.find("## 16. Contingent, and what not to do yet")
if start < 0 or end < 0 or end <= start:
    raise SystemExit("SUGGESTION.md quiet-behavior section not found")
replacement = '''## 15. Implemented: close the quiet behaviors

The three previously quiet readings are now explicit.

- A refutable `for` binder is refused with `BLOT_REFUTABLE_FOR_BINDER`; filtering
  is written with an irrefutable binder plus `if let` or `case` in the body.
- A spread of a parameter copies the exact fields of a contextual record
  signature. Extra width-subtyped caller fields do not leak through, so this is
  a closed copy rather than record-row polymorphism.
- A named module parameter may have a matching ordinary `sig` in the preamble,
  after leading `open` declarations. The signature bounds the body demand and is
  the parameter type published to importers; omitting it keeps demand inference.

All three reuse existing checker/lowering concepts and add no new runtime or
parser representation.

'''
path.write_text(text[:start] + replacement + text[end:])
