import { spawnSync } from "node:child_process";
import { discoverRegressionTests } from "./regression_test_discovery.mjs";

// The parent enforces this deadline even when synchronous compiler Wasm
// blocks Node's test runner. Each file runs in the directly killable child.
let timeoutMs = 300_000;
const configuredTimeout = process.env.BLOT_TEST_TIMEOUT_MS;
if (configuredTimeout !== undefined) {
  if (!/^[1-9][0-9]*$/.test(configuredTimeout)) {
    throw new Error("BLOT_TEST_TIMEOUT_MS must be a positive integer");
  }
  timeoutMs = Number(configuredTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw new Error("BLOT_TEST_TIMEOUT_MS exceeds the supported timer range");
  }
}

const tests = await discoverRegressionTests(".");
if (tests.length === 0) {
  throw new Error(
    "No regression tests were discovered; refusing an empty successful run.",
  );
}

for (const [index, test] of tests.entries()) {
  console.log(
    `[${index + 1}/${tests.length}] ${test} (timeout ${timeoutMs}ms)`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./src/node/deno_test_compat.mjs",
      "--import",
      "tsx",
      "--test",
      "--test-isolation=none",
      `--test-timeout=${timeoutMs}`,
      test,
    ],
    { stdio: "inherit", timeout: timeoutMs, killSignal: "SIGKILL" },
  );
  if (result.error?.code === "ETIMEDOUT") {
    console.log(`Test timed out after ${timeoutMs}ms`);
    console.error(`Regression test failed: ${test} (timeout)`);
    process.exitCode = 1;
    break;
  }
  if (result.error !== undefined) throw result.error;
  if (result.status === null) {
    throw new Error(`Node regression test ${test} was terminated`);
  }
  if (result.status !== 0) {
    console.error(`Regression test failed: ${test} (exit ${result.status})`);
    process.exitCode = result.status;
    break;
  }
}
