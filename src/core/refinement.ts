export type RefinementVariable = number;

export type RefinementProposition =
  | {
    readonly tag: "equal-offset";
    readonly left: RefinementVariable;
    readonly right: RefinementVariable;
    readonly offset: bigint;
  }
  | {
    readonly tag: "at-least";
    readonly variable: RefinementVariable;
    readonly value: bigint;
  }
  | {
    readonly tag: "at-most";
    readonly variable: RefinementVariable;
    readonly value: bigint;
  }
  | {
    readonly tag: "less-than";
    readonly left: RefinementVariable;
    readonly right: RefinementVariable;
  }
  | {
    readonly tag: "difference-at-most";
    readonly left: RefinementVariable;
    readonly right: RefinementVariable;
    readonly offset: bigint;
  };

type ConstraintNode = RefinementVariable | typeof ZERO;

interface DifferenceConstraint {
  /** `left - right <= bound`. */
  readonly left: ConstraintNode;
  readonly right: ConstraintNode;
  readonly bound: bigint;
}

const ZERO = Symbol("refinement-zero");

/**
 * Integer affine equalities and difference constraints.
 *
 * The graph stores `left - right <= bound` as an edge from `right` to
 * `left`. Entailment is shortest-path closure, and a negative cycle rejects
 * an inconsistent assumption. The expected contexts are deliberately small,
 * so recomputing closure keeps the proof kernel simpler than an incremental
 * solver.
 */
export class RefinementContext {
  readonly #constraints: DifferenceConstraint[];
  readonly #assumptions: RefinementProposition[];

  constructor(
    constraints: readonly DifferenceConstraint[] = [],
    assumptions: readonly RefinementProposition[] = [],
  ) {
    this.#constraints = [...constraints];
    this.#assumptions = [...assumptions];
  }

  clone(): RefinementContext {
    return new RefinementContext(this.#constraints, this.#assumptions);
  }

  assumptions(): readonly RefinementProposition[] {
    return [...this.#assumptions];
  }

  assume(proposition: RefinementProposition): boolean {
    const added = constraintsFor(proposition);
    this.#constraints.push(...added);
    if (this.#consistent()) {
      this.#assumptions.push(proposition);
      return true;
    }
    this.#constraints.splice(this.#constraints.length - added.length);
    return false;
  }

  entails(proposition: RefinementProposition): boolean {
    const distances = shortestPaths(this.#constraints);
    for (const constraint of constraintsFor(proposition)) {
      const from = distances.get(constraint.right);
      const distance = from?.get(constraint.left);
      if (distance === undefined || distance > constraint.bound) return false;
    }
    return true;
  }

  /**
   * Removes one dead identity while preserving every difference bound entailed
   * between the remaining identities.
   *
   * Deleting incident edges alone would lose facts whose shortest path passes
   * through the dead node. Materialising the closure first is variable
   * elimination for difference constraints and keeps certificate replay exact.
   */
  forget(variable: RefinementVariable): void {
    const present = this.#constraints.some((constraint) =>
      constraint.left === variable || constraint.right === variable
    );
    if (!present) return;

    const distances = shortestPaths(this.#constraints);
    const nodes = [...distances.keys()].filter((node) => node !== variable);
    const constraints: DifferenceConstraint[] = [];
    const assumptions: RefinementProposition[] = [];
    for (const right of nodes) {
      const from = distances.get(right);
      if (from === undefined) continue;
      for (const left of nodes) {
        if (left === right) continue;
        const bound = from.get(left);
        if (bound === undefined) continue;
        if (left === ZERO) {
          if (right === ZERO) continue;
          const proposition: RefinementProposition = {
            tag: "at-least",
            variable: right,
            value: -bound,
          };
          constraints.push(...constraintsFor(proposition));
          assumptions.push(proposition);
          continue;
        }
        if (right === ZERO) {
          const proposition: RefinementProposition = {
            tag: "at-most",
            variable: left,
            value: bound,
          };
          constraints.push(...constraintsFor(proposition));
          assumptions.push(proposition);
          continue;
        }
        const proposition: RefinementProposition = {
          tag: "difference-at-most",
          left,
          right,
          offset: bound,
        };
        constraints.push(...constraintsFor(proposition));
        assumptions.push(proposition);
      }
    }
    this.#constraints.splice(0, this.#constraints.length, ...constraints);
    this.#assumptions.splice(0, this.#assumptions.length, ...assumptions);
  }

  #consistent(): boolean {
    const distances = shortestPaths(this.#constraints);
    for (const [node, from] of distances) {
      const self = from.get(node);
      if (self !== undefined && self < 0n) return false;
    }
    return true;
  }
}

function constraintsFor(
  proposition: RefinementProposition,
): readonly DifferenceConstraint[] {
  switch (proposition.tag) {
    case "equal-offset":
      return [
        {
          left: proposition.left,
          right: proposition.right,
          bound: proposition.offset,
        },
        {
          left: proposition.right,
          right: proposition.left,
          bound: -proposition.offset,
        },
      ];
    case "at-least":
      return [{
        left: ZERO,
        right: proposition.variable,
        bound: -proposition.value,
      }];
    case "at-most":
      return [{
        left: proposition.variable,
        right: ZERO,
        bound: proposition.value,
      }];
    case "less-than":
      return [{
        left: proposition.left,
        right: proposition.right,
        bound: -1n,
      }];
    case "difference-at-most":
      return [{
        left: proposition.left,
        right: proposition.right,
        bound: proposition.offset,
      }];
  }
}

function shortestPaths(
  constraints: readonly DifferenceConstraint[],
): ReadonlyMap<ConstraintNode, ReadonlyMap<ConstraintNode, bigint>> {
  const nodes = new Set<ConstraintNode>([ZERO]);
  for (const constraint of constraints) {
    nodes.add(constraint.left);
    nodes.add(constraint.right);
  }

  const result = new Map<ConstraintNode, ReadonlyMap<ConstraintNode, bigint>>();
  for (const source of nodes) {
    const distances = new Map<ConstraintNode, bigint>([[source, 0n]]);
    for (let pass = 0; pass < nodes.size; pass += 1) {
      let changed = false;
      for (const constraint of constraints) {
        const right = distances.get(constraint.right);
        if (right === undefined) continue;
        const candidate = right + constraint.bound;
        const left = distances.get(constraint.left);
        if (left !== undefined && left <= candidate) continue;
        distances.set(constraint.left, candidate);
        changed = true;
      }
      if (!changed) break;
    }
    result.set(source, distances);
  }
  return result;
}
