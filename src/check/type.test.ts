import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import type { Value } from "../comptime/value.ts";
import { bridge } from "./bridge.ts";
import { constrain } from "./constrain.ts";
import { show } from "./print.ts";
import {
  boundAbove,
  boundAtMost,
  boundBelow,
  freshVar,
  INT,
  intLiteral,
  shiftBound,
  type SimpleType,
  textLiteral,
} from "./type.ts";

Deno.test("a homogeneous array drops ranges covered by its element domain", () => {
  const element = freshVar(0);
  constrain(INT, element);
  constrain(intLiteral(0n), element);

  assertEquals(show({ tag: "array", element }), "[Int]");
});

Deno.test("literal bounds compare exactly within their domain", () => {
  assertEquals(boundAtMost(1n, 2n), true);
  assertEquals(boundAtMost(2n, 1n), false);
  assertEquals(boundAtMost(2n, 2n), true);
  assertEquals(boundAtMost("a", "b"), true);
  assertEquals(boundAtMost("b", "a"), false);
  assertEquals(boundAtMost("b", "b"), true);
});

Deno.test("bounds are never compared across domains", () => {
  assertThrows(() => boundAtMost(1n, "a"), Error, "blot invariant violated");
  assertThrows(() => boundAtMost("a", 1n), Error, "blot invariant violated");
});

Deno.test("open bounds contain closed bounds", () => {
  assertEquals(boundBelow(null, 1n), true);
  assertEquals(boundAbove(1n, null), true);
  assertEquals(boundBelow(1n, null), false);
  assertEquals(boundAbove(null, 1n), false);
});

Deno.test("integer bounds step by literal offsets", () => {
  assertEquals(shiftBound(3n, -1n), 2n);
  assertEquals(shiftBound(3n, 1n), 4n);
  assertThrows(() => shiftBound("a", 1n), Error, "blot invariant violated");
});

Deno.test("seal identity is structural and alpha-aware", () => {
  const integer: Value = { tag: "int", value: 1n };
  const text: Value = { tag: "text", value: "one" };
  const leftRecord: Value = {
    tag: "shape",
    fields: new Map<string, Value>([
      ["left", integer],
      ["right", text],
    ]),
  };
  const rightRecord: Value = {
    tag: "shape",
    fields: new Map<string, Value>([
      ["right", text],
      ["left", integer],
    ]),
  };
  assertEquals(
    bridge(seal("Pair", leftRecord)),
    bridge(seal("Pair", rightRecord)),
  );

  const quantified = (variable: number): Value => ({
    tag: "forall",
    variable,
    body: {
      tag: "arrow",
      domain: { tag: "type-variable", id: variable },
      codomain: { tag: "type-variable", id: variable },
      effects: [],
    },
  });
  assertEquals(
    bridge(seal("Identity", quantified(7))),
    bridge(seal("Identity", quantified(19))),
  );

  assertEquals(
    bridge(seal("Pair", leftRecord)),
    bridge(seal("Pair", leftRecord)),
  );
  assertNotEquals(
    bridge(seal("Pair", leftRecord)),
    bridge(seal("Pair", integer)),
  );
});

Deno.test("an inferred upper union retains every admitted member", () => {
  const inferred = freshVar(0);
  constrain(inferred, union([intLiteral(1n), textLiteral("one")]));

  constrain(textLiteral("one"), inferred);
});

Deno.test("a failed union candidate leaves no bounds in the next candidate", () => {
  const inferred = freshVar(0);
  const subject = record([
    ["value", inferred],
    ["tag", intLiteral(2n)],
  ]);
  const alternatives = union([
    record([
      ["value", intLiteral(1n)],
      ["tag", intLiteral(1n)],
    ]),
    record([
      ["value", intLiteral(2n)],
      ["tag", intLiteral(2n)],
    ]),
  ]);

  constrain(subject, alternatives);
  constrain(intLiteral(2n), inferred);
});

Deno.test("a failed union candidate restores inference identities", () => {
  const before = freshVar(0);
  const polymorphic: SimpleType = {
    tag: "forall",
    variables: [1],
    body: { tag: "rigid", id: 1 },
  };
  const subject = record([
    ["value", polymorphic],
    ["tag", intLiteral(2n)],
  ]);
  const alternatives = union([
    record([
      ["value", intLiteral(1n)],
      ["tag", intLiteral(1n)],
    ]),
    record([
      ["value", intLiteral(2n)],
      ["tag", intLiteral(2n)],
    ]),
  ]);

  constrain(subject, alternatives);

  const after = freshVar(0);
  assertEquals(after.id, before.id + 2);
});

function union(members: readonly SimpleType[]): SimpleType {
  return { tag: "union", members };
}

function record(
  fields: readonly (readonly [string, SimpleType])[],
): SimpleType {
  return { tag: "record", fields: new Map(fields) };
}

function seal(name: string, inner: Value): Value {
  return { tag: "sealed", name, inner };
}
