import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/renderable_observations.blot";
const libraryPath = "examples/lib/renderable.blot";
const rendererMismatchPath =
  "src/node/fixtures/renderable_renderer_mismatch.blot";
const specializedConsumerPath =
  "src/node/fixtures/renderable_specialized_consumer.blot";

const principalType = "{ .default = { .plain = [Text]; .empty = [Text] } }";

const formattedPaths = [
  libraryPath,
  examplePath,
  rendererMismatchPath,
  specializedConsumerPath,
] as const;

test("renderable observations preserve hidden value/renderer relationships", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of formattedPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    assert.deepEqual(await compiler.check(examplePath), {
      type: principalType,
      effects: "",
      interfaceKey: JSON.stringify([principalType, ""]),
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/renderable_observations.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/renderable_observations.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("renderable observations reject mismatched renderers and monomorphic unpacking", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(rendererMismatchPath),
      /BLOT_TYPE_ERROR: 443 does not flow into Text/,
    );
    await assert.rejects(
      () => compiler.check(specializedConsumerPath),
      /BLOT_TYPE_ERROR: 's\d+ does not flow into Int/,
    );
  } finally {
    compiler.destroy();
  }
});
