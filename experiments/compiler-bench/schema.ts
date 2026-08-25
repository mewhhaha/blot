import type { CompilerWork } from "../../src/compiler/wasm.ts";

export const compilerBenchmarkSchema = 5 as const;

export const compilerBenchmarkClasses = [
  "cold-process",
  "cold-compiler",
  "warm-compiler",
  "resident-unchanged",
  "source-only-edit",
  "semantic-edit",
  "semantic-analysis-edit",
  "prepare-after-check",
  "emit-after-prepare",
] as const;

export type CompilerBenchmarkClass = typeof compilerBenchmarkClasses[number];

export interface CompilerBenchmarkSample {
  readonly durationMilliseconds: number;
  readonly sourceBytes: number;
  readonly runtimeHirNodes: number | null;
  readonly wasmBytes: number | null;
  readonly checkedModules: readonly string[] | null;
  readonly invalidatedImporters: readonly string[] | null;
  readonly hostRssBytes: number;
  readonly work: CompilerWork | null;
}

export interface CompilerBenchmarkScenario {
  readonly name: CompilerBenchmarkClass;
  readonly measuredBoundary: string;
  readonly setupOutsideClock: string;
  readonly observation: string;
  readonly samples: readonly CompilerBenchmarkSample[];
  readonly p50Milliseconds: number;
  readonly madMilliseconds: number;
  readonly p90Milliseconds: number;
  readonly p95Milliseconds: number;
}

export interface CompilerBenchmarkVersions {
  readonly node: string;
  readonly deno: string | null;
  readonly v8: string;
  readonly rust: string | null;
}

export interface CompilerBenchmarkEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModels: readonly string[];
  readonly logicalCpuCount: number;
  readonly nodeInvocationSha256: string;
}

export interface CompilerBenchmarkReport {
  readonly schema: typeof compilerBenchmarkSchema;
  readonly commit: string;
  readonly hostInputsSha256: string;
  readonly benchmarkInputsSha256: string;
  readonly compilerArtifactSha256: string;
  readonly compilerManifestSha256: string;
  readonly compilerInputsSha256: string;
  readonly compilerPreludeSha256: string;
  readonly compilerSourceCommit: string;
  readonly compilerSourceTree: string;
  readonly compilerRustc: string;
  readonly versions: CompilerBenchmarkVersions;
  readonly environment: CompilerBenchmarkEnvironment;
  readonly graphIdentity: string;
  readonly sourcePath: string;
  readonly sourceBytes: number;
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

export function medianAbsoluteDeviation(
  samples: readonly number[],
): number {
  const median = percentile(samples, 0.5);
  return percentile(
    samples.map((sample) => Math.abs(sample - median)),
    0.5,
  );
}
