// What a `case` is required to cover, and what it is not.

import { assertEquals } from "@std/assert";
import { uncovered, unlistable } from "./coverage.ts";
import { INT, intLiteral, textLiteral } from "./type.ts";

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

// --- the pattern matrix ------------------------------------------------------
//
// `uncoveredTuple` is asserted here as well as through `inference.test.ts`,
// because two of its answers have no spelling in source. A shape pattern in a
// column is one: nothing here knows the set a record pattern would have to be
// one of, so the column has no signature and only an irrefutable pattern in it
// can cover it — and that has to be refused rather than waved through, since
// the alternative is a `BLOT_NO_MATCH` the checker promised could not happen.

import { uncoveredTuple } from "./coverage.ts";
import type { Pattern, Span } from "../syntax/ast.ts";
import { record, tupleType, UNIT, variant } from "./type.ts";

const nowhere: Span = { start: 0, end: 0 };

function any(): Pattern {
  return { tag: "wildcard", span: nowhere };
}

function tag(name: string, payload: Pattern | null = null): Pattern {
  return { tag: "constructor", name, payload, span: nowhere };
}

function tuple(...elements: Pattern[]): Pattern {
  return { tag: "tuple", elements, span: nowhere };
}

function shape(name: string): Pattern {
  return {
    tag: "shape",
    fields: [{ name, pattern: any() }],
    span: nowhere,
  };
}

const option = variant([["Some", INT], ["None", UNIT]]);
const pair = tupleType([option, option]);

Deno.test("a column with no signature is covered only by an irrefutable pattern", () => {
  const shapes = tupleType([record([["a", INT]]), option]);
  assertEquals(
    uncoveredTuple(shapes, [
      tuple(
        shape("a"),
        tag("Some", {
          tag: "name",
          name: "v",
          qualifier: "none",
          span: nowhere,
        }),
      ),
      tuple(shape("a"), tag("None")),
    ]),
    "(_, _)",
  );
  assertEquals(
    uncoveredTuple(shapes, [
      tuple(shape("a"), tag("Some", any())),
      tuple(any(), any()),
    ]),
    null,
  );
});

Deno.test("an inner column carries no requirement of its own", () => {
  // The arms close a column of the scrutinee's own tuple, because `inferCase`
  // writes that set back onto the scrutinee. Nothing constrains a payload, so
  // the same arms inside one prove nothing: the `#Some` payload here is `Int`,
  // which no arm list exhausts, and the witness says the whole `#Some` row is
  // what is not covered rather than naming a payload it cannot name.
  assertEquals(
    uncoveredTuple(pair, [
      tuple(tag("Some", tag("Some")), tag("None")),
      tuple(tag("None"), any()),
    ]),
    "(#Some, _)",
  );
});

Deno.test("a matrix that covers the cross-product has no gap", () => {
  assertEquals(
    uncoveredTuple(pair, [
      tuple(tag("Some", any()), tag("Some", any())),
      tuple(tag("Some", any()), tag("None")),
      tuple(tag("None"), tag("Some", any())),
      tuple(tag("None"), tag("None")),
    ]),
    null,
  );
});
