import type {
  CheckedModule,
  CompilerAnalysis,
  CompilerSyntaxSnapshot,
} from "../../compiler.ts";
import type { StagedOverlay } from "../../workspace_graph.ts";
import type { LintFix } from "./types.ts";
import {
  isCompilerSourceRejection,
  type LintValidationCompiler,
  validateFixCandidate,
} from "./validation.ts";

/**
 * The compiler surface behind speculative fix validation. `Compiler`
 * satisfies this; the language service passes its validation compiler and
 * tests inject fakes to count jobs and control ordering.
 */
export interface ScratchCompiler extends LintValidationCompiler {
  analyzeSource(path: string, source: string): Promise<CompilerAnalysis>;
  syntaxSnapshot(path: string, source: string): Promise<CompilerSyntaxSnapshot>;
  stageOverlays(entries: ReadonlyMap<string, StagedOverlay>): Promise<void>;
  clearOverlay(path: string): Promise<void>;
  destroy(): void;
}

/**
 * One speculative validation request: the real document revision the
 * candidate derives from, plus the open-document overlays the scratch
 * session must share before checking anything.
 */
export interface ScratchRequest {
  readonly path: string;
  readonly source: string;
  readonly overlays: ReadonlyMap<string, StagedOverlay>;
}

export interface ScratchFixRequest extends ScratchRequest {
  readonly fix: LintFix;
}

export interface ScratchCombinedRequest extends ScratchRequest {
  readonly fixes: readonly LintFix[];
  readonly requireInterface: boolean;
}

/**
 * The one isolated session for speculative fix validation.
 *
 * The live semantic session is never rewritten onto candidate revisions:
 * every speculative check runs here, on a compiler the service owns
 * separately, seeded with the requesting revision's overlay snapshot so
 * candidates see the same workspace the diagnosis was based on. Units
 * serialize on one queue, so a check pair never interleaves with another
 * unit's staging, and every unit restores the session root to the real
 * entry source before releasing: the session is never left on a candidate
 * revision.
 */
export class ScratchValidationSession {
  readonly #createCompiler: () => Promise<ScratchCompiler>;
  #compiler: Promise<ScratchCompiler> | undefined = undefined;
  #queue: Promise<void> = Promise.resolve();
  #synced: Map<string, string> | null = null;
  #destroyed = false;

  constructor(createCompiler: () => Promise<ScratchCompiler>) {
    this.#createCompiler = createCompiler;
  }

  /**
   * Validates one selected fix against its own proof obligation. Only the
   * selected fix is checked: one original plus one candidate check for
   * semantic fixes, a local syntax parse and zero compiler jobs for
   * parse-level fixes.
   */
  validateFix(request: ScratchFixRequest): Promise<boolean> {
    return this.runExclusive(request, async (compiler) => {
      if (request.fix.validation === "parse") {
        return await validateFixCandidate(
          compiler,
          request.path,
          request.source,
          "",
          request.fix,
        );
      }
      const original = await this.#originalInterfaceKey(
        compiler,
        request,
      );
      if (original === null) return false;
      return await validateFixCandidate(
        compiler,
        request.path,
        request.source,
        original,
        request.fix,
      );
    });
  }

  /**
   * Validates one combined fix-all candidate as a single unit. Individually
   * valid fixes are not automatically jointly valid, so the combination is
   * checked once on its own; overlapping combined edits are a caller
   * violation and throw instead of reading as unproven.
   */
  validateCombined(request: ScratchCombinedRequest): Promise<boolean> {
    let validation: LintFix["validation"] = "check";
    if (request.requireInterface) validation = "check-interface";
    const combined: LintFix = {
      title: "Apply safe lint fixes",
      kind: "quickfix",
      validation,
      edits: request.fixes.flatMap((fix) => fix.edits),
    };
    return this.runExclusive(request, async (compiler) => {
      const original = await this.#originalInterfaceKey(
        compiler,
        request,
      );
      if (original === null) return false;
      return await validateFixCandidate(
        compiler,
        request.path,
        request.source,
        original,
        combined,
      );
    });
  }

  /**
   * Runs one multi-step speculative operation (fix-all) exclusively on the
   * session compiler. The operation sees the request overlays and must use
   * the compiler directly; the session restores the root afterwards.
   */
  runExclusive<T>(
    request: ScratchRequest,
    operation: (compiler: ScratchCompiler) => Promise<T>,
  ): Promise<T> {
    if (this.#destroyed) {
      return Promise.reject(
        new Error("the scratch validation session is destroyed"),
      );
    }
    const run = async (): Promise<T> => {
      const compiler = await this.#sessionCompiler();
      await this.#syncOverlays(compiler, request.overlays);
      try {
        return await operation(compiler);
      } finally {
        await compiler.stageOverlays(
          new Map([[request.path, { source: request.source }]]),
        );
        if (this.#synced !== null) {
          this.#synced.set(request.path, request.source);
        }
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Drains queued units, then destroys the session compiler. */
  async destroy(): Promise<void> {
    this.#destroyed = true;
    await this.#queue;
    const compiler = this.#compiler;
    this.#compiler = undefined;
    if (compiler !== undefined) {
      await compiler.then(
        (session) => session.destroy(),
        () => {},
      );
    }
  }

  async #originalInterfaceKey(
    compiler: ScratchCompiler,
    request: ScratchRequest,
  ): Promise<string | null> {
    try {
      const original: CheckedModule = await compiler.checkSource(
        request.path,
        request.source,
      );
      return original.interfaceKey;
    } catch (error) {
      if (!isCompilerSourceRejection(error)) throw error;
      return null;
    }
  }

  async #syncOverlays(
    compiler: ScratchCompiler,
    overlays: ReadonlyMap<string, StagedOverlay>,
  ): Promise<void> {
    const synced = this.#synced;
    const delta = new Map<string, StagedOverlay>();
    for (const [path, overlay] of overlays) {
      if (synced === null || synced.get(path) !== overlay.source) {
        delta.set(path, overlay);
      }
    }
    if (delta.size > 0) await compiler.stageOverlays(delta);
    if (synced !== null) {
      for (const path of synced.keys()) {
        if (!overlays.has(path)) await compiler.clearOverlay(path);
      }
    }
    const next = new Map<string, string>();
    for (const [path, overlay] of overlays) next.set(path, overlay.source);
    this.#synced = next;
  }

  async #sessionCompiler(): Promise<ScratchCompiler> {
    const existing = this.#compiler;
    if (existing !== undefined) return await existing;
    const created = this.#createCompiler();
    this.#compiler = created;
    try {
      return await created;
    } catch (error) {
      if (this.#compiler === created) this.#compiler = undefined;
      throw error;
    }
  }
}
