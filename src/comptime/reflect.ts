import type { Span } from "../syntax/ast.ts";
import type { Domain } from "../check/type.ts";
import { expect, fail } from "../diagnostic.ts";
import {
  bool,
  equal,
  F32X4_MASK_NAME,
  F32X4_NAME,
  I16X8_MASK_NAME,
  I16X8_NAME,
  I32X4_MASK_NAME,
  I32X4_NAME,
  I8X16_MASK_NAME,
  I8X16_NAME,
  inferredTypeOf,
  show,
  type Value,
} from "./value.ts";
import { arrayElements } from "./coerce.ts";

/**
 * `f ~ { Console }`: the row an arrow performs.
 *
 * The row lands on the innermost arrow that has none yet, which is the arrow
 * that runs once every argument has arrived — `Scene -> Frame -> () ~ { Draw }`
 * performs when it is given the frame, not when it is given the scene. That is
 * also where the checker's printer puts a row, so what a type prints as is what
 * a `sig` can be written as. A second `~` fills the next arrow out, which is
 * how `A -> B -> C ~ { Inner } ~ { Outer }` reads back as itself.
 *
 * An arrow whose chain performs everywhere already is an error rather than a
 * silent overwrite: two rows on one arrow are two claims about it, and the
 * program means only one of them.
 */
export function performs(arrow: Value, effects: Value, span: Span): Value {
  if (arrow.tag !== "arrow") {
    fail(
      "BLOT_TYPE",
      `\`~\` names what a function performs, and ${show(arrow)} is not one.`,
      span,
    );
  }
  // A row is a set, so a name written twice is written once. Keeping the
  // duplicate would make two spellings of one row two unequal type values.
  const row: Value[] = [];
  let tail: number | undefined;
  const members = arrayElements(effects, span, "`~`");
  for (const [index, effect] of members.entries()) {
    if (effect.tag === "type-variable") {
      if (tail !== undefined || index !== members.length - 1) {
        fail(
          "BLOT_TYPE",
          "an effect-row tail is written once and must be the final row member",
          span,
        );
      }
      tail = effect.id;
      continue;
    }
    if (effect.tag !== "effect") {
      fail(
        "BLOT_TYPE",
        `\`~ { … }\` lists effects, and ${show(effect)} is not one.`,
        span,
      );
    }
    if (!row.some((seen) => equal(seen, effect))) row.push(effect);
  }
  const attached = attach(arrow, row, tail);
  if (attached === null) {
    fail(
      "BLOT_TYPE",
      `${show(arrow)} already says what every one of its arrows performs.`,
      span,
    );
  }
  return attached;
}

function attach(
  arrow: Value & { tag: "arrow" },
  row: readonly Value[],
  tail?: number,
): Value | null {
  if (arrow.codomain.tag === "arrow") {
    const inner = attach(arrow.codomain, row, tail);
    if (inner !== null) return { ...arrow, codomain: inner };
  }
  if (arrow.effects.length > 0 || arrow.effectTail !== undefined) return null;
  return tail === undefined
    ? { ...arrow, effects: row }
    : { ...arrow, effects: row, effectTail: tail };
}

/** Unions are flat and duplicate-free, so `1 | 1 | 2` and `1 | 2` are one value. */
export function union(left: Value, right: Value): Value {
  const members: Value[] = [];
  const add = (value: Value): void => {
    if (value.tag === "union") {
      for (const member of value.members) add(member);
      return;
    }
    if (!members.some((existing) => equal(existing, value))) {
      members.push(value);
    }
  };
  add(left);
  add(right);
  if (members.length === 1) return members[0];
  return { tag: "union", members };
}

function members(value: Value): readonly Value[] {
  return value.tag === "union" ? value.members : [value];
}

/**
 * Set algebra on types, by *containment* rather than by equality.
 *
 * Comparing members with `equal` made `Int & 1` empty and `Int \\ 1` the whole
 * of `Int` — both silently wrong, because `1` and `Int` are different values
 * and one is inside the other. A type is a set, so the question is what it
 * contains.
 */
export function intersect(left: Value, right: Value): Value {
  const kept: Value[] = [];
  for (const member of members(left)) {
    for (const other of members(right)) {
      const meet = meetOf(member, other);
      if (meet !== null && !kept.some((seen) => equal(seen, meet))) {
        kept.push(meet);
      }
    }
  }
  if (kept.length === 0) {
    fail("BLOT_EMPTY_TYPE", "The intersection is empty.", { start: 0, end: 0 });
  }
  return kept.reduce(union);
}

/** The overlap of two ground members, or `null` when they are disjoint. */
function meetOf(left: Value, right: Value): Value | null {
  if (equal(left, right)) return left;
  // A literal inside a range is the overlap; this is the case `equal` missed.
  if (right.tag === "range" && inhabits(left, right)) return left;
  if (left.tag === "range" && inhabits(right, left)) return right;
  return null;
}

export function difference(left: Value, right: Value, span: Span): Value {
  let kept = members(left);
  for (const other of members(right)) {
    const next: Value[] = [];
    for (const member of kept) next.push(...without(member, other, span));
    kept = next;
  }
  if (kept.length === 0) {
    fail("BLOT_EMPTY_TYPE", "The difference is empty.", span);
  }
  return kept.reduce(union);
}

/**
 * One ground member minus another, as the pieces that remain.
 *
 * Removing a point from an integer range splits it, and that is exact because
 * integers are discrete: `Int \\ 1` is `..0 | 2..`. Text is dense — there is no
 * least string above `"a"` — so removing a point from a text range is refused
 * rather than approximated, which is what returning the range unchanged was.
 */
function without(member: Value, other: Value, span: Span): Value[] {
  if (equal(member, other)) return [];
  if (member.tag !== "range") return [member];
  if (!inhabits(other, member)) return [member];
  if (other.tag === "int") {
    const pieces: Value[] = [];
    const below: Value = { tag: "int", value: other.value - 1n };
    const above: Value = { tag: "int", value: other.value + 1n };
    if (
      member.low.tag === "unbounded" ||
      compare(member.low, below, span, "@type.diff") <= 0
    ) {
      pieces.push({
        tag: "range",
        low: member.low,
        high: below,
        domain: "int",
      });
    }
    if (
      member.high.tag === "unbounded" ||
      compare(above, member.high, span, "@type.diff") <= 0
    ) {
      pieces.push({
        tag: "range",
        low: above,
        high: member.high,
        domain: "int",
      });
    }
    return pieces;
  }
  fail(
    "BLOT_UNREPRESENTABLE_DIFFERENCE",
    `Removing ${show(other)} from ${
      show(member)
    } cannot be written as a type: text has no least value above a given one, ` +
      "so the result is not a union of ranges.",
    span,
  );
}

/**
 * The one primitive behind type introspection.
 *
 * Types are values, so "inspect a type" has to mean "inspect a value", and the
 * only thing the evaluator knows that a program cannot already ask is which
 * *shape of representation* it is holding. `reflect` answers exactly that and
 * nothing more: it names the case and hands back the parts. Everything built on
 * top — refinement, `Extract`, `Omit`, matching a parameterized nominal — is
 * ordinary blot over the result, because the result is an ordinary tagged value
 * that `case` already destructures.
 *
 * The cases are split by *domain* rather than lumped into one `#Literal`, so a
 * blot-side comparison can tell an integer bound from a text bound without a
 * second primitive to ask.
 */
/** Which ordered domain a range lives in: its own label, else its bounds. */
/** What `reflect` calls each domain. One tag per domain, and no default. */
const DOMAIN_TAGS: Readonly<Record<Domain, string>> = {
  int: "Int",
  float: "F64",
  float32: "F32",
  text: "Text",
};

function rangeDomain(
  value: Value & { tag: "range" },
): "int" | "text" | "float" | "float32" {
  if (value.domain !== undefined) return value.domain;
  if (value.low.tag === "text" || value.high.tag === "text") return "text";
  return "int";
}

export function reflect(value: Value): Value {
  // Transparent here too: reflecting a struct reports its storage, because
  // that is what the type is. `@type.members` asks the other question.
  if (value.tag === "extended") return reflect(value.inner);
  const tagged = (name: string, payload: Value): Value => ({
    tag: "tag",
    name,
    payload,
  });
  const bare = (name: string): Value => ({ tag: "tag", name, payload: null });
  const record = (fields: Record<string, Value>): Value => ({
    tag: "shape",
    fields: new Map(Object.entries(fields)),
  });
  switch (value.tag) {
    case "int":
      return tagged("Int", value);
    case "text":
      return tagged("Text", value);
    case "unit":
      return bare("Unit");
    case "unbounded":
      return bare("Unbounded");
    case "tag":
      return tagged(
        "Tag",
        record({
          name: { tag: "text", value: value.name },
          payload: value.payload === null
            ? bare("None")
            : tagged("Some", value.payload),
        }),
      );
    case "range": {
      // The domain travels with the bounds. Without it `Int` and `Str` are both
      // "a range from unbounded to unbounded" and blot code cannot tell them
      // apart — which made `refines (Str, Int)` answer `#True`.
      const domain = rangeDomain(value);
      return tagged(
        "Range",
        record({
          low: value.low,
          high: value.high,
          // Every domain names itself. Mapping the four onto two made
          // `refines (F64, Int)` and `refines (Int, F64)` both answer `#True`,
          // because a float and an integer reflected to the same value — the
          // same lie the `domain` field was added to stop `Str` and `Int`
          // telling.
          domain: bare(DOMAIN_TAGS[domain]),
        }),
      );
    }
    case "union":
      return tagged("Union", { tag: "array", elements: [...value.members] });
    case "shape":
      return tagged("Shape", value);
    case "array":
      return tagged("Array", value);
    case "arrow":
      return tagged(
        "Arrow",
        record({
          domain: value.domain,
          codomain: value.codomain,
          effects: {
            tag: "array",
            elements: value.effectTail === undefined
              ? [...value.effects]
              : [...value.effects, {
                tag: "type-variable",
                id: value.effectTail,
              }],
          },
          deferred: bool(value.deferred === true),
        }),
      );
    case "sealed":
      return tagged(
        "Sealed",
        record({
          name: { tag: "text", value: value.name },
          inner: value.inner,
        }),
      );
    default:
      // Closures, primitives, host functions, effects, and `F32x4`. A program
      // can call or compute with these but has no business taking them apart,
      // and saying so is more honest than inventing a case per callable kind.
      return bare("Opaque");
  }
}

/** A literal's type is the literal: `@type.of 1` is `1`, never `I32`. */
export function typeOf(value: Value): Value {
  const inferred = inferredTypeOf(value);
  if (inferred !== undefined) return inferred;
  if (value.tag === "extended") return typeOf(value.inner);
  if (value.tag === "shape") {
    return {
      tag: "shape",
      fields: new Map(
        [...value.fields].map(([name, member]) => [name, typeOf(member)]),
      ),
    };
  }
  if (value.tag === "array") {
    return { tag: "array", elements: value.elements.map(typeOf) };
  }
  if (value.tag === "tag" && value.payload !== null) {
    return { tag: "tag", name: value.name, payload: typeOf(value.payload) };
  }
  return value;
}

export function compare(
  left: Value,
  right: Value,
  span: Span,
  what: string,
): number {
  if (left.tag === "int" && right.tag === "int") {
    if (left.value < right.value) return -1;
    return left.value > right.value ? 1 : 0;
  }
  if (left.tag === "text" && right.tag === "text") {
    const leftScalars = [...left.value];
    const rightScalars = [...right.value];
    const length = Math.min(leftScalars.length, rightScalars.length);
    for (let index = 0; index < length; index += 1) {
      const leftScalar = leftScalars[index]!.codePointAt(0)!;
      const rightScalar = rightScalars[index]!.codePointAt(0)!;
      if (leftScalar < rightScalar) return -1;
      if (leftScalar > rightScalar) return 1;
    }
    if (leftScalars.length < rightScalars.length) return -1;
    if (leftScalars.length > rightScalars.length) return 1;
    return 0;
  }
  fail(
    "BLOT_TYPE",
    `${what} compares two integers or two texts, found ${show(left)} and ${
      show(right)
    }.`,
    span,
  );
}

export function ordering(sign: number): Value {
  if (sign < 0) return { tag: "tag", name: "Less", payload: null };
  if (sign > 0) return { tag: "tag", name: "Greater", payload: null };
  return { tag: "tag", name: "Equal", payload: null };
}

/** Does `value` inhabit `type`? Structural, and total over the value domain. */
export function inhabits(value: Value, type: Value): boolean {
  // Members are invisible to typing: a struct's type is its storage.
  if (type.tag === "extended") return inhabits(value, type.inner);
  if (value.tag === "extended") return inhabits(value.inner, type);
  if (type.tag === "unbounded") return true;
  if (type.tag === "union") {
    return type.members.some((member) => inhabits(value, member));
  }
  if (type.tag === "opaque-type") {
    // Nothing to compare: an opaque type is a name, so which values are in it
    // is a fact the evaluator holds rather than one it computes. `F32x4` is the
    // only one there is, and a vector is the only thing in it.
    const vectors = new Map<string, "f32" | "i32" | "i16" | "i8">(
      [
        [F32X4_NAME, "f32"],
        [I32X4_NAME, "i32"],
        [I16X8_NAME, "i16"],
        [I8X16_NAME, "i8"],
      ],
    );
    const masks = new Map<string, "f32" | "i32" | "i16" | "i8">(
      [
        [F32X4_MASK_NAME, "f32"],
        [I32X4_MASK_NAME, "i32"],
        [I16X8_MASK_NAME, "i16"],
        [I8X16_MASK_NAME, "i8"],
      ],
    );
    const vectorElement = vectors.get(type.name);
    if (vectorElement !== undefined) {
      return value.tag === "vector" && value.element === vectorElement;
    }
    const maskElement = masks.get(type.name);
    if (maskElement !== undefined) {
      return value.tag === "vector-mask" && value.element === maskElement;
    }
    expect(
      false,
      `the opaque type ${type.name} has no inhabitants the evaluator knows`,
    );
  }
  if (type.tag === "range") {
    const aboveLow = type.low.tag === "unbounded" ||
      compare(value, type.low, { start: 0, end: 0 }, "@type.range") >= 0;
    const belowHigh = type.high.tag === "unbounded" ||
      compare(value, type.high, { start: 0, end: 0 }, "@type.range") <= 0;
    return aboveLow && belowHigh;
  }
  if (type.tag === "shape" && value.tag === "shape") {
    // Width subtyping: a wider value inhabits a narrower shape type.
    for (const [name, member] of type.fields) {
      const found = value.fields.get(name);
      if (found === undefined) {
        if (!admitsOmission(member)) return false;
        continue;
      }
      if (!inhabits(found, member)) return false;
    }
    return true;
  }
  if (type.tag === "array" && value.tag === "array") {
    return value.elements.every((element) =>
      type.elements.some((m) => inhabits(element, m))
    );
  }
  if (type.tag === "tag" && value.tag === "tag") {
    if (type.name !== value.name) return false;
    if (type.payload === null) return value.payload === null;
    return value.payload !== null && inhabits(value.payload, type.payload);
  }
  return equal(value, type);
}

function admitsOmission(type: Value): boolean {
  if (type.tag === "extended") return admitsOmission(type.inner);
  if (type.tag === "unit") return true;
  if (type.tag !== "union") return false;
  return type.members.some(admitsOmission);
}
