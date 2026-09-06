import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Compiler, explanationAt } from "../compiler.ts";
import { sourceOffset } from "./explain.ts";

const execute = promisify(execFile);
function cli(...arguments_: string[]) {
  return execute(
    process.execPath,
    ["--import", "tsx", resolve("src/node/cli.ts"), ...arguments_],
    { timeout: 30_000, killSignal: "SIGKILL" },
  );
}

test("pack builds deterministic, source-free, executable package exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot cli package "));
  try {
    const root = join(directory, "node_modules", "@test", "numbers");
    await mkdir(root, { recursive: true });
    const source = join(root, "mod.blot");
    const capsule = join(root, "dist", "mod.blotc");
    await writeFile(source, "return 42\n");
    const manifest = join(root, "blot.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schema: "blot-package",
        version: 4,
        exports: { ".": { source: "./mod.blot", built: "./dist/mod.blotc" } },
      }),
    );
    const first = await cli("pack", manifest);
    assert.match(first.stdout, /mod\.blotc, [1-9][0-9]* bytes, 1 modules/);
    assert.equal(first.stderr, "");
    const bytes = await readFile(capsule);
    await cli("pack", manifest);
    assert.deepEqual(await readFile(capsule), bytes);
    await rm(source);
    const consumer = join(directory, "main.blot");
    await writeFile(consumer, 'return import "@test/numbers"\n');
    assert.equal((await cli("run", consumer)).stdout.trim(), "42");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pack leaves existing artifacts untouched when another export fails checking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-cli-pack-failure-"));
  try {
    const first = join(directory, "first.blotc");
    await writeFile(first, "existing artifact\n");
    await writeFile(join(directory, "first.blot"), "return 42\n");
    await writeFile(join(directory, "bad.blot"), "let =\n");
    const manifest = join(directory, "blot.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schema: "blot-package",
        version: 4,
        exports: {
          ".": { source: "./first.blot", built: "./first.blotc" },
          "./bad": { source: "./bad.blot", built: "./bad.blotc" },
        },
      }),
    );
    await assert.rejects(cli("pack", manifest), /GPU_FRONTEND_SYNTAX_ERROR/);
    assert.equal(await readFile(first, "utf8"), "existing artifact\n");
    await assert.rejects(readFile(join(directory, "bad.blotc")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explain emits the real compiler fact at the exact UTF-16 source position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-cli-explain-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "main.blot");
    const source = "// 🦉\r\nreturn 42\r\n";
    const location = { line: 2, column: 8 };
    await writeFile(path, source);
    const expected = explanationAt(
      await compiler.analyzeSource(path, source),
      sourceOffset(source, location),
    );
    assert.notEqual(expected, null);
    const result = await cli("explain", "--json", path, "2:8");
    assert.deepEqual(JSON.parse(result.stdout), {
      path,
      location,
      explanation: expected,
    });
    assert.equal(result.stderr, "");
    assert.match((await cli("explain", path, "2:8")).stdout, /inferred type/);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool usage errors have exit status two, not a compiler failure", async () => {
  for (
    const arguments_ of [
      ["pack", "one.json", "two.json"],
      ["explain", "missing.blot", "0:1"],
      ["explain", "missing.blot", "1:1", "extra"],
    ]
  ) {
    await assert.rejects(cli(...arguments_), (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = error as Error & { code: number; stderr: string };
      assert.equal(failure.code, 2);
      assert.match(failure.stderr, /usage:/);
      assert.doesNotMatch(failure.stderr, /ENOENT|compiler invariant/);
      return true;
    });
  }
  assert.match((await cli("--help")).stdout, /pack\|explain/);
});
