import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "../diagnostic.ts";
import { checkSource } from "./mod.ts";

const PRELUDE = `open import "blot:prelude"\n`;

Deno.test("sig and @satisfies share canonical requirement checking", async () => {
  const checked = await checkSource(
    "/tmp/requirements.blot",
    PRELUDE + `let increment = fn value =>
  let value = @satisfies value Int
  return value + 1

sig checked = Int -> Int
let checked = increment
return checked
`,
  );
  assertEquals(checked.type, "Int -> Int");
});

Deno.test("[a] is one homogeneous element constraint", async () => {
  const checked = await checkSource(
    "/tmp/homogeneous-array.blot",
    PRELUDE + `let count = fn values => Array.length values
let ints = count [1, 2]
let texts = count ["a", "b"]
return count
`,
  );
  assertEquals(checked.type, "['a] -> Int");
});

Deno.test("an empty array type value means Array bottom", async () => {
  await assertRejects(
    () =>
      checkSource(
        "/tmp/empty-array-requirement.blot",
        PRELUDE + `return @satisfies [1] []\n`,
      ),
    BlotError,
    "`1` is not nothing",
  );
});

Deno.test("typestate and effect contracts compose with Omega", async () => {
  const checked = await checkSource(
    "/tmp/typestate-effect.blot",
    PRELUDE + `const Audit = @effect { .record = Str -> Unit; }
const Transition = (#Closed Int) -> (#Open Int) ~ { Audit }

sig advance = Transition
let advance = fn !state =>
  result <- case state of
    #Closed value =>
      <- Audit.record "open"
      return #Open value
  return result

let handler = {
  .record = fn (_, ?resume) => resume ();
  .return = fn value => value;
}
let run = fn () =>
  let !closed = #Closed 7
  return advance (!closed)

return @handle (Audit, run, handler)
`,
  );
  assertEquals(checked.type, "#Open Int");
});
