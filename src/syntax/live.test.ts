import { assertEquals, assertStrictEquals } from "@std/assert";
import type { Expr, Pattern } from "./ast.ts";
import { patternNames } from "./ast.ts";
import { freeNames } from "./live.ts";

Deno.test("AST-local name analysis is memoized by node identity", () => {
  const left: Expr = {
    tag: "var",
    name: "left",
    span: { start: 0, end: 4 },
  };
  const right: Expr = {
    tag: "var",
    name: "right",
    span: { start: 5, end: 10 },
  };
  const expression: Expr = {
    tag: "apply",
    fn: left,
    arg: right,
    span: { start: 0, end: 10 },
  };
  const pattern: Pattern = {
    tag: "tuple",
    elements: [
      { tag: "name", name: "a", qualifier: "none", span: { start: 0, end: 1 } },
      { tag: "name", name: "b", qualifier: "none", span: { start: 3, end: 4 } },
    ],
    span: { start: 0, end: 4 },
  };

  const firstFree = freeNames(expression);
  const secondFree = freeNames(expression);
  assertStrictEquals(secondFree, firstFree);
  assertEquals([...firstFree].sort(), ["left", "right"]);

  const firstBound = patternNames(pattern);
  const secondBound = patternNames(pattern);
  assertStrictEquals(secondBound, firstBound);
  assertEquals(firstBound, ["a", "b"]);
});
