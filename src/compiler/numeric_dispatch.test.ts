import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runArtifact } from "../node/run.ts";
import { Compiler } from "./session.ts";

for (
  const [name, domain, inputs, expected] of [
    ["negate_int", "Int", [7n, 2n], -7n],
    ["negate_f32", "F32", [7.5, 2.5], -7.5],
    ["negate_f64", "F64", [7.5, 2.5], -7.5],
  ] as const
) {
  test(`${domain} prefix negation accepts runtime arguments`, async () => {
    const compiler = await Compiler.create();
    try {
      const artifact = await compiler.compile("examples/dynamic_negation.blot");
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm).buffer,
      );
      const negate = instance.exports[`blot:${name}`];
      assert.equal(typeof negate, "function");
      if (typeof negate !== "function") {
        throw new Error(`missing ${name} export`);
      }
      assert.equal(negate(...inputs), expected);
      assert.equal(negate(expected, inputs[1]), inputs[0]);
      if (domain !== "Int") {
        assert.equal(negate(0, 0), -0);
        assert.equal(negate(-0, 0), 0);
      }
    } finally {
      compiler.destroy();
    }
  });
}

test("Int comparisons do not specialize later float comparisons", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/dynamic_numeric_comparisons.blot",
    );
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm).buffer,
    );
    for (
      const [name, lower, upper] of [
        ["less_int", 2n, 7n],
        ["less_f32", 2.5, 7.5],
        ["less_f64", 2.5, 7.5],
      ] as const
    ) {
      const less = instance.exports[`blot:${name}`];
      if (typeof less !== "function") throw new Error(`missing ${name} export`);
      assert.equal(less(lower, upper), 1);
      assert.equal(less(upper, lower), 0);
    }
  } finally {
    compiler.destroy();
  }
});

test("F32 remainder preserves the dividend sign at runtime", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/dynamic_f32_remainder.blot",
    );
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm).buffer,
    );
    const remainder = instance.exports["blot:remainder"];
    assert.equal(typeof remainder, "function");
    if (typeof remainder !== "function") {
      throw new Error("missing remainder export");
    }
    assert.equal(remainder(8, 2.5), 0.5);
    assert.equal(remainder(-8, 2.5), -0.5);
    assert.equal(remainder(8, -2.5), 0.5);
    assert.equal(remainder(-0, 2.5), -0);
  } finally {
    compiler.destroy();
  }
});

test("chained F32 arithmetic retains the type of intermediate results", async () => {
  const compiler = await Compiler.create();
  try {
    const path = join(tmpdir(), "blot-chained-f32.blot");
    await compiler.setOverlay(
      path,
      'open import "blot:prelude"\n' +
        "const run :: (F32, F32) -> F32\n" +
        "const run = fn (x, y) => (x + y) * 2.0 / 4.0 - 0.5\n" +
        "return { .run = run; }\n",
    );
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm).buffer,
    );
    const run = instance.exports["blot:run"];
    if (typeof run !== "function") throw new Error("missing run export");
    assert.equal(run(1.5, 2.5), 1.5);
  } finally {
    compiler.destroy();
  }
});

for (
  const [completion, iterations, expected] of [
    ["early exit", 20, [1, 0]],
    ["exhaustion", 20, [1, 0]],
    ["zero iterations", 0, [0, 0]],
    ["one iteration", 1, [0, 1]],
  ] as const
) {
  test(`float traversal retains its Boolean accumulator through ${completion}`, async () => {
    const compiler = await Compiler.create();
    try {
      const path = resolve("examples/dynamic_boolean_traversal.blot");
      if (completion === "exhaustion") {
        const source = await readFile(path, "utf8");
        await compiler.setOverlay(
          path,
          source.replace(
            "    if next_x > F32.of_float 5.0 && next_y > F32.of_float 5.0:\n      break\n",
            "",
          ),
        );
      } else if (iterations !== 20) {
        const source = await readFile(path, "utf8");
        await compiler.setOverlay(
          path,
          source.replace("Iter.range (0, 20)", `Iter.range (0, ${iterations})`),
        );
      }
      const checked = await compiler.check(path);
      assert.equal(
        checked.type,
        "{ .traverse = { .0 = F32; .1 = F32 } -> #True | #False }",
      );
      const artifact = await compiler.compile(path);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm).buffer,
      );
      const traverse = instance.exports["blot:traverse"];
      assert.equal(typeof traverse, "function");
      if (typeof traverse !== "function") {
        throw new Error("missing traverse export");
      }
      assert.equal(traverse(0.25, 0.5), expected[0]);
      assert.equal(traverse(0.5, 0.25), expected[1]);
    } finally {
      compiler.destroy();
    }
  });
}

test("numeric runtime observations agree with the evaluator", async () => {
  const compiler = await Compiler.create();
  try {
    const observed = await compiler.evaluate(
      "examples/dynamic_numeric_observations.blot",
    );
    const expected = await readFile(
      "examples/expected/dynamic_numeric_observations.txt",
      "utf8",
    );
    assert.equal(observed.display, expected.trim());
    const emitted = await runArtifact(
      await compiler.compile("examples/dynamic_numeric_observations.blot"),
    );
    assert.equal(emitted, observed.display);
  } finally {
    compiler.destroy();
  }
});

test("a Boolean accumulator still rejects an integer replacement", async () => {
  const compiler = await Compiler.create();
  try {
    const source = await readFile(
      "examples/dynamic_boolean_traversal.blot",
      "utf8",
    );
    await assert.rejects(
      compiler.checkSource(
        join(tmpdir(), "blot-invalid-boolean-accumulator.blot"),
        source.replace("horizontal := True", "horizontal := 1"),
      ),
      /does not flow into/,
    );
  } finally {
    compiler.destroy();
  }
});
