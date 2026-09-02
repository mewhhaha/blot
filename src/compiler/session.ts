import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "@std/path";
import { BlotError, type Diagnostic, diagnosticCode } from "../diagnostic.ts";
import { developmentRevision } from "../development_identity.ts";
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
  verifyCompilerArtifactIntegrity,
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
  type CompilerReadabilityFact,
  type CompilerSimplificationFact,
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

interface BundledCompilerDistribution {
  readonly module: WebAssembly.Module;
  readonly preludeSnapshot: Uint8Array;
  readonly preludeSnapshotDigest: string;
}

let bundledCompilerDistribution:
  | Promise<BundledCompilerDistribution>
  | undefined;

export interface CompilerArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
  readonly artifactSource: "compiled" | "revision-cache";
}

export interface DevelopmentCompilationRequest {
  readonly entryPath: string;
  readonly entryUnit: string;
  readonly units: ReadonlyMap<string, string>;
}

export interface DevelopmentEdge {
  readonly consumer: string;
  readonly provider: string;
  readonly name: string;
}

export interface DevelopmentMemoryCheckpoint {
  readonly stage: string;
  readonly pages: number;
  readonly solver?: {
    readonly variables: number;
    readonly constraintTypeNodes: number;
    readonly constraintTypeInterned: number;
    readonly settledVariables: number;
    readonly residualVariables: number;
  };
}

export interface DevelopmentMemoryProfile {
  readonly checkpoints: readonly DevelopmentMemoryCheckpoint[];
}

export interface DevelopmentUnitIdentity {
  readonly name: string;
  readonly root: string;
  readonly capabilities: readonly string[];
  readonly interfaceDigest: string;
  readonly implementationDigest: string;
  readonly wasmDigest: string;
}

export interface DevelopmentUnitArtifact extends DevelopmentUnitIdentity {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly artifactSource: "compiled" | "unit-cache";
}

export type DevelopmentCompilationUnit =
  | (DevelopmentUnitArtifact & { readonly artifactSource: "compiled" })
  | (DevelopmentUnitIdentity & { readonly artifactSource: "unit-cache" });

export interface DevelopmentCompilation {
  readonly revision: string;
  readonly entryUnit: string;
  readonly units: readonly DevelopmentCompilationUnit[];
  readonly edges: readonly DevelopmentEdge[];
  readonly developmentProfile?: DevelopmentMemoryProfile;
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
  readonly simplifications: readonly CompilerSimplificationFact[];
  readonly readability: readonly CompilerReadabilityFact[];
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
  /** A custom compiler/snapshot pair is trusted as one caller-owned distribution. */
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
  compileDevelopment(
    request: DevelopmentCompilationRequest,
  ): Promise<DevelopmentCompilation>;
  setOverlay(path: string, source: string, version?: number): Promise<void>;
  clearOverlay(path: string): Promise<void>;
  releaseRoot(path: string): Promise<void>;
  markChanged(path: string): Promise<void>;
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
  readonly #handle: number;
  readonly #inspectionHandle: number;
  readonly #revisions = new Map<string, ResidentRevision>();
  readonly #sources = new Map<string, string>();
  readonly #installedModules = new Map<string, InstalledModuleRevision>();
  readonly #inspectedSources = new Map<string, InspectedSource>();
  readonly #developmentArtifacts = new Map<
    string,
    Map<string, DevelopmentUnitIdentity>
  >();
  readonly #workspace: WorkspaceGraph;
  #inspectionCandidate: Map<string, InspectedSource> | undefined;
  #requests: Promise<void> = Promise.resolve();
  #developmentChangesKnown = false;
  #destroyed = false;

  private constructor(
    compiler: CompilerWasm,
    preludeSnapshot: Uint8Array,
    preludeSnapshotDigest: string,
  ) {
    this.#compiler = compiler;
    this.#handle = compiler.createCompilerSession();
    this.#inspectionHandle = compiler.createCompilerSession();
    const sessionHandle = this.#handle;
    compiler.installCompilerSessionTrustedModuleSnapshot(
      this.#handle,
      PRELUDE,
      preludeSnapshot,
    );
    let decodedPrelude: Module | undefined;
    const prelude: Loaded = {
      get module(): Module {
        if (decodedPrelude !== undefined) return decodedPrelude;
        const exportedPrelude = compiler.exportCompilerSessionModuleAst(
          sessionHandle,
          PRELUDE,
        );
        if (!exportedPrelude.ok) {
          throw new Error(
            "installed prelude snapshot omitted its portable AST",
          );
        }
        decodedPrelude = decodePortableModule(
          JSON.parse(exportedPrelude.ast),
          "distributed prelude snapshot",
        );
        return decodedPrelude;
      },
      dependencies: new Map(),
      includedFiles: new Map(),
      source: "",
      path: PRELUDE,
      storage: { tag: "snapshot", digest: preludeSnapshotDigest },
    };
    this.#workspace = new WorkspaceGraph(
      (path, source) => this.#inspectSource(path, source),
      [prelude],
    );
  }

  static async create(options: CompilerOptions = {}): Promise<Compiler> {
    resolveTargetPolicy(options.targetPolicy);
    const wasm = options.wasm;
    let preludeSnapshot = options.preludeSnapshot;
    let preludeSnapshotDigest: string | undefined;
    let compilerModule: WebAssembly.Module | undefined;
    if (wasm === undefined) {
      if (bundledCompilerDistribution === undefined) {
        bundledCompilerDistribution = (async () => {
          const [compilerBytes, manifestSource, prelude] = await Promise.all([
            readFile(bundledCompiler),
            readFile(bundledCompilerManifest, "utf8"),
            readFile(bundledPreludeSnapshot),
          ]);
          const manifest = decodeCompilerArtifactManifest(manifestSource);
          const digest = await sha256(prelude);
          const compilation = CompilerWasm.compile(compilerBytes);
          const validation = verifyCompilerArtifactIntegrity(
            compilerBytes,
            manifest,
            {
              hostAbi: COMPILER_HOST_ABI_VERSION,
              preludeSha256: digest,
              profile: "production",
            },
          );
          const [, module] = await Promise.all([validation, compilation]);
          return {
            module,
            preludeSnapshot: prelude,
            preludeSnapshotDigest: digest,
          };
        })();
      }
      try {
        const distribution = await bundledCompilerDistribution;
        compilerModule = distribution.module;
        preludeSnapshot = distribution.preludeSnapshot;
        preludeSnapshotDigest = distribution.preludeSnapshotDigest;
      } catch (error) {
        bundledCompilerDistribution = undefined;
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
    if (preludeSnapshotDigest === undefined) {
      preludeSnapshotDigest = await sha256(preludeSnapshot);
    }
    try {
      let compiler: CompilerWasm;
      if (compilerModule !== undefined) {
        compiler = await CompilerWasm.instantiate(compilerModule);
      } else if (wasm !== undefined) {
        compiler = await CompilerWasm.load(wasm);
      } else {
        throw new Error("compiler distribution omitted its Wasm module");
      }
      return new Compiler(
        compiler,
        preludeSnapshot,
        preludeSnapshotDigest,
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
      const absolute = resolve(path);
      const root = await this.#loadWorkspaceRevision(
        () => this.#workspace.updateOverlay(absolute, source),
      );
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
      const absolute = resolve(path);
      const root = await this.#loadWorkspaceRevision(
        () => this.#workspace.updateOverlay(absolute, source),
      );
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
      const root = await this.#loadWorkspaceRevision(
        () => this.#workspace.refresh(resolve(path)),
      );
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
      const absolute = resolve(path);
      const root = await this.#loadWorkspaceRevision(
        () => this.#workspace.updateOverlay(absolute, source),
      );
      this.#syncLoaded(root);
      const inspected = this.#inspectedSources.get(root.path);
      if (inspected === undefined || inspected.source !== root.source) {
        throw new CompilerInvariantFailure(
          "canonical syntax snapshot",
          new Error(`Rust frontend omitted the source state for ${root.path}`),
        );
      }
      const snapshotResult = this.#compiler.compilerSessionSyntaxSnapshot(
        this.#inspectionHandle,
        root.path,
      );
      if (!snapshotResult.ok) {
        this.#throwFailure(
          snapshotResult,
          root.path,
          "canonical syntax snapshot",
        );
      }
      const snapshot = snapshotResult.syntaxSnapshot;
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

  async compileDevelopment(
    request: DevelopmentCompilationRequest,
  ): Promise<DevelopmentCompilation> {
    return await this.#request(async () => {
      const entryPath = resolve(request.entryPath);
      const unitRoots = new Map(
        [...request.units].map(([name, root]) =>
          [name, resolve(root)] as const
        ),
      );
      let loaded: Loaded;
      if (this.#developmentChangesKnown) {
        loaded = await this.#loadWorkspaceRevision(
          () => this.#workspace.refreshAfterKnownChanges(entryPath),
        );
        this.#developmentChangesKnown = false;
      } else {
        loaded = await this.#loadWorkspaceRevision(
          () => this.#workspace.refresh(entryPath),
        );
      }
      this.#syncLoaded(loaded);
      const graph = collectGraph(loaded);
      for (const [name, root] of unitRoots) {
        if (graph.has(root)) continue;
        throw new Error(
          `development unit ${JSON.stringify(name)} root ${
            JSON.stringify(root)
          } is not reachable from ${JSON.stringify(entryPath)}`,
        );
      }
      const result = this.#compiler.compileCompilerSessionDevelopmentProgram(
        this.#handle,
        entryPath,
        request.entryUnit,
        unitRoots,
      );
      if (!result.ok) {
        this.#throwFailure(result, entryPath, "development backend emission");
      }
      let residentArtifacts = this.#developmentArtifacts.get(entryPath);
      if (residentArtifacts === undefined) {
        residentArtifacts = new Map<string, DevelopmentUnitIdentity>();
      }
      const nextResidentArtifacts = new Map<
        string,
        DevelopmentUnitIdentity
      >();
      const artifacts: DevelopmentCompilationUnit[] = await Promise.all(
        result.units.map(async (unit) => {
          if (unit.artifactSource === "unit-cache") {
            const retained = residentArtifacts.get(unit.name);
            if (
              retained === undefined ||
              retained.root !== unit.root ||
              retained.implementationDigest !== unit.implementationKey ||
              !sameStrings(retained.capabilities, unit.capabilities)
            ) {
              throw new CompilerInvariantFailure(
                "development backend emission",
                `compiler retained development unit ${
                  JSON.stringify(unit.name)
                } without the matching host artifact`,
              );
            }
            nextResidentArtifacts.set(unit.name, retained);
            return {
              name: retained.name,
              root: retained.root,
              capabilities: retained.capabilities.slice(),
              interfaceDigest: retained.interfaceDigest,
              implementationDigest: retained.implementationDigest,
              wasmDigest: retained.wasmDigest,
              artifactSource: unit.artifactSource,
            };
          }
          const [interfaceDigest, wasmDigest] = await Promise.all([
            sha256(unit.manifestBytes),
            sha256(unit.wasm),
          ]);
          const identity: DevelopmentUnitIdentity = {
            name: unit.name,
            root: unit.root,
            capabilities: unit.capabilities.slice(),
            interfaceDigest,
            implementationDigest: unit.implementationKey,
            wasmDigest,
          };
          nextResidentArtifacts.set(unit.name, {
            ...identity,
            capabilities: unit.capabilities.slice(),
          });
          return {
            ...identity,
            wasm: unit.wasm,
            manifestBytes: unit.manifestBytes,
            artifactSource: unit.artifactSource,
          };
        }),
      );
      const revision = await developmentRevision(result.entryUnit, artifacts);
      const edges = result.edges.map((edge) => ({ ...edge }));
      try {
        this.#compiler.commitCompilerSessionDevelopmentProgram(
          this.#handle,
          result.transactionId,
        );
      } catch (error) {
        throw new CompilerInvariantFailure(
          "development artifact commit",
          error,
        );
      }
      this.#developmentArtifacts.set(entryPath, nextResidentArtifacts);
      return {
        revision,
        entryUnit: result.entryUnit,
        units: artifacts,
        edges,
        developmentProfile: result.developmentProfile,
      };
    });
  }

  async setOverlay(
    path: string,
    source: string,
    version?: number,
  ): Promise<void> {
    await this.#request(async () => {
      const absolute = resolve(path);
      this.#syncLoaded(
        await this.#loadWorkspaceRevision(
          () => this.#workspace.updateOverlay(absolute, source, version),
        ),
      );
    });
  }

  async markChanged(path: string): Promise<void> {
    await this.#request(() => {
      this.#workspace.markDirty(path);
      this.#developmentChangesKnown = true;
    });
  }

  async clearOverlay(path: string): Promise<void> {
    await this.#request(async () => {
      const absolute = resolve(path);
      const roots = await this.#loadWorkspaceRevision(
        () => this.#workspace.closeOverlay(absolute),
      );
      for (const root of roots) this.#syncLoaded(root);
      this.#removeInactiveModules();
    });
  }

  async releaseRoot(path: string): Promise<void> {
    await this.#request(() => {
      this.#workspace.releaseRoot(resolve(path));
      this.#removeInactiveModules();
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    try {
      this.#compiler.destroyCompilerSession(this.#inspectionHandle);
    } catch (error) {
      throw new CompilerInvariantFailure(
        "syntax-inspection session teardown",
        error,
      );
    }
    try {
      this.#compiler.destroyCompilerSession(this.#handle);
    } catch (error) {
      throw new CompilerInvariantFailure("semantic session teardown", error);
    }
  }

  async #request<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#requireActive();
    const result = this.#requests.then(operation);
    this.#requests = result.then(
      () => {},
      () => {},
    );
    return await result;
  }

  async #loadWorkspaceRevision<Revision>(
    loadRevision: () => Promise<Revision>,
  ): Promise<Revision> {
    if (this.#inspectionCandidate !== undefined) {
      throw new CompilerInvariantFailure(
        "source inspection",
        new Error("workspace source inspection cannot be nested"),
      );
    }
    const candidate = new Map<string, InspectedSource>();
    this.#inspectionCandidate = candidate;
    try {
      const loaded = await loadRevision();
      for (const [path, inspected] of candidate) {
        this.#inspectedSources.set(path, inspected);
      }
      return loaded;
    } catch (error) {
      for (const [path, inspected] of candidate) {
        const committed = this.#inspectedSources.get(path);
        if (committed?.source === inspected.source) continue;
        this.#compiler.removeCompilerSessionModule(
          this.#inspectionHandle,
          path,
        );
      }
      throw error;
    } finally {
      this.#inspectionCandidate = undefined;
    }
  }

  async #sync(path: string): Promise<ResidentRevision> {
    const loaded = await this.#loadWorkspaceRevision(
      () => this.#workspace.refresh(path),
    );
    return await this.#syncLoaded(loaded);
  }

  #syncLoaded(root: Loaded): ResidentRevision {
    this.#removeInactiveModules();
    const key = loadedRevisionKey(root);
    const resident = this.#revisions.get(root.path);
    if (resident !== undefined && resident.key === key) return resident;

    const modules = collectGraph(root);
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
        if (inspected === undefined || inspected.source !== loaded.source) {
          throw new CompilerInvariantFailure(
            "compiler source-graph installation",
            new Error(`source module ${loaded.path} was not inspected`),
          );
        }
        added = this.#compiler.shareCompilerSessionModule(
          this.#inspectionHandle,
          this.#handle,
          loaded.path,
        );
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

  #removeInactiveModules(): void {
    const activePaths = this.#workspace.activePaths();
    const removedPaths = [...this.#installedModules.keys()].filter((path) =>
      !activePaths.has(path)
    );
    for (const path of removedPaths) {
      this.#compiler.removeCompilerSessionModule(this.#handle, path);
      this.#compiler.removeCompilerSessionModule(this.#inspectionHandle, path);
      this.#installedModules.delete(path);
      this.#inspectedSources.delete(path);
      this.#sources.delete(path);
      this.#revisions.delete(path);
      this.#developmentArtifacts.delete(path);
    }
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
      simplifications: result.simplifications.slice(),
      readability: result.readability.slice(),
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
    const candidate = this.#inspectionCandidate;
    if (candidate === undefined) {
      throw new CompilerInvariantFailure(
        "source inspection",
        new Error(`workspace inspected ${path} outside a graph load`),
      );
    }
    const added = this.#compiler.addCompilerSessionModule(
      this.#inspectionHandle,
      path,
      source,
    );
    if (!added.ok) this.#throwSourceLoadFailure(added, path, source);
    candidate.set(path, { source, module: added.module });
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

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
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
