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

Deno.test("source fixities define generic infix and prefix operators", async () => {
  const parsed = await parse(`infixr 60 (<++>) = combine
prefix 90 (!!) = negate
return !!(1 <++> 2 <++> 3)
`);
  assert(parsed.ok);
  if (!parsed.ok) return;
  const prefixed = parsed.module.result;
  assertEquals(prefixed.tag, "apply");
  if (prefixed.tag !== "apply") return;
  assertEquals(prefixed.fn.tag, "var");
  if (prefixed.fn.tag !== "var") return;
  assertEquals(prefixed.fn.name, "negate");

  const outer = binaryApplication(prefixed.arg);
  assertEquals(outer.target, "combine");
  assertEquals(outer.left.tag, "int");
  const nested = binaryApplication(outer.right);
  assertEquals(nested.target, "combine");
  assertEquals(nested.left.tag, "int");
  assertEquals(nested.right.tag, "int");
});

Deno.test("fixity headers do not change the semantic module extent", async () => {
  const source = `infixl 60 (<++>) = combine
return 1 <++> 2
`;
  const parsed = await parse(source);
  assert(parsed.ok);
  if (!parsed.ok) return;
  assertEquals(parsed.module.span.start, source.indexOf("return"));
  assertEquals(parsed.module.result.span.start, source.indexOf("return 1") + 7);
});

Deno.test("a source fixity overrides the standard source prelude", async () => {
  const parsed = await parse(`infixl 60 (+) = Custom.add
return 20 + 22
`);
  assert(parsed.ok);
  if (!parsed.ok) return;
  const application = binaryApplication(parsed.module.result);
  assertEquals(application.target, "Custom.add");
});

Deno.test("a source fixity may make a standard spelling non-associative", async () => {
  const parsed = await parse(`infix 60 (+) = Custom.add
return 1 + 2 + 3
`);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_NON_ASSOCIATIVE_CHAIN");
});

Deno.test("source fixity precedence must fit in u32", async () => {
  const parsed = await parse(`infixl 4294967296 (<++>) = combine
return 1 <++> 2
`);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_BAD_FIXITY");
});

Deno.test("a module cannot declare the same fixity form twice", async () => {
  const parsed = await parse(`infixl 60 (<++>) = left
infixr 60 (<++>) = right
return ()
`);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.diagnostics[0]?.code, "BLOT_DUPLICATE_FIXITY");
});

function binaryApplication(expression: Expr): {
  readonly target: string;
  readonly left: Expr;
  readonly right: Expr;
} {
  assert(expression.tag === "apply");
  assert(expression.fn.tag === "apply");
  const left = expression.fn.arg;
  const right = expression.arg;
  let target: Expr = expression.fn.fn;
  const names: string[] = [];
  while (target.tag === "field") {
    names.unshift(target.name);
    target = target.target;
  }
  assert(target.tag === "var");
  names.unshift(target.name);
  return { target: names.join("."), left, right };
}

function importInput(expression: Expr): string {
  assert(expression.tag === "apply");
  assert(expression.fn.tag === "apply");
  assert(expression.fn.fn.tag === "intrinsic");
  assertEquals(expression.fn.fn.name, "@import");
  assertEquals(expression.fn.arg.tag, "text");
  return expression.arg.tag;
}
