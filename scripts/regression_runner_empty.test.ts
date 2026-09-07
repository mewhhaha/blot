import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(
  new URL("./node_regression_tests.mjs", import.meta.url),
);

for (const excludedOnly of [false, true]) {
  test(`regression runner refuses empty discovery (excluded files: ${excludedOnly})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-empty-regression-"));
    try {
      if (excludedOnly) {
        for (const parent of ["dist", "node_modules", "src/node", ".hidden"]) {
          await mkdir(join(directory, parent), { recursive: true });
          await writeFile(
            join(directory, parent, "hidden.test.ts"),
            'throw new Error("excluded fixture must not execute");\n',
          );
        }
      }
      const env = { ...process.env };
      env.BLOT_TEST_TIMEOUT_MS = "5000";
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [runner], {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /No regression tests were discovered/);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /excluded fixture must not execute/,
      );
      assert.doesNotMatch(result.stdout, /\[1\//);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
