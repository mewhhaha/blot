// Does the compiled program agree with the interpreter?
//
// blot has two executions of the same language — the comptime evaluator, which
// is also the runtime until the backend covers everything, and the Wasm the
// backend emits. They must agree, and this is the only thing that proves it.
// The GPU evaluator's answer is a third opinion and is checked too, because a
// lowering can satisfy one of them and not the other.
//
// Needs a WebGPU adapter, so it is not part of `deno test`: `blot check` and
// the corpus tests stay runnable without a device.

import { build } from "../src/backend/compile.ts";
import { runWasm } from "../src/backend/run.ts";
import { evaluateFile } from "../src/run.ts";
import { show } from "../src/comptime/value.ts";

/** Examples the backend covers today. Everything else is in docs/backend.md. */
const COMPILES = [
  "examples/minimal.blot",
  "examples/compiled.blot",
];

let failures = 0;

for (const path of COMPILES) {
  const interpreted = await evaluateFile(path, { write: () => {} });
  const built = await build(path);
  const ran = await runWasm(built.wasm);

  const expected = show(interpreted);
  const actual = String(ran.value);
  const gpu = built.value as { kind?: string; value?: unknown };

  if (actual !== expected) {
    console.error(
      `${path}: wasm returned ${actual}, interpreter said ${expected}`,
    );
    failures += 1;
    continue;
  }
  if (gpu.kind === "integer" && String(gpu.value) !== expected) {
    console.error(
      `${path}: gpu evaluator returned ${gpu.value}, interpreter said ${expected}`,
    );
    failures += 1;
    continue;
  }
  console.log(
    `${path}: ${built.wasm.byteLength} bytes, all three agree on ${expected}`,
  );
}

if (failures > 0) {
  console.error(
    `\n${failures} disagreement(s) between the interpreter and the backend.`,
  );
  Deno.exit(1);
}
console.log(
  "\nThe interpreter, the GPU evaluator, and the emitted Wasm agree.",
);
