import { assert, assertEquals } from "@std/assert";
import {
  captureOverlayManifest,
  DependencyCache,
  diffOverlayManifest,
  failedAnalysis,
  overlayManifestDigest,
  successfulAnalysis,
} from "./analysis.ts";

Deno.test("overlay manifests freeze path-sorted entries with content ids", () => {
  const manifest = captureOverlayManifest(
    [
      {
        uri: "file:///b.blot",
        path: "/b.blot",
        version: 2,
        source: "return 2\n",
      },
      {
        uri: "file:///a.blot",
        path: "/a.blot",
        version: 1,
        source: "return 1\n",
      },
    ],
    7,
  );
  assertEquals(manifest.epoch, 7);
  assertEquals(
    manifest.entries.map((entry) => entry.path),
    ["/a.blot", "/b.blot"],
  );
  assert(Object.isFrozen(manifest));
  assert(Object.isFrozen(manifest.entries));
  assert(Object.isFrozen(manifest.entries[0]));
  assertEquals(manifest.entries[0]?.contentId, manifest.entries[0]?.contentId);
  assert(manifest.entries[0]?.contentId !== manifest.entries[1]?.contentId);
});

Deno.test("overlay manifest digests name the synchronized workspace", () => {
  const snapshots = [
    {
      uri: "file:///a.blot",
      path: "/a.blot",
      version: 1,
      source: "return 1\n",
    },
  ];
  const first = captureOverlayManifest(snapshots, 1);
  const same = captureOverlayManifest(snapshots, 2);
  const edited = captureOverlayManifest(
    [
      {
        uri: "file:///a.blot",
        path: "/a.blot",
        version: 2,
        source: "return 2\n",
      },
    ],
    2,
  );
  assertEquals(overlayManifestDigest(first), overlayManifestDigest(same));
  assert(overlayManifestDigest(first) !== overlayManifestDigest(edited));
});

Deno.test("manifest diffs stage only new or changed overlays", () => {
  const previous = captureOverlayManifest(
    [
      {
        uri: "file:///a.blot",
        path: "/a.blot",
        version: 1,
        source: "return 1\n",
      },
      {
        uri: "file:///b.blot",
        path: "/b.blot",
        version: 1,
        source: "return 1\n",
      },
    ],
    1,
  );
  assertEquals(diffOverlayManifest(null, previous).length, 2);
  assertEquals(diffOverlayManifest(previous, previous), []);
  const edited = captureOverlayManifest(
    [
      {
        uri: "file:///a.blot",
        path: "/a.blot",
        version: 1,
        source: "return 1\n",
      },
      {
        uri: "file:///b.blot",
        path: "/b.blot",
        version: 2,
        source: "return 2\n",
      },
      {
        uri: "file:///c.blot",
        path: "/c.blot",
        version: 1,
        source: "return 3\n",
      },
    ],
    2,
  );
  assertEquals(
    diffOverlayManifest(previous, edited).map((entry) => entry.path),
    ["/b.blot", "/c.blot"],
  );
  const closed = captureOverlayManifest(
    [
      {
        uri: "file:///a.blot",
        path: "/a.blot",
        version: 1,
        source: "return 1\n",
      },
    ],
    3,
  );
  assertEquals(diffOverlayManifest(previous, closed), []);
});

Deno.test("analysis results carry either facts or a source failure", () => {
  const identity = {
    uri: "file:///a.blot",
    lifecycle: 1,
    revision: 4,
    workspaceEpoch: 9,
    manifestDigest: "digest",
  };
  const analysis = {
    type: "Int",
    effects: "",
    interfaceKey: "key",
    types: [],
    tags: [],
    ownership: [],
    specializations: [],
    simplifications: [],
    readability: [],
    refinements: [],
    work: null,
    invalidation: {
      dirtyModules: [],
      invalidationReasons: {},
      checkedModules: [],
      boundaryChanged: [],
      boundaryUnchanged: [],
      invalidatedImporters: [],
      reusedArtifacts: [],
    },
    targetPreflight: {
      supported: true,
      code: null,
      export: null,
      inferredType: "Int",
      unsupportedComponent: null,
      alternatives: [],
    },
  };
  const ok = successfulAnalysis(
    identity,
    analysis,
    ["/a.blot", "/b.blot"],
    { syncMs: 1, analysisMs: 2 },
  );
  assert(ok.analysis !== null);
  assertEquals(ok.failure, null);
  assertEquals(ok.dependencies, ["/a.blot", "/b.blot"]);
  assertEquals(ok.work, { syncMs: 1, analysisMs: 2 });
  const failed = failedAnalysis(
    identity,
    {
      diagnostics: [{
        code: "BLOT_UNBOUND",
        message: "nope",
        span: { start: 0, end: 1 },
      }],
    },
    null,
    { syncMs: 0, analysisMs: 3 },
  );
  assertEquals(failed.analysis, null);
  assertEquals(failed.failure?.diagnostics.length, 1);
  assertEquals(failed.dependencies, null);
});

Deno.test("dependency caches share in-flight work across revisions", async () => {
  const cache = new DependencyCache<string>(4);
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  cache.set("key", "source", 1, 1, "/a.blot", pending);
  const shared = cache.get("key", "source", () => new Set(["/b.blot"]));
  assertEquals(shared, pending);
  release("done");
  assertEquals(await shared, "done");
});

Deno.test("dependency caches verify source equality on lookup", () => {
  const cache = new DependencyCache<string>(4);
  cache.set("key", "source", 1, 1, "/a.blot", Promise.resolve("done"));
  cache.noteSettled("key", 1, {
    revision: 1,
    dependencies: ["/a.blot"],
    outcome: "ok",
  });
  assertEquals(cache.get("key", "other", () => new Set()), undefined);
});

Deno.test("dependency caches refuse older revisions over newer slots", async () => {
  const cache = new DependencyCache<string>(4);
  cache.set("key", "source", 2, 2, "/a.blot", Promise.resolve("newer"));
  cache.set("key", "source", 1, 1, "/a.blot", Promise.resolve("older"));
  const read = cache.get("key", "source", () => new Set());
  assertEquals(await read, "newer");
});

Deno.test("dependency caches evict the least recently used entry", () => {
  const cache = new DependencyCache<string>(2);
  cache.set("old", "old", 1, 1, "/old.blot", Promise.resolve("old"));
  cache.set("mid", "mid", 1, 1, "/mid.blot", Promise.resolve("mid"));
  assertEquals(cache.get("old", "old", () => new Set()) !== undefined, true);
  cache.set("new", "new", 1, 1, "/new.blot", Promise.resolve("new"));
  assertEquals(cache.size, 2);
  assertEquals(cache.get("old", "old", () => new Set()) !== undefined, true);
  assertEquals(cache.get("mid", "mid", () => new Set()), undefined);
});

Deno.test("settled entries survive unrelated changes but not dependency moves", async () => {
  const cache = new DependencyCache<string>(4);
  cache.set("key", "source", 3, 3, "/a.blot", Promise.resolve("done"));
  cache.noteSettled("key", 3, {
    revision: 3,
    dependencies: ["/a.blot", "/b.blot"],
    outcome: "ok",
  });
  const quiet = cache.get("key", "source", () => new Set());
  assertEquals(await quiet, "done");
  const unrelated = cache.get("key", "source", () => new Set(["/c.blot"]));
  assertEquals(await unrelated, "done");
  const rootOnly = cache.get("key", "source", () => new Set(["/a.blot"]));
  assertEquals(await rootOnly, "done");
  assertEquals(
    cache.get("key", "source", () => new Set(["/b.blot"])),
    undefined,
  );
  assertEquals(cache.get("key", "source", () => null), undefined);
});

Deno.test("unknown closures fall back to coarse invalidation", async () => {
  const cache = new DependencyCache<string>(4);
  cache.set("key", "source", 3, 3, "/a.blot", Promise.resolve("done"));
  cache.noteSettled("key", 3, {
    revision: 3,
    dependencies: null,
    outcome: "ok",
  });
  const quiet = cache.get("key", "source", () => new Set());
  assertEquals(await quiet, "done");
  assertEquals(
    cache.get("key", "source", () => new Set(["/c.blot"])),
    undefined,
  );
});

Deno.test("source failures serve while quiet and redispatch on change", async () => {
  const cache = new DependencyCache<string>(4);
  const failure = Promise.reject(new Error("missing import"));
  failure.catch(() => {});
  cache.set("key", "source", 3, 3, "/a.blot", failure);
  cache.noteSettled("key", 3, {
    revision: 3,
    dependencies: ["/a.blot", "/b.blot"],
    outcome: "source-failure",
  });
  const quiet = cache.get("key", "source", () => new Set());
  let settled = false;
  try {
    await quiet;
  } catch (error) {
    settled = error instanceof Error && error.message === "missing import";
  }
  assert(settled);
  assertEquals(
    cache.get("key", "source", () => new Set(["/b.blot"])),
    undefined,
  );
});

Deno.test("infrastructure failures are never served from the cache", () => {
  const cache = new DependencyCache<string>(4);
  const failure = Promise.reject(new Error("boom"));
  failure.catch(() => {});
  cache.set("key", "source", 3, 3, "/a.blot", failure);
  cache.noteSettled("key", 3, {
    revision: 3,
    dependencies: ["/a.blot"],
    outcome: "infrastructure-failure",
  });
  assertEquals(cache.get("key", "source", () => new Set()), undefined);
});

Deno.test("settlement metadata and deletes honor the revision guard", () => {
  const cache = new DependencyCache<string>(4);
  cache.set("key", "source", 2, 2, "/a.blot", Promise.resolve("newer"));
  cache.noteSettled("key", 1, {
    revision: 1,
    dependencies: null,
    outcome: "infrastructure-failure",
  });
  assertEquals(cache.delete("key", 1), false);
  assertEquals(cache.get("key", "source", () => new Set()) !== undefined, true);
  assertEquals(cache.delete("key", 2), true);
  assertEquals(cache.get("key", "source", () => new Set()), undefined);
});
