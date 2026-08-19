import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "../diagnostic.ts";
import { checkFile, checkSource } from "./mod.ts";

const PRELUDE = `open import "blot:prelude"\n`;

function checkedWith(bound: string, declarations = ""): Promise<unknown> {
  return checkSource(
    "/tmp/relational-summary.blot",
    PRELUDE + declarations +
      `sig at = [Int] -> Int -> Int
let at = fn xs => fn n => case n >= 0 && ${bound} of
  #True => @array.get xs n
  #False => 0
return at
`,
  );
}

Deno.test("a verified prelude length wrapper proves direct access", async () => {
  const checked = await checkedWith("n < Array.length xs");
  assertEquals((checked as { type: string }).type, "[Int] -> Int -> Int");
});

Deno.test("relational summaries survive aliases and wrapper composition", async () => {
  await checkedWith(
    "n < count xs",
    `const length = Array.length
const count = fn values => length values
`,
  );
});

Deno.test("relational summaries retain a literal affine offset", async () => {
  await checkedWith(
    "n <= last xs",
    `const last = fn values => @int.sub (Array.length values) 1
`,
  );
});

Deno.test("a same-named unverified wrapper proves no length fact", async () => {
  await assertRejects(
    () =>
      checkedWith(
        "n < Array.length xs",
        `let Array = { .length = fn _ => 10; }
`,
      ),
    BlotError,
    "BLOT_UNPROVEN_INDEX",
  );
});

Deno.test("refined consuming extraction returns plain tuples", async () => {
  const checked = await checkSource(
    "/tmp/refined-array-extraction.blot",
    PRELUDE + `sig take_at = [Int] -> Int -> (Int, [Int])
let take_at = fn values => fn index =>
  if index >= 0 && index < Array.length values:
    return @array.take values index
  else:
    return @panic "take index out of bounds"

sig split_at = [Int] -> Int -> ([Int], Int, [Int])
let split_at = fn values => fn index =>
  if index >= 0 && index < Array.length values:
    return @array.split values index
  else:
    return @panic "split index out of bounds"

return (take_at, split_at)
`,
  );
  assertEquals(
    checked.type,
    "([Int] -> Int -> (Int, [Int]), [Int] -> Int -> ([Int], Int, [Int]))",
  );
});

Deno.test("unproved consuming extraction is rejected", async () => {
  await assertRejects(
    () =>
      checkSource(
        "/tmp/unproved-array-take.blot",
        PRELUDE + `sig take_at = [Int] -> Int -> (Int, [Int])
let take_at = fn values => fn index => @array.take values index
return take_at
`,
      ),
    BlotError,
    "BLOT_UNPROVEN_INDEX",
  );
});

Deno.test("statically out-of-bounds consuming extraction is rejected", async () => {
  await assertRejects(
    () =>
      checkSource(
        "/tmp/out-of-bounds-array-split.blot",
        PRELUDE + `return @array.split [1, 2, 3] 9
`,
      ),
    BlotError,
    "BLOT_OUT_OF_BOUNDS",
  );
});


Deno.test("verified relational summaries cross an imported module value", async () => {
  const directory = await Deno.makeTempDir();
  const library = `${directory}/contracts.blot`;
  const root = `${directory}/main.blot`;
  await Deno.writeTextFile(
    library,
    PRELUDE + `const count = fn values => Array.length values
return { .count = count; }
`,
  );
  await Deno.writeTextFile(
    root,
    PRELUDE + `const Contracts = import "./contracts.blot"
sig at = [Int] -> Int -> Int
let at = fn values => fn index => case index >= 0 && index < Contracts.count values of
  #True => @array.get values index
  #False => 0
return at
`,
  );
  const checked = await checkFile(root);
  assertEquals(checked.type, "[Int] -> Int -> Int");
});
