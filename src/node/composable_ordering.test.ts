import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

test("composable ordering executes through emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    await compiler.check("examples/composable_ordering.blot");
    const artifact = await compiler.compile(
      "examples/composable_ordering.blot",
    );
    const expected = await readFile(
      "examples/expected/composable_ordering.wasm.txt",
      "utf8",
    );
    assert.equal(await runArtifact(artifact), expected.trim());
  } finally {
    compiler.destroy();
  }
});

test("composable ordering sources stay canonical", async () => {
  for (
    const path of [
      "examples/lib/order.blot",
      "examples/composable_ordering.blot",
    ]
  ) {
    const source = await readFile(path, "utf8");
    assert.match(source, /Pain point:/);
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error(`${path} failed to format`);
    assert.equal(formatted.source, source);
  }
});

test("order projection rejects a mismatched key type", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/order_key_mismatch.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});

test("annotated order composition rejects mixed subject types", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/order_subject_mismatch.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
