import { assert, assertFalse } from "@std/assert";
import { verifiesArrayIndexProof } from "./proof.ts";

Deno.test("array index certificates verify independently", () => {
  assert(verifiesArrayIndexProof({
    tag: "array-index",
    assumptions: [],
    length: { tag: "variable", identity: 1, offset: 0n },
    intervals: [{
      low: { tag: "literal", value: 0n },
      high: { tag: "variable", identity: 1, offset: -1n },
    }],
  }));
});

Deno.test("array index certificates reject a mismatched identity", () => {
  assertFalse(verifiesArrayIndexProof({
    tag: "array-index",
    assumptions: [],
    length: { tag: "variable", identity: 1, offset: 0n },
    intervals: [{
      low: { tag: "literal", value: 0n },
      high: { tag: "variable", identity: 2, offset: -1n },
    }],
  }));
});

Deno.test("array index certificates reject an out-of-bounds claim", () => {
  assertFalse(verifiesArrayIndexProof({
    tag: "array-index",
    assumptions: [],
    length: { tag: "literal", value: 3n },
    intervals: [{
      low: { tag: "literal", value: 0n },
      high: { tag: "literal", value: 3n },
    }],
  }));
});

Deno.test("array index certificates replay branch assumptions", () => {
  assert(verifiesArrayIndexProof({
    tag: "array-index",
    assumptions: [
      { tag: "at-least", variable: 2, value: 0n },
      { tag: "difference-at-most", left: 2, right: 1, offset: -1n },
    ],
    length: { tag: "variable", identity: 1, offset: 0n },
    intervals: [{
      low: { tag: "variable", identity: 2, offset: 0n },
      high: { tag: "variable", identity: 2, offset: 0n },
    }],
  }));
});

Deno.test("array index certificates reject a missing branch assumption", () => {
  assertFalse(verifiesArrayIndexProof({
    tag: "array-index",
    assumptions: [{ tag: "at-least", variable: 2, value: 0n }],
    length: { tag: "variable", identity: 1, offset: 0n },
    intervals: [{
      low: { tag: "variable", identity: 2, offset: 0n },
      high: { tag: "variable", identity: 2, offset: 0n },
    }],
  }));
});
