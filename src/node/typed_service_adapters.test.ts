import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/typed_service_adapters.blot";
const libraryPath = "examples/lib/service_adapter.blot";
const compositionMismatchPath =
  "src/node/fixtures/service_adapter_composition_mismatch.blot";
const handlerMismatchPath =
  "src/node/fixtures/service_adapter_handler_mismatch.blot";
const droppedEffectPath =
  "src/node/fixtures/service_adapter_dropped_effect.blot";

const principalType =
  "{ .default = { .pure = #Resolved #Service { .endpoint = Text; .status = #Ready | #Degraded Text }; .effectful = #Resolved #Service { .endpoint = Text; .status = #Ready | #Degraded Text }; .identity = { .endpoint = Text; .status = #Ready | #Degraded Text } } }";

const blotPaths = [
  libraryPath,
  examplePath,
  compositionMismatchPath,
  handlerMismatchPath,
  droppedEffectPath,
] as const;

test("typed service adapters compose boundaries and preserve service effects", async () => {
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
    assert.equal(checked.type, principalType);
    assert.equal(checked.effects, "");

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/typed_service_adapters.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/typed_service_adapters.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed service adapters reject incompatible composition and handlers", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of [compositionMismatchPath, handlerMismatchPath]) {
      await assert.rejects(
        () => compiler.check(path),
        (error: unknown) => {
          assert(error instanceof BlotError);
          assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
          return true;
        },
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("typed service adapters cannot erase wrapped callback effects", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(droppedEffectPath),
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
        assert.match(error.diagnostic.message, /does not flow into/);
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});
