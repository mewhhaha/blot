import { compileBlotRuntimeModulesOnRustWasm } from "./runtime/target.ts";
import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
  type ValidatedBlotRuntimeModule,
} from "../../runtime/hir.ts";
import { prepareGpupaperHir } from "./compile.ts";
import { refreshLoadedModules } from "../../load.ts";
import type { BuildOutcome } from "../../compiler/build.ts";

type PreparedGpupaperBuild = {
  readonly ordinal: number;
  readonly path: string;
  readonly hir: BlotRuntimeModule;
  readonly module: ValidatedBlotRuntimeModule;
};

type CachedGpupaperArtifact = {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
};

const artifactByHirRevision = new WeakMap<
  BlotRuntimeModule,
  CachedGpupaperArtifact
>();

export async function buildTypeScriptOracleBatch(
  paths: readonly string[],
): Promise<readonly BuildOutcome[]> {
  await refreshLoadedModules();
  return await buildBatch(paths, prepareGpupaperHir);
}

async function buildBatch(
  paths: readonly string[],
  prepare: (path: string) => Promise<BlotRuntimeModule>,
): Promise<readonly BuildOutcome[]> {
  const outcomes: Array<BuildOutcome | undefined> = Array.from(
    { length: paths.length },
  );
  const prepared: PreparedGpupaperBuild[] = [];
  for (const [ordinal, path] of paths.entries()) {
    try {
      const hir = await prepare(path);
      const cached = artifactByHirRevision.get(hir);
      if (cached !== undefined) {
        outcomes[ordinal] = {
          status: "built",
          path,
          wasm: cached.wasm.slice(),
          manifestBytes: cached.manifestBytes.slice(),
          capabilities: cached.capabilities.slice(),
          artifactSource: "revision-cache",
          wasmEmitter: "rust-wasm",
        };
        continue;
      }
      prepared.push({
        ordinal,
        path,
        hir,
        module: validateBlotRuntimeModule(hir),
      });
    } catch (cause) {
      outcomes[ordinal] = { status: "failed", path, cause };
    }
  }
  if (prepared.length > 0) {
    try {
      const batch = await compileBlotRuntimeModulesOnRustWasm(
        prepared.map((entry) => entry.module),
        { target: "wasm-simd128" },
      );
      if (batch.artifacts.length !== prepared.length) {
        throw new Error(
          `gpupaper emitted ${batch.artifacts.length} artifacts for ${prepared.length} prepared modules`,
        );
      }
      const compiled = batch.artifacts.map((artifact, batchOrdinal) => {
        const entry = prepared[batchOrdinal];
        if (entry === undefined) {
          throw new Error(
            `gpupaper emitted unexpected batch artifact ${batchOrdinal}`,
          );
        }
        const cached: CachedGpupaperArtifact = {
          wasm: artifact.wasm.slice(),
          manifestBytes: artifact.manifestBytes.slice(),
          capabilities: Object.freeze([
            ...new Set(
              artifact.manifest.imports.map((imported) => imported.capability),
            ),
          ].sort()),
        };
        return { entry, cached };
      });
      for (const { entry, cached } of compiled) {
        artifactByHirRevision.set(entry.hir, cached);
        outcomes[entry.ordinal] = {
          status: "built",
          path: entry.path,
          wasm: cached.wasm.slice(),
          manifestBytes: cached.manifestBytes.slice(),
          capabilities: cached.capabilities.slice(),
          artifactSource: "compiled",
          wasmEmitter: "rust-wasm",
        };
      }
    } catch (cause) {
      for (const entry of prepared) {
        outcomes[entry.ordinal] = {
          status: "failed",
          path: entry.path,
          cause,
        };
      }
    }
  }
  return outcomes.map((outcome, ordinal) => {
    if (outcome !== undefined) return outcome;
    throw new Error(
      `gpupaper batch omitted outcome ${ordinal} for ${paths[ordinal]}`,
    );
  });
}
