import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CompilerArtifactManifest,
  decodeCompilerArtifactManifest,
  validateCompilerArtifact,
} from "../src/compiler/artifact.ts";

const requiredSteps = {
  formal: [
    "Check stable Core metatheory",
    "Reject admitted formal declarations",
  ],
  check: [
    "Rebuild Rust compiler Wasm",
    "Check tracked prelude snapshot freshness",
    "Verify packed npm package on minimum supported Node",
    "Check Rust formatting",
    "Check generated-code Rust formatting",
    "Check Rust lint",
    "Test Rust compiler",
    "Deterministic compiler performance gates",
    "Check TypeScript",
    "Check current implementation manifest",
    "Check formatting",
    "Check lint",
    "Verify generated frontend artifacts",
    "Verify packed Node workspace",
    "Test Node host",
    "Test regression suite",
    "Run pnpm run check",
    "Run pnpm run smoke",
    "Run pnpm blot run examples/node-runner-demo.blot",
    "Test compiler and runtime conformance",
    "Verify runtime conformance",
    "Verify the V8 / Wasm 3 target on Node 24 LTS",
    "Verify the V8 / Wasm 3 target on Node 26 Current",
    "Run pnpm run benchmark -- examples/storage.blot",
    "Verify compiler artifact is derived output",
  ],
} as const;

export interface ReleaseEvidence {
  readonly schema: "blot-release-evidence";
  readonly version: 1;
  readonly commit: string;
  readonly sourceTree: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly compilerSha256: string;
  readonly compilerInputsSha256: string;
  readonly preludeSha256: string;
  readonly jobs: readonly { readonly name: string; readonly id: number }[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/** Validate exact-commit CI snapshots. This is evidence checking, not an attestation. */
export function checkReleaseEvidence(
  commit: string,
  runSnapshot: unknown,
  jobsSnapshot: unknown,
  compiler: CompilerArtifactManifest,
): ReleaseEvidence {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("release commit must be a complete Git commit SHA");
  }
  const run = record(runSnapshot, "workflow run");
  if (
    run.head_sha !== commit || compiler.sourceCommit !== commit ||
    run.status !== "completed" || run.conclusion !== "success"
  ) {
    throw new Error(
      "the complete successful workflow and compiler must match the exact release commit",
    );
  }
  if (
    run.path !== ".github/workflows/ci.yml" ||
    (run.event !== "push" && run.event !== "workflow_dispatch")
  ) {
    throw new Error(
      "release evidence requires standard CI on a frozen commit, not a pull-request merge candidate",
    );
  }
  if (compiler.profile !== "production") {
    throw new Error("release evidence requires a production compiler artifact");
  }
  const runId = positiveInteger(run.id, "run id");
  const runAttempt = positiveInteger(run.run_attempt, "run attempt");
  const jobs = record(jobsSnapshot, "job collection");
  const encodedJobs = array(jobs.jobs, "jobs");
  if (jobs.total_count !== encodedJobs.length) {
    throw new Error(
      "job collection is incomplete; include every page from the latest attempt",
    );
  }
  const selected: Array<{ readonly name: string; readonly id: number }> = [];
  for (const [name, steps] of Object.entries(requiredSteps)) {
    const matches = encodedJobs.map((job) => record(job, "job")).filter((job) =>
      job.name === name
    );
    if (matches.length !== 1) {
      throw new Error(`expected exactly one ${name} job`);
    }
    const job = matches[0];
    if (
      job.run_id !== runId || job.run_attempt !== runAttempt ||
      job.status !== "completed" || job.conclusion !== "success"
    ) {
      throw new Error(`${name} did not succeed on the selected run attempt`);
    }
    const actualSteps = array(job.steps, `${name} steps`).map((step) =>
      record(step, "step")
    );
    for (const required of steps) {
      const found = actualSteps.filter((step) => step.name === required);
      if (
        found.length !== 1 || found[0].status !== "completed" ||
        found[0].conclusion !== "success"
      ) {
        throw new Error(
          `${name}: mandatory step ${JSON.stringify(required)} did not succeed`,
        );
      }
    }
    selected.push({ name, id: positiveInteger(job.id, `${name} job id`) });
  }
  return {
    schema: "blot-release-evidence",
    version: 1,
    commit,
    sourceTree: compiler.sourceTree,
    runId,
    runAttempt,
    compilerSha256: compiler.sha256,
    compilerInputsSha256: compiler.compilerInputsSha256,
    preludeSha256: compiler.preludeSha256,
    jobs: selected,
  };
}

async function main(arguments_: readonly string[]): Promise<void> {
  const options = new Map<string, string>();
  const expected = ["--commit", "--run", "--jobs", "--compiler", "--wasm"];
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!expected.includes(key) || value === undefined || options.has(key)) {
      throw new Error(
        "usage: release_evidence.ts --commit SHA --run run.json --jobs jobs.json --compiler compiler-artifact.json --wasm compiler.wasm",
      );
    }
    options.set(key, value);
  }
  const get = (key: string): string => {
    const value = options.get(key);
    if (value === undefined) throw new Error(`missing ${key}`);
    return value;
  };
  const compiler = decodeCompilerArtifactManifest(
    await readFile(get("--compiler"), "utf8"),
  );
  await validateCompilerArtifact(await readFile(get("--wasm")), compiler, {
    profile: "production",
  });
  const evidence = checkReleaseEvidence(
    get("--commit"),
    JSON.parse(await readFile(get("--run"), "utf8")),
    JSON.parse(await readFile(get("--jobs"), "utf8")),
    compiler,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) message = error.message;
    console.error(`release refused: ${message}`);
    process.exitCode = 1;
  }
}
