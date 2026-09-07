import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const runner = resolve("scripts/node_regression_tests.mjs");
const compatibility = resolve("src/node/deno_test_compat.mjs");

async function withFixture(
  source: string,
  run: (directory: string) => void,
): Promise<void> {
  // Keep the fixture below the workspace so --import tsx resolves the same
  // installed loader, but hide it from the outer regression discovery.
  const directory = await mkdtemp(resolve(".regression-runner-"));
  try {
    await mkdir(join(directory, "src", "node"), { recursive: true });
    await copyFile(
      compatibility,
      join(directory, "src", "node", "deno_test_compat.mjs"),
    );
    await writeFile(join(directory, "a.test.ts"), source);
    await writeFile(
      join(directory, "b.test.ts"),
      'Deno.test("later file ran", () => {});\n',
    );
    run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runFixture(directory: string, timeoutMs: string) {
  const env = { ...process.env };
  env.BLOT_TEST_TIMEOUT_MS = timeoutMs;
  // This is a standalone runner invocation, not another test child of this
  // file. Inheriting Node's internal context would skip the fixture tests.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
}

test("regression runner reports each file and preserves successful exits", async () => {
  await withFixture('Deno.test("first file ran", () => {});\n', (directory) => {
    const result = runFixture(directory, "5000");
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[1\/2\] a\.test\.ts \(timeout 5000ms\)/);
    assert.match(result.stdout, /\[2\/2\] b\.test\.ts/);
    assert.match(result.stdout, /later file ran/);
  });
});

test("regression runner fails instead of stalling on synchronous compiler work", async () => {
  await withFixture(
    'Deno.test("blocked", () => { console.log("entered loop"); while (true) {} });\n',
    (directory) => {
      const result = runFixture(directory, "2000");
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /entered loop/);
      assert.match(result.stdout, /timed out after 2000ms/);
      assert.match(result.stderr, /Regression test failed: a\.test\.ts/);
      assert.doesNotMatch(result.stdout, /later file ran|\[2\/2\]/);
    },
  );
});

test("regression runner preserves assertion failures and stops before later files", async () => {
  await withFixture(
    'Deno.test("failure", () => { throw new Error("intentional failure"); });\n',
    (directory) => {
      const result = runFixture(directory, "5000");
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /intentional failure/);
      assert.match(result.stderr, /Regression test failed: a\.test\.ts/);
      assert.doesNotMatch(result.stdout, /later file ran|\[2\/2\]/);
    },
  );
});

test("regression runner rejects invalid deadlines before running tests", async () => {
  await withFixture('Deno.test("first file ran", () => {});\n', (directory) => {
    for (const value of ["", "0", "-1", "1.5", "Infinity", "2147483648"]) {
      const result = runFixture(directory, value);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /BLOT_TEST_TIMEOUT_MS/);
      assert.doesNotMatch(result.stdout, /first file ran|\[1\/2\]/);
    }
  });
});
