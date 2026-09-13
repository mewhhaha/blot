import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/derived_structural_diff.blot";

const expectedType =
  "{ .default = { .deployment_changed = [Text]; .deployment_equal = #True | #False; .same_changed = [Text]; .same_equal = #True | #False; .boundary_changed = [Text]; .account_changed = [Text]; .account_equal = #True | #False } }";

test("derived structural diff preserves its type and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const source = await readFile(path, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error("accepted example failed to format");
    assert.equal(formatted.source, source);

    assert.deepEqual(await compiler.check(path), {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/derived_structural_diff.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/derived_structural_diff.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("derived structural diff rejects values from another schema", async () => {
  const compiler = await Compiler.create();
  try {
    const source = await readFile(path, "utf8");
    await assert.rejects(
      () =>
        compiler.checkSource(
          "examples/derived_structural_diff_schema_mismatch.blot",
          source.replace(
            "account_diff.changed (account_before, account_after)",
            "account_diff.changed (deployment_before, account_after)",
          ),
        ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});

test("derived structural diff keeps the derivation ownership boundary", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () =>
        compiler.checkSource(
          "examples/derived_structural_diff_owned_field.blot",
          `open import "blot:prelude"
const Diff = import "./lib/structural_diff.blot"
const Snapshot = { .version = Int; .tags = [Text]; }
const snapshot_diff = Diff.derive Snapshot
return snapshot_diff
`,
        ),
      /BLOT_REFUSED/,
    );
  } finally {
    compiler.destroy();
  }
});
