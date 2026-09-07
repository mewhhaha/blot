import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

test("Money.add preserves its I32 carrier and traps on either overflow", async () => {
  const source = await readFile(resolve("examples/newtype.blot"), "utf8");
  const declarationsEnd = source.indexOf("let price :: Money");
  assert.notEqual(declarationsEnd, -1, "missing newtype example declarations");
  const declarations = source.slice(0, declarationsEnd);
  const directory = await mkdtemp(join(tmpdir(), "blot-newtype-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "add.blot");
    await writeFile(
      path,
      `${declarations}let add :: I32 -> I32 -> I32
let add = fn left => fn right => case Money.add (Money.of left) (Money.of right) of
  #Money sum => sum
return add
`,
    );
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const add = instance.exports["blot:default"];
    if (typeof add !== "function") throw new Error("missing newtype export");
    for (
      const [left, right, expected] of [
        [42n, 8n, 50n],
        [2147483647n, 0n, 2147483647n],
        [-2147483648n, 0n, -2147483648n],
        [2147483647n, -2147483648n, -1n],
      ]
    ) {
      assert.equal(add(left, right), expected);
      const evaluation = join(directory, "evaluate.blot");
      await writeFile(
        evaluation,
        `const add = import "./add.blot"\nreturn add (${left}) (${right})\n`,
      );
      assert.equal(
        (await compiler.evaluate(evaluation)).display,
        String(expected),
      );
    }
    for (const [left, right] of [[2147483647n, 1n], [-2147483648n, -1n]]) {
      assert.throws(() => add(left, right), WebAssembly.RuntimeError);
      const evaluation = join(directory, "overflow.blot");
      await writeFile(
        evaluation,
        `const add = import "./add.blot"\nreturn add (${left}) (${right})\n`,
      );
      await assert.rejects(
        () => compiler.evaluate(evaluation),
        /Money.add overflow/,
      );
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
