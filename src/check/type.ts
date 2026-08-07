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
import {
  F32X4_MASK_NAME,
  F32X4_NAME,
  I16X8_MASK_NAME,
  I16X8_NAME,
  I32X4_MASK_NAME,
  I32X4_NAME,
  I8X16_MASK_NAME,
  I8X16_NAME,
} from "../comptime/value.ts";

export type Level = number;

/** `null` is an open end: the domain is unbounded in that direction. */
export type Bound = bigint | string | null;

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

/**
 * Evidence about why an inference variable cannot authorize residual work.
 *
 * This is deliberately not a field of `Variable`: availability is a phase
 * judgment, not a member of the algebraic-subtyping lattice. Copies retain the
 * evidence explicitly through `freshVar`, while ordinary constraints continue
 * to see an ordinary inference variable.
 */
export type VariableEvidence = "reflection" | "dynamic-shape";

const variableEvidence = new WeakMap<Variable, VariableEvidence>();

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
  /** Compiler-private mutable interval over one array Store. */
  | { readonly tag: "region"; readonly element: SimpleType }
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

export interface InferenceIdentityCheckpoint {
  readonly nextVariable: number;
  readonly nextRigid: number;
}

export function checkpointInferenceIdentities(): InferenceIdentityCheckpoint {
  return { nextVariable: nextId, nextRigid: nextRigidId };
}

export function restoreInferenceIdentities(
  checkpoint: InferenceIdentityCheckpoint,
): void {
  nextId = checkpoint.nextVariable;
  nextRigidId = checkpoint.nextRigid;
}

export function freshVar(
  level: Level,
  evidence?: VariableEvidence,
): Variable {
  nextId += 1;
  const variable: Variable = {
    tag: "var",
    id: nextId,
    level,
    lower: [],
    upper: [],
  };
  if (evidence !== undefined) variableEvidence.set(variable, evidence);
  return variable;
}

export function evidenceOf(variable: Variable): VariableEvidence | null {
  const evidence = variableEvidence.get(variable);
  if (evidence === undefined) return null;
  return evidence;
}

export function freshRigid(): RigidVariable {
  nextRigidId += 1;
  return { tag: "rigid", id: nextRigidId };
}

export const UNIT: SimpleType = { tag: "unit" };
export const TOP: SimpleType = { tag: "top" };
export const BOTTOM: SimpleType = { tag: "bottom" };
export const PURE: SimpleType = { tag: "effects", labels: new Set() };
export const I64_LOW = -0x8000000000000000n;
export const I64_HIGH = 0x7fffffffffffffffn;

export function intLiteral(value: bigint): SimpleType {
  return { tag: "range", domain: "int", low: value, high: value };
}

export function textLiteral(value: string): SimpleType {
  return { tag: "range", domain: "text", low: value, high: value };
}

export const INT: SimpleType = {
  tag: "range",
  domain: "int",
  low: I64_LOW,
  high: I64_HIGH,
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
export const I32X4: SimpleType = { tag: "opaque", name: I32X4_NAME };
export const I32X4_MASK: SimpleType = { tag: "opaque", name: I32X4_MASK_NAME };
export const I16X8: SimpleType = { tag: "opaque", name: I16X8_NAME };
export const I16X8_MASK: SimpleType = { tag: "opaque", name: I16X8_MASK_NAME };
export const I8X16: SimpleType = { tag: "opaque", name: I8X16_NAME };
export const I8X16_MASK: SimpleType = { tag: "opaque", name: I8X16_MASK_NAME };

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

export function shiftBound(bound: ClosedBound, delta: bigint): ClosedBound {
  if (typeof bound === "bigint") return bound + delta;
  expect(false, "a text bound was stepped");
}

/** `left <= right` within one scalar domain. */
export function boundAtMost(
  left: ClosedBound,
  right: ClosedBound,
): boolean {
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left <= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left <= right;
  }
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
    case "region":
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
