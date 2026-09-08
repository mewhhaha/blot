import { Compiler } from "../src/compiler/session.ts";
import { runArtifact } from "../src/node/run.ts";
import { instantiateArtifact } from "../src/host.ts";
import { formatValue } from "../src/abi_values.ts";

const cases = [
  "examples/minimal.blot",
  "examples/dynamic_numeric_observations.blot",
  "examples/async_effects.blot",
  "examples/control_transformers.blot",
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
    const emitted = await runArtifact(await compiler.compile(path));
    if (emitted !== evaluated.display) {
      throw new Error(
        `${path}: evaluator returned ${evaluated.display}, emitted Wasm returned ${emitted}`,
      );
    }
    console.log(`${path}: evaluator and emitted Wasm agree on ${emitted}`);
  }
  const source = await Deno.readTextFile("examples/async_effects.blot");
  const hostPath = "examples/async_effects-host.blot";
  await compiler.checkSource(
    hostPath,
    source.slice(0, source.indexOf("use answer <-")) +
      "return { .run = run; }\n",
  );
  const hosted = await instantiateArtifact(
    await compiler.compile(hostPath),
    new Map([
      [
        "Device",
        new Map([[
          "read",
          async (argument: import("../src/abi_values.ts").RuntimeValue) => {
            if (typeof argument !== "bigint") {
              throw new TypeError("Device.read requires Int");
            }
            return await Promise.resolve(argument + 10n);
          },
        ]]),
      ],
    ]),
  );
  try {
    const evaluated = await compiler.evaluate("examples/async_effects.blot");
    const emitted = formatValue(await hosted.callAsync("run", [7n]));
    if (emitted !== evaluated.display) {
      throw new Error(
        `portable suspension: evaluator returned ${evaluated.display}, emitted Wasm returned ${emitted}`,
      );
    }
    console.log(
      `portable suspension: evaluator and emitted Wasm agree on ${emitted}`,
    );
  } finally {
    await hosted.close();
  }
} finally {
  compiler.destroy();
}
