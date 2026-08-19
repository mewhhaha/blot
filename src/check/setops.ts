// Intersection and difference on ground types.
//
// Types in blot are sets: `1 | 2 | 3` is a three-element set, `Int` is every
// integer, `#A | #B` is a set of constructors. Once a branch proves something
// about a value — `n == 1` on the branch it is taken — the type that branch
// should see is ordinary set algebra on those sets. This module is that algebra
// and nothing else: it has no opinion about branches, conditions, or operators,
// and no caller yet.
//
// WHY THIS DOES NOT TOUCH BIUNIFICATION
//
// Algebraic subtyping stays polynomial because unions only ever appear where a
// value is produced and intersections only where a value is demanded. A lattice
// with arbitrary intersection and complement in both polarities is a boolean
// algebra and the bound is gone.
//
// Nothing here adds either. Both operations take two types and return one type
// that is already in the lattice — `bottom`, a `range`, a closed `variant`,
// `unit`, or a `union` of those. There is no `intersection` constructor and no
// `complement` constructor to add, because the answer is computed rather than
// represented: `(1 | 2 | 3) ∩ 1` is the type `1`, not the type `(1 | 2 | 3) & 1`.
// That is only possible because both sides are ground, which is why every
// non-ground shape is refused instead of approximated. No `constrain` call is
// made, no variable bound is pushed, and no variable is even read — so
// biunification cannot observe that this module exists.
//
// The piece count stays linear for the same reason. Subtracting one atom splits
// at most one interval in two, so `A \ B` has at most `|A| + |B|` pieces and `d`
// nested differences over one range give at most `d + 1`. Nothing here can
// produce an exponential type.
//
// WHAT IS REFUSED, AND WHY EACH REFUSAL IS A FACT ABOUT THE LATTICE
//
//   * A text range cannot exclude a value from its interior. `Bound` is
//     inclusive (type.ts) and text order is dense, so there is no bound naming
//     the values just below `"m"`; splitting `Str` at `"m"` would print
//     `.."m" | "m"..` and readmit the value it was asked to remove. Integers are
//     discrete, so the same split is exact for them and is performed.
//   * An open `variant` is "these constructors, and possibly others". `variant`
//     carries only `cases` and `open`, so there is no way to write down "those
//     others, minus `#A`" — a negated constructor set is unrepresentable.
//   * A record, an array, a function, `top`, an `opaque`, or an effect row has
//     no complement in this lattice, and intersecting two records would be a
//     genuine intersection type — the thing the polarity argument above forbids.
//   * A variable is not a set yet. Reading its bounds and answering anyway would
//     be a guess about values that have not arrived.
//
// This is deliberately not `@type.intersect` or `@type.diff`. Those filter
// members with the comptime `equal`, which on a range compares exact bounds, so
// `@type.diff Int 1` answers `Int` and silently readmits `1`, and
// `@type.intersect Int 1` reports `BLOT_EMPTY_TYPE` where the answer is `1`.
// A set operation that silently readmits a value is worse than one that refuses.

import { expect } from "../diagnostic.ts";
import {
  BOTTOM,
  type Bound,
  boundAtMost,
  type ClosedBound,
  type SimpleType,
  TOP,
  union,
} from "./type.ts";
import { show, showRange } from "./print.ts";

/**
 * Why an operation could not be performed exactly.
 *
 * It is not a `Diagnostic`: this module has no span to report against. A caller
 * that wants to speak attaches its own span; a caller that would rather stay
 * silent — the usual choice when a type simply is not ground yet — ignores it.
 */
export interface Refusal {
  readonly code: string;
  readonly message: string;
}

export type SetResult =
  | { readonly tag: "type"; readonly type: SimpleType }
  | { readonly tag: "refused"; readonly refusal: Refusal };

export const UNSUPPORTED_SET_OP = "BLOT_UNSUPPORTED_SET_OP";

/**
 * Canonical union at the closed type-value boundary.
 *
 * Open inference does not build union nodes: several lower bounds are its
 * join. Type values have already finished that job, so they can be flattened,
 * stripped of `bottom`, short-circuited by `top`, and deduplicated here. This
 * is the one normalization boundary shared by bridging and exact set algebra.
 */
export function normalizeClosedUnion(
  members: readonly SimpleType[],
): SimpleType {
  const flat: SimpleType[] = [];
  const append = (member: SimpleType): void => {
    if (member.tag === "bottom") return;
    if (member.tag === "union") {
      for (const nested of member.members) append(nested);
      return;
    }
    flat.push(member);
  };
  for (const member of members) append(member);
  if (flat.some((member) => member.tag === "top")) return TOP;

  const distinct = new Map<string, SimpleType>();
  for (const member of flat) distinct.set(show(member), member);
  const normalized = [...distinct.values()];
  if (normalized.length === 0) return BOTTOM;
  return union(normalized);
}

/** A ground shape whose inhabitants the lattice can name exactly. */
type Atom =
  | Extract<SimpleType, { tag: "range" }>
  | Extract<SimpleType, { tag: "variant" }>
  | Extract<SimpleType, { tag: "unit" }>;

/** Thrown by the algebra, caught at the two entry points. Never escapes. */
class Unsupported extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = "Unsupported";
  }
}

function refuse(message: string): never {
  throw new Unsupported({ code: UNSUPPORTED_SET_OP, message });
}

/** The values in both `left` and `right`. */
export function intersect(left: SimpleType, right: SimpleType): SetResult {
  return attempt(() => intersectGround(left, right));
}

/** The values in `left` that are not in `right`. */
export function difference(left: SimpleType, right: SimpleType): SetResult {
  return attempt(() => differenceGround(left, right));
}

function attempt(operation: () => SimpleType): SetResult {
  try {
    return { tag: "type", type: operation() };
  } catch (error) {
    if (error instanceof Unsupported) {
      return { tag: "refused", refusal: error.refusal };
    }
    throw error;
  }
}

function intersectGround(left: SimpleType, right: SimpleType): SimpleType {
  const pieces: Atom[] = [];
  for (const one of atomsOf(left)) {
    for (const other of atomsOf(right)) {
      const both = intersectAtoms(one, other);
      if (both !== null) pieces.push(both);
    }
  }
  return fromAtoms(pieces);
}

function differenceGround(left: SimpleType, right: SimpleType): SimpleType {
  // Subtract one atom at a time. Each pass keeps the pieces disjoint from
  // everything removed so far, so the order does not matter and the count grows
  // by at most one per subtracted atom.
  let pieces = atomsOf(left);
  for (const other of atomsOf(right)) {
    pieces = pieces.flatMap((one) => differenceAtoms(one, other));
  }
  return fromAtoms(pieces);
}

/**
 * The atoms `type` is the union of.
 *
 * `bottom` is the empty union, which is why it needs no special case anywhere
 * else. Everything that is not a union of atoms is refused here, so the algebra
 * below never has to ask whether its inputs are ground.
 */
function atomsOf(type: SimpleType): Atom[] {
  switch (type.tag) {
    case "bottom":
      return [];
    case "range":
    case "unit":
      return [type];
    case "variant": {
      if (type.open) {
        refuse(
          `\`${
            show(type)
          }\` admits constructors it does not name, so the constructors outside it cannot be written down`,
        );
      }
      return [type];
    }
    case "union":
      return type.members.flatMap(atomsOf);
    default:
      refuse(`\`${show(type)}\` is not a ground set`);
  }
}

function fromAtoms(pieces: readonly Atom[]): SimpleType {
  return normalizeClosedUnion(pieces);
}

/** The atom both describe, or `null` when they are disjoint. */
function intersectAtoms(left: Atom, right: Atom): Atom | null {
  if (left.tag === "unit" && right.tag === "unit") return left;

  if (left.tag === "range" && right.tag === "range") {
    if (left.domain !== right.domain) return null;
    const low = higherLow(left.low, right.low);
    const high = lowerHigh(left.high, right.high);
    if (crossed(low, high)) return null;
    return { tag: "range", domain: left.domain, low, high };
  }

  if (left.tag === "variant" && right.tag === "variant") {
    const cases = new Map<string, SimpleType>();
    for (const [name, payload] of left.cases) {
      const accepted = right.cases.get(name);
      if (accepted === undefined) continue;
      const both = intersectGround(payload, accepted);
      // A constructor whose payload is uninhabited is itself uninhabited.
      if (both.tag === "bottom") continue;
      cases.set(name, both);
    }
    if (cases.size === 0) return null;
    return { tag: "variant", cases, open: false };
  }

  // An integer is not a constructor and a constructor is not `()`. Different
  // shapes have no inhabitant in common.
  return null;
}

/** The pieces of `left` that `right` does not contain. */
function differenceAtoms(left: Atom, right: Atom): Atom[] {
  if (left.tag === "unit" && right.tag === "unit") return [];

  if (left.tag === "range" && right.tag === "range") {
    if (left.domain !== right.domain) return [left];
    if (apart(left.high, right.low) || apart(right.high, left.low)) {
      return [left];
    }
    if (covers(right.low, right.high, left.low, left.high)) return [];
    if (left.domain !== "int") {
      refuse(
        `\`${show(right)}\` cannot be removed from \`${
          show(left)
        }\`: text bounds are inclusive and text order is dense, so no bound names the values just outside it`,
      );
    }
    // Integers are discrete, so the values below `right` end at `right.low - 1`
    // and the values above it start at `right.high + 1`. Both pieces are exact.
    const pieces: Atom[] = [];
    if (right.low !== null) {
      const high = stepDown(right.low);
      if (!crossed(left.low, high)) {
        pieces.push({ tag: "range", domain: "int", low: left.low, high });
      }
    }
    if (right.high !== null) {
      const low = stepUp(right.high);
      if (!crossed(low, left.high)) {
        pieces.push({ tag: "range", domain: "int", low, high: left.high });
      }
    }
    return pieces;
  }

  if (left.tag === "variant" && right.tag === "variant") {
    const cases = new Map<string, SimpleType>();
    for (const [name, payload] of left.cases) {
      const removed = right.cases.get(name);
      if (removed === undefined) {
        cases.set(name, payload);
        continue;
      }
      const rest = differenceGround(payload, removed);
      if (rest.tag === "bottom") continue;
      cases.set(name, rest);
    }
    if (cases.size === 0) return [];
    return [{ tag: "variant", cases, open: false }];
  }

  return [left];
}

/**
 * The greater of two lower bounds. `null` is unbounded below.
 *
 * Refuses when neither bound is known to be at most the other. It cannot
 * approximate: naming the wrong one as the greater either drops values the
 * intersection contains or admits values it does not.
 *
 * `boundAtMost` rather than a strict comparison preserves equal endpoints.
 */
function higherLow(left: Bound, right: Bound): Bound {
  if (left === null) return right;
  if (right === null) return left;
  if (boundAtMost(left, right) === true) return right;
  if (boundAtMost(right, left) === true) return left;
  refuse(
    `\`${showBound(left)}\` and \`${
      showBound(right)
    }\` cannot be ordered, so which of them starts the intersection is unknown`,
  );
}

/** The lesser of two upper bounds. `null` is unbounded above. */
function lowerHigh(left: Bound, right: Bound): Bound {
  if (left === null) return right;
  if (right === null) return left;
  if (boundAtMost(left, right) === true) return left;
  if (boundAtMost(right, left) === true) return right;
  refuse(
    `\`${showBound(left)}\` and \`${
      showBound(right)
    }\` cannot be ordered, so which of them ends the intersection is unknown`,
  );
}

/**
 * No value satisfies both: the interval ran backwards.
 *
 * Unknown is read as "not crossed". Answering yes turns a range into `bottom`,
 * which tells the rest of the compiler that a branch is unreachable — a claim
 * about a program that a length nobody has measured cannot support. Keeping a
 * range that may hold nothing costs only precision.
 */
function crossed(low: Bound, high: Bound): boolean {
  if (low === null || high === null) return false;
  return boundAtMost(low, high) === false;
}

/**
 * Every value at or below `high` is strictly below every value at or above
 * `low`. Unknown is read as "not apart", which sends the difference on to the
 * split — and the split refuses a length outright.
 */
function apart(high: Bound, low: Bound): boolean {
  if (high === null || low === null) return false;
  return boundAtMost(low, high) === false;
}

/** Unknown is read as "does not cover": nothing is removed on a guess. */
function covers(
  low: Bound,
  high: Bound,
  innerLow: Bound,
  innerHigh: Bound,
): boolean {
  const belowStart = low === null ||
    (innerLow !== null && boundAtMost(low, innerLow) === true);
  const aboveEnd = high === null ||
    (innerHigh !== null && boundAtMost(innerHigh, high) === true);
  return belowStart && aboveEnd;
}

/**
 * A bound on its own, for a refusal that has no range to show.
 *
 * Only a length is ever undecided, and a length is an integer, so this is
 * never asked to spell a text bound.
 */
function showBound(bound: ClosedBound): string {
  return showRange("int", bound, bound);
}

function stepDown(bound: Bound): Bound {
  expect(typeof bound === "bigint", "an int range carries a non-integer bound");
  return bound - 1n;
}

function stepUp(bound: Bound): Bound {
  expect(typeof bound === "bigint", "an int range carries a non-integer bound");
  return bound + 1n;
}
