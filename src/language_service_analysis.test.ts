// Shared-analysis integration tests: one computation per revision, overlay
// transactions, and dependency-aware invalidation, driven through a fake
// compiler that counts analyses and controls ordering deterministically.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import type { CompilerAnalysis, CompilerSyntaxSnapshot } from "./compiler.ts";
import { BlotError } from "./diagnostic.ts";
import {
  LanguageService,
  type SemanticCompiler,
  type ValidationCompiler,
} from "./language_service.ts";
import { LoadError } from "./load.ts";
import { snapshotSource } from "./syntax/snapshot.ts";
import type { StagedOverlay } from "./workspace_graph.ts";

type AnalyzeBehavior = (
  path: string,
  source: string,
) => CompilerAnalysis | Promise<CompilerAnalysis>;

function cannedAnalysis(
  source: string,
  overrides: Partial<CompilerAnalysis> = {},
): CompilerAnalysis {
  return {
    type: `Fake ${source.length}`,
    effects: "",
    interfaceKey: `fake:${source.length}`,
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
    ...overrides,
  };
}

class FakeCompiler implements SemanticCompiler {
  analyzeCalls: Array<{ readonly path: string; readonly source: string }> = [];
  syntaxCalls = 0;
  staged: Array<ReadonlyMap<string, StagedOverlay>> = [];
  closures = new Map<string, readonly string[]>();
  diskRefreshes = 0;
  gate: Promise<void> = Promise.resolve();
  behavior: AnalyzeBehavior = (_path, source) => cannedAnalysis(source);

  async analyzeSource(path: string, source: string): Promise<CompilerAnalysis> {
    this.analyzeCalls.push({ path, source });
    await this.gate;
    return await this.behavior(path, source);
  }

  async syntaxSnapshot(
    _path: string,
    source: string,
  ): Promise<CompilerSyntaxSnapshot> {
    this.syntaxCalls += 1;
    const snapshot = await snapshotSource(source);
    if (!snapshot.ok) {
      const diagnostic = snapshot.diagnostics[0];
      if (diagnostic === undefined) throw new Error("snapshot failed silently");
      throw new BlotError(diagnostic, null);
    }
    return {
      module: snapshot.snapshot.module,
      cst: snapshot.snapshot.cst,
      reuse: [],
      parserExecuted: true,
      portableAstDigest: "fake",
    };
  }

  stageOverlays(
    entries: ReadonlyMap<string, StagedOverlay>,
  ): Promise<void> {
    this.staged.push(new Map(entries));
    return Promise.resolve();
  }

  workspaceClosure(path: string): Promise<readonly string[]> {
    const closure = this.closures.get(path);
    if (closure !== undefined) return Promise.resolve(closure);
    return Promise.resolve([path]);
  }

  refreshDiskInputs(): Promise<void> {
    this.diskRefreshes += 1;
    return Promise.resolve();
  }

  releaseRoot(_path: string): Promise<void> {
    return Promise.resolve();
  }

  clearOverlay(_path: string): Promise<void> {
    return Promise.resolve();
  }

  destroy(): void {}
}

class FakeValidationCompiler implements ValidationCompiler {
  checks = 0;
  staged: Array<ReadonlyMap<string, StagedOverlay>> = [];
  cleared: string[] = [];

  analyzeSource(
    _path: string,
    source: string,
  ): Promise<CompilerAnalysis> {
    return Promise.resolve(cannedAnalysis(source));
  }

  async syntaxSnapshot(
    _path: string,
    source: string,
  ): Promise<CompilerSyntaxSnapshot> {
    const snapshot = await snapshotSource(source);
    if (!snapshot.ok) {
      const diagnostic = snapshot.diagnostics[0];
      if (diagnostic === undefined) throw new Error("snapshot failed silently");
      throw new BlotError(diagnostic, null);
    }
    return {
      module: snapshot.snapshot.module,
      cst: snapshot.snapshot.cst,
      reuse: [],
      parserExecuted: true,
      portableAstDigest: "fake",
    };
  }

  checkSource(_path: string, _source: string) {
    this.checks += 1;
    return Promise.resolve({ type: "Int", effects: "", interfaceKey: "fake" });
  }

  stageOverlays(
    entries: ReadonlyMap<string, StagedOverlay>,
  ): Promise<void> {
    this.staged.push(new Map(entries));
    return Promise.resolve();
  }

  clearOverlay(path: string): Promise<void> {
    this.cleared.push(path);
    return Promise.resolve();
  }

  destroy(): void {}
}

function assertWithinBounds(
  entry:
    | { readonly syntax: number; readonly semantic: number }
    | undefined,
): void {
  assert(entry !== undefined);
  assert(entry.syntax <= 16, `syntax cache holds ${entry.syntax} entries`);
  assert(
    entry.semantic <= 16,
    `semantic cache holds ${entry.semantic} entries`,
  );
}

function testService(compiler: FakeCompiler): {
  service: LanguageService;
  validation: FakeValidationCompiler;
} {
  const validation = new FakeValidationCompiler();
  const service = new LanguageService({
    createCompiler: () => Promise.resolve(compiler),
    createValidationCompiler: () => Promise.resolve(validation),
  });
  return { service, validation };
}

Deno.test("diagnostics and hover share one analysis job for one revision", async () => {
  const compiler = new FakeCompiler();
  const { service, validation } = testService(compiler);
  const uri = "untitled:shared-analysis.blot";
  const source = "return 1\n";
  try {
    service.open(uri, source, 1);
    const [diagnostics, hover] = await Promise.all([
      service.diagnostics(uri),
      service.hover(uri, { line: 0, character: 1 }),
    ]);
    assertEquals(diagnostics, []);
    assert(hover === null || typeof hover.contents.value === "string");
    assertEquals(compiler.analyzeCalls.length, 1);
    assertEquals(compiler.syntaxCalls, 1);
    assertEquals(validation.checks, 0);
    assertEquals(await service.diagnostics(uri), []);
    assertEquals(compiler.analyzeCalls.length, 1);
    assertEquals(compiler.syntaxCalls, 1);
  } finally {
    await service.destroy();
  }
});

Deno.test("completion, hints, and symbols reuse the shared revision analysis", async () => {
  const compiler = new FakeCompiler();
  const { service } = testService(compiler);
  const uri = "untitled:shared-details.blot";
  try {
    service.open(uri, "return 1\n", 1);
    const [completion, hints, symbols, signature] = await Promise.all([
      service.completion(uri, { line: 0, character: 1 }),
      service.inlayHints(uri),
      service.documentSymbols(uri),
      service.signatureHelp(uri, { line: 0, character: 1 }),
    ]);
    assert(completion.some((item) => item.label === "return"));
    assertEquals(hints, []);
    assertEquals(symbols, []);
    assertEquals(signature, null);
    assertEquals(compiler.analyzeCalls.length, 1);
    assertEquals(compiler.syntaxCalls, 1);
  } finally {
    await service.destroy();
  }
});

Deno.test("changing unsaved provider B invalidates importer A without editing A", async () => {
  const compiler = new FakeCompiler();
  const { service } = testService(compiler);
  const directory = await Deno.makeTempDir();
  const providerPath = join(directory, "provider.blot");
  const importerPath = join(directory, "importer.blot");
  const unrelatedPath = join(directory, "unrelated.blot");
  const providerUri = toFileUrl(providerPath).href;
  const importerUri = toFileUrl(importerPath).href;
  const unrelatedUri = toFileUrl(unrelatedPath).href;
  compiler.closures.set(importerPath, [importerPath, providerPath]);
  try {
    service.open(
      importerUri,
      `const provider = import "./provider.blot"\nreturn provider\n`,
      1,
    );
    service.open(providerUri, "return 1\n", 1);
    assertEquals(await service.diagnostics(importerUri), []);
    assertEquals(compiler.analyzeCalls.length, 1);
    const firstStages = compiler.staged.flatMap((staged) => [...staged.keys()]);
    assert(firstStages.includes(providerPath));
    assert(firstStages.includes(importerPath));

    service.change(providerUri, "return 2\n", 2);
    assertEquals(await service.diagnostics(importerUri), []);
    assertEquals(compiler.analyzeCalls.length, 2);
    const restaged = compiler.staged[compiler.staged.length - 1];
    assertEquals(restaged?.get(providerPath)?.source, "return 2\n");

    service.open(unrelatedUri, "return 9\n", 1);
    assertEquals(await service.diagnostics(importerUri), []);
    assertEquals(compiler.analyzeCalls.length, 2);
    service.change(unrelatedUri, "return 10\n", 2);
    assertEquals(await service.diagnostics(importerUri), []);
    assertEquals(compiler.analyzeCalls.length, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("every relevant overlay is staged before its analysis runs", async () => {
  const compiler = new FakeCompiler();
  const events: string[] = [];
  const { service } = testService(compiler);
  const directory = await Deno.makeTempDir();
  const providerPath = join(directory, "provider.blot");
  const importerPath = join(directory, "importer.blot");
  const providerUri = toFileUrl(providerPath).href;
  const importerUri = toFileUrl(importerPath).href;
  compiler.closures.set(importerPath, [importerPath, providerPath]);
  const stagedSources = new Map<string, string>();
  const originalStage = compiler.stageOverlays.bind(compiler);
  compiler.stageOverlays = async (entries) => {
    for (const [path, overlay] of entries) {
      stagedSources.set(path, overlay.source);
      events.push(`stage ${path}`);
    }
    await originalStage(entries);
  };
  const originalBehavior = compiler.behavior;
  compiler.behavior = (path, source) => {
    events.push(`analyze ${path}`);
    for (const [stagedPath, stagedSource] of stagedSources) {
      if (stagedPath === path) continue;
      assert(
        stagedSource.length > 0,
        `analysis of ${path} ran before ${stagedPath} was staged`,
      );
    }
    return originalBehavior(path, source);
  };
  try {
    service.open(providerUri, "return 1\n", 1);
    service.open(
      importerUri,
      `const provider = import "./provider.blot"\nreturn provider\n`,
      1,
    );
    assertEquals(await service.diagnostics(importerUri), []);
    const firstAnalyze = events.findIndex((event) =>
      event.startsWith("analyze ")
    );
    assert(firstAnalyze > 0);
    const stagedBefore = events.slice(0, firstAnalyze);
    assert(stagedBefore.includes(`stage ${providerPath}`));
    assert(stagedBefore.includes(`stage ${importerPath}`));
  } finally {
    await service.destroy();
  }
});

Deno.test("a stale completion cannot displace a newer cached analysis", async () => {
  const compiler = new FakeCompiler();
  let release!: () => void;
  compiler.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  compiler.behavior = (_path, source) => {
    calls += 1;
    const call = calls;
    return cannedAnalysis(source, {
      targetPreflight: {
        supported: false,
        code: "BLOT_TARGET_REFUSAL",
        export: null,
        inferredType: "Int",
        unsupportedComponent: `refusal-${call}`,
        alternatives: [],
      },
    });
  };
  const { service } = testService(compiler);
  const directory = await Deno.makeTempDir();
  const providerPath = join(directory, "provider.blot");
  const importerPath = join(directory, "importer.blot");
  const providerUri = toFileUrl(providerPath).href;
  const importerUri = toFileUrl(importerPath).href;
  compiler.closures.set(importerPath, [importerPath, providerPath]);
  try {
    service.open(
      importerUri,
      `const provider = import "./provider.blot"\nreturn provider\n`,
      1,
    );
    service.open(providerUri, "return 1\n", 1);
    const stale = service.diagnostics(importerUri);
    for (
      let spin = 0;
      spin < 1000 && compiler.analyzeCalls.length === 0;
      spin += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(compiler.analyzeCalls.length, 1);
    service.change(providerUri, "return 2\n", 2);
    release();
    const staleDiagnostics = await stale;
    assert(
      staleDiagnostics.some((diagnostic) =>
        diagnostic.message.includes("refusal-1")
      ),
    );
    compiler.gate = Promise.resolve();
    const fresh = await service.diagnostics(importerUri);
    assertEquals(compiler.analyzeCalls.length, 2);
    assert(
      fresh.some((diagnostic) => diagnostic.message.includes("refusal-2")),
    );
    assertEquals(await service.diagnostics(importerUri), fresh);
    assertEquals(compiler.analyzeCalls.length, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("structured source failures cache until a dependency moves", async () => {
  const compiler = new FakeCompiler();
  compiler.behavior = () => {
    throw new BlotError(
      {
        code: "BLOT_UNBOUND",
        message: "missing is unbound",
        span: { start: 0, end: 1 },
      },
      null,
    );
  };
  const { service } = testService(compiler);
  const directory = await Deno.makeTempDir();
  const providerPath = join(directory, "provider.blot");
  const importerPath = join(directory, "importer.blot");
  const unrelatedPath = join(directory, "unrelated.blot");
  const providerUri = toFileUrl(providerPath).href;
  const importerUri = toFileUrl(importerPath).href;
  const unrelatedUri = toFileUrl(unrelatedPath).href;
  compiler.closures.set(importerPath, [importerPath, providerPath]);
  try {
    service.open(importerUri, "return missing\n", 1);
    service.open(providerUri, "return 1\n", 1);
    const first = await service.diagnostics(importerUri);
    assertEquals(first.map((diagnostic) => diagnostic.code), ["BLOT_UNBOUND"]);
    assertEquals(await service.diagnostics(importerUri), first);
    assertEquals(compiler.analyzeCalls.length, 1);
    service.open(unrelatedUri, "return 9\n", 1);
    assertEquals(await service.diagnostics(importerUri), first);
    assertEquals(compiler.analyzeCalls.length, 1);
    service.change(providerUri, "return 2\n", 2);
    assertEquals(await service.diagnostics(importerUri), first);
    assertEquals(compiler.analyzeCalls.length, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("analysis cache falls back safely past the epoch-log boundary", async () => {
  const compiler = new FakeCompiler();
  const { service } = testService(compiler);
  const directory = await Deno.makeTempDir();
  const mainPath = join(directory, "main.blot");
  const mainUri = toFileUrl(mainPath).href;
  try {
    service.open(mainUri, "return 1\n", 1);
    assertEquals(await service.diagnostics(mainUri), []);
    assertEquals(compiler.analyzeCalls.length, 1);
    for (let index = 0; index < 511; index += 1) {
      service.markChanged(join(directory, `unrelated-${index}.blot`));
    }
    assertEquals(await service.diagnostics(mainUri), []);
    assertEquals(compiler.analyzeCalls.length, 1);
    service.markChanged(join(directory, "unrelated-final.blot"));
    assertEquals(await service.diagnostics(mainUri), []);
    assertEquals(compiler.analyzeCalls.length, 2);
    assertEquals(await service.diagnostics(mainUri), []);
    assertEquals(compiler.analyzeCalls.length, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("analysis cache invalidates unknown closures on any change", async () => {
  const compiler = new FakeCompiler();
  compiler.behavior = (path, source) => {
    throw new LoadError(path, source, [{
      code: "BLOT_UNBOUND",
      message: "missing is unbound",
      span: { start: 0, end: 1 },
    }]);
  };
  const { service } = testService(compiler);
  const directory = await Deno.makeTempDir();
  const mainPath = join(directory, "main.blot");
  const mainUri = toFileUrl(mainPath).href;
  try {
    service.open(mainUri, "return missing\n", 1);
    const first = await service.diagnostics(mainUri);
    assertEquals(
      first.map((diagnostic) => diagnostic.code),
      ["BLOT_UNBOUND"],
    );
    assertEquals(compiler.analyzeCalls.length, 1);
    assertEquals(await service.diagnostics(mainUri), first);
    assertEquals(compiler.analyzeCalls.length, 1);
    service.markChanged(join(directory, "unrelated.blot"));
    assertEquals(await service.diagnostics(mainUri), first);
    assertEquals(compiler.analyzeCalls.length, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("infrastructure failures settle every subscriber and never cache", async () => {
  const compiler = new FakeCompiler();
  compiler.behavior = () => {
    throw new Error("worker exploded");
  };
  const { service } = testService(compiler);
  const uri = "untitled:infra-failure.blot";
  try {
    service.open(uri, "return 1\n", 1);
    const [diagnostics, hover] = await Promise.allSettled([
      service.diagnostics(uri),
      service.hover(uri, { line: 0, character: 1 }),
    ]);
    assertEquals(diagnostics.status, "rejected");
    assertEquals(hover.status, "rejected");
    assertEquals(compiler.analyzeCalls.length, 1);
    const retry = await Promise.allSettled([service.diagnostics(uri)]);
    assertEquals(retry[0]?.status, "rejected");
    assertEquals(compiler.analyzeCalls.length, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("many edits keep per-document caches within their configured bound", async () => {
  const compiler = new FakeCompiler();
  const { service } = testService(compiler);
  const uri = "untitled:bounded-caches.blot";
  try {
    service.open(uri, "return 0\n", 1);
    for (let version = 2; version <= 40; version += 1) {
      service.change(uri, `return ${version}\n`, version);
      assertEquals(await service.diagnostics(uri), []);
    }
    const stats = service.debugCacheStats();
    assertEquals(stats.documents, 1);
    assertEquals(stats.entries.length, 1);
    assertWithinBounds(stats.entries[0]);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await service.close(uri);
      service.open(uri, "return 0\n", 1);
      assertEquals(await service.diagnostics(uri), []);
    }
    const reopened = service.debugCacheStats();
    assertEquals(reopened.documents, 1);
    assertWithinBounds(reopened.entries[0]);
  } finally {
    await service.destroy();
  }
});

Deno.test("unsaved provider edits invalidate the importer end to end", async () => {
  const directory = await Deno.makeTempDir();
  const providerPath = join(directory, "provider.blot");
  const importerPath = join(directory, "importer.blot");
  const providerUri = toFileUrl(providerPath).href;
  const importerUri = toFileUrl(importerPath).href;
  const importerSource =
    `const provider = import "./provider.blot"\nreturn provider\n`;
  await Deno.writeTextFile(providerPath, "return 1\n");
  await Deno.writeTextFile(importerPath, importerSource);
  const service = new LanguageService();
  try {
    service.open(importerUri, importerSource, 1);
    assertEquals(await service.diagnostics(importerUri), []);
    service.open(providerUri, "return missing\n", 1);
    const broken = await service.diagnostics(importerUri);
    assert(
      broken.some((diagnostic) => diagnostic.code === "BLOT_UNBOUND"),
      `expected the unsaved provider breakage to reach the importer, got ${
        JSON.stringify(broken)
      }`,
    );
    service.change(providerUri, "return 2\n", 2);
    assertEquals(await service.diagnostics(importerUri), []);
  } finally {
    await service.destroy();
  }
});

Deno.test("lint validation reuses one compiler instead of minting per call", async () => {
  let created = 0;
  const service = new LanguageService({
    createValidationCompiler: async () => {
      created += 1;
      const { Compiler } = await import("./compiler.ts");
      return await Compiler.create();
    },
  });
  const uri = "untitled:conjoined-equality-reuse.blot";
  const source = `open import "blot:prelude"
const Host = @effect.host {
  .x = Unit -> Int;
  .y = Unit -> Int;
}
use x <- Host.x ()
use y <- Host.y ()
return case x == 0 && y == 0 of
  #True => "origin"
  #False => "elsewhere"
`;
  try {
    service.open(uri, source, 1);
    const range = {
      start: { line: 7, character: 0 },
      end: { line: 9, character: 24 },
    };
    const first = await service.codeActions(uri, range);
    assert(first.length > 0);
    const second = await service.codeActions(uri, range);
    assertEquals(second.length, first.length);
    assertEquals(created, 1);
  } finally {
    await service.destroy();
  }
});
