// The set algebra, asserted as printed types.
//
// These are the whole argument for the module: every answer it gives is a type
// the lattice already prints, and every case it cannot answer exactly says so
// instead of guessing. Asserting the printed form is what makes an over-wide
// answer show up as a diff rather than as "still returns something".

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  difference,
  intersect,
  normalizeClosedUnion,
  UNSUPPORTED_SET_OP,
} from "./setops.ts";
import { show } from "./print.ts";
import {
  BOTTOM,
  freshVar,
  fun,
  INT,
  intLiteral,
  openVariant,
  PURE,
  record,
  type SimpleType,
  TEXT,
  textLiteral,
  TOP,
  union,
  UNIT,
  variant,
} from "./type.ts";

function ints(...values: readonly number[]): SimpleType {
  return union(values.map((value) => intLiteral(BigInt(value))));
}

function texts(...values: readonly string[]): SimpleType {
  return union(values.map(textLiteral));
}

function bound(value: number | null): bigint | null {
  if (value === null) return null;
  return BigInt(value);
}

function range(low: number | null, high: number | null): SimpleType {
  return { tag: "range", domain: "int", low: bound(low), high: bound(high) };
}

function got(result: ReturnType<typeof intersect>): string {
  if (result.tag === "refused") {
    throw new Error(`refused: ${result.refusal.message}`);
  }
  return show(result.type);
}

function refusal(result: ReturnType<typeof intersect>): string {
  if (result.tag === "type") {
    throw new Error(`expected a refusal, got \`${show(result.type)}\``);
  }
  assertEquals(result.refusal.code, UNSUPPORTED_SET_OP);
  return result.refusal.message;
}

Deno.test("a literal union narrows to the member a branch proved", () => {
  assertEquals(got(intersect(ints(1, 2, 3), intLiteral(1n))), "1");
  assertEquals(got(difference(ints(1, 2, 3), intLiteral(1n))), "2 | 3");
});

Deno.test("intersection is subsumption, not member equality", () => {
  // `@type.intersect Int 1` reports BLOT_EMPTY_TYPE here, because it looks for
  // `1` among `Int`'s members and `Int` has none. The answer is `1`.
  assertEquals(got(intersect(INT, intLiteral(1n))), "1");
  assertEquals(got(intersect(intLiteral(1n), INT)), "1");
  assertEquals(got(intersect(range(0, 10), range(5, 20))), "5..10");
  assertEquals(got(intersect(ints(1, 2, 3), ints(2, 3, 4))), "2 | 3");
});

Deno.test("an integer domain is discrete, so a value can be cut out of it", () => {
  // `@type.diff Int 1` answers `Int`, silently readmitting the excluded value.
  assertEquals(
    got(difference(INT, intLiteral(1n))),
    "-9223372036854775808..0 | 2..9223372036854775807",
  );
  assertEquals(got(difference(range(null, 9), intLiteral(5n))), "..4 | 6..9");
  assertEquals(got(difference(range(1, 5), range(3, 9))), "1..2");
  assertEquals(got(difference(range(1, 5), range(0, 2))), "3..5");
});

Deno.test("an empty result is bottom, never a diagnostic", () => {
  assertEquals(got(intersect(intLiteral(1n), intLiteral(2n))), "⊥");
  assertEquals(got(difference(intLiteral(1n), intLiteral(1n))), "⊥");
  assertEquals(got(difference(ints(1, 2), ints(1, 2, 3))), "⊥");
  assertEquals(got(difference(range(1, 5), INT)), "⊥");
});

Deno.test("bottom is the empty union and needs no special case", () => {
  assertEquals(got(intersect(BOTTOM, INT)), "⊥");
  assertEquals(got(difference(BOTTOM, INT)), "⊥");
  assertEquals(got(difference(ints(1, 2), BOTTOM)), "1 | 2");
});

Deno.test("two domains share no value", () => {
  assertEquals(got(intersect(intLiteral(1n), textLiteral("1"))), "⊥");
  assertEquals(got(difference(intLiteral(1n), textLiteral("1"))), "1");
  assertEquals(
    got(difference(union([intLiteral(1n), textLiteral("a")]), TEXT)),
    "1",
  );
});

Deno.test("text literals subtract exactly when they do not split an interval", () => {
  assertEquals(
    got(difference(texts("up", "down", "left"), textLiteral("down"))),
    '"up" | "left"',
  );
  assertEquals(got(difference(textLiteral("a"), textLiteral("b"))), '"a"');
  assertEquals(got(difference(textLiteral("a"), TEXT)), "⊥");
  assertEquals(got(intersect(TEXT, textLiteral("a"))), '"a"');
});

Deno.test("a text interval cannot have a value removed from inside it", () => {
  // `Bound` is inclusive and text order is dense, so the two pieces would have
  // to be `.."a"` and `"a"..` — both of which still contain `"a"`.
  assertStringIncludes(refusal(difference(TEXT, textLiteral("a"))), "dense");
  assertStringIncludes(
    refusal(
      difference(
        { tag: "range", domain: "text", low: "a", high: "z" },
        textLiteral("m"),
      ),
    ),
    "dense",
  );
});

Deno.test("a closed constructor set subtracts by name", () => {
  const three = variant([["A", UNIT], ["B", UNIT], ["C", UNIT]]);
  assertEquals(got(difference(three, variant([["A", UNIT]]))), "#B | #C");
  assertEquals(got(intersect(three, variant([["A", UNIT]]))), "#A");
  assertEquals(got(difference(three, three)), "⊥");
  assertEquals(
    got(intersect(variant([["A", UNIT]]), variant([["B", UNIT]]))),
    "⊥",
  );
});

Deno.test("a constructor payload is itself a set", () => {
  const some = variant([["Some", INT], ["None", UNIT]]);
  assertEquals(
    got(difference(some, variant([["Some", intLiteral(1n)]]))),
    "#Some -9223372036854775808..0 | 2..9223372036854775807 | #None",
  );
  assertEquals(
    got(intersect(some, variant([["Some", intLiteral(1n)]]))),
    "#Some 1",
  );
  // A constructor whose payload has no inhabitant has none either.
  assertEquals(
    got(
      intersect(
        variant([["Some", intLiteral(1n)]]),
        variant([["Some", intLiteral(2n)]]),
      ),
    ),
    "⊥",
  );
});

Deno.test("constructors and literals coexist in one union", () => {
  const mixed = union([intLiteral(1n), variant([["A", UNIT], ["B", UNIT]])]);
  assertEquals(got(difference(mixed, variant([["A", UNIT]]))), "1 | #B");
  assertEquals(got(difference(mixed, intLiteral(1n))), "#A | #B");
  assertEquals(got(intersect(mixed, INT)), "1");
});

Deno.test("unit is a one-element set", () => {
  assertEquals(got(intersect(UNIT, UNIT)), "()");
  assertEquals(got(difference(UNIT, UNIT)), "⊥");
  assertEquals(got(difference(UNIT, intLiteral(1n))), "()");
});

Deno.test("an open variant names no complement, so it is refused", () => {
  const open = openVariant([["A", UNIT]]);
  assertStringIncludes(
    refusal(difference(open, variant([["A", UNIT]]))),
    "admits constructors",
  );
  assertStringIncludes(
    refusal(difference(variant([["A", UNIT], ["B", UNIT]]), open)),
    "admits constructors",
  );
  assertStringIncludes(refusal(intersect(open, open)), "admits constructors");
});

Deno.test("a shape that is not a ground set is refused rather than approximated", () => {
  const cases: readonly [string, SimpleType][] = [
    ["a variable", freshVar(0)],
    ["a record", record([["x", INT]])],
    ["an array", { tag: "array", element: INT }],
    ["a function", fun(INT, INT, PURE)],
    ["top", TOP],
    ["an opaque", { tag: "opaque", name: "Device" }],
  ];
  for (const [what, type] of cases) {
    assertStringIncludes(refusal(intersect(type, INT)), "is not a ground set");
    assertStringIncludes(
      refusal(difference(INT, type)),
      "is not a ground set",
      `expected ${what} to be refused`,
    );
  }
});

Deno.test("a non-ground payload refuses the whole operation", () => {
  const holed = variant([["Some", freshVar(0)]]);
  assertStringIncludes(
    refusal(difference(holed, variant([["Some", INT]]))),
    "is not a ground set",
  );
});

Deno.test("nested differences stay linear in the number of cuts", () => {
  // Each subtracted atom splits at most one interval, so `d` of them leave at
  // most `d + 1` pieces. This is the whole cost argument, and it is cheap to
  // notice if it ever stops holding.
  let current: SimpleType = INT;
  for (let cut = 1; cut <= 6; cut += 1) {
    const next = difference(current, intLiteral(BigInt(cut * 10)));
    if (next.tag === "refused") throw new Error(next.refusal.message);
    current = next.type;
    const pieces = current.tag === "union" ? current.members.length : 1;
    assertEquals(pieces, cut + 1);
  }
  assertEquals(
    show(current),
    "-9223372036854775808..9 | 11..19 | 21..29 | 31..39 | 41..49 | 51..59 | 61..9223372036854775807",
  );
});

Deno.test("a union with a repeated member answers once", () => {
  assertEquals(
    got(
      intersect(union([intLiteral(1n), intLiteral(1n), intLiteral(2n)]), INT),
    ),
    "1 | 2",
  );
});

Deno.test("closed unions have one canonical empty, flat, distinct form", () => {
  assertEquals(show(normalizeClosedUnion([])), "⊥");
  assertEquals(
    show(normalizeClosedUnion([
      BOTTOM,
      intLiteral(1n),
      union([intLiteral(1n), intLiteral(2n)]),
    ])),
    "1 | 2",
  );
  assertEquals(show(normalizeClosedUnion([intLiteral(1n), TOP])), "⊤");
});
