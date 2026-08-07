import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildBatch } from "../../src/backend/build.ts";

Deno.test("linear alias does not make an observed Store destructively reusable", async () => {
  const directory = await Deno.makeTempDir();
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(
    root,
    `open @import "blot:prelude" ()
const Source = @effect.host { .value = Int -> Int; }
x <- Source.value 0
let shared = [x, 2, 3]
let !candidate = shared
let changed = @array.set candidate 0 9
let shared_first = case Array.get (shared, 0) of
  #Some value => value
  #None => 0
let changed_first = case Array.get (changed, 0) of
  #Some value => value
  #None => 0
return shared_first * 10 + changed_first
`,
  );

  const [outcome] = await buildBatch([root]);
  if (outcome.status !== "built") throw outcome.cause;
  const compiled = await WebAssembly.compile(outcome.wasm as BufferSource);
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Source": {
      value(input: bigint) {
        assertEquals(input, 0n);
        return 1n;
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("compiled module omitted the default export");
  }

  // Persistent source semantics: `shared` remains 1 while `changed` is 9.
  assertEquals(run(), 19n);
});
