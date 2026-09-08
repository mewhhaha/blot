import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { instantiateArtifact } from "../host.ts";
import { LoadError } from "../load.ts";

test("continue and numeric tokens preserve evaluator and dynamic Wasm behavior", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const probe of [
        {
          path: "examples/continuing.blot",
          call: "return run 4",
          expected: "248",
          cases: [[0n, 0n], [1n, 1n], [2n, 123n], [4n, 248n], [5n, 249n]],
        },
        {
          path: "examples/numeric_literals.blot",
          call: "return run 0.5",
          expected: "1029",
          cases: [[0.5, 1029n], [100.25, 1129n]],
        },
      ]
    ) {
      assert.equal(
        (await compiler.evaluate(probe.path)).display,
        probe.expected,
      );
      const path = resolve(probe.path);
      const source = await readFile(path, "utf8");
      await compiler.checkSource(
        path,
        source.replace(probe.call, "return { .run = run; }"),
      );
      const hosted = await instantiateArtifact(await compiler.compile(path));
      try {
        for (const [argument, expected] of probe.cases) {
          assert.equal(hosted.call("run", [argument]), expected);
        }
      } finally {
        await hosted.close();
      }
    }
    for (
      const literal of [
        "1__0",
        "1_",
        "0x",
        "0x_FF",
        "1e",
        "1e+",
        "1._0",
        "1e_2",
      ]
    ) {
      await assert.rejects(
        compiler.checkSource(
          resolve("numeric-rejection.blot"),
          `return ${literal}\n`,
        ),
        (error: unknown) =>
          error instanceof LoadError || error instanceof BlotError,
        literal,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("owned iteration and variant combinators sequence real host suspensions", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/lib/collection_effects.blot",
    );
    const visited: bigint[] = [];
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        [
          "Tick",
          new Map([["next", async (_context, value) => {
            assert.equal(typeof value, "bigint");
            const number = BigInt(String(value));
            visited.push(number);
            await Promise.resolve();
            return number * 2n;
          }]]),
        ],
      ]),
    );
    try {
      assert.equal(await hosted.callAsync("run", [[1n, 2n, 3n]]), 48n);
      assert.deepEqual(visited, [1n, 2n, 3n, 12n, 24n]);
      visited.length = 0;
      assert.equal(await hosted.callAsync("each", [[3n, 1n, 2n]]), null);
      assert.deepEqual(visited, [3n, 1n, 2n]);
      visited.length = 0;
      assert.equal(await hosted.callAsync("each", [[]]), null);
      assert.deepEqual(visited, []);
    } finally {
      await hosted.close();
    }
    for (
      const path of [
        "examples/option_result.blot",
        "examples/collection_effects.blot",
      ]
    ) {
      const evaluated = await compiler.evaluate(path);
      const hosted = await instantiateArtifact(await compiler.compile(path));
      try {
        const value = hosted.call("default");
        if (Array.isArray(value)) {
          assert.equal(`[${value.map(String).join(", ")}]`, evaluated.display);
        } else {
          assert.equal(String(value), evaluated.display);
        }
      } finally {
        await hosted.close();
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("native editor holes expose checked local types and cannot emit", async () => {
  const compiler = await Compiler.create();
  const path = resolve("examples/rejected/semantics/expression_hole.blot");
  try {
    const source = await readFile(path, "utf8");
    for (
      const check of [
        () => compiler.analyze(path),
        () => compiler.compile(path),
      ]
    ) {
      await assert.rejects(check, (error: unknown) => {
        assert(error instanceof BlotError);
        assert.equal(error.diagnostic.code, "BLOT_EXPRESSION_HOLE");
        assert.match(error.diagnostic.message, /expected Int/);
        assert.match(error.diagnostic.message, /input: Int/);
        assert.match(error.diagnostic.message, /offset: Int/);
        assert.equal(
          error.diagnostic.span.start,
          source.indexOf("return _") + 7,
        );
        return true;
      });
    }
    await compiler.checkSource(
      path,
      source.replace("return _", "return input + offset"),
    );
    const hosted = await instantiateArtifact(await compiler.compile(path));
    try {
      assert.equal(hosted.call("run", [40n]), 42n);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});
