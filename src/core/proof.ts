import type { ClosedBound, SimpleType } from "../check/type.ts";

/** Erasable evidence carried from relationship checking into lowering. */
export interface ArrayIndexProof {
  readonly tag: "array-index";
  readonly length: ClosedBound;
  readonly indices: SimpleType;
}
