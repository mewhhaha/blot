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
const REJECTIONS: Record<
  string,
  { code: string; stage: "check" | "run" | "build" }
> = {
  "misplaced_rec": { code: "BLOT_MISPLACED_REC", stage: "run" },
  "missing_result": { code: "BLOT_MISSING_RESULT", stage: "check" },
  "out_of_range": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "resume_twice": {
    code: "BLOT_HANDLER_RESUME_NOT_AFFINE",
    stage: "check",
  },
  "lambda_without_fn": { code: "BLOT_LAMBDA_WITHOUT_FN", stage: "check" },
  "unknown_operator": { code: "BLOT_UNKNOWN_OPERATOR", stage: "check" },
  "unhandled_effect": { code: "BLOT_UNHANDLED_EFFECT", stage: "check" },
  "sig_mismatch": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // Both halves of how a member call is typed, and both would be *accepted* by
  // a rule that answered with a type variable: the first because the computed
  // value would never be compared against the `sig`, the second because a
  // variable satisfies every constraint put on it.
  "member_sig_unchecked": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "member_sig_unknowable": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "literal_outside_union": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "missing_case": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // A constructor set is covered by subtyping and reports through `constrain`;
  // a literal set is covered by membership and has its own code.
  "missing_literal_case": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  // Both of these would be *accepted* by an `if` rule that narrowed on the
  // spelling of `==` or on the witness's type rather than its value, and both
  // trap at run time. They report through coverage because a refused narrowing
  // leaves the scrutinee exactly as wide as it was declared.
  "shadowed_equality": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "compared_names": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  // The one bounds failure the checker can already decide: both the index and
  // the array's length are written out in the source. It is the same code the
  // evaluator raises, and it has migrated from `run` to `check`.
  "index_outside_array": { code: "BLOT_OUT_OF_BOUNDS", stage: "check" },
  // The same code from a length nobody measured. `n >= @array.len xs` proves
  // `n : len xs..`, every value of which is past the end of `xs` whatever `xs`
  // turns out to hold — so the read is decided without the length ever being a
  // number.
  "index_at_or_past_length": { code: "BLOT_OUT_OF_BOUNDS", stage: "check" },
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
  "for_type_drift": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "rebinding_type_change": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "rebinding_unbound": { code: "BLOT_UNBOUND", stage: "check" },
  "generic_refused": { code: "BLOT_REFUSED", stage: "check" },
  "spread_of_a_parameter": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "shadowed_accumulator": { code: "BLOT_SHADOWED_ACCUMULATOR", stage: "check" },
  "float_unordered": { code: "BLOT_UNORDERED", stage: "run" },
  "unbounded_case": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "guard_may_continue": {
    code: "BLOT_GUARD_MAY_CONTINUE",
    stage: "check",
  },
  "guard_payload_type": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "handler_wrong_operation": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "handler_composition_action": {
    code: "BLOT_BAD_HANDLER_COMPOSITION",
    stage: "check",
  },
  "open_collision": { code: "BLOT_OPEN_COLLISION", stage: "check" },
  "open_duplicate_field": {
    code: "BLOT_DUPLICATE_OPEN_FIELD",
    stage: "check",
  },
  "open_missing_field": { code: "BLOT_NO_FIELD", stage: "check" },
  "break_outside_loop": {
    code: "BLOT_BREAK_OUTSIDE_LOOP",
    stage: "check",
  },
  "break_in_function": {
    code: "BLOT_BREAK_OUTSIDE_LOOP",
    stage: "check",
  },
  "break_in_value_if": {
    code: "BLOT_BREAK_IN_VALUE_CONDITION",
    stage: "check",
  },
  "return_in_value_if": {
    code: "BLOT_RETURN_IN_VALUE_CONDITION",
    stage: "check",
  },
  "return_in_value_case": {
    code: "BLOT_RETURN_IN_VALUE_CONDITION",
    stage: "check",
  },
  // A phase error, not a type error: the program checks and the interpreter
  // runs it, and only lowering has to place the capture in a frame that does
  // not exist. `backend.test.ts` asserts the code.
  "const_captures_let": {
    code: "BLOT_CONST_CAPTURES_RUNTIME",
    stage: "build",
  },
  // Also not a type error: width subtyping accepts two records at one
  // projection, and it is Core's nominal records that have no type for both.
  // `backend.test.ts` asserts the code and that the message names both shapes.
  "shape_disagreement": {
    code: "BLOT_SHAPE_DISAGREEMENT",
    stage: "build",
  },
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

  const suffix = expected?.stage === "build" ? " at build" : "";
  Deno.test(
    `examples/rejected/semantics/${name} fails with ${label}${suffix}`,
    async () => {
      if (expected === undefined) {
        throw new Error(
          `add \`${stem}\` to REJECTIONS with its code and stage`,
        );
      }
      const path = join("examples/rejected/semantics", name);
      // A `build` rejection needs a WebGPU adapter, so it is asserted by
      // `just wasm` rather than here; checking it must still pass.
      if (expected.stage === "build") {
        await checkFile(path);
        return;
      }
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
        throw new Error(
          `expected \`${expected.stage}\` to reject this program`,
        );
      }
      assertStringIncludes(message, expected.code);
    },
  );
}
