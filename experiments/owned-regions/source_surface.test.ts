import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkSource } from "../../src/check/mod.ts";
import { show } from "../../src/comptime/value.ts";
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
    `open import "blot:prelude"
let values = [3, 1, 2]
let whole = @region.claim values
let rejoined = case @region.split (!whole) 1 of
  #Split (!left, !right, !rejoin) => @region.join (!rejoin) (!left) (!right)
  #SplitOutOfBounds !original => original
return @region.freeze (!rejoined)
`,
  );
  assertEquals(checked.type, "[(3 | 1 | 2)]");
});

Deno.test("Region claim is copy-safe for a shared source array", async () => {
  const checked = await checkSource(
    path,
    `open import "blot:prelude"
let values = [3, 1, 2]
let region = @region.claim values
let shared_first = case Array.get (values, 0) of
  #Some value => value
  #None => 0
let frozen = @region.freeze (!region)
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
    `open import "blot:prelude"
let values = [3, 1, 2]
let whole = @region.claim values
let rejoined = case @region.split (!whole) 1 of
  #Split (!left, !right, !rejoin) => @region.join (!rejoin) (!right) (!left)
  #SplitOutOfBounds !original => original
return @region.freeze (!rejoined)
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
      `open import "blot:prelude"
let values = [3, 1, 2]
let region = @region.claim values
let changed = case @region.swap (!region) 0 2 of
  #Updated !updated => updated
  #SwapOutOfBounds !original => original
return @region.freeze (!changed)
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

Deno.test("Region replacement returns the displaced value and successor", async () => {
  const directory = await Deno.makeTempDir();
  const file = join(directory, "root.blot");
  try {
    await Deno.writeTextFile(
      file,
      `open import "blot:prelude"
let region = Slice.claim [10, 20, 30]
let result = case Slice.replace ((!region), 1, 7) of
  #Replaced (old, !updated) =>
    let frozen = Slice.freeze (!updated)
    let current = case Array.get (frozen, 1) of
      #Some value => value
      #None => 0
    return old * 10 + current
  #ReplaceOutOfBounds (_, !original) =>
    let frozen = Slice.freeze (!original)
    return Array.length (&frozen)
return result
`,
    );
    const result = await evaluateFile(file, { write() {} });
    assertEquals(result, { tag: "int", value: 207n });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Slice partition is a pure consuming in-place transform", async () => {
  const directory = await Deno.makeTempDir();
  const file = join(directory, "root.blot");
  try {
    await Deno.writeTextFile(
      file,
      `open import "blot:prelude"
let region = Slice.claim [5, 2, 4, 1, 3]
let (!partitioned, boundary) =
  Slice.partition ((!region), fn value => value <= 3)
return (Slice.freeze (!partitioned), boundary)
`,
    );
    const result = await evaluateFile(file, { write() {} });
    assertEquals(show(result), "([2, 1, 3, 5, 4], 3)");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Slice partition range conserves authority on bounds failure", async () => {
  const directory = await Deno.makeTempDir();
  const file = join(directory, "root.blot");
  try {
    await Deno.writeTextFile(
      file,
      `open import "blot:prelude"
let region = Slice.claim [1, 2, 3]
let result = case Slice.partition_range (
  (!region),
  2,
  4,
  fn value => value <= 2
) of
  #Partitioned (!updated, boundary) => (Slice.freeze (!updated), boundary)
  #PartitionOutOfBounds (!original, start) => (Slice.freeze (!original), start)
return result
`,
    );
    const result = await evaluateFile(file, { write() {} });
    assertEquals(show(result), "([1, 2, 3], 2)");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Region claim, replace, and freeze conserve owned elements", async () => {
  const checked = await checkSource(
    path,
    `open import "blot:prelude"
let consume = fn !value => value
let !old_token = 40
let !new_token = 2
let region = Slice.claim [fn () => consume (!old_token)]
let settle = fn (!old, !updated) =>
  let [current] = Slice.freeze (!updated)
  return (old ()) + (current ())
return case Slice.replace ((!region), 0, (fn () => consume (!new_token))) of
  #Replaced (!old, !updated) => settle ((!old), (!updated))
  #ReplaceOutOfBounds (!replacement, !original) =>
    return settle ((!replacement), (!original))
`,
  );
  assertEquals(checked.type, "Int");
});

Deno.test("Region join preserves replacement inside a split child", async () => {
  const checked = await checkSource(
    path,
    `open import "blot:prelude"
let consume = fn !value => value
let !old_token = 40
let !new_token = 2
let whole = Slice.claim [fn () => consume (!old_token), fn () => 1]
let restored = case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) =>
    return case Slice.replace ((!left), 0, (fn () => consume (!new_token))) of
      #Replaced (!old, !updated) =>
        let joined = Slice.join ((!rejoin), (!updated), (!right))
        let [current, tail] = Slice.freeze (!joined)
        return (old ()) + (current ()) + (tail ())
      #ReplaceOutOfBounds (!replacement, !original) =>
        let joined = Slice.join ((!rejoin), (!original), (!right))
        let [current, tail] = Slice.freeze (!joined)
        return (replacement ()) + (current ()) + (tail ())
  #SplitOutOfBounds !original =>
    let [first, second] = Slice.freeze (!original)
    return (first ()) + (second ()) + consume (!new_token)
return restored
`,
  );
  assertEquals(checked.type, "Int");
});

Deno.test("nested Region witnesses reassociate in both directions", async () => {
  const checked = await checkSource(
    path,
    `open import "blot:prelude"
let whole = Slice.claim [1, 2, 3]
let restored = case Slice.split ((!whole), 1) of
  #Split (!a, !bc, !outer) =>
    return case Slice.split ((!bc), 1) of
      #Split (!b, !c, !inner) =>
        let (outer_left, inner_left) =
          Slice.reassociate_left ((!outer), (!inner))
        let (outer_right, inner_right) =
          Slice.reassociate_right ((!outer_left), (!inner_left))
        let bc = Slice.join ((!inner_right), (!b), (!c))
        return Slice.join ((!outer_right), (!a), (!bc))
      #SplitOutOfBounds !bc_original =>
        return Slice.join ((!outer), (!a), (!bc_original))
  #SplitOutOfBounds !original => original
return Slice.freeze (!restored)
`,
  );
  assertEquals(checked.type, "[(1 | 2 | 3)]");
});
