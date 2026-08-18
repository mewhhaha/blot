import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { definitionAt } from "./definition.ts";

Deno.test("definition lookup follows lexical shadowing", async () => {
  const source = `let value = 1
let inner = fn value => value
return (inner value, value)
`;
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("definition fixture did not parse");

  const parameter = source.indexOf("value =>");
  const innerUse = source.indexOf("value\n", parameter);
  const outerUse = source.lastIndexOf("value)");

  assertEquals(
    definitionAt(parsed.module, source, innerUse + 1),
    { start: parameter, end: parameter + "value".length },
  );
  assertEquals(
    definitionAt(parsed.module, source, outerUse + 1),
    { start: 4, end: 9 },
  );
});

Deno.test("definition lookup sees every member of a recursive group", async () => {
  const source = `let rec even = fn n => odd n
let rec odd = fn n => even n
return even
`;
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("definition fixture did not parse");

  const oddUse = source.indexOf("odd n");
  const oddDefinition = source.indexOf("odd =");
  assertEquals(
    definitionAt(parsed.module, source, oddUse + 1),
    { start: oddDefinition, end: oddDefinition + "odd".length },
  );
});
