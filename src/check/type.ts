// The inference lattice.
//
// One lattice, no type-level sublanguage. Everything blot infers is an element
// here, and the pieces that look like separate features elsewhere are the same
// piece seen twice:
//
//   * a literal is a range whose bounds coincide, so "literals are singleton
//     types" needs no separate constructor;
//   * an effect row is a set ordered by inclusion — fewer effects is a subtype,
//     exactly like a variant with fewer cases. Effect inference is therefore
//     not a separate pass, it is the join the algorithm already computes;
//   * a `duck` contract is a record constraint, so width subtyping is the whole
//     of what a typeclass would have been.
//
// Inference follows Parreaux's Simple-sub: mutable variables carrying lower and
// upper bounds, levels for let-polymorphism, and biunification by propagating
// bounds rather than by unifying. It is polynomial, which is what pays for
// keeping ownership and linearity out of the lattice entirely.

import { expect } from "../diagnostic.ts";
import { F32X4_MASK_NAME, F32X4_NAME } from "../comptime/value.ts";

export type Level = number;

/**
 * `length(binding) + offset` — the number of elements in one immutable array
 * value, shifted by a literal.
 *
 * WHY A LENGTH IS A BOUND AND NOT A TYPE
 *
 * An array's type is `{ tag: "array", element }` and carries no length, because
 * a length is a fact about a *value*. What an index needs is not the array's
 * type but something it can be compared against, and the thing an integer range
 * compares against is a `Bound`. So the symbol goes here, in the one place the
 * lattice already reads relationally, and nowhere else: there is no new
 * `SimpleType` constructor, no equation store, and no constraint between two
 * symbols. Comparison is same-root-or-unknown, which is O(1) and total.
 *
 * IDENTITY IS THE BINDING OCCURRENCE
 *
 * `binding` is an id minted for an immutable value. A fresh binder normally
 * creates one; an alias keeps the id. blot has no assignment and arrays are
 * immutable, so the identity denotes exactly one value for its whole lifetime,
 * and `len(b)` therefore denotes exactly one integer.
 *
 * The two cheaper keys are unsound, each with a program that shows it:
 *
 *   * By name. `let measure = fn vs => @array.len vs; let read = fn vs => fn i =>
 *     @array.get vs i;` — two lambdas, two different arrays, one name. A
 *     measurement of the first would license a read of the second.
 *   * By type variable. `@array.push`'s scheme builds parameter and result from
 *     the same `element` object (primitives.ts), so `let bigger = @array.push
 *     xs 9;` shares `xs`'s variable. Measuring `bigger` would license a read of
 *     `xs` one element past its end.
 *
 * `let ys = xs;` keeps the identity, while a function call or a `:=` to another
 * value does not. This preserves a fact through a transparent alias without
 * equating two arrays merely because their element types agree.
 *
 * `name` is for the reader only. Two occurrences may share it; it takes no part
 * in identity, and `lengthSubject` is what disambiguates it in a message.
 */
export interface LengthBound {
  readonly tag: "len";
  readonly binding: number;
  readonly offset: bigint;
  readonly name: string;
}

/** `null` is an open end: the domain is unbounded in that direction. */
export type Bound = bigint | string | LengthBound | null;

/** A bound that names a value — everything but the open end. */
export type ClosedBound = Exclude<Bound, null>;

export interface Variable {
  readonly tag: "var";
  readonly id: number;
  level: Level;
  /** Types that flow into this variable. Its meaning when read positively. */
  readonly lower: SimpleType[];
  /** Types this variable must flow into. Its obligations when read negatively. */
  readonly upper: SimpleType[];
}

export interface RigidVariable {
  readonly tag: "rigid";
  readonly id: number;
}

/**
 * The ordered domains a range lives in.
 *
 * `float` and `float32` ranges are always open at both ends. A float bound would have to be
 * a real number, and the operations this lattice performs on bounds — adjacency
 * in `difference`, enumeration in coverage — have no meaning there: there is no
 * next float after 1.5 that a program could name, and equality is not something
 * to narrow on when NaN and rounding exist. So `1.5` is a `Float` rather than a
 * singleton, and the machinery that would need a real number is never reached.
 */
export type Domain = "int" | "text" | "float" | "float32";

export type SimpleType =
  | Variable
  | RigidVariable
  | {
    readonly tag: "forall";
    readonly variables: readonly number[];
    readonly body: SimpleType;
  }
  | {
    readonly tag: "range";
    readonly domain: Domain;
    readonly low: Bound;
    readonly high: Bound;
  }
  | { readonly tag: "unit" }
  | {
    readonly tag: "fun";
    readonly param: SimpleType;
    readonly effects: SimpleType;
    readonly result: SimpleType;
  }
  | { readonly tag: "record"; readonly fields: ReadonlyMap<string, SimpleType> }
  | { readonly tag: "array"; readonly element: SimpleType }
  /**
   * A union of constructors. Payload is `unit` when the tag carries none.
   *
   * `open` means "these constructors, and possibly others". It is what a `case`
   * with a wildcard or name arm proves about its scrutinee: the constructor
   * arms still say what their payloads carry, but the arm that matches
   * everything leaves the set of constructors unbounded. Inference only ever
   * builds one as an upper bound.
   */
  | {
    readonly tag: "variant";
    readonly cases: ReadonlyMap<string, SimpleType>;
    readonly open: boolean;
  }
  /** An effect row: a set ordered by inclusion. */
  | { readonly tag: "effects"; readonly labels: ReadonlySet<string> }
  /**
   * A declared union of ground types, as written in a `sig`: `1 | 2 | "three"`.
   *
   * Inference itself never builds one — a variable's several lower bounds are
   * how it represents a join. This constructor exists only for unions that
   * arrive already computed from a type expression, and its members are
   * required to be ground. That restriction is what keeps `T <: union`
   * decidable by trying each member instead of backtracking through variables.
   */
  | { readonly tag: "union"; readonly members: readonly SimpleType[] }
  /** An opaque value the checker knows nothing about — a host capability. */
  | { readonly tag: "opaque"; readonly name: string }
  | { readonly tag: "top" }
  | { readonly tag: "bottom" };

/** A `let`-bound scheme. Instantiating it freshens everything above `level`. */
export interface Scheme {
  readonly tag: "scheme";
  readonly level: Level;
  readonly body: SimpleType;
}

export type Typing = SimpleType | Scheme;

let nextId = 0;
let nextRigidId = 0;

export function freshVar(level: Level): Variable {
  nextId += 1;
  return { tag: "var", id: nextId, level, lower: [], upper: [] };
}

export function freshRigid(): RigidVariable {
  nextRigidId += 1;
  return { tag: "rigid", id: nextRigidId };
}

export const UNIT: SimpleType = { tag: "unit" };
export const TOP: SimpleType = { tag: "top" };
export const BOTTOM: SimpleType = { tag: "bottom" };
export const PURE: SimpleType = { tag: "effects", labels: new Set() };

export function intLiteral(value: bigint): SimpleType {
  return { tag: "range", domain: "int", low: value, high: value };
}

export function textLiteral(value: string): SimpleType {
  return { tag: "range", domain: "text", low: value, high: value };
}

export const INT: SimpleType = {
  tag: "range",
  domain: "int",
  low: null,
  high: null,
};
export const TEXT: SimpleType = {
  tag: "range",
  domain: "text",
  low: null,
  high: null,
};
/**
 * The only float type. There is no `floatLiteral`, because a float range is
 * always open at both ends — `1.5` is a `Float`, not a singleton (see
 * `Domain`).
 */
export const FLOAT: SimpleType = {
  tag: "range",
  domain: "float",
  low: null,
  high: null,
};
/**
 * Single precision. A separate type rather than a precision `F64` sometimes
 * has, because rounding to it is a step a program takes rather than one that
 * happens to it — and because it is the lane type a four-wide vector needs.
 */
export const FLOAT32: SimpleType = {
  tag: "range",
  domain: "float32",
  low: null,
  high: null,
};
/**
 * Four `F32` lanes, as one value.
 *
 * A distinct type rather than a tuple of four, because it is one machine
 * register and a tuple is four fields: the point of naming it is that the
 * operations over it are single instructions, and a shape blot could take
 * apart field by field would not be.
 *
 * Opaque rather than a range, because a vector is not an interval. A range's
 * whole content is its two bounds, and there is no value a vector sits above or
 * below; it read as one only because every float-ish range is open at both ends
 * and so `setops` and coverage never put a bound question to it. `opaque` is
 * what the lattice already has for a type whose only fact is its name, and
 * matching by name is the relation four lanes need: an `F32x4` is an `F32x4`
 * and nothing else.
 */
export const F32X4: SimpleType = { tag: "opaque", name: F32X4_NAME };
export const F32X4_MASK: SimpleType = { tag: "opaque", name: F32X4_MASK_NAME };

export function fun(
  param: SimpleType,
  result: SimpleType,
  effects: SimpleType,
): SimpleType {
  return { tag: "fun", param, effects, result };
}

export function record(
  fields: Iterable<readonly [string, SimpleType]>,
): SimpleType {
  return { tag: "record", fields: new Map(fields) };
}

export function variant(
  cases: Iterable<readonly [string, SimpleType]>,
): SimpleType {
  return { tag: "variant", cases: new Map(cases), open: false };
}

/** `#A | #B | ..` — those constructors, and possibly others. */
export function openVariant(
  cases: Iterable<readonly [string, SimpleType]>,
): SimpleType {
  return { tag: "variant", cases: new Map(cases), open: true };
}

export function union(members: readonly SimpleType[]): SimpleType {
  if (members.length === 1) return members[0];
  return { tag: "union", members };
}

/** Whether a type explicitly names `Unit` as one of its inhabitants. */
export function admitsOmission(
  type: SimpleType,
  seen = new Set<number>(),
): boolean {
  if (type.tag === "unit") return true;
  if (type.tag === "union") {
    return type.members.some((member) => admitsOmission(member, seen));
  }
  if (type.tag === "forall") return admitsOmission(type.body, seen);
  if (type.tag !== "var" || seen.has(type.id)) return false;
  seen.add(type.id);
  return [...type.lower, ...type.upper].some((bound) =>
    admitsOmission(bound, seen)
  );
}

export function effects(labels: Iterable<string>): SimpleType {
  return { tag: "effects", labels: new Set(labels) };
}

export function tupleType(elements: readonly SimpleType[]): SimpleType {
  return record(
    elements.map((element, index) => [String(index), element] as const),
  );
}

const lengthBounds = new Map<string, LengthBound>();

/**
 * `len(binding) + offset`, interned so that `===` is denotational equality.
 *
 * The interning is load-bearing rather than a cache. `sameGround` in infer.ts
 * compares bounds with `===`, and `boundAtMost` must accept
 * `0..len xs - 1 <: 0..len xs - 1`; on two structurally equal objects a raw
 * `===` would answer no and a raw `<=` would answer yes in *both* directions,
 * because JavaScript stringifies every object to `"[object Object]"`. One
 * object per pair removes the question.
 */
export function lengthBound(
  binding: number,
  offset: bigint,
  name: string,
): LengthBound {
  const key = `${binding}:${offset}`;
  const existing = lengthBounds.get(key);
  if (existing !== undefined) return existing;
  const minted: LengthBound = { tag: "len", binding, offset, name };
  lengthBounds.set(key, minted);
  return minted;
}

export function isLength(bound: Bound): bound is LengthBound {
  return bound !== null && typeof bound === "object";
}

/**
 * `bound + delta`, the one place an offset is ever built.
 *
 * Two callers, and both build the same `1`: `region` in narrow.ts, because
 * "below `k`" ends at `k - 1`, and the valid index set of an array, because the
 * last index of `len xs` elements is `len xs - 1`. Keeping the arithmetic here
 * is what keeps it from spreading — an offset that no function outside this one
 * can construct cannot grow a second term.
 *
 * A text bound is never stepped. Text order is dense, so no bound names the
 * value just below another one, and the two operations that would want to —
 * `region` and set difference — are over `@int.cmp` and refuse text outright.
 */
export function shiftBound(bound: ClosedBound, delta: bigint): ClosedBound {
  if (typeof bound === "bigint") return bound + delta;
  if (isLength(bound)) {
    return lengthBound(bound.binding, bound.offset + delta, bound.name);
  }
  expect(false, "a text bound was stepped");
}

/**
 * How a message names the array whose length this is, beside another bound.
 *
 * Two occurrences may be written with the same name, and a range whose two ends
 * said `len xs` about two different arrays would read as a compiler bug. So the
 * occurrence id is spelled — `xs#7` — exactly when the bound printed next to
 * this one is a different occurrence with the same name, and never otherwise.
 *
 * Deciding it from the pair rather than from a claim made once per process is
 * what keeps the id out of the message a reader actually gets. A diagnostic
 * carries a span, so `len xs` at that span names the `xs` in scope there; a
 * number attached to it because some unrelated function also had a parameter
 * called `xs` would be noise the reader cannot act on.
 */
export function lengthSubject(bound: LengthBound, beside: Bound): string {
  if (!isLength(beside)) return bound.name;
  if (beside.name !== bound.name) return bound.name;
  if (beside.binding === bound.binding) return bound.name;
  return `${bound.name}#${bound.binding}`;
}

/**
 * The one fact the compiler assumes about a length it cannot see.
 *
 * `@array.len` lowers to `at.storeLength` converted through
 * `SignedInteger32ToSignedInteger64` (src/backend/lower.ts), so an array's
 * length is an i32 and `0 <= len(b) <= 2147483647` holds of every array a blot
 * program can build. It is admitted here because without it nothing narrows:
 * `n >= 0` proves `0..` and `n < @array.len xs` proves `..len xs - 1`, and
 * intersecting those two needs `0 <= len xs` to pick a lower bound at all.
 *
 * It is not the first step of a theory, because there is no second step
 * available. A bound holds one symbol and one literal offset, so relating a
 * symbol to a literal is the only assumption there is room to make; relating
 * two symbols would need a normal form this representation cannot express.
 */
export const LONGEST_ARRAY = 2147483647n;

/**
 * `left <= right`, or `null` when the lengths involved do not settle it.
 *
 * Partial, and that is the representation's whole soundness. A three-way
 * ordering cannot express the state of `0` against `len xs` — below or same,
 * and which one is unknown — which is the state of the comparison the feature
 * exists to make. Every caller is told which arm it took and decides for
 * itself what an unknown means; none of them may treat it as an ordering.
 */
export function boundAtMost(
  left: ClosedBound,
  right: ClosedBound,
): boolean | null {
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left <= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left <= right;
  }
  if (isLength(left) && isLength(right)) {
    // The same occurrence denotes the same integer, so only the offsets differ.
    // Two different occurrences are two unrelated integers: no envelope can
    // settle them, and asking would be the first constraint between symbols.
    if (left.binding !== right.binding) return null;
    return left.offset <= right.offset;
  }
  if (isLength(left) && typeof right === "bigint") {
    if (LONGEST_ARRAY + left.offset <= right) return true;
    if (left.offset > right) return false;
    return null;
  }
  if (typeof left === "bigint" && isLength(right)) {
    if (left <= right.offset) return true;
    if (left > LONGEST_ARRAY + right.offset) return false;
    return null;
  }
  // A length is an integer, so this is a text bound against an int one. A
  // range's domain is checked before its bounds are, so reaching here is the
  // compiler having built a range whose bounds disagree with its domain.
  expect(false, "a range compared bounds across two domains");
}

/**
 * `-Infinity <= x` and `x <= Infinity`, spelled for `null` bounds.
 *
 * Unknown is read as "does not hold". These two decide whether one range is
 * inside another, so a false negative refuses a program and a false positive
 * accepts an unsound one; refusing is the direction that can be corrected by
 * writing the fact down.
 */
export function boundBelow(outer: Bound, inner: Bound): boolean {
  if (outer === null) return true;
  if (inner === null) return false;
  return boundAtMost(outer, inner) === true;
}

export function boundAbove(inner: Bound, outer: Bound): boolean {
  if (outer === null) return true;
  if (inner === null) return false;
  return boundAtMost(inner, outer) === true;
}

export function levelOf(type: SimpleType): Level {
  switch (type.tag) {
    case "var":
      return type.level;
    case "forall":
      return levelOf(type.body);
    case "fun":
      return Math.max(
        levelOf(type.param),
        levelOf(type.effects),
        levelOf(type.result),
      );
    case "record":
      return maxLevel([...type.fields.values()]);
    case "variant":
      return maxLevel([...type.cases.values()]);
    case "array":
      return levelOf(type.element);
    default:
      return 0;
  }
}

function maxLevel(types: readonly SimpleType[]): Level {
  let level = 0;
  for (const type of types) level = Math.max(level, levelOf(type));
  return level;
}
