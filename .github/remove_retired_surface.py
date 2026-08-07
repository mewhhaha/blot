from __future__ import annotations

from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    text = read(path)
    count = text.count(old)
    if count != expected:
        raise SystemExit(
            f"{path}: expected {expected} occurrences, found {count}: {old[:120]!r}"
        )
    write(path, text.replace(old, new))


def remove_between(path: str, start: str, end: str, expected: int = 1) -> None:
    text = read(path)
    if text.count(start) != expected or text.count(end) < expected:
        raise SystemExit(
            f"{path}: markers changed for removal: {start[:80]!r} .. {end[:80]!r}"
        )
    for _ in range(expected):
        begin = text.index(start)
        finish = text.index(end, begin)
        text = text[:begin] + "\n" + text[finish:]
    write(path, text)


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    text = read(path)
    if text.count(start) != 1 or text.count(end) < 1:
        raise SystemExit(
            f"{path}: markers changed for replacement: {start[:80]!r} .. {end[:80]!r}"
        )
    begin = text.index(start)
    finish = text.index(end, begin)
    write(path, text[:begin] + replacement + text[finish:])


def replace_test(path: str, title: str, replacement: str) -> None:
    text = read(path)
    marker = f'Deno.test("{title}"'
    if text.count(marker) != 1:
        raise SystemExit(f"{path}: test marker changed: {title!r}")
    begin = text.index(marker)
    next_test = text.find("\nDeno.test(", begin + len(marker))
    next_const = text.find("\nconst RULE_CASES", begin + len(marker))
    candidates = [offset for offset in (next_test, next_const) if offset >= 0]
    if not candidates:
        raise SystemExit(f"{path}: cannot find end of test {title!r}")
    finish = min(candidates) + 1
    rendered = replacement.rstrip() + "\n\n" if replacement.strip() else ""
    write(path, text[:begin] + rendered + text[finish:])


# Production grammar: value selection is `case`; handler composition is the
# general two-argument @handle transformer plus ordinary `|>` application.
replace(
    "grammar.baba",
    """// A value continued after `=` cannot begin with a block or conditional. Both
// begin with the same layout tokens as a binding block, and treating `if` as a
// continued value would make its branch suites indistinguishable from a
// statement conditional's suites. Other values have disjoint starts; an
// explicit block remains available through the ordinary `value` alternative.
""",
    """// A value continued after `=` cannot begin with the implicit block rule: its
// layout tokens are also the binding's statement suite. Other values have
// disjoint starts; `do:` is the explicit value-producing statement scope.
""",
)
replace(
    "grammar.baba",
    "  | case_expression\n  | handler_composition\n  | do_block\n",
    "  | case_expression\n  | do_block\n",
    expected=3,
)
replace(
    "grammar.baba",
    "  | conditional\n  | case_expression\n",
    "  | case_expression\n",
    expected=2,
)
replace(
    "grammar.baba",
    '  | "for" | "in" | "break" | "try" | "with" | "do" | "fn"\n',
    '  | "for" | "in" | "break" | "do" | "fn"\n',
)
remove_between(
    "grammar.baba",
    "\nconditional = (\n",
    "\n// A standalone conditional",
)
remove_between(
    "grammar.baba",
    "\n// Compose statically known handlers around one nullary computation.",
    "\n// Construct-owned suites",
)

# Layout no longer has a retired `with` suite opener.
replace(
    "src/syntax/layout.ts",
    '      token.literal === "of" || token.literal === "with" ||\n      token.literal === ":";\n',
    '      token.literal === "of" || token.literal === ":";\n',
)

# The production compact schema no longer carries fields belonging only to the
# retired grammar. The frozen migration schema remains untouched.
for field in ("action", "effect", "handler", "intrinsic", "program", "steps"):
    replace("src/syntax/compact_schema.ts", f'  "{field}",\n', "")
replace("src/syntax/compact_schema.ts", '  "conditional.alternatives",\n', "")
replace("src/syntax/compact_schema.ts", '  "handler_composition.steps",\n', "")

# Remove the parse-after-parse rejection layer. Unsupported source now fails in
# the authoritative production grammar, while src/migration keeps its frozen
# parser and current AST lowering support.
replace(
    "src/syntax/parse.ts",
    """export async function parse(source: string): Promise<ParseResult> {
  const result = await parseConcrete(source);
  if (!result.ok) return result;
  const removed = removedSurfaceDiagnostics(result.cst);
  if (removed.length > 0) return { ok: false, diagnostics: removed };
  return { ok: true, module: result.module };
}
""",
    """export async function parse(source: string): Promise<ParseResult> {
  const result = await parseConcrete(source);
  if (!result.ok) return result;
  return { ok: true, module: result.module };
}
""",
)
remove_between(
    "src/syntax/parse.ts",
    "\nfunction removedSurfaceDiagnostics(root: Rule): readonly Diagnostic[] {",
    "\nexport function ingestCpuSource",
)

replace_between(
    "src/syntax/surface.test.ts",
    'Deno.test("value if is retained only by concrete migration parsing"',
    "function transformerEffect",
    """Deno.test("value if is absent from the production grammar", async () => {
  const source = `let value = if True:
  return 1
else:
  return 2
return value
`;
  const parsed = await parseConcrete(source);
  assert(!parsed.ok);
});

Deno.test("try-with is absent from the production grammar", async () => {
  const source = `let program = fn () => 1
let handler = {}
let value = try program with
  @handle (Effect, handler)
return value
`;
  const parsed = await parseConcrete(source);
  assert(!parsed.ok);
});

""",
)

# Source tooling should only format accepted production syntax.
for snippet in ('  "conditional",\n', '  "handler_composition",\n'):
    text = read("src/tooling/formatter.ts")
    count = text.count(snippet)
    if count == 0:
        raise SystemExit(f"formatter.ts: missing {snippet!r}")
    write("src/tooling/formatter.ts", text.replace(snippet, ""))
replace(
    "src/tooling/formatter.ts",
    """    const conditional = formatOneConditional(laidOut, current.cst);
    if (conditional !== laidOut) {
      laidOut = conditional;
      continue;
    }
""",
    "",
)
remove_between(
    "src/tooling/formatter.ts",
    "\nfunction formatOneConditional(\n",
    "\nfunction formatOneLambda",
)
replace(
    "src/tooling/formatter.ts",
    """    if (
      original.includes("\\n") &&
      containsRule(body, layoutSensitiveRules) &&
      !expressionPrimaryIs(body, "conditional")
    ) {
      continue;
    }
""",
    """    if (original.includes("\\n") && containsRule(body, layoutSensitiveRules)) {
      continue;
    }
""",
)
replace(
    "src/tooling/formatter.ts",
    """    if (
      candidateWidth <= maximumLineWidth &&
      !expressionPrimaryIs(body, "conditional")
    ) {
""",
    """    if (candidateWidth <= maximumLineWidth) {
""",
)
replace(
    "src/tooling/formatter.ts",
    '      expressionPrimaryIs(body, "conditional") ? "" : "return ",\n',
    '      "return ",\n',
)
replace(
    "src/tooling/formatter.ts",
    '  collectRules(concrete, "handler_composition_step", bindings);\n',
    "",
)

# Editor queries mirror the production CST.
replace("queries/indents.scm", "  (handler_composition)\n", "")
remove_between(
    "queries/keywords.scm",
    "\n(conditional\n",
    "\n(conditional_statement\n",
)
remove_between(
    "queries/keywords.scm",
    "\n(handler_composition\n",
    "\n(lambda_parameter\n",
)

# Remove lints whose only possible concrete origin was value-if. Keep the two
# chain rules, but restrict their AST path to terminal statement conditionals.
for path in (
    "src/tooling/lint/rules/boolean_if.ts",
    "src/tooling/lint/rules/redundant_if.ts",
    "src/tooling/lint/rules/discarded_value_if.ts",
):
    Path(path).unlink()
for line in (
    'import { booleanIf } from "./rules/boolean_if.ts";\n',
    'import { discardedValueIf } from "./rules/discarded_value_if.ts";\n',
    'import { redundantIf } from "./rules/redundant_if.ts";\n',
    "  redundantIf,\n",
    "  booleanIf,\n",
    "  discardedValueIf,\n",
):
    replace("src/tooling/lint/rules.ts", line, "")
replace(
    "src/tooling/lint/types.ts",
    "  isValueConditional(expression: Expr): boolean;\n",
    "",
)
replace(
    "src/tooling/lint/runner.ts",
    """      isValueConditional: (expression) =>
        expression.tag === "if" &&
        concrete.spans.get("conditional")?.has(spanKey(expression.span)) ===
          true,
""",
    "",
)
for path in (
    "src/tooling/lint/rules/equality_if_chain.ts",
    "src/tooling/lint/rules/nested_if_chain.ts",
):
    replace(
        path,
        """        const valueConditional = context.isValueConditional(expression);
        const terminalStatement = isTerminalStatement(
          expression,
          path.parent,
          context,
        );
        if (!valueConditional && !terminalStatement) return;
""",
        """        const terminalStatement = isTerminalStatement(
          expression,
          path.parent,
          context,
        );
        if (!terminalStatement) return;
""",
    )
    replace(
        path,
        """  return context.isValueConditional(expression) ||
    context.hasConcreteOrigin(expression, "conditional_statement_branches");
""",
        """  return context.hasConcreteOrigin(
    expression,
    "conditional_statement_branches",
  );
""",
    )

# Lint fixtures no longer depend on syntax the compiler refuses.
replace_test(
    "src/tooling/lint.test.ts",
    "an equality if chain prefers one case match",
    """Deno.test("an equality if chain prefers one case match", async () => {
  const source = `let label = fn n =>
  if n == 1:
    return "one"
  else if n == 2:
    return "two"
  else:
    return "other"
return label
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).map((diagnostic) =>
      diagnostic.code
    ),
    ["BLOT_LINT_IF_CHAIN"],
  );
});""",
)
for title in (
    "a nested equality ladder becomes one case match",
    "a nested value conditional becomes an else-if ladder",
    "a conditional whose branches agree is redundant",
    "a statement conditional is not a redundant value conditional",
):
    replace_test("src/tooling/lint.test.ts", title, "")
replace_test(
    "src/tooling/lint.test.ts",
    "different equality subjects prefer else-if rather than case",
    """Deno.test("different equality subjects prefer else-if rather than case", async () => {
  const source = `let choose = fn () =>
  if left == 1:
    return 1
  else:
    if right == 2:
      return 2
    else:
      return 3
return choose
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("different-subject fixture did not parse");
  const diagnostics = lintModule(parsed.module, source, parsed.cst);

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_IF_CHAIN"
    ),
    [],
  );
  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_LINT_NESTED_IF_CHAIN"
    ),
  );
});""",
)
text = read("src/tooling/lint.test.ts")
text, removed_cases = re.subn(
    r'  \{\n    name: "[^"]+",\n    code: "BLOT_LINT_(?:BOOLEAN_IF|DISCARDED_VALUE_IF)",[\s\S]*?\n  \},\n',
    "",
    text,
)
if removed_cases != 2:
    raise SystemExit(f"lint.test.ts: expected two retired rule cases, removed {removed_cases}")
write("src/tooling/lint.test.ts", text)
replace_test(
    "src/tooling/lint.test.ts",
    "rule visitors cover effect rows and structural interfaces",
    """Deno.test("rule visitors cover effect rows and structural interfaces", async () => {
  const source = `const Console = @effect { .write = Unit -> Unit; }
const Host = @effect.host { .write = Unit -> Unit; }
let run = fn () =>
  value <- Console.write ()
  return value
let composed = run
  |> @handle (Host, host_handler)
  |> @handle (Console, handler)
return (
  Empty Int,
  Length Str,
  Semigroup Int,
  Monoid Str,
  @handle (Console, run, handler),
  composed,
  Unit -> Unit ~ { Console }
)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("coverage fixture did not parse");
  const seen = new Set<string>();
  const rule: LintRule = {
    name: "surface-coverage",
    code: "TEST_SURFACE_COVERAGE",
    severity: "hint",
    create() {
      return {
        declaration(path) {
          if (path.node.tag === "binding" && path.node.kind === "effect") {
            seen.add("effect-binding");
          }
        },
        expression(path) {
          if (path.node.tag === "var") seen.add(path.node.name);
          if (path.node.tag === "intrinsic") seen.add(path.node.name);
        },
        concrete(node) {
          seen.add(node.name);
        },
      };
    },
  };
  lintModule(parsed.module, source, parsed.cst, [rule]);
  for (
    const name of [
      "@effect",
      "@effect.host",
      "@handle",
      "@type.arrow",
      "@type.performs",
      "effect-binding",
      "Empty",
      "Length",
      "Semigroup",
      "Monoid",
    ]
  ) {
    assert(seen.has(name), `${name} was not visited`);
  }
});""",
)

# The production Rust frontend has no migration mode, so remove its now-dead
# concrete lowering branches. TypeScript's lowerer retains them for migration.
remove_between(
    "experiments/rust-middle/src/lower.rs",
    '        "conditional" => {\n',
    '        "case_expression" => {\n',
)
replace(
    "experiments/rust-middle/src/lower.rs",
    '        "handler_composition" => lower_handler_composition(cst, rule, context, arena),\n',
    "",
)
remove_between(
    "experiments/rust-middle/src/lower.rs",
    "\nfn lower_handler_composition(\n",
    "\nfn lower_element(\n",
)

# Documentation: one accepted source language, with migration explicitly
# confined to the frozen parser.
replace_between(
    "README.md",
    "An expression `if` always has an `else` and produces one of its branch values:",
    "A deconstructing guard binds its pattern on the path that follows:",
    """Value selection is written with `case`, including Boolean choices:

```blot
let label = case ready of
  #True => "ready"
  #False => "waiting"
```

A standalone `if` is surrounding control flow, has an optional `else`, and may
transfer control:

```blot
let describe = fn value =>
  if value < 0:
    return "negative"
  return "non-negative"
```

""",
)
replace_between(
    "README.md",
    "Several handlers compose without manual nesting:",
    "An effect the _host_ implements",
    """Several handlers compose as ordinary computation transformers:

```blot
let handled = program
  |> @handle (Terminal, fake_terminal)
  |> @handle (Clock, fake_clock)
  |> @handle (Random, fake_random)
result <- handled
```

Each two-argument `@handle` returns a transformer over a nullary computation.
The pipeline remains statically visible and lowers to ordinary three-argument
`@handle` calls; it is not a runtime handler registry.

""",
)

replace("LANGUAGE.md", "for in break try do fn\n", "for in break do fn\n")
replace(
    "LANGUAGE.md",
    "The\nintroducers are `=`, `=>`, `<-`, `of`, `with`, `:`, and an opening element's\n",
    "The\nintroducers are `=`, `=>`, `<-`, `of`, `:`, and an opening element's\n",
)
replace(
    "LANGUAGE.md",
    """The
formatter writes value conditionals vertically, expanding each direct branch
value into a block whose explicit `return` supplies that value. When the
conditional is itself the terminal result of a scope, the formatter omits the
redundant outer `return` and lets those branch returns target the scope
directly. Arrays use one line when they fit within their value scope and
""",
    """Arrays use one line when they fit within their value scope and
""",
)
replace(
    "LANGUAGE.md",
    """The indented continuation accepts a lambda, element, or ordinary expression. An
`if` immediately after the newline begins the binding's existing block form,
where it is a statement conditional; parenthesize it when the binding must
continue with a value conditional instead. The continuation changes layout only
and does not introduce another scope.
""",
    """The indented continuation accepts a lambda, element, or ordinary expression. An
`if` immediately after the newline begins the binding's statement block. The
continuation changes layout only and does not introduce another scope.
""",
)
replace(
    "LANGUAGE.md",
    """const measuring = fn T => if refines (T, Str):
  return fn x => Text.length x
else:
  return fn x => x + 0
""",
    """const measuring = fn T => case refines (T, Str) of
  #True => fn x => Text.length x
  #False => fn x => x + 0
""",
)
replace(
    "LANGUAGE.md",
    """The left-hand binding in a `try` handler step is a separate bounded surface
form. Section 12.2 specifies how it binds the newly handled computation without
executing it.

""",
    "",
)
replace_between(
    "LANGUAGE.md",
    "### 8.1 Value-producing `if`",
    "### 8.3 Deconstructing guard",
    """### 8.1 Statement `if`

```blot
if condition:
  statements
else if other:
  statements
else:
  statements
```

A statement conditional's `else` is optional. Its branches are lexical binding
scopes but not return or loop boundaries, so `return` and `break` retain their
surrounding targets. Value selection belongs to `case` (§8.3), including a
choice between `#True` and `#False`.

A branch is a scope for `let` but not for `:=`. A name a branch rebinds with
`:=` is rebound for the statements that follow the conditional: the name was
already in scope and keeps its type, so every path agrees on what it holds —
including a missing `else`, which passes the name through unchanged. A `let`
inside a branch stays local to that branch, shadowing any outer binding of that
name for the rest of the branch and escaping with nothing.

The suite ends at the first dedent. `else` aligns with its `if`.

### 8.2 Deconstructing guard
""",
)
replace("LANGUAGE.md", "### 8.4 `case`\n", "### 8.3 `case`\n")
replace(
    "LANGUAGE.md",
    "Like expression `if`, `case` is a separate result scope.",
    "`case` is a separate result scope.",
)
replace(
    "LANGUAGE.md",
    "It cannot cross a lambda\nor a value-producing `if` or `case`, and using it without an enclosing `for` is\n",
    "It cannot cross a lambda or a value-producing `case`, and using it without\nan enclosing `for` is\n",
)
replace_between(
    "LANGUAGE.md",
    "### 12.2 Handler composition",
    "### 12.3 Host boundary",
    """### 12.2 Handler composition

A two-argument `@handle (effect, handler)` is a surface computation transformer.
It accepts a linear nullary computation and returns another nullary computation
with that effect discharged. Ordinary left-associative `|>` composes several:

```blot
let handled = program
  |> @handle (Terminal, fake_terminal)
  |> @handle (Clock, fake_clock)
  |> @handle (Random, fake_random)
result <- handled
```

Each transformer lowers to a nullary computation containing the ordinary
three-argument `@handle (effect, computation, handler)` call. Sequencing the
final computation executes it. Effect identities, handler shapes, and the
resulting effect rows remain statically visible; there is no runtime handler
registry.

""",
)
replace(
    "LANGUAGE.md",
    """Every intrinsic is curried like an ordinary Blot function except `@handle`,
which takes its three arguments in one tuple. The two-argument spelling inside
`try` is surface syntax described in section 12.2, not partial application.
""",
    """Every intrinsic is curried like an ordinary Blot function except `@handle`,
which takes its three intrinsic arguments in one tuple. The two-argument source
spelling is the computation transformer described in section 12.2, not partial
application of the intrinsic.
""",
)

replace(
    "AGENTS.md",
    """A standalone `if` becomes an ordinary
conditional over those results, and `x <- e` explicitly sequences the already
applied expression `e`, all during CST lowering. `try program with ... end`
likewise becomes named nullary
computations containing ordinary three-argument `@handle` calls; its bounded
left-hand `<-` binds that computation rather than using the general declaration
form. Nothing downstream of the parser knows these forms exist.
""",
    """A standalone `if` becomes an ordinary
conditional over those results, and `x <- e` explicitly sequences the already
applied expression `e`, all during CST lowering. Two-argument `@handle` calls
become nullary computation transformers containing ordinary three-argument
calls. Nothing downstream of surface elaboration knows these forms exist.
""",
)
replace_between(
    "AGENTS.md",
    "**Value conditionals do not transfer control.**",
    "**A deconstructing guard must leave on failure.**",
    """**Value selection does not transfer control.** A `case` produces one arm's
value in a separate result scope that does not inherit surrounding control
targets. An arm's explicit `return` supplies the `case` result; `break` cannot
escape it to reach an enclosing loop. A standalone `if condition:` suite
inherits the surrounding return and loop targets.

""",
)

replace_between(
    "DOCS.md",
    "## Distinguish value conditionals from control flow",
    "## Treat `return` and `break` as different exits",
    """## Distinguish value selection from control flow

Use `case` when an expression must choose a value:

```blot
let label = case ready of
  #True => "ready"
  #False => "waiting"
```

Use standalone `if` for control flow. Return directly from terminal branches,
or use early returns and leave the main path flat:

```blot
let minimum = fn (left, right) =>
  if left < right:
    return left
  return right
```

Use a deconstructing guard when failure leaves and success continues:

```blot
let unwrap_or = fn (candidate, fallback) =>
  if let #Some value = candidate else:
    return fallback

  return value
```

The success path is the code after the guard. Do not add a success suite, and do
not let the failure branch continue: the pattern's names would not exist there.

""",
)
replace(
    "DOCS.md",
    """Do not use `break` from a value conditional. A value conditional is a separate
result scope, so it cannot transfer control to an outer loop.

""",
    """A `case` is a value scope, so `break` cannot transfer from one of its arms to an
outer loop.

""",
)

replace(
    "docs/editor.md",
    """- equality `if` chains better written as one `case`, identical branches, and
  conditionals that only reproduce a Boolean condition;
- discarded value conditionals better written as statement suites and
  Option-shaped terminal matches that can become `if let` guards;
""",
    """- equality `if` chains better written as one `case`, nested `else`
  conditionals that can be one `else if` ladder, and Option-shaped terminal
  matches that can become `if let` guards;
""",
)
replace(
    "docs/backend.md",
    """`try program with` followed by an indented suite adds no backend path. CST
lowering turns each bound two-argument `@handle (effect, handler)` step into a
named nullary computation containing the ordinary three-argument call, then
emits one final three-argument call that executes the composition.
""",
    """A two-argument `@handle (effect, handler)` adds no backend path. Surface
elaboration turns it into a transformer over a linear nullary computation that
contains the ordinary three-argument call. Ordinary `|>` application composes
those transformers before the final computation is sequenced.
""",
)
replace(
    "spec/FRONTEND.md",
    "while\nisolating both at value-producing `if` and `case` result scopes.\n",
    "while\nisolating both at `case` result scopes.\n",
)
replace(
    "spec/SAFETY.md",
    """proved proposition entails. A failed value conditional does not transfer control
to an enclosing function; statement-control elaboration expresses that transfer
before coverage runs.
""",
    """proved proposition entails. A failed guarded arm falls through to later arms;
statement-control elaboration expresses function and loop transfer before
coverage runs.
""",
)
replace(
    "spec/PAPER.md",
    "such as `for`, statement `if`, element syntax, `try`, and early `return` should\n",
    "such as `for`, statement `if`, element syntax, and early `return` should\n",
)
replace("spec/PAPER.md", "- `try` handler composition;\n", "")
replace(
    "docs/roadmap.md",
    """**Remaining work.** The formatter reflows lambdas, value conditionals, arrays,
and long tuple arguments toward 80 columns. A complete expression printer
""",
    """**Remaining work.** The formatter reflows lambdas, arrays, explicit blocks,
and long tuple arguments toward 80 columns. A complete expression printer
""",
)
replace(
    "docs/roadmap.md",
    """Every syntax mistake reports
`Unexpected token
";"`, including the omitted `else` on an expression `if` — the
language's most emphatic rule. A missing comma between `case` arms reports
""",
    """Every syntax mistake reports `Unexpected token ";"` without saying what was
expected. A missing comma between `case` arms reports
""",
)

# Historical profile notes remain historical; current counters are updated by
# the workflow after regeneration.

# Temporary worker files are removed before the final commit.
