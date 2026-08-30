import {
  Compiler,
  type CompilerOptions,
  type DevelopmentEdge,
  type DevelopmentMemoryProfile,
  type DevelopmentUnitArtifact,
} from "./compiler/session.ts";
import { CompilerInvariantFailure } from "./compiler/policy.ts";
import {
  type DevelopmentUnitName,
  type ProjectManifest,
  readProjectManifest,
} from "./project_format.ts";
import type {
  DevelopmentActivation,
  DevelopmentRuntime,
} from "./development_runtime.ts";

const developmentBuildBrand: unique symbol = Symbol("DevelopmentBuild");

export interface RetainedDevelopmentUnit {
  readonly name: string;
  readonly interfaceDigest: string;
  readonly implementationDigest: string;
  readonly wasmDigest: string;
}

export interface DevelopmentBuild {
  readonly [developmentBuildBrand]: true;
  readonly baseRevision: string | undefined;
  readonly revision: string;
  readonly entryUnit: string;
  readonly changedUnits: readonly DevelopmentUnitArtifact[];
  readonly retainedUnits: readonly RetainedDevelopmentUnit[];
  readonly removedUnits: readonly string[];
  readonly edges: readonly DevelopmentEdge[];
  readonly durationMilliseconds: number;
  readonly developmentProfile?: DevelopmentMemoryProfile;
}

interface PendingDevelopmentBuild {
  readonly build: DevelopmentBuild;
  readonly units: Map<string, DevelopmentUnitArtifact>;
  readonly baseRevision: string | undefined;
  readonly revision: string;
  readonly entryUnit: string;
}

type DevelopmentProjectState =
  | { readonly tag: "ready" }
  | { readonly tag: "preparing" }
  | { readonly tag: "pending"; readonly candidate: PendingDevelopmentBuild }
  | { readonly tag: "destroyed" };

export class DevelopmentProject {
  readonly manifest: ProjectManifest;
  readonly #compiler: Compiler;
  #units = new Map<string, DevelopmentUnitArtifact>();
  #artifactReservoir = new Map<string, DevelopmentUnitArtifact>();
  #revision: string | undefined;
  #state: DevelopmentProjectState = { tag: "ready" };

  private constructor(manifest: ProjectManifest, compiler: Compiler) {
    this.manifest = manifest;
    this.#compiler = compiler;
  }

  static async create(
    manifestPath: string,
    compilerOptions: CompilerOptions = {},
  ): Promise<DevelopmentProject> {
    const manifest = await readProjectManifest(manifestPath);
    const compiler = await Compiler.create(compilerOptions);
    return new DevelopmentProject(manifest, compiler);
  }

  async setOverlay(
    path: string,
    source: string,
    version?: number,
  ): Promise<void> {
    this.#requireReady("set an overlay");
    await this.#compiler.setOverlay(path, source, version);
  }

  async clearOverlay(path: string): Promise<void> {
    this.#requireReady("clear an overlay");
    await this.#compiler.clearOverlay(path);
  }

  async releaseRoot(path: string): Promise<void> {
    this.#requireReady("release a source root");
    await this.#compiler.releaseRoot(path);
  }

  async markChanged(path: string): Promise<void> {
    this.#requireReady("mark a source changed");
    await this.#compiler.markChanged(path);
  }

  async prepareBuild(): Promise<DevelopmentBuild> {
    this.#requireReady("prepare a build");
    this.#state = { tag: "preparing" };
    const started = performance.now();
    try {
      const entryPath = this.#unitRoot(this.manifest.entryUnit);
      const compiled = await this.#compiler.compileDevelopment({
        entryPath,
        entryUnit: this.manifest.entryUnit,
        units: this.manifest.units,
      });
      const next = new Map(
        compiled.units.map((unit) => {
          let artifact: DevelopmentUnitArtifact;
          if (unit.artifactSource === "compiled") {
            artifact = copyDevelopmentArtifact(unit);
          } else {
            let retained: DevelopmentUnitArtifact | undefined;
            for (
              const candidate of [
                this.#artifactReservoir.get(unit.name),
                this.#units.get(unit.name),
              ]
            ) {
              if (
                candidate === undefined || candidate.root !== unit.root ||
                candidate.interfaceDigest !== unit.interfaceDigest ||
                candidate.implementationDigest !==
                  unit.implementationDigest ||
                candidate.wasmDigest !== unit.wasmDigest ||
                candidate.capabilities.length !== unit.capabilities.length ||
                !candidate.capabilities.every((capability, index) =>
                  capability === unit.capabilities[index]
                )
              ) {
                continue;
              }
              retained = candidate;
              break;
            }
            if (retained === undefined) {
              throw new CompilerInvariantFailure(
                "development build preparation",
                new Error(
                  `compiler returned cached unit ${
                    JSON.stringify(unit.name)
                  } without the matching private artifact`,
                ),
              );
            }
            artifact = Object.freeze({
              ...retained,
              artifactSource: unit.artifactSource,
            });
          }
          return [artifact.name, artifact] as const;
        }),
      );
      this.#artifactReservoir = new Map(next);
      const changedArtifacts = [...next.values()].filter((unit) => {
        if (unit.artifactSource === "compiled") return true;
        const previous = this.#units.get(unit.name);
        return previous === undefined ||
          previous.interfaceDigest !== unit.interfaceDigest ||
          previous.implementationDigest !== unit.implementationDigest ||
          previous.wasmDigest !== unit.wasmDigest;
      });
      const changedNames = new Set(
        changedArtifacts.map((unit) => unit.name),
      );
      const retainedUnits = [...next.values()].flatMap((unit) => {
        if (changedNames.has(unit.name)) return [];
        return [Object.freeze({
          name: unit.name,
          interfaceDigest: unit.interfaceDigest,
          implementationDigest: unit.implementationDigest,
          wasmDigest: unit.wasmDigest,
        })];
      });
      const removedUnits = Object.freeze(
        [...this.#units.keys()].filter((name) => !next.has(name)),
      );
      const changedUnits = Object.freeze(
        changedArtifacts.map(copyDevelopmentArtifact),
      );
      const edges = Object.freeze(
        compiled.edges.map((edge) => Object.freeze({ ...edge })),
      );
      const build: DevelopmentBuild = Object.freeze({
        [developmentBuildBrand]: true as const,
        baseRevision: this.#revision,
        revision: compiled.revision,
        entryUnit: compiled.entryUnit,
        changedUnits,
        retainedUnits: Object.freeze(retainedUnits),
        removedUnits,
        edges,
        durationMilliseconds: performance.now() - started,
        developmentProfile: compiled.developmentProfile,
      });
      this.#state = {
        tag: "pending",
        candidate: {
          build,
          units: next,
          baseRevision: this.#revision,
          revision: compiled.revision,
          entryUnit: compiled.entryUnit,
        },
      };
      return build;
    } catch (error) {
      if (this.#state.tag === "preparing") this.#state = { tag: "ready" };
      throw error;
    }
  }

  commitBuild(build: DevelopmentBuild): void {
    const pending = this.#pendingBuild(build, "commit");
    this.#units = pending.units;
    this.#revision = pending.revision;
    this.#state = { tag: "ready" };
  }

  abortBuild(build: DevelopmentBuild): void {
    this.#pendingBuild(build, "abort");
    this.#state = { tag: "ready" };
  }

  async activate(runtime: DevelopmentRuntime): Promise<DevelopmentBuild> {
    const build = await this.prepareBuild();
    let activation: DevelopmentActivation;
    try {
      activation = await runtime.prepareActivation(build);
    } catch (error) {
      this.abortBuild(build);
      throw error;
    }
    this.commitBuild(build);
    runtime.commitActivation(activation);
    return build;
  }

  destroy(): void {
    if (this.#state.tag === "destroyed") return;
    this.#requireReady("destroy");
    this.#state = { tag: "destroyed" };
    this.#compiler.destroy();
  }

  #unitRoot(name: DevelopmentUnitName): string {
    const root = this.manifest.units.get(name);
    if (root === undefined) {
      throw new Error(
        `project ${JSON.stringify(this.manifest.path)} lost unit ${
          JSON.stringify(name)
        } after validation`,
      );
    }
    return root;
  }

  #pendingBuild(
    build: DevelopmentBuild,
    operation: "commit" | "abort",
  ): PendingDevelopmentBuild {
    if (
      this.#state.tag === "pending" &&
      this.#state.candidate.build === build
    ) {
      return this.#state.candidate;
    }
    if (this.#state.tag === "destroyed") {
      throw new Error(
        `development project ${
          JSON.stringify(this.manifest.path)
        } is destroyed`,
      );
    }
    let pendingRevision = "none";
    if (this.#state.tag === "pending") {
      pendingRevision = JSON.stringify(this.#state.candidate.revision);
    }
    throw new Error(
      `development project ${
        JSON.stringify(this.manifest.path)
      } cannot ${operation} build ${
        JSON.stringify(build.revision)
      }; pending revision is ${pendingRevision}`,
    );
  }

  #requireReady(operation: string): void {
    if (this.#state.tag === "ready") return;
    if (this.#state.tag === "destroyed") {
      throw new Error(
        `development project ${
          JSON.stringify(this.manifest.path)
        } is destroyed`,
      );
    }
    if (this.#state.tag === "preparing") {
      throw new Error(
        `development project ${
          JSON.stringify(this.manifest.path)
        } cannot ${operation} while preparing a build`,
      );
    }
    throw new Error(
      `development project ${
        JSON.stringify(this.manifest.path)
      } cannot ${operation} while build ${
        JSON.stringify(this.#state.candidate.revision)
      } is pending`,
    );
  }
}

function copyDevelopmentArtifact(
  artifact: DevelopmentUnitArtifact,
): DevelopmentUnitArtifact {
  return Object.freeze({
    name: artifact.name,
    root: artifact.root,
    wasm: artifact.wasm.slice(),
    manifestBytes: artifact.manifestBytes.slice(),
    capabilities: artifact.capabilities.slice(),
    interfaceDigest: artifact.interfaceDigest,
    implementationDigest: artifact.implementationDigest,
    wasmDigest: artifact.wasmDigest,
    artifactSource: artifact.artifactSource,
  });
}
