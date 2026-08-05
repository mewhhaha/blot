import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { formatSource } from "./formatter.ts";

Deno.test("formatting applies structural indentation without losing comments", async () => {
  const source = "// choose a label\r\n" +
    "let choose = fn n => if n == 1\r\n" +
    'then "one"   \r\n' +
    'else "other"\r\n' +
    "end;\r\n" +
    "return choose 1;";

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    "// choose a label\n" +
      "let choose = fn n => if n == 1\n" +
      '  then "one"\n' +
      '  else "other"\n' +
      "end;\n" +
      "return choose 1;\n",
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting refuses source the compiler cannot parse", async () => {
  const formatted = await formatSource("let value = 1;");
  if (formatted.ok) throw new Error("invalid source formatted successfully");
  assertEquals(formatted.diagnostics[0]?.code, "BLOT_MISSING_RESULT");
});

Deno.test("formatting removes only precedence-redundant parentheses", async () => {
  const source = 'let imported = (@import "module") ();\n' +
    "let atom = (1);\n" +
    "let left = (apply 1) 2;\n" +
    "let right = apply (apply 1);\n" +
    "let grouped = (1 + 2) * 3;\n" +
    "return (imported, atom, left, right, grouped);";

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    'let imported = @import "module" ();\n' +
      "let atom = 1;\n" +
      "let left = apply 1 2;\n" +
      "let right = apply (apply 1);\n" +
      "let grouped = (1 + 2) * 3;\n" +
      "return (imported, atom, left, right, grouped);\n",
  );
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting retains interacting parentheses when flattening changes application", async () => {
  const source = "let nested = apply ((apply 1));\nreturn nested;";
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, `${source}\n`);
});

Deno.test("formatting indents scoped returns as statements", async () => {
  const source = "return do\n" +
    "if 1 == 1 then\n" +
    "return 1;\n" +
    "end;\n" +
    "return 2;\n" +
    "end;";
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    "return do\n" +
      "  if 1 == 1 then\n" +
      "    return 1;\n" +
      "  end;\n" +
      "  return 2;\n" +
      "end;\n",
  );
});

function semanticTree(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, field) => {
    if (key === "span") return undefined;
    if (typeof field === "bigint") return field.toString();
    return field;
  }));
}
