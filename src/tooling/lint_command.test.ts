import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { Compiler } from "../compiler.ts";
import {
  fixLintSource,
  lintSource,
  parseLintArguments,
} from "./lint_command.ts";

Deno.test("lint arguments select report, check, and fix modes", () => {
  assertEquals(parseLintArguments(["example.blot"]), {
    ok: true,
    mode: "report",
    paths: ["example.blot"],
  });
  assertEquals(parseLintArguments(["--check", "example.blot"]), {
    ok: true,
    mode: "check",
    paths: ["example.blot"],
  });
  assertEquals(parseLintArguments(["example.blot", "--fix"]), {
    ok: true,
    mode: "fix",
    paths: ["example.blot"],
  });
  assertEquals(parseLintArguments(["--check", "--fix", "example.blot"]), {
    ok: false,
    message: "blot lint accepts either --check or --fix, not both",
  });
});

Deno.test("lint fixes reach a compiler-checked fixed point", async () => {
  const path = resolve("lint-command-fixture.blot");
  const source = `open import "blot:prelude"
return Op.rem 5 2
`;
  const analysisCompiler = await Compiler.create();
  const validationCompiler = await Compiler.create();
  const compilers = {
    analysis: analysisCompiler,
    validation: validationCompiler,
  };
  try {
    const reported = await lintSource(
      compilers,
      path,
      source,
    );
    assert(
      reported.diagnostics.some((diagnostic) =>
        diagnostic.code === "BLOT_LINT_OPERATOR_SPELLING"
      ),
    );

    const fixed = await fixLintSource(
      compilers,
      path,
      source,
    );
    assertEquals(
      fixed.source,
      `const { .Op; } = import "blot:prelude"
return (5 % 2)
`,
    );
    assertEquals(fixed.diagnostics, []);
    assertEquals(fixed.appliedFixes, 2);
  } finally {
    validationCompiler.destroy();
    analysisCompiler.destroy();
  }
});

Deno.test("selective imports preserve following comments", async () => {
  const analysis = await Compiler.create();
  const validation = await Compiler.create();
  const path = resolve("lint-selective-import-comment.blot");
  const source = `open import "blot:prelude"

// This explanation belongs to the result.
return Op.rem 5 2
`;
  try {
    const fixed = await fixLintSource(
      { analysis, validation },
      path,
      source,
      { rule: "BLOT_LINT_SELECTIVE_OPEN" },
    );
    assertEquals(fixed.appliedFixes, 1);
    assertEquals(
      fixed.source,
      `const { .Op; } = import "blot:prelude"

// This explanation belongs to the result.
return Op.rem 5 2
`,
    );
    await analysis.checkSource(path, fixed.source);
    assertEquals((await analysis.evaluate(path)).display, "1");
  } finally {
    analysis.destroy();
    validation.destroy();
  }
});

Deno.test("fix all rechecks scope interactions and excludes refactors", async () => {
  const analysis = await Compiler.create();
  const validation = await Compiler.create();
  const path = resolve("lint-fix-all-interactions.blot");
  const source = `open import "blot:prelude"
let twice = fn value => @int.mul value 2
let values = [1, 2, 3]
let total = fold (values, 0, fn (sum, value) => sum + value)
return (twice 21, total)
`;
  try {
    await analysis.checkSource(path, source);
    const original = await analysis.evaluate(path);
    const fixed = await fixLintSource({ analysis, validation }, path, source);
    assert(fixed.appliedFixes > 0);
    assert(fixed.source.includes("fold ("), "refactors must remain opt-in");
    await analysis.checkSource(path, fixed.source);
    assertEquals(await analysis.evaluate(path), original);
    assertEquals(
      (await fixLintSource({ analysis, validation }, path, fixed.source))
        .appliedFixes,
      0,
    );
  } finally {
    analysis.destroy();
    validation.destroy();
  }
});
