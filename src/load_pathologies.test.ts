import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cachedDiamond,
  writeDiamond,
} from "../experiments/workspace-graph/fixtures.ts";
import { BlotError } from "./diagnostic.ts";
import { load, type Loaded, refreshLoadedModules } from "./load.ts";

for (const depth of [4, 8, 16, 32]) {
  test(`depth-${depth} diamond expands each node once per load`, async () => {
    const visits = new Map<string, number>();
    const fixture = cachedDiamond(depth, (path) => {
      const count = visits.get(path);
      assert.equal(count, undefined, `revisited shared dependency ${path}`);
      visits.set(path, 1);
    });
    const original = fixture.cache.get(fixture.root);
    assert.strictEqual(await load(fixture.root, fixture.cache), original);
    assert.equal(visits.size, fixture.cache.size);
    visits.clear();
    // The memo must not leak into the next revision/request.
    assert.strictEqual(await load(fixture.root, fixture.cache), original);
    assert.equal(visits.size, fixture.cache.size);
  });
}

test("a leaf edit rebinds both parents without reparsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-diamond-edit-"));
  const cache = new Map<string, Loaded>();
  try {
    const fixture = await writeDiamond(directory, 4);
    await load(fixture.root, cache);
    const before = new Map(cache);
    const leaf = join(directory, "leaf.blot");
    await writeFile(leaf, "return 2\n");
    await refreshLoadedModules(cache);
    await load(fixture.root, cache);
    assert.equal(cache.get(leaf)?.source, "return 2\n");
    for (const [path, loaded] of cache) {
      if (path === leaf) continue;
      assert.strictEqual(loaded.module, before.get(path)?.module);
      for (const dependency of loaded.dependencies.values()) {
        assert.strictEqual(dependency, cache.get(dependency.path));
      }
    }
    // A cycle introduced after a successful walk is still a source error.
    await writeFile(leaf, 'return import "./root.blot"\n');
    await refreshLoadedModules(cache);
    await assert.rejects(() => load(fixture.root, cache), (error: unknown) => {
      assert.ok(error instanceof BlotError);
      assert.equal(error.diagnostic.code, "BLOT_IMPORT_CYCLE");
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("512-file refresh fits a 64-descriptor process", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-descriptor-gate-"));
  try {
    const script = join(directory, "refresh.mjs");
    const loader = new URL("./load.ts", import.meta.url).href;
    await writeFile(script, `
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { refreshLoadedModules } from ${JSON.stringify(loader)};
const cache = new Map();
for (let index = 0; index < 512; index += 1) {
  const path = join(${JSON.stringify(directory)}, index + ".blot");
  await writeFile(path, "return 1\\n");
  cache.set(path, {
    path, source: "return 1\\n", storage: { tag: "source" },
    dependencies: new Map(), includedFiles: new Map(),
    get module() { throw new Error("refresh must not parse"); },
  });
}
await refreshLoadedModules(cache);
assert.equal(cache.size, 512);
await writeFile(join(${JSON.stringify(directory)}, "0.blot"), "return 2\\n");
await unlink(join(${JSON.stringify(directory)}, "511.blot"));
await refreshLoadedModules(cache);
assert.equal(cache.size, 510);
console.log("512 refreshed; changed and missing inputs invalidated");
`);
    const child = spawnSync("/bin/sh", [
      "-c",
      'ulimit -n 64 && exec "$@"',
      "blot-descriptor-gate",
      process.execPath,
      "--import",
      "tsx",
      script,
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /512 refreshed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a refresh read error does not publish partial invalidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-refresh-error-"));
  const cache = new Map<string, Loaded>();
  try {
    const root = join(directory, "root.blot");
    const dependency = join(directory, "dependency.blot");
    await writeFile(dependency, "return 1\n");
    await writeFile(root, 'return import "./dependency.blot"\n');
    await load(root, cache);
    const before = new Map(cache);
    await writeFile(
      root,
      'const value = import "./dependency.blot"\nreturn value\n',
    );
    await rm(dependency);
    await mkdir(dependency);
    await assert.rejects(() => refreshLoadedModules(cache), {
      message: /could not refresh cached Blot source/,
    });
    assert.equal(cache.size, before.size);
    for (const [path, loaded] of before) {
      assert.strictEqual(cache.get(path), loaded);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
