import {
  compileBlotRuntimeModulesOnGpu,
} from "../../../gpupaper/src/blot_runtime_target.ts";
import {
  validateBlotRuntimeModule,
  type ValidatedBlotRuntimeModule,
} from "../../../gpupaper/src/blot_runtime_hir.ts";
import { prepareGpupaperHir } from "./compile.ts";

export type GpupaperBuildOutcome =
  | {
    readonly status: "built";
    readonly path: string;
    readonly wasm: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly capabilities: readonly string[];
  }
  | {
    readonly status: "failed";
    readonly path: string;
    readonly cause: unknown;
  };

type PreparedGpupaperBuild = {
  readonly ordinal: number;
  readonly path: string;
  readonly module: ValidatedBlotRuntimeModule;
};

export async function buildGpupaperBatch(
  paths: readonly string[],
): Promise<readonly GpupaperBuildOutcome[]> {
  const outcomes: Array<GpupaperBuildOutcome | undefined> = Array.from(
    { length: paths.length },
  );
  const prepared: PreparedGpupaperBuild[] = [];
  for (const [ordinal, path] of paths.entries()) {
    try {
      prepared.push({
        ordinal,
        path,
        module: validateBlotRuntimeModule(await prepareGpupaperHir(path)),
      });
    } catch (cause) {
      outcomes[ordinal] = { status: "failed", path, cause };
    }
  }
  if (prepared.length > 0) {
    try {
      const batch = await compileBlotRuntimeModulesOnGpu(
        prepared.map((entry) => entry.module),
      );
      for (const [batchOrdinal, artifact] of batch.artifacts.entries()) {
        const entry = prepared[batchOrdinal];
        if (entry === undefined) {
          throw new Error(
            `gpupaper emitted unexpected batch artifact ${batchOrdinal}`,
          );
        }
        outcomes[entry.ordinal] = {
          status: "built",
          path: entry.path,
          wasm: artifact.wasm,
          manifestBytes: artifact.manifestBytes,
          capabilities: [
            ...new Set(
              artifact.manifest.imports.map((imported) => imported.capability),
            ),
          ].sort(),
        };
      }
      if (batch.artifacts.length !== prepared.length) {
        throw new Error(
          `gpupaper emitted ${batch.artifacts.length} artifacts for ${prepared.length} prepared modules`,
        );
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
