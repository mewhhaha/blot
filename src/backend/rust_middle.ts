import { dirname, isAbsolute, relative, resolve } from "@std/path";
import { BlotError } from "../diagnostic.ts";
import { LoadError, resolvePath } from "../load.ts";
import type { BlotRuntimeModule } from "./runtime/hir.ts";
import { RustMiddle } from "./rust_middle_wasm.ts";

const compilerUrl = new URL(
  "../../generated/rust-middle/compiler.wasm",
  import.meta.url,
);

interface ResidentModule {
  readonly source: string;
  readonly imports: readonly string[];
  readonly includes: readonly string[];
  readonly configurationRevision?: string;
}

interface PreparedRevision {
  readonly revision: string;
  readonly module: BlotRuntimeModule;
}

interface CompiledRevision {
  readonly revision: string;
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
}

export interface RustCompilerArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
  readonly artifactSource: "compiled" | "revision-cache";
}

export interface RustCheckedModule {
  readonly type: string;
  readonly effects: string;
}

interface LoadedRevision {
  readonly revision: string;
}

export class RustMiddleCompiler {
  readonly #rust: RustMiddle;
  readonly #session: number;
  readonly #modules = new Map<string, ResidentModule>();
  readonly #prepared = new Map<string, PreparedRevision>();
  readonly #compiled = new Map<string, CompiledRevision>();
  #destroyed = false;

  private constructor(rust: RustMiddle) {
    this.#rust = rust;
    this.#session = rust.createCompilerSession();
  }

  static async create(): Promise<RustMiddleCompiler> {
    const wasm = await Deno.readFile(compilerUrl);
    return new RustMiddleCompiler(await RustMiddle.load(wasm));
  }

  async check(path: string): Promise<RustCheckedModule> {
    this.#requireActive();
    const absolute = resolve(path);
    await this.#load(absolute, []);
    const checked = this.#rust.checkCompilerSessionModule(
      this.#session,
      absolute,
    );
    if (checked.ok) {
      return { type: checked.type, effects: checked.effects };
    }
    if (checked.diagnostic !== undefined) {
      let origin = checked.diagnostic.origin;
      if (origin === undefined) origin = absolute;
      const source = this.#modules.get(origin)?.source;
      if (source === undefined) {
        throw new Error(`${origin}: resident Rust module lost its source`);
      }
      throw new BlotError(checked.diagnostic, { path: origin, source });
    }
    throw new Error(
      `${absolute}: Rust compiler failed without a diagnostic: ${checked.message}`,
    );
  }

  async prepare(path: string): Promise<BlotRuntimeModule> {
    this.#requireActive();
    const absolute = resolve(path);
    const loaded = await this.#load(absolute, []);
    const cached = this.#prepared.get(absolute);
    if (cached !== undefined && cached.revision === loaded.revision) {
      return cached.module;
    }
    const prepared = this.#rust.prepareCompilerSessionRuntimeHir(
      this.#session,
      absolute,
    );
    if (!prepared.ok) {
      if (prepared.diagnostic !== undefined) {
        let origin = prepared.diagnostic.origin;
        if (origin === undefined) origin = absolute;
        const source = this.#modules.get(origin)?.source;
        if (source === undefined) {
          throw new Error(`${origin}: resident Rust module lost its source`);
        }
        throw new BlotError(
          prepared.diagnostic,
          { path: origin, source },
        );
      }
      throw new Error(
        `${absolute}: Rust compiler failed without a diagnostic: ${prepared.message}`,
      );
    }
    const module = freezeSnapshot(prepared.module);
    this.#prepared.set(absolute, { revision: loaded.revision, module });
    return module;
  }

  async compile(path: string): Promise<RustCompilerArtifact> {
    this.#requireActive();
    const absolute = resolve(path);
    const loaded = await this.#load(absolute, []);
    const cached = this.#compiled.get(absolute);
    if (cached !== undefined && cached.revision === loaded.revision) {
      return {
        wasm: cached.wasm.slice(),
        manifestBytes: cached.manifestBytes.slice(),
        capabilities: cached.capabilities.slice(),
        artifactSource: "revision-cache",
      };
    }
    const compiled = this.#rust.compileCompilerSessionModule(
      this.#session,
      absolute,
    );
    if (!compiled.ok) {
      if (compiled.diagnostic !== undefined) {
        let origin = compiled.diagnostic.origin;
        if (origin === undefined) origin = absolute;
        const source = this.#modules.get(origin)?.source;
        if (source === undefined) {
          throw new Error(`${origin}: resident Rust module lost its source`);
        }
        throw new BlotError(compiled.diagnostic, { path: origin, source });
      }
      throw new Error(
        `${absolute}: Rust compiler failed without a diagnostic: ${compiled.message}`,
      );
    }
    try {
      await WebAssembly.compile(Uint8Array.from(compiled.wasm).buffer);
    } catch (cause) {
      throw new Error(
        `${absolute}: Rust compiler emitted invalid WebAssembly: ${cause}`,
        { cause },
      );
    }
    const artifact = {
      revision: loaded.revision,
      wasm: compiled.wasm.slice(),
      manifestBytes: compiled.manifestBytes.slice(),
      capabilities: Object.freeze(compiled.capabilities.slice()),
    };
    this.#compiled.set(absolute, artifact);
    return {
      wasm: artifact.wasm.slice(),
      manifestBytes: artifact.manifestBytes.slice(),
      capabilities: artifact.capabilities.slice(),
      artifactSource: "compiled",
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#rust.destroyCompilerSession(this.#session);
    this.#destroyed = true;
    this.#modules.clear();
    this.#prepared.clear();
    this.#compiled.clear();
  }

  async #load(
    path: string,
    active: readonly string[],
  ): Promise<LoadedRevision> {
    const cycleStart = active.indexOf(path);
    if (cycleStart >= 0) {
      const cycle = [...active.slice(cycleStart), path];
      throw new BlotError({
        code: "BLOT_IMPORT_CYCLE",
        message: `Import cycle: ${cycle.join(" -> ")}.`,
        span: { start: 0, end: 0 },
      });
    }
    const source = await Deno.readTextFile(path);
    let resident = this.#modules.get(path);
    if (resident === undefined || resident.source !== source) {
      const added = this.#rust.addCompilerSessionModule(
        this.#session,
        path,
        source,
      );
      if (!added.ok) {
        if (added.diagnostics !== undefined) {
          throw new LoadError(path, source, added.diagnostics);
        }
        throw loweringError(path, source, added.message);
      }
      resident = {
        source,
        imports: added.module.imports,
        includes: added.module.includes,
      };
      this.#modules.set(path, resident);
    }

    const nextActive = [...active, path];
    const imports: Record<string, string> = {};
    const dependencyRevisions: string[] = [];
    for (const specifier of resident.imports) {
      const dependencyPath = resolvePath(specifier, path);
      const dependency = await this.#load(dependencyPath, nextActive);
      imports[specifier] = dependencyPath;
      dependencyRevisions.push(`${specifier}:${dependency.revision}`);
    }

    const includes: Record<
      string,
      { readonly path: string; readonly text: string }
    > = {};
    const includeRevisions: string[] = [];
    for (const specifier of resident.includes) {
      let includedPath = specifier;
      if (!isAbsolute(specifier)) {
        includedPath = resolve(dirname(path), specifier);
      }
      let text: string;
      try {
        text = await Deno.readTextFile(includedPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new LoadError(path, source, [{
            code: "BLOT_INCLUDE_NOT_FOUND",
            message: `Included file \`${specifier}\` does not exist.`,
            span: { start: 0, end: 0 },
          }]);
        }
        throw new Error(
          `could not read included Blot file ${JSON.stringify(includedPath)}`,
          { cause: error },
        );
      }
      let normalizedPath = relative(dirname(path), includedPath).replaceAll(
        "\\",
        "/",
      );
      if (!normalizedPath.startsWith(".")) {
        normalizedPath = `./${normalizedPath}`;
      }
      includes[specifier] = { path: normalizedPath, text };
      includeRevisions.push(`${specifier}:${includedPath}:${text}`);
    }
    const configurationRevision = revision([
      ...Object.entries(imports).flatMap(([specifier, dependency]) => [
        specifier,
        dependency,
      ]),
      ...includeRevisions,
    ]);
    if (resident.configurationRevision !== configurationRevision) {
      this.#rust.configureCompilerSessionModule(this.#session, path, {
        imports,
        includes,
      });
      resident = { ...resident, configurationRevision };
      this.#modules.set(path, resident);
    }
    return {
      revision: revision([
        path,
        source,
        ...dependencyRevisions,
        ...includeRevisions,
      ]),
    };
  }

  #requireActive(): void {
    if (this.#destroyed) {
      throw new Error("Rust middle compiler session has been destroyed");
    }
  }
}

let sharedCompiler: Promise<RustMiddleCompiler> | undefined;

export async function prepareRustGpupaperHir(
  path: string,
): Promise<BlotRuntimeModule> {
  if (sharedCompiler === undefined) {
    sharedCompiler = RustMiddleCompiler.create();
  }
  return await (await sharedCompiler).prepare(path);
}

export async function compileRustGpupaperArtifact(
  path: string,
): Promise<RustCompilerArtifact> {
  if (sharedCompiler === undefined) {
    sharedCompiler = RustMiddleCompiler.create();
  }
  return await (await sharedCompiler).compile(path);
}

function loweringError(
  path: string,
  source: string,
  message: string | undefined,
): Error {
  if (message === undefined) {
    return new Error(
      `${path}: Rust source lowering failed without a diagnostic`,
    );
  }
  const separator = message.indexOf(":");
  if (separator > 0) {
    return new BlotError(
      {
        code: message.slice(0, separator),
        message: message.slice(separator + 1).trim(),
        span: { start: 0, end: 0 },
      },
      { path, source },
    );
  }
  return new Error(`${path}: Rust CST lowering failed: ${message}`);
}

function revision(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

function freezeSnapshot<Value>(
  value: Value,
  seen: WeakSet<object> = new WeakSet(),
): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  const object = value as object & Record<PropertyKey, unknown>;
  for (const property of Reflect.ownKeys(object)) {
    freezeSnapshot(object[property], seen);
  }
  return Object.freeze(value);
}
