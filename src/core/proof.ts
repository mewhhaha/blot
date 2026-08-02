import {
  RefinementContext,
  type RefinementProposition,
  type RefinementVariable,
} from "./refinement.ts";

/** A refinement term retained after ordinary inference types are erased. */
export type RefinementTerm =
  | { readonly tag: "literal"; readonly value: bigint }
  | {
    readonly tag: "variable";
    readonly identity: number;
    readonly offset: bigint;
  };

export interface RefinementInterval {
  readonly low: RefinementTerm;
  readonly high: RefinementTerm;
}

/** Erasable evidence carried from relationship checking into lowering. */
export interface ArrayIndexProof {
  readonly tag: "array-index";
  readonly assumptions: readonly RefinementProposition[];
  readonly length: RefinementTerm;
  readonly intervals: readonly RefinementInterval[];
}

/**
 * Replays a bounds certificate without consulting inference types or the
 * solver that produced it.
 */
export function verifiesArrayIndexProof(proof: ArrayIndexProof): boolean {
  if (proof.intervals.length === 0) return false;
  if (!validTerm(proof.length)) return false;
  for (const interval of proof.intervals) {
    if (!validTerm(interval.low) || !validTerm(interval.high)) return false;
  }
  const refinements = new RefinementContext();
  for (const assumption of proof.assumptions) {
    if (!validProposition(assumption) || !refinements.assume(assumption)) {
      return false;
    }
  }
  let nextLiteral = -1;

  const materialize = (term: RefinementTerm): RefinementVariable => {
    const variable = nextLiteral;
    nextLiteral -= 1;
    if (term.tag === "literal") {
      if (
        !refinements.assume({
          tag: "at-least",
          variable,
          value: term.value,
        })
      ) return variable;
      refinements.assume({ tag: "at-most", variable, value: term.value });
      return variable;
    }

    const related = term.identity;
    refinements.assume({
      tag: "equal-offset",
      left: variable,
      right: related,
      offset: term.offset,
    });
    return variable;
  };

  const length = materialize(proof.length);
  for (const interval of proof.intervals) {
    const low = materialize(interval.low);
    const high = materialize(interval.high);
    if (!refinements.entails({ tag: "at-least", variable: low, value: 0n })) {
      return false;
    }
    if (!refinements.entails({ tag: "less-than", left: high, right: length })) {
      return false;
    }
  }
  return true;
}

function validProposition(proposition: RefinementProposition): boolean {
  if (proposition.tag === "at-least" || proposition.tag === "at-most") {
    return validVariable(proposition.variable);
  }
  return validVariable(proposition.left) && validVariable(proposition.right);
}

function validVariable(variable: RefinementVariable): boolean {
  return Number.isSafeInteger(variable) && variable >= 0;
}

function validTerm(term: RefinementTerm): boolean {
  if (term.tag === "literal") return true;
  return validVariable(term.identity);
}
