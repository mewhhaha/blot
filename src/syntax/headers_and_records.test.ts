import { assert, assertEquals } from "@std/assert";
import { parse } from "./parse.ts";
import { formatSource } from "../tooling/formatter.ts";

const sources = [
  `const left = fn (a :: Int, b) => a
const right = fn (a, b :: Int) => b
const result = fn (a, b) -> Int => a
const mixed = fn (a, b :: Int) -> Int => b
const scalar = fn a -> Int => a
return { .left; .right; .result; .mixed; .scalar; }
`,
  `const add = fn (a :: Int, b :: Int) -> Int => do:
  return a + b
return { .add; }
`,
  `const rec count = fn (n :: Int) -> Int => do:
  if n == 0:
    return 42
  else:
    return count (n - 1)
return count
`,
  `const expose = fn (!value :: Int) -> Int => value
return expose
`,
  `return {
  .first = 1
  .nested = {
    .value = 2
  }
  .read = fn (x :: Int) -> Int => do:
    let y = x + 1
    return y
  .last = object
    .field
}
`,
  `const value = 1
const record = {
  .value
  // This comment belongs to the next field.
  .other = value +
    1
}
const {
  .value
  .other
} = record
return other
`,
  `return {
  ...base
  .[name] = 1
  .return = fn () => do:
    return {
      .ok = True
    }
}
`,
];

for (const [index, source] of sources.entries()) {
  Deno.test(`typed headers and record layout round trip ${index + 1}`, async () => {
    const parsed = await parse(source);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const formatted = await formatSource(source);
    assert(formatted.ok, JSON.stringify(formatted));
    const reparsed = await parse(formatted.source);
    if (!reparsed.ok) throw new Error(JSON.stringify(reparsed));
    assertEquals(await formatSource(formatted.source), formatted);
    if (source.includes("do:")) assert(formatted.source.includes("do:"));
  });
}

Deno.test("record boundaries require separators on the same line", async () => {
  assertEquals((await parse("return { .a = 1 .b = 2 }\n")).ok, false);
  assertEquals((await parse("return { .a = 1; .b = 2; }\n")).ok, true);
});

Deno.test("typed headers elaborate to signatures and ordinary unary lambdas", async () => {
  const parsed = await parse(sources[1]);
  assert(parsed.ok);
  assertEquals(
    parsed.module.declarations.map((declaration) => declaration.tag),
    ["signature", "binding"],
  );
  const declaration = parsed.module.declarations[1];
  assert(declaration.tag === "binding" && declaration.value.tag === "lambda");
  assertEquals(declaration.value.parameter.tag, "tuple");
});

Deno.test("pattern annotations outside function headers are diagnosed", async () => {
  assertEquals((await parse("let (x :: Int) = 1\nreturn x\n")).ok, false);
});
