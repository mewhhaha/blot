import { assert, assertEquals } from "@std/assert";
import { Compiler } from "../../compiler.ts";
import { decodeManifest } from "../../abi_values.ts";
import { instantiateArtifact } from "../../host.ts";
import { DEFAULT_LINT_RULES, lintModule } from "../lint.ts";
import {
  applyLintFix,
  validateLintDiagnosticsWithCompiler,
} from "./validation.ts";
import { formatSource } from "../formatter.ts";

const fixtures = [
  {
    "name": "field-shorthand",
    "before":
      "let count = 2\nlet { .enabled = enabled; } = { .enabled = True; }\nreturn { .count = count; .enabled = enabled; }\n\n",
    "code": "BLOT_LINT_FIELD_SHORTHAND",
  },
  {
    "name": "projection-destructuring",
    "before":
      "let settings = { .minimum = 2; .maximum = 8; }\nlet minimum = settings.minimum\nlet maximum = settings.maximum\nreturn maximum - minimum\n",
    "code": "BLOT_LINT_PROJECTION_DESTRUCTURING",
  },
  {
    "name": "parameter-destructuring",
    "before":
      "\nlet width = fn rectangle => do:\n  let { .left; .right; } = rectangle\n  return right - left\nreturn width { .left = 2; .right = 8; }\n",
    "code": "BLOT_LINT_PARAMETER_DESTRUCTURING",
  },
  {
    "name": "selective-open",
    "before":
      "const colours = { .red = 3; .blue = 7; .green = 11; }\nopen colours\nreturn red + blue\n",
    "code": "BLOT_LINT_SELECTIVE_OPEN",
  },
  {
    "name": "local-open",
    "before":
      "const arithmetic = { .double = fn value => value * 2; .zero = 0; }\nopen arithmetic\nlet run = fn value => do:\n  let result = double value\n  return result + 1\nreturn run 20\n",
    "code": "BLOT_LINT_LOCAL_OPEN",
  },
  {
    "name": "terminal-value-forwarding",
    "before":
      "\nlet double = fn value => do:\n  let result = value * 2\n  return result\nreturn double 21\n",
    "code": "BLOT_LINT_TERMINAL_VALUE_FORWARDING",
  },
  {
    "name": "identity-case",
    "before":
      "let keep :: Option Int -> Option Int\nlet keep = fn option => case option of\n  #None => #None\n  #Some value => #Some value\nreturn (keep (Some 2), keep None)\n",
    "code": "BLOT_LINT_IDENTITY_VARIANT_CASE",
  },
  {
    "name": "forwarding-lambda",
    "before":
      "let increment = fn value => value + 1\nreturn map ([1, 2], fn value => increment value)\n",
    "code": "BLOT_LINT_FORWARDING_CALLBACK",
  },
  {
    "name": "public-primitive",
    "before": "\nlet twice = fn value => @int.mul value 2\nreturn twice 21\n",
    "code": "BLOT_LINT_PUBLIC_PRIMITIVE",
  },
  {
    "name": "handler-pipeline",
    "before":
      "const Read = @effect { .get = Unit -> Int; }\nconst Add = @effect { .plus = Int -> Int; }\nlet program = fn () => do:\n  use value <- Read.get ()\n  return Add.plus value\nlet reading = { .get = fn ((), ?resume) => resume 20; }\nlet adding = { .plus = fn (value, ?resume) => resume (value + 22); }\nlet handled = fn () => @handle (Read, fn () => @handle (Add, program, adding), reading)\nuse result <- handled\nreturn result\n",
    "code": "BLOT_LINT_HANDLER_PIPELINE",
  },
  {
    "name": "identity-handler-return",
    "before":
      "const Read = @effect { .get = Unit -> Int; }\nlet program = fn () => Read.get ()\nreturn @handle (Read, program, {\n  .get = fn ((), ?resume) => resume 42;\n  .return = fn value => value;\n})\n\n",
    "code": "BLOT_LINT_IDENTITY_HANDLER_RETURN",
  },
  {
    "name": "terminal-continue",
    "before":
      "let total :: Int\nlet total = 0\nfor value in Iter.range (0, 5):\n  total := total + value\n  continue\nreturn total\n",
    "code": "BLOT_LINT_TERMINAL_CONTINUE",
  },
  {
    "name": "refutable-loop-pattern",
    "before":
      "let total :: Int\nlet total = 0\nfor candidate in Iter.items [Some 2, None, Some 5]:\n  if let #Some value = candidate else:\n    continue\n  total := total + value\nreturn total\n",
    "code": "BLOT_LINT_FILTERING_LOOP_PATTERN",
  },
  {
    "name": "iterator-to-for",
    "before":
      "let source = Iter.range (0, 5)\nlet rec walk = fn (state, total) => case source.step state of\n  #None => total\n  #Some (value, next) => walk (next, total + value)\nreturn walk (source.state, 0)\n\n",
    "code": "BLOT_LINT_ITERATOR_LOOP",
  },
  {
    "name": "fold-to-for",
    "before":
      "\nlet sum = fn values => fold (values, 0, fn (total, value) => total + value)\nreturn sum [1, 2, 3]\n",
    "code": "BLOT_LINT_ACCUMULATOR_FOLD",
  },
  {
    "name": "variant-map",
    "before":
      "let increment = fn value => value + 1\nlet change :: Option Int -> Option Int\nlet change = fn option => case option of\n  #None => #None\n  #Some value => #Some (increment value)\nreturn (change (Some 1), change None)\n",
    "code": "BLOT_LINT_VARIANT_MAP",
  },
  {
    "name": "variant-and-then",
    "before":
      "let validate = fn value => case value > 0 of\n  #True => Some value\n  #False => None\nlet change :: Option Int -> Option Int\nlet change = fn option => case option of\n  #None => #None\n  #Some value => validate value\nreturn (change (Some 1), change (Some 0), change None)\n",
    "code": "BLOT_LINT_VARIANT_CHAINING",
  },
  {
    "name": "variant-fallback",
    "before":
      "let fallback = fn () => 42\nlet unwrap :: Option Int -> Int\nlet unwrap = fn option => case option of\n  #None => fallback ()\n  #Some value => value\nreturn (unwrap (Some 7), unwrap None)\n",
    "code": "BLOT_LINT_VARIANT_FALLBACK",
  },
  {
    "name": "paired-filter-partition",
    "before":
      "let values = [1, 2, 3, 4]\nlet even = fn value => Int.lt value 3\nlet accepted = filter (values, even)\nlet rejected = filter (values, fn value => not (even value))\nreturn (accepted, rejected)\n",
    "code": "BLOT_LINT_COMPLEMENTARY_FILTERS",
  },
  {
    "name": "array-find",
    "before":
      "\nlet find :: [Int] -> Option Int\nlet find = fn values => do:\n  let found = None\n  for value in Iter.items values:\n    if value > 2:\n      found := Some value\n      break\n  return found\nreturn (find [], find [1, 2], find [1, 3, 4])\n",
    "code": "BLOT_LINT_ARRAY_FIND",
  },
  {
    "name": "result-map",
    "code": "BLOT_LINT_VARIANT_MAP",
    "before":
      'let increment = fn value => value + 1\nlet change :: Result (Int, Text) -> Result (Int, Text)\nlet change = fn result => case result of\n  #Error error => #Error error\n  #Ok value => #Ok (increment value)\nreturn (change (#Ok 1), change (#Error "no"))\n',
  },
  {
    "name": "result-map-error",
    "code": "BLOT_LINT_VARIANT_MAP",
    "before":
      'let label = fn text => Text.append text "!"\nlet change :: Result (Int, Text) -> Result (Int, Text)\nlet change = fn result => case result of\n  #Ok value => #Ok value\n  #Error error => #Error (label error)\nreturn (change (#Ok 1), change (#Error "no"))\n',
  },
  {
    "name": "result-fallback",
    "code": "BLOT_LINT_VARIANT_FALLBACK",
    "before":
      'let recover = fn text => Text.length text\nlet unwrap :: Result (Int, Text) -> Int\nlet unwrap = fn result => case result of\n  #Ok value => value\n  #Error error => recover error\nreturn (unwrap (#Ok 7), unwrap (#Error "no"))\n',
  },
  {
    "name": "effectful-map",
    "code": "BLOT_LINT_VARIANT_MAP",
    "before":
      'const Console = @effect { .write = Text -> Unit; }\nlet increment = fn value => do:\n  use Console.write "mapped"\n  return value + 1\nlet change = fn option => case option of\n  #None => #None\n  #Some value => #Some (increment value)\nlet program = fn () => (change (Some 1), change None)\nreturn @handle (Console, program, {\n  .write = fn (text, ?resume) => Text.append text (resume ());\n  .return = fn result => "";\n})\n',
  },
  {
    "name": "undemanded-fallback",
    "code": "BLOT_LINT_VARIANT_FALLBACK",
    "before":
      "let fallback = fn () => @int.div 1 0\nlet unwrap :: Option Int -> Int\nlet unwrap = fn option => case option of\n  #None => fallback ()\n  #Some value => value\nreturn unwrap (Some 7)\n",
  },
];

Deno.test("idiom actions preserve checked interfaces and evaluation", async (test) => {
  const compiler = await Compiler.create();
  const validation = await Compiler.create();
  try {
    for (const fixture of fixtures) {
      await test.step(fixture.name, async () => {
        const path = `/tmp/blot-idiom-${fixture.name}.blot`;
        const source = `open import "blot:prelude"\n${fixture.before}`;
        const analysis = await compiler.analyzeSource(path, source);
        const original = await compiler.evaluate(path);
        const originalWasm = await observeWasm(compiler, path);
        const syntax = await compiler.syntaxSnapshot(path, source);
        const rule = DEFAULT_LINT_RULES.find((rule) =>
          rule.code === fixture.code
        );
        assert(rule, fixture.code);
        const candidates = lintModule(
          syntax.module,
          source,
          syntax.cst,
          [rule],
          analysis,
        );
        const diagnostics = await validateLintDiagnosticsWithCompiler(
          validation,
          path,
          source,
          candidates,
        );
        assert(
          diagnostics.length > 0,
          `${fixture.code}: no validated action (${
            JSON.stringify(candidates)
          })`,
        );
        const fix = diagnostics[0].fix;
        assert(fix, fixture.code);
        const replacement = applyLintFix(source, fix);
        const checked = await compiler.checkSource(path, replacement);
        assertEquals(checked.interfaceKey, analysis.interfaceKey);
        const evaluated = await compiler.evaluate(path);
        assertEquals(evaluated, original, replacement);
        assertEquals(
          await observeWasm(compiler, path),
          originalWasm,
          replacement,
        );
        const formatted = await formatSource(replacement);
        assert(formatted.ok, replacement);
        const again = await formatSource(formatted.source);
        assertEquals(again, formatted, `${fixture.name} formatting drift`);
        await compiler.releaseRoot(path);
        await validation.releaseRoot(path);
      });
    }
  } finally {
    compiler.destroy();
    validation.destroy();
  }
});

async function observeWasm(compiler: Compiler, path: string) {
  const artifact = await compiler.compile(path);
  const manifest = decodeManifest(artifact.manifestBytes);
  const hosted = await instantiateArtifact(artifact);
  try {
    const observations = [];
    for (const exported of manifest.exports) {
      assert(
        exported.function !== null && exported.function.parameters.length === 0,
        "idiom fixture must have closed runtime observations",
      );
      observations.push({
        name: exported.sourceName,
        value: await hosted.callAsync(exported.sourceName),
      });
    }
    return observations;
  } finally {
    await hosted.close();
  }
}

Deno.test("idiom rules withhold actions without their demand, scope, and trivia premises", async (test) => {
  const compiler = await Compiler.create();
  const scenarios = [
    {
      code: "BLOT_LINT_PROJECTION_DESTRUCTURING",
      source: `let record = { .left = 1; .right = 2; }
let left = record.left
// Keep this explanation between the projections.
let right = record.right
return left + right
`,
    },
    {
      code: "BLOT_LINT_PARAMETER_DESTRUCTURING",
      source: `let left = fn pair => do:
  let { .first; .second; } = pair
  return first
return left { .first = 1; .second = 2; }
`,
    },
    {
      code: "BLOT_LINT_PUBLIC_PRIMITIVE",
      source: `const Int = { .mul = fn left => fn right => 99; }
return @int.mul 2 3
`,
    },
    {
      code: "BLOT_LINT_VARIANT_MAP",
      source: `const Option = { .map = fn transform => fn option => #None; }
let increment = fn value => value + 1
let change = fn option => case option of
  #None => #None
  #Some value => #Some (increment value)
return change (#Some 1)
`,
    },
    {
      code: "BLOT_LINT_VARIANT_MAP",
      source: `let change = fn ~transform => fn option => case option of
  #None => #None
  #Some value => #Some (transform value)
return change (fn value => value + 1) (#Some 2)
`,
    },
    {
      code: "BLOT_LINT_FORWARDING_CALLBACK",
      source: `let identity = fn value => value
return (fn ~value => identity value, ())
`,
    },
    {
      code: "BLOT_LINT_COMPLEMENTARY_FILTERS",
      source: `let values = [1, 2, 3]
let predicate = fn value => @int.div 1 value > 0
let accepted = filter (values, predicate)
let rejected = filter (values, fn value => not (predicate value))
return (accepted, rejected)
`,
    },
    {
      code: "BLOT_LINT_PROJECTION_DESTRUCTURING",
      source: `let width = fn ~rectangle => do:
  let left = rectangle.left
  let right = rectangle.right
  return right - left
return width { .left = 2; .right = 8; }
`,
    },
    {
      code: "BLOT_LINT_COMPLEMENTARY_FILTERS",
      source: `let split = fn ~values => do:
  let predicate = fn value => Int.lt value 3
  let accepted = filter (values, predicate)
  let rejected = filter (values, fn value => not (predicate value))
  return (accepted, rejected)
return split [1, 2, 3]
`,
    },
    {
      code: "BLOT_LINT_COMPLEMENTARY_FILTERS",
      source: `let split = fn ~threshold => do:
  let values = [1, 2, 3]
  let predicate = fn value => Int.lt value threshold
  let accepted = filter (values, predicate)
  let rejected = filter (values, fn value => not (predicate value))
  return (accepted, rejected)
return split 3
`,
    },
    {
      code: "BLOT_LINT_ACCUMULATOR_FOLD",
      source: `let make = fn () => [1, 2]
return fold (make (), 0, fn (total, value) => total + value)
`,
    },
    {
      code: "BLOT_LINT_ITERATOR_LOOP",
      source: `let sum = fn ~source => do:
  let rec walk = fn (state, total) => case source.step state of
    #None => total
    #Some (value, next) => walk (next, total + value)
  return walk (source.state, 0)
return sum (Iter.range (0, 5))
`,
    },
    {
      code: "BLOT_LINT_TERMINAL_CONTINUE",
      source: `for value in Iter.range (0, 2):
  continue
return ()
`,
    },
    {
      code: "BLOT_LINT_FILTERING_LOOP_PATTERN",
      source: `let found = None
for candidate in Iter.items [Some 1, None]:
  if let #Some value = candidate else:
    continue
  found := candidate
return found
`,
    },
  ];
  try {
    for (const scenario of scenarios) {
      await test.step(scenario.code, async () => {
        const path = "/tmp/blot-idiom-premise.blot";
        const source = `open import "blot:prelude"\n${scenario.source}`;
        const analysis = await compiler.analyzeSource(path, source);
        const syntax = await compiler.syntaxSnapshot(path, source);
        const rules = DEFAULT_LINT_RULES.filter((rule) =>
          rule.code === scenario.code
        );
        const candidates = lintModule(
          syntax.module,
          source,
          syntax.cst,
          rules,
          analysis,
        );
        assert(
          !candidates.some((diagnostic) => diagnostic.fix !== null),
          JSON.stringify(candidates),
        );
        await compiler.releaseRoot(path);
      });
    }
  } finally {
    compiler.destroy();
  }
});
