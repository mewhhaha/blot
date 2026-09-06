import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";
import type { BlotAbiType } from "../compiler/backend/runtime/abi.ts";
import { indirectResultFixture } from "../../test_support/indirect_result_fixture.ts";

test("run copies and releases an indirect structured result", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve("examples/conditions.blot"),
    );
    const expected =
      '{ .0 = "one"; .1 = "three"; .2 = "second"; .3 = "small"; .4 = "large" }';
    assert.equal(await runArtifact(artifact), expected);
    assert.equal(await runArtifact(artifact), expected);
  } finally {
    compiler.destroy();
  }
});

test("run renders arrays and variants from canonical memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-run-"));
  const path = join(directory, "structured.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "return ([1, 2, 3], #Some 7)\n");
    const artifact = await compiler.compile(path);
    assert.equal(
      await runArtifact(artifact),
      "{ .0 = [1, 2, 3]; .1 = #Some 7 }",
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("run decodes deeply nested canonical records without repeated layout work", async () => {
  let type: BlotAbiType = { kind: "text" };
  let expected = '"blot"';
  for (let depth = 0; depth < 64; depth += 1) {
    type = { kind: "record", fields: [{ name: "value", type }] };
    expected = `{ .value = ${expected} }`;
  }
  const data = new Uint8Array(68);
  const view = new DataView(data.buffer);
  view.setUint32(0, 64, true);
  view.setUint32(4, 4, true);
  data.set(new TextEncoder().encode("blot"), 64);
  const artifact = indirectResultFixture(type, data);
  assert.equal(await runArtifact(artifact), expected);
  assert.equal(await runArtifact(artifact), expected);
});
