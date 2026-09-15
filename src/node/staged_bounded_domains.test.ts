import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/staged_bounded_domains.blot";
const libraryPath = "examples/lib/bounded_int_domain.blot";
const wrongNarrowingPath =
  "src/node/fixtures/bounded_domain_wrong_narrowing.blot";
const outOfRangePath = "src/node/fixtures/bounded_domain_out_of_range.blot";
const wrongInputPath = "src/node/fixtures/bounded_domain_wrong_input.blot";

const blotPaths = [
  libraryPath,
  examplePath,
  wrongNarrowingPath,
  outOfRangePath,
  wrongInputPath,
] as const;

function isTypeError(error: unknown): boolean {
  assert(error instanceof BlotError);
  assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
  return true;
}

test("staged bounded domains derive one checked runtime boundary", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(examplePath);
    assert.equal(checked.effects, "");
    assert.match(checked.type, /\.default =/);

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/staged_bounded_domains.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/staged_bounded_domains.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("staged bounded domains reject invalid carriers and narrowing", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(() => compiler.check(wrongNarrowingPath), isTypeError);
    await assert.rejects(() => compiler.check(outOfRangePath), isTypeError);
    await assert.rejects(() => compiler.check(wrongInputPath), isTypeError);
  } finally {
    compiler.destroy();
  }
});
