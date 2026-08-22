import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkSource } from "../../src/check/mod.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { evaluateFile } from "../../src/run.ts";

const path = "/tmp/blot-owned-ordered-map-source-test.blot";

async function evaluate(source: string): Promise<unknown> {
  const directory = await Deno.makeTempDir();
  const file = join(directory, "root.blot");
  try {
    await Deno.writeTextFile(file, source);
    return await evaluateFile(file, { write() {} });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("OrderedTextMap validates and finds every lower-bound class", async () => {
  const result = await evaluate(
    `open import "blot:prelude"
let source = [("a", 1), ("b", 2), ("c", 3)]
let valid = case OrderedTextMap.validate (&source) of
  #True => 1
  #False => 0
let entries = OrderedTextMap.copy source
let before = OrderedTextMap.lower_bound ((&entries), "")
let present = OrderedTextMap.lower_bound ((&entries), "b")
let absent = OrderedTextMap.lower_bound ((&entries), "bb")
let after = OrderedTextMap.lower_bound ((&entries), "z")
let frozen = OrderedTextMap.freeze (!entries)
return valid * 10000 + before * 1000 + present * 100 + absent * 10 + after +
  Array.length frozen
`,
  );
  assertEquals(result, { tag: "int", value: 10126n });
});

Deno.test("OrderedTextMap handles empty and singleton roots", async () => {
  const result = await evaluate(
    `open import "blot:prelude"
sig empty_source = [OrderedTextMap.entry Int]
let empty_source = Array.empty
let empty = OrderedTextMap.copy empty_source
let empty_length = OrderedTextMap.length (&empty)
let empty_bound = OrderedTextMap.lower_bound ((&empty), "a")
let empty_frozen = OrderedTextMap.freeze (!empty)
let singleton = OrderedTextMap.copy [("b", 2)]
let before = OrderedTextMap.lower_bound ((&singleton), "a")
let present = OrderedTextMap.lower_bound ((&singleton), "b")
let after = OrderedTextMap.lower_bound ((&singleton), "c")
let singleton_frozen = OrderedTextMap.freeze (!singleton)
return empty_length * 100000 + empty_bound * 10000 +
  Array.length empty_frozen * 1000 + before * 100 + present * 10 + after +
  Array.length singleton_frozen
`,
  );
  assertEquals(result, { tag: "int", value: 2n });
});

Deno.test("OrderedTextMap rejects duplicate and descending keys", async () => {
  const validated = await evaluate(
    `open import "blot:prelude"
let duplicate = [("a", 1), ("a", 2)]
let descending = [("b", 1), ("a", 2)]
let duplicate_valid = OrderedTextMap.validate (&duplicate)
let descending_valid = OrderedTextMap.validate (&descending)
return case (duplicate_valid, descending_valid) of
  (#False, #False) => 1
  _ => 0
`,
  );
  assertEquals(validated, { tag: "int", value: 1n });

  try {
    await evaluate(
      `open import "blot:prelude"
let entries = OrderedTextMap.copy [("b", 1), ("a", 2)]
return OrderedTextMap.freeze (!entries)
`,
    );
    throw new Error("expected OrderedTextMap.copy to trap");
  } catch (error) {
    assert(error instanceof BlotError);
    assertEquals(error.diagnostic.code, "BLOT_PANIC");
  }
});

Deno.test("OrderedTextMap missing replacement returns both inputs", async () => {
  const result = await evaluate(
    `open import "blot:prelude"
let entries = OrderedTextMap.copy [("a", 1), ("b", 2)]
return case OrderedTextMap.replace ((!entries), "z", 9) of
  #MapReplaced (previous, !updated) => do:
    let frozen = OrderedTextMap.freeze (!updated)
    return previous * 10 + Array.length frozen
  #MapMissing (returned, !original) => do:
    let frozen = OrderedTextMap.freeze (!original)
    return returned * 10 + Array.length frozen
`,
  );
  assertEquals(result, { tag: "int", value: 92n });
});

Deno.test("OrderedTextMap refuses values whose lookup would copy ownership", async () => {
  try {
    await checkSource(
      path,
      `open import "blot:prelude"
let consume = fn !value => value
let !token = 1
let entries = OrderedTextMap.copy [
  ("a", fn () => consume (!token))
]
return OrderedTextMap.freeze (!entries)
`,
    );
    throw new Error("expected owned-value acquisition to be rejected");
  } catch (error) {
    assert(error instanceof BlotError);
    assertEquals(error.diagnostic.code, "BLOT_LINEAR_ARGUMENT_NOT_OWNED");
  }
});
