import { scalarExport } from "../../test_support/guest_abi.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

async function agrees(
  definitions: string,
  cases: readonly (readonly [bigint, bigint])[],
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-residual-identity-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "main.blot");
    await writeFile(
      path,
      `open import "blot:prelude"\n${definitions}\nreturn run\n`,
    );
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const run = scalarExport(instance, "blot:default");
    assert.equal(typeof run, "function");
    if (typeof run !== "function") throw new Error("missing runtime export");
    for (const [input, expected] of cases) {
      assert.equal(run(input), expected, `Wasm at ${input}`);
      const evaluationPath = join(directory, "evaluate.blot");
      await writeFile(
        evaluationPath,
        `open import "blot:prelude"\nconst run = import "./main.blot"\nreturn run (${input})\n`,
      );
      assert.equal(
        (await compiler.evaluate(evaluationPath)).display,
        String(expected),
        `evaluator at ${input}`,
      );
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
}

for (const reverse of [false, true]) {
  test(`static field captures survive residual sharing (reverse=${reverse})`, async () => {
    let getters = 'const left = make "left"\nconst right = make "right"';
    let result = "left pair + right pair";
    if (reverse) {
      getters = 'const right = make "right"\nconst left = make "left"';
      result = "right pair + left pair";
    }
    await agrees(
      `const make = fn name => fn value => @shape.get value name
${getters}
let run :: Int -> Int
let run = fn number => do:
  let pair = { .left = number; .right = 7; }
  return ${result}`,
      [[42n, 49n], [0n, 7n], [-3n, 4n]],
    );
  });
}

test("static evidence survives captured records", async () => {
  await agrees(
    `const make = fn config => fn value => @shape.get value config.name
const left = make { .name = "left"; }
const right = make { .name = "right"; }
let run :: Int -> Int
let run = fn number => do:
  let pair = { .left = number; .right = 7; }
  return left pair + right pair`,
    [[42n, 49n], [0n, 7n]],
  );
});

test("static evidence includes transitive closure captures", async () => {
  await agrees(
    `const make = fn name => fn value => @shape.get value name
const wrap = fn getter => fn value => getter value
const left = wrap (make "left")
const right = wrap (make "right")
let run :: Int -> Int
let run = fn number => do:
  let pair = { .left = number; .right = 7; }
  return left pair + right pair`,
    [[42n, 49n], [0n, 7n]],
  );
});

test("static and dynamic captures are independently accounted for", async () => {
  await agrees(
    `const make = fn name => fn bias => fn value => @int.add (@shape.get value name) bias
let run :: Int -> Int
let run = fn number => do:
  let left = make "left" number
  let right = make "right" (number + 1)
  let pair = { .left = number; .right = 7; }
  return left pair + right pair`,
    [[42n, 134n], [0n, 8n], [-3n, -1n]],
  );
});

test("same-typed runtime capture permutations retain their meaning", async () => {
  await agrees(
    `const make = fn left => fn right => fn ignored => @int.sub left right
let run :: Int -> Int
let run = fn number => do:
  let next = number + 1
  let forward = make number next
  let backward = make next number
  return forward () * 10 + backward ()`,
    [[42n, -9n], [0n, -9n]],
  );
});

test("recursive specializations retain distinct static environments", async () => {
  await agrees(
    `const make = fn offset => do:
  let rec count :: Int -> Int
  let rec count = fn n => do:
    if n <= 0:
      return offset
    return count (n - 1) + 1
  return count
const left = make 10
const right = make 100
let run :: Int -> Int
let run = fn number => left number + right number`,
    [[0n, 110n], [3n, 116n], [10n, 130n]],
  );
});

test("repeated calls preserve corresponding runtime arguments", async () => {
  await agrees(
    `const make = fn name => fn value => @shape.get value name
const left = make "left"
let run :: Int -> Int
let run = fn number => do:
  let first = { .left = number; .right = 7; }
  let second = { .left = number + 1; .right = 9; }
  return left first + left second`,
    [[42n, 85n], [0n, 1n]],
  );
});
