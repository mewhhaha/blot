import { assertEquals, assertRejects } from "@std/assert";
import { parseSourceFixities } from "./source_fixities.ts";

Deno.test("source fixities cover every associativity", async () => {
  assertEquals(
    await parseSourceFixities(`
infixl 60 (+) = Int.add
infix 30 (==) = Int.eq
infixr 10 ($) = Fn.apply
prefix 90 (!) = @linear.own
`),
    [
      {
        operator: "+",
        associativity: "left",
        precedence: 60,
        target: "Int.add",
      },
      {
        operator: "==",
        associativity: "none",
        precedence: 30,
        target: "Int.eq",
      },
      {
        operator: "$",
        associativity: "right",
        precedence: 10,
        target: "Fn.apply",
      },
      {
        operator: "!",
        associativity: "prefix",
        precedence: 90,
        target: "@linear.own",
      },
    ],
  );
});

Deno.test("source fixity generation rejects duplicate forms", async () => {
  await assertRejects(
    () =>
      parseSourceFixities(`
infixl 60 (+) = Int.add
infixr 60 (+) = Int.add
`),
    Error,
    "duplicate operator infix:+",
  );
});
