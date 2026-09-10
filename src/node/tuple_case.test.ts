import { scalarExport } from "../../test_support/guest_abi.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

test("tuple cases retain runtime field decisions and evaluate every subject once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-tuple-case-"));
  const path = join(directory, "main.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      `open import "blot:prelude"
const Input = @effect.host {
  .flag = Unit -> Bool;
  .index = Unit -> Int;
}
let pick :: (Bool, Int) -> Int
let pick = fn (trunk, y) => case (trunk, y % 3) of
  (#True, _) => 10
  (_, 0) => 20
  (_, 1) => 30
  _ => 40
let strict :: Unit -> Int ~ { Input }
let strict = fn () => case (Input.flag (), Input.index ()) of
  (#True, _) => 10
  (_, 0) => 20
  _ => 40
let identity :: Bool -> Bool
let identity = fn flag => flag
let flip :: Bool -> Bool
let flip = fn flag => case flag of
  #True => #False
  #False => #True
const Choice = #Zulu | #Alpha | #Middle
let enum_identity :: Choice -> Choice
let enum_identity = fn choice => choice
let enum_index :: Choice -> Int
let enum_index = fn choice => case choice of
  #Zulu => 42
  #Alpha => 7
  #Middle => 19
return { .pick = pick; .strict = strict; .identity = identity; .flip = flip; .enum_identity = enum_identity; .enum_index = enum_index; }
`,
    );
    const artifact = await compiler.compile(path);
    const calls: string[] = [];
    let flag = 1;
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {
        "blot:host/Input": {
          flag: () => {
            calls.push("flag");
            return flag;
          },
          index: () => {
            calls.push("index");
            return 0n;
          },
        },
      },
    );
    const pick = scalarExport(instance, "blot:pick") as (
      flag: number,
      y: bigint,
    ) => bigint;
    const strict = scalarExport(instance, "blot:strict") as () => bigint;
    const identity = scalarExport(instance, "blot:identity") as (
      flag: number,
    ) => number;
    const flip = scalarExport(instance, "blot:flip") as (
      flag: number,
    ) => number;
    const enumIdentity = scalarExport(instance, "blot:enum_identity") as (
      tag: number,
    ) => number;
    const enumIndex = scalarExport(instance, "blot:enum_index") as (
      tag: number,
    ) => bigint;
    // Public constructor tags are canonical by name, not source order.
    for (let tag = 0; tag < 3; tag += 1) {
      assert.equal(enumIdentity(tag), tag);
      assert.equal(enumIndex(tag), [7n, 19n, 42n][tag]);
    }
    assert.equal(identity(0), 0);
    assert.equal(identity(1), 1);
    assert.equal(flip(0), 1);
    assert.equal(flip(1), 0);
    assert.throws(() => pick(2, 0n), WebAssembly.RuntimeError);
    for (let y = 0; y < 12; y += 1) {
      assert.equal(pick(1, BigInt(y)), 10n);
      assert.equal(pick(0, BigInt(y)), [20n, 30n, 40n][y % 3]);
    }
    assert.equal(strict(), 10n);
    assert.deepEqual(calls, ["flag", "index"]);
    flag = 0;
    calls.length = 0;
    assert.equal(strict(), 20n);
    assert.deepEqual(calls, ["flag", "index"]);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
