import { assert, assertEquals } from "@std/assert";
import type { Expr } from "./ast.ts";
import { parse } from "./parse.ts";

Deno.test("two-argument @handle elaborates to a computation transformer", async () => {
  const source = `const Effect = @effect { .read = Unit -> Int; }
let handler = { .read = fn ((), ?resume) => resume 1; }
let transformer = @handle (Effect, handler)
return transformer
`;
  const parsed = await parse(source);
  assert(parsed.ok);
  if (!parsed.ok) return;

  const binding = parsed.module.declarations[2];
  assert(binding !== undefined && binding.tag === "binding");
  if (binding === undefined || binding.tag !== "binding") return;
  assertEquals(binding.value.tag, "lambda");
  if (binding.value.tag !== "lambda") return;
  assertEquals(binding.value.body.tag, "lambda");

  const delayed = binding.value.body;
  if (delayed.tag !== "lambda") return;
  assertEquals(delayed.body.tag, "block");
  if (delayed.body.tag !== "block") return;
  const effectBinding = delayed.body.declarations[0];
  assert(effectBinding !== undefined && effectBinding.tag === "binding");
  if (effectBinding === undefined || effectBinding.tag !== "binding") return;
  assertHandleCall(effectBinding.value, "Effect");
});

Deno.test("boolean case uses the internal conditional representation", async () => {
  const source = `let choose = fn ready => case ready of
  #True => 1
  #False => 2
return choose
`;
  const parsed = await parse(source);
  assert(parsed.ok);
  if (!parsed.ok) return;

  const binding = parsed.module.declarations[0];
  assert(binding !== undefined && binding.tag === "binding");
  if (binding === undefined || binding.tag !== "binding") return;
  assertEquals(binding.value.tag, "lambda");
  if (binding.value.tag !== "lambda") return;
  assertEquals(binding.value.body.tag, "if");
  if (binding.value.body.tag !== "if") return;
  assertEquals(binding.value.body.branches.length, 1);
  assertEquals(binding.value.body.branches[0].consequence.tag, "int");
  assertEquals(binding.value.body.fallback?.tag, "int");
});

function assertHandleCall(expression: Expr, effectName: string): void {
  assert(expression.tag === "apply");
  if (expression.tag !== "apply") return;
  assertEquals(expression.fn.tag, "intrinsic");
  if (expression.fn.tag !== "intrinsic") return;
  assertEquals(expression.fn.name, "@handle");
  assertEquals(expression.arg.tag, "tuple");
  if (expression.arg.tag !== "tuple") return;
  assertEquals(expression.arg.elements.length, 3);
  assertEquals(expression.arg.elements[0].tag, "var");
  if (expression.arg.elements[0].tag !== "var") return;
  assertEquals(expression.arg.elements[0].name, effectName);
}
