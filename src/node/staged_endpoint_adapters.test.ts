import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/staged_endpoint_adapters.blot";
const libraryPath = "examples/lib/endpoint_adapter.blot";
const monomorphicPath =
  "src/node/fixtures/endpoint_adapter_monomorphic_transform.blot";
const wrongTransformPath =
  "src/node/fixtures/endpoint_adapter_wrong_transform.blot";
const wrongOutputPath = "src/node/fixtures/endpoint_adapter_wrong_output.blot";
const inferredPath =
  "src/node/fixtures/endpoint_adapter_inferred_composition.blot";

const expectedType =
  "{ .default = { .required_api = #Ok 1..65535 | #Error Text; .required_missing = #Ok 1..65535 | #Error Text; .observed_admin = #Ok { .value = 1..65535; .source = Text } | #Error Text; .observed_owner = #Ok { .value = Text; .source = Text } | #Error Text; .observed_owner_missing = #Ok { .value = Text; .source = Text } | #Error Text } }";

const blotPaths = [
  libraryPath,
  examplePath,
  monomorphicPath,
  wrongTransformPath,
  wrongOutputPath,
  inferredPath,
] as const;

test("staged endpoint adapters preserve payload types in both executions", async () => {
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
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      { type: expectedType, effects: "" },
    );

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/staged_endpoint_adapters.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/staged_endpoint_adapters.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("staged endpoint adapters reject broken payload relationships", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [monomorphicPath, wrongTransformPath, wrongOutputPath]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});

test("staged endpoint adapters retain an inferred composition's Rank-N result", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(inferredPath);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      {
        type: "#Ok { .value = Text; .source = Text } | #Error Text",
        effects: "",
      },
    );
    const evaluated = await compiler.evaluate(inferredPath);
    assert.equal(
      evaluated.display,
      '#Ok { .value = "Żaneta"; .source = "registry"; }',
    );
    assert.equal(
      await runArtifact(await compiler.compile(inferredPath)),
      '#Ok { .source = "registry"; .value = "Żaneta" }',
    );
  } finally {
    compiler.destroy();
  }
});
