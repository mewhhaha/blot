import { resolve } from "@std/path";
import { BlotError, type Diagnostic } from "../diagnostic.ts";
import { type Loaded, LoadError } from "../load.ts";
import { encodePortableModule } from "../syntax/portable.ts";
import type { BlotRuntimeModule } from "../runtime/hir.ts";
import {
  CompilerInvariantFailure,
  type CompilerTargetPolicy,
  CompilerTargetRefusal,
  resolveTargetPolicy,
} from "./backend.ts";
import { refreshProgram } from "./frontend.ts";
import { loadedRevisionKey } from "./revision.ts";
import type {
  CheckedModule,
  CompilerArtifact,
  CompilerHost,
} from "./session.ts";
import {
  type CompilerSourceDiagnostic,
  type CompilerTransportFailure,
  CompilerWasm,
} from "./wasm.ts";

export interface ProductionCompilerOptions {
  readonly wasm: Uint8Array;
  readonly targetPolicy?: CompilerTargetPolicy;
}

interface ResidentProductionRevision {
  readonly key: string;
  hir?: BlotRuntimeModule;
  artifact?: CompilerArtifact;
}

/** High-level host for the CI-built Rust production compiler Wasm. */
export class ProductionCompiler implements CompilerHost {
  readonly #compiler: CompilerWasm;
  readonly #handle: number;
  readonly #revisions = new Map<string, ResidentProductionRevision>();
  readonly #sources = new Map<string, string>();
  #destroyed = false;

  private constructor(compiler: CompilerWasm) {
    this.#compiler = compiler;
    this.#handle = compiler.createCompilerSession();
  }

  static async create(
    options: ProductionCompilerOptions,
  ): Promise<ProductionCompiler> {
    resolveTargetPolicy(options.targetPolicy);
    try {
      return new ProductionCompiler(await CompilerWasm.load(options.wasm));
    } catch (error) {
      throw new CompilerInvariantFailure(
        "production compiler initialization",
        error,
      );
    }
  }

  async check(path: string): Promise<CheckedModule> {
    this.#requireActive();
    const absolute = resolve(path);
    await this.#sync(absolute);
    const result = this.#compiler.checkCompilerSessionModule(
      this.#handle,
      absolute,
    );
    if (!result.ok) this.#throwFailure(result, absolute, "checking");
    return { type: result.type, effects: result.effects };
  }

  async prepare(path: string): Promise<BlotRuntimeModule> {
    this.#requireActive();
    const absolute = resolve(path);
    const revision = await this.#sync(absolute);
    if (revision.hir !== undefined) return revision.hir;
    const result = this.#compiler.prepareCompilerSessionRuntimeHir(
      this.#handle,
      absolute,
    );
    if (!result.ok) {
      this.#throwFailure(result, absolute, "Runtime HIR preparation");
    }
    revision.hir = result.module;
    return revision.hir;
  }

  async compile(path: string): Promise<CompilerArtifact> {
    this.#requireActive();
    const absolute = resolve(path);
    const revision = await this.#sync(absolute);
    if (revision.artifact !== undefined) {
      return copiedArtifact(revision.artifact, "revision-cache");
    }
    const result = this.#compiler.compileCompilerSessionModule(
      this.#handle,
      absolute,
    );
    if (!result.ok) this.#throwFailure(result, absolute, "backend emission");
    const artifact: CompilerArtifact = {
      wasm: result.wasm.slice(),
      manifestBytes: result.manifestBytes.slice(),
      capabilities: result.capabilities.slice(),
      artifactSource: "compiled",
    };
    revision.artifact = artifact;
    return copiedArtifact(artifact, "compiled");
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#compiler.destroyCompilerSession(this.#handle);
  }

  async #sync(path: string): Promise<ResidentProductionRevision> {
    const root = await refreshProgram(path);
    const key = loadedRevisionKey(root);
    const resident = this.#revisions.get(path);
    if (resident !== undefined && resident.key === key) return resident;

    const modules = collectGraph(root);
    for (const loaded of modules.values()) {
      this.#sources.set(loaded.path, loaded.source);
      let added;
      if (loaded.storage.tag === "source") {
        added = this.#compiler.addCompilerSessionModule(
          this.#handle,
          loaded.path,
          loaded.source,
        );
      } else {
        added = this.#compiler.addCompilerSessionAst(
          this.#handle,
          loaded.path,
          JSON.stringify(encodePortableModule(loaded.module)),
        );
      }
      if (!added.ok) this.#throwLoadFailure(added, loaded);
    }
    for (const loaded of modules.values()) {
      try {
        this.#compiler.configureCompilerSessionModule(
          this.#handle,
          loaded.path,
          {
            imports: Object.fromEntries(
              [...loaded.dependencies].map(([specifier, dependency]) => [
                specifier,
                dependency.path,
              ]),
            ),
            includes: Object.fromEntries(
              [...loaded.includedFiles].map(([specifier, included]) => [
                specifier,
                { path: included.path, text: included.source },
              ]),
            ),
          },
        );
      } catch (error) {
        throw new CompilerInvariantFailure(
          "production source-graph configuration",
          error,
        );
      }
    }

    const revision: ResidentProductionRevision = { key };
    this.#revisions.set(path, revision);
    return revision;
  }

  #throwLoadFailure(
    failure: CompilerTransportFailure,
    loaded: Loaded,
  ): never {
    if (failure.diagnostics !== undefined) {
      const diagnostics = failure.diagnostics.map(sourceDiagnostic);
      throw new LoadError(loaded.path, loaded.source, diagnostics);
    }
    if (failure.diagnostic !== undefined) {
      throw new LoadError(
        loaded.path,
        loaded.source,
        [sourceDiagnostic(failure.diagnostic)],
      );
    }
    this.#throwFailure(failure, loaded.path, "source-graph loading");
  }

  #throwFailure(
    failure: CompilerTransportFailure,
    fallbackPath: string,
    phase: string,
  ): never {
    if (failure.targetRefusal !== undefined) {
      throw new CompilerTargetRefusal(failure.targetRefusal.message);
    }
    if (failure.invariantFailure !== undefined) {
      throw new CompilerInvariantFailure(
        failure.invariantFailure.phase,
        new Error(failure.invariantFailure.message),
      );
    }
    let diagnostic = failure.diagnostic;
    if (
      diagnostic === undefined && failure.diagnostics !== undefined &&
      failure.diagnostics.length > 0
    ) {
      diagnostic = failure.diagnostics[0];
    }
    if (diagnostic !== undefined) {
      let originPath = fallbackPath;
      if (diagnostic.origin !== undefined) originPath = diagnostic.origin;
      const source = this.#sources.get(originPath);
      if (source === undefined) {
        throw new CompilerInvariantFailure(
          "production diagnostic transport",
          new Error(`Rust diagnostic named unknown origin ${originPath}`),
        );
      }
      throw new BlotError(sourceDiagnostic(diagnostic), {
        path: originPath,
        source,
      });
    }
    let message = "Rust compiler failed without a transport payload";
    if (failure.message !== undefined) message = failure.message;
    throw new CompilerInvariantFailure(
      `production ${phase} transport`,
      new Error(message),
    );
  }

  #requireActive(): void {
    if (this.#destroyed) {
      throw new Error("Compiler session has been destroyed");
    }
  }
}

function sourceDiagnostic(diagnostic: CompilerSourceDiagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    span: diagnostic.span,
  };
}

function collectGraph(root: Loaded): Map<string, Loaded> {
  const modules = new Map<string, Loaded>();
  const pending = [root];
  while (pending.length > 0) {
    const loaded = pending.pop();
    if (loaded === undefined || modules.has(loaded.path)) continue;
    modules.set(loaded.path, loaded);
    pending.push(...loaded.dependencies.values());
  }
  return modules;
}

function copiedArtifact(
  artifact: CompilerArtifact,
  artifactSource: CompilerArtifact["artifactSource"],
): CompilerArtifact {
  return {
    wasm: artifact.wasm.slice(),
    manifestBytes: artifact.manifestBytes.slice(),
    capabilities: artifact.capabilities.slice(),
    artifactSource,
  };
}
