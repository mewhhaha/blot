import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

// These are process/exit-status tests, not a replacement semantic compiler.
// Inject outcomes into an isolated child to exercise the actual corpus script
// without putting intentionally refused files in the shared accepted catalog.
for (const statuses of [
  ["ok"],
  ["refused"],
  ["error"],
  ["ok", "refused"],
  ["ok", "error", "refused"],
]) {
  test(`corpus exit status for ${statuses.join(", ")}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-corpus-status-"));
    try {
      const preload = join(directory, "outcomes.mjs");
      const compilerUrl = pathToFileURL(resolve("src/compiler.ts")).href;
      await writeFile(
        preload,
        `import { Compiler, CompilerTargetRefusal } from ${
          JSON.stringify(compilerUrl)
        };
const statuses = ${JSON.stringify(statuses)};
let index = 0;
globalThis.Deno = {
  async *readDir() {
    for (let i = 0; i < statuses.length; i += 1) {
      yield { isFile: true, name: "example-" + i + ".blot" };
    }
  },
  exit(code) { process.exitCode = code; },
};
Compiler.create = async () => ({
  async compile() {
    const status = statuses[index++];
    if (status === "refused") throw new CompilerTargetRefusal("test refusal");
    if (status === "error") throw new Error("test failure");
    return { wasm: new Uint8Array(8) };
  },
  destroy() {},
});
`,
      );
      const run = () => execute(process.execPath, [
        "--import",
        "tsx",
        "--import",
        preload,
        resolve("scripts/compile_corpus.ts"),
      ]);
      let stdout: string;
      if (statuses.every((status) => status === "ok")) {
        stdout = (await run()).stdout;
      } else {
        stdout = "";
        await assert.rejects(run(), (error: unknown) => {
          assert.ok(error instanceof Error);
          const failure = error as Error & { code: number; stdout: string };
          assert.equal(failure.code, 1);
          stdout = failure.stdout;
          return true;
        });
      }
      const report = JSON.parse(stdout);
      assert.equal(report.files, statuses.length);
      assert.equal(
        report.compiled,
        statuses.filter((status) => status === "ok").length,
      );
      assert.equal(
        report.refused,
        statuses.filter((status) => status === "refused").length,
      );
      assert.equal(
        report.failed,
        statuses.filter((status) => status === "error").length,
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
}
