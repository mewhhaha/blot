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
return Int.rem 5 2
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
      `open import "blot:prelude"
return (5 % 2)
`,
    );
    assertEquals(fixed.diagnostics, []);
    assertEquals(fixed.appliedFixes, 1);
  } finally {
    validationCompiler.destroy();
    analysisCompiler.destroy();
  }
});
