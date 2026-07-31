// The comparison a symbolic bound turns on.
//
// `boundAtMost` is the only thing in the lattice that reads a length, and every
// other reader of a `Bound` is written in terms of it. Its answers are asserted
// directly rather than through a program, because the answer that decides
// whether the representation is sound — "unknown" — is the one no program can
// demonstrate: a reader handed an unknown is supposed to stay silent.
//
// The regression these pin is not hypothetical. Before `Bound` was widened,
// every comparison on it ended in a raw JavaScript `<=`, and TypeScript reports
// exactly one error when the variant is added. On two distinct symbols
// `a <= b` and `b <= a` are *both* true, because both stringify to
// "[object Object]" — which is `boundAbove` accepting `0..len xs - 1` as a
// subtype of `0..len ys - 1`.

import { assertEquals, assertThrows } from "@std/assert";
import {
  boundAbove,
  boundAtMost,
  boundBelow,
  isLength,
  lengthBound,
  lengthSubject,
  LONGEST_ARRAY,
} from "./type.ts";
import { showRange } from "./print.ts";

// Occurrence ids are minted by the checker at a binder; these stand in for
// ones it would have minted. Names are unique per test so that the collision
// rule is exercised only where it is the subject.
const xs = lengthBound(101, 0n, "xs");
const xsLast = lengthBound(101, -1n, "xs");
const xsPast = lengthBound(101, 1n, "xs");
const ys = lengthBound(102, 0n, "ys");

Deno.test("a literal bound compares exactly, in both directions", () => {
  assertEquals(boundAtMost(1n, 2n), true);
  assertEquals(boundAtMost(2n, 1n), false);
  assertEquals(boundAtMost(2n, 2n), true);
  assertEquals(boundAtMost("a", "b"), true);
  assertEquals(boundAtMost("b", "a"), false);
  assertEquals(boundAtMost("b", "b"), true);
});

Deno.test("one occurrence and one offset name one bound", () => {
  assertEquals(lengthBound(101, 0n, "xs") === xs, true);
  assertEquals(lengthBound(101, -1n, "xs") === xsLast, true);
  // The display name takes no part in identity: the pair decides.
  assertEquals(lengthBound(101, 0n, "elsewhere") === xs, true);
  assertEquals(xs === xsLast, false);
  assertEquals(xs === ys, false);
  assertEquals(isLength(xs), true);
  assertEquals(isLength(0n), false);
  assertEquals(isLength(null), false);
  assertEquals(isLength("a"), false);
});

Deno.test("the same occurrence compares by its offsets", () => {
  assertEquals(boundAtMost(xsLast, xs), true);
  assertEquals(boundAtMost(xs, xsLast), false);
  assertEquals(boundAtMost(xs, xs), true);
  assertEquals(boundAtMost(xs, xsPast), true);
  assertEquals(boundAtMost(xsPast, xs), false);
});

Deno.test("two occurrences are two unrelated integers", () => {
  // Not "either could be smaller, so pick one" — unknown in *both*
  // directions. Answering one of them would relate two symbols, which is where
  // a comparison becomes a solver.
  assertEquals(boundAtMost(xs, ys), null);
  assertEquals(boundAtMost(ys, xs), null);
  assertEquals(boundAtMost(xsLast, ys), null);
});

Deno.test("the envelope settles a length against a literal, or says it cannot", () => {
  // `0 <= len xs` is the comparison the feature exists to make, and it is
  // decided even though `0 < len xs` is not.
  assertEquals(boundAtMost(0n, xs), true);
  assertEquals(boundAtMost(-1n, xs), true);
  assertEquals(boundAtMost(xs, LONGEST_ARRAY), true);
  assertEquals(boundAtMost(xsLast, LONGEST_ARRAY), true);

  // An empty array makes each of these false and a longer one makes it true.
  assertEquals(boundAtMost(xs, 0n), null);
  assertEquals(boundAtMost(1n, xs), null);
  assertEquals(boundAtMost(xs, 5n), null);
  assertEquals(boundAtMost(xsLast, -1n), null);
  assertEquals(boundAtMost(0n, xsLast), null);

  // Decided the other way: nothing an array can be makes these hold.
  assertEquals(boundAtMost(xs, -1n), false);
  assertEquals(boundAtMost(LONGEST_ARRAY + 1n, xs), false);
  assertEquals(boundAtMost(xsPast, 0n), false);
});

Deno.test("a bound is never compared across two domains", () => {
  assertThrows(() => boundAtMost(1n, "a"), Error, "blot invariant violated");
  assertThrows(() => boundAtMost("a", xs), Error, "blot invariant violated");
  assertThrows(() => boundAtMost(xs, "a"), Error, "blot invariant violated");
});

Deno.test("the subtype checks read an unknown as no", () => {
  // The direction that matters: a range bounded by one array's length is not
  // inside a range bounded by another's, in either direction. A raw `<=`
  // answers yes to both.
  assertEquals(boundAbove(xs, ys), false);
  assertEquals(boundAbove(ys, xs), false);
  assertEquals(boundBelow(xs, ys), false);
  assertEquals(boundBelow(ys, xs), false);

  // And a range bounded by a length is inside itself, which interning is what
  // makes true.
  assertEquals(boundAbove(xsLast, lengthBound(101, -1n, "xs")), true);
  assertEquals(boundBelow(0n, xs), true);

  // An open end still swallows everything, symbol or not.
  assertEquals(boundBelow(null, xs), true);
  assertEquals(boundAbove(xs, null), true);
  assertEquals(boundBelow(xs, null), false);
  assertEquals(boundAbove(null, xs), false);
});

Deno.test("a length is spelled as the arithmetic it is", () => {
  assertEquals(showRange("int", xs, xs), "len xs");
  assertEquals(showRange("int", 0n, xsLast), "0..len xs - 1");
  assertEquals(showRange("int", xsPast, null), "len xs + 1..");
  assertEquals(showRange("int", null, xs), "..len xs");
  assertEquals(showRange("int", xs, ys), "len xs..len ys");
});

Deno.test("two occurrences written with the same name are told apart", () => {
  const first = lengthBound(201, 0n, "vs");
  const second = lengthBound(202, 0n, "vs");
  assertEquals(lengthSubject(first), "vs");
  assertEquals(lengthSubject(second), "vs#202");
  assertEquals(
    showRange("int", 0n, lengthBound(202, -1n, "vs")),
    "0..len vs#202 - 1",
  );
});
