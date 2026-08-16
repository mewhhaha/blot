import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "../diagnostic.ts";
import { checkSource } from "./mod.ts";

const PRELUDE = `open import "blot:prelude"\n`;

function checkedWith(bound: string, declarations = ""): Promise<unknown> {
  return checkSource(
    "/tmp/relational-summary.blot",
    PRELUDE + declarations +
      `sig at = [Int] -> Int -> Int
let at = fn xs => fn n => case n >= 0 && ${bound} of
  #True => @array.get xs n
  #False => 0
export at
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
