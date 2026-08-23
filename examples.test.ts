// The executable catalog.
//
// Five invariants, one per outcome:
//
//   * `examples/*.blot` evaluate to exactly the value recorded in
//     `examples/expected/`. A golden value catches a semantics change that a
//     "still runs" test would sail past;
//   * `examples/rejected/syntax/` must fail to parse;
//   * `examples/rejected/semantics/` must parse and then fail with a specific
//     diagnostic code. Asserting the code, not merely the failure, is what
//     keeps an error from silently becoming a different error;
//   * `examples/traps/` check, then reach their specified run-time trap;
//   * `examples/pending/` preserve a named current limitation until it is
//     implemented and the example can be promoted.
//
// Nothing here needs WebGPU.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { basename, join } from "@std/path";
import { parse } from "./src/syntax/parse.ts";
import { evaluateFile, show } from "./src/run.ts";
import { BlotError } from "./src/diagnostic.ts";
import { LoadError } from "./src/load.ts";
import { checkFile } from "./src/check.ts";
import { Compiler } from "./src/compiler/session.ts";

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
  "unsupported_refinement_predicate": {
    code: "BLOT_REFINEMENT_PREDICATE",
    stage: "check",
  },
  "shadowed_refinement_parameter": {
    code: "BLOT_REFINEMENT_PREDICATE",
    stage: "check",
  },
  "instantiate_non_forall": {
    code: "BLOT_TYPE_INSTANTIATE",
    stage: "check",
  },
  "empty_refinement": { code: "BLOT_EMPTY_REFINEMENT", stage: "check" },
  "refinement_outside_i64": {
    code: "BLOT_EMPTY_REFINEMENT",
    stage: "check",
  },
  "does_not_satisfy": { code: "BLOT_DOES_NOT_SATISFY", stage: "check" },
  "out_of_range": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "resume_twice": {
    code: "BLOT_HANDLER_RESUME_NOT_AFFINE",
    stage: "check",
  },
  "unknown_operator": { code: "BLOT_UNKNOWN_OPERATOR", stage: "check" },
  "unhandled_effect": { code: "BLOT_UNHANDLED_EFFECT", stage: "check" },
  "effect_in_let": { code: "BLOT_UNSEQUENCED_EFFECT", stage: "check" },
  "sig_mismatch": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "rank_n_monomorphic": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // Both halves of how a member call is typed, and both would be *accepted* by
  // a rule that answered with a type variable: the first because the computed
  // value would never be compared against the `sig`, the second because a
  // variable satisfies every constraint put on it.
  "member_sig_unchecked": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "member_sig_unknowable": {
    code: "BLOT_REFLECTION_NOT_INDEXED",
    stage: "check",
  },
  "literal_outside_union": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "missing_case": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // A constructor set is covered by subtyping and reports through `constrain`;
  // a literal set is covered by membership and has its own code.
  "missing_literal_case": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  // Tuple arms are covered by the cross-product of their columns. Neither of
  // the two above can state what these are missing: every column is complete on
  // its own, and it is a combination no arm reaches.
  "missing_tuple_case": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "unlisted_tuple_column": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  // A field named by a value is still named at compile time, and a rule that
  // answered with a type variable would have this `sig` believed rather than
  // checked — the mistake `member_sig_unchecked` is the other half of.
  "shape_get_sig_unchecked": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // Both of these would be *accepted* by an `if` rule that narrowed on the
  // spelling of `==` or on the witness's type rather than its value, and both
  // trap at run time. They report through coverage because a refused narrowing
  // leaves the scrutinee exactly as wide as it was declared.
  "shadowed_equality": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "shadowed_const_equality": {
    code: "BLOT_INCOMPLETE_CASE",
    stage: "check",
  },
  "compared_names": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "compared_lengths": { code: "BLOT_UNPROVEN_INDEX", stage: "check" },
  // The one bounds failure the checker can already decide: both the index and
  // the array's length are written out in the source. It is the same code the
  // evaluator raises, and it has migrated from `run` to `check`.
  "index_outside_array": { code: "BLOT_OUT_OF_BOUNDS", stage: "check" },
  // The same code from a length nobody measured. `n >= @array.len xs` proves
  // `n : len xs..`, every value of which is past the end of `xs` whatever `xs`
  // turns out to hold — so the read is decided without the length ever being a
  // number.
  "index_at_or_past_length": { code: "BLOT_OUT_OF_BOUNDS", stage: "check" },
  "unproven_index": { code: "BLOT_UNPROVEN_INDEX", stage: "check" },
  "array_split_outside": { code: "BLOT_OUT_OF_BOUNDS", stage: "check" },
  "unproven_array_take": { code: "BLOT_UNPROVEN_INDEX", stage: "check" },
  "partial_direct_array_access": {
    code: "BLOT_ARRAY_ACCESS_NOT_DIRECT",
    stage: "check",
  },
  "wrong_argument": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "missing_field": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // The same rule across a module boundary, and the half that was wrong: an
  // imported module's parameter used to be a fresh variable rather than the one
  // its own bodies constrained, and a variable satisfies every argument.
  "module_argument_missing_field": {
    code: "BLOT_TYPE_ERROR",
    stage: "check",
  },
  "linear_consumed_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "linear_spent_each_iteration": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "linear_closure_called_each_iteration": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "linear_branch_disagreement": {
    code: "BLOT_LINEAR_BRANCH_DISAGREEMENT",
    stage: "check",
  },
  "linear_closure_called_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "linear_closure_escapes": {
    code: "BLOT_LINEAR_RESULT_ESCAPES",
    stage: "check",
  },
  "higher_order_owned_argument": {
    code: "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
    stage: "check",
  },
  "higher_order_owned_direct_result_replaced": {
    code: "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
    stage: "check",
  },
  "higher_order_owned_result_replaced": {
    code: "BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT",
    stage: "check",
  },
  "region_name_not_trusted": {
    code: "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
    stage: "check",
  },
  "ordered_map_owned_value": {
    code: "BLOT_LINEAR_RESULT_ESCAPES",
    stage: "check",
  },
  "linear_handler_abort": {
    code: "BLOT_LINEAR_HANDLER_MAY_ABORT",
    stage: "check",
  },
  "partial_owned_pattern": {
    code: "BLOT_LINEAR_PATTERN_DISCARDS",
    stage: "check",
  },
  "partially_moved_record": {
    code: "BLOT_LINEAR_PARTIAL_REUSE",
    stage: "check",
  },
  "owned_shape_spread": {
    code: "BLOT_LINEAR_SHAPE_SPREAD",
    stage: "check",
  },
  "recursive_group_consumed_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "recursive_linear_capture": {
    code: "BLOT_RECURSIVE_OWNERSHIP_UNPROVED",
    stage: "check",
  },
  "borrow_moved": { code: "BLOT_BORROW_MOVED", stage: "check" },
  "borrow_stored": { code: "BLOT_BORROW_STORED", stage: "check" },
  "affine_resumed_twice": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  "deferred_at_runtime": { code: "BLOT_DEFERRED_AT_RUNTIME", stage: "build" },
  "reuse_persistent_update": {
    code: "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
    stage: "check",
  },
  "deferred_demanded_twice": {
    code: "BLOT_DEFERRED_DEMANDED_TWICE",
    stage: "check",
  },
  "effect_not_discharged": { code: "BLOT_UNHANDLED_EFFECT", stage: "check" },
  "for_type_drift": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "rebinding_pattern": {
    code: "BLOT_BAD_REBINDING_TARGET",
    stage: "check",
  },
  "rebinding_type_change": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "rebinding_unbound": { code: "BLOT_UNBOUND", stage: "check" },
  // A scope error with its own code, because the name is not missing — it is
  // bound further down the same block, and telling the reader that is the
  // whole difference between this and a typo. It is not a comptime failure:
  // the binding is a `let`, and a `const` reading a later `const` would reach
  // this same rule first.
  "forward_reference": { code: "BLOT_FORWARD_REFERENCE", stage: "check" },
  // Mutual visibility belongs to a group of functions. A member that is not
  // one would have to read a name the group has not given a value to yet, so
  // the recursive-binding rule refuses it where it stands.
  "recursive_value": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // Two members of one group cannot shadow each other: they enter scope
  // together, so neither is "the earlier one".
  "duplicate_recursive_binding": {
    code: "BLOT_DUPLICATE_RECURSIVE_BINDING",
    stage: "check",
  },
  "generic_refused": { code: "BLOT_REFUSED", stage: "check" },
  "zero_integer_width": { code: "BLOT_REFUSED", stage: "run" },
  "tagged_sig": { code: "BLOT_TAGGED_SIG", stage: "check" },
  "bad_declaration_tag": {
    code: "BLOT_BAD_DECLARATION_TAG",
    stage: "check",
  },
  "declaration_tag_not_comptime": {
    code: "BLOT_NOT_COMPTIME",
    stage: "check",
  },
  "transformed_sig": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "spread_of_a_parameter": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // The other half of the spread rule, and the half that was wrong: a spread
  // whose fields are unknown contributes no names, so keeping the fields
  // written before it typed `{ .tag = 1; ...r; }` as `{ .tag = 1; }` for a call
  // that hands it `{ .tag = "hi"; }`. `blot check` reported `1` and `blot eval`
  // returned `"hi"`. A rule that answers with the narrower of two values it
  // cannot choose between is not incomplete, it is wrong.
  "spread_after_a_field": { code: "BLOT_SPREAD_MAY_OVERWRITE", stage: "check" },
  "shadowed_accumulator": { code: "BLOT_SHADOWED_ACCUMULATOR", stage: "check" },
  "float_unordered": { code: "BLOT_UNORDERED", stage: "run" },
  "unbounded_case": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "unconstrained_case": {
    code: "BLOT_INCOMPLETE_CASE",
    stage: "check",
  },
  "dynamic_shape_field": {
    code: "BLOT_DYNAMIC_SHAPE_FIELD",
    stage: "check",
  },
  "reflection_not_indexed": {
    code: "BLOT_REFLECTION_NOT_INDEXED",
    stage: "check",
  },
  "relational_summary_impostor": {
    code: "BLOT_UNPROVEN_INDEX",
    stage: "check",
  },
  "unrepresentable_integer": {
    code: "BLOT_UNREPRESENTABLE_INTEGER",
    stage: "check",
  },
  "include_dynamic_path": { code: "BLOT_INCLUDE_PATH", stage: "check" },
  "include_at_runtime": {
    code: "BLOT_INCLUDE_NOT_COMPTIME",
    stage: "check",
  },
  "include_invalid_json": { code: "BLOT_JSON_PARSE", stage: "check" },
  "json_at_runtime": { code: "BLOT_JSON_NOT_COMPTIME", stage: "check" },
  "pinned_structural_value": {
    code: "BLOT_UNMATCHABLE_PIN",
    stage: "check",
  },
  "bad_pin": { code: "BLOT_BAD_PIN", stage: "check" },
  // A guard may be false, so a guarded arm is dropped from the matrix that
  // decides coverage. With every arm guarded there is no matrix left, and the
  // scrutinee's own set is what reports the rest: a constructor named only
  // under a guard is a constructor no arm covers.
  "all_arms_guarded": { code: "BLOT_INCOMPLETE_CASE", stage: "check" },
  "guarded_arm_does_not_cover": { code: "BLOT_TYPE_ERROR", stage: "check" },
  // A guard falls through, and a fall-through tests the target again. That is
  // one consumption too many for a linear one, which is why this is recorded
  // rather than left to be rediscovered.
  "guarded_linear_target": {
    code: "BLOT_LINEAR_CONSUMED_TWICE",
    stage: "check",
  },
  // A bare `->` is the empty row, so a `sig` without `~` on an effectful
  // binding is a mismatch rather than an omission.
  "sig_without_row": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "guard_may_continue": {
    code: "BLOT_GUARD_MAY_CONTINUE",
    stage: "check",
  },
  "guard_payload_type": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "handler_wrong_operation": { code: "BLOT_TYPE_ERROR", stage: "check" },
  "break_outside_loop": {
    code: "BLOT_BREAK_OUTSIDE_LOOP",
    stage: "check",
  },
  "break_in_function": {
    code: "BLOT_BREAK_OUTSIDE_LOOP",
    stage: "check",
  },
  // A phase error, not a type error: the captured name is in lexical scope,
  // but a compile-time closure has no runtime frame in which to find it.
  "const_captures_let": {
    code: "BLOT_CONST_CAPTURES_RUNTIME",
    stage: "check",
  },
  "runtime_requirement": {
    code: "BLOT_SIG_NOT_COMPTIME",
    stage: "check",
  },
};

/** Valid programs whose requested evaluation has a specified trap. */
const TRAPS: Record<string, string> = {
  "division_by_zero": "BLOT_DIVIDE_BY_ZERO",
  "integer_overflow": "BLOT_INTEGER_OVERFLOW",
};

/**
 * Desirable programs which are deliberately not part of the language yet.
 * A resolved entry fails this test so it must be promoted to the executable
 * catalog instead of disappearing from the frontier by accident.
 */
const PENDING: Record<
  string,
  | { code: string; stage: "check" | "run" }
  | { type: string; stage: "type" }
> = {
  "collect_principal_type": {
    type: "([(Int | 0)] | ['a])",
    stage: "type",
  },
  "type_directed_text_equality": {
    code: "BLOT_TYPE_ERROR",
    stage: "check",
  },
  "affine_index_rebinding": {
    code: "BLOT_UNPROVEN_INDEX",
    stage: "check",
  },
  "total_float_ordering": { code: "BLOT_UNORDERED", stage: "run" },
  "text_codepoints": { code: "BLOT_TYPE_ERROR", stage: "check" },
};

async function blotFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && entry.name.endsWith(".blot")) found.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
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
      let run: () => Promise<unknown>;
      if (expected.stage === "check") {
        run = () => checkFile(path);
      } else if (expected.stage === "build") {
        run = async () => {
          const compiler = await Compiler.create();
          try {
            return await compiler.compile(path);
          } finally {
            compiler.destroy();
          }
        };
      } else {
        run = () => evaluateFile(path, { write: () => {} });
      }

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

for (const name of await blotFiles("examples/traps")) {
  const stem = basename(name, ".blot");
  const expected = TRAPS[stem];
  Deno.test(`examples/traps/${name} reaches ${expected}`, async () => {
    if (expected === undefined) {
      throw new Error(`add \`${stem}\` to TRAPS with its diagnostic code`);
    }
    const path = join("examples/traps", name);
    await checkFile(path);
    const message = await failureMessage(
      () => evaluateFile(path, { write: () => {} }),
    );
    assertStringIncludes(message, expected);
  });
}

for (const name of await blotFiles("examples/pending")) {
  const stem = basename(name, ".blot");
  const expected = PENDING[stem];
  const label = expected === undefined
    ? "an unrecorded limitation"
    : expected.stage === "type"
    ? expected.type
    : expected.code;
  Deno.test(`examples/pending/${name} records ${label}`, async () => {
    if (expected === undefined) {
      throw new Error(`add \`${stem}\` to PENDING with its result and stage`);
    }
    const path = join("examples/pending", name);
    if (expected.stage === "type") {
      const checked = await checkFile(path);
      assertEquals(checked.type, expected.type);
      return;
    }
    let run: () => Promise<unknown>;
    if (expected.stage === "check") {
      run = () => checkFile(path);
    } else {
      run = () => evaluateFile(path, { write: () => {} });
    }
    const message = await failureMessage(run);
    assertStringIncludes(message, expected.code);
  });
}

async function failureMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      const coded = error as Error & { readonly code?: string };
      if (coded.code !== undefined) return `${coded.code}: ${coded.message}`;
      return error.message;
    }
    throw error;
  }
  throw new Error("expected this example to retain its recorded failure");
}
