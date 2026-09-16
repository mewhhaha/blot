import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  CheckedModule,
  CompilerAnalysis,
  CompilerSyntaxSnapshot,
} from "../../compiler.ts";
import { BlotError } from "../../diagnostic.ts";
import { Barrier } from "../../lsp/testing.ts";
import type { StagedOverlay } from "../../workspace_graph.ts";
import { type ScratchCompiler, ScratchValidationSession } from "./scratch.ts";
import type { LintFix } from "./types.ts";

const PATH = "/tmp/blot-scratch-fixture.blot";
const SOURCE = "return 1\n";

type CheckBehavior = (
  path: string,
  source: string,
) => CheckedModule | Promise<CheckedModule>;

class FakeScratchCompiler implements ScratchCompiler {
  checks: Array<{ readonly path: string; readonly source: string }> = [];
  stages: Array<ReadonlyMap<string, StagedOverlay>> = [];
  cleared: string[] = [];
  events: string[] = [];
  destroyed = false;
  gate: Barrier | null = null;
  behavior: CheckBehavior = (_path, source) => ({
    type: "Int",
    effects: "",
    interfaceKey: `key:${source}`,
  });

  analyzeSource(
    _path: string,
    source: string,
  ): Promise<CompilerAnalysis> {
    return Promise.reject(
      new Error(`scratch analysis is out of scope for ${source.length}`),
    );
  }

  syntaxSnapshot(
    _path: string,
    _source: string,
  ): Promise<CompilerSyntaxSnapshot> {
    return Promise.reject(
      new Error("scratch syntax snapshots are out of scope"),
    );
  }

  async checkSource(path: string, source: string): Promise<CheckedModule> {
    this.checks.push({ path, source });
    this.events.push(`check:${path}:${source}`);
    const gate = this.gate;
    if (gate !== null) await gate.wait();
    return await this.behavior(path, source);
  }

  stageOverlays(
    entries: ReadonlyMap<string, StagedOverlay>,
  ): Promise<void> {
    this.stages.push(new Map(entries));
    for (const [path, overlay] of entries) {
      this.events.push(`stage:${path}:${overlay.source}`);
    }
    return Promise.resolve();
  }

  clearOverlay(path: string): Promise<void> {
    this.cleared.push(path);
    this.events.push(`clear:${path}`);
    return Promise.resolve();
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function testSession(compiler: FakeScratchCompiler): ScratchValidationSession {
  return new ScratchValidationSession(() => Promise.resolve(compiler));
}

function fix(
  validation: LintFix["validation"],
  replacement = "return 2\n",
): LintFix {
  return {
    title: "Rewrite",
    edits: [{ span: { start: 0, end: SOURCE.length }, replacement }],
    kind: "quickfix",
    validation,
  };
}

const OVERLAYS: ReadonlyMap<string, StagedOverlay> = new Map([
  ["/tmp/blot-scratch-dep.blot", { source: "return 41\n" }],
]);

Deno.test("a parse-level fix validates with zero compiler jobs", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  try {
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("parse"),
      }),
      true,
    );
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("parse", ")(\n"),
      }),
      false,
    );
    assertEquals(compiler.checks, []);
  } finally {
    await session.destroy();
  }
});

Deno.test("a check-level fix validates its original and candidate pair", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  try {
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("check"),
      }),
      true,
    );
    assertEquals(
      compiler.checks.map((call) => call.source),
      [SOURCE, "return 2\n"],
    );
  } finally {
    await session.destroy();
  }
});

Deno.test("a check-interface fix compares the candidate interface key", async () => {
  const compiler = new FakeScratchCompiler();
  compiler.behavior = () => ({
    type: "Int",
    effects: "",
    interfaceKey: "same",
  });
  const session = testSession(compiler);
  try {
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("check-interface"),
      }),
      true,
    );
    compiler.behavior = (_path, source) => {
      let interfaceKey = "after";
      if (source === SOURCE) interfaceKey = "before";
      return { type: "Int", effects: "", interfaceKey };
    };
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("check-interface"),
      }),
      false,
    );
  } finally {
    await session.destroy();
  }
});

Deno.test("source rejections read as unproven while infrastructure throws", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  const rejection = new BlotError(
    {
      code: "BLOT_UNREACHABLE_STATEMENT",
      message: "no",
      span: { start: 0, end: 1 },
    },
    null,
  );
  try {
    compiler.behavior = (_path, source) => {
      if (source !== SOURCE) throw rejection;
      return { type: "Int", effects: "", interfaceKey: "key" };
    };
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("check"),
      }),
      false,
    );
    compiler.behavior = () => {
      throw rejection;
    };
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("check"),
      }),
      false,
    );
    compiler.behavior = () => {
      throw new Error("worker exploded");
    };
    await assertRejects(
      () =>
        session.validateFix({
          path: PATH,
          source: SOURCE,
          overlays: OVERLAYS,
          fix: fix("check"),
        }),
      Error,
      "worker exploded",
    );
  } finally {
    await session.destroy();
  }
});

Deno.test("a combined candidate validates as one unit, not per fix", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  try {
    const left = fix("check-interface", "return 1\n");
    const right: LintFix = {
      title: "Append",
      edits: [{
        span: { start: SOURCE.length, end: SOURCE.length },
        replacement: "return 2\n",
      }],
      kind: "quickfix",
      validation: "check-interface",
    };
    assertEquals(
      await session.validateCombined({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fixes: [left, right],
        requireInterface: false,
      }),
      true,
    );
    assertEquals(compiler.checks.length, 2);
    assertEquals(compiler.checks[1].source, "return 1\nreturn 2\n");
  } finally {
    await session.destroy();
  }
});

Deno.test("overlapping combined edits throw instead of reading unproven", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  try {
    await assertRejects(
      () =>
        session.validateCombined({
          path: PATH,
          source: SOURCE,
          overlays: OVERLAYS,
          fixes: [fix("check"), fix("check")],
          requireInterface: false,
        }),
      Error,
      "overlapping edits",
    );
  } finally {
    await session.destroy();
  }
});

Deno.test("validation shares the request overlays and restores the root", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  try {
    await session.validateFix({
      path: PATH,
      source: SOURCE,
      overlays: OVERLAYS,
      fix: fix("check"),
    });
    const depStages = compiler.stages.flatMap((stage) =>
      [...stage.entries()].filter(([path]) =>
        path === "/tmp/blot-scratch-dep.blot"
      )
    );
    assertEquals(depStages.length, 1);
    assertEquals(depStages[0][1].source, "return 41\n");
    const rootStages = compiler.stages.flatMap((stage) =>
      [...stage.entries()].filter(([path]) => path === PATH)
    );
    assert(rootStages.length > 0, "the session root must be restored");
    assertEquals(rootStages[rootStages.length - 1][1].source, SOURCE);
    const firstCheck = compiler.events.findIndex((event) =>
      event.startsWith("check:")
    );
    const firstStage = compiler.events.findIndex((event) =>
      event.startsWith("stage:")
    );
    assert(firstStage >= 0 && firstStage < firstCheck);
  } finally {
    await session.destroy();
  }
});

Deno.test("closed overlays are cleared instead of haunting the session", async () => {
  const compiler = new FakeScratchCompiler();
  const session = testSession(compiler);
  try {
    await session.validateFix({
      path: PATH,
      source: SOURCE,
      overlays: OVERLAYS,
      fix: fix("parse"),
    });
    assertEquals(compiler.cleared, []);
    await session.validateFix({
      path: PATH,
      source: SOURCE,
      overlays: new Map(),
      fix: fix("parse"),
    });
    assertEquals(compiler.cleared, [
      "/tmp/blot-scratch-dep.blot",
      PATH,
    ]);
  } finally {
    await session.destroy();
  }
});

Deno.test("concurrent validations serialize behind one another", async () => {
  const compiler = new FakeScratchCompiler();
  compiler.gate = new Barrier();
  const session = testSession(compiler);
  try {
    const first = session.validateFix({
      path: PATH,
      source: SOURCE,
      overlays: OVERLAYS,
      fix: fix("check"),
    });
    while (compiler.checks.length < 1) await Promise.resolve();
    const second = session.validateFix({
      path: PATH,
      source: SOURCE,
      overlays: OVERLAYS,
      fix: fix("check"),
    });
    for (let round = 0; round < 20; round += 1) await Promise.resolve();
    assertEquals(compiler.checks.length, 1);
    compiler.gate.releaseAll();
    compiler.gate = null;
    assertEquals(await first, true);
    assertEquals(await second, true);
    const restoreIndex = compiler.events.findIndex((event) =>
      event === `stage:${PATH}:${SOURCE}`
    );
    const secondChecks = compiler.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === `check:${PATH}:${SOURCE}`)
      .map(({ index }) => index);
    assertEquals(secondChecks.length, 2);
    assert(restoreIndex >= 0 && restoreIndex < secondChecks[1]);
  } finally {
    await session.destroy();
  }
});

Deno.test("a failed compiler creation is forgotten so the next unit retries", async () => {
  let attempts = 0;
  const compiler = new FakeScratchCompiler();
  const session = new ScratchValidationSession(() => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("no compiler yet"));
    return Promise.resolve(compiler);
  });
  try {
    await assertRejects(
      () =>
        session.validateFix({
          path: PATH,
          source: SOURCE,
          overlays: OVERLAYS,
          fix: fix("parse"),
        }),
      Error,
      "no compiler yet",
    );
    assertEquals(
      await session.validateFix({
        path: PATH,
        source: SOURCE,
        overlays: OVERLAYS,
        fix: fix("parse"),
      }),
      true,
    );
    assertEquals(attempts, 2);
    assertEquals(compiler.destroyed, false);
  } finally {
    await session.destroy();
  }
  assertEquals(compiler.destroyed, true);
});
