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
import { hostInit } from "../src/backend/host.ts";
import { evaluateFile } from "../src/run.ts";
import { show } from "../src/comptime/value.ts";

/** Examples the backend covers today. Everything else is in docs/backend.md. */
const COMPILES = [
  "examples/minimal.blot",
  "examples/compiled.blot",
  "examples/host.blot",
];

/** `()` crosses the host boundary as a constructor, and reads as one. */
function sameValue(wasm: unknown, interpreted: string): boolean {
  const encoded = wasm as { kind?: string; value?: unknown };
  if (encoded?.kind === "unit") return interpreted === "()";
  if (encoded?.kind === "integer") return String(encoded.value) === interpreted;
  return String(wasm) === interpreted;
}

let failures = 0;

for (const path of COMPILES) {
  // Both runs print into their own transcript. An effectful program's output is
  // as much of its meaning as its result, so the two have to match as well.
  const interpretedLines: string[] = [];
  const compiledLines: string[] = [];
  const interpreted = await evaluateFile(path, {
    write: (line) => interpretedLines.push(line),
  });
  const built = await build(path, hostInit((line) => compiledLines.push(line)));

  const expected = show(interpreted);
  const gpu = built.value as { kind?: string; value?: unknown };

  if (!sameValue(built.ran, expected)) {
    console.error(
      `${path}: wasm returned ${
        JSON.stringify(built.ran)
      }, interpreter said ${expected}`,
    );
    failures += 1;
    continue;
  }
  if (interpretedLines.join("|") !== compiledLines.join("|")) {
    console.error(
      `${path}: wasm printed [${compiledLines}], interpreter printed [${interpretedLines}]`,
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
  const imports = built.capabilities.length === 0
    ? ""
    : ` importing { ${built.capabilities.join(", ")} }`;
  console.log(
    `${path}: ${built.wasm.byteLength} bytes${imports}, all three agree on ${expected}`,
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
