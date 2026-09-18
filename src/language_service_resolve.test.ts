// Deferred code-action tests: staged detection without speculative
// compilation, selected-edit validation in the scratch session, lifecycle
// staleness, live-session isolation, resolve storms, and snapshot-at-entry
// providers, driven through recording compilers with deterministic gates.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import type {
  CheckedModule,
  CompilerAnalysis,
  CompilerSyntaxSnapshot,
} from "./compiler.ts";
import { BlotError } from "./diagnostic.ts";
import {
  LanguageService,
  offsetAtPosition,
  type SemanticCompiler,
  type ValidationCompiler,
} from "./language_service.ts";
import { Barrier, Deferred, settleMicrotasks } from "./lsp/testing.ts";
import { snapshotSource } from "./syntax/snapshot.ts";
import type { StagedOverlay } from "./workspace_graph.ts";

function cannedAnalysis(source: string): CompilerAnalysis {
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
  };
}

interface RecordedCall {
  readonly path: string;
  readonly source: string;
}

/**
 * A compiler that records every call, parses syntax for real, and answers
 * analyses from canned facts. One instance serves the live semantic slot
 * while another serves the scratch slot, so tests observe exactly which
 * session each job ran on.
 */
class RecordingCompiler implements SemanticCompiler, ValidationCompiler {
  analyzeCalls: RecordedCall[] = [];
  syntaxCalls: RecordedCall[] = [];
  checks: RecordedCall[] = [];
  staged: Array<ReadonlyMap<string, StagedOverlay>> = [];
  cleared: string[] = [];
  keyBehavior: (source: string) => string = (source) => `key:${source}`;
  gateSyntaxFor: string | null = null;
  gateChecks = false;
  syntaxGate = new Barrier();
  checkGate = new Barrier();
  syntaxReached = new Deferred<void>();
  checkReached = new Deferred<void>();
  #syntaxReleased = false;

  analyzeSource(
    path: string,
    source: string,
  ): Promise<CompilerAnalysis> {
    this.analyzeCalls.push({ path, source });
    return Promise.resolve(cannedAnalysis(source));
  }

  async syntaxSnapshot(
    path: string,
    source: string,
  ): Promise<CompilerSyntaxSnapshot> {
    this.syntaxCalls.push({ path, source });
    if (this.gateSyntaxFor === path && !this.#syntaxReleased) {
      this.syntaxReached.resolve();
      await this.syntaxGate.wait();
    }
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

  releaseSyntax(): void {
    this.#syntaxReleased = true;
    this.syntaxGate.releaseAll();
  }

  async checkSource(path: string, source: string): Promise<CheckedModule> {
    this.checks.push({ path, source });
    this.checkReached.resolve();
    if (this.gateChecks) await this.checkGate.wait();
    return {
      type: "Int",
      effects: "",
      interfaceKey: this.keyBehavior(source),
    };
  }

  stageOverlays(
    entries: ReadonlyMap<string, StagedOverlay>,
  ): Promise<void> {
    this.staged.push(new Map(entries));
    return Promise.resolve();
  }

  workspaceClosure(path: string): Promise<readonly string[]> {
    return Promise.resolve([path]);
  }

  refreshDiskInputs(): Promise<void> {
    return Promise.resolve();
  }

  releaseRoot(_path: string): Promise<void> {
    return Promise.resolve();
  }

  clearOverlay(path: string): Promise<void> {
    this.cleared.push(path);
    return Promise.resolve();
  }

  destroy(): void {}
}

Deno.test("diagnostics publish ordinary suggestions without speculative compilation", async () => {
  const live = new RecordingCompiler();
  const scratch = new RecordingCompiler();
  const service = new LanguageService({
    createCompiler: () => Promise.resolve(live),
    createValidationCompiler: () => Promise.resolve(scratch),
  });
  const ordinaryUri = "untitled:ordinary-suggestions.blot";
  const ordinarySource = "let a = 1\nlet b = 2\nlet c = 3\nreturn 4\n";
  try {
    service.open(ordinaryUri, ordinarySource, 1);
    const diagnostics = await service.diagnostics(ordinaryUri);
    assertEquals(
      diagnostics.filter((diagnostic) =>
        diagnostic.code === "BLOT_LINT_UNUSED_BINDING"
      ).length,
      3,
    );
    assertEquals(
      scratch.checks,
      [],
      "detection of ordinary suggestions must perform zero fix validations",
    );
    const directory = await Deno.makeTempDir();
    try {
      const path = join(directory, "widening-rebinding.blot");
      const source = "let value = 1\nvalue := value\nreturn value\n";
      await Deno.writeTextFile(path, source);
      const uri = toFileUrl(path).href;
      service.open(uri, source, 1);
      const widening = await service.diagnostics(uri);
      assert(
        !widening.some((diagnostic) =>
          diagnostic.code === "BLOT_LINT_NOOP_REBINDING"
        ),
        "an unproven rewrite claim must never publish",
      );
      assertEquals(
        scratch.checks.length,
        2,
        "the rewrite-validation stage checks the original and candidate pair",
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  } finally {
    await service.destroy();
  }
});

Deno.test("a selected single fix resolves only after its own validation", async () => {
  const service = new LanguageService();
  const uri = "untitled:selected-single-fix.blot";
  const source = "let forgotten = 1\nreturn 2\n";
  try {
    service.open(uri, source, 1);
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 8 },
    };
    const actions = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const deferred = actions.find((action) =>
      action.title === "Remove unused binding"
    );
    assert(deferred, "the selected fix must be described while deferred");
    assertEquals(deferred.edit.documentChanges[0].edits, []);
    const data = deferred.data;
    assert(data !== undefined);
    assertEquals(data.uri, uri);
    assertEquals(data.version, 1);
    assertEquals(data.rule, "BLOT_LINT_UNUSED_BINDING");
    assert(data.candidate !== undefined);
    assertEquals(data.candidate.title, "Remove unused binding");
    assertEquals(data.lifecycle, 1);
    assertEquals(data.revision, 1);
    assertEquals(data.workspaceEpoch, 2);
    const resolved = await service.resolveCodeAction(deferred);
    assertEquals(resolved.diagnostics.map((diagnostic) => diagnostic.code), [
      "BLOT_LINT_UNUSED_BINDING",
    ]);
    const edits = resolved.edit.documentChanges[0].edits;
    assertEquals(edits.length, 1);
    const edit = edits[0];
    const start = offsetAtPosition(source, edit.range.start);
    const end = offsetAtPosition(source, edit.range.end);
    assertEquals(
      source.slice(0, start) + edit.newText + source.slice(end),
      "return 2\n",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("a check-interface fix resolves to its proven rewrite", async () => {
  const service = new LanguageService();
  const uri = "untitled:selected-checked-fix.blot";
  const source = `open import "blot:prelude"
let increment: Int -> Int
let increment = fn value => do:
  // Increment at the boundary.
  return value + 1 // The returned value stays documented.
return increment
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 6, character: 17 },
    }, { resolveEdits: true });
    const deferred = actions.find((action) =>
      action.title === "Remove redundant `do:` block"
    );
    assert(deferred, "the checked fix must be described while deferred");
    assertEquals(deferred.edit.documentChanges[0].edits, []);
    assertEquals(deferred.diagnostics.length, 1);
    assert(deferred.data !== undefined);
    assert(deferred.data.candidate !== undefined);
    const resolved = await service.resolveCodeAction(deferred);
    assertEquals(
      resolved.edit.documentChanges[0].edits[0]?.newText,
      `(\n  // Increment at the boundary.\n  value + 1\n  // The returned value stays documented.\n)\n`,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("fix-all validates its combined candidate as one unit", async () => {
  const live = new RecordingCompiler();
  const scratch = new RecordingCompiler();
  const service = new LanguageService({
    createCompiler: () => Promise.resolve(live),
    createValidationCompiler: () => Promise.resolve(scratch),
  });
  const uri = "untitled:combined-fix-all.blot";
  const source =
    "let count = 2\nlet total = 3\nlet other = 4\nreturn { .count = count; .total = total; .other = other; }\n";
  try {
    service.open(uri, source, 1);
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 4, character: 0 },
    };
    const actions = await service.codeActions(uri, range, {
      resolveEdits: true,
      only: ["source.fixAll.blot.BLOT_LINT_FIELD_SHORTHAND"],
    });
    const fixAll = actions.find((action) =>
      action.kind === "source.fixAll.blot.BLOT_LINT_FIELD_SHORTHAND"
    );
    assert(fixAll, "the scoped fix-all must be described while deferred");
    assertEquals(fixAll.edit.documentChanges[0].edits, []);
    const resolved = await service.resolveCodeAction(fixAll);
    const edits = resolved.edit.documentChanges[0].edits;
    assertEquals(edits.length, 1);
    assertEquals(
      edits[0].newText,
      "let count = 2\nlet total = 3\nlet other = 4\nreturn { .count; .total; .other; }\n",
    );
    assertEquals(
      scratch.checks.length,
      1,
      "three individually unchecked fixes share one combined validation",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("clients without resolve support receive validated edits only", async () => {
  const service = new LanguageService();
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "widening-rebinding.blot");
    const widening = "let value = 1\nvalue := value\nreturn value\n";
    await Deno.writeTextFile(path, widening);
    const wideningUri = toFileUrl(path).href;
    service.open(wideningUri, widening, 1);
    const refused = await service.codeActions(wideningUri, {
      start: { line: 0, character: 0 },
      end: { line: 3, character: 0 },
    });
    assert(
      !refused.some((action) => action.title === "Remove no-op rebinding"),
      "an unproven eager fix must be withheld, not returned unchecked",
    );
    const uri = "untitled:validated-eager-fix.blot";
    const source = "let forgotten = 1\nreturn 2\n";
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 8 },
    });
    const removal = actions.find((action) =>
      action.title === "Remove unused binding"
    );
    assert(removal, "a proven eager fix must carry its edits");
    const edits = removal.edit.documentChanges[0].edits;
    assertEquals(edits.length, 1);
    const edit = edits[0];
    const start = offsetAtPosition(source, edit.range.start);
    const end = offsetAtPosition(source, edit.range.end);
    assertEquals(
      source.slice(0, start) + edit.newText + source.slice(end),
      "return 2\n",
    );
  } finally {
    await service.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("stale resolve data returns no edits", async () => {
  const service = new LanguageService();
  const uri = "untitled:stale-resolve.blot";
  const source = "let forgotten = 1\nreturn 2\n";
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 8 },
  };
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const deferred = actions.find((action) =>
      action.title === "Remove unused binding"
    );
    assert(deferred);
    service.change(uri, `${source}\n`, 2);
    const moved = await service.resolveCodeAction(deferred);
    assertEquals(moved.edit.documentChanges[0].edits, []);
    assertEquals(moved.diagnostics, []);
    await service.close(uri);
    const closed = await service.resolveCodeAction(deferred);
    assertEquals(closed.edit.documentChanges[0].edits, []);
    service.open(uri, source, 1);
    const reopened = await service.resolveCodeAction(deferred);
    assertEquals(
      reopened.edit.documentChanges[0].edits,
      [],
      "a reused version on a new lifecycle stays stale",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("stale fix-all resolve asks for fresh actions", async () => {
  const service = new LanguageService();
  const uri = "untitled:stale-fix-all.blot";
  const source = "let forgotten = 1\nreturn 2\n";
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 8 },
  };
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const fixAll = actions.find((action) =>
      action.kind === "source.fixAll.blot"
    );
    assert(fixAll);
    service.change(uri, `${source}\n`, 2);
    await assertRejects(
      () => service.resolveCodeAction(fixAll),
      Error,
      "document changed",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("eager code actions stay within the validation budget", async () => {
  const service = new LanguageService();
  const uri = "untitled:eager-budget.blot";
  // Signatures suppress the (unbudgeted) signature-hole actions, leaving the
  // budgeted lint-fix set plus eagerly resolved fix-all actions.
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    lines.push(`let unused${index}: _`);
    lines.push(`let unused${index} = ${index}`);
  }
  lines.push("return unused39");
  const source = lines.join("\n") + "\n";
  const range = {
    start: { line: 0, character: 0 },
    end: { line: lines.length, character: 0 },
  };
  const lintSingles = (actions: readonly { kind: string; title: string }[]) =>
    actions.filter((action) =>
      action.kind === "quickfix" &&
      !action.title.startsWith("Add inferred signature hole") &&
      !action.title.startsWith("Match signature header")
    );
  try {
    service.open(uri, source, 1);
    const deferred = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const candidates = lintSingles(deferred);
    assert(
      candidates.length > 32,
      `want over-budget candidates, got ${candidates.length}`,
    );
    const first = lintSingles(await service.codeActions(uri, range));
    const second = lintSingles(await service.codeActions(uri, range));
    assert(
      first.length <= 32,
      `eager lint fixes exceeded budget: ${first.length}`,
    );
    assert(first.length > 0, "the budgeted set must not be empty");
    assertEquals(
      second.map((action) => action.title),
      first.map((action) => action.title),
      "the budgeted set must be deterministic",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("scratch validation leaves live diagnostics and session roots untouched", async () => {
  const live = new RecordingCompiler();
  const scratch = new RecordingCompiler();
  scratch.keyBehavior = () => "stable";
  const service = new LanguageService({
    createCompiler: () => Promise.resolve(live),
    createValidationCompiler: () => Promise.resolve(scratch),
  });
  const uri = "untitled:scratch-isolation.blot";
  const source = "let value = 1\nvalue := value\nreturn value\n";
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 3, character: 0 },
  };
  try {
    service.open(uri, source, 1);
    const before = await service.diagnostics(uri);
    assert(
      before.some((diagnostic) =>
        diagnostic.code === "BLOT_LINT_NOOP_REBINDING"
      ),
      "the scratch-proven rewrite must publish",
    );
    const liveAnalyze = live.analyzeCalls.length;
    const liveSyntax = live.syntaxCalls.length;
    const liveStaged = live.staged.length;
    const checks = scratch.checks.length;
    const actions = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const deferred = actions.find((action) =>
      action.title === "Remove no-op rebinding"
    );
    assert(deferred);
    const resolved = await service.resolveCodeAction(deferred);
    assertEquals(resolved.edit.documentChanges[0].edits.length, 1);
    assertEquals(live.analyzeCalls.length, liveAnalyze);
    assertEquals(live.syntaxCalls.length, liveSyntax);
    assertEquals(live.staged.length, liveStaged);
    assertEquals(scratch.checks.length, checks + 2);
    assertEquals(await service.diagnostics(uri), before);
    assertEquals(live.analyzeCalls.length, liveAnalyze);
    assertEquals(live.syntaxCalls.length, liveSyntax);
  } finally {
    await service.destroy();
  }
});

Deno.test("a typing burst plus resolve storm settles every request exactly once", async () => {
  const scratch = new RecordingCompiler();
  scratch.keyBehavior = () => "stable";
  const service = new LanguageService({
    createValidationCompiler: () => Promise.resolve(scratch),
  });
  const uri = "untitled:resolve-storm.blot";
  const source = "let value = 1\nvalue := value\nreturn value\n";
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 3, character: 0 },
  };
  try {
    service.open(uri, source, 1);
    await service.diagnostics(uri);
    const offered = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const deferred = offered.find((action) =>
      action.title === "Remove no-op rebinding"
    );
    assert(deferred, "the storm needs one deferred rewrite candidate");
    const checksBefore = scratch.checks.length;
    scratch.gateChecks = true;
    const storm = [
      service.resolveCodeAction(deferred),
      service.resolveCodeAction(deferred),
      service.resolveCodeAction(deferred),
      service.resolveCodeAction(deferred),
      service.resolveCodeAction(deferred),
      service.resolveCodeAction(deferred),
    ];
    await scratch.checkReached.promise;
    await settleMicrotasks();
    assertEquals(scratch.checks.length, checksBefore + 1);
    scratch.gateChecks = false;
    scratch.checkGate.releaseAll();
    const settled = await Promise.allSettled(storm);
    assertEquals(settled.length, 6);
    for (const entry of settled) {
      assertEquals(entry.status, "fulfilled");
      if (entry.status !== "fulfilled") continue;
      assertEquals(entry.value.edit.documentChanges[0].edits.length, 1);
    }
    assertEquals(scratch.checks.length, checksBefore + 12);
    let current = source;
    let version = 1;
    for (let burst = 0; burst < 5; burst += 1) {
      version += 1;
      current = `${current}\n`;
      service.change(uri, current, version);
      const burstActions = await service.codeActions(uri, range, {
        resolveEdits: true,
      });
      assert(burstActions.length > 0, "every burst revision must settle");
    }
    const latest = await service.codeActions(uri, range, {
      resolveEdits: true,
    });
    const fresh = latest.find((action) =>
      action.title === "Remove no-op rebinding"
    );
    assert(fresh);
    const proven = await service.resolveCodeAction(fresh);
    assertEquals(proven.edit.documentChanges[0].edits.length, 1);
    const stale = await service.resolveCodeAction(deferred);
    assertEquals(stale.edit.documentChanges[0].edits, []);
  } finally {
    await service.destroy();
  }
});

Deno.test("import navigation answers from the request-entry workspace snapshot", async () => {
  const directory = await Deno.makeTempDir();
  const libraryPath = join(directory, "library.blot");
  const mainPath = join(directory, "main.blot");
  const libraryUri = toFileUrl(libraryPath).href;
  const mainUri = toFileUrl(mainPath).href;
  const libraryV1 = "let answer = 42\nreturn { .answer = answer; }\n";
  const libraryV2 =
    "let padding = 0\nlet answer = 42\nreturn { .answer = answer; .padding = padding; }\n";
  const mainSource =
    `const Library = import "./library.blot"\nreturn Library.answer\n`;
  const live = new RecordingCompiler();
  live.gateSyntaxFor = mainPath;
  const service = new LanguageService({
    createCompiler: () => Promise.resolve(live),
  });
  try {
    await Deno.writeTextFile(libraryPath, libraryV1);
    await Deno.writeTextFile(mainPath, mainSource);
    service.open(libraryUri, libraryV1, 1);
    service.open(mainUri, mainSource, 1);
    const pending = service.definition(mainUri, { line: 1, character: 16 });
    await live.syntaxReached.promise;
    service.change(libraryUri, libraryV2, 2);
    live.releaseSyntax();
    assertEquals(await pending, {
      uri: libraryUri,
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 10 },
      },
    });
    assertEquals(
      live.syntaxCalls.filter((call) => call.path === libraryPath).map((
        call,
      ) => call.source),
      [libraryV1],
    );
  } finally {
    await service.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});
