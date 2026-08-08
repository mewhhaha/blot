import { dirname, isAbsolute, relative, resolve } from "@std/path";
import { BlotError } from "../diagnostic.ts";
import { LoadError, resolvePath } from "../load.ts";
import {
  type CapsuleModule,
  decodeModuleCapsuleForRust,
  isPackageSpecifier,
  type ModuleCapsule,
  PackageArtifactError,
  resolvePackageExport,
} from "../package_format.ts";
import type { BlotRuntimeModule } from "../runtime/hir.ts";
import { CompilerWasm } from "./wasm.ts";

const compilerUrl = new URL(
  "../../generated/compiler/compiler.wasm",
  import.meta.url,
);
const preludeSnapshotUrl = new URL(
  "../../generated/compiler/prelude.snapshot",
  import.meta.url,
);
const preludeSourceUrl = new URL("../prelude/prelude.blot", import.meta.url);
const PRELUDE_MODULE_PATH = "blot:prelude";

interface ResidentModule {
  readonly inputRevision: string;
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

interface LoadedRevision {
  readonly revision: string;
}

interface DistributedSnapshot {
  readonly bytes: Uint8Array;
  readonly revision: string;
  readonly source: string;
}

export class Compiler {
  readonly #rust: CompilerWasm;
  readonly #session: number;
  readonly #modules = new Map<string, ResidentModule>();
  readonly #capsules = new Map<
    string,
    { readonly source: string; readonly capsule: ModuleCapsule }
  >();
  readonly #prepared = new Map<string, PreparedRevision>();
  readonly #compiled = new Map<string, CompiledRevision>();
  #preludeSnapshot?: DistributedSnapshot;
  #preludeInstalled = false;
  #destroyed = false;

  private constructor(rust: CompilerWasm) {
    this.#rust = rust;
    this.#session = rust.createCompilerSession();
  }

  static async create(): Promise<Compiler> {
    const wasm = await Deno.readFile(compilerUrl);
    return new Compiler(await CompilerWasm.load(wasm));
  }

  async check(path: string): Promise<CheckedModule> {
    this.#requireActive();
    const absolute = resolve(path);
    await this.#load(absolute, []);
    return this.#checkResidentModule(absolute);
  }

  /** Checks an in-memory revision while resolving its imports from disk. */
  async checkSource(path: string, source: string): Promise<CheckedModule> {
    this.#requireActive();
    const absolute = resolve(path);
    await this.#loadRevision(absolute, source, []);
    return this.#checkResidentModule(absolute);
  }

  #checkResidentModule(path: string): CheckedModule {
    const checked = this.#rust.checkCompilerSessionModule(
      this.#session,
      path,
    );
    if (checked.ok) {
      return { type: checked.type, effects: checked.effects };
    }
    if (checked.diagnostic !== undefined) {
      let origin = checked.diagnostic.origin;
      if (origin === undefined) origin = path;
      const resident = this.#modules.get(origin);
      if (resident === undefined) {
        throw new Error(`${origin}: resident Rust module lost its source`);
      }
      throw new BlotError(
        checked.diagnostic,
        { path: origin, source: resident.source },
      );
    }
    throw new Error(
      `${path}: Rust compiler failed without a diagnostic: ${checked.message}`,
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
        const resident = this.#modules.get(origin);
        if (resident === undefined) {
          throw new Error(`${origin}: resident Rust module lost its source`);
        }
        throw new BlotError(
          prepared.diagnostic,
          { path: origin, source: resident.source },
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

  async compile(path: string): Promise<CompilerArtifact> {
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
        const resident = this.#modules.get(origin);
        if (resident === undefined) {
          throw new Error(`${origin}: resident Rust module lost its source`);
        }
        throw new BlotError(
          compiled.diagnostic,
          { path: origin, source: resident.source },
        );
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
    this.#capsules.clear();
    this.#prepared.clear();
    this.#compiled.clear();
  }

  async #load(
    path: string,
    active: readonly string[],
  ): Promise<LoadedRevision> {
    const source = await Deno.readTextFile(path);
    return await this.#loadRevision(path, source, active);
  }

  async #loadRevision(
    path: string,
    source: string,
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
    let resident = this.#modules.get(path);
    if (resident === undefined || resident.inputRevision !== source) {
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
        inputRevision: source,
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
      const dependency = await this.#loadImport(specifier, path, nextActive);
      imports[specifier] = dependency.path;
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

  async #loadImport(
    specifier: string,
    importer: string,
    active: readonly string[],
  ): Promise<LoadedRevision & { readonly path: string }> {
    if (specifier === PRELUDE_MODULE_PATH) {
      const snapshot = await this.#loadPreludeSnapshot();
      if (!this.#preludeInstalled) {
        this.#rust.installCompilerSessionModuleSnapshot(
          this.#session,
          PRELUDE_MODULE_PATH,
          snapshot.bytes,
        );
        this.#modules.set(PRELUDE_MODULE_PATH, {
          inputRevision: snapshot.revision,
          source: snapshot.source,
          imports: [],
          includes: [],
        });
        this.#preludeInstalled = true;
      }
      return {
        path: PRELUDE_MODULE_PATH,
        revision: snapshot.revision,
      };
    }
    if (!isPackageSpecifier(specifier)) {
      const path = resolvePath(specifier, importer);
      if (path.endsWith(".blotc")) {
        return await this.#loadCapsule(path, active);
      }
      return { path, ...await this.#load(path, active) };
    }
    const exported = await resolvePackageExport(specifier, importer);
    if (exported.built !== undefined) {
      try {
        return await this.#loadCapsule(exported.built, active);
      } catch (error) {
        if (!(error instanceof PackageArtifactError)) throw error;
      }
    }
    try {
      return {
        path: exported.source,
        ...await this.#load(exported.source, active),
      };
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
      throw new PackageArtifactError(
        `could not load Blot package ${
          JSON.stringify(exported.packageName)
        } export ${JSON.stringify(exported.exportName)} from source ${
          JSON.stringify(exported.source)
        }`,
        { cause },
      );
    }
  }

  async #loadPreludeSnapshot(): Promise<DistributedSnapshot> {
    if (this.#preludeSnapshot !== undefined) return this.#preludeSnapshot;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(preludeSnapshotUrl);
    } catch (cause) {
      throw new Error(
        `could not read compiler-distributed module snapshot ${preludeSnapshotUrl}`,
        { cause },
      );
    }
    let source: string;
    try {
      source = await Deno.readTextFile(preludeSourceUrl);
    } catch (cause) {
      throw new Error(
        `could not read compiler-distributed prelude source ${preludeSourceUrl}`,
        { cause },
      );
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(bytes).buffer,
    );
    const hash = Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    this.#preludeSnapshot = {
      bytes,
      revision: `module-snapshot:${hash}`,
      source,
    };
    return this.#preludeSnapshot;
  }

  async #loadCapsule(
    path: string,
    active: readonly string[],
  ): Promise<LoadedRevision & { readonly path: string }> {
    const cycleStart = active.indexOf(path);
    if (cycleStart >= 0) {
      const cycle = [...active.slice(cycleStart), path];
      throw new BlotError({
        code: "BLOT_IMPORT_CYCLE",
        message: `Import cycle: ${cycle.join(" -> ")}.`,
        span: { start: 0, end: 0 },
      });
    }
    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch (cause) {
      throw new PackageArtifactError(
        `could not read Blot module capsule ${JSON.stringify(path)}`,
        { cause },
      );
    }
    const cachedCapsule = this.#capsules.get(path);
    let capsule: ModuleCapsule;
    if (cachedCapsule !== undefined && cachedCapsule.source === source) {
      capsule = cachedCapsule.capsule;
    } else {
      capsule = await decodeModuleCapsuleForRust(source, path);
      this.#capsules.set(path, { source, capsule });
    }
    const modules = new Map(
      capsule.modules.map((module) => [module.id, module]),
    );
    const configured = new Map<
      string,
      LoadedRevision & { readonly path: string }
    >();
    const root = await this.#configureCapsuleModule(
      path,
      capsule,
      modules,
      configured,
      capsule.root,
      [],
      [...active, path],
    );
    return root;
  }

  async #configureCapsuleModule(
    path: string,
    capsule: ModuleCapsule,
    modules: ReadonlyMap<string, CapsuleModule>,
    configured: Map<string, LoadedRevision & { readonly path: string }>,
    identifier: string,
    active: readonly string[],
    importActive: readonly string[],
  ): Promise<LoadedRevision & { readonly path: string }> {
    const cached = configured.get(identifier);
    if (cached !== undefined) return cached;
    const cycleStart = active.indexOf(identifier);
    if (cycleStart >= 0) {
      const cycle = [...active.slice(cycleStart), identifier];
      throw new PackageArtifactError(
        `Blot module capsule ${JSON.stringify(path)} contains import cycle ${
          cycle.join(" -> ")
        }`,
      );
    }
    const encoded = modules.get(identifier);
    if (encoded === undefined) {
      throw new Error(`validated module capsule lost ${identifier}`);
    }
    const modulePath = `${path}#${encoded.name}`;
    const inputRevision = `${capsule.hash}:${identifier}`;
    let resident = this.#modules.get(modulePath);
    if (resident === undefined || resident.inputRevision !== inputRevision) {
      const added = this.#rust.addCompilerSessionAst(
        this.#session,
        modulePath,
        encoded.ast,
      );
      if (!added.ok) {
        if (added.message === undefined) {
          throw new Error(
            `${modulePath}: Rust portable AST loading failed without a message`,
          );
        }
        throw new PackageArtifactError(
          `Blot module capsule ${
            JSON.stringify(path)
          } contains an invalid portable AST for ${
            JSON.stringify(encoded.name)
          }: ${added.message}`,
        );
      }
      resident = {
        inputRevision,
        source: "",
        imports: added.module.imports,
        includes: added.module.includes,
      };
      this.#modules.set(modulePath, resident);
    }
    const sourceImports = [...resident.imports].sort();
    const capsuleImports = encoded.imports.map((imported) => imported.specifier)
      .sort();
    const sourceIncludes = [...resident.includes].sort();
    const capsuleIncludes = encoded.includes.map((included) =>
      included.specifier
    ).sort();
    if (sourceImports.join("\0") !== capsuleImports.join("\0")) {
      throw new PackageArtifactError(
        `Blot module capsule ${JSON.stringify(path)} has import edges for ${
          JSON.stringify(encoded.name)
        } that do not match its source`,
      );
    }
    if (sourceIncludes.join("\0") !== capsuleIncludes.join("\0")) {
      throw new PackageArtifactError(
        `Blot module capsule ${JSON.stringify(path)} has include edges for ${
          JSON.stringify(encoded.name)
        } that do not match its source`,
      );
    }

    const imports: Record<string, string> = {};
    const nextActive = [...active, identifier];
    for (const imported of encoded.imports) {
      let dependency: LoadedRevision & { readonly path: string };
      if (imported.kind === "bundled") {
        dependency = await this.#configureCapsuleModule(
          path,
          capsule,
          modules,
          configured,
          imported.module,
          nextActive,
          importActive,
        );
      } else {
        dependency = await this.#loadImport(
          imported.specifier,
          path,
          importActive,
        );
      }
      imports[imported.specifier] = dependency.path;
    }
    const includes: Record<
      string,
      { readonly path: string; readonly text: string }
    > = {};
    for (const included of encoded.includes) {
      includes[included.specifier] = {
        path: included.path,
        text: included.text,
      };
    }
    const configurationRevision = revision([
      capsule.hash,
      identifier,
      ...Object.entries(imports).flatMap(([specifier, dependency]) => [
        specifier,
        dependency,
      ]),
    ]);
    if (resident.configurationRevision !== configurationRevision) {
      this.#rust.configureCompilerSessionModule(this.#session, modulePath, {
        imports,
        includes,
      });
      resident = { ...resident, configurationRevision };
      this.#modules.set(modulePath, resident);
    }
    const loaded = {
      path: modulePath,
      revision: revision([path, capsule.hash, identifier]),
    };
    configured.set(identifier, loaded);
    return loaded;
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

function loweringError(
  path: string,
  source: string,
  message: string | undefined,
): Error {
  if (message === undefined) {
    return new Error(
      `${path}: Compiler source lowering failed without a diagnostic`,
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
  return new Error(`${path}: Compiler CST lowering failed: ${message}`);
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
