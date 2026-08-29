import { assert, assertEquals } from "@std/assert";
import { parseConcrete } from "../syntax/parse.ts";
import { DEFAULT_FIXITIES } from "../syntax/fixity.ts";
import type { Expr, Module } from "../syntax/ast.ts";
import type { Rule } from "../syntax/cursor.ts";
import type {
  CompilerReadabilityFact,
  CompilerSimplificationFact,
  CompilerSpecializationFact,
} from "../compiler/wasm.ts";
import { DEFAULT_LINT_RULES, lintModule } from "./lint.ts";
import type { LintRule } from "./lint.ts";
import { binaryCall } from "./lint/syntax.ts";

function rendererSimplificationFacts(
  module: Module,
  source: string,
  cst: Rule,
): readonly CompilerSimplificationFact[] {
  const expressions: Expr[] = [];
  const collector: LintRule = {
    name: "collect-renderer-expressions",
    code: "BLOT_LINT_EQUALITY_CASE",
    severity: "hint",
    create() {
      return { expression: (path) => expressions.push(path.node) };
    },
  };
  lintModule(module, source, cst, [collector]);
  const facts: CompilerSimplificationFact[] = [];
  for (const expression of expressions) {
    const call = binaryCall(expression);
    if (call === null) continue;
    const operator = source.slice(call.left.span.end, call.right.span.start)
      .trim();
    if (operator === "&&") {
      facts.push({
        kind: "short-circuit-and",
        span: expression.span,
        left: call.left.span,
        right: call.right.span,
      });
      continue;
    }
    if (operator !== "==") continue;
    if (call.right.tag === "int" && call.left.tag !== "int") {
      facts.push({
        kind: "integer-equality",
        span: expression.span,
        subject: call.left.span,
        pattern: { kind: "integer-literal", span: call.right.span },
      });
      continue;
    }
    if (call.left.tag === "int" && call.right.tag !== "int") {
      facts.push({
        kind: "integer-equality",
        span: expression.span,
        subject: call.right.span,
        pattern: { kind: "integer-literal", span: call.left.span },
      });
      continue;
    }
    if (call.right.tag === "var") {
      facts.push({
        kind: "integer-equality",
        span: expression.span,
        subject: call.left.span,
        pattern: { kind: "integer-pin", name: call.right.name },
      });
    }
  }
  return facts;
}

async function applyLintFix(
  source: string,
  code: string,
  readability: readonly CompilerReadabilityFact[] = [],
): Promise<string> {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error(`lint fixture for ${code} did not parse`);
  const diagnostic = lintModule(
    parsed.module,
    source,
    parsed.cst,
    DEFAULT_LINT_RULES,
    {
      simplifications: rendererSimplificationFacts(
        parsed.module,
        source,
        parsed.cst,
      ),
      readability,
    },
  ).find(
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
  const source = `let label = fn n => do:
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
    lintModule(parsed.module, source, parsed.cst, DEFAULT_LINT_RULES, {
      simplifications: rendererSimplificationFacts(
        parsed.module,
        source,
        parsed.cst,
      ),
    }).filter((diagnostic) => diagnostic.code === "BLOT_LINT_NESTED_IF_CHAIN"),
    [],
  );
  const fixed = await applyLintFix(source, "BLOT_LINT_IF_CHAIN");

  assertEquals(
    fixed,
    `let label = fn n => do:
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

Deno.test("an equality ladder fix preserves grouped branch expressions", async () => {
  const source = `let select = fn quadrant => do:
  if quadrant == 0:
    return table_at step
  else if quadrant == 1:
    return table_at (quarter - step)
  else:
    return negate (table_at step)
return select
`;

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_IF_CHAIN"),
    `let select = fn quadrant => do:
  return case quadrant of
    0 => table_at step
    1 => table_at (quarter - step)
    _ => negate (table_at step)
return select
`,
  );
});

Deno.test("a nested statement conditional becomes an else-if ladder", async () => {
  const source = `let choose = fn () => do:
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
    `let choose = fn () => do:
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
  const source = `let choose = fn () => do:
  if first:
    use one ()
  else:
    if second:
      use two ()
    use finish ()
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

Deno.test("a nested case decision tree becomes one demand-driven case", async () => {
  const source = `return case first of
  #One => 1
  #More => case second of
    #One => 2
    #More => case third of
      #One => 3
      #More => 4
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_NESTED_CASE_CHAIN"),
    `return case first, second, third of
  #One, _, _ => 1
  #More, #One, _ => 2
  #More, #More, #One => 3
  #More, #More, #More => 4
`,
  );
});

Deno.test("two nested cases become one demand-driven case", async () => {
  const source = `return case first of
  #True => 1
  #False => case second of
    #True => 2
    #False => 3
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_NESTED_CASE_CHAIN"),
    `return case first, second of
  #True, _ => 1
  #False, #True => 2
  #False, #False => 3
`,
  );
});

Deno.test("a Boolean equality case matches the compared value directly", async () => {
  const source = `return case 0 == value of
  #False => "nonzero"
  #True => "zero"
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_EQUALITY_CASE"),
    `return case value of
  0 => "zero"
  _ => "nonzero"
`,
  );
});

Deno.test("conjoined equality checks become one demand-driven case", async () => {
  const source = `return case x == 0 && y == 0 of
  #True => "origin"
  #False => "elsewhere"
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_EQUALITY_CASE"),
    `return case x, y of
  0, 0 => "origin"
  _, _ => "elsewhere"
`,
  );
});

Deno.test("a named equality call without compiler facts remains explicit", async () => {
  const source = `return case Int.eq value 0 of
  #True => "zero"
  #False => "nonzero"
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("named equality fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_EQUALITY_CASE"
    ),
    [],
  );
});

Deno.test("an equality case fix preserves multiline arm bodies", async () => {
  const source = `let classify = fn value => case value == 0 of
  #True => do:
    let label = "zero"
    return label
  #False => do:
    let label = "nonzero"
    return label
return classify
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_EQUALITY_CASE"),
    `let classify = fn value => case value of
  0 => do:
    let label = "zero"
    return label
  _ => do:
    let label = "nonzero"
    return label
return classify
`,
  );
});

Deno.test("an equality case pins a stable comparison value", async () => {
  const source = `let expected = 0
return case record.kind == expected of
  #True => "expected"
  #False => "other"
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_EQUALITY_CASE"),
    `let expected = 0
return case record.kind of
  ^expected => "expected"
  _ => "other"
`,
  );
});

Deno.test("a pinned case pattern reads its existing binding", async () => {
  const source = `let expected = 0
return case value of
  ^expected => "expected"
  _ => "other"
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("pinned pattern fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_BINDING"
    ),
    [],
  );
});

Deno.test("a discarded Boolean case becomes statement control flow", async () => {
  const source = `let run = fn hidden => do:
  use case hidden of
    #True => ()
    #False => draw ()
  return ()
return run
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_DISCARDED_BOOLEAN_CASE"),
    `let run = fn hidden => do:
  if hidden:
    use ()
  else:
    use draw ()
  return ()
return run
`,
  );
});

Deno.test("a discarded Boolean case preserves text literal whitespace", async () => {
  const source = `let run = fn ready => do:
  use case accepts "a  b" of
    #True => draw ()
    #False => hide ()
  return ()
return run
`;
  const fixed = await applyLintFix(
    source,
    "BLOT_LINT_DISCARDED_BOOLEAN_CASE",
  );
  assert(fixed.includes('if accepts "a  b":'));
});

Deno.test("a discarded two-effect Boolean case becomes an if-else", async () => {
  const source = `let run = fn ready => do:
  use case ready of
    #False => hide ()
    #True => draw ()
  return ()
return run
`;
  assertEquals(
    await applyLintFix(source, "BLOT_LINT_DISCARDED_BOOLEAN_CASE"),
    `let run = fn ready => do:
  if ready:
    use draw ()
  else:
    use hide ()
  return ()
return run
`,
  );
});

Deno.test("an identical-branch rewrite still evaluates its condition", async () => {
  const source = `let flag = #True
if flag:
  return 1
else:
  return 1
`;

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_IDENTICAL_CONDITIONAL_BRANCHES"),
    `let flag = #True
let _ = flag
return 1
`,
  );
});

Deno.test("a single-return do block becomes its returned expression", async () => {
  assertEquals(
    await applyLintFix(
      `let increment = fn value => do:
  return value + 1
return increment
`,
      "BLOT_LINT_REDUNDANT_DO_BLOCK",
    ),
    `let increment = fn value => (value + 1)
return increment
`,
  );
});

Deno.test("a redundant do fix preserves operator grouping", async () => {
  assertEquals(
    await applyLintFix(
      `open import "blot:prelude"
return 2 * do:
  return 3 + 4
`,
      "BLOT_LINT_REDUNDANT_DO_BLOCK",
    ),
    `open import "blot:prelude"
return 2 * (3 + 4)
`,
  );
});

Deno.test("a redundant do fix dedents a multiline expression", async () => {
  assertEquals(
    await applyLintFix(
      `let pair = fn value => do:
  return (
    value,
    value + 1
  )
return pair
`,
      "BLOT_LINT_REDUNDANT_DO_BLOCK",
    ),
    `let pair = fn value => (
  value,
  value + 1
)
return pair
`,
  );
});

Deno.test("a do block with a declaration keeps its return scope", async () => {
  const source = `let increment = fn value => do:
  let next = value + 1
  return next
return increment
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("nontrivial do fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_REDUNDANT_DO_BLOCK"
    ),
    [],
  );
});

Deno.test("an early return makes its terminal else redundant", async () => {
  assertEquals(
    await applyLintFix(
      `let label = fn value => do:
  if value == 0:
    return "zero"
  else:
    let next = value + 1
    return Text.of_int next
return label
`,
      "BLOT_LINT_REDUNDANT_TERMINAL_ELSE",
    ),
    `let label = fn value => do:
  if value == 0:
    return "zero"
  let next = value + 1
  return Text.of_int next
return label
`,
  );
});

Deno.test("a nonterminal else keeps its local bindings scoped", async () => {
  const source = `let choose = fn ready => do:
  let value = 0
  if ready:
    return 1
  else:
    let hidden = 2
    value := hidden
  return value
return choose
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("nonterminal else fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_REDUNDANT_TERMINAL_ELSE"
    ),
    [],
  );
});

Deno.test("a nested conditional retains the ladder-specific action", async () => {
  const source = `let choose = fn value => do:
  if first value:
    return 1
  else:
    if second value:
      return 2
    else:
      return 3
return choose
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("nested conditional fixture did not parse");
  const diagnostics = lintModule(parsed.module, source, parsed.cst);
  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_LINT_NESTED_IF_CHAIN"
    ),
  );
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_REDUNDANT_TERMINAL_ELSE"
    ),
    [],
  );
});

Deno.test("an empty left append returns the right array", async () => {
  assertEquals(
    await applyLintFix(
      `return Array.append [] values
`,
      "BLOT_LINT_EMPTY_ARRAY_APPEND",
    ),
    `return values
`,
  );
});

Deno.test("an unused lambda parameter becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `return fn forgotten => 1
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `return fn _ => 1
`,
  );
});

Deno.test("an unused module parameter becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `module with forgotten
return 1
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `module with _
return 1
`,
  );
});

Deno.test("an unused name in a compound parameter becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `return fn (used, forgotten) => used
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `return fn (used, _) => used
`,
  );
});

Deno.test("an unused name in a destructuring binding becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `let (used, forgotten) = pair
return used
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `let (used, _) = pair
return used
`,
  );
});

Deno.test("an owned sibling keeps an unused destructured name visible", async () => {
  assertEquals(
    await applyLintFix(
      `let (!owned, forgotten) = pair
return consume (!owned)
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `let (!owned, _) = pair
return consume (!owned)
`,
  );
});

Deno.test("a wholly unused destructuring binding prefers removal", async () => {
  const source = `let (first, second) = pair
return 0
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("unused destructuring fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_PATTERN_NAME"
    ),
    [],
  );
});

Deno.test("an unused effect destructuring name becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `use (first, second) <- effect ()
return ()
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `use (_, second) <- effect ()
return ()
`,
  );
});

Deno.test("an unused loop pattern name becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `let values = []
for forgotten in inputs:
  values := [...values, 0]
return values
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `let values = []
for _ in inputs:
  values := [...values, 0]
return values
`,
  );
});

Deno.test("an unused refutable loop pattern name becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `for case #Some forgotten in inputs:
  use draw ()
return ()
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `for case #Some _ in inputs:
  use draw ()
return ()
`,
  );
});

Deno.test("an unused case payload becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `return case option of
  #Some forgotten => 1
  #None => 0
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `return case option of
  #Some _ => 1
  #None => 0
`,
  );
});

Deno.test("an unused parameter in a computed field name becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `return { .[(fn forgotten => "field") ()] = 1; }
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `return { .[(fn _ => "field") ()] = 1; }
`,
  );
});

Deno.test("an unused multi-subject case name becomes a wildcard", async () => {
  assertEquals(
    await applyLintFix(
      `return case first, second of
  used, forgotten => used
`,
      "BLOT_LINT_UNUSED_PATTERN_NAME",
    ),
    `return case first, second of
  used, _ => used
`,
  );
});

Deno.test("read and semantically qualified parameters stay named", async () => {
  const source = `let read = fn value => value
let owned = fn !value => 0
let deferred = fn ~value => 0
let computed = fn name => { .[name] = 1; }
return (read, owned, deferred, computed)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("used pattern fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_PATTERN_NAME"
    ),
    [],
  );
});

Deno.test("a nonrecursive function without a signature drops rec", async () => {
  assertEquals(
    await applyLintFix(
      `let rec identity = fn value => value
return identity
`,
      "BLOT_LINT_UNNECESSARY_REC",
    ),
    `let identity = fn value => value
return identity
`,
  );
});

Deno.test("a nonrecursive function drops rec from its signature and binding", async () => {
  assertEquals(
    await applyLintFix(
      `let rec identity :: Int -> Int
let rec identity = fn value => value
return identity
`,
      "BLOT_LINT_UNNECESSARY_REC",
    ),
    `let identity :: Int -> Int
let identity = fn value => value
return identity
`,
  );
});

Deno.test("an independent recursive group drops every rec marker", async () => {
  assertEquals(
    await applyLintFix(
      `let rec first = fn value => value
let rec second = fn value => value
return (first, second)
`,
      "BLOT_LINT_UNNECESSARY_REC",
    ),
    `let first = fn value => value
let second = fn value => value
return (first, second)
`,
  );
});

Deno.test("self and mutually recursive functions keep rec", async () => {
  const source = `let rec loop = fn value => loop value
let separator = 0
let rec even = fn value => odd value
let rec odd = fn value => even value
return (loop, separator, even, odd)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("necessary rec fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNNECESSARY_REC"
    ),
    [],
  );
});

Deno.test("an inner recursive binding does not keep an outer rec", async () => {
  assertEquals(
    await applyLintFix(
      `let rec f = fn () => do:
  let rec f = fn () => f ()
  return f
return f
`,
      "BLOT_LINT_UNNECESSARY_REC",
    ),
    `let f = fn () => do:
  let rec f = fn () => f ()
  return f
return f
`,
  );
});

Deno.test("five positional parameters suggest named fields without a fix", async () => {
  const source = `return fn (a, b, c, d, e) => (a, b, c, d, e)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) {
    throw new Error("large positional tuple fixture did not parse");
  }

  const diagnostics = lintModule(parsed.module, source, parsed.cst).filter(
    (diagnostic) => diagnostic.code === "BLOT_LINT_LARGE_POSITIONAL_TUPLE",
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]?.fix, null);
});

Deno.test("five positional module parameters suggest named fields", async () => {
  const source = `module with (a, b, c, d, e)
return (a, b, c, d, e)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) {
    throw new Error("large positional module fixture did not parse");
  }

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_LARGE_POSITIONAL_TUPLE"
    ).length,
    1,
  );
});

Deno.test("a proved terminal effect result is returned directly", async () => {
  const source = `let run = fn () => do:
  use result <- load ()
  return result
return run
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("terminal effect fixture did not parse");
  const run = parsed.module.declarations[0];
  if (
    run === undefined || run.tag !== "binding" ||
    run.value.tag !== "lambda" || run.value.body.tag !== "block"
  ) {
    throw new Error("terminal effect fixture did not contain the run block");
  }
  const effect = run.value.body.declarations[0];
  if (effect === undefined || effect.tag !== "binding") {
    throw new Error("terminal effect fixture did not contain the effect");
  }
  const readability = [{
    kind: "direct-effect-computation",
    span: effect.value.span,
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(
      source,
      "BLOT_LINT_TERMINAL_EFFECT_FORWARDING",
      readability,
    ),
    `let run = fn () => do:
  return load ()
return run
`,
  );
});

Deno.test("terminal effect forwarding requires a compiler fact", async () => {
  const source = `let run = fn () => do:
  use result <- load ()
  return result
return run
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) {
    throw new Error("unproved terminal effect fixture did not parse");
  }

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_TERMINAL_EFFECT_FORWARDING"
    ),
    [],
  );
});

Deno.test("a bare effect value is not forwarded without compiler proof", async () => {
  const source = `let run = fn () => do:
  use result <- load
  return result
return run
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("bare terminal effect fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_TERMINAL_EFFECT_FORWARDING"
    ),
    [],
  );
});

Deno.test("a compiler-proved empty array uses literal spelling", async () => {
  const source = `return Array.empty
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("proved empty array fixture did not parse");
  const readability = [{
    kind: "empty-array",
    span: parsed.module.result.span,
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_EMPTY_ARRAY_SPELLING", readability),
    `return []
`,
  );
});

Deno.test("an empty array literal is already in canonical form", async () => {
  const source = `return []
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("empty array literal fixture did not parse");
  const readability = [{
    kind: "empty-array",
    span: parsed.module.result.span,
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    lintModule(parsed.module, source, parsed.cst, DEFAULT_LINT_RULES, {
      readability,
    }).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_EMPTY_ARRAY_SPELLING"
    ),
    [],
  );
});

Deno.test("a named empty array stays named", async () => {
  const source = `return empty
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("named empty array fixture did not parse");
  const readability = [{
    kind: "empty-array",
    span: parsed.module.result.span,
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    lintModule(parsed.module, source, parsed.cst, DEFAULT_LINT_RULES, {
      readability,
    }).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_EMPTY_ARRAY_SPELLING"
    ),
    [],
  );
});

Deno.test("readability facts never target synthetic loop expressions", async () => {
  const source = `let values = []
for value in inputs:
  values := [...values, value]
return values
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("loop readability fixture did not parse");
  const loopSpan = {
    start: source.indexOf("for value"),
    end: source.indexOf("return values"),
  };
  const copiedSourceStart = source.indexOf("values", source.indexOf("[..."));
  const readability: readonly CompilerReadabilityFact[] = [{
    kind: "empty-array",
    span: loopSpan,
  }, {
    kind: "record-reconstruction",
    span: loopSpan,
    source: {
      start: copiedSourceStart,
      end: copiedSourceStart + "values".length,
    },
    retained: [],
  }];

  assertEquals(
    lintModule(
      parsed.module,
      source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      { readability },
    ).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_EMPTY_ARRAY_SPELLING" ||
      diagnostic.code === "BLOT_LINT_RECORD_RECONSTRUCTION"
    ),
    [],
  );
});

Deno.test("a proved same-suite shadow uses stable rebinding", async () => {
  const source = `let count = 0
let next = count
let count = next
return count
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("stable shadow fixture did not parse");
  const shadow = parsed.module.declarations[2];
  if (shadow === undefined || shadow.tag !== "binding") {
    throw new Error("stable shadow fixture did not contain the second binding");
  }
  const readability = [{
    kind: "stable-shadow",
    span: shadow.value.span,
    name: "count",
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_STABLE_SHADOWING", readability),
    `let count = 0
let next = count
count := next
return count
`,
  );
});

Deno.test("a dead binding is removed instead of made stable", async () => {
  const source = `let count = 0
let count = next
return count
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("dead stable shadow fixture did not parse");
  const shadow = parsed.module.declarations[1];
  if (shadow === undefined || shadow.tag !== "binding") {
    throw new Error("dead stable shadow fixture lost its second binding");
  }
  const readability = [{
    kind: "stable-shadow",
    span: shadow.value.span,
    name: "count",
  }] satisfies readonly CompilerReadabilityFact[];
  const diagnostics = lintModule(
    parsed.module,
    source,
    parsed.cst,
    DEFAULT_LINT_RULES,
    { readability },
  );

  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_BINDING"
    ),
  );
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_STABLE_SHADOWING"
    ),
    [],
  );
});

Deno.test("an unread destructured name is not made stable", async () => {
  const source = `let (count, other) = pair
let count = 1
return (count, other)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) {
    throw new Error("partial stable shadow fixture did not parse");
  }
  const shadow = parsed.module.declarations[1];
  if (shadow === undefined || shadow.tag !== "binding") {
    throw new Error("partial stable shadow fixture lost its shadow");
  }
  const readability = [{
    kind: "stable-shadow",
    span: shadow.value.span,
    name: "count",
  }] satisfies readonly CompilerReadabilityFact[];
  const diagnostics = lintModule(
    parsed.module,
    source,
    parsed.cst,
    DEFAULT_LINT_RULES,
    { readability },
  );

  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_PATTERN_NAME"
    ),
  );
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_STABLE_SHADOWING"
    ),
    [],
  );
});

Deno.test("a stable shadow inside statement control flow stays explicit", async () => {
  const source = `if ready:
  let count = 0
  let count = next
return ()
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("nested stable shadow fixture did not parse");
  const control = parsed.module.declarations[0];
  if (
    control === undefined || control.tag !== "binding" ||
    control.value.tag !== "if"
  ) {
    throw new Error(
      "nested stable shadow fixture did not contain the conditional",
    );
  }
  const consequence = control.value.branches[0]?.consequence;
  if (consequence === undefined || consequence.tag !== "block") {
    throw new Error(
      "nested stable shadow fixture did not contain the consequence",
    );
  }
  const shadow = consequence.declarations[1];
  if (shadow === undefined || shadow.tag !== "binding") {
    throw new Error("nested stable shadow fixture did not contain the shadow");
  }
  const readability = [{
    kind: "stable-shadow",
    span: shadow.value.span,
    name: "count",
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    lintModule(parsed.module, source, parsed.cst, DEFAULT_LINT_RULES, {
      readability,
    }).filter((diagnostic) => diagnostic.code === "BLOT_LINT_STABLE_SHADOWING"),
    [],
  );
});

Deno.test("a type-changing shadow without a compiler fact stays a let", async () => {
  const source = `let value = 0
let value = "zero"
return value
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("type-changing shadow fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_STABLE_SHADOWING"
    ),
    [],
  );
});

Deno.test("an unchanged record reconstruction uses its source", async () => {
  const source = `return { .x = original.x; .y = original.y; }
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("record identity fixture did not parse");
  const record = parsed.module.result;
  if (record.tag !== "shape") {
    throw new Error("record identity fixture did not contain a record");
  }
  const first = record.members[0];
  if (
    first === undefined || first.tag !== "field" ||
    first.value.tag !== "field"
  ) {
    throw new Error("record identity fixture did not contain the source field");
  }
  const readability = [{
    kind: "record-reconstruction",
    span: record.span,
    source: first.value.target.span,
    retained: [],
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(
      source,
      "BLOT_LINT_RECORD_RECONSTRUCTION",
      readability,
    ),
    `return original
`,
  );
});

Deno.test("a changed record reconstruction spreads its source", async () => {
  const source = `return { .x = original.x; .y = replacement; }
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("record spread fixture did not parse");
  const record = parsed.module.result;
  if (record.tag !== "shape") {
    throw new Error("record spread fixture did not contain a record");
  }
  const first = record.members[0];
  if (
    first === undefined || first.tag !== "field" ||
    first.value.tag !== "field"
  ) {
    throw new Error("record spread fixture did not contain the source field");
  }
  const readability = [{
    kind: "record-reconstruction",
    span: record.span,
    source: first.value.target.span,
    retained: ["y"],
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(
      source,
      "BLOT_LINT_RECORD_RECONSTRUCTION",
      readability,
    ),
    `return { ...original; .y = replacement; }
`,
  );
});

Deno.test("an unused open is removed when the compiler observes no names", async () => {
  const source = `let Scope = { .hidden = 1; }
open Scope
return 0
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("unused open fixture did not parse");
  const open = parsed.module.declarations[1];
  if (open === undefined || open.tag !== "open") {
    throw new Error("unused open fixture did not contain the open declaration");
  }
  const readability = [{
    kind: "open-usage",
    span: open.value.span,
    used: [],
    shadowed: [],
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_UNUSED_OPEN", readability),
    `let Scope = { .hidden = 1; }
return 0
`,
  );
});

Deno.test("an unused open is removed from a nonempty statement suite", async () => {
  const source = `if ready:
  open Scope
  use draw ()
return ()
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("suite open fixture did not parse");
  const control = parsed.module.declarations[0];
  if (
    control === undefined || control.tag !== "binding" ||
    control.value.tag !== "if"
  ) throw new Error("suite open fixture lost its conditional");
  const consequence = control.value.branches[0]?.consequence;
  if (consequence === undefined || consequence.tag !== "block") {
    throw new Error("suite open fixture lost its consequence");
  }
  const open = consequence.declarations[0];
  if (open === undefined || open.tag !== "open") {
    throw new Error("suite open fixture lost its opening");
  }
  const readability = [{
    kind: "open-usage",
    span: open.value.span,
    used: [],
    shadowed: [],
  }] satisfies readonly CompilerReadabilityFact[];

  assertEquals(
    await applyLintFix(source, "BLOT_LINT_UNUSED_OPEN", readability),
    `if ready:
  use draw ()
return ()
`,
  );
});

Deno.test("an unused open keeps an empty statement suite valid", async () => {
  const source = `if ready:
  open Scope
return ()
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("sole open fixture did not parse");
  const control = parsed.module.declarations[0];
  if (
    control === undefined || control.tag !== "binding" ||
    control.value.tag !== "if"
  ) throw new Error("sole open fixture lost its conditional");
  const consequence = control.value.branches[0]?.consequence;
  if (consequence === undefined || consequence.tag !== "block") {
    throw new Error("sole open fixture lost its consequence");
  }
  const open = consequence.declarations[0];
  if (open === undefined || open.tag !== "open") {
    throw new Error("sole open fixture lost its opening");
  }
  const readability = [{
    kind: "open-usage",
    span: open.value.span,
    used: [],
    shadowed: [],
  }] satisfies readonly CompilerReadabilityFact[];
  const diagnostic = lintModule(
    parsed.module,
    source,
    parsed.cst,
    DEFAULT_LINT_RULES,
    { readability },
  ).find((candidate) => candidate.code === "BLOT_LINT_UNUSED_OPEN");

  assertEquals(diagnostic?.fix, null);
});

Deno.test("open shadowing reports only names the compiler observed", async () => {
  const source = `let value = 0
let silent = 0
let Scope = { .value = 1; .silent = 2; }
open Scope
return value
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("open shadow fixture did not parse");
  const open = parsed.module.declarations[3];
  if (open === undefined || open.tag !== "open") {
    throw new Error("open shadow fixture did not contain the open declaration");
  }
  const readability = [{
    kind: "open-usage",
    span: open.value.span,
    used: ["value"],
    shadowed: ["value"],
  }] satisfies readonly CompilerReadabilityFact[];

  const diagnostics = lintModule(
    parsed.module,
    source,
    parsed.cst,
    DEFAULT_LINT_RULES,
    { readability },
  ).filter((diagnostic) => diagnostic.code === "BLOT_LINT_OPEN_SHADOW");
  assertEquals(diagnostics.length, 1);
  assertEquals(
    diagnostics[0]?.message,
    "This `open` shadows the previously visible name `value`.",
  );
  assertEquals(diagnostics[0]?.fix, null);
});

Deno.test("four positional parameters stay below the readability limit", async () => {
  const source = `return fn (a, b, c, d) => (a, b, c, d)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) {
    throw new Error("small positional tuple fixture did not parse");
  }

  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_LARGE_POSITIONAL_TUPLE"
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
    name: "a nested case tree is one decision matrix",
    code: "BLOT_LINT_NESTED_CASE_CHAIN",
    source: `return case first of
  #One => 1
  #More => case second of
    #One => 2
    #More => case third of
      #One => 3
      #More => 4
`,
  },
  {
    name: "a Boolean equality case matches its subject directly",
    code: "BLOT_LINT_EQUALITY_CASE",
    source: `return case value == 0 of
  #True => "zero"
  #False => "nonzero"
`,
  },
  {
    name: "a discarded Boolean case is statement control flow",
    code: "BLOT_LINT_DISCARDED_BOOLEAN_CASE",
    source: `let run = fn ready => do:
  use case ready of
    #True => draw ()
    #False => ()
  return ()
return run
`,
  },
  {
    name: "an Option failure arm can be written as a guard",
    code: "BLOT_LINT_GUARD_SHAPED_CASE",
    source: `let unwrap = fn option => do:
  return case option of
    #None => do:
      return ()
    #Some value => value
return unwrap
`,
  },
  {
    name: "a Boolean identity conditional returns its condition directly",
    code: "BLOT_LINT_BOOLEAN_IDENTITY_CONDITIONAL",
    source: `let flag = #True
if flag:
  return #True
else:
  return #False
`,
  },
  {
    name: "identical conditional branches collapse to their shared value",
    code: "BLOT_LINT_IDENTICAL_CONDITIONAL_BRANCHES",
    source: `let flag = #True
if flag:
  return 1
else:
  return 1
`,
  },
  {
    name: "a single-return do block is only its returned expression",
    code: "BLOT_LINT_REDUNDANT_DO_BLOCK",
    source: `let increment = fn value => do:
  return value + 1
return increment
`,
  },
  {
    name: "an early return makes a terminal else redundant",
    code: "BLOT_LINT_REDUNDANT_TERMINAL_ELSE",
    source: `let label = fn value => do:
  if value == 0:
    return "zero"
  else:
    return "other"
return label
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
    name: "a singleton append outside a fold pushes directly",
    code: "BLOT_LINT_SINGLETON_ARRAY_APPEND",
    source: `return Array.append values [next]
`,
  },
  {
    name: "an empty append returns the other array",
    code: "BLOT_LINT_EMPTY_ARRAY_APPEND",
    source: `return Array.append values []
`,
  },
  {
    name: "an explicit primitive function prefers its operator",
    code: "BLOT_LINT_OPERATOR_SPELLING",
    source: `return Int.rem 5 2
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
    source: `let run = fn () => do:
  use ignored <- perform_work ()
  return ()
return run
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
    const diagnostics = lintModule(
      parsed.module,
      ruleCase.source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      {
        simplifications: rendererSimplificationFacts(
          parsed.module,
          ruleCase.source,
          parsed.cst,
        ),
      },
    );
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === ruleCase.code),
      `${ruleCase.code} was absent from ${
        diagnostics.map((diagnostic) => diagnostic.code).join(", ")
      }`,
    );
  });
}

Deno.test("compiler facts disclose specialization count", async () => {
  const source = `let project = fn point => point.x
let first = project { .x = 1; }
let second = project { .x = 1; .y = 2; }
return (first, second)
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("specialization lint fixture did not parse");
  const first = parsed.module.declarations[0];
  let bindingSpan = { start: 0, end: 0 };
  if (first !== undefined) bindingSpan = first.span;
  const fact: CompilerSpecializationFact = {
    binding: {
      path: "/tmp/specialization.blot",
      name: "project",
      span: bindingSpan,
    },
    specializationCount: 2,
    softLimit: 2,
    hardLimit: 256,
    keys: ["{ .x = Int }", "{ .x = Int; .y = Int }"].map(
      (representation) => ({
        representation,
        reason: "parameter representation differs",
        callSites: [],
        runtimeHirNodes: 0,
        wasmFunctionBytes: 0,
      }),
    ),
  };
  const diagnostics = lintModule(
    parsed.module,
    source,
    parsed.cst,
    DEFAULT_LINT_RULES,
    { specializations: [fact] },
  );
  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_LINT_SPECIALIZATION_COUNT" &&
      diagnostic.message.includes("compiler-confirmed")
    ),
  );
});

Deno.test("every syntax-only lint fix produces accepted syntax", async () => {
  for (const ruleCase of RULE_CASES) {
    const parsed = await parseConcrete(ruleCase.source);
    if (!parsed.ok) {
      throw new Error(`lint fixture ${ruleCase.name} did not parse`);
    }
    const diagnostics = lintModule(
      parsed.module,
      ruleCase.source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      {
        simplifications: rendererSimplificationFacts(
          parsed.module,
          ruleCase.source,
          parsed.cst,
        ),
      },
    );
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
    const diagnostic = lintModule(
      parsed.module,
      ruleCase.source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      {
        simplifications: rendererSimplificationFacts(
          parsed.module,
          ruleCase.source,
          parsed.cst,
        ),
      },
    )
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

Deno.test("a proved lookup is silent when its rewrite cannot preserve comments", async () => {
  const source = `return case Array.get ([1], 0) of
  #Some value => value
  #None => do:
    // The fallback documents why this lookup remains total.
    return 0
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("commented lookup fixture did not parse");
  assertEquals(
    lintModule(parsed.module, source, parsed.cst).filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_PROVED_ARRAY_LOOKUP"
    ),
    [],
  );
});

Deno.test("a registered rule receives typed AST and concrete syntax visits", async () => {
  const source = `return chosen
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");
  let sawResult = false;
  const rule: LintRule = {
    name: "chosen-name",
    code: "BLOT_LINT_TEST_CHOSEN_NAME",
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
    ["BLOT_LINT_TEST_CHOSEN_NAME"],
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
  use value <- reload ()
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
  const source = `let unwrap = fn option => do:
  return case option of
    #None => do:
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
let run = fn () => do:
  use value <- Console.write ()
  return value
let composed = run
  |> @handle (Host, host_handler)
  |> @handle (Console, handler)
return (
  Empty Int,
  Length Text,
  Semigroup Int,
  Monoid Text,
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
    code: "BLOT_LINT_TEST_SURFACE_COVERAGE",
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
