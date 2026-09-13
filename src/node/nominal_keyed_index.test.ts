import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const example = "examples/nominal_keyed_index.blot";
const library = "examples/lib/nominal_index.blot";
const mismatchFixture = "src/node/fixtures/nominal_index_key_mismatch.blot";

test(
  "nominal keyed indexes preserve key domains in both executions",
  async () => {
    const compiler = await Compiler.create();
    try {
      for (const path of [library, example]) {
        const source = await readFile(path, "utf8");
        const formatted = await formatSource(source);
        assert.equal(formatted.ok, true);
        if (!formatted.ok) throw new Error(`${path} failed to format`);
        assert.equal(formatted.source, source);
      }

      const checked = await compiler.check(example);
      assert.equal(checked.effects, "");
      assert.match(checked.type, /\.user = #None \| #Some Text/);
      assert.match(checked.type, /\.project = #None \| #Some Text/);
      assert.match(checked.type, /\.missing_user = #None \| #Some Text/);

      const evaluated = await compiler.evaluate(example);
      const expected = await readFile(
        "examples/expected/nominal_keyed_index.txt",
        "utf8",
      );
      const expectedWasm = await readFile(
        "examples/expected/nominal_keyed_index.wasm.txt",
        "utf8",
      );
      assert.deepEqual(evaluated.writes, []);
      assert.equal(evaluated.display, expected.trim());
      assert.equal(
        await runArtifact(await compiler.compile(example)),
        expectedWasm.trim(),
      );
    } finally {
      compiler.destroy();
    }
  },
);

test(
  "nominal keyed indexes reject a key from another keyspace",
  async () => {
    const compiler = await Compiler.create();
    try {
      await assert.rejects(
        () => compiler.check(mismatchFixture),
        /BLOT_TYPE_ERROR/,
      );
    } finally {
      compiler.destroy();
    }
  },
);
