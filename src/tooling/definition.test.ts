import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import {
  definitionAt,
  fieldDefinitionAt,
  signatureTypeAt,
} from "./definition.ts";

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

Deno.test("a signature header navigates to the binding it constrains", async () => {
  const source = `let answer :: Number
let answer = 42
return answer
`;
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("signature definition fixture did not parse");

  const signatureName = source.indexOf("answer");
  const bindingName = source.indexOf("answer", signatureName + 1);
  assertEquals(
    definitionAt(parsed.module, source, signatureName),
    { start: bindingName, end: bindingName + "answer".length },
  );
});

Deno.test("a local field navigates to its shape member", async () => {
  const source = `let record = { .answer = 42; }
return record.answer
`;
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("field definition fixture did not parse");

  const use = source.lastIndexOf("answer");
  const member = source.indexOf("answer");
  assertEquals(
    fieldDefinitionAt(parsed.module, source, use),
    { start: member, end: member + "answer".length },
  );
});

Deno.test("an attached field navigates to its source member", async () => {
  const source = `const Thing = #Thing ()
Thing := Thing <+ { .build = 42; }
return Thing.build
`;
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("attached definition fixture did not parse");

  const use = source.lastIndexOf("build");
  const member = source.indexOf("build");
  assertEquals(
    fieldDefinitionAt(parsed.module, source, use),
    { start: member, end: member + "build".length },
  );
});

Deno.test("a value occurrence finds the explicit type value in its signature", async () => {
  const source = `const Point = { .x = Number; }
let point :: Point
let point = { .x = 42; }
return point
`;
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error("type definition fixture did not parse");

  const type = signatureTypeAt(
    parsed.module,
    source,
    source.lastIndexOf("point"),
  );
  assertEquals(type?.tag, "var");
  if (type?.tag !== "var") return;
  assertEquals(type.name, "Point");
});

Deno.test("a nested value finds the signature in its own block scope", async () => {
  const source = `let run = fn () => do:
  const Point = { .x = Number; }
  let point :: Point
  let point = { .x = 42; }
  return point
return run ()
`;
  const parsed = await parse(source);
  if (!parsed.ok) {
    throw new Error("nested type definition fixture did not parse");
  }

  const type = signatureTypeAt(
    parsed.module,
    source,
    source.lastIndexOf("point"),
  );
  assertEquals(type?.tag, "var");
  if (type?.tag !== "var") return;
  assertEquals(type.name, "Point");
});
