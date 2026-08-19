import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "../diagnostic.ts";
import { checkFile, checkSource } from "./mod.ts";
import { relationalSummary } from "./relational.ts";

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

Deno.test("affine summaries select a later curried parameter", async () => {
  await checkedWith(
    "n < count_second 0 xs",
    `const count_second = fn _ => fn values => Array.length values
`,
  );
});

Deno.test("region lengths use the same affine summary language", async () => {
  const checked = await checkSource(
    "/tmp/region-summary.blot",
    PRELUDE + `const count_region = fn &region => @region.length (&region)
return count_region
`,
  );
  const value = checked.values.names.get("count_region");
  if (value === undefined) throw new Error("missing count_region value");
  assertEquals(relationalSummary(value), {
    tag: "affine-measure",
    measure: "region-length",
    parameter: 0,
    offset: 0n,
  });
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

Deno.test(
  "verified relational summaries cross an imported module value",
  async () => {
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
  },
);

const INDEX_PACKAGE_BODY = `let at_index = fn values =>
  let iterator = Iter.indexed values
  let state = iterator.state
  return case iterator.step state of
    #None => 0
    #Some (entry, _) =>
      let input = (values, entry)
      let package = CARRY input
      let { .values = selected_values; .payload; } = package
      let (index, _) = payload
      return @array.get selected_values index
return at_index [10, 20, 30]
`;

Deno.test("relationship evidence survives records and destructuring", async () => {
  const checked = await checkSource(
    "/tmp/relationship-record.blot",
    PRELUDE + INDEX_PACKAGE_BODY.replace(
      "CARRY input",
      "{ .values = input.0; .payload = input.1; }",
    ),
  );
  assertEquals(checked.type, "(0 | 10 | 20 | 30)");
});

Deno.test("checked helpers structurally transport relationship packages", async () => {
  const checked = await checkSource(
    "/tmp/relationship-helper.blot",
    PRELUDE + `let carry = fn input => { .values = input.0; .payload = input.1; }
` + INDEX_PACKAGE_BODY.replace("CARRY", "carry"),
  );
  assertEquals(checked.type, "(0 | 10 | 20 | 30)");
});

Deno.test("relationship package transforms cross module values", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${directory}/packages.blot`,
    PRELUDE + `let carry = fn input => { .values = input.0; .payload = input.1; }
return { .carry = carry; }
`,
  );
  await Deno.writeTextFile(
    `${directory}/main.blot`,
    PRELUDE + `const Packages = import "./packages.blot"
` + INDEX_PACKAGE_BODY.replace("CARRY", "Packages.carry"),
  );
  const checked = await checkFile(`${directory}/main.blot`);
  assertEquals(checked.type, "(0 | 10 | 20 | 30)");
});

Deno.test("same-shaped data cannot forge relationship evidence", async () => {
  await assertRejects(
    () =>
      checkSource(
        "/tmp/forged-relationship.blot",
        PRELUDE + `sig at_index = [Int] -> Int -> Int
let at_index = fn values => fn candidate =>
  let package = { .payload = (candidate, 0); }
  let (index, _) = package.payload
  return @array.get values index
return at_index
`,
      ),
    BlotError,
    "BLOT_UNPROVEN_INDEX",
  );
});
