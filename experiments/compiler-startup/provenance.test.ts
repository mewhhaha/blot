import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  startupBenchmarkInputsIdentity,
  startupHostInputsIdentity,
  startupSourceGraphIdentity,
} from "./provenance.ts";
import {
  compilerStartupChildExecArgv,
  compilerStartupNodeInvocationSha256,
} from "./invocation.ts";

const exec = promisify(execFile);
const nodeExecutable = "node";

test("startup source graph identity covers source and prelude snapshot", () => {
  const initial = startupSourceGraphIdentity(
    "return 1\n",
    "a".repeat(64),
  );

  assert.notEqual(
    startupSourceGraphIdentity("return 2\n", "a".repeat(64)),
    initial,
  );
  assert.notEqual(
    startupSourceGraphIdentity("return 1\n", "b".repeat(64)),
    initial,
  );
});

test("startup input identities cover the harness and current host worktree", async () => {
  const [benchmark, host] = await Promise.all([
    startupBenchmarkInputsIdentity(),
    startupHostInputsIdentity(),
  ]);

  assert.match(benchmark, /^[0-9a-f]{64}$/);
  assert.match(host, /^[0-9a-f]{64}$/);
});

test("startup child observes the Node flags recorded by provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-startup-invocation-"));
  const probe = join(directory, "probe.mjs");
  try {
    await writeFile(
      probe,
      "process.stdout.write(JSON.stringify(process.execArgv));\n",
    );
    const { stdout } = await exec(nodeExecutable, [
      ...compilerStartupChildExecArgv,
      probe,
    ]);

    assert.deepEqual(JSON.parse(stdout), compilerStartupChildExecArgv);
    assert.match(
      compilerStartupNodeInvocationSha256(process.env.NODE_OPTIONS),
      /^[0-9a-f]{64}$/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
