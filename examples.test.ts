// The executable catalog.
//
// Three invariants, one per directory:
//
//   * `examples/*.blot` evaluate to exactly the value recorded in
//     `examples/expected/`. A golden value catches a semantics change that a
//     "still runs" test would sail past;
//   * `examples/rejected/syntax/` must fail to parse;
//   * `examples/rejected/semantics/` must parse and then fail with a specific
//     diagnostic code. Asserting the code, not merely the failure, is what
//     keeps an error from silently becoming a different error.
//
// Nothing here needs WebGPU.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { basename, join } from "@std/path";
import { parse } from "./src/syntax/parse.ts";
import { evaluateFile } from "./src/run.ts";
import { show } from "./src/comptime/value.ts";
import { BlotError } from "./src/diagnostic.ts";
import { LoadError } from "./src/load.ts";
import { checkFile } from "./src/check/mod.ts";

/**
 * The diagnostic each semantic rejection must produce, and which stage catches
 * it. Naming the stage matters: an error that migrates from `run` to `check` is
 * the type system getting stronger, and one that migrates the other way is a
 * regression.
 */
const REJECTIONS: Record<string, { code: string; stage: "check" | "run" }> = {
  "declaration_after_result": {
    code: "BLOT_DECLARATION_AFTER_RESULT",
    stage: "check",
  },
  "misplaced_rec": { code: "BLOT_MISPLACED_REC", stage: "run" },
  "missing_result": { code: "BLOT_MISSING_RESULT", stage: "check" },
  "out_of_range": { code: "BLOT_DOES_NOT_SATISFY", stage: "run" },
  "resume_twice": { code: "BLOT_RESUME_TWICE", stage: "run" },
  "uncurried_lambda": { code: "BLOT_UNPARENTHESIZED_LAMBDA", stage: "check" },
  "unknown_operator": { code: "BLOT_UNKNOWN_OPERATOR", stage: "check" },
  "unhandled_effect": { code: "BLOT_UNHANDLED_EFFECT", stage: "check" },
  "sig_mismatch": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "literal_outside_union": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "missing_case": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "wrong_argument": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "missing_field": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "linear_consumed_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "linear_not_consumed": { code: "BLOT_LINEAR_NOT_CONSUMED", stage: "check" },
  "linear_branch_disagreement": {
    code: "BLOT_LINEAR_BRANCH_DISAGREEMENT",
    stage: "check",
  },
  "linear_closure_called_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "linear_closure_never_called": {
    code: "BLOT_LINEAR_NOT_CONSUMED",
    stage: "check",
  },
  "linear_closure_escapes": {
    code: "BLOT_LINEAR_CLOSURE_ESCAPES",
    stage: "check",
  },
  "borrow_moved": { code: "BLOT_BORROW_MOVED", stage: "check" },
  "affine_resumed_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "effect_not_discharged": { code: "BLOT_UNHANDLED_EFFECT", stage: "check" },
  "handler_wrong_operation": { code: "BLOT_TYPE_ERROR", stage: "check" },
};

async function blotFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".blot")) found.push(entry.name);
  }
  return found.sort();
}

for (const name of await blotFiles("examples")) {
  const stem = basename(name, ".blot");

  Deno.test(`examples/${name} type checks`, async () => {
    await checkFile(join("examples", name));
  });

  Deno.test(`examples/${name} evaluates to its recorded value`, async () => {
    const printed: string[] = [];
    const value = await evaluateFile(
      join("examples", name),
      { write: (line) => printed.push(line) },
    );
    const actual = [...printed, show(value)].join("\n");
    const expected = await Deno.readTextFile(
      join("examples/expected", `${stem}.txt`),
    );
    assertEquals(actual.trim(), expected.trim());
  });
}

for (const name of await blotFiles("examples/rejected/syntax")) {
  Deno.test(`examples/rejected/syntax/${name} fails to parse`, async () => {
    const source = await Deno.readTextFile(
      join("examples/rejected/syntax", name),
    );
    const result = await parse(source);
    assertEquals(result.ok, false, "expected this program to be rejected");
  });
}

for (const name of await blotFiles("examples/rejected/semantics")) {
  const stem = basename(name, ".blot");
  const expected = REJECTIONS[stem];
  const label = expected === undefined
    ? "an unrecorded diagnostic"
    : expected.code;

  Deno.test(`examples/rejected/semantics/${name} fails with ${label}`, async () => {
    if (expected === undefined) {
      throw new Error(`add \`${stem}\` to REJECTIONS with its code and stage`);
    }
    const path = join("examples/rejected/semantics", name);
    const run = expected.stage === "check"
      ? () => checkFile(path)
      : () => evaluateFile(path, { write: () => {} });

    let message: string | null = null;
    try {
      await run();
    } catch (error) {
      if (!(error instanceof BlotError) && !(error instanceof LoadError)) {
        throw error;
      }
      message = error.message;
    }
    if (message === null) {
      throw new Error(`expected \`${expected.stage}\` to reject this program`);
    }
    assertStringIncludes(message, expected.code);
  });
}
