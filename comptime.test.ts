import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "./src/diagnostic.ts";
import {
  apply,
  evaluationRuntime,
  moduleClosure,
  run,
} from "./src/comptime/eval.ts";
import {
  childEnv,
  equal,
  substituteTypeVariable,
  UNIT,
  type Value,
} from "./src/comptime/value.ts";
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

Deno.test("quantified type-value equality is alpha-equivalent", () => {
  const identity = (variable: number): Value => ({
    tag: "forall",
    variable,
    body: {
      tag: "arrow",
      domain: { tag: "type-variable", id: variable },
      codomain: { tag: "type-variable", id: variable },
      effects: [],
    },
  });
  assertEquals(equal(identity(1), identity(99)), true);
});

Deno.test("quantified equality does not capture a free type variable", () => {
  const freeZero: Value = {
    tag: "forall",
    variable: 1,
    body: { tag: "type-variable", id: 0 },
  };
  const boundZero: Value = {
    tag: "forall",
    variable: 0,
    body: { tag: "type-variable", id: 0 },
  };
  assertEquals(equal(freeZero, boundZero), false);
});

Deno.test("type-value instantiation substitutes an arrow", () => {
  const body: Value = {
    tag: "arrow",
    domain: { tag: "type-variable", id: 7 },
    codomain: { tag: "type-variable", id: 7 },
    effects: [],
  };
  const argument: Value = { tag: "opaque-type", name: "T" };
  assertEquals(
    equal(
      substituteTypeVariable(body, 7, argument)!,
      { ...body, domain: argument, codomain: argument },
    ),
    true,
  );
});

Deno.test("effect-row instantiation closes only with effects", () => {
  const body: Value = {
    tag: "arrow",
    domain: UNIT,
    codomain: UNIT,
    effects: [],
    effectTail: 7,
  };
  const effect: Value = {
    tag: "effect",
    id: 1,
    name: "Console",
    operations: new Map(),
    host: true,
  };
  assertEquals(
    equal(
      substituteTypeVariable(body, 7, effect)!,
      { ...body, effects: [effect], effectTail: undefined },
    ),
    true,
  );
  assertEquals(
    substituteTypeVariable(body, 7, { tag: "int", value: 0n }),
    null,
  );
});

Deno.test("deferred evaluation is not part of exact type identity", () => {
  const strict = {
    tag: "arrow",
    domain: UNIT,
    codomain: UNIT,
    effects: [],
  } satisfies Value;
  const deferred = { ...strict, deferred: true } satisfies Value;
  assertEquals(equal(strict, deferred), true);
});

Deno.test("an unused deferred argument is never evaluated", async () => {
  assertEquals(
    await evaluate(`let ignore = fn ~_ => 42
return ignore (@panic "unused")
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("a demanded deferred argument is evaluated once", async () => {
  assertEquals(
    await evaluate(`let use = fn ~value => value
return use 42
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("a deferred parameter cannot be demanded twice directly", async () => {
  const error = await assertRejects(
    async () => {
      await evaluate(`let twice = fn ~value => (value, value)
return twice 21
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
return twice 21
`),
    { tag: "int", value: 42n },
  );
});

Deno.test("evaluation stops at its deterministic fuel limit", async () => {
  const error = await assertRejects(
    async () => {
      await evaluate(
        `const rec spin = fn () => spin ()
return spin ()
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
        `return @int.mul (@int.mul 2147483647 2147483647) 3
`,
      );
    },
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_INTEGER_OVERFLOW");
});

Deno.test("comptime integer addition remains arbitrary precision", async () => {
  const parsed = await parse(
    `return @int.mul (@int.mul 2147483647 2147483647) 3
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
return 42
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
return @int.add second first
`,
      );
    },
    BlotError,
  );
  assertEquals(error.diagnostic.message, "first");
});
