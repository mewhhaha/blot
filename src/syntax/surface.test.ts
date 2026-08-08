import { assert, assertEquals } from "@std/assert";
import type { Expr } from "./ast.ts";
import { parse, parseConcrete } from "./parse.ts";

Deno.test("a deferred lambda parameter is recorded on the lambda", async () => {
  const parsed = await parse(`let lazy = fn ~value => value
return lazy
`);
  assert(parsed.ok);
  if (!parsed.ok) return;
  const binding = parsed.module.declarations[0];
  assert(binding !== undefined && binding.tag === "binding");
  if (binding === undefined || binding.tag !== "binding") return;
  assertEquals(binding.value.tag, "lambda");
  if (binding.value.tag !== "lambda") return;
  assertEquals(binding.value.deferred, true);
  assertEquals(binding.value.parameter.tag, "name");
});

Deno.test("a deferred lambda parameter must be one name", async () => {
  const parsed = await parse(`let lazy = fn ~(left, right) => left
return lazy
`);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_BAD_DEFERRED_PARAMETER");
});

Deno.test("do is an explicit value-producing statement scope", async () => {
  const source = `let value = do:
  let local = 1
  return local
return value
`;
  const parsed = await parse(source);
  assert(parsed.ok);
  if (!parsed.ok) return;
  const binding = parsed.module.declarations[0];
  assert(binding !== undefined && binding.tag === "binding");
  if (binding === undefined || binding.tag !== "binding") return;
  assertEquals(binding.value.tag, "block");
  if (binding.value.tag !== "block") return;
  assertEquals(binding.value.declarations.length, 1);
  assertEquals(binding.value.result.tag, "var");
});

Deno.test("a closure cannot rebind a captured outer lineage", async () => {
  const source = `let x = 0
let change = fn () => do:
  x := 1
  return x
return change
`;
  const parsed = await parse(source);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_REBINDING_FRAME");
});

Deno.test("a local let starts a rebinding lineage inside a closure", async () => {
  const source = `let x = 0
let change = fn () => do:
  let x = x
  x := 1
  return x
return change
`;
  const parsed = await parse(source);
  assert(parsed.ok);
});

Deno.test("a closure parameter belongs to its rebinding frame", async () => {
  const source = `let bump = fn x => do:
  x := @int.add x 1
  return x
return bump
`;
  const parsed = await parse(source);
  assert(parsed.ok);
});

Deno.test("an inner curried closure cannot rebind an outer parameter", async () => {
  const source = `let update = fn outer => fn inner => do:
  outer := inner
  return outer
return update
`;
  const parsed = await parse(source);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_REBINDING_FRAME");
});

Deno.test("a curried closure can start a local lineage from its capture", async () => {
  const source = `let update = fn outer => fn inner => do:
  let outer = outer
  outer := inner
  return outer
return update
`;
  const parsed = await parse(source);
  assert(parsed.ok);
});

Deno.test("statement control flow keeps the surrounding rebinding frame", async () => {
  const source = `let x = 0
if True:
  x := 1
for ever:
  x := @int.add x 1
  break
return x
`;
  const parsed = await parse(source);
  assert(parsed.ok);
});

Deno.test("a nested do cannot rebind its enclosing do lineage", async () => {
  const source = `let value = do:
  let x = 0
  let nested = do:
    x := 1
    return x
  return nested
return value
`;
  const parsed = await parse(source);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_REBINDING_FRAME");
});

Deno.test("a case arm cannot rebind its enclosing lineage", async () => {
  const source = `let x = 0
let value = case True of
  #True => do:
    x := 1
    return x
  #False => 0
return value
`;
  const parsed = await parse(source);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_REBINDING_FRAME");
});

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

Deno.test("handler pipelines become nested handled computations", async () => {
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

  const binding = parsed.module.declarations.find((declaration) =>
    declaration.tag === "binding" && declaration.pattern.tag === "name" &&
    declaration.pattern.name === "handled"
  );
  assert(binding !== undefined && binding.tag === "binding");
  if (binding === undefined || binding.tag !== "binding") return;

  // Each step is the saturated call itself rather than an application of the
  // transformer, so the written computation reaches `@handle` unchanged.
  const outer = handledArguments(binding.value);
  assert(outer !== null);
  if (outer === null) return;
  assertEquals(variableName(outer[0]), "Second");
  const inner = handledArguments(outer[1]);
  assert(inner !== null);
  if (inner === null) return;
  assertEquals(variableName(inner[0]), "First");
  assertEquals(variableName(inner[1]), "program");
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

Deno.test("value if is absent from the production grammar", async () => {
  const source = `let value = if True:
  return 1
else:
  return 2
return value
`;
  const parsed = await parseConcrete(source);
  assert(!parsed.ok);
});

Deno.test("try-with is absent from the production grammar", async () => {
  // `try` and `with` are ordinary identifiers, so the retired spelling
  // parses as the application `try program with (@handle ...)` — the
  // indented line is a layout continuation, not a handler suite — and is
  // left to fail at check because nothing binds `try`.
  const source = `let program = fn () => 1
let handler = {}
let value = try program with
  @handle (Effect, handler)
return value
`;
  const parsed = await parse(source);
  assert(parsed.ok);
});

function handledArguments(expression: Expr): readonly Expr[] | null {
  if (expression.tag !== "lambda" || expression.parameter.tag !== "unit") {
    return null;
  }
  const body = expression.body;
  if (body.tag !== "block") return null;
  const declaration = body.declarations[0];
  if (declaration === undefined || declaration.tag !== "binding") return null;
  const call = declaration.value;
  if (call.tag !== "apply" || call.fn.tag !== "intrinsic") return null;
  if (call.fn.name !== "@handle") return null;
  if (call.arg.tag !== "tuple" || call.arg.elements.length !== 3) return null;
  return call.arg.elements;
}

function variableName(expression: Expr): string | null {
  if (expression.tag !== "var") return null;
  return expression.name;
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
