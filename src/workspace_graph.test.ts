import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load, type Loaded } from "./load.ts";
import { buildPackage } from "./package.ts";
import { PACKAGE_FORMAT_VERSION } from "./package_format.ts";
import { Compiler } from "./compiler/session.ts";
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

    const [revealed] = await graph.closeOverlay(path);
    assert.equal(revealed?.source, "return 3\n");
    assert.equal(graph.activePaths().has(path), true);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("releasing a root preserves its overlay for a later root", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-root-overlay-"),
  );
  const path = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(path, "return 1\n");
    await graph.updateOverlay(path, "return 2\n", 1);

    graph.releaseRoot(path);
    assert.equal(graph.activePaths().has(path), false);
    assert.equal(graph.committedRevision(path), undefined);
    assert.equal((await graph.refresh(path)).source, "return 2\n");

    graph.releaseRoot(path);
    assert.deepEqual(await graph.closeOverlay(path), []);
    assert.equal((await graph.refresh(path)).source, "return 1\n");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("releasing one root preserves dependencies shared by another root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-roots-"));
  const shared = join(directory, "shared.blot");
  const first = join(directory, "first.blot");
  const second = join(directory, "second.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(shared, "return 1\n");
    await writeFile(first, 'return import "./shared.blot"\n');
    await writeFile(second, 'return import "./shared.blot"\n');
    await graph.refresh(first);
    await graph.refresh(second);

    graph.releaseRoot(first);
    assert.equal(graph.activePaths().has(first), false);
    assert.equal(graph.committedRevision(first), undefined);
    assert.equal(graph.activePaths().has(second), true);
    assert.equal(graph.activePaths().has(shared), true);

    graph.releaseRoot(second);
    assert.equal(graph.activePaths().has(second), false);
    assert.equal(graph.activePaths().has(shared), false);
    assert.equal(graph.committedRevision(second), undefined);
    assert.equal(graph.committedRevision(shared), undefined);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("closing a shared dependency overlay rebinds every remaining root", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-shared-overlay-"),
  );
  const shared = join(directory, "shared.blot");
  const first = join(directory, "first.blot");
  const second = join(directory, "second.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(shared, "return 1\n");
    await writeFile(first, 'return import "./shared.blot"\n');
    await writeFile(second, 'return import "./shared.blot"\n');
    await graph.refresh(first);
    await graph.refresh(second);
    await graph.updateOverlay(shared, "return 2\n", 1);
    graph.releaseRoot(shared);
    await writeFile(shared, "return 3\n");

    const rebound = await graph.closeOverlay(shared);
    assert.deepEqual(
      new Set(rebound.map((root) => root.path)),
      new Set([first, second]),
    );
    assert.equal(
      graph.committedRevision(first)?.dependencies.get("./shared.blot")
        ?.source,
      "return 3\n",
    );
    assert.equal(
      graph.committedRevision(second)?.dependencies.get("./shared.blot")
        ?.source,
      "return 3\n",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed implicit overlay update preserves its version for retry", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-overlay-transaction-"),
  );
  const path = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(path, "return 1\n");
    await graph.refresh(path);
    const first = await graph.updateOverlay(path, "return 2\n");
    assert.equal(graph.node(path)?.overlaySource?.version, 1);

    await assert.rejects(() => graph.updateOverlay(path, "return (\n"));
    assert.equal(graph.node(path)?.overlaySource?.source, "return 2\n");
    assert.equal(graph.node(path)?.overlaySource?.version, 1);
    assert.equal(graph.node(path)?.dirty, false);
    assert.strictEqual(await graph.refreshAfterKnownChanges(path), first);

    const recovered = await graph.updateOverlay(path, "return 3\n");
    assert.equal(recovered.source, "return 3\n");
    assert.equal(graph.node(path)?.overlaySource?.version, 2);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed new root does not remain active when later loaded as a dependency", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-failed-root-transaction-"),
  );
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(dependency, 'return import "./missing.blot"\n');
    await assert.rejects(() => graph.refresh(dependency));
    assert.equal(graph.activePaths().has(dependency), false);

    await writeFile(dependency, "return 1\n");
    await writeFile(root, 'return import "./dependency.blot"\n');
    await graph.refresh(root);
    assert.equal(graph.activePaths().has(dependency), true);

    await writeFile(root, "return 2\n");
    graph.markDirty(root);
    await graph.refreshAfterKnownChanges(root);
    assert.equal(graph.activePaths().has(dependency), false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed overlay close keeps the last successful overlay active", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-overlay-close-transaction-"),
  );
  const path = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(path, "return 1\n");
    await graph.refresh(path);
    const overlay = await graph.updateOverlay(path, "return 2\n", 1);
    await writeFile(path, "return (\n");

    await assert.rejects(() => graph.closeOverlay(path));
    assert.equal(graph.node(path)?.overlaySource?.version, 1);
    assert.equal(graph.node(path)?.dirty, false);
    assert.strictEqual(await graph.refreshAfterKnownChanges(path), overlay);

    await writeFile(path, "return 3\n");
    const [recovered] = await graph.closeOverlay(path);
    assert.equal(recovered?.source, "return 3\n");
    assert.strictEqual(graph.node(path)?.overlaySource, undefined);
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

test("a known leaf edit does not read or reparse its importers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-leaf-edit-"));
  const leaf = join(directory, "leaf.blot");
  const middle = join(directory, "middle.blot");
  const root = join(directory, "root.blot");
  const inspections = new Map<string, number>();
  const graph = new WorkspaceGraph((path, source) => {
    let inspectionCount = 1;
    const previousCount = inspections.get(path);
    if (previousCount !== undefined) inspectionCount = previousCount + 1;
    inspections.set(path, inspectionCount);
    const imports = [...source.matchAll(/import "([^"]+)"/g)].map((match) => {
      const specifier = match[1];
      if (specifier === undefined || match.index === undefined) {
        throw new Error(`could not inspect imports in ${path}`);
      }
      const start = match.index + match[0].indexOf('"');
      return {
        specifier,
        span: { start, end: start + specifier.length + 2 },
      };
    });
    return {
      imports,
      includes: [],
      moduleHandle: path,
      portableAstDigest: `test:${source.length}`,
    };
  });
  try {
    await writeFile(leaf, "return 1\n");
    await writeFile(middle, 'return import "./leaf.blot"\n');
    await writeFile(root, 'return import "./middle.blot"\n');
    const first = await graph.refresh(root);
    const firstMiddle = first.dependencies.get("./middle.blot");
    const firstLeaf = firstMiddle?.dependencies.get("./leaf.blot");
    if (firstMiddle === undefined || firstLeaf === undefined) {
      throw new Error(`loaded ${root} omitted its dependency chain`);
    }

    await rename(root, `${root}.unavailable`);
    await rename(middle, `${middle}.unavailable`);
    await writeFile(leaf, "return 2\n");
    graph.markDirty(leaf);
    const changed = await graph.refreshAfterKnownChanges(root);
    const changedMiddle = changed.dependencies.get("./middle.blot");
    const changedLeaf = changedMiddle?.dependencies.get("./leaf.blot");
    if (changedMiddle === undefined || changedLeaf === undefined) {
      throw new Error(`refreshed ${root} omitted its dependency chain`);
    }

    assert.notStrictEqual(changed, first);
    assert.notStrictEqual(changedMiddle, firstMiddle);
    assert.notStrictEqual(changedLeaf, firstLeaf);
    assert.strictEqual(changed.module, first.module);
    assert.strictEqual(changedMiddle.module, firstMiddle.module);
    assert.equal(changedLeaf.source, "return 2\n");
    assert.equal(inspections.get(root), 1);
    assert.equal(inspections.get(middle), 1);
    assert.equal(inspections.get(leaf), 2);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a known refresh without changes performs no filesystem reads", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-unchanged-refresh-"),
  );
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(dependency, "return 1\n");
    await writeFile(root, 'return import "./dependency.blot"\n');
    const first = await graph.refresh(root);

    await rename(root, `${root}.unavailable`);
    await rename(dependency, `${dependency}.unavailable`);
    const unchanged = await graph.refreshAfterKnownChanges(root);

    assert.strictEqual(unchanged, first);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a failed known refresh leaves the previous graph active", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-transactional-refresh-"),
  );
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  const graph = new WorkspaceGraph();
  try {
    await writeFile(dependency, "return 1\n");
    await writeFile(root, 'return import "./dependency.blot"\n');
    const first = await graph.refresh(root);

    await writeFile(dependency, "return (\n");
    graph.markDirty(dependency);
    await assert.rejects(() => graph.refreshAfterKnownChanges(root));
    assert.equal(graph.node(dependency)?.diskSource, "return 1\n");
    assert.equal(graph.node(dependency)?.dirty, true);

    await writeFile(dependency, "return 2\n");
    const recovered = await graph.refreshAfterKnownChanges(root);
    assert.strictEqual(recovered.module, first.module);
    assert.equal(
      recovered.dependencies.get("./dependency.blot")?.source,
      "return 2\n",
    );
    assert.equal(graph.node(dependency)?.dirty, false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("package manifest edits rebind cached imports without reparsing the importer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-package-"));
  const root = join(directory, "entry.blot");
  const packageRoot = join(directory, "node_modules", "answer");
  const manifest = join(packageRoot, "blot.json");
  const graph = new WorkspaceGraph();
  const describe = (source: string): string =>
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source } },
    });
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(root, 'return import "answer"\n');
    await writeFile(join(packageRoot, "first.blot"), "return 1\n");
    await writeFile(join(packageRoot, "second.blot"), "return 2\n");
    await writeFile(manifest, describe("./first.blot"));
    const first = await graph.refresh(root);

    await writeFile(manifest, describe("./second.blot"));
    const second = await graph.refresh(root);
    assert.strictEqual(second.module, first.module);
    assert.equal(second.dependencies.get("answer")?.source, "return 2\n");

    await writeFile(manifest, describe("./first.blot"));
    graph.markDirty(manifest);
    const reverted = await graph.refreshAfterKnownChanges(root);
    assert.equal(reverted.dependencies.get("answer")?.source, "return 1\n");

    await rename(manifest, `${manifest}.unavailable`);
    assert.strictEqual(await graph.refreshAfterKnownChanges(root), reverted);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a warm compiler agrees with a fresh compiler after a package export moves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-compiler-package-"));
  const root = join(directory, "entry.blot");
  const packageRoot = join(directory, "node_modules", "answer");
  const manifest = join(packageRoot, "blot.json");
  const compiler = await Compiler.create();
  const describe = (source: string): string =>
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source } },
    });
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(root, 'return import "answer"\n');
    await writeFile(join(packageRoot, "first.blot"), "return 1\n");
    await writeFile(join(packageRoot, "second.blot"), "return 2\n");
    await writeFile(manifest, describe("./first.blot"));
    assert.equal((await compiler.evaluate(root)).display, "1");
    await writeFile(manifest, describe("./second.blot"));
    const fresh = await Compiler.create();
    try {
      const expected = await fresh.evaluate(root);
      assert.equal(expected.display, "2");
      assert.deepEqual(await compiler.evaluate(root), expected);
    } finally {
      fresh.destroy();
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("a full refresh notices a newly available package capsule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-workspace-capsule-"));
  const root = join(directory, "entry.blot");
  const packageRoot = join(directory, "node_modules", "answer");
  const manifest = join(packageRoot, "blot.json");
  const graph = new WorkspaceGraph();
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(root, 'return import "answer"\n');
    await writeFile(join(packageRoot, "mod.blot"), "return 42\n");
    await writeFile(
      manifest,
      JSON.stringify({
        schema: "blot-package",
        version: PACKAGE_FORMAT_VERSION,
        exports: { ".": { source: "./mod.blot", built: "./mod.blotc" } },
      }),
    );
    const first = await graph.refresh(root);
    assert.equal(first.dependencies.get("answer")?.storage.tag, "source");
    await buildPackage(manifest);
    const second = await graph.refresh(root);
    assert.strictEqual(second.module, first.module);
    assert.equal(second.dependencies.get("answer")?.storage.tag, "capsule");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a package resolution failure preserves the committed graph", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-workspace-package-failure-"),
  );
  const root = join(directory, "entry.blot");
  const packageRoot = join(directory, "node_modules", "answer");
  const manifest = join(packageRoot, "blot.json");
  const graph = new WorkspaceGraph();
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(root, 'return import "answer"\n');
    await writeFile(join(packageRoot, "mod.blot"), "return 42\n");
    const valid = JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source: "./mod.blot" } },
    });
    await writeFile(manifest, valid);
    const first = await graph.refresh(root);
    await writeFile(manifest, "{");
    graph.markDirty(manifest);
    await assert.rejects(() => graph.refreshAfterKnownChanges(root));
    assert.strictEqual(graph.committedRevision(root), first);
    await writeFile(manifest, valid);
    assert.strictEqual(await graph.refreshAfterKnownChanges(root), first);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("cached capsule edges notice a nearer package installation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-capsule-package-refresh-"),
  );
  const root = join(directory, "entry.blot");
  const wrapper = join(directory, "node_modules", "wrapper");
  const graph = new WorkspaceGraph();
  const manifest = JSON.stringify({
    schema: "blot-package",
    version: PACKAGE_FORMAT_VERSION,
    exports: { ".": { source: "./mod.blot" } },
  });
  try {
    const outer = join(directory, "node_modules", "answer");
    await mkdir(outer, { recursive: true });
    await writeFile(join(outer, "blot.json"), manifest);
    await writeFile(join(outer, "mod.blot"), "return 1\n");
    await mkdir(wrapper);
    await writeFile(join(wrapper, "mod.blot"), 'return import "answer"\n');
    const wrapperManifest = join(wrapper, "blot.json");
    await writeFile(
      wrapperManifest,
      JSON.stringify({
        schema: "blot-package",
        version: PACKAGE_FORMAT_VERSION,
        exports: { ".": { source: "./mod.blot", built: "./mod.blotc" } },
      }),
    );
    await buildPackage(wrapperManifest);
    await writeFile(root, 'return import "wrapper"\n');
    const first = await graph.refresh(root);
    const previous = first.dependencies.get("wrapper");
    assert.equal(previous?.storage.tag, "capsule");
    assert.equal(previous?.dependencies.get("answer")?.source, "return 1\n");

    const nearer = join(wrapper, "node_modules", "answer");
    await mkdir(nearer, { recursive: true });
    await writeFile(join(nearer, "blot.json"), manifest);
    await writeFile(join(nearer, "mod.blot"), "return 2\n");
    const second = await graph.refresh(root);
    const rebound = second.dependencies.get("wrapper");
    assert.strictEqual(second.module, first.module);
    assert.strictEqual(rebound?.module, previous?.module);
    assert.equal(rebound?.storage.tag, "capsule");
    assert.equal(rebound?.dependencies.get("answer")?.source, "return 2\n");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("package changes remain pending for every open root", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-package-multiple-roots-"),
  );
  const packageRoot = join(directory, "node_modules", "answer");
  const firstRoot = join(directory, "first.blot");
  const secondRoot = join(directory, "second.blot");
  const manifest = join(packageRoot, "blot.json");
  const graph = new WorkspaceGraph();
  const describe = (source: string): string =>
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source } },
    });
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(firstRoot, 'return import "answer"\n');
    await writeFile(secondRoot, 'return import "answer"\n');
    await writeFile(join(packageRoot, "old.blot"), "return 1\n");
    await writeFile(join(packageRoot, "new.blot"), "return 2\n");
    await writeFile(manifest, describe("./old.blot"));
    await graph.refresh(firstRoot);
    const previousSecond = await graph.refresh(secondRoot);
    await writeFile(manifest, describe("./new.blot"));
    graph.markDirty(manifest);
    const first = await graph.refreshAfterKnownChanges(firstRoot);
    assert.equal(first.dependencies.get("answer")?.source, "return 2\n");
    const second = await graph.refreshAfterKnownChanges(secondRoot);
    assert.strictEqual(second.module, previousSecond.module);
    assert.equal(second.dependencies.get("answer")?.source, "return 2\n");

    await writeFile(manifest, describe("./old.blot"));
    await graph.refresh(firstRoot);
    const reverted = await graph.refreshAfterKnownChanges(secondRoot);
    assert.equal(reverted.dependencies.get("answer")?.source, "return 1\n");
    await rename(manifest, `${manifest}.unavailable`);
    assert.strictEqual(
      await graph.refreshAfterKnownChanges(secondRoot),
      reverted,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
