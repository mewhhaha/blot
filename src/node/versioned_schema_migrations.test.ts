import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/versioned_schema_migrations.blot";
const libraryPath = "examples/lib/versioned_migration.blot";
const pendingNominalPath = "examples/pending/versioned_nominal_migration.blot";
const wrongVersionPath =
  "src/node/fixtures/versioned_migration_wrong_version.blot";
const wrongOrderPath = "src/node/fixtures/versioned_migration_wrong_order.blot";
const invalidV3Path = "src/node/fixtures/versioned_migration_invalid_v3.blot";

const principalType =
  "{ .default = { .valid = { .status = Text; .timeout_ms = Int; .retry_limit = Int }; .invalid_seconds = { .status = Text; .timeout_ms = Int; .retry_limit = Int }; .invalid_retry = { .status = Text; .timeout_ms = Int; .retry_limit = Int }; .boundary = { .status = Text; .timeout_ms = Int; .retry_limit = Int } } }";

const blotPaths = [
  libraryPath,
  examplePath,
  pendingNominalPath,
  wrongVersionPath,
  wrongOrderPath,
  invalidV3Path,
] as const;

test("versioned migrations compose exact schemas in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
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
        "examples/expected/versioned_schema_migrations.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/versioned_schema_migrations.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("versioned migrations reject wrong stages and refined payloads", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(wrongVersionPath),
      /BLOT_TYPE_ERROR: #V2 .* does not flow into #V1/,
    );
    await assert.rejects(
      () => compiler.check(wrongOrderPath),
      /BLOT_TYPE_ERROR: #C Int does not flow into #A Int/,
    );
    await assert.rejects(
      () => compiler.check(invalidV3Path),
      /BLOT_TYPE_ERROR: 8 does not flow into 1\.\.5/,
    );
  } finally {
    compiler.destroy();
  }
});

test("pending nominal migration records the current bottom-type mismatch", async () => {
  const compiler = await Compiler.create();
  try {
    assert.deepEqual(await compiler.check(pendingNominalPath), {
      type: "⊥",
      effects: "",
      interfaceKey: '["⊥",""]',
    });

    const evaluated = await compiler.evaluate(pendingNominalPath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/versioned_nominal_migration.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(pendingNominalPath)),
      (await readFile(
        "examples/expected/versioned_nominal_migration.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});
