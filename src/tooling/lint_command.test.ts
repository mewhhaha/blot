import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { Compiler } from "../compiler.ts";
import type { LintDiagnostic } from "./lint.ts";
import {
  fixLintSource,
  lintSource,
  parseLintArguments,
  selectNonOverlappingFixes,
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

Deno.test("overlapping fix-all edits resolve to one deterministic winner", () => {
  const overlapping = (
    code: LintDiagnostic["code"],
    start: number,
    end: number,
  ): LintDiagnostic => ({
    code,
    severity: "hint",
    message: "overlap",
    span: { start, end },
    fix: {
      title: `Fix ${code}`,
      edits: [{ span: { start, end }, replacement: "x" }],
      kind: "quickfix",
      validation: "check-interface",
    },
  });
  const wide = overlapping("BLOT_LINT_UNUSED_BINDING", 10, 20);
  const narrow = overlapping("BLOT_LINT_NOOP_REBINDING", 12, 18);
  const disjoint = overlapping("BLOT_LINT_EQUALITY_CASE", 30, 40);
  const refactor: LintDiagnostic = {
    ...overlapping("BLOT_LINT_IF_CHAIN", 50, 60),
    fix: {
      title: "Refactor",
      edits: [{ span: { start: 50, end: 60 }, replacement: "y" }],
      kind: "refactor.rewrite",
      validation: "check-interface",
    },
  };
  const forward = selectNonOverlappingFixes([wide, narrow, disjoint, refactor]);
  const backward = selectNonOverlappingFixes([
    refactor,
    disjoint,
    narrow,
    wide,
  ]);
  assertEquals(
    forward.map((selected) => selected.diagnostic.code),
    ["BLOT_LINT_NOOP_REBINDING", "BLOT_LINT_EQUALITY_CASE"],
  );
  assertEquals(
    backward.map((selected) => selected.diagnostic.code),
    ["BLOT_LINT_NOOP_REBINDING", "BLOT_LINT_EQUALITY_CASE"],
  );
});
