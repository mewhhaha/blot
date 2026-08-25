import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCompilerBenchmarkSuites,
  type CompilerBenchmarkTarget,
} from "./comparison.ts";
import {
  type CompilerBenchmarkClass,
  compilerBenchmarkClasses,
  medianAbsoluteDeviation,
  percentile,
} from "./schema.ts";
import {
  type CompilerBenchmarkDistribution,
  type CompilerBenchmarkSuiteReport,
  type CompilerBenchmarkSuiteRun,
  type CompilerBenchmarkSuiteRunScenario,
  type CompilerBenchmarkSuiteScenario,
  compilerBenchmarkSuiteSchema,
} from "./suite_schema.ts";

const target: CompilerBenchmarkTarget = {
  workload: "minimal",
  scenario: "cold-compiler",
};

function samples(
  milliseconds: number,
  deviation = 1,
): readonly number[] {
  return [
    ...Array.from({ length: 15 }, () => milliseconds - deviation),
    milliseconds,
    ...Array.from({ length: 15 }, () => milliseconds + deviation),
  ];
}

function distribution(
  durations: readonly number[],
): CompilerBenchmarkDistribution {
  return {
    p50Milliseconds: percentile(durations, 0.5),
    madMilliseconds: medianAbsoluteDeviation(durations),
    p90Milliseconds: percentile(durations, 0.9),
    p95Milliseconds: percentile(durations, 0.95),
  };
}

function runScenarios(
  targetMilliseconds: number,
): readonly CompilerBenchmarkSuiteRunScenario[] {
  return compilerBenchmarkClasses.map((name) => {
    let milliseconds = 10;
    if (name === target.scenario) milliseconds = targetMilliseconds;
    const durations = samples(milliseconds);
    return { name, samples: durations, ...distribution(durations) };
  });
}

function aggregateScenarios(
  runs: readonly CompilerBenchmarkSuiteRun[],
): readonly CompilerBenchmarkSuiteScenario[] {
  return compilerBenchmarkClasses.map((name) => {
    const durations = runs.flatMap((run) => {
      const scenario = run.scenarios.find((candidate) =>
        candidate.name === name
      );
      assert.ok(scenario !== undefined);
      return scenario.samples;
    });
    return { name, ...distribution(durations) };
  });
}

function runScenario(
  name: CompilerBenchmarkClass,
  milliseconds: number,
  deviation = 1,
): CompilerBenchmarkSuiteRunScenario {
  const durations = samples(milliseconds, deviation);
  return { name, samples: durations, ...distribution(durations) };
}

function observations(): Readonly<Record<CompilerBenchmarkClass, string>> {
  return Object.fromEntries(
    compilerBenchmarkClasses.map((name) => [name, `${name}:unchanged`]),
  ) as Record<CompilerBenchmarkClass, string>;
}

function suite(
  targetMilliseconds: number,
  runMilliseconds: readonly number[],
): CompilerBenchmarkSuiteReport {
  const runs = runMilliseconds.map((milliseconds) => ({
    scenarios: runScenarios(milliseconds),
  }));
  const aggregate = aggregateScenarios(runs);
  assert.equal(
    aggregate.find((scenario) => scenario.name === target.scenario)
      ?.p50Milliseconds,
    targetMilliseconds,
  );
  return {
    schema: compilerBenchmarkSuiteSchema,
    runCount: runMilliseconds.length,
    sampleCount: 31,
    commit: "a".repeat(40),
    hostInputsSha256: "b".repeat(64),
    benchmarkInputsSha256: "7".repeat(64),
    compilerArtifactSha256: "c".repeat(64),
    compilerManifestSha256: "9".repeat(64),
    compilerInputsSha256: "d".repeat(64),
    compilerPreludeSha256: "e".repeat(64),
    compilerSourceCommit: "f".repeat(40),
    compilerSourceTree: "1".repeat(40),
    compilerRustc: "rustc 1.97.1 (test)",
    versions: {
      node: "v24.0.0",
      deno: "deno 2.0.0",
      v8: "13.0",
      rust: "rustc 1.97.1 (test)",
    },
    environment: {
      platform: "linux",
      arch: "x64",
      cpuModels: ["test cpu"],
      logicalCpuCount: 8,
      nodeInvocationSha256: "0".repeat(64),
    },
    workloads: [{
      name: target.workload,
      path: "/stable/minimal.blot",
      graphIdentity: "2".repeat(64),
      observations: observations(),
      deterministicObservations: observations(),
      scenarios: aggregate,
      runs,
    }],
  };
}

test("candidate runs compare with the aggregate baseline", () => {
  const baseline = suite(100, [98, 100, 102]);
  const candidate = suite(80, [80, 85, 75]);

  const compared = compareCompilerBenchmarkSuites(
    baseline,
    candidate,
    target,
    { minimumImprovement: 0.1, maximumRegression: 0.05 },
  );

  assert.deepEqual(compared.candidateRunImprovements, [0.2, 0.15, 0.25]);
});

test("comparison rejects a changed workload graph", () => {
  const baseline = suite(100, [100, 100, 100]);
  const originalWorkload = baseline.workloads[0];
  assert.ok(originalWorkload !== undefined);
  const candidate: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    workloads: [{
      ...structuredClone(originalWorkload),
      graphIdentity: "3".repeat(64),
    }],
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        candidate,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /source graph differs/,
  );
});

test("comparison rejects different artifacts from identical compiler inputs", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    compilerArtifactSha256: "4".repeat(64),
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        candidate,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /same compiler build inputs produced different compiler artifacts/,
  );
});

test("comparison rejects different manifests from identical compiler inputs", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    compilerManifestSha256: "8".repeat(64),
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        candidate,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /same compiler manifest fields produced different manifest bytes/,
  );
});

test("comparison preserves changed compiler provenance", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate: CompilerBenchmarkSuiteReport = {
    ...suite(80, [80, 80, 80]),
    compilerArtifactSha256: "4".repeat(64),
    compilerManifestSha256: "8".repeat(64),
    compilerInputsSha256: "5".repeat(64),
    compilerSourceTree: "6".repeat(40),
  };

  const compared = compareCompilerBenchmarkSuites(
    baseline,
    candidate,
    target,
    { minimumImprovement: 0.1, maximumRegression: 0.05 },
  );
  assert.equal(compared.baselineCompilerArtifactSha256, "c".repeat(64));
  assert.equal(compared.candidateCompilerArtifactSha256, "4".repeat(64));
});

test("comparison rejects changed harness, runtime, and scenario matrices", () => {
  const baseline = suite(100, [100, 100, 100]);
  const changedBenchmark: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    benchmarkInputsSha256: "8".repeat(64),
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        changedBenchmark,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /benchmark inputs differ/,
  );

  const changedVersion: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    versions: { ...baseline.versions, node: "v25.0.0" },
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        changedVersion,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /toolchain versions differ/,
  );

  const changedEnvironment: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    environment: { ...baseline.environment, logicalCpuCount: 4 },
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        changedEnvironment,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /benchmark environment differs/,
  );

  const originalWorkload = baseline.workloads[0];
  assert.ok(originalWorkload !== undefined);
  const changedMatrix: CompilerBenchmarkSuiteReport = {
    ...structuredClone(baseline),
    workloads: [{
      ...structuredClone(originalWorkload),
      scenarios: originalWorkload.scenarios.slice(1),
    }],
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        changedMatrix,
        target,
        { minimumImprovement: 0, maximumRegression: 1 },
      ),
    /scenario matrix differs/,
  );
});

test("comparison rejects invalid timing distributions", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = structuredClone(suite(80, [80, 80, 80]));
  const workload = candidate.workloads[0];
  assert.ok(workload !== undefined);
  const scenario = workload.scenarios[0];
  assert.ok(scenario !== undefined);
  const invalidCandidate: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      scenarios: [
        { ...scenario, madMilliseconds: -1 },
        ...workload.scenarios.slice(1),
      ],
    }],
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        invalidCandidate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /MAD is not a finite non-negative number/,
  );
});

test("comparison rejects zero medians and unordered percentiles", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = suite(80, [80, 80, 80]);
  const zeroWorkload = candidate.workloads[0];
  assert.ok(zeroWorkload !== undefined);
  const zeroRun = zeroWorkload.runs[0];
  assert.ok(zeroRun !== undefined);
  const zeroScenario = zeroRun.scenarios[0];
  assert.ok(zeroScenario !== undefined);
  const zeroMedian: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...zeroWorkload,
      runs: [{
        scenarios: [
          { ...zeroScenario, p50Milliseconds: 0 },
          ...zeroRun.scenarios.slice(1),
        ],
      }, ...zeroWorkload.runs.slice(1)],
    }],
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        zeroMedian,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /p50 must be positive/,
  );

  const unorderedWorkload = candidate.workloads[0];
  assert.ok(unorderedWorkload !== undefined);
  const unorderedScenario = unorderedWorkload.scenarios[0];
  assert.ok(unorderedScenario !== undefined);
  const unordered: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...unorderedWorkload,
      scenarios: [{
        ...unorderedScenario,
        p90Milliseconds: unorderedScenario.p50Milliseconds - 1,
      }, ...unorderedWorkload.scenarios.slice(1)],
    }],
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        unordered,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /percentiles are not ordered/,
  );
});

test("comparison rejects an even sample count", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = { ...suite(80, [80, 80, 80]), sampleCount: 30 };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        candidate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /invalid sample count/,
  );
});

test("comparison rejects a non-string public observation", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = structuredClone(suite(80, [80, 80, 80]));
  const workload = candidate.workloads[0];
  assert.ok(workload !== undefined);
  const invalidCandidate: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      observations: {
        ...workload.observations,
        "cold-process": 1,
      } as unknown as CompilerBenchmarkSuiteReport["workloads"][number][
        "observations"
      ],
    }],
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        invalidCandidate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /observation cold-process is not a string/,
  );
});

test("comparison rejects a non-string deterministic observation", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = structuredClone(suite(80, [80, 80, 80]));
  const workload = candidate.workloads[0];
  assert.ok(workload !== undefined);
  const invalidCandidate: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      deterministicObservations: {
        ...workload.deterministicObservations,
        "cold-process": false,
      } as unknown as CompilerBenchmarkSuiteReport["workloads"][number][
        "deterministicObservations"
      ],
    }],
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        invalidCandidate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /deterministic observation cold-process is not a string/,
  );
});

test("a non-target regression in one candidate run cannot be pooled away", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = suite(80, [80, 80, 80]);
  const workload = candidate.workloads[0];
  assert.ok(workload !== undefined);
  const firstRun = workload.runs[0];
  assert.ok(firstRun !== undefined);
  const slowRuns = [{
    scenarios: firstRun.scenarios.map((scenario) => {
      if (scenario.name !== "resident-unchanged") return scenario;
      return runScenario(scenario.name, 20);
    }),
  }, ...workload.runs.slice(1)];
  const slowCandidate: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      scenarios: aggregateScenarios(slowRuns),
      runs: slowRuns,
    }],
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        slowCandidate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /minimal:resident-unchanged run 1 regressed 100\.0%/,
  );
});

test("candidate target runs must each exceed their measured noise", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = suite(80, [80, 80, 80]);
  const workload = candidate.workloads[0];
  assert.ok(workload !== undefined);
  const firstRun = workload.runs[0];
  assert.ok(firstRun !== undefined);
  const noisyTarget = firstRun.scenarios.find((scenario) =>
    scenario.name === target.scenario
  );
  assert.ok(noisyTarget !== undefined);
  const noisyRuns = [{
    scenarios: firstRun.scenarios.map((scenario) => {
      if (scenario.name !== target.scenario) return scenario;
      return runScenario(scenario.name, 80, 10);
    }),
  }, ...workload.runs.slice(1)];
  const noisyCandidate: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      scenarios: aggregateScenarios(noisyRuns),
      runs: noisyRuns,
    }],
  };

  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        noisyCandidate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /candidate runs against the aggregate baseline/,
  );
});

test("comparison recomputes summaries from every raw duration", () => {
  const baseline = suite(100, [100, 100, 100]);
  const candidate = structuredClone(suite(80, [80, 80, 80]));
  const workload = candidate.workloads[0];
  assert.ok(workload !== undefined);
  const firstRun = workload.runs[0];
  assert.ok(firstRun !== undefined);
  const firstScenario = firstRun.scenarios[0];
  assert.ok(firstScenario !== undefined);

  const missingSample: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      runs: [{
        scenarios: [{
          ...firstScenario,
          samples: firstScenario.samples.slice(1),
        }, ...firstRun.scenarios.slice(1)],
      }, ...workload.runs.slice(1)],
    }],
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        missingSample,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /has 30 raw samples, expected 31/,
  );

  const falseSummary: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      runs: [{
        scenarios: [{
          ...firstScenario,
          p50Milliseconds: firstScenario.p50Milliseconds + 1,
        }, ...firstRun.scenarios.slice(1)],
      }, ...workload.runs.slice(1)],
    }],
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        falseSummary,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /summary does not match its raw samples/,
  );

  const aggregateTarget = workload.scenarios.find((scenario) =>
    scenario.name === target.scenario
  );
  assert.ok(aggregateTarget !== undefined);
  const falseAggregate: CompilerBenchmarkSuiteReport = {
    ...candidate,
    workloads: [{
      ...workload,
      scenarios: workload.scenarios.map((scenario) => {
        if (scenario.name !== target.scenario) return scenario;
        return {
          ...scenario,
          p50Milliseconds: aggregateTarget.p50Milliseconds + 0.5,
        };
      }),
    }],
  };
  assert.throws(
    () =>
      compareCompilerBenchmarkSuites(
        baseline,
        falseAggregate,
        target,
        { minimumImprovement: 0.1, maximumRegression: 0.05 },
      ),
    /aggregate summary does not match its raw samples/,
  );
});
