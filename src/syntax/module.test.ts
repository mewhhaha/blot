import { assert, assertEquals } from "@std/assert";
import type { Expr } from "./ast.ts";
import { parse } from "./parse.ts";

Deno.test("a module exports one value and imports instantiate immediately", async () => {
  const parsed = await parse(
    `module with capabilities
let plain = import "./plain.blot"
let configured = import "./configured.blot" with capabilities
export { .plain = plain; .configured = configured; }
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

Deno.test("the module boundary requires export and permits an early return", async () => {
  const missing = await parse("let value = 1\n");
  assert(!missing.ok);
  assertEquals(missing.diagnostics[0]?.code, "BLOT_MISSING_EXPORT");

  const returning = await parse("return 1\nexport 2\n");
  assert(returning.ok);
  assertEquals(returning.module.result.tag, "case");
});

Deno.test("the exposed module-function import spelling is retired", async () => {
  const parsed = await parse('export @import "./dependency.blot" ()\n');
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
