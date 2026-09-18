import { assert, assertEquals } from "@std/assert";
import { parse } from "./parse.ts";
import { formatSource } from "../tooling/formatter.ts";

const annotatedPrograms = [
  "let apply:\n  (Int -> Int ~ { ..e }) ->\n  Int -> Int ~ { Console, ..e }\nlet apply = fn f => f\nreturn apply\n",
  "const f = fn (x:\n  Int, y:\n  Int) -> Int => x\nreturn f\n",
  "let answer: Int\nlet answer = 42\nreturn answer\n",
  "const answer:Int=42\nreturn answer\n",
  "const rec count: Int -> Int = fn (n: Int) -> Int => n\nreturn count\n",
  "use answer: Int <- Clock.read ()\nreturn answer\n",
  "const f = fn (!a: Int, &b: [Int], ?c: Int) -> Int => a\nreturn f\n",
  "const f:\n  Int -> Int\nconst f = fn x => x\nreturn f\n",
  "const f = fn (x: Int) -> Int => do:\n  let y: Int = x\n  y := 42\n  if y == 42:\n    return y\n  else:\n    return 0\nreturn f\n",
];

for (const [index, source] of annotatedPrograms.entries()) {
  Deno.test(`single-colon annotation parses and formats ${index + 1}`, async () => {
    const parsed = await parse(source);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const formatted = await formatSource(source);
    assert(formatted.ok, JSON.stringify(formatted));
    assert((await parse(formatted.source)).ok);
    assertEquals(await formatSource(formatted.source), formatted);
  });
}

Deno.test("annotations are tight before the colon and spaced after it", async () => {
  assertEquals(await formatSource("let x :Int=1\nreturn x\n"), {
    ok: true,
    source: "let x: Int = 1\nreturn x\n",
  });
});

Deno.test("double-colon typing is rejected, not accepted as an alias", async () => {
  for (
    const source of [
      "let x :: Int\nlet x = 1\nreturn x\n",
      "const x :: Int = 1\nreturn x\n",
      "const f = fn (x :: Int) => x\nreturn f\n",
      "use x :: Int <- Clock.read ()\nreturn x\n",
    ]
  ) {
    assertEquals((await parse(source)).ok, false, source);
  }
});

Deno.test("colon tokens in text and comments retain their contents", async () => {
  const source = 'let x: Text = ":: := :" // keep :: here\nreturn x\n';
  assert((await parse(source)).ok);
  assertEquals(await formatSource(source), { ok: true, source });
});

Deno.test("single-colon annotations preserve CRLF source spans", async () => {
  const source = 'const text = "λ"\r\nlet x: Int\r\nlet x = 42\r\nreturn x\r\n';
  const parsed = await parse(source);
  assert(parsed.ok);
  const signature = parsed.module.declarations.find((declaration) =>
    declaration.tag === "signature"
  );
  assert(signature !== undefined && signature.tag === "signature");
  assertEquals(
    source.slice(signature.value.span.start, signature.value.span.end),
    "Int",
  );
});
