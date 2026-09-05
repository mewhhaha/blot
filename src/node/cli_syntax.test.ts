import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Block the semantic boundary in an isolated child process. Never rename the
// shared compiler artifact: other test files may be using it concurrently.
async function syntaxOnlyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-syntax-"));
  const preload = join(directory, "no-compiler.mjs");
  const compilerUrl = pathToFileURL(resolve("src/compiler.ts")).href;
  await writeFile(
    preload,
    `import { Compiler } from ${JSON.stringify(compilerUrl)};
Compiler.create = async () => {
  throw new Error("semantic compiler deliberately unavailable");
};
`,
  );
  return {
    directory,
    run: (...arguments_: string[]) => execute(process.execPath, [
      "--import",
      "tsx",
      "--import",
      preload,
      resolve("src/node/cli.ts"),
      ...arguments_,
    ]),
  };
}

test("ast parses and serializes bigint without a semantic compiler", async () => {
  const fixture = await syntaxOnlyFixture();
  try {
    const path = join(fixture.directory, "valid.blot");
    await writeFile(path, "return 42\n");
    const result = await fixture.run("ast", path);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stdout, /"42n"/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(fixture.directory, { recursive: true });
  }
});

test("ast reports syntax errors without a semantic compiler", async () => {
  const fixture = await syntaxOnlyFixture();
  try {
    const path = join(fixture.directory, "invalid.blot");
    await writeFile(path, "let =\n");
    await assert.rejects(fixture.run("ast", path), (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = error as Error & { code: number; stderr: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /GPU_FRONTEND_SYNTAX_ERROR/);
      assert.doesNotMatch(failure.stderr, /semantic compiler/);
      return true;
    });
  } finally {
    await rm(fixture.directory, { recursive: true });
  }
});

test("ast continues after a missing file and retains failure status", async () => {
  const fixture = await syntaxOnlyFixture();
  try {
    const path = join(fixture.directory, "valid.blot");
    const missing = join(fixture.directory, "missing.blot");
    await writeFile(path, "return 42\n");
    await assert.rejects(fixture.run("ast", missing, path), (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = error as Error & {
        code: number;
        stderr: string;
        stdout: string;
      };
      assert.equal(failure.code, 1);
      assert.ok(failure.stderr.includes(missing));
      assert.match(failure.stdout, /"42n"/);
      return true;
    });
  } finally {
    await rm(fixture.directory, { recursive: true });
  }
});

test("check still requires the semantic compiler", async () => {
  const fixture = await syntaxOnlyFixture();
  try {
    const path = join(fixture.directory, "valid.blot");
    await writeFile(path, "return 42\n");
    await assert.rejects(
      fixture.run("check", path),
      /semantic compiler deliberately unavailable/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true });
  }
});
