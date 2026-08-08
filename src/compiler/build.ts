import { compileArtifact } from "./session.ts";

export type BuildOutcome =
  | {
    readonly status: "built";
    readonly path: string;
    readonly wasm: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly capabilities: readonly string[];
    readonly artifactSource: "compiled" | "revision-cache";
    readonly wasmEmitter: "rust-wasm";
  }
  | {
    readonly status: "failed";
    readonly path: string;
    readonly cause: unknown;
  };

export async function buildBatch(
  paths: readonly string[],
): Promise<readonly BuildOutcome[]> {
  const outcomes: BuildOutcome[] = [];
  for (const path of paths) {
    try {
      const artifact = await compileArtifact(path);
      outcomes.push({
        status: "built",
        path,
        wasm: artifact.wasm,
        manifestBytes: artifact.manifestBytes,
        capabilities: artifact.capabilities,
        artifactSource: artifact.artifactSource,
        wasmEmitter: "rust-wasm",
      });
    } catch (cause) {
      outcomes.push({ status: "failed", path, cause });
    }
  }
  return outcomes;
}
