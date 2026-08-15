import { resolve } from "@std/path";
import {
  close,
  type CompilerTargetPolicy,
  type ResolvedCompilerTargetPolicy,
  resolveTargetPolicy,
  warmBackend,
} from "./backend.ts";
import { refreshProgram } from "./frontend.ts";
import { checkProgram, checkProgramSource } from "./typecheck.ts";
import type { BlotRuntimeModule } from "../runtime/hir.ts";
import { warmBabaRuntime } from "../syntax/baba_runtime.ts";
import { lowerRuntimeHir } from "./hir.ts";
import { loadedRevisionKey } from "./revision.ts";

export interface CompilerArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
  readonly artifactSource: "compiled" | "revision-cache";
}

export interface CheckedModule {
  readonly type: string;
  readonly effects: string;
}

export interface CompilerOptions {
  readonly targetPolicy?: CompilerTargetPolicy;
}

interface CachedArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
}

interface PreparedArtifact {
  readonly hir: BlotRuntimeModule;
  readonly artifact: CachedArtifact;
}

interface ResidentRevision {
  readonly key: string;
  checked?: CheckedModule;
  hir?: BlotRuntimeModule;
}

/**
 * The default Node/TypeScript development compiler session.
 *
 * Baba's checked-in parser Wasm owns syntax. Blot's TypeScript passes own source
 * semantics and Runtime HIR. The compiler-owned backend boundary delegates final
 * binary-plan validation and emission. No Deno runtime or native Rust toolchain
 * participates in this path.
 */
export class Compiler {
  readonly #compiled = new WeakMap<BlotRuntimeModule, CachedArtifact>();
  readonly #compiledByPath = new Map<string, PreparedArtifact>();
  readonly #revisions = new Map<string, ResidentRevision>();
  readonly #targetPolicy: ResolvedCompilerTargetPolicy;
  #destroyed = false;

  private constructor(targetPolicy: ResolvedCompilerTargetPolicy) {
    this.#targetPolicy = targetPolicy;
  }

  static create(options: CompilerOptions = {}): Promise<Compiler> {
    const targetPolicy = resolveTargetPolicy(options.targetPolicy);
    warmBabaRuntime();
    warmBackend();
    return Promise.resolve(new Compiler(targetPolicy));
  }

  async check(path: string): Promise<CheckedModule> {
    this.#requireActive();
    const absolute = resolve(path);
    const revision = await this.#revision(absolute);
    if (revision.checked !== undefined) return revision.checked;
    const checked = await checkProgram(absolute);
    const summary = { type: checked.type, effects: checked.effects };
    revision.checked = summary;
    return summary;
  }

  async checkSource(path: string, source: string): Promise<CheckedModule> {
    this.#requireActive();
    const checked = await checkProgramSource(resolve(path), source);
    return { type: checked.type, effects: checked.effects };
  }

  async prepare(path: string): Promise<BlotRuntimeModule> {
    this.#requireActive();
    const absolute = resolve(path);
    const revision = await this.#revision(absolute);
    if (revision.hir !== undefined) return revision.hir;
    const hir = await lowerRuntimeHir(absolute);
    revision.hir = hir;
    return hir;
  }

  async compile(path: string): Promise<CompilerArtifact> {
    this.#requireActive();
    const absolute = resolve(path);
    const hir = await this.prepare(absolute);
    const cached = this.#compiled.get(hir);
    if (cached !== undefined) return cachedArtifact(cached);

    const previous = this.#compiledByPath.get(absolute);
    if (previous !== undefined && sameRuntimeProgram(previous.hir, hir)) {
      this.#compiled.set(hir, previous.artifact);
      return cachedArtifact(previous.artifact);
    }

    const program = close(hir, this.#targetPolicy);
    const emitted = await program.compile();
    const artifact: CachedArtifact = {
      wasm: emitted.wasm.slice(),
      manifestBytes: emitted.manifestBytes.slice(),
      capabilities: emitted.capabilities.slice(),
    };
    this.#compiled.set(hir, artifact);
    this.#compiledByPath.set(absolute, { hir, artifact });
    return {
      wasm: artifact.wasm.slice(),
      manifestBytes: artifact.manifestBytes.slice(),
      capabilities: artifact.capabilities.slice(),
      artifactSource: "compiled",
    };
  }

  destroy(): void {
    this.#destroyed = true;
  }

  async #revision(path: string): Promise<ResidentRevision> {
    const loaded = await refreshProgram(path);
    const key = loadedRevisionKey(loaded);
    const cached = this.#revisions.get(path);
    if (cached !== undefined && cached.key === key) return cached;
    const revision: ResidentRevision = { key };
    this.#revisions.set(path, revision);
    return revision;
  }

  #requireActive(): void {
    if (this.#destroyed) {
      throw new Error("Compiler session has been destroyed");
    }
  }
}

let sharedCompiler: Promise<Compiler> | undefined;

export async function prepareRuntimeHir(
  path: string,
): Promise<BlotRuntimeModule> {
  if (sharedCompiler === undefined) {
    sharedCompiler = Compiler.create();
  }
  return await (await sharedCompiler).prepare(path);
}

export async function compileArtifact(
  path: string,
): Promise<CompilerArtifact> {
  if (sharedCompiler === undefined) {
    sharedCompiler = Compiler.create();
  }
  return await (await sharedCompiler).compile(path);
}

function cachedArtifact(artifact: CachedArtifact): CompilerArtifact {
  return {
    wasm: artifact.wasm.slice(),
    manifestBytes: artifact.manifestBytes.slice(),
    capabilities: artifact.capabilities.slice(),
    artifactSource: "revision-cache",
  };
}

/** Runtime source locations do not affect a successfully emitted program. */
function sameRuntimeProgram(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (typeof left !== "object") return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) =>
      sameRuntimeProgram(value, right[index])
    );
  }
  if (Array.isArray(right)) return false;

  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).filter((key) => key !== "span");
  const rightKeys = Object.keys(rightRecord).filter((key) => key !== "span");
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!;
    if (key !== rightKeys[index]) return false;
    if (!sameRuntimeProgram(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
