import { assert, assertEquals } from "@std/assert";
import { parseConcrete } from "../syntax/parse.ts";
import { DEFAULT_FIXITIES } from "../syntax/fixity.ts";
import { lintModule } from "./lint.ts";
import type { LintRule } from "./lint.ts";

async function applyLintFix(source: string, code: string): Promise<string> {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error(`lint fixture for ${code} did not parse`);
  const diagnostic = lintModule(parsed.module, source, parsed.cst).find(
    (candidate) => candidate.code === code,
  );
  if (diagnostic === undefined) throw new Error(`${code} was not reported`);
  if (diagnostic.fix === null) throw new Error(`${code} did not provide a fix`);
  const fixed = source.slice(0, diagnostic.fix.span.start) +
    diagnostic.fix.replacement + source.slice(diagnostic.fix.span.end);
  if (!(await parseConcrete(fixed)).ok) {
    throw new Error(`${code} produced syntax the parser rejected`);
  }
  return fixed;
}

Deno.test("a terminal statement equality ladder becomes a returned case", async () => {
  const source = `let label = fn n =>
  if n == 1:
    return "one"
  else:
    if 2 == n:
      return "two"
    else:
      return "other"
return label
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("terminal equality fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_NESTED_IF_CHAIN"
    ),
    [],
  );
  const fixed = await applyLintFix(source, "BLOT_LINT_IF_CHAIN");

  assertEquals(
    fixed,
    `let label = fn n =>
  return case n of
    1 => "one"
    2 => "two"
    _ => "other"
return label
`,
  );
  const fixedParse = await parseConcrete(fixed);
  assert(fixedParse.ok);
  if (!fixedParse.ok) return;
  assertEquals(
    lintModule(fixedParse.module, fixed, fixedParse.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_NESTED_IF_CHAIN"
    ),
    [],
  );
});

Deno.test("a nested statement conditional becomes an else-if ladder", async () => {
  const source = `let choose = fn () =>
  let choice = 0
  if first:
    choice := 1
  else:
    if second:
      choice := 2
    else:
      choice := 3
  return choice
return choose
`;

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_NESTED_IF_CHAIN"),
    `let choose = fn () =>
  let choice = 0
  if first:
    choice := 1
  else if second:
    choice := 2
  else:
    choice := 3
  return choice
return choose
`,
  );
});

Deno.test("an else suite with work after its conditional stays nested", async () => {
  const source = `let choose = fn () =>
  if first:
    _ <- one ()
  else:
    if second:
      _ <- two ()
    _ <- finish ()
  return ()
return choose
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("nested statement fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_NESTED_IF_CHAIN"
    ),
    [],
  );
});

const RULE_CASES: readonly {
  readonly name: string;
  readonly code: string;
  readonly source: string;
}[] = [
  {
    name: "an unread pure binding is removable",
    code: "BLOT_LINT_UNUSED_BINDING",
    source: `let forgotten = 1
return 2
`,
  },
  {
    name: "a rebinding to the same value is a no-op",
    code: "BLOT_LINT_NOOP_REBINDING",
    source: `let count = 1
count := count
return count
`,
  },
  {
    name: "an arm after a wildcard is unreachable",
    code: "BLOT_LINT_UNREACHABLE_CASE_ARM",
    source: `return case 1 of
  _ => 1
  1 => 2
`,
  },
  {
    name: "an Option failure arm can be written as a guard",
    code: "BLOT_LINT_GUARD_SHAPED_CASE",
    source: `let unwrap = fn option =>
  return case option of
    #None =>
      return ()
    #Some value => value
return unwrap
`,
  },
  {
    name: "a singleton append in a fold is quadratic",
    code: "BLOT_LINT_QUADRATIC_ARRAY_APPEND",
    source: `let copy = fn values => fold (
  values,
  @array.empty,
  fn (state, value) => Array.append state [value]
)
return copy
`,
  },
  {
    name: "an explicit primitive function prefers its operator",
    code: "BLOT_LINT_OPERATOR_SPELLING",
    source: `return Num.rem 5 2
`,
  },
  {
    name: "a proved total lookup can become direct access",
    code: "BLOT_LINT_PROVED_ARRAY_LOOKUP",
    source: `return case Array.get ([1], 0) of
  #Some value => value
  #None => 0
`,
  },
  {
    name: "a retained array prevents update storage reuse",
    code: "BLOT_LINT_PERSISTENT_ARRAY_COPY",
    source: `let values = [1]
let updated = @array.push values 2
let previous_length = Array.length values
return (updated, previous_length)
`,
  },
  {
    name: "an unread effect result is explicitly discarded",
    code: "BLOT_LINT_UNUSED_EFFECT_RESULT",
    source: `let run = fn () =>
  ignored <- perform_work ()
  return ()
return run
`,
  },
  {
    name: "distinct record arguments disclose specialization count",
    code: "BLOT_LINT_SPECIALIZATION_COUNT",
    source: `let project = fn point => point.x
let first = project { .x = 1; }
let second = project { .x = 1; .y = 2; }
return (first, second)
`,
  },
];

for (const ruleCase of RULE_CASES) {
  Deno.test(ruleCase.name, async () => {
    const parsed = await parseConcrete(ruleCase.source);
    if (!parsed.ok) {
      throw new Error(
        `lint fixture did not parse: ${parsed.diagnostics[0]?.message}`,
      );
    }
    const diagnostics = lintModule(parsed.module, ruleCase.source, parsed.cst);
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === ruleCase.code),
      `${ruleCase.code} was absent from ${
        diagnostics.map((diagnostic) => diagnostic.code).join(", ")
      }`,
    );
  });
}

Deno.test("every syntax-only lint fix produces accepted syntax", async () => {
  for (const ruleCase of RULE_CASES) {
    const parsed = await parseConcrete(ruleCase.source);
    if (!parsed.ok) {
      throw new Error(`lint fixture ${ruleCase.name} did not parse`);
    }
    const diagnostics = lintModule(parsed.module, ruleCase.source, parsed.cst);
    for (const diagnostic of diagnostics) {
      const fix = diagnostic.fix;
      if (fix === null || fix.validation !== "parse") continue;
      const replacement = ruleCase.source.slice(0, fix.span.start) +
        fix.replacement + ruleCase.source.slice(fix.span.end);
      const fixed = await parseConcrete(replacement);
      assert(
        fixed.ok,
        `${diagnostic.code} produced invalid syntax: ${
          fixed.ok ? "" : fixed.diagnostics[0]?.message
        }\n${replacement}`,
      );
    }
  }
});

Deno.test("every actionable default rule provides a fix", async () => {
  const informational = new Set([
    "BLOT_LINT_PERSISTENT_ARRAY_COPY",
    "BLOT_LINT_SPECIALIZATION_COUNT",
  ]);
  for (const ruleCase of RULE_CASES) {
    if (informational.has(ruleCase.code)) continue;
    const parsed = await parseConcrete(ruleCase.source);
    if (!parsed.ok) {
      throw new Error(`lint fixture ${ruleCase.name} did not parse`);
    }
    const diagnostic = lintModule(parsed.module, ruleCase.source, parsed.cst)
      .find((candidate) => candidate.code === ruleCase.code);
    assert(diagnostic !== undefined, `${ruleCase.code} has no diagnostic`);
    assert(diagnostic.fix !== null, `${ruleCase.code} has no fix`);
  }
});

Deno.test("a compiler-proved rewrite requests semantic validation", async () => {
  const source = `return case Array.get ([1], 0) of
  #Some value => value
  #None => 0
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");
  const diagnostic = lintModule(parsed.module, source, parsed.cst).find(
    (candidate) => candidate.code === "BLOT_LINT_PROVED_ARRAY_LOOKUP",
  );
  assertEquals(diagnostic?.fix?.validation, "check");
});

Deno.test("a registered rule receives typed AST and concrete syntax visits", async () => {
  const source = `return chosen
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");
  let sawResult = false;
  const rule: LintRule = {
    name: "chosen-name",
    code: "TEST_CHOSEN_NAME",
    severity: "hint",
    create(context) {
      return {
        expression(path) {
          if (path.node.tag !== "var" || path.node.name !== "chosen") return;
          context.report({ message: "chosen", span: path.node.span });
        },
        concrete(node) {
          if (node.name === "result") sawResult = true;
        },
      };
    },
  };

  assertEquals(
    lintModule(parsed.module, source, parsed.cst, [rule]).map(
      (diagnostic) => diagnostic.code,
    ),
    ["TEST_CHOSEN_NAME"],
  );
  assert(sawResult);
});

Deno.test("guard lowering does not create unreachable-arm diagnostics", async () => {
  const source = `let classify = fn n => case n of
  m if m > 0 => "positive"
  m if m < 0 => "negative"
  _ => "zero"
return classify
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNREACHABLE_CASE_ARM"
    ),
    [],
  );
});

Deno.test("loop lowering does not create a second unused binding", async () => {
  const source = `for ever:
  let forgotten = 1
return ()
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_BINDING"
    ).length,
    1,
  );
});

Deno.test("an effect result used after a statement suite is not unused", async () => {
  const source = `let value = ()
if refresh:
  value <- reload ()
return value
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("effect continuation fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_EFFECT_RESULT"
    ),
    [],
  );
});

Deno.test("every default operator target has a spelling action", async () => {
  for (const fixity of DEFAULT_FIXITIES) {
    const target = fixity.target.join(".");
    const source = fixity.associativity === "prefix"
      ? `return ${target} operand\n`
      : `return ${target} left right\n`;
    const parsed = await parseConcrete(source);
    if (!parsed.ok) {
      throw new Error(`operator fixture for ${target} did not parse`);
    }
    const diagnostic = lintModule(parsed.module, source, parsed.cst).find(
      (candidate) => candidate.code === "BLOT_LINT_OPERATOR_SPELLING",
    );
    assert(diagnostic !== undefined, `${target} has no operator diagnostic`);
    const fix = diagnostic.fix;
    if (fix === null) throw new Error(`${target} lost its operator action`);
    const replacement = source.slice(0, fix.span.start) + fix.replacement +
      source.slice(fix.span.end);
    assert(
      (await parseConcrete(replacement)).ok,
      `${target} produced invalid operator syntax: ${replacement}`,
    );
  }
});

Deno.test("a terminal Option match offers a guard action", async () => {
  const source = `let unwrap = fn option =>
  return case option of
    #None =>
      return ()
    #Some value => value
return unwrap
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("guard action fixture did not parse");
  const diagnostic = lintModule(parsed.module, source, parsed.cst).find(
    (candidate) => candidate.code === "BLOT_LINT_GUARD_SHAPED_CASE",
  );
  const fix = diagnostic?.fix;
  assert(fix !== null && fix !== undefined);
  const replacement = source.slice(0, fix.span.start) + fix.replacement +
    source.slice(fix.span.end);
  assert((await parseConcrete(replacement)).ok, replacement);
  assert(replacement.includes("if let #Some value = option else:"));
});

Deno.test("rule visitors cover effect rows and structural interfaces", async () => {
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
});
