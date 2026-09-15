import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/interpretable_policies.blot";
const libraryPath = "examples/lib/interpretable_policy.blot";
const subjectMismatchPath =
  "src/node/fixtures/interpretable_policy_subject_mismatch.blot";
const badProjectionPath =
  "src/node/fixtures/interpretable_policy_bad_projection.blot";
const invalidQuotaPath =
  "src/node/fixtures/interpretable_policy_invalid_quota.blot";

const principalType =
  "{ .default = { .admin = { .allowed = #True | #False; .trace = { .allowed = #True | #False; .notes = [Text] } }; .member = { .allowed = #True | #False; .trace = { .allowed = #True | #False; .notes = [Text] } }; .over_limit = { .allowed = #True | #False; .trace = { .allowed = #True | #False; .notes = [Text] } }; .wrong_region = { .allowed = #True | #False; .trace = { .allowed = #True | #False; .notes = [Text] } } } }";
const interfaceType = principalType.replaceAll("#True | #False", "#False | #True");

const blotPaths = [
  libraryPath,
  examplePath,
  subjectMismatchPath,
  badProjectionPath,
  invalidQuotaPath,
] as const;

test("interpretable policies preserve one subject across reusable interpreters", async () => {
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
      interfaceKey: JSON.stringify([interfaceType, ""]),
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/interpretable_policies.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/interpretable_policies.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("interpretable policies reject mismatched subjects and refinements", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(subjectMismatchPath),
      /BLOT_TYPE_ERROR: #Left Int does not flow into #Right Int/,
    );
    await assert.rejects(
      () => compiler.check(badProjectionPath),
      /BLOT_TYPE_ERROR: Text does not flow into \{ \.region = Text \}/,
    );
    await assert.rejects(
      () => compiler.check(invalidQuotaPath),
      /BLOT_TYPE_ERROR: 0 does not flow into 1\.\.100/,
    );
  } finally {
    compiler.destroy();
  }
});
