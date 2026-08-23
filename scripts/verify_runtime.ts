import { Compiler } from "../src/compiler/session.ts";
import { runArtifact } from "../src/node/run.ts";

const cases = [
  "examples/minimal.blot",
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
    const emitted = await runArtifact(await compiler.compile(path));
    if (emitted !== evaluated.display) {
      throw new Error(
        `${path}: evaluator returned ${evaluated.display}, emitted Wasm returned ${emitted}`,
      );
    }
    console.log(`${path}: evaluator and emitted Wasm agree on ${emitted}`);
  }
} finally {
  compiler.destroy();
}
