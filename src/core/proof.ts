import type { ClosedBound, SimpleType } from "../check/type.ts";
import { shiftBound } from "../check/type.ts";
import { intersect } from "../check/setops.ts";

/** Erasable evidence carried from relationship checking into lowering. */
export interface ArrayIndexProof {
  readonly tag: "array-index";
  readonly length: ClosedBound;
  readonly indices: SimpleType;
}

/** Checks a certificate without consulting the inference environment. */
export function verifiesArrayIndexProof(proof: ArrayIndexProof): boolean {
  const inside: SimpleType = {
    tag: "range",
    domain: "int",
    low: 0n,
    high: shiftBound(proof.length, -1n),
  };
  const intersection = intersect(proof.indices, inside);
  if (intersection.tag !== "type") return false;
  return sameIndexSet(intersection.type, proof.indices);
}

function sameIndexSet(left: SimpleType, right: SimpleType): boolean {
  if (left.tag === "bottom" || right.tag === "bottom") {
    return left.tag === right.tag;
  }
  if (left.tag === "range" && right.tag === "range") {
    return left.domain === right.domain && left.low === right.low &&
      left.high === right.high;
  }
  if (left.tag !== "union" || right.tag !== "union") return false;
  if (left.members.length !== right.members.length) return false;
  return left.members.every((member, index) => {
    const candidate = right.members[index];
    if (candidate === undefined) return false;
    return sameIndexSet(member, candidate);
  });
}
