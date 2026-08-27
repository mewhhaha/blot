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
