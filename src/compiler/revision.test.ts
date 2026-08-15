import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSource } from "../load.ts";
import { loadedRevisionKey } from "./revision.ts";

test("semantic revision keys are fixed-size dependency digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-revision-key-"));
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const source = 'const dependency = @import "./dependency.blot"\nreturn dependency ()\n';
  try {
    await writeFile(dependency, "module ()\nreturn 42\n");
    const first = await loadSource(root, source);
    const firstKey = loadedRevisionKey(first);
    assert.match(firstKey, /^[0-9a-f]{64}$/);

    const commentOnly = await loadSource(root, `${source}\n// comment only\n`);
    assert.equal(loadedRevisionKey(commentOnly), firstKey);

    await writeFile(dependency, "module ()\nreturn 43\n");
    const changedDependency = await loadSource(root, source);
    assert.notEqual(loadedRevisionKey(changedDependency), firstKey);
    assert.match(loadedRevisionKey(changedDependency), /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
