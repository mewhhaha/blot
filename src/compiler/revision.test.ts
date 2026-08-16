import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSource } from "../load.ts";
import { loadedRevisionKey } from "./revision.ts";

test("semantic revision keys are fixed-size recursive digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-revision-key-"));
  const leaf = join(directory, "leaf.blot");
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const source =
    'const dependency = import "./dependency.blot"\nexport dependency\n';
  try {
    await writeFile(leaf, "export 42\n");
    await writeFile(
      dependency,
      'const leaf = import "./leaf.blot"\nexport leaf\n',
    );
    const first = await loadSource(root, source);
    const firstKey = loadedRevisionKey(first);
    assert.match(firstKey, /^[0-9a-f]{64}$/);

    const rootCommentOnly = await loadSource(
      root,
      `${source}\n// comment only\n`,
    );
    assert.equal(loadedRevisionKey(rootCommentOnly), firstKey);

    await writeFile(leaf, "export 42\n// dependency comment only\n");
    const dependencyCommentOnly = await loadSource(root, source);
    assert.equal(loadedRevisionKey(dependencyCommentOnly), firstKey);

    await writeFile(leaf, "export 43\n");
    const changedGrandchild = await loadSource(root, source);
    assert.notEqual(loadedRevisionKey(changedGrandchild), firstKey);
    assert.match(loadedRevisionKey(changedGrandchild), /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
