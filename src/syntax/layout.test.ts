import { assertEquals } from "@std/assert";
import { elaborateLayout } from "./layout.ts";

Deno.test("layout elaboration inserts suites only outside delimiters", async () => {
  const source = `let choose = fn condition =>
  let values = [
    1,
    2,
  ];
  return if condition : values.0 else: values.1;
export choose;
`;
  const result = await elaborateLayout(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(
    visible(result.layout.source),
    `let choose = fn condition =>\n  <NL><IN>let values = [\n    1,\n    2,\n  ];\n  <NL>return if condition : values.0 else: values.1;\n<NL><DED><NL>export choose;<NL>\n`,
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
export outer;
`;
  const result = await elaborateLayout(source);
  if (result.ok) throw new Error("inconsistent indentation was accepted");
  assertEquals(result.diagnostics[0]?.code, "BLOT_INCONSISTENT_INDENT");
});

Deno.test("layout elaboration opens an explicit do suite", async () => {
  const source = `let value = do:
  let local = 1
  return local
export value
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
export value
`;
  const result = await elaborateLayout(source);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(visible(result.layout.source).includes("(<NL><IN>"), false);
});

Deno.test("layout markers precede a trailing line comment", async () => {
  const result = await elaborateLayout("export 1 // changed");
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  assertEquals(
    visible(result.layout.source),
    "export 1<NL> // changed",
  );
});

function visible(source: string): string {
  return source.replaceAll("\u{e000}", "<NL>")
    .replaceAll("\u{e001}", "<IN>")
    .replaceAll("\u{e002}", "<DED>");
}
