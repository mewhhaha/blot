import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  type CompilerBenchmarkClass,
  compilerBenchmarkClasses,
  type CompilerBenchmarkEnvironment,
  type CompilerBenchmarkReport,
  type CompilerBenchmarkScenario,
  compilerBenchmarkSchema,
  type CompilerBenchmarkVersions,
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
  type CompilerBenchmarkSuiteWorkload,
} from "./suite_schema.ts";

const exec = promisify(execFile);
const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));

interface Workload {
  readonly name: string;
  readonly path: string;
}

interface Options {
  readonly runs: number;
  readonly samples: number;
  readonly output: string | null;
  readonly workloads: readonly Workload[];
}

interface SuiteProvenance {
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
}

function options(): Options {
  let runs = 3;
  let samples = 31;
  let output: string | null = null;
  const paths: string[] = [];
  for (const argument of process.argv.slice(2)) {
    if (argument === "--") {
      continue;
    } else if (argument.startsWith("--runs=")) {
      runs = Number(argument.slice("--runs=".length));
    } else if (argument.startsWith("--samples=")) {
      samples = Number(argument.slice("--samples=".length));
    } else if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
    } else {
      paths.push(argument);
    }
  }
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples % 2 === 0) {
    throw new Error("--samples must be a positive odd integer");
  }
  let workloads: Workload[];
  if (paths.length === 0) {
    workloads = [
      { name: "minimal", path: resolve("examples/minimal.blot") },
      { name: "terminal", path: resolve("case-studies/terminal/main.blot") },
      { name: "agent", path: resolve("case-studies/agent/main.blot") },
    ];
  } else {
    workloads = paths.map((path) => ({
      name: workloadName(path),
      path: resolve(path),
    }));
  }
  const names = new Set<string>();
  for (const workload of workloads) {
    if (names.has(workload.name)) {
      throw new Error(`compiler suite repeats workload ${workload.name}`);
    }
    names.add(workload.name);
  }
  return { runs, samples, output, workloads };
}

function workloadName(path: string): string {
  const relativePath = relative(process.cwd(), resolve(path));
  if (basename(relativePath) === "main.blot") {
    return basename(dirname(relativePath));
  }
  return basename(relativePath, ".blot");
}

function scenarioDistribution(
  scenarios: readonly CompilerBenchmarkScenario[],
): CompilerBenchmarkDistribution {
  const durations = scenarios.flatMap((scenario) =>
    scenario.samples.map((sample) => sample.durationMilliseconds)
  );
  return {
    p50Milliseconds: percentile(durations, 0.5),
    madMilliseconds: medianAbsoluteDeviation(durations),
    p90Milliseconds: percentile(durations, 0.9),
    p95Milliseconds: percentile(durations, 0.95),
  };
}

function deterministicObservation(
  scenario: CompilerBenchmarkScenario,
  rootPath: string,
): string {
  return JSON.stringify(
    scenario.samples.map((sample) => ({
      sourceBytes: sample.sourceBytes,
      runtimeHirNodes: sample.runtimeHirNodes,
      wasmBytes: sample.wasmBytes,
      checkedModules: sample.checkedModules?.map((path) => {
        if (path === rootPath) return "$root";
        return relative(dirname(rootPath), path);
      }),
      invalidatedImporters: sample.invalidatedImporters?.map((path) => {
        if (path === rootPath) return "$root";
        return relative(dirname(rootPath), path);
      }),
      work: sample.work,
    })),
  );
}

function reportProvenance(
  report: CompilerBenchmarkReport,
  workload: Workload,
  samples: number,
): SuiteProvenance {
  if (report.schema !== compilerBenchmarkSchema) {
    throw new Error(
      `${workload.name} report has schema ${report.schema}, expected ${compilerBenchmarkSchema}`,
    );
  }
  assert.equal(
    report.sourcePath,
    workload.path,
    `${workload.name} source path`,
  );
  assert.equal(report.sampleCount, samples, `${workload.name} sample count`);
  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.name),
    compilerBenchmarkClasses,
    `${workload.name} scenario matrix`,
  );
  for (const scenario of report.scenarios) {
    assert.equal(
      scenario.samples.length,
      samples,
      `${workload.name} ${scenario.name} sample count`,
    );
  }
  if (report.commit === "unknown") {
    throw new Error(`${workload.name} report omitted its commit`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.hostInputsSha256)) {
    throw new Error(`${workload.name} report omitted host-input identity`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.benchmarkInputsSha256)) {
    throw new Error(`${workload.name} report omitted benchmark-input identity`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.compilerArtifactSha256)) {
    throw new Error(
      `${workload.name} report omitted compiler artifact identity`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(report.compilerManifestSha256)) {
    throw new Error(
      `${workload.name} report omitted compiler manifest identity`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(report.compilerInputsSha256)) {
    throw new Error(`${workload.name} report omitted compiler-input identity`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.compilerPreludeSha256)) {
    throw new Error(`${workload.name} report omitted prelude identity`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(report.compilerSourceCommit)) {
    throw new Error(`${workload.name} report omitted compiler source commit`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(report.compilerSourceTree)) {
    throw new Error(`${workload.name} report omitted compiler source tree`);
  }
  if (!/^rustc [0-9]+\.[0-9]+\.[0-9]+/.test(report.compilerRustc)) {
    throw new Error(`${workload.name} report omitted compiler toolchain`);
  }
  if (!/^[0-9a-f]{64}$/.test(report.graphIdentity)) {
    throw new Error(`${workload.name} report omitted source graph identity`);
  }
  return {
    commit: report.commit,
    hostInputsSha256: report.hostInputsSha256,
    benchmarkInputsSha256: report.benchmarkInputsSha256,
    compilerArtifactSha256: report.compilerArtifactSha256,
    compilerManifestSha256: report.compilerManifestSha256,
    compilerInputsSha256: report.compilerInputsSha256,
    compilerPreludeSha256: report.compilerPreludeSha256,
    compilerSourceCommit: report.compilerSourceCommit,
    compilerSourceTree: report.compilerSourceTree,
    compilerRustc: report.compilerRustc,
    versions: report.versions,
    environment: report.environment,
  };
}

async function main(): Promise<void> {
  const selected = options();
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "blot-compiler-suite-"),
  );
  const workloads: CompilerBenchmarkSuiteWorkload[] = [];
  let provenance: SuiteProvenance | undefined;
  try {
    for (const workload of selected.workloads) {
      const reports: CompilerBenchmarkReport[] = [];
      for (let run = 0; run < selected.runs; run += 1) {
        const output = join(temporaryDirectory, `${workload.name}-${run}.json`);
        await exec(process.execPath, [
          "--import",
          "tsx",
          resolve(benchmarkDirectory, "benchmark.ts"),
          workload.path,
          `--samples=${selected.samples}`,
          `--output=${output}`,
        ]);
        reports.push(
          JSON.parse(await readFile(output, "utf8")) as CompilerBenchmarkReport,
        );
      }
      const firstReport = reports[0];
      if (firstReport === undefined) {
        throw new Error(`compiler suite workload ${workload.name} has no runs`);
      }
      const graphIdentity = firstReport.graphIdentity;
      for (const report of reports) {
        const currentProvenance = reportProvenance(
          report,
          workload,
          selected.samples,
        );
        if (provenance === undefined) {
          provenance = currentProvenance;
        } else {
          assert.deepEqual(
            currentProvenance,
            provenance,
            `${workload.name} benchmark provenance changed`,
          );
        }
        assert.equal(
          report.graphIdentity,
          graphIdentity,
          `${workload.name} source graph changed`,
        );
      }
      const observations = Object.fromEntries(
        firstReport.scenarios.map((scenario) => [
          scenario.name,
          scenario.observation,
        ]),
      ) as Record<CompilerBenchmarkClass, string>;
      const deterministicObservations = Object.fromEntries(
        firstReport.scenarios.map((scenario) => [
          scenario.name,
          deterministicObservation(scenario, workload.path),
        ]),
      ) as Record<CompilerBenchmarkClass, string>;
      for (const report of reports) {
        for (const scenario of report.scenarios) {
          assert.equal(
            scenario.observation,
            observations[scenario.name],
            `${workload.name} ${scenario.name} observation changed`,
          );
          assert.equal(
            deterministicObservation(scenario, workload.path),
            deterministicObservations[scenario.name],
            `${workload.name} ${scenario.name} deterministic work changed`,
          );
        }
      }
      const scenarioNames = firstReport.scenarios.map((scenario) =>
        scenario.name
      );
      const scenarios: CompilerBenchmarkSuiteScenario[] = scenarioNames.map(
        (name) => {
          const matching = reports.flatMap((report) =>
            report.scenarios.filter((scenario) => scenario.name === name)
          );
          return { name, ...scenarioDistribution(matching) };
        },
      );
      const runs: CompilerBenchmarkSuiteRun[] = reports.map((report) => ({
        scenarios: report.scenarios.map((scenario) => {
          const samples = scenario.samples.map((sample) =>
            sample.durationMilliseconds
          );
          return {
            name: scenario.name,
            samples,
            ...scenarioDistribution([scenario]),
          } satisfies CompilerBenchmarkSuiteRunScenario;
        }),
      }));
      workloads.push({
        name: workload.name,
        path: workload.path,
        graphIdentity,
        observations,
        deterministicObservations,
        scenarios,
        runs,
      });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
  if (provenance === undefined) {
    throw new Error("compiler suite produced no benchmark provenance");
  }
  const report: CompilerBenchmarkSuiteReport = {
    schema: compilerBenchmarkSuiteSchema,
    runCount: selected.runs,
    sampleCount: selected.samples,
    commit: provenance.commit,
    hostInputsSha256: provenance.hostInputsSha256,
    benchmarkInputsSha256: provenance.benchmarkInputsSha256,
    compilerArtifactSha256: provenance.compilerArtifactSha256,
    compilerManifestSha256: provenance.compilerManifestSha256,
    compilerInputsSha256: provenance.compilerInputsSha256,
    compilerPreludeSha256: provenance.compilerPreludeSha256,
    compilerSourceCommit: provenance.compilerSourceCommit,
    compilerSourceTree: provenance.compilerSourceTree,
    compilerRustc: provenance.compilerRustc,
    versions: provenance.versions,
    environment: provenance.environment,
    workloads,
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (selected.output === null) {
    process.stdout.write(encoded);
  } else {
    await writeFile(selected.output, encoded);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exitCode = 1;
});
