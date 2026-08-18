import { assertEquals } from "@std/assert";
import { parse } from "./parse.ts";

Deno.test("a recursive binding header lowers to the existing Rec AST", async () => {
  const parsed = await parse(`let rec factorial = fn n => factorial n
return factorial
`);
  if (!parsed.ok) throw new Error("recursive binding fixture did not parse");

  const declaration = parsed.module.declarations[0];
  assertEquals(declaration?.tag, "binding");
  if (declaration?.tag !== "binding") {
    throw new Error("recursive binding fixture did not lower to a binding");
  }
  assertEquals(declaration.kind, "let");
  assertEquals(declaration.pattern.tag, "name");
  assertEquals(declaration.value.tag, "rec");
  if (declaration.value.tag !== "rec") {
    throw new Error("recursive binding fixture omitted its recursive root");
  }
  assertEquals(declaration.value.lambda.tag, "lambda");
});

Deno.test("const rec uses the same recursive AST under its phase", async () => {
  const parsed = await parse(`const rec factorial = fn n => factorial n
return factorial
`);
  if (!parsed.ok) throw new Error("const recursive fixture did not parse");

  const declaration = parsed.module.declarations[0];
  if (declaration?.tag !== "binding") {
    throw new Error("const recursive fixture did not lower to a binding");
  }
  assertEquals(declaration.kind, "const");
  assertEquals(declaration.value.tag, "rec");
});

Deno.test("the former rec expression syntax is a hard parse error", async () => {
  const parsed = await parse(`let factorial = rec (fn n => factorial n)
return factorial
`);
  assertEquals(parsed.ok, false);
});

Deno.test("a signature cannot carry the rec binding modifier", async () => {
  const parsed = await parse(`sig rec factorial = Int -> Int
let rec factorial = fn n => n
return factorial
`);
  assertEquals(parsed.ok, false);
});
