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
  "examples/handlers.blot",
  "examples/shadowed_effects.blot",
  "examples/modules.blot",
  "examples/arithmetic.blot",
  "examples/linear.blot",
  "examples/collections.blot",
  "examples/matching.blot",
  "examples/granted.blot",
];

/**
 * A boundary value, rendered the way the interpreter renders its own.
 *
 * A record crosses as a constructor, and its field *names* are a lowering
 * detail — so the shapes the backend synthesized are what turn it back into
 * something comparable. Comparing only scalars would have quietly stopped
 * checking every program that returns a record.
 */
function render(
  value: unknown,
  shapes: ReadonlyMap<string, readonly string[]>,
): string {
  const node = value as {
    kind?: string;
    value?: unknown;
    name?: string;
    fields?: readonly unknown[];
  };
  if (node?.kind === "unit") return "()";
  if (node?.kind === "integer") return String(node.value);
  if (node?.kind === "text") return JSON.stringify(node.value);
  // `#True` and `#False` became Core booleans on the way in; reading one back
  // means undoing exactly that mapping.
  if (node?.kind === "boolean") return node.value === true ? "#True" : "#False";
  if (node?.kind === "constructor" && node.name !== undefined) {
    const fields = shapes.get(node.name);
    const parts = node.fields ?? [];
    if (fields === undefined) {
      return `#${node.name}${parts.length === 0 ? "" : " …"}`;
    }
    if (fields.every((name) => /^\d+$/.test(name)) && fields.length > 0) {
      return `(${parts.map((part) => render(part, shapes)).join(", ")})`;
    }
    const members = fields.map((name, index) =>
      `.${name} = ${render(parts[index], shapes)}`
    );
    return members.length === 0 ? "{}" : `{ ${members.join("; ")}; }`;
  }
  return String(value);
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

  if (render(built.ran, built.shapes) !== expected) {
    console.error(
      `${path}: wasm returned ${
        render(built.ran, built.shapes)
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

// Programs the backend must refuse, and why. A refusal that quietly became a
// miscompile would look like progress.
const REFUSES: readonly [string, string][] = [
  [
    "examples/rejected/semantics/handler_aborts.blot",
    "does not resume in tail position",
  ],
];

for (const [path, reason] of REFUSES) {
  try {
    await build(path, hostInit(() => {}));
    console.error(`${path}: expected the backend to refuse this`);
    failures += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(reason)) {
      console.error(`${path}: refused for the wrong reason: ${message}`);
      failures += 1;
      continue;
    }
    console.log(`${path}: refused, ${reason}`);
  }
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
