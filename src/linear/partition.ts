/**
 * Structure-independent partition proof manipulation.
 *
 * Ownership flow decides whether each proof value is consumed. A family
 * adapter decides what its parts mean and how adjacent parts compose. This
 * module owns only exact witness matching and associative proof-tree rotation.
 */

export interface PartitionWitness<Family, Part> {
  readonly family: Family;
  readonly parent: Part;
  readonly left: Part;
  readonly right: Part;
}

export interface PartitionAlgebra<Family, Part> {
  readonly sameFamily: (left: Family, right: Family) => boolean;
  readonly samePart: (left: Part, right: Part) => boolean;
  /** Returns the ordered union, or null when the parts cannot compose. */
  readonly compose: (family: Family, left: Part, right: Part) => Part | null;
}

export type PartitionError =
  | "family-mismatch"
  | "left-mismatch"
  | "right-mismatch"
  | "inner-parent-mismatch"
  | "composition-refused";

export type PartitionResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: PartitionError };

export function combinePartition<Family, Part>(
  algebra: PartitionAlgebra<Family, Part>,
  family: Family,
  witness: PartitionWitness<Family, Part>,
  left: Part,
  right: Part,
): PartitionResult<Part> {
  if (!algebra.sameFamily(family, witness.family)) {
    return { ok: false, error: "family-mismatch" };
  }
  if (!algebra.samePart(witness.left, left)) {
    return { ok: false, error: "left-mismatch" };
  }
  if (!algebra.samePart(witness.right, right)) {
    return { ok: false, error: "right-mismatch" };
  }
  return { ok: true, value: witness.parent };
}

export function reassociatePartition<Family, Part>(
  algebra: PartitionAlgebra<Family, Part>,
  direction: "left" | "right",
  outer: PartitionWitness<Family, Part>,
  inner: PartitionWitness<Family, Part>,
): PartitionResult<
  readonly [
    PartitionWitness<Family, Part>,
    PartitionWitness<Family, Part>,
  ]
> {
  if (!algebra.sameFamily(outer.family, inner.family)) {
    return { ok: false, error: "family-mismatch" };
  }
  if (direction === "left") {
    if (!algebra.samePart(outer.right, inner.parent)) {
      return { ok: false, error: "inner-parent-mismatch" };
    }
    const joined = algebra.compose(outer.family, outer.left, inner.left);
    if (joined === null) {
      return { ok: false, error: "composition-refused" };
    }
    return {
      ok: true,
      value: [
        {
          family: outer.family,
          left: joined,
          right: inner.right,
          parent: outer.parent,
        },
        {
          family: outer.family,
          left: outer.left,
          right: inner.left,
          parent: joined,
        },
      ],
    };
  }
  if (!algebra.samePart(outer.left, inner.parent)) {
    return { ok: false, error: "inner-parent-mismatch" };
  }
  const joined = algebra.compose(outer.family, inner.right, outer.right);
  if (joined === null) {
    return { ok: false, error: "composition-refused" };
  }
  return {
    ok: true,
    value: [
      {
        family: outer.family,
        left: inner.left,
        right: joined,
        parent: outer.parent,
      },
      {
        family: outer.family,
        left: inner.right,
        right: outer.right,
        parent: joined,
      },
    ],
  };
}
