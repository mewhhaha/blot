import type { CompilerWork } from "../../src/compiler/wasm.ts";

export const compilerBenchmarkSchema = 1 as const;

export interface CompilerBenchmarkSample {
  readonly durationMilliseconds: number;
  readonly sourceBytes: number;
  readonly astBytes: number | null;
  readonly runtimeHirNodes: number | null;
  readonly wasmBytes: number | null;
  readonly modulesLoaded: number;
  readonly modulesTransported: number;
  readonly modulesChecked: number;
  readonly importersInvalidated: number;
  readonly guestMemoryPagesBefore: number | null;
  readonly guestMemoryPagesAfter: number | null;
  readonly hostRssBytes: number;
  readonly work: CompilerWork | null;
}

export interface CompilerBenchmarkScenario {
  readonly name: string;
  readonly observation: string;
  readonly samples: readonly CompilerBenchmarkSample[];
  readonly p50Milliseconds: number;
  readonly p90Milliseconds: number;
  readonly p95Milliseconds: number;
}

export interface CompilerBenchmarkReport {
  readonly schema: typeof compilerBenchmarkSchema;
  readonly commit: string;
  readonly compilerArtifactSha256: string;
  readonly versions: {
    readonly node: string;
    readonly deno: string | null;
    readonly v8: string;
    readonly rust: string | null;
  };
  readonly graphIdentity: string;
  readonly sampleCount: number;
  readonly scenarios: readonly CompilerBenchmarkScenario[];
}

export function percentile(
  samples: readonly number[],
  quantile: number,
): number {
  if (samples.length === 0) throw new Error("a percentile requires samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.max(0, index)];
}
