import { assertEquals, assertThrows } from "@std/assert";
import "../../src/comptime/region_primitives.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { PRIMITIVES } from "../../src/comptime/primitives.ts";
import { asTuple, type Value } from "../../src/comptime/value.ts";

const span = { start: 0, end: 0 };

function run(name: string, arguments_: readonly Value[]): Value {
  const primitive = PRIMITIVES.get(name);
  if (primitive === undefined) throw new Error(`missing ${name}`);
  return primitive.run(arguments_, span, "comptime");
}

function split(value: Value, at: bigint): readonly Value[] {
  const result = run("@region.split", [value, { tag: "int", value: at }]);
  if (result.tag !== "tag" || result.name !== "Split" ||
    result.payload === null) {
    throw new Error("expected a successful Region split");
  }
  const tuple = asTuple(result.payload, 3);
  if (tuple === null) throw new Error("expected split tuple");
  return tuple;
}

Deno.test("Region witness reassociation validates Store identity", () => {
  const first = run("@region.claim", [{
    tag: "array",
    elements: [{ tag: "int", value: 1n }, { tag: "int", value: 2n }],
  }]);
  const second = run("@region.claim", [{
    tag: "array",
    elements: [{ tag: "int", value: 3n }, { tag: "int", value: 4n }],
  }]);
  const firstSplit = split(first, 1n);
  const secondSplit = split(second, 1n);
  const error = assertThrows(
    () => run("@region.reassociate_left", [firstSplit[2], secondSplit[2]]),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_REGION_REASSOCIATE_UNPROVED");
});

Deno.test("Region replace failure returns both unchanged inputs", () => {
  const region = run("@region.claim", [{
    tag: "array",
    elements: [{ tag: "int", value: 1n }],
  }]);
  const result = run("@region.replace", [
    region,
    { tag: "int", value: 9n },
    { tag: "int", value: 2n },
  ]);
  if (result.tag !== "tag" || result.name !== "ReplaceOutOfBounds" ||
    result.payload === null) {
    throw new Error("expected replacement failure");
  }
  const payload = asTuple(result.payload, 2);
  if (payload === null) throw new Error("expected replacement tuple");
  assertEquals(payload[0], { tag: "int", value: 2n });
  assertEquals(payload[1], region);
});
