import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { lintModule } from "./lint.ts";

Deno.test("an equality if chain prefers one case match", async () => {
  const source = 'let label = fn n => if n == 1 then "one" ' +
    'else if n == 2 then "two" else "other" end;\n' +
    "return label;";
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source).map((diagnostic) => diagnostic.code),
    ["BLOT_LINT_IF_CHAIN"],
  );
});

Deno.test("a conditional whose branches agree is redundant", async () => {
  const source =
    'let label = fn ready => if ready then "same" else "same" end;\n' +
    "return label;";
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("lint fixture did not parse");

  assertEquals(
    lintModule(parsed.module, source).map((diagnostic) => diagnostic.code),
    ["BLOT_LINT_REDUNDANT_IF"],
  );
});
