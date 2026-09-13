import { spawnSync } from "node:child_process";

for (
  const [command, arguments_] of [
    ["cargo", [
      "test",
      "--manifest-path",
      "compiler/Cargo.toml",
      "relational_",
      "--",
      "--nocapture",
    ]],
    [process.execPath, [
      "--import",
      "tsx",
      "--test",
      "--test-timeout=60000",
      "src/node/relational_inference.test.ts",
      "src/node/predicate_helpers.test.ts",
    ]],
  ]
) {
  const result = spawnSync(command, arguments_, {
    stdio: "inherit",
    timeout: 300_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status} and signal ${result.signal}`,
    );
  }
}
