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

import { BlotCompilerSession } from "../src/backend/compile.ts";
import { hostInit } from "../src/backend/host.ts";
import { evaluateFile } from "../src/run.ts";
import { shapeOf, show, UNIT, type Value } from "../src/comptime/value.ts";
import type { RuntimeConstructor } from "../src/backend/lower.ts";
import { join } from "@std/path";

const examples: string[] = [];
for await (const entry of Deno.readDir("examples")) {
  if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
  examples.push(join("examples", entry.name));
}
examples.sort();

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
  constructors: ReadonlyMap<string, RuntimeConstructor>,
): string {
  const node = value as {
    kind?: string;
    value?: unknown;
    name?: string;
    fields?: readonly unknown[];
    values?: readonly unknown[];
  };
  if (node?.kind === "unit") return "()";
  if (node?.kind === "integer") return String(node.value);
  if (node?.kind === "signed-integer-64") return String(node.value);
  if (node?.kind === "float-32" || node?.kind === "float-64") {
    return String(node.value);
  }
  if (node?.kind === "text") return JSON.stringify(node.value);
  if (node?.kind === "array" || node?.kind === "slice") {
    if (node.values === undefined) return String(value);
    return `[${
      node.values.map((element) => render(element, shapes, constructors)).join(
        ", ",
      )
    }]`;
  }
  if (node?.kind === "tuple") {
    let values = node.values;
    if (values === undefined) values = node.fields;
    if (values === undefined) return String(value);
    return `(${
      values.map((element) => render(element, shapes, constructors)).join(", ")
    })`;
  }
  if (node?.kind === "erased") {
    return render(node.value, shapes, constructors);
  }
  // `#True` and `#False` became Core booleans on the way in; reading one back
  // means undoing exactly that mapping.
  if (node?.kind === "boolean") {
    if (node.value === true) return "#True";
    return "#False";
  }
  if (node?.kind === "constructor" && node.name !== undefined) {
    const fields = shapes.get(node.name);
    let parts: readonly unknown[] = [];
    if (node.fields !== undefined) parts = node.fields;
    if (fields === undefined) {
      const constructor = constructors.get(node.name);
      if (constructor === undefined) {
        if (parts.length === 0) return `#${node.name}`;
        return `#${node.name} …`;
      }
      if (!constructor.payload) return `#${constructor.sourceName}`;
      const payload = parts[0];
      if (payload === undefined) {
        throw new Error(
          `runtime constructor ${node.name} omitted its payload`,
        );
      }
      const rendered = render(payload, shapes, constructors);
      if (constructor.kind === "sealed") {
        return `${constructor.sourceName} ${rendered}`;
      }
      return `#${constructor.sourceName} ${rendered}`;
    }
    if (fields.every((name) => /^\d+$/.test(name)) && fields.length > 0) {
      return `(${
        parts.map((part) => render(part, shapes, constructors)).join(", ")
      })`;
    }
    const members = fields.map((name, index) =>
      `.${name} = ${render(parts[index], shapes, constructors)}`
    );
    if (members.length === 0) return "{}";
    return `{ ${members.join("; ")}; }`;
  }
  return String(value);
}

let failures = 0;

// One device for the whole corpus. `verify(path)` opens and destroys a session
// per call, and a destroyed device does not return its memory to the driver
// immediately — so the one-shot form asked for and released forty devices back
// to back, and failed to get one whenever something else on the machine was
// already holding a share of the card. Keeping the session is what it was
// added for.
const session = await BlotCompilerSession.create();
try {
  for (const path of examples) {
    // Each execution prints into its own transcript. An effectful program's
    // output is as much of its meaning as its result, so all three have to match.
    const interpretedLines: string[] = [];
    const evaluatorLines: string[] = [];
    const wasmLines: string[] = [];
    const interpreted = await evaluateFile(path, {
      write: (line) => interpretedLines.push(line),
    });
    const built = await session.verify(path, {
      evaluatorInit: hostInit((line) => evaluatorLines.push(line)),
      wasmInit: hostInit((line) => wasmLines.push(line)),
    });

    const expected = show(runtimeResult(interpreted, built.manifest.exports));

    if (render(built.ran, built.shapes, built.constructors) !== expected) {
      console.error(
        `${path}: wasm returned ${
          render(built.ran, built.shapes, built.constructors)
        }, interpreter said ${expected}`,
      );
      failures += 1;
      continue;
    }
    if (interpretedLines.join("|") !== wasmLines.join("|")) {
      console.error(
        `${path}: wasm printed [${wasmLines}], interpreter printed [${interpretedLines}]`,
      );
      failures += 1;
      continue;
    }
    if (render(built.value, built.shapes, built.constructors) !== expected) {
      console.error(
        `${path}: gpu evaluator returned ${
          render(built.value, built.shapes, built.constructors)
        }, interpreter said ${expected}`,
      );
      failures += 1;
      continue;
    }
    if (interpretedLines.join("|") !== evaluatorLines.join("|")) {
      console.error(
        `${path}: gpufuck evaluator printed [${evaluatorLines}], interpreter printed [${interpretedLines}]`,
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
} finally {
  session.destroy();
}

function runtimeResult(
  value: Value,
  exports: readonly {
    readonly sourceName: string;
    readonly phase: "runtime" | "comptime";
  }[],
): Value {
  if (
    exports.length === 1 &&
    exports[0].sourceName === "default" &&
    exports[0].phase === "runtime"
  ) {
    return value;
  }
  if (value.tag !== "shape") return UNIT;
  const fields: [string, Value][] = [];
  for (const exported of exports) {
    if (exported.phase !== "runtime") continue;
    const field = value.fields.get(exported.sourceName);
    if (field === undefined) {
      throw new Error(
        `interpreter result omitted runtime export ${exported.sourceName}`,
      );
    }
    fields.push([exported.sourceName, field]);
  }
  if (fields.length === 0) return UNIT;
  return shapeOf(fields);
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
