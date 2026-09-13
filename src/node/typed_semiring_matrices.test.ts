import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const example = "examples/typed_semiring_matrices.blot";
const library = "examples/lib/semiring_matrix.blot";
const mismatchFixture = "src/node/fixtures/semiring_carrier_mismatch.blot";
const matrixMismatchFixture = "src/node/fixtures/semiring_matrix_mismatch.blot";

test(
  "typed semiring matrices preserve one carrier in both executions",
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
      assert.match(checked.type, /\.walks =/);
      assert.match(checked.type, /\.costs =/);

      const evaluated = await compiler.evaluate(example);
      const expected = await readFile(
        "examples/expected/typed_semiring_matrices.txt",
        "utf8",
      );
      const expectedWasm = await readFile(
        "examples/expected/typed_semiring_matrices.wasm.txt",
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
  "typed semiring matrices reject mixed carriers",
  async () => {
    const compiler = await Compiler.create();
    try {
      for (const path of [mismatchFixture, matrixMismatchFixture]) {
        await assert.rejects(() => compiler.check(path), /BLOT_TYPE_ERROR/);
      }
    } finally {
      compiler.destroy();
    }
  },
);
