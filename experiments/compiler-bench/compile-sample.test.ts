import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseCompilationSampleOptions,
  sampleCompilation,
} from "./compile-sample.ts";

test("complete compilation defaults to cold, not cached preparation", () => {
  assert.deepEqual(
    parseCompilationSampleOptions(["--entry=examples/minimal.blot"]),
    {
      entry: resolve("examples/minimal.blot"),
      mode: "cold",
      wasm: undefined,
      snapshot: undefined,
      output: undefined,
      edit: undefined,
    },
  );
});

test("diagnostic compilers require an explicit matched snapshot", () => {
  for (const extra of ["--wasm=compiler.wasm", "--snapshot=prelude.snapshot"]) {
    assert.throws(
      () => parseCompilationSampleOptions(["--entry=main.blot", extra]),
      /both/,
    );
  }
  const options = parseCompilationSampleOptions([
    "--entry=main.blot",
    "--wasm=compiler.wasm",
    "--snapshot=prelude.snapshot",
    "--mode=split",
  ]);
  assert.equal(options.mode, "split");
  assert.equal(options.wasm, "compiler.wasm");
});

test("invalid modes and duplicate or unknown options cannot relabel samples", () => {
  for (
    const args of [
      [],
      ["--entry=main.blot", "--mode=warm"],
      ["--entry=main.blot", "--mode=cold", "--mode=resident"],
      ["--entry=main.blot", "--samples=5"],
      ["--entry="],
    ]
  ) assert.throws(() => parseCompilationSampleOptions(args));
  assert.equal(
    parseCompilationSampleOptions(["--entry=main.blot", "--mode=resident"])
      .mode,
    "resident",
  );
});

test("edited samples cannot omit the edit or hide it in a cold/cache sample", () => {
  assert.throws(
    () => parseCompilationSampleOptions(["--entry=main.blot", "--mode=edited"]),
    /requires/,
  );
  for (const mode of ["cold", "split", "resident"]) {
    assert.throws(
      () =>
        parseCompilationSampleOptions([
          "--entry=main.blot",
          `--mode=${mode}`,
          "--edit=replacement.blot",
        ]),
      /requires/,
    );
  }
  const options = parseCompilationSampleOptions([
    "--entry=main.blot",
    "--mode=edited",
    "--edit=replacement.blot",
  ]);
  assert.equal(options.mode, "edited");
  assert.equal(options.edit, "replacement.blot");
});

test("edited compilation includes invalidation and agrees with a fresh changed compile", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(resolve(tmpdir(), "blot-edit-sample-"));
  try {
    const entry = resolve(directory, "main.blot");
    const edit = resolve(directory, "replacement.blot");
    const output = resolve(directory, "observed");
    const replacement = "return { .run = fn () => 2; }\n";
    await writeFile(entry, "return { .run = fn () => 1; }\n");
    await writeFile(edit, replacement);
    const sample = await sampleCompilation({
      entry,
      edit,
      output,
      mode: "edited",
    });
    assert.equal(sample.artifactSource, "compiled");
    assert.equal(sample.editedCompilation?.artifactSource, "compiled");
    assert.equal(sample.editedCompilation?.wasmChanged, true);
    assert.equal(sample.editedCompilation?.wasmValidated, true);
    assert.notEqual(sample.unchangedArtifactHitMs, null);
    assert.ok(sample.editedCompilation !== null);
    assert.ok(
      Math.abs(
        sample.editedCompilation.totalCompilationMs -
          (sample.editedCompilation.setOverlayMs +
            sample.editedCompilation.compileMs),
      ) < 0.000001,
    );
    await writeFile(entry, replacement);
    const fresh = await sampleCompilation({
      entry,
      mode: "cold",
      output: `${output}-fresh`,
    });
    assert.equal(fresh.wasmSha256, sample.editedCompilation.wasmSha256);
    assert.equal(fresh.abiSha256, sample.editedCompilation.abiSha256);
    assert.deepEqual(
      await readFile(`${output}-fresh.wasm`),
      await readFile(`${output}.edited.wasm`),
    );
    await assert.rejects(
      sampleCompilation({ entry, edit, mode: "edited" }),
      /different source bytes/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
