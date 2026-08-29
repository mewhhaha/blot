import { spawnSync } from "node:child_process";
import { discoverRegressionTests } from "./regression_test_discovery.mjs";

const tests = await discoverRegressionTests(".");

for (const test of tests) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./src/node/deno_test_compat.mjs",
      "--import",
      "tsx",
      "--test",
      test,
    ],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status === null) {
    throw new Error(`Node regression test ${test} was terminated`);
  }
  if (result.status !== 0) {
    process.exitCode = result.status;
    break;
  }
}
