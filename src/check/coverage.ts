// Which values a ground type enumerates.
//
// Types in blot are sets, and a literal is a range whose bounds coincide — so
// `1 | 2 | 3` is a three-element set and the question "do these arms cover it"
// is ordinary set membership. This module answers only the half of that
// question the lattice can answer exactly: it enumerates a type, or it says it
// cannot.
//
// It says it cannot far more often than it says it can, and that is the point.
// `Int` is a set too, but not one an arm list can exhaust, and a variable is
// not a set yet at all. A `case` over either of those carries no coverage
// requirement rather than a guessed one.
//
// Only two shapes enumerate: a singleton `range`, and a `union` whose members
// are all singleton ranges. A `union` is the one constructor inference never
// builds for itself — it arrives already computed from a type expression (see
// type.ts) — so when one reaches here it *is* the set the program declared.
//
// This is deliberately not `@type.diff` or `Reflect.exclude`. Those compare
// members with the comptime `equal`, which on a range compares exact bounds, so
// `@type.diff Int 1` answers `Int` and silently readmits the value it was asked
// to remove. A coverage check that silently readmits a value is worse than no
// coverage check.

import type { Pattern } from "../syntax/ast.ts";
import { type Domain, isLength, type SimpleType } from "./type.ts";
import { showRange } from "./print.ts";

/** One inhabitant of a ground literal type. */
export interface Literal {
  readonly domain: Domain;
  readonly value: bigint | string;
}

/**
 * The inhabitants of `type`, or `null` when it does not enumerate.
 *
 * `null` is "cannot say", never "no inhabitants": an empty set is `[]`.
 */
/** How many integers are worth listing to decide coverage. */
const LISTABLE = 256n;

function enumerate(type: SimpleType): readonly Literal[] | null {
  if (type.tag === "range") {
    if (type.low === null || type.high === null) return null;
    // A length is not a literal. `len xs..len xs` is a singleton, but nothing
    // here knows which integer it holds, so it names no inhabitant. The guard
    // sits above the singleton shortcut rather than below it: the shortcut's
    // test is `===`, and an interned symbol is `===` itself.
    if (isLength(type.low) || isLength(type.high)) return null;
    if (type.low === type.high) {
      return [{ domain: type.domain, value: type.low }];
    }
    // A bounded *integer* range is a finite set, so arms can cover it: two
    // comparisons narrow `i` to `1..2` and `case i of 1 => …, 2 => …` is then
    // complete. Text is dense — `"a".."b"` holds infinitely many strings — so
    // only integers enumerate.
    if (type.domain !== "int") return null;
    if (typeof type.low !== "bigint" || typeof type.high !== "bigint") {
      return null;
    }
    const span = type.high - type.low;
    // Past this, listing is not how a program should be covering the range,
    // and building the list would cost more than the check is worth.
    if (span >= LISTABLE) return null;
    const values: Literal[] = [];
    for (let value = type.low; value <= type.high; value += 1n) {
      values.push({ domain: "int", value });
    }
    return values;
  }
  if (type.tag !== "union") return null;

  const members: Literal[] = [];
  for (const member of type.members) {
    const one = enumerate(member);
    // One member that does not enumerate makes the whole union unenumerable.
    // Widening to the members that do would claim a coverage the type does not
    // have, and the missing member is exactly the value that would trap.
    if (one === null) return null;
    members.push(...one);
  }
  return members;
}

/** Two literals are the same value only within the same domain. */
function sameLiteral(left: Literal, right: Literal): boolean {
  return left.domain === right.domain && left.value === right.value;
}

/**
 * The members of `target` that no arm accepts, or `null` when no requirement
 * can be stated.
 *
 * `null` when the target does not enumerate, and `null` when any arm does not:
 * an arm whose pattern is a constructor, a shape, or a tuple says nothing about
 * a literal set, and a partial answer here would name members a later arm may
 * well cover.
 */
export function uncovered(
  target: SimpleType,
  arms: readonly SimpleType[],
): readonly Literal[] | null {
  const members = enumerate(target);
  if (members === null) return null;
  if (arms.length === 0) return null;

  const covered: Literal[] = [];
  for (const arm of arms) {
    const one = enumerate(arm);
    if (one === null) return null;
    covered.push(...one);
  }

  return members.filter(
    (member) => !covered.some((literal) => sameLiteral(literal, member)),
  );
}

/**
 * Whether a scalar type is too large for literal arms to cover.
 *
 * A range with an open end holds infinitely many values, so no finite set of
 * literal arms can be exhaustive over it and `uncovered` has nothing to list.
 * Reading that silence as "covered" is how `case n of 1 => …` over `Int` was
 * accepted and then trapped at run time. Saying so instead lets the program
 * choose: widen the type, add the missing arms, or write the `_` arm and say
 * with `@panic` why reaching it is impossible.
 */
export function unlistable(type: SimpleType): boolean {
  // No literal names an inhabitant of an opaque type, so no finite list of arms
  // exhausts one. `F32x4` answered this as a range with two open ends until it
  // stopped being a range; the answer is the same and the reason is now the
  // type itself rather than its bounds.
  if (type.tag === "opaque") return true;
  if (type.tag === "range") {
    // Only a set no finite arm list could exhaust. A bounded integer range is
    // finite and `enumerate` lists it, so it is not unlistable — saying it was
    // rejected `case i of 1 => …, 2 => …` over the `1..2` a pair of
    // comparisons had just proved.
    if (type.low === null || type.high === null) return true;
    // Above the singleton shortcut for the same reason, and with the opposite
    // answer: a singleton whose one value the compiler cannot name is a set no
    // arm list can be shown to exhaust, so a `case` over it still owes a `_`.
    if (isLength(type.low) || isLength(type.high)) return true;
    if (type.low === type.high) return false;
    if (type.domain !== "int") return true;
    if (typeof type.low !== "bigint" || typeof type.high !== "bigint") {
      return true;
    }
    return type.high - type.low >= LISTABLE;
  }
  if (type.tag !== "union") return false;
  return type.members.some(unlistable);
}

/** `1 | 2`, spelled the way a `sig` would spell it. */
export function showLiterals(literals: readonly Literal[]): string {
  return literals
    .map((literal) => showRange(literal.domain, literal.value, literal.value))
    .join(" | ");
}

// --- tuple arms --------------------------------------------------------------
//
// A `case` whose arms are tuple patterns is a pattern matrix: one row per arm,
// one column per element. It is exhaustive when the rows cover the cross-product
// of the columns, and neither half of the scalar machinery above can say that —
// `uncovered` compares a target against arms of the same shape, and a tuple is
// not a set of literals.
//
// So this is Maranget's usefulness check, cut down to the one question `case`
// asks. A column is decided by a *signature*: the complete set of heads a value
// in that column can have. When the arms name every head in the signature the
// matrix splits, one sub-matrix per head; when they do not, the arms that are
// missing a head can only be reached through a row that is a wildcard there, so
// the check continues on those rows alone. That second rule is what makes a
// column of an unlistable type — `Int`, `F64`, a shape — coverable by a
// wildcard and by nothing else.
//
// Where a column has no signature the answer is to refuse. An exhaustive
// program refused here is a diagnostic its author answers with a `_` arm; a
// non-exhaustive one accepted is a `BLOT_NO_MATCH` at run time, which is the
// bug this exists to stop.

/**
 * A column of the matrix: what a value in it can be, and whether the arms are
 * allowed to be what closes that.
 *
 * `closable` is true only for the columns of the scrutinee's own tuple. Those
 * are the ones `inferCase` writes a merged constructor set back onto, so an arm
 * list that names `#Some` and `#None` there really does make the column that
 * union — the same rule a one-column `case` lives by. Nothing constrains a
 * column *inside* a payload or a nested tuple, so the arms there prove nothing
 * about it and only a declared type can say what it holds.
 */
interface Column {
  readonly type: SimpleType | null;
  readonly closable: boolean;
}

type Head =
  | { readonly kind: "any" }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly payload: Pattern | null;
  }
  | { readonly kind: "literal"; readonly literal: Literal }
  | { readonly kind: "tuple"; readonly elements: readonly Pattern[] }
  // A shape or an array pattern. Refutable, and nothing here knows what set it
  // would have to be one of, so it can only reach the default matrix — where it
  // is dropped, because it is not a wildcard.
  | { readonly kind: "opaque" };

type Signature =
  | {
    readonly kind: "constructors";
    readonly cases: ReadonlyMap<string, Column>;
  }
  | { readonly kind: "literals"; readonly values: readonly Literal[] }
  | { readonly kind: "tuple"; readonly columns: readonly Column[] };

/** Stands in for the columns a wildcard row contributes when a head is split. */
const ANY: Pattern = { tag: "wildcard", span: { start: 0, end: 0 } };

/**
 * A combination of columns no arm of a tuple `case` accepts, printed the way the
 * arms are written, or `null` when the arms leave nothing uncovered.
 *
 * `arms` must be the refutable arms' patterns and every one of them a tuple;
 * `inferCase` is what checks that, because a `case` mixing tuple arms with
 * anything else is not a matrix and gets no requirement from here.
 */
export function uncoveredTuple(
  target: SimpleType,
  arms: readonly Pattern[],
): string | null {
  const witness = missingRow(
    arms.map((pattern) => [pattern]),
    [{ type: target, closable: false }],
    0,
  );
  if (witness === null) return null;
  return witness[0];
}

/**
 * One value per column that no row of `rows` matches, or `null` when the rows
 * match every combination.
 *
 * `depth` is only how the scrutinee's own columns are told apart from the ones
 * under them; see `Column.closable`.
 */
function missingRow(
  rows: readonly (readonly Pattern[])[],
  columns: readonly Column[],
  depth: number,
): string[] | null {
  if (columns.length === 0) {
    if (rows.length > 0) return null;
    return [];
  }
  const rest = columns.slice(1);
  const heads = rows.map((row) => headOf(row[0]));
  const signature = signatureOf(columns[0], heads, depth === 0);

  if (signature === null) return defaulted(rows, heads, rest, depth, "_");

  if (signature.kind === "tuple") {
    const arity = signature.columns.length;
    const specialized: Pattern[][] = [];
    for (const [index, row] of rows.entries()) {
      const head = heads[index];
      if (head.kind === "any") {
        specialized.push([...Array(arity).fill(ANY), ...row.slice(1)]);
        continue;
      }
      if (head.kind !== "tuple") continue;
      specialized.push([...head.elements, ...row.slice(1)]);
    }
    const witness = missingRow(
      specialized,
      [...signature.columns, ...rest],
      depth + 1,
    );
    if (witness === null) return null;
    return [
      `(${witness.slice(0, arity).join(", ")})`,
      ...witness.slice(arity),
    ];
  }

  if (signature.kind === "constructors") {
    const named = new Set(
      heads.filter((head) => head.kind === "constructor")
        .map((head) => head.kind === "constructor" ? head.name : ""),
    );
    const missing = [...signature.cases.keys()].filter((name) =>
      !named.has(name)
    );
    // A head the arms never name is only reachable through a row that matches
    // everything in this column, so what remains to check is those rows.
    if (missing.length > 0) {
      return defaulted(rows, heads, rest, depth, `#${missing[0]}`);
    }
    for (const [name, payload] of signature.cases) {
      const specialized: Pattern[][] = [];
      for (const [index, row] of rows.entries()) {
        const head = heads[index];
        if (head.kind === "any") {
          specialized.push([ANY, ...row.slice(1)]);
          continue;
        }
        if (head.kind !== "constructor" || head.name !== name) continue;
        specialized.push([head.payload ?? ANY, ...row.slice(1)]);
      }
      const witness = missingRow(
        specialized,
        [payload, ...rest],
        depth + 1,
      );
      if (witness === null) continue;
      const carried = witness[0] === "_" ? "" : ` ${witness[0]}`;
      return [`#${name}${carried}`, ...witness.slice(1)];
    }
    return null;
  }

  const matched = heads.flatMap((head) =>
    head.kind === "literal" ? [head.literal] : []
  );
  const missing = signature.values.filter((value) =>
    !matched.some((literal) => sameLiteral(literal, value))
  );
  if (missing.length > 0) {
    return defaulted(rows, heads, rest, depth, showLiterals([missing[0]]));
  }
  for (const value of signature.values) {
    const specialized: Pattern[][] = [];
    for (const [index, row] of rows.entries()) {
      const head = heads[index];
      if (head.kind === "any") {
        specialized.push([...row.slice(1)]);
        continue;
      }
      if (head.kind !== "literal" || !sameLiteral(head.literal, value)) {
        continue;
      }
      specialized.push([...row.slice(1)]);
    }
    const witness = missingRow(specialized, rest, depth + 1);
    if (witness === null) continue;
    return [showLiterals([value]), ...witness];
  }
  return null;
}

/** The rows that match every value of the first column, with it dropped. */
function defaulted(
  rows: readonly (readonly Pattern[])[],
  heads: readonly Head[],
  rest: readonly Column[],
  depth: number,
  shown: string,
): string[] | null {
  const remaining = rows
    .filter((_, index) => heads[index].kind === "any")
    .map((row) => row.slice(1));
  const witness = missingRow(remaining, rest, depth + 1);
  if (witness === null) return null;
  return [shown, ...witness];
}

function headOf(pattern: Pattern): Head {
  switch (pattern.tag) {
    // A `unit` pattern is refutable in spelling only: `()` is the one value of
    // its type, so an arm carrying it can never be the one that fails.
    case "name":
    case "wildcard":
    case "unit":
      return { kind: "any" };
    case "constructor":
      return {
        kind: "constructor",
        name: pattern.name,
        payload: pattern.payload,
      };
    case "int":
      return {
        kind: "literal",
        literal: { domain: "int", value: pattern.value },
      };
    case "text":
      return {
        kind: "literal",
        literal: { domain: "text", value: pattern.value },
      };
    case "tuple":
      return { kind: "tuple", elements: pattern.elements };
    // A float pattern names one float and its type holds every float, so it can
    // never close a column. `opaque` is what says that: it reaches the default
    // matrix and is dropped there.
    default:
      return { kind: "opaque" };
  }
}

/**
 * The complete set of heads a value of `column` can have, or `null` when it has
 * none this can state.
 */
function signatureOf(
  column: Column,
  heads: readonly Head[],
  scrutinee: boolean,
): Signature | null {
  const present = heads.filter((head) => head.kind !== "any");
  if (present.length === 0) return null;

  // A tuple is the only head its type has, so the arms settle it: there is
  // nothing else a value in that column could be.
  if (present.every((head) => head.kind === "tuple")) {
    const arity = present[0].kind === "tuple" ? present[0].elements.length : 0;
    const sized = present.every((head) =>
      head.kind === "tuple" && head.elements.length === arity
    );
    if (!sized) return null;
    // `scrutinee` says this column *is* the target of the `case`, so the
    // columns being split out of it are the ones `inferCase` constrains — the
    // only ones an arm list is allowed to close.
    return {
      kind: "tuple",
      columns: tupleColumns(column.type, arity, scrutinee),
    };
  }

  const declared = declaredSignature(column.type, new Set());
  if (declared !== null) return declared;

  // Nothing declared this column, so the arms are what close it — but only
  // where `inferCase` turns that into a constraint on the scrutinee, and only
  // for constructors, because a literal set is covered by membership and stays
  // non-constraining.
  if (!column.closable) return null;
  if (!present.every((head) => head.kind === "constructor")) return null;
  const cases = new Map<string, Column>();
  for (const head of present) {
    if (head.kind !== "constructor") continue;
    cases.set(head.name, { type: null, closable: false });
  }
  return { kind: "constructors", cases };
}

/** The columns of a tuple type, when one reached this position. */
function tupleColumns(
  type: SimpleType | null,
  arity: number,
  closable: boolean,
): readonly Column[] {
  const declared = declaredSignature(type, new Set());
  if (
    declared !== null && declared.kind === "tuple" &&
    declared.columns.length === arity
  ) {
    return declared.columns.map((each) => ({ ...each, closable }));
  }
  return Array.from({ length: arity }, () => ({ type: null, closable }));
}

/**
 * What a *type* says a column holds.
 *
 * A variable is followed through its upper bounds: they are what the program
 * demanded of the scrutinee, and a value is a member of every one of them, so
 * reading one can only name heads the arms may have to cover. Lower bounds are
 * the other direction — what happened to flow in so far — and a column believed
 * to be only that would let an arm list look complete for want of a call site.
 */
function declaredSignature(
  type: SimpleType | null,
  seen: Set<number>,
): Signature | null {
  if (type === null) return null;
  if (type.tag === "variant") {
    // An open variant is "these, and possibly others", which is no complete set.
    if (type.open) return null;
    const cases = new Map<string, Column>();
    for (const [name, payload] of type.cases) {
      cases.set(name, { type: payload, closable: false });
    }
    return { kind: "constructors", cases };
  }
  if (type.tag === "range" || type.tag === "union") {
    const values = enumerate(type);
    if (values === null) return null;
    return { kind: "literals", values };
  }
  if (type.tag === "record") {
    const columns: Column[] = [];
    for (let index = 0; index < type.fields.size; index += 1) {
      const found = type.fields.get(String(index));
      // A record whose names are not `0..n-1` is a shape rather than a tuple,
      // and a shape has no positional columns to split.
      if (found === undefined) return null;
      columns.push({ type: found, closable: false });
    }
    if (columns.length === 0) return null;
    return { kind: "tuple", columns };
  }
  if (type.tag === "var" && !seen.has(type.id)) {
    seen.add(type.id);
    for (const bound of type.upper) {
      const found = declaredSignature(bound, seen);
      if (found !== null) return found;
    }
  }
  return null;
}
