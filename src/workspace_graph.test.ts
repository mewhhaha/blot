import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load, type Loaded } from "./load.ts";
import { WorkspaceGraph } from "./workspace_graph.ts";

test("a pinned module is not reread from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-pinned-"));
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  try {
    await writeFile(dependency, "return 1\n");
    const pinned = await load(dependency, new Map());
    await rm(dependency);
    await writeFile(
      root,
      'const dependency = import "./dependency.blot"\nreturn dependency\n',
    );
    const graph = new WorkspaceGraph(undefined, [pinned]);

    const loaded = await graph.refresh(root);
    assert.equal(loaded.dependencies.get("./dependency.blot"), pinned);
    assert.equal(
      (await graph.refresh(root)).dependencies.get("./dependency.blot"),
      pinned,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a pinned dependency does not materialize its module", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-lazy-pinned-"),
  );
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const pinned: Loaded = {
    get module(): never {
      throw new Error("pinned module was materialized");
    },
    dependencies: new Map(),
    includedFiles: new Map(),
    source: "",
    path: dependency,
    storage: { tag: "snapshot", digest: "test-pinned-snapshot" },
  };
  try {
    await writeFile(
      root,
      'const dependency = import "./dependency.blot"\nreturn dependency\n',
    );
    const graph = new WorkspaceGraph(undefined, [pinned]);

    const loaded = await graph.refresh(root);
    assert.equal(loaded.dependencies.get("./dependency.blot"), pinned);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("workspace overlays persist and reveal the latest disk revision on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-overlay-"));
  const path = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(path, "return 1\n");
    const disk = await graph.refresh(path);
    assert.equal(disk.source, "return 1\n");

    const overlay = await graph.updateOverlay(path, "return 2\n", 1);
    assert.equal(overlay.source, "return 2\n");
    await writeFile(path, "return 3\n");
    assert.equal((await graph.refresh(path)).source, "return 2\n");

    const revealed = await graph.closeOverlay(path);
    assert.equal(revealed.source, "return 3\n");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a dependency overlay invalidates exact cached importers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-dependency-"));
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(dependency, "return 1\n");
    await writeFile(
      root,
      'const dependency = import "./dependency.blot"\nreturn dependency\n',
    );
    const first = await graph.refresh(root);
    const firstDependency = first.dependencies.get("./dependency.blot");
    assert.equal(firstDependency?.source, "return 1\n");

    await graph.updateOverlay(dependency, "return 2\n", 1);
    const changed = await graph.refresh(root);
    const changedDependency = changed.dependencies.get("./dependency.blot");
    assert.equal(changedDependency?.source, "return 2\n");
    assert.notEqual(changed, first);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("compiler inspection discovers each changed source revision once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-inspection-"));
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const inspections = new Map<string, number>();
  const graph = new WorkspaceGraph((path, source) => {
    inspections.set(path, (inspections.get(path) ?? 0) + 1);
    const imports = source.includes("import")
      ? [{
        specifier: "./dependency.blot",
        span: { start: source.indexOf('"'), end: source.lastIndexOf('"') + 1 },
      }]
      : [];
    return {
      imports,
      includes: [],
      moduleHandle: path,
      portableAstDigest: `test:${source.length}`,
    };
  });
  try {
    await writeFile(dependency, "return 1\n");
    await writeFile(
      root,
      'const dependency = import "./dependency.blot"\nreturn dependency\n',
    );
    await graph.refresh(root);
    await graph.refresh(root);
    assert.equal(inspections.get(root), 1);
    assert.equal(inspections.get(dependency), 1);

    await graph.updateOverlay(
      root,
      'const dependency = import "./dependency.blot"\nreturn (dependency, 2)\n',
      1,
    );
    assert.equal(inspections.get(root), 2);
    assert.equal(inspections.get(dependency), 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});
