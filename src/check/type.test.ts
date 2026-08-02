import { assertEquals, assertThrows } from "@std/assert";
import { boundAbove, boundAtMost, boundBelow, shiftBound } from "./type.ts";

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
