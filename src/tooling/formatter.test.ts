import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { formatSource } from "./formatter.ts";

Deno.test("formatting applies structural indentation without losing comments", async () => {
  const source = `// choose a label
let choose = fn n => if n == 1 then "one"
else "other"
return choose 1
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `// choose a label
let choose = fn n => if n == 1 then "one"
else "other"
return choose 1
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting refuses source the compiler cannot parse", async () => {
  const formatted = await formatSource(`let value = 1
`);
  if (formatted.ok) throw new Error("invalid source formatted successfully");
  assertEquals(formatted.diagnostics[0]?.code, "BLOT_MISSING_RESULT");
});

Deno.test("formatting removes only precedence-redundant parentheses", async () => {
  const source = `let imported = (@import "module") ()
let atom = (1)
let left = (apply 1) 2
let right = apply (apply 1)
let grouped = (1 + 2) * 3
return (imported, atom, left, right, grouped)
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let imported = @import "module" ()
let atom = 1
let left = apply 1 2
let right = apply (apply 1)
let grouped = (1 + 2) * 3
return (imported, atom, left, right, grouped)
`,
  );
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting retains interacting parentheses when flattening changes application", async () => {
  const source = `let nested = apply ((apply 1))
return nested
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, source);
});

Deno.test("formatting indents scoped returns as statements", async () => {
  const source = `let result =
 if 1 == 1 then
  return 1
 return 2
return result
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let result =
  if 1 == 1 then
    return 1
  return 2
return result
`,
  );
});

function semanticTree(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, field) => {
    if (key === "span") return undefined;
    if (typeof field === "bigint") return field.toString();
    return field;
  }));
}
