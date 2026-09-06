import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const suites = [
  "src/node/refactoring.test.ts",
  "src/node/predicate_helpers.test.ts",
  "src/node/host.test.ts",
  "src/node/live_report_host.test.ts",
  "src/node/run.test.ts",
  "src/node/cli_tools.test.ts",
  "src/node/explain.test.ts",
  "src/node/report.test.ts",
  "scripts/release_evidence.test.ts",
  "src/node/residual_identity.test.ts",
  "src/node/inline_products.test.ts",
  "src/node/language_claims.test.ts",
  "case-studies/live-report/live_report.test.ts",
];

// A test-runner timeout cannot interrupt synchronous Wasm. Bound each entire
// process instead; timeout is a failed qualification, never a skipped test.
for (const suite of suites) {
  console.log(`\nQualifying ${suite}`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", suite],
    {
      cwd: repository,
      stdio: "inherit",
      timeout: 120_000,
      killSignal: "SIGKILL",
    },
  );
  if (result.error !== undefined) {
    console.error(`${suite}: ${result.error.message}`);
  }
  if (result.status !== 0 || result.error !== undefined) {
    console.error(`${suite}: qualification failed; signal=${result.signal}`);
    process.exitCode = 1;
  }
}
