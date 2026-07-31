// What a `case` is required to cover, and what it is not.
//
// Both questions turn on a shortcut that fires when a range's two bounds are
// the same object. That is right for a literal — `1..1` is the one-element set
// `{1}` — and wrong for a length: `len xs..len xs` is a singleton too, but
// nothing here knows which integer it holds, so it names no inhabitant to
// list. The two guards below the shortcut test for `bigint`, so the shortcut
// would answer first and hand a symbol out as a literal.
//
// Asserted directly because a symbolic bound cannot be written in source: no
// program can put one here yet, and by the time one can, the wrong answer is
// either a `case` that claims to be complete and traps, or a `case` that is
// rejected for missing arms nobody can name.

import { assertEquals } from "@std/assert";
import { uncovered, unlistable } from "./coverage.ts";
import {
  INT,
  intLiteral,
  lengthBound,
  type SimpleType,
  textLiteral,
  union,
} from "./type.ts";

const lenXs = lengthBound(401, 0n, "xs");
const lastXs = lengthBound(401, -1n, "xs");

const length: SimpleType = {
  tag: "range",
  domain: "int",
  low: lenXs,
  high: lenXs,
};
const indices: SimpleType = {
  tag: "range",
  domain: "int",
  low: 0n,
  high: lastXs,
};

Deno.test("a length names no inhabitant, so arms carry no requirement", () => {
  assertEquals(uncovered(length, [intLiteral(1n), intLiteral(2n)]), null);
  assertEquals(uncovered(indices, [intLiteral(0n)]), null);
  assertEquals(uncovered(intLiteral(1n), [length]), null);
});

Deno.test("a length is unlistable, so a case over one still owes a catch-all", () => {
  // The polarity is the trap: `unlistable` answers "can no finite list of
  // literal arms exhaust this", so a set whose members cannot be named is
  // `true`, not `false`. A singleton literal is the case it must not swallow.
  assertEquals(unlistable(length), true);
  assertEquals(unlistable(indices), true);
  assertEquals(unlistable(union([intLiteral(1n), length])), true);
  assertEquals(unlistable(INT), true);
});

Deno.test("a literal singleton still enumerates, in either domain", () => {
  // The guard sits above the shortcut, so this is the regression it must not
  // cause: `case s of "up" => …, "down" => …` is still checked for coverage.
  assertEquals(uncovered(intLiteral(1n), [intLiteral(1n)]), []);
  assertEquals(uncovered(textLiteral("up"), [textLiteral("up")]), []);
  assertEquals(uncovered(textLiteral("up"), [textLiteral("down")]), [
    { domain: "text", value: "up" },
  ]);
  assertEquals(unlistable(intLiteral(1n)), false);
  assertEquals(unlistable(textLiteral("up")), false);
  assertEquals(
    unlistable({ tag: "range", domain: "int", low: 1n, high: 2n }),
    false,
  );
});
