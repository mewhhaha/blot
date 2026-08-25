import { readFile } from "node:fs/promises";
import {
  compareCompilerBenchmarkSuites,
  type CompilerBenchmarkTarget,
} from "./comparison.ts";
import { benchmarkInputsIdentity } from "./provenance.ts";
import type { CompilerBenchmarkSuiteReport } from "./suite_schema.ts";

const commandArguments = process.argv.slice(2).filter((argument) =>
  argument !== "--"
);

function target(argument: string | undefined): CompilerBenchmarkTarget {
  if (argument === undefined) {
    return { workload: "minimal", scenario: "cold-compiler" };
  }
  const separator = argument.indexOf(":");
  if (separator < 1 || separator === argument.length - 1) {
    throw new Error("--target must be WORKLOAD:SCENARIO");
  }
  return {
    workload: argument.slice(0, separator),
    scenario: argument.slice(separator + 1),
  };
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const argument = commandArguments.slice(2).find((candidate) =>
    candidate.startsWith(prefix)
  );
  if (argument === undefined) return undefined;
  return argument.slice(prefix.length);
}

async function report(
  path: string | undefined,
): Promise<CompilerBenchmarkSuiteReport> {
  if (path === undefined) {
    throw new Error(
      "compiler comparison requires baseline and candidate reports",
    );
  }
  return JSON.parse(
    await readFile(path, "utf8"),
  ) as CompilerBenchmarkSuiteReport;
}

async function main(): Promise<void> {
  const baseline = await report(commandArguments[0]);
  const candidate = await report(commandArguments[1]);
  const currentBenchmarkInputs = await benchmarkInputsIdentity();
  if (
    baseline.benchmarkInputsSha256 !== currentBenchmarkInputs ||
    candidate.benchmarkInputsSha256 !== currentBenchmarkInputs
  ) {
    throw new Error(
      "comparison reports were produced by different benchmark inputs",
    );
  }
  const selectedTarget = target(option("target"));
  let minimumImprovementSource = option("minimum-improvement");
  if (minimumImprovementSource === undefined) minimumImprovementSource = "0.10";
  let maximumRegressionSource = option("maximum-regression");
  if (maximumRegressionSource === undefined) maximumRegressionSource = "0.05";
  const minimumImprovement = Number(minimumImprovementSource);
  const maximumRegression = Number(maximumRegressionSource);
  if (!Number.isFinite(minimumImprovement) || minimumImprovement < 0) {
    throw new Error("--minimum-improvement must be a non-negative number");
  }
  if (!Number.isFinite(maximumRegression) || maximumRegression < 0) {
    throw new Error("--maximum-regression must be a non-negative number");
  }
  const comparison = compareCompilerBenchmarkSuites(
    baseline,
    candidate,
    selectedTarget,
    { minimumImprovement, maximumRegression },
  );
  process.stdout.write(
    `${comparison.targetName} improved ${
      (comparison.improvement * 100).toFixed(1)
    }% (${comparison.previousMilliseconds.toFixed(3)} -> ${
      comparison.currentMilliseconds.toFixed(3)
    } ms; candidate runs against the aggregate baseline ${
      comparison.candidateRunImprovements.map((runImprovement) =>
        `${(runImprovement * 100).toFixed(1)}%`
      ).join(", ")
    }); compiler ${comparison.baselineCompilerArtifactSha256.slice(0, 12)} -> ${
      comparison.candidateCompilerArtifactSha256.slice(0, 12)
    }; no significant regression exceeded ${
      (maximumRegression * 100).toFixed(0)
    }%.\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exitCode = 1;
});
