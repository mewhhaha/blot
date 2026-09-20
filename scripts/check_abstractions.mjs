import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const suites = [
  "src/node/refactoring.test.ts",
  "src/node/predicate_helpers.test.ts",
  "src/node/host.test.ts",
  "src/node/host_async.test.ts",
  "src/node/live_report_host.test.ts",
  "src/node/run.test.ts",
  "src/node/cli_tools.test.ts",
  "src/node/explain.test.ts",
  "src/node/report.test.ts",
  "scripts/release_evidence.test.ts",
  "src/node/residual_identity.test.ts",
  "src/node/inline_products.test.ts",
  "src/node/language_claims.test.ts",
  "src/node/practical_examples.test.ts",
  "src/node/typed_quantities.test.ts",
  "src/node/typed_lenses.test.ts",
  "src/node/composable_ordering.test.ts",
  "src/node/typed_nonempty.test.ts",
  "src/node/structural_readers.test.ts",
  "src/node/typed_validation.test.ts",
  "src/node/effect_row_middleware.test.ts",
  "src/node/composable_reducers.test.ts",
  "src/node/typed_semiring_matrices.test.ts",
  "src/node/nominal_keyed_index.test.ts",
  "src/node/composable_parser.test.ts",
  "src/node/composable_prisms.test.ts",
  "src/node/derived_structural_diff.test.ts",
  "src/node/staged_request_builder.test.ts",
  "src/node/typed_codec.test.ts",
  "src/node/deferred_fallback.test.ts",
  "src/node/residual_command_router.test.ts",
  "src/node/typed_relational_join.test.ts",
  "src/node/typed_coordinate_spaces.test.ts",
  "src/node/reversible_updates.test.ts",
  "src/node/typed_traversals.test.ts",
  "src/node/typed_record_projections.test.ts",
  "src/node/composable_event_aggregates.test.ts",
  "src/node/staged_bounded_domains.test.ts",
  "src/node/staged_endpoint_adapters.test.ts",
  "src/node/versioned_schema_migrations.test.ts",
  "src/node/shared_service_contracts.test.ts",
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
