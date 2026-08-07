import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkSource } from "../../src/check/mod.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { evaluateFile } from "../../src/run.ts";

const path = "/tmp/blot-owned-region-source-test.blot";

async function expectDiagnostic(source: string, code: string): Promise<void> {
  try {
    await checkSource(path, source);
    throw new Error(`expected ${code}`);
  } catch (error) {
    assert(error instanceof BlotError);
    assertEquals(error.diagnostic.code, code);
  }
}

Deno.test("Region split and join preserve one fresh root", async () => {
  const checked = await checkSource(
    path,
    `open @import "blot:prelude" ()
let values = [3, 1, 2]
let whole = @region.array.claim values
let rejoined = case @region.array.split (!whole) 1 of
  #Split (!left, !right) => @region.array.join (!left) (!right)
  #SplitOutOfBounds !original => original
return @region.array.freeze (!rejoined)
`,
  );
  assertEquals(checked.type, "[1 | 2 | 3]");
});

Deno.test("Region claim is copy-safe for a shared source array", async () => {
  const checked = await checkSource(
    path,
    `open @import "blot:prelude" ()
let values = [3, 1, 2]
let region = @region.array.claim values
let shared_first = case Array.get (values, 0) of
  #Some value => value
  #None => 0
let frozen = @region.array.freeze (!region)
let frozen_first = case Array.get (frozen, 0) of
  #Some value => value
  #None => 0
return shared_first * 10 + frozen_first
`,
  );
  assertEquals(checked.type, "Int");
});

Deno.test("Region join rejects reversed siblings", async () => {
  await expectDiagnostic(
    `open @import "blot:prelude" ()
let values = [3, 1, 2]
let whole = @region.array.claim values
let rejoined = case @region.array.split (!whole) 1 of
  #Split (!left, !right) => @region.array.join (!right) (!left)
  #SplitOutOfBounds !original => original
return @region.array.freeze (!rejoined)
`,
    "BLOT_REGION_JOIN_UNPROVED",
  );
});

Deno.test("Region evaluator mutates only its private Store", async () => {
  const directory = await Deno.makeTempDir();
  const file = join(directory, "root.blot");
  try {
    await Deno.writeTextFile(
      file,
      `open @import "blot:prelude" ()
let values = [3, 1, 2]
let region = @region.array.claim values
let changed = @region.array.swap (!region) 0 2
return @region.array.freeze (!changed)
`,
    );
    const result = await evaluateFile(file, { write() {} });
    assertEquals(result, {
      tag: "array",
      elements: [
        { tag: "int", value: 2n },
        { tag: "int", value: 1n },
        { tag: "int", value: 3n },
      ],
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
