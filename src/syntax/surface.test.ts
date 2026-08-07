import { assert, assertEquals } from "@std/assert";
import type { Expr } from "./ast.ts";
import { parse } from "./parse.ts";

Deno.test(
  "two-argument @handle elaborates to a computation transformer",
  async () => {
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
    assertEquals(binding.value.parameter.tag, "name");
    if (binding.value.parameter.tag !== "name") return;
    assertEquals(binding.value.parameter.qualifier, "linear");
    assertEquals(binding.value.body.tag, "lambda");

    const delayed = binding.value.body;
    if (delayed.tag !== "lambda") return;
    assertEquals(delayed.body.tag, "block");
    if (delayed.body.tag !== "block") return;
    const effectBinding = delayed.body.declarations[0];
    assert(effectBinding !== undefined && effectBinding.tag === "binding");
    if (effectBinding === undefined || effectBinding.tag !== "binding") return;
    assertHandleCall(effectBinding.value, "Effect");
  },
);

Deno.test("handler pipelines become nested direct applications", async () => {
  const source = `open @import "blot:prelude" ()
const First = @effect { .read = Unit -> Int; }
const Second = @effect { .write = Int -> Unit; }
let first_handler = { .read = fn ((), ?resume) => resume 1; }
let second_handler = { .write = fn (_, ?resume) => resume (); }
let program = fn () => 1
let handled = program
  |> @handle (First, first_handler)
  |> @handle (Second, second_handler)
return handled
`;
  const parsed = await parse(source);
  assert(parsed.ok);
  if (!parsed.ok) return;

  const binding = parsed.module.declarations[5];
  assert(binding !== undefined && binding.tag === "binding");
  if (binding === undefined || binding.tag !== "binding") return;
  assertEquals(binding.value.tag, "apply");
  if (binding.value.tag !== "apply") return;
  assertEquals(transformerEffect(binding.value.fn), "Second");
  assertEquals(binding.value.arg.tag, "apply");
  if (binding.value.arg.tag !== "apply") return;
  assertEquals(transformerEffect(binding.value.arg.fn), "First");
  assertEquals(binding.value.arg.arg.tag, "var");
  if (binding.value.arg.arg.tag !== "var") return;
  assertEquals(binding.value.arg.arg.name, "program");
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

function transformerEffect(expression: Expr): string | null {
  if (expression.tag !== "lambda" || expression.body.tag !== "lambda") {
    return null;
  }
  const body = expression.body.body;
  if (body.tag !== "block") return null;
  const declaration = body.declarations[0];
  if (declaration === undefined || declaration.tag !== "binding") return null;
  const call = declaration.value;
  if (call.tag !== "apply" || call.arg.tag !== "tuple") return null;
  const effect = call.arg.elements[0];
  if (effect === undefined || effect.tag !== "var") return null;
  return effect.name;
}

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
