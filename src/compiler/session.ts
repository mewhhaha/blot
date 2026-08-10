import { resolve } from "@std/path";
import { checkFile, checkSource } from "../check/mod.ts";
import {
  load,
  type Loaded,
  refreshLoadedModules,
} from "../load.ts";
import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
} from "../runtime/hir.ts";
import {
  compileBlotRuntimeModulesOnRustWasm,
  warmBlotRuntimeEmitter,
} from "../conformance/gpufuck/runtime/target.ts";
import { warmBabaRuntime } from "../syntax/baba_runtime.ts";
import { encodePortableModule } from "../syntax/portable.ts";
import { prepareGpupaperHir } from "./node_hir.ts";

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

interface CachedArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
}

interface ResidentRevision {
  readonly key: string;
  checked?: CheckedModule;
  hir?: BlotRuntimeModule;
}

const revisionKeyByLoaded = new WeakMap<Loaded, string>();

/**
 * A Node-hosted compiler session.
 *
 * Baba's checked-in parser Wasm owns syntax. Blot's TypeScript passes own source
 * semantics and Runtime HIR. Gpupaper's checked-in Rust/Wasm module owns final
 * binary-plan validation and emission. No Deno runtime or native Rust toolchain
 * participates in this path.
 */
export class Compiler {
  readonly #compiled = new WeakMap<BlotRuntimeModule, CachedArtifact>();
  readonly #revisions = new Map<string, ResidentRevision>();
  #destroyed = false;

  private constructor() {}

  static async create(): Promise<Compiler> {
    warmBabaRuntime();
    warmBlotRuntimeEmitter();
    return new Compiler();
  }

  async check(path: string): Promise<CheckedModule> {
    this.#requireActive();
    const absolute = resolve(path);
    const revision = await this.#revision(absolute);
    if (revision.checked !== undefined) return revision.checked;
    const checked = await checkFile(absolute);
    const summary = { type: checked.type, effects: checked.effects };
    revision.checked = summary;
    return summary;
  }

  async checkSource(path: string, source: string): Promise<CheckedModule> {
    this.#requireActive();
    const checked = await checkSource(resolve(path), source);
    return { type: checked.type, effects: checked.effects };
  }

  async prepare(path: string): Promise<BlotRuntimeModule> {
    this.#requireActive();
    const absolute = resolve(path);
    const revision = await this.#revision(absolute);
    if (revision.hir !== undefined) return revision.hir;
    const hir = await prepareGpupaperHir(absolute);
    revision.hir = hir;
    return hir;
  }

  async compile(path: string): Promise<CompilerArtifact> {
    this.#requireActive();
    const absolute = resolve(path);
    const hir = await this.prepare(absolute);
    const cached = this.#compiled.get(hir);
    if (cached !== undefined) {
      return {
        wasm: cached.wasm.slice(),
        manifestBytes: cached.manifestBytes.slice(),
        capabilities: cached.capabilities.slice(),
        artifactSource: "revision-cache",
      };
    }

    const module = validateBlotRuntimeModule(hir);
    const batch = await compileBlotRuntimeModulesOnRustWasm(
      [module],
      { target: "wasm-simd128" },
    );
    const emitted = batch.artifacts[0];
    if (emitted === undefined || batch.artifacts.length !== 1) {
      throw new Error(
        `${absolute}: gpupaper emitted ${batch.artifacts.length} artifacts for one module`,
      );
    }
    const artifact: CachedArtifact = {
      wasm: emitted.wasm.slice(),
      manifestBytes: emitted.manifestBytes.slice(),
      capabilities: Object.freeze([
        ...new Set(
          emitted.manifest.imports.map((imported) => imported.capability),
        ),
      ].sort()),
    };
    this.#compiled.set(hir, artifact);
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
    await refreshLoadedModules();
    const loaded = await load(path);
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

function loadedRevisionKey(loaded: Loaded): string {
  const cached = revisionKeyByLoaded.get(loaded);
  if (cached !== undefined) return cached;

  const dependencies = [...loaded.dependencies].map(
    ([specifier, dependency]) => ({
      specifier,
      revision: loadedRevisionKey(dependency),
    }),
  );
  const includedFiles = [...loaded.includedFiles].map(
    ([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    }),
  );
  const key = JSON.stringify({
    path: loaded.path,
    module: encodePortableModule(loaded.module),
    dependencies,
    includedFiles,
  });
  revisionKeyByLoaded.set(loaded, key);
  return key;
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
