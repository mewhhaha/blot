export const compilerStartupSchema = 4 as const;

export const compilerStartupPhases = [
  "process-bootstrap-and-module-load",
  "bundle-read",
  "artifact-validation",
  "wasm-compile",
  "artifact-authenticate-and-compile",
  "wasm-instantiate",
  "session-create",
  "snapshot-install",
  "root-read",
  "root-lower",
  "root-configure",
  "root-check",
  "prelude-ast-export",
  "prelude-ast-decode",
] as const;

export type CompilerStartupPhase = typeof compilerStartupPhases[number];

export interface CompilerStartupChildSample {
  readonly internalMilliseconds: number;
  readonly syntaxConsumerInternalMilliseconds: number;
  readonly phases: Readonly<Partial<Record<CompilerStartupPhase, number>>>;
  readonly observation: string;
}

export interface CompilerStartupSample extends CompilerStartupChildSample {
  readonly processMilliseconds: number;
  readonly syntaxConsumerProcessMilliseconds: number;
}

export interface CompilerStartupDistribution {
  readonly p50Milliseconds: number;
  readonly madMilliseconds: number;
  readonly p90Milliseconds: number;
  readonly p95Milliseconds: number;
}

export interface CompilerStartupEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModels: readonly string[];
  readonly logicalCpuCount: number;
  readonly nodeInvocationSha256: string;
}

export interface CompilerStartupProvenance {
  readonly commit: string;
  readonly hostInputsSha256: string;
  readonly benchmarkInputsSha256: string;
  readonly graphIdentity: string;
  readonly compilerArtifactSha256: string;
  readonly compilerManifestSha256: string;
  readonly compilerInputsSha256: string;
  readonly compilerPreludeSha256: string;
  readonly compilerSourceCommit: string;
  readonly compilerSourceTree: string;
  readonly compilerRustc: string;
  readonly sourceBytes: number;
  readonly environment: CompilerStartupEnvironment;
}

export interface CompilerStartupReport extends CompilerStartupProvenance {
  readonly schema: typeof compilerStartupSchema;
  readonly sourcePath: string;
  readonly sampleCount: number;
  readonly node: string;
  readonly v8: string;
  readonly observation: string;
  readonly process: CompilerStartupDistribution;
  readonly internal: CompilerStartupDistribution;
  readonly syntaxConsumerProcess: CompilerStartupDistribution;
  readonly syntaxConsumerInternal: CompilerStartupDistribution;
  readonly phases: Readonly<
    Record<CompilerStartupPhase, CompilerStartupDistribution>
  >;
  readonly samples: readonly CompilerStartupSample[];
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

export function distribution(
  samples: readonly number[],
): CompilerStartupDistribution {
  const median = percentile(samples, 0.5);
  const deviations = samples.map((sample) => Math.abs(sample - median));
  return {
    p50Milliseconds: median,
    madMilliseconds: percentile(deviations, 0.5),
    p90Milliseconds: percentile(samples, 0.9),
    p95Milliseconds: percentile(samples, 0.95),
  };
}

export function semanticProcessMilliseconds(
  syntaxConsumerProcessMilliseconds: number,
  sample: CompilerStartupChildSample,
): number {
  if (sample.syntaxConsumerInternalMilliseconds < sample.internalMilliseconds) {
    throw new Error(
      `syntax-consumer internal time ${sample.syntaxConsumerInternalMilliseconds} ms precedes semantic internal time ${sample.internalMilliseconds} ms`,
    );
  }
  if (
    syntaxConsumerProcessMilliseconds <
      sample.syntaxConsumerInternalMilliseconds
  ) {
    throw new Error(
      `syntax-consumer process time ${syntaxConsumerProcessMilliseconds} ms is shorter than its internal time ${sample.syntaxConsumerInternalMilliseconds} ms`,
    );
  }
  const outsideMeasuredWork = syntaxConsumerProcessMilliseconds -
    sample.syntaxConsumerInternalMilliseconds;
  return outsideMeasuredWork + sample.internalMilliseconds;
}

export function decodeCompilerStartupChildSample(
  value: unknown,
): CompilerStartupChildSample {
  const sample = requiredRecord(value, "compiler startup child sample");
  const internalMilliseconds = requiredMilliseconds(
    sample.internalMilliseconds,
    "compiler startup semantic internal time",
  );
  const syntaxConsumerInternalMilliseconds = requiredMilliseconds(
    sample.syntaxConsumerInternalMilliseconds,
    "compiler startup syntax-consumer internal time",
  );
  if (syntaxConsumerInternalMilliseconds < internalMilliseconds) {
    throw new Error(
      `syntax-consumer internal time ${syntaxConsumerInternalMilliseconds} ms precedes semantic internal time ${internalMilliseconds} ms`,
    );
  }
  const phases = requiredPhases(
    sample.phases,
    compilerStartupPhases.slice(1),
    "compiler startup child sample",
  );
  const observation = requiredText(
    sample.observation,
    "compiler startup child observation",
  );
  return {
    internalMilliseconds,
    syntaxConsumerInternalMilliseconds,
    phases,
    observation,
  };
}

export function decodeCompilerStartupReport(
  value: unknown,
): CompilerStartupReport {
  const report = requiredRecord(value, "compiler startup report");
  if (report.schema !== compilerStartupSchema) {
    throw new Error(
      `compiler startup report has schema ${
        String(report.schema)
      }, expected ${compilerStartupSchema}`,
    );
  }
  const sampleCount = requiredPositiveOddInteger(
    report.sampleCount,
    "compiler startup sample count",
  );
  const observation = requiredText(
    report.observation,
    "compiler startup observation",
  );
  const samplesSource = report.samples;
  if (!Array.isArray(samplesSource) || samplesSource.length !== sampleCount) {
    let actualSampleCount = "no";
    if (Array.isArray(samplesSource)) {
      actualSampleCount = String(samplesSource.length);
    }
    throw new Error(
      `compiler startup report has ${actualSampleCount} samples, expected ${sampleCount}`,
    );
  }
  const samples = samplesSource.map((sample, index) =>
    decodeReportSample(sample, observation, index)
  );
  const phasesSource = requiredRecord(
    report.phases,
    "compiler startup phase distributions",
  );
  requireExactKeys(
    phasesSource,
    compilerStartupPhases,
    "compiler startup phase distributions",
  );
  const phases = Object.fromEntries(compilerStartupPhases.map((phase) => [
    phase,
    decodeDistribution(
      phasesSource[phase],
      `compiler startup ${phase} distribution`,
    ),
  ])) as Record<CompilerStartupPhase, CompilerStartupDistribution>;
  const decoded: CompilerStartupReport = {
    schema: compilerStartupSchema,
    commit: requiredGitIdentity(report.commit, "repository commit"),
    hostInputsSha256: requiredHash(
      report.hostInputsSha256,
      "host inputs",
    ),
    benchmarkInputsSha256: requiredHash(
      report.benchmarkInputsSha256,
      "benchmark inputs",
    ),
    graphIdentity: requiredHash(report.graphIdentity, "source graph"),
    compilerArtifactSha256: requiredHash(
      report.compilerArtifactSha256,
      "compiler artifact",
    ),
    compilerManifestSha256: requiredHash(
      report.compilerManifestSha256,
      "compiler manifest",
    ),
    compilerInputsSha256: requiredHash(
      report.compilerInputsSha256,
      "compiler inputs",
    ),
    compilerPreludeSha256: requiredHash(
      report.compilerPreludeSha256,
      "compiler prelude",
    ),
    compilerSourceCommit: requiredGitIdentity(
      report.compilerSourceCommit,
      "compiler source commit",
    ),
    compilerSourceTree: requiredGitIdentity(
      report.compilerSourceTree,
      "compiler source tree",
    ),
    compilerRustc: requiredRustc(report.compilerRustc),
    environment: decodeEnvironment(report.environment),
    sourcePath: requiredText(report.sourcePath, "compiler startup source path"),
    sourceBytes: requiredNonNegativeInteger(
      report.sourceBytes,
      "compiler startup source byte count",
    ),
    sampleCount,
    node: requiredText(report.node, "compiler startup Node version"),
    v8: requiredText(report.v8, "compiler startup V8 version"),
    observation,
    process: decodeDistribution(
      report.process,
      "compiler startup process distribution",
    ),
    internal: decodeDistribution(
      report.internal,
      "compiler startup internal distribution",
    ),
    syntaxConsumerProcess: decodeDistribution(
      report.syntaxConsumerProcess,
      "compiler startup syntax-consumer process distribution",
    ),
    syntaxConsumerInternal: decodeDistribution(
      report.syntaxConsumerInternal,
      "compiler startup syntax-consumer internal distribution",
    ),
    phases,
    samples,
  };
  requireDistributionMatches(
    decoded.process,
    samples.map((sample) => sample.processMilliseconds),
    "compiler startup process distribution",
  );
  requireDistributionMatches(
    decoded.internal,
    samples.map((sample) => sample.internalMilliseconds),
    "compiler startup internal distribution",
  );
  requireDistributionMatches(
    decoded.syntaxConsumerProcess,
    samples.map((sample) => sample.syntaxConsumerProcessMilliseconds),
    "compiler startup syntax-consumer process distribution",
  );
  requireDistributionMatches(
    decoded.syntaxConsumerInternal,
    samples.map((sample) => sample.syntaxConsumerInternalMilliseconds),
    "compiler startup syntax-consumer internal distribution",
  );
  for (const phase of compilerStartupPhases) {
    requireDistributionMatches(
      decoded.phases[phase],
      samples.map((sample) => sample.phases[phase] as number),
      `compiler startup ${phase} distribution`,
    );
  }
  return decoded;
}

function decodeReportSample(
  value: unknown,
  observation: string,
  index: number,
): CompilerStartupSample {
  const sample = requiredRecord(
    value,
    `compiler startup sample ${index + 1}`,
  );
  const internalMilliseconds = requiredMilliseconds(
    sample.internalMilliseconds,
    `compiler startup sample ${index + 1} semantic internal time`,
  );
  const syntaxConsumerInternalMilliseconds = requiredMilliseconds(
    sample.syntaxConsumerInternalMilliseconds,
    `compiler startup sample ${index + 1} syntax-consumer internal time`,
  );
  const processMilliseconds = requiredMilliseconds(
    sample.processMilliseconds,
    `compiler startup sample ${index + 1} semantic process time`,
  );
  const syntaxConsumerProcessMilliseconds = requiredMilliseconds(
    sample.syntaxConsumerProcessMilliseconds,
    `compiler startup sample ${index + 1} syntax-consumer process time`,
  );
  if (
    internalMilliseconds > processMilliseconds ||
    internalMilliseconds > syntaxConsumerInternalMilliseconds ||
    processMilliseconds > syntaxConsumerProcessMilliseconds ||
    syntaxConsumerInternalMilliseconds > syntaxConsumerProcessMilliseconds
  ) {
    throw new Error(
      `compiler startup sample ${
        index + 1
      } has inconsistent nested timing boundaries`,
    );
  }
  const expectedProcessMilliseconds = semanticProcessMilliseconds(
    syntaxConsumerProcessMilliseconds,
    {
      internalMilliseconds,
      syntaxConsumerInternalMilliseconds,
      phases: {},
      observation,
    },
  );
  if (processMilliseconds !== expectedProcessMilliseconds) {
    throw new Error(
      `compiler startup sample ${
        index + 1
      } semantic process time is ${processMilliseconds} ms, expected ${expectedProcessMilliseconds} ms from its nested boundaries`,
    );
  }
  const currentObservation = requiredText(
    sample.observation,
    `compiler startup sample ${index + 1} observation`,
  );
  if (currentObservation !== observation) {
    throw new Error(
      `compiler startup sample ${
        index + 1
      } observation differs from the report`,
    );
  }
  const phases = requiredPhases(
    sample.phases,
    compilerStartupPhases,
    `compiler startup sample ${index + 1}`,
  );
  const bootstrapMilliseconds = requiredMilliseconds(
    phases["process-bootstrap-and-module-load"],
    `compiler startup sample ${index + 1} bootstrap time`,
  );
  const expectedBootstrapMilliseconds = processMilliseconds -
    internalMilliseconds;
  if (bootstrapMilliseconds !== expectedBootstrapMilliseconds) {
    throw new Error(
      `compiler startup sample ${
        index + 1
      } bootstrap time is ${bootstrapMilliseconds} ms, expected ${expectedBootstrapMilliseconds} ms`,
    );
  }
  return {
    internalMilliseconds,
    syntaxConsumerInternalMilliseconds,
    processMilliseconds,
    syntaxConsumerProcessMilliseconds,
    phases,
    observation: currentObservation,
  };
}

function decodeDistribution(
  value: unknown,
  evidence: string,
): CompilerStartupDistribution {
  const encoded = requiredRecord(value, evidence);
  const p50Milliseconds = requiredMilliseconds(
    encoded.p50Milliseconds,
    `${evidence} p50`,
  );
  const madMilliseconds = requiredMilliseconds(
    encoded.madMilliseconds,
    `${evidence} MAD`,
  );
  const p90Milliseconds = requiredMilliseconds(
    encoded.p90Milliseconds,
    `${evidence} p90`,
  );
  const p95Milliseconds = requiredMilliseconds(
    encoded.p95Milliseconds,
    `${evidence} p95`,
  );
  if (p50Milliseconds > p90Milliseconds || p90Milliseconds > p95Milliseconds) {
    throw new Error(`${evidence} percentiles are not ordered`);
  }
  return {
    p50Milliseconds,
    madMilliseconds,
    p90Milliseconds,
    p95Milliseconds,
  };
}

function decodeEnvironment(value: unknown): CompilerStartupEnvironment {
  const environment = requiredRecord(value, "compiler startup environment");
  const cpuModels = environment.cpuModels;
  if (
    !Array.isArray(cpuModels) || cpuModels.length === 0 ||
    cpuModels.some((model) => typeof model !== "string" || model.length === 0)
  ) {
    throw new Error("compiler startup environment has invalid CPU models");
  }
  return {
    platform: requiredText(
      environment.platform,
      "compiler startup environment platform",
    ),
    arch: requiredText(
      environment.arch,
      "compiler startup environment architecture",
    ),
    cpuModels: cpuModels as string[],
    logicalCpuCount: requiredPositiveInteger(
      environment.logicalCpuCount,
      "compiler startup logical CPU count",
    ),
    nodeInvocationSha256: requiredHash(
      environment.nodeInvocationSha256,
      "Node invocation",
    ),
  };
}

function requiredPhases(
  value: unknown,
  expected: readonly CompilerStartupPhase[],
  evidence: string,
): Readonly<Partial<Record<CompilerStartupPhase, number>>> {
  const phases = requiredRecord(value, `${evidence} phases`);
  requireExactKeys(phases, expected, `${evidence} phases`);
  return Object.fromEntries(expected.map((phase) => [
    phase,
    requiredMilliseconds(phases[phase], `${evidence} ${phase}`),
  ]));
}

function requireDistributionMatches(
  actual: CompilerStartupDistribution,
  samples: readonly number[],
  evidence: string,
): void {
  const expected = distribution(samples);
  for (
    const key of [
      "p50Milliseconds",
      "madMilliseconds",
      "p90Milliseconds",
      "p95Milliseconds",
    ] as const
  ) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${evidence} ${key} is ${actual[key]}, expected ${
          expected[key]
        } from its samples`,
      );
    }
  }
}

function requiredRecord(
  value: unknown,
  evidence: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${evidence} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  evidence: string,
): void {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(orderedExpected)) {
    throw new Error(`${evidence} has an unexpected phase matrix`);
  }
}

function requiredText(value: unknown, evidence: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${evidence} is missing`);
  }
  return value;
}

function requiredMilliseconds(value: unknown, evidence: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${evidence} is not a finite non-negative number`);
  }
  return value;
}

function requiredPositiveOddInteger(value: unknown, evidence: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value % 2 === 0
  ) {
    throw new Error(`${evidence} is not a positive odd integer`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, evidence: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${evidence} is not a positive integer`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, evidence: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${evidence} is not a non-negative integer`);
  }
  return value;
}

function requiredHash(value: unknown, evidence: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `compiler startup report has an invalid ${evidence} identity`,
    );
  }
  return value;
}

function requiredGitIdentity(value: unknown, evidence: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error(`compiler startup report has an invalid ${evidence}`);
  }
  return value;
}

function requiredRustc(value: unknown): string {
  if (
    typeof value !== "string" || !/^rustc [0-9]+\.[0-9]+\.[0-9]+/.test(value)
  ) {
    throw new Error("compiler startup report has an invalid Rust toolchain");
  }
  return value;
}
