import assert from "node:assert/strict";
import test from "node:test";
import { parseConcrete } from "../syntax/parse.ts";
import { controlFlowAt } from "./control_flow.ts";
import { hoverAt } from "./hover.ts";

async function description(source: string, needle: string, last = false) {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  let offset = source.indexOf(needle);
  if (last) offset = source.lastIndexOf(needle);
  assert.notEqual(offset, -1);
  return controlFlowAt(parsed.module, source, parsed.cst, offset);
}

test("return through a conditional and loop points at the explicit do", async () => {
  const source = `let find = fn values => do:
  for value in values:
    if value > 0:
      return value
  return 0
return find
`;
  const found = await description(source, "return value");
  assert.equal(
    found?.markdown,
    "**return** — supplies the result of `do` on line 1.",
  );
  assert.equal(source.slice(found!.target.start, found!.target.end), "do");
  const outer = await description(source, "return find");
  assert.equal(
    outer?.markdown,
    "**return** — supplies the result of this module.",
  );
});

test("nested do scopes retain their own return destination", async () => {
  const source = `let value = do:
  let inner = do:
    return 1
  return inner
return value
`;
  const inner = await description(source, "return 1");
  assert.match(inner!.markdown, /line 2/);
  const outer = await description(source, "return inner");
  assert.match(outer!.markdown, /line 1/);
});

test("break chooses the nearest for through statement conditionals", async () => {
  const source = `for outer in values:
  for inner in values:
    if inner > 1:
      break
  break
return 0
`;
  const inner = await description(source, "break");
  assert.match(inner!.markdown, /line 2/);
  const outer = await description(source, "break", true);
  assert.match(outer!.markdown, /line 1/);
});

test("loop hover uses lowered accumulator evidence and excludes local shadows", async () => {
  const source = `let total = 0
let local = 100
for value in values:
  let local = value
  local := local + 1
  if local > 1:
    total := total + local
return total
`;
  const found = await description(source, "for value");
  assert.match(found!.markdown, /Loop accumulator: `total`\./);
  assert.doesNotMatch(found!.markdown, /`local`/);
});

test("an empty accumulator is distinguished from missing lowering metadata", async () => {
  const source = `for value in values:
  let local = value
return 0
`;
  const found = await description(source, "for value");
  assert.match(found!.markdown, /carries no outer bindings/);
});

test("keyword-shaped fields are not control flow", async () => {
  const source = "return { .return = 1; .break = 2; .for = 3; }\n";
  for (const name of ["return =", "break =", "for ="]) {
    assert.equal(await description(source, name), null);
  }
});

test("control flow is available through the existing hover entry point", async () => {
  const source = "let x = do:\n  return 1\nreturn x\n";
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new Error("source did not parse");
  const found = hoverAt(
    parsed.module,
    source,
    parsed.cst,
    source.indexOf("return 1"),
    null,
  );
  assert.match(found!.markdown, /`do` on line 1/);
});
