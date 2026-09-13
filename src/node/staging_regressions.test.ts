import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";
import { scalarExport } from "../../test_support/guest_abi.ts";

test("rebinding survives dead-value removal and preserves lexical captures", async () => {
  const compiler = await Compiler.create();
  const path =
    new URL("../../examples/literal_rebinding.blot", import.meta.url).pathname;
  try {
    assert.equal((await compiler.evaluate(path)).display, "[7, 7, 0, 7]");
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      "[7, 7, 0, 7]",
    );
    await assert.rejects(
      () =>
        compiler.checkSource(
          "/tmp/blot-unbound-rebinding.blot",
          "missing := 7\nreturn 0\n",
        ),
      /BLOT_UNBOUND/,
    );
  } finally {
    compiler.destroy();
  }
});

test("nested array traversal resolves forwarded integer operations", async () => {
  const compiler = await Compiler.create();
  const directory = await mkdtemp(join(tmpdir(), "blot-nested-runtime-"));
  try {
    const path = join(directory, "nested.blot");
    await writeFile(
      path,
      await readFile(
        new URL(
          "../../examples/dynamic_nested_loop_accumulator.blot",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const run = scalarExport(instance, "blot:default");
    for (const [count, expected] of [[0n, 100n], [2n, 110n], [20n, 200n]]) {
      assert.equal(run(count), expected);
      const evaluation = join(directory, "evaluate.blot");
      await writeFile(
        evaluation,
        `const run = import "./nested.blot"\nreturn run ${count}\n`,
      );
      assert.equal(
        (await compiler.evaluate(evaluation)).display,
        String(expected),
      );
    }
    assert.equal(run(100000n), 500100n);
    assert.deepEqual((await compiler.compile(path)).wasm, artifact.wasm);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent residual checks retain integer and array representations", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-residual-representations-"),
  );
  const source = await readFile(
    new URL("../../examples/lib/owned_radix_sorts.blot", import.meta.url),
    "utf8",
  );
  try {
    for (
      const order of [["first", "last", "stable_ids"], [
        "stable_ids",
        "first",
        "last",
      ], ["last", "stable_ids", "first"]]
    ) {
      const compiler = await Compiler.create();
      try {
        const path = join(directory, "sorts.blot");
        const exports = order.map((name) => `.${name} = ${name};`).join(" ");
        await writeFile(
          path,
          source.slice(0, source.lastIndexOf("return {")) +
            `return { ${exports} }\n`,
        );
        const artifact = await compiler.compile(path);
        const { instance } = await WebAssembly.instantiate(
          Uint8Array.from(artifact.wasm),
        );
        assert.equal(
          scalarExport(instance, "blot:first")(1n),
          -9223372036854775808n,
        );
        assert.equal(
          scalarExport(instance, "blot:last")(1n),
          9223372036854775807n,
        );
        assert.equal(scalarExport(instance, "blot:stable_ids")(1n), 40201030n);
      } finally {
        compiler.destroy();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
