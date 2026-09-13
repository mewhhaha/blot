import { Compiler } from "../src/compiler/session.ts";
import { observeArtifact } from "../src/node/run.ts";
import { evaluationObservation } from "../src/runtime_observation.ts";
import { deepStrictEqual } from "node:assert";

const cases = [
  "examples/minimal.blot",
  "examples/relational_observations.blot",
  "examples/literal_rebinding.blot",
  "examples/dynamic_numeric_observations.blot",
  "examples/control_transformers.blot",
  "examples/suspension.blot",
  "examples/generic_host_effect.blot",
  "examples/compiled_callback.blot",
  "examples/inline_signatures.blot",
  "examples/continuing.blot",
  "examples/numeric_literals.blot",
  "examples/option_result.blot",
  "examples/nested_case_joins.blot",
  "examples/collection_effects.blot",
  "examples/text_cursor.blot",
  "examples/value_observations.blot",
  "examples/typed_parameters.blot",
  "examples/record_fields.blot",
  "examples/collection_adapters.blot",
  "examples/effectful_iterator.blot",
  "examples/inferred_search.blot",
  "examples/float_formatting.blot",
  "examples/parse_integer.blot",
  "examples/command_codec.blot",
  "examples/module_input_contract.blot",
  "examples/spark_parallel.blot",
  "examples/row_preserving_wrapper.blot",
  "examples/region_round_trip.blot",
  "examples/owned_quicksort.blot",
  "examples/owned_merge_sort.blot",
  "examples/owned_radix_sort_stable.blot",
  "examples/owned_radix_sort_unstable.blot",
  "examples/higher_order_owned_fold.blot",
  "examples/higher_order_owned_quicksort.blot",
  "examples/region_zipper_quicksort.blot",
];
const compiler = await Compiler.create();
try {
  for (const path of cases) {
    const evaluated = await compiler.evaluate(path);
    if (evaluated.writes.length > 0) {
      throw new Error(
        `${path}: conformance case unexpectedly writes to its host`,
      );
    }
    const emitted = await observeArtifact(await compiler.compile(path));
    deepStrictEqual(
      emitted.value,
      evaluationObservation(evaluated.value, emitted.type),
      `${path}: evaluator and emitted Wasm differ`,
    );
    console.log(`${path}: evaluator and emitted Wasm observations agree`);
  }
} finally {
  compiler.destroy();
}
