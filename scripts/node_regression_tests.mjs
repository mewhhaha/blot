import { spawnSync } from "node:child_process";
import { discoverRegressionTests } from "./regression_test_discovery.mjs";

const tests = await discoverRegressionTests(".");

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./src/node/deno_test_compat.mjs",
    "--import",
    "tsx",
    "--test",
    ...tests,
  ],
  { stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
if (result.status === null) {
  throw new Error("Node regression tests were terminated");
}
process.exitCode = result.status;
