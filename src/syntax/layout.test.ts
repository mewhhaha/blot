import { assertEquals } from "@std/assert";
import { elaborateLayout } from "./layout.ts";
import { parse } from "./parse.ts";

Deno.test("continuation guidance uses the rejected declaration's source tokens", async () => {
  for (const [source, token, guidance] of [
    ["const twice = fn value =>\n  value\nreturn twice\n", "=>", "`do:`"],
    ["const Choice =\n  #First\n  | #Second\nreturn Choice\n", "|", "parentheses"],
  ]) {
    const result = await parse(source);
    if (result.ok) throw new Error("invalid continuation was accepted");
    const diagnostic = result.diagnostics[0];
    assertEquals(diagnostic.message.includes(guidance), true);
    assertEquals(source.slice(diagnostic.span.start, diagnostic.span.end), token);
  }
  for (const source of [
    "const twice = fn value => do:\n  return value\nreturn twice\n",
    "const Choice = (\n  #First\n  | #Second\n)\nreturn Choice\n",
  ]) {
    assertEquals((await parse(source)).ok, true);
  }
  const unrelated = await parse("const broken = )\nconst later = fn value =>\n  value\nreturn later\n");
  if (unrelated.ok) throw new Error("invalid delimiter was accepted");
  assertEquals(unrelated.diagnostics[0].message.includes("`do:`"), false);
});

Deno.test("layout elaboration inserts suites only outside delimiters", async () => {
  const source = `let choose = fn condition =>
  let values = [
    1,
    2,
  ];
  return if condition : values.0 else: values.1;
return choose;
`;
  const result = await elaborateLayout(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(
    visible(result.layout.source),
    `let choose = fn condition =>\n  <NL><IN>let values = [\n    1,\n    2,\n  ];\n  <NL>return if condition : values.0 else: values.1;\n<NL><DED><NL>return choose;<NL>\n`,
  );
  for (let offset = 0; offset <= result.layout.source.length; offset += 1) {
    const original = result.layout.originalOffset(offset);
    assertEquals(original >= 0 && original <= source.length, true);
  }
});

Deno.test("layout elaboration treats indentation without an introducer as continuation", async () => {
  const source = `let value = 1;
  return value;
`;
  const result = await elaborateLayout(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(
    visible(result.layout.source),
    `let value = 1;\n  return value;<NL>\n`,
  );
});

Deno.test("layout elaboration rejects a dedent between active suites", async () => {
  const source = `let outer =
    let value =
      return 1;
   return value;
return outer;
`;
  const result = await elaborateLayout(source);
  if (result.ok) throw new Error("inconsistent indentation was accepted");
  assertEquals(result.diagnostics[0]?.code, "BLOT_INCONSISTENT_INDENT");
});

Deno.test("layout elaboration opens an explicit do suite", async () => {
  const source = `let value = do:
  let local = 1
  return local
return value
`;
  const result = await elaborateLayout(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(
    visible(result.layout.source).includes("<IN>let local = 1"),
    true,
  );
});

Deno.test("parentheses do not introduce statement suites", async () => {
  const source = `let value = (
  let local = 1
  return local
)
return value
`;
  const result = await elaborateLayout(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(visible(result.layout.source).includes("(<NL><IN>"), false);
});

Deno.test("layout markers precede a trailing line comment", async () => {
  const result = await elaborateLayout("return 1 // changed");
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(
    visible(result.layout.source),
    "return 1<NL> // changed",
  );
});

function visible(source: string): string {
  return source.replaceAll("\u{e000}", "<NL>")
    .replaceAll("\u{e001}", "<IN>")
    .replaceAll("\u{e002}", "<DED>");
}
