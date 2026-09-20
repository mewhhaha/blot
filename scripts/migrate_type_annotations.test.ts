import { assertEquals, assertRejects } from "@std/assert";
import { migrateTypeAnnotations } from "./migrate_type_annotations.ts";

Deno.test("migrate annotations without altering literals, comments, or rebinding", async () => {
  const legacy =
    'let x :: Text = "λ ::" // keep ::\r\nx := "::"\r\nreturn x\r\n';
  const expected =
    'let x: Text = "λ ::" // keep ::\r\nx := "::"\r\nreturn x\r\n';
  assertEquals(await migrateTypeAnnotations(legacy), expected);
  assertEquals(await migrateTypeAnnotations(expected), expected);
});

Deno.test("migrate typed parameters and multiline signature headers", async () => {
  assertEquals(
    await migrateTypeAnnotations(
      "const f ::\n  Int -> Int\nconst f = fn (x::Int) => x\nreturn f\n",
    ),
    "const f:\n  Int -> Int\nconst f = fn (x:Int) => x\nreturn f\n",
  );
});

Deno.test("migration does not split longer operator tokens", async () => {
  const source = "infixl 40 (:::) = append\nreturn a ::: b\n";
  assertEquals(await migrateTypeAnnotations(source), source);
});

Deno.test("migration refuses lexical errors instead of partially rewriting source", async () => {
  await assertRejects(() =>
    migrateTypeAnnotations('let x :: Text = "unterminated')
  );
});
