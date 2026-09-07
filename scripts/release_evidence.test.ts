import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { CompilerArtifactManifest } from "../src/compiler/artifact.ts";
import { checkReleaseEvidence } from "./release_evidence.ts";

const commit = "a".repeat(40);
const compiler: CompilerArtifactManifest = {
  schema: "blot-rust-compiler-artifact",
  version: 3,
  file: "compiler.wasm",
  bytes: 8,
  sha256: "b".repeat(64),
  hostAbi: 6,
  preludeSha256: "c".repeat(64),
  compilerInputsSha256: "d".repeat(64),
  profile: "production",
  sourceCommit: commit,
  sourceTree: "e".repeat(40),
  rustc: "rustc 1.97.1",
};

async function fixture() {
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const jobs = [];
  for (const [index, name] of ["formal", "check"].entries()) {
    const begin = workflow.indexOf(`  ${name}:\n`);
    assert.notEqual(begin, -1);
    let end = workflow.indexOf("\n  check:\n", begin + 1);
    if (end === -1) end = workflow.length;
    const section = workflow.slice(begin, end);
    const names = [
      ...section.matchAll(/^ {6}- name: (.+)$/gm),
    ].map((match) => match[1]);
    for (const match of section.matchAll(/^ {6}- run: (.+)$/gm)) {
      names.push(`Run ${match[1]}`);
    }
    jobs.push({
      id: index + 1,
      name,
      run_id: 10,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      steps: names.map((step) => ({
        name: step,
        status: "completed",
        conclusion: "success",
      })),
    });
  }
  return {
    run: {
      id: 10,
      run_attempt: 1,
      head_sha: commit,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/ci.yml",
      event: "push",
    },
    jobs: { total_count: jobs.length, jobs },
  };
}

test("release evidence requires the actual mandatory workflow steps", async () => {
  const { run, jobs } = await fixture();
  const evidence = checkReleaseEvidence(commit, run, jobs, compiler);
  assert.equal(evidence.commit, commit);
  assert.equal(evidence.compilerSha256, compiler.sha256);
  assert.deepEqual(evidence.jobs.map((job) => job.name), ["formal", "check"]);
});

test("old green runs, old binaries, pending runs, and PR merge candidates are refused", async () => {
  const { run, jobs } = await fixture();
  for (
    const override of [
      { head_sha: "f".repeat(40) },
      { status: "in_progress" },
      { conclusion: "failure" },
      { event: "pull_request" },
      { path: ".github/workflows/abstraction-contracts.yml" },
    ]
  ) {
    assert.throws(() =>
      checkReleaseEvidence(commit, { ...run, ...override }, jobs, compiler)
    );
  }
  assert.throws(() =>
    checkReleaseEvidence(commit, run, jobs, {
      ...compiler,
      sourceCommit: "f".repeat(40),
    })
  );
  assert.throws(() =>
    checkReleaseEvidence(commit, run, jobs, {
      ...compiler,
      profile: "development-profile",
    })
  );
});

test("partial pagination, a different attempt, skipped tests, and duplicate jobs fail closed", async () => {
  let data = await fixture();
  data.jobs.total_count += 1;
  assert.throws(
    () => checkReleaseEvidence(commit, data.run, data.jobs, compiler),
    /incomplete/,
  );
  data = await fixture();
  data.jobs.jobs[1].run_attempt = 2;
  assert.throws(
    () => checkReleaseEvidence(commit, data.run, data.jobs, compiler),
    /attempt/,
  );
  data = await fixture();
  const native = data.jobs.jobs[1].steps.find((step) =>
    step.name === "Test Rust compiler"
  );
  assert.ok(native);
  native.conclusion = "skipped";
  assert.throws(
    () => checkReleaseEvidence(commit, data.run, data.jobs, compiler),
    /mandatory step/,
  );
  data = await fixture();
  data.jobs.jobs.push(data.jobs.jobs[1]);
  data.jobs.total_count += 1;
  assert.throws(
    () => checkReleaseEvidence(commit, data.run, data.jobs, compiler),
    /exactly one check/,
  );
});

test("release evidence requires every bounded test stage to succeed", async () => {
  for (
    const name of [
      "Test Node host",
      "Test regression suite",
      "Test compiler and runtime conformance",
      "Verify runtime conformance",
    ]
  ) {
    const { run, jobs } = await fixture();
    const stage = jobs.jobs[1].steps.find((step) => step.name === name);
    assert.ok(stage, `missing workflow stage ${name}`);
    for (const conclusion of ["skipped", "cancelled", "failure"]) {
      stage.conclusion = conclusion;
      assert.throws(
        () => checkReleaseEvidence(commit, run, jobs, compiler),
        /mandatory step/,
      );
    }
    jobs.jobs[1].steps = jobs.jobs[1].steps.filter((step) => step !== stage);
    assert.throws(
      () => checkReleaseEvidence(commit, run, jobs, compiler),
      /mandatory step/,
    );
  }
});
