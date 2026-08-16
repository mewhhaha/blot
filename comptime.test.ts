import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "./src/diagnostic.ts";
import {
  apply,
  evaluationRuntime,
  moduleClosure,
  run,
} from "./src/comptime/eval.ts";
import { childEnv, UNIT } from "./src/comptime/value.ts";
import { parse } from "./src/syntax/parse.ts";

async function evaluate(source: string, fuel = 1_000): Promise<unknown> {
  const parsed = await parse(source);
  if (!parsed.ok) {
    throw new Error("test source did not parse");
  }
  const env = childEnv(null);
  const closure = moduleClosure(parsed.module, env, new Map());
  return run(
    apply(
      closure,
      UNIT,
      parsed.module.span,
      evaluationRuntime(new Map(), "runtime", fuel),
    ),
  );
}

Deno.test("an unused deferred argument is never evaluated", async () => {
  assertEquals(
    await evaluate(`let ignore = fn ~_ => 42
export ignore (@panic "unused")
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("a demanded deferred argument is evaluated once", async () => {
  assertEquals(
    await evaluate(`let use = fn ~value => value
export use 42
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("a deferred parameter cannot be demanded twice directly", async () => {
  const error = await assertRejects(
    async () => {
      await evaluate(`let twice = fn ~value => (value, value)
export twice 21
`);
    },
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_DEFERRED_DEMANDED_TWICE");
});

Deno.test("a deferred parameter can be forced once into an ordinary binding", async () => {
  assertEquals(
    await evaluate(`let twice = fn ~value => do:
  let value = value
  return @int.add value value
export twice 21
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("evaluation stops at its deterministic fuel limit", async () => {
  const error = await assertRejects(
    async () => {
      await evaluate(
        `const spin = rec (fn () => spin ())
export spin ()
`,
        100,
      );
    },
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_EVALUATION_LIMIT");
});

Deno.test("runtime integer addition traps outside signed i64", async () => {
  const error = await assertRejects(
    async () => {
      await evaluate(
        `export @int.mul (@int.mul 2147483647 2147483647) 3
`,
      );
    },
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_INTEGER_OVERFLOW");
});

Deno.test("comptime integer addition remains arbitrary precision", async () => {
  const parsed = await parse(
    `export @int.mul (@int.mul 2147483647 2147483647) 3
`,
  );
  if (!parsed.ok) {
    throw new Error("test source did not parse");
  }
  const value = run(
    apply(
      moduleClosure(parsed.module, childEnv(null), new Map()),
      UNIT,
      parsed.module.span,
      evaluationRuntime(new Map(), "comptime"),
    ),
  );
  assertEquals(value, { tag: "int", value: 13835058042397261827n });
});

Deno.test("an unused pure binding is not evaluated", async () => {
  assertEquals(
    await evaluate(`let unused = @panic "unused"
export 42
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("live pure bindings evaluate once in source order", async () => {
  const error = await assertRejects(
    async () => {
      await evaluate(
        `let first = @panic "first"
let second = @panic "second"
export @int.add second first
`,
      );
    },
    BlotError,
  );
  assertEquals(error.diagnostic.message, "first");
});
