import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compiler } from "../../src/compiler.ts";

// Opt-in acceptance probe. Distinct compile-time field names must survive
// residual function sharing. The baseline currently returns 84, not 49.
const directory = await mkdtemp(join(tmpdir(), "blot-static-captures-"));
const compiler = await Compiler.create();
try {
  const path = join(directory, "main.blot");
  await writeFile(
    path,
    `open import "blot:prelude"
const make = fn name => fn value => @shape.get value name
const left = make "left"
const right = make "right"
let read :: Int -> Int
let read = fn number => do:
  let pair = { .left = number; .right = 7; }
  return left pair + right pair
return read
`,
  );
  const artifact = await compiler.compile(path);
  const { instance } = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const read = instance.exports["blot:default"];
  if (typeof read !== "function") throw new Error("missing runtime export");
  const observed = read(42n);
  console.log({ observed: String(observed), expected: "49" });
  assert.equal(observed, 49n);
} finally {
  compiler.destroy();
  await rm(directory, { recursive: true });
}
