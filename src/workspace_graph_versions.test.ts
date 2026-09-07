import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceGraph } from "./workspace_graph.ts";

const invalidVersions = [
  NaN,
  Infinity,
  -Infinity,
  1.5,
  -1.5,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_SAFE_INTEGER - 1,
];

for (const version of invalidVersions) {
  test(`invalid overlay version ${version} cannot publish state`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-overlay-version-"));
    const path = join(directory, "root.blot");
    const graph = new WorkspaceGraph();
    try {
      await writeFile(path, "return 1\n");
      const disk = await graph.refresh(path);
      await assert.rejects(
        graph.updateOverlay(path, "return 2\n", version),
        /version must be a safe integer/,
      );
      assert.equal(graph.committedRevision(path), disk);
      assert.equal(graph.node(path)?.overlaySource, undefined);
      await graph.updateOverlay(path, "return 3\n");
      assert.deepEqual(graph.node(path)?.overlaySource, {
        source: "return 3\n",
        version: 1,
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
}

test("signed versions remain ordered and identical updates are idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-overlay-signed-"));
  const path = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(path, "return 0\n");
    await graph.updateOverlay(path, "return 1\n", -2);
    const revision = await graph.updateOverlay(path, "return 2\n", -1);
    assert.equal(await graph.updateOverlay(path, "return 2\n", -1), revision);
    await assert.rejects(
      graph.updateOverlay(path, "return 3\n", -1),
      /does not follow/,
    );
    await assert.rejects(
      graph.updateOverlay(path, "return 3\n", -2),
      /does not follow/,
    );
    assert.equal(graph.committedRevision(path), revision);
    await graph.updateOverlay(path, "return 3\n", 0);
    assert.equal(graph.node(path)?.overlaySource?.version, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("automatic overlay version overflow rolls back its sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-overlay-overflow-"));
  const path = join(directory, "root.blot");
  const other = join(directory, "other.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(path, "return 0\n");
    await writeFile(other, "return 0\n");
    const revision = await graph.updateOverlay(
      path,
      "return 1\n",
      Number.MAX_SAFE_INTEGER,
    );
    await assert.rejects(
      graph.updateOverlay(path, "return 2\n"),
      /version must be a safe integer/,
    );
    assert.equal(graph.committedRevision(path), revision);
    assert.equal(
      graph.node(path)?.overlaySource?.version,
      Number.MAX_SAFE_INTEGER,
    );
    await graph.updateOverlay(other, "return 3\n");
    assert.equal(graph.node(other)?.overlaySource?.version, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});
