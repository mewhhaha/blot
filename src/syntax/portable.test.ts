import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "./parse.ts";
import { decodePortableModule, encodePortableModule } from "./portable.ts";

Deno.test("a portable AST round trip preserves the lowered module", async () => {
  const parsed = await parse(
    `const answer = 41
return reuse fn offset => answer + offset
`,
  );
  if (!parsed.ok) throw new Error("portable AST fixture did not parse");

  const encoded = encodePortableModule(parsed.module);
  const decoded = decodePortableModule(
    JSON.parse(JSON.stringify(encoded)),
    "round-trip fixture",
  );

  assertEquals(decoded, parsed.module);
});

Deno.test("a portable AST rejects a forged reuse assertion", async () => {
  const parsed = await parse(`return reuse fn value => value
`);
  if (!parsed.ok) throw new Error("portable AST fixture did not parse");
  const encoded = JSON.parse(
    JSON.stringify(encodePortableModule(parsed.module)),
  ) as {
    arena: { expressions: Array<Record<string, unknown>> };
  };
  const lambda = encoded.arena.expressions.find((expression) =>
    expression.tag === "lambda"
  );
  if (lambda === undefined) {
    throw new Error("portable AST fixture lost its lambda");
  }
  lambda.reuse = "checked";

  const failure = assertThrows(
    () => decodePortableModule(encoded, "forged-reuse fixture"),
    Error,
  );
  assertEquals(
    failure.message,
    "forged-reuse fixture expression 0 reuse must be a boolean",
  );
});

Deno.test("a portable AST rejects references outside its arenas", async () => {
  const parsed = await parse(`return 41
`);
  if (!parsed.ok) throw new Error("portable AST fixture did not parse");
  const encoded = JSON.parse(
    JSON.stringify(encodePortableModule(parsed.module)),
  ) as Record<string, unknown>;
  encoded.result = 1000;

  const failure = assertThrows(
    () => decodePortableModule(encoded, "invalid-reference fixture"),
    Error,
  );
  assertEquals(
    failure.message,
    "invalid-reference fixture result 1000 is outside arena length 1",
  );
});

Deno.test("a portable AST rejects cyclic expression references", async () => {
  const parsed = await parse(`return fn value => value
`);
  if (!parsed.ok) throw new Error("portable AST fixture did not parse");
  const encoded = JSON.parse(
    JSON.stringify(encodePortableModule(parsed.module)),
  ) as {
    arena: { expressions: Array<Record<string, unknown>> };
  };
  const rootExpression = encoded.arena.expressions[0];
  if (rootExpression === undefined) {
    throw new Error("portable AST fixture omitted its root expression");
  }
  rootExpression.body = 0;

  const failure = assertThrows(
    () => decodePortableModule(encoded, "cyclic fixture"),
    Error,
  );
  assertEquals(
    failure.message,
    "cyclic fixture expression arena contains a cycle at 0",
  );
});
