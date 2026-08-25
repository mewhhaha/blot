import {
  type CompilerBenchmarkClass,
  compilerBenchmarkClasses,
  type CompilerBenchmarkEnvironment,
  type CompilerBenchmarkVersions,
  medianAbsoluteDeviation,
  percentile,
} from "./schema.ts";
import {
  type CompilerBenchmarkDistribution,
  type CompilerBenchmarkSuiteReport,
  type CompilerBenchmarkSuiteRunScenario,
  type CompilerBenchmarkSuiteScenario,
  compilerBenchmarkSuiteSchema,
  type CompilerBenchmarkSuiteWorkload,
} from "./suite_schema.ts";

export interface CompilerBenchmarkTarget {
  readonly workload: string;
  readonly scenario: string;
}

export interface CompilerBenchmarkThresholds {
  readonly minimumImprovement: number;
  readonly maximumRegression: number;
}

export interface CompilerBenchmarkComparison {
  readonly targetName: string;
  readonly previousMilliseconds: number;
  readonly currentMilliseconds: number;
  readonly improvement: number;
  readonly candidateRunImprovements: readonly number[];
  readonly baselineCompilerArtifactSha256: string;
  readonly candidateCompilerArtifactSha256: string;
}

function scenarioNames(
  scenarios: readonly CompilerBenchmarkSuiteScenario[],
): readonly CompilerBenchmarkClass[] {
  return scenarios.map((scenario) => scenario.name);
}

function requireEqual<T>(
  previous: T,
  current: T,
  evidence: string,
): void {
  if (JSON.stringify(previous) !== JSON.stringify(current)) {
    throw new Error(`${evidence} differs between benchmark suites`);
  }
}

function requireUnique(names: readonly string[], evidence: string): void {
  if (new Set(names).size !== names.length) {
    throw new Error(`${evidence} contains duplicate names`);
  }
}

function validateDistribution(
  current: CompilerBenchmarkDistribution,
  evidence: string,
): void {
  for (
    const [name, milliseconds] of [
      ["p50", current.p50Milliseconds],
      ["MAD", current.madMilliseconds],
      ["p90", current.p90Milliseconds],
      ["p95", current.p95Milliseconds],
    ] as const
  ) {
    if (
      typeof milliseconds !== "number" || !Number.isFinite(milliseconds) ||
      milliseconds < 0
    ) {
      throw new Error(
        `${evidence} ${name} is not a finite non-negative number`,
      );
    }
  }
  if (current.p50Milliseconds === 0) {
    throw new Error(`${evidence} p50 must be positive`);
  }
  if (
    current.p50Milliseconds > current.p90Milliseconds ||
    current.p90Milliseconds > current.p95Milliseconds
  ) {
    throw new Error(`${evidence} percentiles are not ordered`);
  }
}

function validateSamples(
  current: CompilerBenchmarkSuiteRunScenario,
  sampleCount: number,
  evidence: string,
): void {
  if (
    !Array.isArray(current.samples) || current.samples.length !== sampleCount
  ) {
    let actualCount = "no";
    if (Array.isArray(current.samples)) {
      actualCount = String(current.samples.length);
    }
    throw new Error(
      `${evidence} has ${actualCount} raw samples, expected ${sampleCount}`,
    );
  }
  if (
    current.samples.some((sample) =>
      typeof sample !== "number" || !Number.isFinite(sample) || sample < 0
    )
  ) {
    throw new Error(`${evidence} has an invalid raw duration`);
  }
  validateDistributionMatches(current, current.samples, evidence);
}

function validateDistributionMatches(
  current: CompilerBenchmarkDistribution,
  samples: readonly number[],
  evidence: string,
): void {
  const expected: CompilerBenchmarkDistribution = {
    p50Milliseconds: percentile(samples, 0.5),
    madMilliseconds: medianAbsoluteDeviation(samples),
    p90Milliseconds: percentile(samples, 0.9),
    p95Milliseconds: percentile(samples, 0.95),
  };
  if (
    current.p50Milliseconds !== expected.p50Milliseconds ||
    current.madMilliseconds !== expected.madMilliseconds ||
    current.p90Milliseconds !== expected.p90Milliseconds ||
    current.p95Milliseconds !== expected.p95Milliseconds
  ) {
    throw new Error(`${evidence} summary does not match its raw samples`);
  }
}

function validateVersions(
  versions: CompilerBenchmarkVersions,
  suiteName: string,
): void {
  if (
    typeof versions !== "object" || versions === null ||
    typeof versions.node !== "string" || versions.node.length === 0 ||
    typeof versions.v8 !== "string" || versions.v8.length === 0 ||
    !(typeof versions.deno === "string" || versions.deno === null) ||
    !(typeof versions.rust === "string" || versions.rust === null)
  ) {
    throw new Error(`${suiteName} report omitted runtime versions`);
  }
}

function validateEnvironment(
  environment: CompilerBenchmarkEnvironment,
  suiteName: string,
): void {
  if (
    typeof environment !== "object" || environment === null ||
    typeof environment.platform !== "string" ||
    environment.platform.length === 0 ||
    typeof environment.arch !== "string" || environment.arch.length === 0 ||
    !Array.isArray(environment.cpuModels) ||
    environment.cpuModels.length === 0 ||
    environment.cpuModels.some((model) =>
      typeof model !== "string" || model.length === 0
    ) ||
    !Number.isSafeInteger(environment.logicalCpuCount) ||
    environment.logicalCpuCount < 1 ||
    typeof environment.nodeInvocationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(environment.nodeInvocationSha256)
  ) {
    throw new Error(`${suiteName} report omitted its benchmark environment`);
  }
}

function validateWorkload(
  workload: CompilerBenchmarkSuiteWorkload,
  runCount: number,
  sampleCount: number,
  suiteName: string,
): void {
  if (typeof workload.name !== "string" || workload.name.length === 0) {
    throw new Error(`${suiteName} report has a workload without a name`);
  }
  if (typeof workload.path !== "string" || workload.path.length === 0) {
    throw new Error(`${suiteName} workload ${workload.name} omitted its path`);
  }
  if (!/^[0-9a-f]{64}$/.test(workload.graphIdentity)) {
    throw new Error(
      `${suiteName} workload ${workload.name} omitted its graph identity`,
    );
  }
  const aggregateNames = scenarioNames(workload.scenarios);
  requireUnique(aggregateNames, `${suiteName} ${workload.name} scenarios`);
  requireEqual(
    compilerBenchmarkClasses,
    aggregateNames,
    `${suiteName} ${workload.name} scenario matrix`,
  );
  for (const scenario of workload.scenarios) {
    validateDistribution(
      scenario,
      `${suiteName} ${workload.name}:${scenario.name} aggregate`,
    );
  }
  if (
    typeof workload.observations !== "object" ||
    workload.observations === null || Array.isArray(workload.observations)
  ) {
    throw new Error(
      `${suiteName} workload ${workload.name} omitted its observations`,
    );
  }
  if (
    typeof workload.deterministicObservations !== "object" ||
    workload.deterministicObservations === null ||
    Array.isArray(workload.deterministicObservations)
  ) {
    throw new Error(
      `${suiteName} workload ${workload.name} omitted its deterministic observations`,
    );
  }
  const observationNames = Object.keys(workload.observations).sort();
  const deterministicNames = Object.keys(
    workload.deterministicObservations,
  ).sort();
  const expectedNames = [...compilerBenchmarkClasses].sort();
  requireEqual(
    expectedNames,
    observationNames,
    `${suiteName} ${workload.name} observation matrix`,
  );
  requireEqual(
    expectedNames,
    deterministicNames,
    `${suiteName} ${workload.name} deterministic matrix`,
  );
  for (const name of compilerBenchmarkClasses) {
    if (typeof workload.observations[name] !== "string") {
      throw new Error(
        `${suiteName} workload ${workload.name} observation ${name} is not a string`,
      );
    }
    if (typeof workload.deterministicObservations[name] !== "string") {
      throw new Error(
        `${suiteName} workload ${workload.name} deterministic observation ${name} is not a string`,
      );
    }
  }
  if (workload.runs.length !== runCount) {
    throw new Error(
      `${suiteName} workload ${workload.name} has ${workload.runs.length} runs, expected ${runCount}`,
    );
  }
  for (const [index, run] of workload.runs.entries()) {
    const currentNames = scenarioNames(run.scenarios);
    requireUnique(
      currentNames,
      `${suiteName} ${workload.name} run ${index + 1} scenarios`,
    );
    requireEqual(
      aggregateNames,
      currentNames,
      `${suiteName} ${workload.name} run ${index + 1} scenario matrix`,
    );
    for (const scenario of run.scenarios) {
      validateDistribution(
        scenario,
        `${suiteName} ${workload.name}:${scenario.name} run ${index + 1}`,
      );
      validateSamples(
        scenario,
        sampleCount,
        `${suiteName} ${workload.name}:${scenario.name} run ${index + 1}`,
      );
    }
  }
  for (const aggregate of workload.scenarios) {
    const samples = workload.runs.flatMap((run) => {
      const scenario = run.scenarios.find((candidate) =>
        candidate.name === aggregate.name
      );
      if (scenario === undefined) {
        throw new Error(
          `${suiteName} ${workload.name} run omitted ${aggregate.name}`,
        );
      }
      return scenario.samples;
    });
    validateDistributionMatches(
      aggregate,
      samples,
      `${suiteName} ${workload.name}:${aggregate.name} aggregate`,
    );
  }
}

function validateSuite(
  report: CompilerBenchmarkSuiteReport,
  suiteName: string,
): void {
  if (report.schema !== compilerBenchmarkSuiteSchema) {
    throw new Error(
      `${suiteName} report has schema ${report.schema}, expected ${compilerBenchmarkSuiteSchema}`,
    );
  }
  if (!Number.isSafeInteger(report.runCount) || report.runCount < 3) {
    throw new Error(`${suiteName} report requires at least 3 runs`);
  }
  if (
    !Number.isSafeInteger(report.sampleCount) || report.sampleCount < 1 ||
    report.sampleCount % 2 === 0
  ) {
    throw new Error(`${suiteName} report has an invalid sample count`);
  }
  if (
    typeof report.commit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(report.commit)
  ) {
    throw new Error(`${suiteName} report omitted its commit`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.hostInputsSha256)) {
    throw new Error(`${suiteName} report omitted host-input identity`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.benchmarkInputsSha256)) {
    throw new Error(`${suiteName} report omitted benchmark-input identity`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.compilerArtifactSha256)) {
    throw new Error(`${suiteName} report omitted compiler artifact identity`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.compilerManifestSha256)) {
    throw new Error(`${suiteName} report omitted compiler manifest identity`);
  }
  for (
    const [name, identity] of [
      ["compiler inputs", report.compilerInputsSha256],
      ["prelude", report.compilerPreludeSha256],
    ]
  ) {
    if (!/^[0-9a-f]{64}$/.test(identity)) {
      throw new Error(`${suiteName} report omitted ${name} identity`);
    }
  }
  for (
    const [name, identity] of [
      ["compiler source commit", report.compilerSourceCommit],
      ["compiler source tree", report.compilerSourceTree],
    ]
  ) {
    if (!/^[0-9a-f]{40,64}$/.test(identity)) {
      throw new Error(`${suiteName} report omitted ${name}`);
    }
  }
  if (!/^rustc [0-9]+\.[0-9]+\.[0-9]+/.test(report.compilerRustc)) {
    throw new Error(`${suiteName} report omitted compiler toolchain`);
  }
  validateVersions(report.versions, suiteName);
  validateEnvironment(report.environment, suiteName);
  const workloadNames = report.workloads.map((workload) => workload.name);
  requireUnique(workloadNames, `${suiteName} workloads`);
  if (workloadNames.length === 0) {
    throw new Error(`${suiteName} report has no workloads`);
  }
  for (const workload of report.workloads) {
    validateWorkload(
      workload,
      report.runCount,
      report.sampleCount,
      suiteName,
    );
  }
}

function scenarioMap(
  report: CompilerBenchmarkSuiteReport,
): Map<string, CompilerBenchmarkSuiteScenario> {
  const scenarios = new Map<string, CompilerBenchmarkSuiteScenario>();
  for (const workload of report.workloads) {
    for (const scenario of workload.scenarios) {
      scenarios.set(`${workload.name}:${scenario.name}`, scenario);
    }
  }
  return scenarios;
}

function targetRuns(
  report: CompilerBenchmarkSuiteReport,
  target: CompilerBenchmarkTarget,
): readonly CompilerBenchmarkSuiteScenario[] {
  const workload = report.workloads.find((candidate) =>
    candidate.name === target.workload
  );
  if (workload === undefined) {
    throw new Error(`comparison report omitted workload ${target.workload}`);
  }
  return workload.runs.map((run) => {
    const scenario = run.scenarios.find((candidate) =>
      candidate.name === target.scenario
    );
    if (scenario === undefined) {
      throw new Error(
        `comparison report omitted target ${target.workload}:${target.scenario}`,
      );
    }
    return scenario;
  });
}

function noiseThreshold(
  baseline: CompilerBenchmarkDistribution,
  candidate: CompilerBenchmarkDistribution,
): number {
  return 3 * Math.max(
    baseline.madMilliseconds,
    candidate.madMilliseconds,
  );
}

function requireComparableSuites(
  baseline: CompilerBenchmarkSuiteReport,
  candidate: CompilerBenchmarkSuiteReport,
): void {
  validateSuite(baseline, "baseline");
  validateSuite(candidate, "candidate");
  requireEqual(baseline.runCount, candidate.runCount, "run count");
  requireEqual(baseline.sampleCount, candidate.sampleCount, "sample count");
  requireEqual(baseline.versions, candidate.versions, "toolchain versions");
  requireEqual(
    baseline.environment,
    candidate.environment,
    "benchmark environment",
  );
  requireEqual(
    baseline.benchmarkInputsSha256,
    candidate.benchmarkInputsSha256,
    "benchmark inputs",
  );
  requireEqual(
    baseline.compilerRustc,
    candidate.compilerRustc,
    "compiler build toolchain",
  );
  requireEqual(
    baseline.workloads.map((workload) => workload.name),
    candidate.workloads.map((workload) => workload.name),
    "workload matrix",
  );
  for (const [index, previousWorkload] of baseline.workloads.entries()) {
    const currentWorkload = candidate.workloads[index];
    if (currentWorkload === undefined) {
      throw new Error(`candidate report omitted ${previousWorkload.name}`);
    }
    requireEqual(
      previousWorkload.path,
      currentWorkload.path,
      `${previousWorkload.name} stable path`,
    );
    requireEqual(
      previousWorkload.graphIdentity,
      currentWorkload.graphIdentity,
      `${previousWorkload.name} source graph`,
    );
    requireEqual(
      scenarioNames(previousWorkload.scenarios),
      scenarioNames(currentWorkload.scenarios),
      `${previousWorkload.name} scenario matrix`,
    );
  }
  const sameCompilerBuildInputs =
    baseline.compilerInputsSha256 === candidate.compilerInputsSha256 &&
    baseline.compilerPreludeSha256 === candidate.compilerPreludeSha256 &&
    baseline.compilerSourceTree === candidate.compilerSourceTree &&
    baseline.compilerRustc === candidate.compilerRustc;
  if (
    sameCompilerBuildInputs &&
    baseline.compilerArtifactSha256 !== candidate.compilerArtifactSha256
  ) {
    throw new Error(
      "the same compiler build inputs produced different compiler artifacts",
    );
  }
  const sameCompilerManifestFields =
    baseline.compilerArtifactSha256 === candidate.compilerArtifactSha256 &&
    baseline.compilerInputsSha256 === candidate.compilerInputsSha256 &&
    baseline.compilerPreludeSha256 === candidate.compilerPreludeSha256 &&
    baseline.compilerSourceCommit === candidate.compilerSourceCommit &&
    baseline.compilerSourceTree === candidate.compilerSourceTree &&
    baseline.compilerRustc === candidate.compilerRustc;
  if (
    sameCompilerManifestFields &&
    baseline.compilerManifestSha256 !== candidate.compilerManifestSha256
  ) {
    throw new Error(
      "the same compiler manifest fields produced different manifest bytes",
    );
  }
  if (
    !sameCompilerManifestFields &&
    baseline.compilerManifestSha256 === candidate.compilerManifestSha256
  ) {
    throw new Error(
      "different compiler manifest fields retained one manifest identity",
    );
  }
}

export function compareCompilerBenchmarkSuites(
  baseline: CompilerBenchmarkSuiteReport,
  candidate: CompilerBenchmarkSuiteReport,
  target: CompilerBenchmarkTarget,
  thresholds: CompilerBenchmarkThresholds,
): CompilerBenchmarkComparison {
  if (
    !Number.isFinite(thresholds.minimumImprovement) ||
    thresholds.minimumImprovement < 0
  ) {
    throw new Error("minimum improvement must be a finite non-negative number");
  }
  if (
    !Number.isFinite(thresholds.maximumRegression) ||
    thresholds.maximumRegression < 0
  ) {
    throw new Error("maximum regression must be a finite non-negative number");
  }
  requireComparableSuites(baseline, candidate);
  const baselineScenarios = scenarioMap(baseline);
  const candidateScenarios = scenarioMap(candidate);
  for (const currentWorkload of candidate.workloads) {
    const previousWorkload = baseline.workloads.find((workload) =>
      workload.name === currentWorkload.name
    );
    if (previousWorkload === undefined) {
      throw new Error(`baseline report omitted ${currentWorkload.name}`);
    }
    for (const scenario of compilerBenchmarkClasses) {
      if (
        previousWorkload.observations[scenario] !==
          currentWorkload.observations[scenario]
      ) {
        throw new Error(
          `${currentWorkload.name}:${scenario} public observation changed`,
        );
      }
      if (
        previousWorkload.deterministicObservations[scenario] !==
          currentWorkload.deterministicObservations[scenario]
      ) {
        throw new Error(
          `${currentWorkload.name}:${scenario} deterministic work changed`,
        );
      }
    }
  }
  const regressions: string[] = [];
  const targetName = `${target.workload}:${target.scenario}`;
  for (const [name, current] of candidateScenarios) {
    const previous = baselineScenarios.get(name);
    if (previous === undefined) {
      throw new Error(`baseline report omitted ${name}`);
    }
    const increase = current.p50Milliseconds - previous.p50Milliseconds;
    const regression = increase / previous.p50Milliseconds;
    if (
      regression > thresholds.maximumRegression &&
      increase > noiseThreshold(previous, current)
    ) {
      regressions.push(
        `${name} aggregate regressed ${(regression * 100).toFixed(1)}% (${
          previous.p50Milliseconds.toFixed(3)
        } -> ${current.p50Milliseconds.toFixed(3)} ms)`,
      );
    }
  }
  for (const workload of candidate.workloads) {
    for (const [runIndex, run] of workload.runs.entries()) {
      for (const current of run.scenarios) {
        const name = `${workload.name}:${current.name}`;
        if (name === targetName) continue;
        const previous = baselineScenarios.get(name);
        if (previous === undefined) {
          throw new Error(`baseline report omitted ${name}`);
        }
        const increase = current.p50Milliseconds - previous.p50Milliseconds;
        const regression = increase / previous.p50Milliseconds;
        if (
          regression > thresholds.maximumRegression &&
          increase > noiseThreshold(previous, current)
        ) {
          regressions.push(
            `${name} run ${runIndex + 1} regressed ${
              (regression * 100).toFixed(1)
            }% (${previous.p50Milliseconds.toFixed(3)} -> ${
              current.p50Milliseconds.toFixed(3)
            } ms)`,
          );
        }
      }
    }
  }
  const previousTarget = baselineScenarios.get(targetName);
  const currentTarget = candidateScenarios.get(targetName);
  if (previousTarget === undefined || currentTarget === undefined) {
    throw new Error(`comparison reports omitted target ${targetName}`);
  }
  const saved = previousTarget.p50Milliseconds - currentTarget.p50Milliseconds;
  const improvement = saved / previousTarget.p50Milliseconds;
  const currentRuns = targetRuns(candidate, target);
  const candidateRunImprovements = currentRuns.map((current) =>
    (previousTarget.p50Milliseconds - current.p50Milliseconds) /
    previousTarget.p50Milliseconds
  );
  const insignificantImprovement =
    saved <= noiseThreshold(previousTarget, currentTarget);
  const insignificantCandidateRun = currentRuns.some((current) => {
    const runSaved = previousTarget.p50Milliseconds - current.p50Milliseconds;
    return runSaved <= noiseThreshold(previousTarget, current);
  });
  if (
    improvement < thresholds.minimumImprovement ||
    insignificantImprovement ||
    insignificantCandidateRun ||
    candidateRunImprovements.some((runImprovement) =>
      runImprovement < thresholds.minimumImprovement
    )
  ) {
    throw new Error(
      `${targetName} improved only ${(improvement * 100).toFixed(1)}% (${
        previousTarget.p50Milliseconds.toFixed(3)
      } -> ${
        currentTarget.p50Milliseconds.toFixed(3)
      } ms); candidate runs against the aggregate baseline: ${
        candidateRunImprovements.map((runImprovement) =>
          `${(runImprovement * 100).toFixed(1)}%`
        ).join(", ")
      }`,
    );
  }
  if (regressions.length > 0) {
    throw new Error(regressions.join("\n"));
  }
  return {
    targetName,
    previousMilliseconds: previousTarget.p50Milliseconds,
    currentMilliseconds: currentTarget.p50Milliseconds,
    improvement,
    candidateRunImprovements,
    baselineCompilerArtifactSha256: baseline.compilerArtifactSha256,
    candidateCompilerArtifactSha256: candidate.compilerArtifactSha256,
  };
}
