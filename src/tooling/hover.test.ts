import { assertEquals } from "@std/assert";
import { parseConcrete } from "../syntax/parse.ts";
import { hoverAt } from "./hover.ts";

Deno.test("recursive value hover keeps rec on the binding header", async () => {
  const source = `let rec factorial = fn n => factorial n
return factorial
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("recursive binding did not parse");

  const hover = hoverAt(
    parsed.module,
    source,
    parsed.cst,
    source.lastIndexOf("factorial"),
    null,
  );
  assertEquals(
    hover?.markdown,
    `\`\`\`blot
let rec factorial = fn n => body
\`\`\``,
  );
});

Deno.test("compile-time block hover uses its surface spelling", async () => {
  const source = `let value = compdo:
  return 1
return value
`;
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("compile-time block did not parse");

  const hover = hoverAt(
    parsed.module,
    source,
    parsed.cst,
    source.indexOf("compdo"),
    null,
  );
  assertEquals(
    hover?.markdown,
    "Introduces a compile-time statement scope with its own `return` target.",
  );
});
