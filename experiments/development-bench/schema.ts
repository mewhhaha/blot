export const developmentBenchmarkSchema = 3 as const;
export const developmentBenchmarkMaximumRssGrowthBytes = 128 * 1024 * 1024;

export type DevelopmentBenchmarkCompilerProfile =
  | "production"
  | "development-profile";

export interface DevelopmentBenchmarkProvenance {
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
  readonly compilerProfile: DevelopmentBenchmarkCompilerProfile;
  readonly environment: {
    readonly os: string;
    readonly architecture: string;
    readonly cpuModels: readonly string[];
    readonly logicalCpuCount: number;
    readonly deno: string;
    readonly v8: string;
    readonly denoExecutableSha256: string;
    readonly denoInvocationSha256: string;
  };
}

export interface DevelopmentBenchmarkSample {
  readonly iteration: number;
  readonly buildMilliseconds: number;
  readonly activationMilliseconds: number;
  readonly committedMilliseconds: number;
  readonly changedUnits: readonly string[];
  readonly retainedUnits: readonly string[];
  readonly transferredWasmBytes: number;
  readonly transferredManifestBytes: number;
  readonly observation: string;
  readonly hostRssBytes: number;
}

export interface DevelopmentBenchmarkSummary {
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

export interface DevelopmentBenchmarkMemoryCheckpoint {
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

export interface DevelopmentBenchmarkMemoryProfile {
  readonly checkpoints: readonly DevelopmentBenchmarkMemoryCheckpoint[];
}

export type DevelopmentBenchmarkCompilerProfiling =
  | {
    readonly featureStatus: "production";
    readonly measurementsIncluded: false;
  }
  | {
    readonly featureStatus: "development-profile";
    readonly measurementsIncluded: true;
    readonly initialCheckpoints:
      readonly DevelopmentBenchmarkMemoryCheckpoint[];
    readonly sampleCheckpoints: readonly (
      readonly DevelopmentBenchmarkMemoryCheckpoint[]
    )[];
  };

export interface DevelopmentBenchmarkReport
  extends DevelopmentBenchmarkProvenance {
  readonly schema: typeof developmentBenchmarkSchema;
  readonly compilerProfiling: DevelopmentBenchmarkCompilerProfiling;
  readonly workload: {
    readonly sourceBytes: number;
    readonly editedProviderBytes: number;
    readonly unitCount: number;
    readonly voxelDeclarations: number;
  };
  readonly initial: {
    readonly buildMilliseconds: number;
    readonly activationMilliseconds: number;
    readonly changedUnits: readonly string[];
    readonly observation: string;
    readonly hostRssBytes: number;
  };
  readonly samples: readonly DevelopmentBenchmarkSample[];
  readonly committed: DevelopmentBenchmarkSummary;
  readonly build: DevelopmentBenchmarkSummary;
  readonly activation: DevelopmentBenchmarkSummary;
  readonly maximumRssGrowthBytes: number;
}

export function summarizeDurations(
  durations: readonly number[],
): DevelopmentBenchmarkSummary {
  if (durations.length === 0) {
    throw new Error("development benchmark requires at least one sample");
  }
  return {
    p50Milliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95),
    maximumMilliseconds: Math.max(...durations),
  };
}

export function developmentBenchmarkCompilerProfiling(
  expectedProfile: DevelopmentBenchmarkCompilerProfile,
  initial: DevelopmentBenchmarkMemoryProfile | undefined,
  samples: readonly (DevelopmentBenchmarkMemoryProfile | undefined)[],
): DevelopmentBenchmarkCompilerProfiling {
  if (expectedProfile === "production") {
    if (initial !== undefined) {
      throw new Error(
        "development benchmark production compiler returned an initial memory profile",
      );
    }
    for (let index = 0; index < samples.length; index += 1) {
      if (samples[index] !== undefined) {
        throw new Error(
          `development benchmark production compiler returned a memory profile in sample ${index}`,
        );
      }
    }
    return {
      featureStatus: "production",
      measurementsIncluded: false,
    };
  }
  if (initial === undefined) {
    throw new Error(
      "development benchmark development-profile compiler omitted its initial memory profile",
    );
  }
  const sampleCheckpoints: DevelopmentBenchmarkMemoryCheckpoint[][] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const profile = samples[index];
    if (profile === undefined) {
      throw new Error(
        `development benchmark compiler profiling disappeared in sample ${index}`,
      );
    }
    sampleCheckpoints.push([...profile.checkpoints]);
  }
  return {
    featureStatus: "development-profile",
    measurementsIncluded: true,
    initialCheckpoints: initial.checkpoints,
    sampleCheckpoints,
  };
}

export function maximumRssGrowth(
  baselineBytes: number,
  samples: readonly DevelopmentBenchmarkSample[],
): number {
  if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 0) {
    throw new Error(
      `development benchmark RSS baseline must be a non-negative safe integer, received ${baselineBytes}`,
    );
  }
  if (samples.length === 0) {
    throw new Error("development benchmark requires at least one RSS sample");
  }
  const maximum = Math.max(...samples.map((sample) => sample.hostRssBytes));
  return Math.max(0, maximum - baselineBytes);
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.max(0, index)];
}
