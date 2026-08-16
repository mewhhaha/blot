import { assert, assertEquals } from "@std/assert";
import type { Expr } from "./ast.ts";
import { parse } from "./parse.ts";

Deno.test("a module returns one value and imports instantiate immediately", async () => {
  const parsed = await parse(
    `module with capabilities
let plain = import "./plain.blot"
let configured = import "./configured.blot" with capabilities
return { .plain = plain; .configured = configured; }
`,
  );
  assert(parsed.ok);
  assertEquals(parsed.module.parameter?.tag, "name");
  assertEquals(parsed.module.declarations.length, 2);

  const plain = parsed.module.declarations[0];
  assert(plain !== undefined && plain.tag === "binding");
  assertEquals(importInput(plain.value), "unit");

  const configured = parsed.module.declarations[1];
  assert(configured !== undefined && configured.tag === "binding");
  assertEquals(importInput(configured.value), "var");
});

Deno.test("modules share return and unit fallthrough with do blocks", async () => {
  const empty = await parse("");
  assert(empty.ok);
  assertEquals(empty.module.result.tag, "unit");

  const fallthrough = await parse("let value = 1\n");
  assert(fallthrough.ok);
  assertEquals(fallthrough.module.result.tag, "unit");

  const returning = await parse("return 1\nlet unreachable = 2\n");
  assert(returning.ok);
  assertEquals(returning.module.result.tag, "case");
});

Deno.test("the exposed module-function import spelling is retired", async () => {
  const parsed = await parse('return @import "./dependency.blot" ()\n');
  assert(!parsed.ok);
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_RETIRED_IMPORT");
});

function importInput(expression: Expr): string {
  assert(expression.tag === "apply");
  assert(expression.fn.tag === "apply");
  assert(expression.fn.fn.tag === "intrinsic");
  assertEquals(expression.fn.fn.name, "@import");
  assertEquals(expression.fn.arg.tag, "text");
  return expression.arg.tag;
}
