import {
  Compiler,
  type CompilerOptions,
  type DevelopmentUnitArtifact,
} from "./compiler/session.ts";
import {
  type DevelopmentUnitName,
  type ProjectManifest,
  readProjectManifest,
} from "./project_format.ts";
import type { CompilerDevelopmentEdge } from "./compiler/wasm.ts";

export interface RetainedDevelopmentUnit {
  readonly name: string;
  readonly interfaceDigest: string;
  readonly implementationDigest: string;
}

export interface DevelopmentBuild {
  readonly revision: string;
  readonly entryUnit: string;
  readonly changedUnits: readonly DevelopmentUnitArtifact[];
  readonly retainedUnits: readonly RetainedDevelopmentUnit[];
  readonly removedUnits: readonly string[];
  readonly edges: readonly CompilerDevelopmentEdge[];
  readonly durationMilliseconds: number;
}

export class DevelopmentProject {
  readonly manifest: ProjectManifest;
  readonly #compiler: Compiler;
  #units = new Map<string, DevelopmentUnitArtifact>();
  #destroyed = false;

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
    this.#requireActive();
    await this.#compiler.setOverlay(path, source, version);
  }

  async clearOverlay(path: string): Promise<void> {
    this.#requireActive();
    await this.#compiler.clearOverlay(path);
  }

  async build(): Promise<DevelopmentBuild> {
    this.#requireActive();
    const started = performance.now();
    const entryPath = this.#unitRoot(this.manifest.entryUnit);
    const compiled = await this.#compiler.compileDevelopment({
      entryPath,
      entryUnit: this.manifest.entryUnit,
      units: this.manifest.units,
    });
    const next = new Map(
      compiled.units.map((unit) => [unit.name, unit] as const),
    );
    const changedUnits = compiled.units.filter((unit) => {
      const previous = this.#units.get(unit.name);
      return previous === undefined ||
        previous.interfaceDigest !== unit.interfaceDigest ||
        previous.implementationDigest !== unit.implementationDigest;
    });
    const changedNames = new Set(changedUnits.map((unit) => unit.name));
    const retainedUnits = compiled.units.flatMap((unit) => {
      if (changedNames.has(unit.name)) return [];
      return [{
        name: unit.name,
        interfaceDigest: unit.interfaceDigest,
        implementationDigest: unit.implementationDigest,
      }];
    });
    const removedUnits = [...this.#units.keys()].filter((name) =>
      !next.has(name)
    );
    this.#units = next;
    return {
      revision: compiled.revision,
      entryUnit: compiled.entryUnit,
      changedUnits,
      retainedUnits,
      removedUnits,
      edges: compiled.edges,
      durationMilliseconds: performance.now() - started,
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
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

  #requireActive(): void {
    if (this.#destroyed) {
      throw new Error(
        `development project ${
          JSON.stringify(this.manifest.path)
        } is destroyed`,
      );
    }
  }
}
