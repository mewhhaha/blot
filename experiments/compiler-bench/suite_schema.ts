import type {
  CompilerBenchmarkClass,
  CompilerBenchmarkEnvironment,
  CompilerBenchmarkVersions,
} from "./schema.ts";

export const compilerBenchmarkSuiteSchema = 5 as const;

export interface CompilerBenchmarkDistribution {
  readonly p50Milliseconds: number;
  readonly madMilliseconds: number;
  readonly p90Milliseconds: number;
  readonly p95Milliseconds: number;
}

export interface CompilerBenchmarkSuiteScenario
  extends CompilerBenchmarkDistribution {
  readonly name: CompilerBenchmarkClass;
}

export interface CompilerBenchmarkSuiteRunScenario
  extends CompilerBenchmarkSuiteScenario {
  readonly samples: readonly number[];
}

export interface CompilerBenchmarkSuiteRun {
  readonly scenarios: readonly CompilerBenchmarkSuiteRunScenario[];
}

export interface CompilerBenchmarkSuiteWorkload {
  readonly name: string;
  readonly path: string;
  readonly graphIdentity: string;
  readonly observations: Readonly<Record<CompilerBenchmarkClass, string>>;
  readonly deterministicObservations: Readonly<
    Record<CompilerBenchmarkClass, string>
  >;
  readonly scenarios: readonly CompilerBenchmarkSuiteScenario[];
  readonly runs: readonly CompilerBenchmarkSuiteRun[];
}

export interface CompilerBenchmarkSuiteReport {
  readonly schema: typeof compilerBenchmarkSuiteSchema;
  readonly runCount: number;
  readonly sampleCount: number;
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
  readonly workloads: readonly CompilerBenchmarkSuiteWorkload[];
}
