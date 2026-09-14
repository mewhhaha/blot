import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { evaluateFile, show } from "../run.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

test("typed nonempty evaluator matches the recorded result", async () => {
  const expected = await readFile(
    "examples/expected/typed_nonempty.txt",
    "utf8",
  );
  assert.equal(
    show(
      await evaluateFile("examples/typed_nonempty.blot", {
        write: (line) =>
          assert.fail(`Unexpected nonempty example write: ${line}`),
      }),
    ),
    expected.trim(),
  );
});

test("typed nonempty executes through emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    await compiler.check("examples/typed_nonempty.blot");
    const artifact = await compiler.compile("examples/typed_nonempty.blot");
    const expected = await readFile(
      "examples/expected/typed_nonempty.wasm.txt",
      "utf8",
    );
    assert.equal(await runArtifact(artifact), expected.trim());
  } finally {
    compiler.destroy();
  }
});

test("typed nonempty sources stay canonical", async () => {
  for (
    const path of [
      "examples/lib/nonempty.blot",
      "examples/typed_nonempty.blot",
    ]
  ) {
    const source = await readFile(path, "utf8");
    assert.match(source, /Pain point:/);
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error(`${path} failed to format`);
    assert.equal(formatted.source, source);
  }
});

test("a nonempty value cannot omit its head", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/nonempty_missing_head.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});

test("nonempty is a semigroup but not a monoid", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/nonempty_monoid.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
