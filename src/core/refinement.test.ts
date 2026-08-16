import { assert, assertFalse } from "@std/assert";
import { RefinementContext } from "./refinement.ts";

Deno.test("refinement aliases retain literal affine offsets", () => {
  const refinements = new RefinementContext();
  assert(refinements.assume({ tag: "at-least", variable: 1, value: 0n }));
  assert(refinements.assume({
    tag: "equal-offset",
    left: 2,
    right: 1,
    offset: 3n,
  }));
  assert(refinements.entails({ tag: "at-least", variable: 2, value: 3n }));
});

Deno.test("refinement identities do not relate by their numeric bounds", () => {
  const refinements = new RefinementContext();
  assert(refinements.assume({ tag: "at-most", variable: 1, value: 4n }));
  assert(refinements.assume({ tag: "at-least", variable: 2, value: 5n }));
  assert(refinements.entails({ tag: "less-than", left: 1, right: 2 }));
  assertFalse(refinements.entails({
    tag: "equal-offset",
    left: 1,
    right: 2,
    offset: 0n,
  }));
});

Deno.test("refinement branches clone without leaking assumptions", () => {
  const outer = new RefinementContext();
  assert(outer.assume({ tag: "at-least", variable: 1, value: 0n }));
  const branch = outer.clone();
  assert(branch.assume({ tag: "at-most", variable: 1, value: 3n }));
  assert(branch.entails({ tag: "at-most", variable: 1, value: 3n }));
  assertFalse(outer.entails({ tag: "at-most", variable: 1, value: 3n }));
});

Deno.test("refinement contexts reject contradictory literal intervals", () => {
  const refinements = new RefinementContext();
  assert(refinements.assume({ tag: "at-least", variable: 1, value: 5n }));
  assertFalse(refinements.assume({ tag: "at-most", variable: 1, value: 4n }));
});

Deno.test("strict refinements compose with affine aliases", () => {
  const refinements = new RefinementContext();
  assert(refinements.assume({ tag: "less-than", left: 1, right: 2 }));
  assert(refinements.assume({
    tag: "equal-offset",
    left: 3,
    right: 1,
    offset: -1n,
  }));
  assert(refinements.entails({ tag: "less-than", left: 3, right: 2 }));
});

Deno.test("a rejected refinement leaves earlier facts intact", () => {
  const refinements = new RefinementContext();
  assert(refinements.assume({ tag: "at-least", variable: 1, value: 0n }));
  assertFalse(refinements.assume({
    tag: "at-most",
    variable: 1,
    value: -1n,
  }));
  assert(refinements.entails({ tag: "at-least", variable: 1, value: 0n }));
  assertFalse(refinements.entails({
    tag: "at-most",
    variable: 1,
    value: -1n,
  }));
});

Deno.test("forgetting a dead identity preserves live transitive facts", () => {
  const refinements = new RefinementContext();
  assert(refinements.assume({
    tag: "difference-at-most",
    left: 1,
    right: 2,
    offset: 3n,
  }));
  assert(refinements.assume({
    tag: "difference-at-most",
    left: 2,
    right: 3,
    offset: 4n,
  }));

  refinements.forget(2);

  assert(refinements.entails({
    tag: "difference-at-most",
    left: 1,
    right: 3,
    offset: 7n,
  }));
  assertFalse(
    refinements.assumptions().some((proposition) =>
      "variable" in proposition && proposition.variable === 2 ||
      "left" in proposition &&
        (proposition.left === 2 || proposition.right === 2)
    ),
  );
});
