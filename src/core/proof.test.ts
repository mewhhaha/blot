import { assert, assertFalse } from "@std/assert";
import { lengthBound } from "../check/type.ts";
import { verifiesArrayIndexProof } from "./proof.ts";

Deno.test("array index certificates verify independently", () => {
  const length = lengthBound(1, 0n, "values");
  assert(verifiesArrayIndexProof({
    tag: "array-index",
    length,
    indices: {
      tag: "range",
      domain: "int",
      low: 0n,
      high: lengthBound(1, -1n, "values"),
    },
  }));
});

Deno.test("array index certificates reject an out-of-bounds claim", () => {
  const length = lengthBound(2, 0n, "values");
  assertFalse(verifiesArrayIndexProof({
    tag: "array-index",
    length,
    indices: {
      tag: "range",
      domain: "int",
      low: 0n,
      high: length,
    },
  }));
});
