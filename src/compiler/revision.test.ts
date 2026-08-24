import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSource } from "../load.ts";
import {
  loadedConfigurationDigest,
  loadedPayloadDigest,
  loadedRevisionKey,
} from "./revision.ts";

test("origin-exact revision keys are fixed-size recursive digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-revision-key-"));
  const leaf = join(directory, "leaf.blot");
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const source =
    'const dependency = import "./dependency.blot"\nreturn dependency\n';
  try {
    await writeFile(leaf, "return 42\n");
    await writeFile(
      dependency,
      'const leaf = import "./leaf.blot"\nreturn leaf\n',
    );
    const first = await loadSource(root, source);
    const firstKey = loadedRevisionKey(first);
    assert.match(firstKey, /^[0-9a-f]{64}$/);

    const rootCommentOnly = await loadSource(
      root,
      `${source}\n// comment only\n`,
    );
    assert.equal(loadedRevisionKey(rootCommentOnly), firstKey);

    const shiftedRoot = await loadSource(root, `// shifts origins\n${source}`);
    assert.notEqual(loadedRevisionKey(shiftedRoot), firstKey);

    await writeFile(leaf, "return 42\n// dependency comment only\n");
    const dependencyCommentOnly = await loadSource(root, source);
    assert.equal(loadedRevisionKey(dependencyCommentOnly), firstKey);

    await writeFile(leaf, "return 43\n");
    const changedGrandchild = await loadSource(root, source);
    assert.notEqual(loadedRevisionKey(changedGrandchild), firstKey);
    assert.match(loadedRevisionKey(changedGrandchild), /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("module payload and direct configuration digests vary independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-module-revision-"));
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const source = 'const dependency = import "./dependency.blot"\nreturn 1\n';
  try {
    await writeFile(dependency, "return 1\n");
    const first = await loadSource(root, source);
    const payload = loadedPayloadDigest(first);
    const configuration = loadedConfigurationDigest(first);

    await writeFile(dependency, "return 2\n");
    const changedDependency = await loadSource(root, source);
    assert.equal(loadedPayloadDigest(changedDependency), payload);
    assert.equal(
      loadedConfigurationDigest(changedDependency),
      configuration,
      "a dependency payload is not a direct edge configuration change",
    );

    const changedRoot = await loadSource(
      root,
      source.replace("return 1", "return 2"),
    );
    assert.notEqual(loadedPayloadDigest(changedRoot), payload);
    assert.equal(loadedConfigurationDigest(changedRoot), configuration);
  } finally {
    await rm(directory, { recursive: true });
  }
});
