import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/stateful_processors.blot";
const libraryPath = "examples/lib/stream_processor.blot";
const compositionMismatchPath =
  "src/node/fixtures/stream_processor_composition_mismatch.blot";
const inputMismatchPath =
  "src/node/fixtures/stream_processor_input_mismatch.blot";
const rankRunnerPath =
  "src/node/fixtures/stream_processor_rank_polymorphic_run.blot";

const blotPaths = [
  libraryPath,
  examplePath,
  compositionMismatchPath,
  inputMismatchPath,
  rankRunnerPath,
] as const;

async function expectCode(
  compiler: Compiler,
  path: string,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(
    () => compiler.check(path),
    (error: unknown) => {
      assert(error instanceof BlotError);
      assert.equal(error.diagnostic.code, expectedCode);
      return true;
    },
  );
}

test("stateful stream processors compose typed stages and preserve suppression", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(examplePath);
    assert.equal(checked.effects, "");
    assert.equal(checked.interfaceKey, JSON.stringify([checked.type, ""]));
    assert.match(checked.type, /\.alerts =/);
    assert.match(checked.type, /\.duplicate_only =/);
    assert.match(checked.type, /\.empty =/);

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/stateful_processors.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/stateful_processors.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("processor descriptors enforce stage adjacency and input carriers", async () => {
  const compiler = await Compiler.create();
  try {
    await expectCode(compiler, compositionMismatchPath, "BLOT_TYPE_ERROR");
    await expectCode(compiler, inputMismatchPath, "BLOT_TYPE_ERROR");
    await expectCode(compiler, rankRunnerPath, "BLOT_TYPE_ERROR");
  } finally {
    compiler.destroy();
  }
});
