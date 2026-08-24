import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "@std/path";
import { BlotError, type Diagnostic, diagnosticCode } from "../diagnostic.ts";
import {
  type Loaded,
  LoadError,
  PRELUDE,
  type SourceInspection,
} from "../load.ts";
import { WorkspaceGraph } from "../workspace_graph.ts";
import { babaRuntime } from "../syntax/baba_runtime.ts";
import { materializeCpuCst } from "../syntax/cpu_cst.ts";
import {
  compactFieldNames,
  compactNamedTokenKinds,
  compactRepeatedFields,
  compactRuleNames,
} from "../syntax/compact_schema.ts";
import type { Rule } from "../syntax/cursor.ts";
import { elaborateLayout } from "../syntax/layout.ts";
import type { Module } from "../syntax/ast.ts";
import {
  decodePortableModule,
  encodePortableModule,
} from "../syntax/portable.ts";
import type { BlotRuntimeModule } from "../runtime/hir.ts";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "./artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "./host_abi.ts";
import {
  CompilerInvariantFailure,
  CompilerLimitDiagnostic,
  type CompilerTargetPolicy,
  CompilerTargetRefusal,
  resolveTargetPolicy,
} from "./policy.ts";
import {
  type InstalledModuleRevision,
  loadedConfigurationDigest,
  loadedPayloadDigest,
  loadedRevisionKey,
} from "./revision.ts";
import {
  type AddedCompilerModuleResult,
  type CompilerInvalidationTelemetry,
  type CompilerOwnershipFact,
  type CompilerSourceDiagnostic,
  type CompilerSpecializationFact,
  type CompilerSyntaxSnapshot as RustSyntaxSnapshot,
  type CompilerTagFact,
  type CompilerTargetPreflight,
  type CompilerTestOutcome,
  type CompilerTransportFailure,
  type CompilerTypeFact,
  CompilerWasm,
  type CompilerWork,
} from "./wasm.ts";

const bundledCompiler = new URL(
  "../../generated/compiler/compiler.wasm",
  import.meta.url,
);
const bundledCompilerManifest = new URL(
  "../../generated/compiler/compiler-artifact.json",
  import.meta.url,
);
const bundledPreludeSnapshot = new URL(
  "../../generated/compiler/prelude.snapshot",
  import.meta.url,
);

export interface CompilerArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
  readonly artifactSource: "compiled" | "revision-cache";
}

export interface CompilerSyntaxSnapshot {
  readonly module: Module;
  readonly cst: Rule;
  readonly reuse: RustSyntaxSnapshot["reuse"];
  readonly parserExecuted: boolean;
  readonly portableAstDigest: string;
}

export interface CheckedModule {
  readonly type: string;
  readonly effects: string;
}

export interface EvaluatedModule {
  readonly value: unknown;
  readonly display: string;
  readonly writes: readonly string[];
}

export interface CompilerAnalysis extends CheckedModule {
  readonly types: readonly CompilerTypeFact[];
  readonly tags: readonly CompilerTagFact[];
  readonly ownership: readonly CompilerOwnershipFact[];
  readonly specializations: readonly CompilerSpecializationFact[];
  readonly work: CompilerWork | null;
  readonly invalidation: CompilerInvalidationTelemetry;
  readonly targetPreflight: CompilerTargetPreflight;
}

export interface CompilerExplanation {
  readonly kind: "type" | "ownership" | "specialization" | "target";
  readonly span: { readonly start: number; readonly end: number };
  readonly summary: string;
  readonly reasons: readonly string[];
}

export interface CompilerOptions {
  readonly wasm?: Uint8Array;
  readonly preludeSnapshot?: Uint8Array;
  readonly targetPolicy?: CompilerTargetPolicy;
}

export interface CompilerHost {
  check(path: string): Promise<CheckedModule>;
  checkSource(path: string, source: string): Promise<CheckedModule>;
  analyze(path: string): Promise<CompilerAnalysis>;
  analyzeSource(path: string, source: string): Promise<CompilerAnalysis>;
  explain(path: string, offset: number): Promise<CompilerExplanation | null>;
  evaluate(path: string): Promise<EvaluatedModule>;
  test(path: string): Promise<readonly CompilerTestOutcome[]>;
  portableAst(path: string): Promise<string>;
  portableGraph(path: string): Promise<ReadonlyMap<string, string>>;
  syntaxSnapshot(path: string, source: string): Promise<CompilerSyntaxSnapshot>;
  prepare(path: string): Promise<BlotRuntimeModule>;
  compile(path: string): Promise<CompilerArtifact>;
  destroy(): void;
}

interface ResidentRevision {
  readonly key: string;
  hir?: BlotRuntimeModule;
  artifact?: CompilerArtifact;
}

type AddedCompilerModule = Extract<
  AddedCompilerModuleResult,
  { readonly ok: true }
>["module"];

interface InspectedSource {
  readonly source: string;
  readonly module: AddedCompilerModule;
}

/** The sole high-level host for Blot's Rust/Wasm semantic compiler. */
export class Compiler implements CompilerHost {
  readonly #compiler: CompilerWasm;
  readonly #preludeSnapshot: Uint8Array;
  readonly #handle: number;
  readonly #revisions = new Map<string, ResidentRevision>();
  readonly #sources = new Map<string, string>();
  readonly #installedModules = new Map<string, InstalledModuleRevision>();
  readonly #inspectedSources = new Map<string, InspectedSource>();
  readonly #workspace: WorkspaceGraph;
  #preludeInstalled = false;
  #requests: Promise<void> = Promise.resolve();
  #destroyed = false;

  private constructor(compiler: CompilerWasm, preludeSnapshot: Uint8Array) {
    this.#compiler = compiler;
    this.#preludeSnapshot = preludeSnapshot.slice();
    this.#handle = compiler.createCompilerSession();
    this.#workspace = new WorkspaceGraph((path, source) =>
      this.#inspectSource(path, source)
    );
  }

  static async create(options: CompilerOptions = {}): Promise<Compiler> {
    resolveTargetPolicy(options.targetPolicy);
    let wasm = options.wasm;
    let preludeSnapshot = options.preludeSnapshot;
    if (wasm === undefined) {
      try {
        const [compilerBytes, manifestSource, prelude] = await Promise.all([
          readFile(bundledCompiler),
          readFile(bundledCompilerManifest, "utf8"),
          readFile(bundledPreludeSnapshot),
        ]);
        const manifest = decodeCompilerArtifactManifest(manifestSource);
        await validateCompilerArtifact(compilerBytes, manifest, {
          hostAbi: COMPILER_HOST_ABI_VERSION,
          preludeSha256: await sha256(prelude),
        });
        wasm = compilerBytes;
        preludeSnapshot = prelude;
      } catch (error) {
        throw new CompilerInvariantFailure(
          "compiler artifact loading",
          new Error(
            "the generated compiler bundle is missing or incompatible; run `pnpm compiler:build` or `pnpm compiler:download`",
            { cause: error },
          ),
        );
      }
    }
    if (preludeSnapshot === undefined) {
      throw new CompilerInvariantFailure(
        "compiler initialization",
        new Error(
          "a custom compiler Wasm requires its matching prelude snapshot",
        ),
      );
    }
    try {
      return new Compiler(
        await CompilerWasm.load(wasm),
        preludeSnapshot,
      );
    } catch (error) {
      throw new CompilerInvariantFailure("compiler initialization", error);
    }
  }

  async check(path: string): Promise<CheckedModule> {
    return await this.#request(async () => {
      const absolute = resolve(path);
      await this.#sync(absolute);
      return this.#checkResident(absolute);
    });
  }

  async checkSource(path: string, source: string): Promise<CheckedModule> {
    return await this.#request(async () => {
      const root = await this.#workspace.updateOverlay(resolve(path), source);
      await this.#syncLoaded(root);
      return this.#checkResident(root.path);
    });
  }

  async analyze(path: string): Promise<CompilerAnalysis> {
    return await this.#request(async () => {
      const absolute = resolve(path);
      await this.#sync(absolute);
      return this.#analyzeResident(absolute);
    });
  }

  async analyzeSource(path: string, source: string): Promise<CompilerAnalysis> {
    return await this.#request(async () => {
      const root = await this.#workspace.updateOverlay(resolve(path), source);
      await this.#syncLoaded(root);
      return this.#analyzeResident(root.path);
    });
  }

  async explain(
    path: string,
    offset: number,
  ): Promise<CompilerExplanation | null> {
    const analysis = await this.analyze(path);
    return explanationAt(analysis, offset);
  }

  async evaluate(path: string): Promise<EvaluatedModule> {
    return await this.#request(async () => {
      const absolute = resolve(path);
      await this.#sync(absolute);
      const result = this.#compiler.evaluateCompilerSessionModule(
        this.#handle,
        absolute,
      );
      if (!result.ok) this.#throwFailure(result, absolute, "evaluation");
      return {
        value: result.value,
        display: result.display,
        writes: result.writes.slice(),
      };
    });
  }

  async portableAst(path: string): Promise<string> {
    return await this.#request(async () => {
      const absolute = resolve(path);
      await this.#sync(absolute);
      const result = this.#compiler.exportCompilerSessionModuleAst(
        this.#handle,
        absolute,
      );
      if (!result.ok) {
        this.#throwFailure(result, absolute, "portable AST export");
      }
      return result.ast;
    });
  }

  async portableGraph(path: string): Promise<ReadonlyMap<string, string>> {
    return await this.#request(async () => {
      const root = await this.#workspace.refresh(resolve(path));
      await this.#syncLoaded(root);
      const modules = new Map<string, string>();
      for (const modulePath of collectGraph(root).keys()) {
        const result = this.#compiler.exportCompilerSessionModuleAst(
          this.#handle,
          modulePath,
        );
        if (!result.ok) {
          this.#throwFailure(result, modulePath, "portable AST export");
        }
        modules.set(modulePath, result.ast);
      }
      return modules;
    });
  }

  async syntaxSnapshot(
    path: string,
    source: string,
  ): Promise<CompilerSyntaxSnapshot> {
    return await this.#request(async () => {
      const root = await this.#workspace.updateOverlay(resolve(path), source);
      this.#syncLoaded(root);
      const inspected = this.#inspectedSources.get(root.path);
      const snapshot = inspected?.module.syntaxSnapshot;
      if (
        inspected === undefined || snapshot === undefined || snapshot === null
      ) {
        throw new CompilerInvariantFailure(
          "canonical syntax snapshot",
          new Error(
            `Rust frontend omitted the syntax snapshot for ${root.path}`,
          ),
        );
      }
      const exported = this.#compiler.exportCompilerSessionModuleAst(
        this.#handle,
        root.path,
      );
      if (!exported.ok) {
        this.#throwFailure(exported, root.path, "portable AST export");
      }
      const layout = await elaborateLayout(source);
      if (!layout.ok) {
        throw new CompilerInvariantFailure(
          "canonical syntax snapshot",
          new Error(
            "Rust accepted source that the shared layout pass rejected",
          ),
        );
      }
      const frontend = await babaRuntime();
      const cst = materializeCpuCst(
        frontend.cpuParser,
        {
          tokens: Int32Array.from(snapshot.tokens),
          nodes: Int32Array.from(snapshot.nodes),
          edges: Int32Array.from(snapshot.edges),
          symbols: new Int32Array(),
          types: new Int32Array(),
        },
        layout.layout.source,
        layout.layout.originalOffset,
        {
          ruleNames: compactRuleNames,
          fieldNames: compactFieldNames,
          namedTokenKinds: compactNamedTokenKinds,
          repeatedFields: compactRepeatedFields,
        },
      );
      return {
        module: decodePortableModule(
          JSON.parse(exported.ast),
          `${root.path} Rust syntax snapshot`,
        ),
        cst,
        reuse: snapshot.reuse.slice(),
        parserExecuted: snapshot.parserExecuted,
        portableAstDigest: inspected.module.portableAstDigest,
      };
    });
  }

  async test(path: string): Promise<readonly CompilerTestOutcome[]> {
    return await this.#request(async () => {
      const absolute = resolve(path);
      await this.#sync(absolute);
      const result = this.#compiler.testCompilerSessionModule(
        this.#handle,
        absolute,
      );
      if (!result.ok) this.#throwFailure(result, absolute, "test execution");
      return result.outcomes.slice();
    });
  }

  async prepare(path: string): Promise<BlotRuntimeModule> {
    return await this.#request(async () => {
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
    });
  }

  async compile(path: string): Promise<CompilerArtifact> {
    return await this.#request(async () => {
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
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#compiler.destroyCompilerSession(this.#handle);
  }

  async #request<T>(operation: () => Promise<T>): Promise<T> {
    this.#requireActive();
    const result = this.#requests.then(operation);
    this.#requests = result.then(
      () => {},
      () => {},
    );
    return await result;
  }

  async #sync(path: string): Promise<ResidentRevision> {
    return await this.#syncLoaded(await this.#workspace.refresh(path));
  }

  #syncLoaded(root: Loaded): ResidentRevision {
    const key = loadedRevisionKey(root);
    const resident = this.#revisions.get(root.path);
    if (resident !== undefined && resident.key === key) return resident;

    const modules = collectGraph(root);
    const activePaths = this.#workspace.activePaths();
    const removedPaths = [...this.#installedModules.keys()].filter((path) =>
      !activePaths.has(path)
    );
    for (const path of removedPaths) {
      this.#compiler.removeCompilerSessionModule(this.#handle, path);
      this.#installedModules.delete(path);
      this.#inspectedSources.delete(path);
      this.#sources.delete(path);
      this.#revisions.delete(path);
    }
    for (const loaded of modules.values()) {
      this.#sources.set(loaded.path, loaded.source);
      if (loaded.path === PRELUDE) {
        if (
          loaded.dependencies.size > 0 || loaded.includedFiles.size > 0
        ) {
          throw new CompilerInvariantFailure(
            "prelude snapshot installation",
            new Error("the distributed prelude must remain dependency-free"),
          );
        }
        if (!this.#preludeInstalled) {
          try {
            this.#compiler.installCompilerSessionModuleSnapshot(
              this.#handle,
              loaded.path,
              this.#preludeSnapshot,
            );
          } catch (error) {
            throw new CompilerInvariantFailure(
              "prelude snapshot installation",
              error,
            );
          }
          this.#preludeInstalled = true;
        }
        continue;
      }
      const payloadDigest = loadedPayloadDigest(loaded);
      let storage: "source" | "ast";
      if (loaded.storage.tag === "source") {
        storage = "source";
      } else {
        storage = "ast";
      }
      const installed = this.#installedModules.get(loaded.path);
      if (
        installed !== undefined && installed.payloadDigest === payloadDigest &&
        installed.storage === storage
      ) {
        continue;
      }
      let added;
      if (loaded.storage.tag === "source") {
        const inspected = this.#inspectedSources.get(loaded.path);
        if (inspected !== undefined && inspected.source === loaded.source) {
          added = { ok: true as const, module: inspected.module };
        } else {
          added = this.#compiler.addCompilerSessionModule(
            this.#handle,
            loaded.path,
            loaded.source,
          );
        }
      } else {
        added = this.#compiler.addCompilerSessionAst(
          this.#handle,
          loaded.path,
          JSON.stringify(encodePortableModule(loaded.module)),
        );
      }
      if (!added.ok) this.#throwLoadFailure(added, loaded);
      requireSameDependencies(
        loaded.path,
        "imports",
        added.module.imports,
        loaded.dependencies.keys(),
      );
      requireSameDependencies(
        loaded.path,
        "includes",
        added.module.includes,
        loaded.includedFiles.keys(),
      );
      let previousConfigurationDigest = "";
      if (installed !== undefined) {
        previousConfigurationDigest = installed.configurationDigest;
      }
      this.#installedModules.set(loaded.path, {
        payloadDigest,
        configurationDigest: previousConfigurationDigest,
        storage,
      });
    }
    const configurationDeltas: Array<{
      readonly loaded: Loaded;
      readonly installed: InstalledModuleRevision;
      readonly configurationDigest: string;
      readonly configuration: {
        readonly imports: Readonly<Record<string, string>>;
        readonly includes: Readonly<
          Record<string, { readonly path: string; readonly text: string }>
        >;
      };
    }> = [];
    for (const loaded of modules.values()) {
      if (loaded.path === PRELUDE) continue;
      const installed = this.#installedModules.get(loaded.path);
      if (installed === undefined) {
        throw new CompilerInvariantFailure(
          "compiler source-graph configuration",
          new Error(`module ${loaded.path} was not installed`),
        );
      }
      const configurationDigest = loadedConfigurationDigest(loaded);
      if (installed.configurationDigest === configurationDigest) continue;
      configurationDeltas.push({
        loaded,
        installed,
        configurationDigest,
        configuration: {
          imports: Object.fromEntries(
            [...loaded.dependencies].map(([specifier, dependency]) => [
              specifier,
              dependency.path,
            ]),
          ),
          includes: Object.fromEntries(
            [...loaded.includedFiles].map(([specifier, included]) => [
              specifier,
              {
                path: includePath(loaded, included.path),
                text: included.source,
              },
            ]),
          ),
        },
      });
    }
    let configurationResults;
    try {
      configurationResults = this.#compiler.applyCompilerSessionDelta(
        this.#handle,
        configurationDeltas.map((delta) => ({
          path: delta.loaded.path,
          payload: { tag: "none" as const },
          configuration: delta.configuration,
        })),
      );
    } catch (error) {
      throw new CompilerInvariantFailure(
        "compiler source-graph configuration",
        error,
      );
    }
    for (const [index, delta] of configurationDeltas.entries()) {
      const result = configurationResults[index];
      if (result === undefined || !result.ok) {
        throw new CompilerInvariantFailure(
          "compiler source-graph configuration",
          new Error(`compiler rejected graph delta for ${delta.loaded.path}`),
        );
      }
      this.#installedModules.set(delta.loaded.path, {
        ...delta.installed,
        configurationDigest: delta.configurationDigest,
      });
    }

    const revision: ResidentRevision = { key };
    this.#revisions.set(root.path, revision);
    return revision;
  }

  #checkResident(path: string): CheckedModule {
    const result = this.#compiler.checkCompilerSessionModule(
      this.#handle,
      path,
    );
    if (!result.ok) this.#throwFailure(result, path, "checking");
    return { type: result.type, effects: result.effects };
  }

  #analyzeResident(path: string): CompilerAnalysis {
    const result = this.#compiler.analyzeCompilerSessionModule(
      this.#handle,
      path,
    );
    if (!result.ok) this.#throwFailure(result, path, "analysis");
    return {
      type: result.type,
      effects: result.effects,
      types: result.types.slice(),
      tags: result.tags.slice(),
      ownership: result.ownership.slice(),
      specializations: result.specializations.slice(),
      work: result.work,
      invalidation: result.invalidation,
      targetPreflight: result.targetPreflight,
    };
  }

  #throwLoadFailure(
    failure: CompilerTransportFailure,
    loaded: Loaded,
  ): never {
    this.#throwSourceLoadFailure(failure, loaded.path, loaded.source);
  }

  #throwSourceLoadFailure(
    failure: CompilerTransportFailure,
    path: string,
    source: string,
  ): never {
    if (failure.diagnostics !== undefined) {
      throw new LoadError(
        path,
        source,
        failure.diagnostics.map(sourceDiagnostic),
      );
    }
    if (failure.diagnostic !== undefined) {
      throw new LoadError(
        path,
        source,
        [sourceDiagnostic(failure.diagnostic)],
      );
    }
    this.#throwFailure(failure, path, "source-graph loading");
  }

  #inspectSource(path: string, source: string): SourceInspection | undefined {
    if (path === PRELUDE) return undefined;
    this.#sources.set(path, source);
    const added = this.#compiler.addCompilerSessionModule(
      this.#handle,
      path,
      source,
    );
    if (!added.ok) this.#throwSourceLoadFailure(added, path, source);
    this.#inspectedSources.set(path, { source, module: added.module });
    return {
      imports: added.module.importSites,
      includes: added.module.includeSites,
      moduleHandle: added.module.moduleHandle,
      portableAstDigest: added.module.portableAstDigest,
    };
  }

  #throwFailure(
    failure: CompilerTransportFailure,
    fallbackPath: string,
    phase: string,
  ): never {
    if (failure.limitDiagnostic !== undefined) {
      throw new CompilerLimitDiagnostic(
        failure.limitDiagnostic.code,
        failure.limitDiagnostic.message,
      );
    }
    if (failure.targetRefusal !== undefined) {
      throw new CompilerTargetRefusal(
        failure.targetRefusal.message,
        failure.targetRefusal.code,
      );
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
          "compiler diagnostic transport",
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
      `compiler ${phase} transport`,
      new Error(message),
    );
  }

  #requireActive(): void {
    if (this.#destroyed) throw new Error("Compiler session has been destroyed");
  }
}

let sharedCompiler: Promise<Compiler> | undefined;

function includePath(loaded: Loaded, path: string): string {
  if (loaded.storage.tag === "capsule") return path;
  let result = relative(dirname(loaded.path), path).replaceAll("\\", "/");
  if (!result.startsWith(".")) result = `./${result}`;
  return result;
}

export async function prepareRuntimeHir(
  path: string,
): Promise<BlotRuntimeModule> {
  if (sharedCompiler === undefined) sharedCompiler = Compiler.create();
  return await (await sharedCompiler).prepare(path);
}

export async function compileArtifact(path: string): Promise<CompilerArtifact> {
  if (sharedCompiler === undefined) sharedCompiler = Compiler.create();
  return await (await sharedCompiler).compile(path);
}

function sourceDiagnostic(diagnostic: CompilerSourceDiagnostic): Diagnostic {
  return {
    code: diagnosticCode(diagnostic.code),
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

function requireSameDependencies(
  path: string,
  kind: "imports" | "includes",
  compilerDependencies: readonly string[],
  resolvedDependencies: Iterable<string>,
): void {
  const compiler = [...new Set(compilerDependencies)].sort();
  const resolved = [...new Set(resolvedDependencies)].sort();
  if (compiler.join("\0") === resolved.join("\0")) return;
  throw new CompilerInvariantFailure(
    "source-graph agreement",
    new Error(
      `${path} ${kind} differ: compiler [${compiler.join(", ")}], host [${
        resolved.join(", ")
      }]`,
    ),
  );
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

export function explanationAt(
  analysis: CompilerAnalysis,
  offset: number,
): CompilerExplanation | null {
  const specialization = analysis.specializations
    .filter((fact) => containsOffset(fact.binding.span, offset))
    .sort((left, right) =>
      spanWidth(left.binding.span) - spanWidth(right.binding.span)
    )[0];
  if (specialization !== undefined) {
    let name = "binding";
    if (specialization.binding.name !== null) {
      name = specialization.binding.name;
    }
    return {
      kind: "specialization",
      span: specialization.binding.span,
      summary:
        `${name} has ${specialization.specializationCount} runtime representations.`,
      reasons: specialization.keys.map((key) =>
        `${key.reason}: ${key.representation}`
      ),
    };
  }
  const ownership = analysis.ownership
    .filter((fact) => containsOffset(fact.span, offset))
    .sort((left, right) => spanWidth(left.span) - spanWidth(right.span))[0];
  if (ownership !== undefined) {
    let state = "available";
    if (ownership.spent) state = "consumed";
    const reasons = [`${ownership.name} is ${state} at the end of its scope.`];
    if (ownership.last_use !== null) {
      reasons.push(
        `Its last recorded use is [${ownership.last_use.start}, ${ownership.last_use.end}).`,
      );
    }
    return {
      kind: "ownership",
      span: ownership.span,
      summary: `${ownership.name} is ${state}.`,
      reasons,
    };
  }
  const type = analysis.types
    .filter((fact) => containsOffset(fact.span, offset))
    .sort((left, right) => spanWidth(left.span) - spanWidth(right.span))[0];
  if (type !== undefined) {
    return {
      kind: "type",
      span: type.span,
      summary: `The inferred type is ${type.type}.`,
      reasons: [
        "The Rust checker derived this fact from the expression's source constraints and expected type.",
      ],
    };
  }
  if (!analysis.targetPreflight.supported) {
    const reasons = analysis.targetPreflight.alternatives.slice();
    let summary = "The selected target cannot represent this public value.";
    if (analysis.targetPreflight.unsupportedComponent !== null) {
      summary = analysis.targetPreflight.unsupportedComponent;
    }
    return {
      kind: "target",
      span: { start: 0, end: 0 },
      summary,
      reasons,
    };
  }
  return null;
}

function containsOffset(
  span: { readonly start: number; readonly end: number },
  offset: number,
): boolean {
  return offset >= span.start && offset <= span.end;
}

function spanWidth(
  span: { readonly start: number; readonly end: number },
): number {
  return span.end - span.start;
}
