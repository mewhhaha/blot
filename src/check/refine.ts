// Refinement, narrowing, and index proofs.

import type { Expr, Pattern } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import type { Value } from "../comptime/value.ts";
import {
  complement,
  type Junction,
  junction,
  mirror,
  type Ordering,
  recognise,
  region,
} from "./narrow.ts";
import { intersect } from "./setops.ts";
import { show as showType } from "./print.ts";
import type {
  ArrayIndexProof,
  RefinementInterval,
  RefinementTerm,
} from "../core/proof.ts";
import type {
  RefinementContext,
  RefinementProposition,
  RefinementVariable,
} from "../core/refinement.ts";
import type { SimpleType, Typing } from "./type.ts";
import {
  relationshipSummary,
  type RelationshipTransform,
  relationalSummary,
} from "./relational.ts";
import {
  childTypeEnv,
  type Context,
  lookupArrayLength,
  lookupBinding,
  lookupComptime,
  lookupIntegerValue,
  lookupRelation,
  lookupRelationshipFunction,
  lookupType,
  primitiveName,
  projectedBinding,
  recordBinding,
  recordIntegerValue,
  recordRelation,
  type RelationalValue,
  type TypeEnv,
} from "./infer.ts";
export interface Spine {
  readonly callee: Expr;
  readonly args: readonly Expr[];
}

export function spine(expr: Expr): Spine | null {
  const args: Expr[] = [];
  let current = expr;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  if (args.length === 0) return null;
  return { callee: current, args };
}

/**
 * What one branch of an `if` proves about one name.
 *
 * Both types are computed, never represented: `taken` is the type `1`, not the
 * type `(1 | 2 | 3) & 1`. Nothing is written into the lattice, no `constrain`
 * call is made, and no variable bound is pushed — narrowing is a name shadow in
 * a child scope, exactly the mechanism `inferCase` already uses for an arm. That
 * is what keeps intersection out of the positive polarity and complement out of
 * both, so biunification stays where it was.
 */
interface Narrowing {
  readonly name: string;
  /** The type the name had before the branch, for recognising a no-op. */
  readonly before: SimpleType;
  readonly taken: SimpleType;
  readonly untaken: SimpleType;
  readonly takenRefinements: readonly RefinementProposition[];
  readonly untakenRefinements: readonly RefinementProposition[];
}

type ComparisonWitness = bigint | RefinementTerm;

/**
 * What `condition` proves, when the function it calls is a recognised comparison
 * of an integer against a witness.
 *
 * Nothing here knows what `==` is. `n == 1` has already become the ordinary
 * application `Eq.eq n 1`, and this reads the compile-time value bound to that
 * path — through `lookupComptime`, so a shadowed `Eq` is refused rather than
 * mistaken for the prelude's — and asks `recognise` what it computes.
 */
export function narrowing(condition: Expr, scope: TypeEnv): Narrowing | null {
  if (condition.tag !== "apply") return null;
  if (condition.fn.tag !== "apply") return null;
  const path = namePath(condition.fn.fn);
  if (path === null) return null;
  const callee = comptimeAt(path, scope);
  if (callee === null) return null;

  // `a && b` and `a || b` are ordinary applications of ordinary bindings, so
  // they are recognised by their truth table rather than by name — a shadowed
  // `Logic.and` that is not conjunction tabulates as neither and proves
  // nothing. This is the same discipline the comparisons use.
  const shape = junction(callee);
  if (shape !== null) {
    return combined(
      shape,
      narrowing(condition.fn.arg, scope),
      narrowing(condition.arg, scope),
    );
  }

  const answers = recognise(callee);
  if (answers === null) return null;

  // A witness decides what the named subject is compared against. It must name
  // one value — a compile-time integer, or one collection's length — and not
  // merely
  // have a ground type. `n == m` where `m`'s type is `1 | 2` would let the
  // untaken branch conclude `n ∉ {1, 2}`, but all the condition said is that
  // `n` differs from *this* `m`. A whole type is a sound witness for the
  // intersection and an unsound one for the complement, so neither is taken
  // unless the witness is one value. A length is one value for the same reason
  // a `const` is: the immutable value identity it names holds one array or
  // region for its whole lifetime. A name retaining such a length may itself
  // be the subject
  // when the other side is a literal; the selection below keeps that case
  // separate from comparing two independent length witnesses.
  const left = condition.fn.arg;
  const right = condition.arg;
  const leftWitness = witness(left, scope);
  const rightWitness = witness(right, scope);
  const leftSubject = comparedName(left, scope);
  const rightSubject = comparedName(right, scope);

  // A name retaining `length(array) + k` is both a stable witness and a valid
  // subject when compared with a literal. Choosing its binding identity as the
  // subject lets the equality already recorded in Phi carry the branch bound
  // back to that collection. Two retained relationships still have no subject:
  // this decidable fragment deliberately does not compare independent lengths.
  if (
    rightWitness !== null && leftSubject !== null &&
    (leftWitness === null || typeof rightWitness === "bigint")
  ) {
    return proves(leftSubject, answers, rightWitness);
  }
  if (
    leftWitness !== null && rightSubject !== null &&
    (rightWitness === null || typeof leftWitness === "bigint")
  ) {
    // `1 < n` is `n > 1`. Mirroring the three-element ordering set is a
    // bijection, so mirroring before complementing and after agree.
    return proves(rightSubject, mirror(answers), leftWitness);
  }
  return null;
}

function proves(
  subject: {
    readonly name: string;
    readonly type: SimpleType;
    readonly identity: RefinementVariable;
  },
  answers: ReadonlySet<Ordering>,
  against: ComparisonWitness,
): Narrowing | null {
  let taken = subject.type;
  let untaken = subject.type;
  if (typeof against === "bigint") {
    const takenIntersection = intersect(subject.type, region(answers, against));
    const untakenIntersection = intersect(
      subject.type,
      region(complement(answers), against),
    );
    if (
      takenIntersection.tag !== "type" ||
      untakenIntersection.tag !== "type"
    ) return null;
    taken = takenIntersection.type;
    untaken = untakenIntersection.type;
  }
  return {
    name: subject.name,
    before: subject.type,
    taken,
    untaken,
    takenRefinements: comparisonRefinements(
      subject.identity,
      answers,
      against,
    ),
    untakenRefinements: comparisonRefinements(
      subject.identity,
      complement(answers),
      against,
    ),
  };
}

function comparisonRefinements(
  subject: RefinementVariable,
  answers: ReadonlySet<Ordering>,
  against: ComparisonWitness,
): readonly RefinementProposition[] {
  const less = answers.has("less");
  const equal = answers.has("equal");
  const greater = answers.has("greater");
  if (less && equal && greater) return [];
  if (less && greater) return [];

  if (typeof against === "bigint") {
    if (less && equal) {
      return [{ tag: "at-most", variable: subject, value: against }];
    }
    if (equal && greater) {
      return [{ tag: "at-least", variable: subject, value: against }];
    }
    if (less) {
      return [{ tag: "at-most", variable: subject, value: against - 1n }];
    }
    if (greater) {
      return [{ tag: "at-least", variable: subject, value: against + 1n }];
    }
    if (equal) {
      return [
        { tag: "at-least", variable: subject, value: against },
        { tag: "at-most", variable: subject, value: against },
      ];
    }
    return [];
  }

  const related = against;
  if (related.tag === "literal") {
    return comparisonRefinements(subject, answers, related.value);
  }
  if (less && equal) {
    return [{
      tag: "difference-at-most",
      left: subject,
      right: related.identity,
      offset: related.offset,
    }];
  }
  if (equal && greater) {
    return [{
      tag: "difference-at-most",
      left: related.identity,
      right: subject,
      offset: -related.offset,
    }];
  }
  if (less) {
    return [{
      tag: "difference-at-most",
      left: subject,
      right: related.identity,
      offset: related.offset - 1n,
    }];
  }
  if (greater) {
    return [{
      tag: "difference-at-most",
      left: related.identity,
      right: subject,
      offset: -related.offset - 1n,
    }];
  }
  if (equal) {
    return [{
      tag: "equal-offset",
      left: subject,
      right: related.identity,
      offset: related.offset,
    }];
  }
  return [];
}

/**
 * What `a && b` or `a || b` proves, from what each side proves.
 *
 * Only when both sides speak about the *same* name: a `Narrowing` carries one,
 * and two names would need two scopes.
 *
 * One side of each junction proves nothing, and it is the side De Morgan turns
 * into a union. `not (a && b)` is `not a || not b` — a value failing the
 * conjunction may fail either half, so the untaken branch learns nothing and
 * keeps the type it had. `a || b` is the mirror: its taken branch learns
 * nothing, and its untaken branch learns both.
 */
function combined(
  shape: Junction,
  left: Narrowing | null,
  right: Narrowing | null,
): Narrowing | null {
  if (left === null || right === null) return null;
  if (left.name !== right.name) return null;

  if (shape === "and") {
    const taken = intersect(left.taken, right.taken);
    if (taken.tag !== "type") return null;
    return {
      name: left.name,
      before: left.before,
      taken: taken.type,
      untaken: left.before,
      takenRefinements: [
        ...left.takenRefinements,
        ...right.takenRefinements,
      ],
      untakenRefinements: [],
    };
  }
  const untaken = intersect(left.untaken, right.untaken);
  if (untaken.tag !== "type") return null;
  return {
    name: left.name,
    before: left.before,
    taken: left.before,
    untaken: untaken.type,
    takenRefinements: [],
    untakenRefinements: [
      ...left.untakenRefinements,
      ...right.untakenRefinements,
    ],
  };
}

/** The branch's scope, carrying what it proved. */
export function proven(
  scope: TypeEnv,
  proof: Narrowing | null,
  side: "taken" | "untaken",
): TypeEnv {
  if (proof === null) return scope;
  let narrowed = proof.taken;
  let refinements = proof.takenRefinements;
  if (side === "untaken") narrowed = proof.untaken;
  if (side === "untaken") refinements = proof.untakenRefinements;
  // An empty intersection means the branch cannot be reached. Reporting that is
  // a separate diagnostic; installing `⊥` here would instead make every use of
  // the name inside it check against nothing.
  if (narrowed.tag === "bottom") return scope;
  // Built once per branch, and only when it says something new: `constrain`
  // memoises on object identity, so a fresh copy of an unchanged type would
  // quietly defeat the cache.
  if (sameGround(narrowed, proof.before) && refinements.length === 0) {
    return scope;
  }
  const inner = childTypeEnv(scope);
  if (!sameGround(narrowed, proof.before)) {
    const identity = lookupBinding(scope, proof.name);
    inner.names.set(proof.name, narrowed);
    if (identity !== null) recordBinding(inner, proof.name, identity);
  }
  for (const refinement of refinements) {
    if (!inner.refinements.assume(refinement)) {
      throw new Error(
        `branch refinement for \`${proof.name}\` is inconsistent`,
      );
    }
  }
  return inner;
}

/** A name whose type is already a ground set of integers — the `sig` case. */
function comparedName(
  expr: Expr,
  scope: TypeEnv,
): {
  readonly name: string;
  readonly type: SimpleType;
  readonly identity: RefinementVariable;
} | null {
  if (expr.tag !== "var") return null;
  const type = groundIntType(lookupType(scope, expr.name));
  if (type === null) return null;
  const identity = lookupBinding(scope, expr.name);
  if (identity === null) return null;
  return { name: expr.name, type, identity };
}

function groundIntType(
  typing: Typing | undefined,
  seen = new Set<number>(),
): SimpleType | null {
  if (typing === undefined) return null;
  if (typing.tag === "scheme") return groundIntType(typing.body, seen);
  if (typing.tag === "var") {
    if (seen.has(typing.id)) return null;
    seen.add(typing.id);
    for (const bound of [...typing.lower, ...typing.upper]) {
      const ground = groundIntType(bound, seen);
      if (ground !== null) return ground;
    }
    return null;
  }
  if (typing.tag === "range") {
    if (typing.domain !== "int") return null;
    return typing;
  }
  if (typing.tag === "union") {
    for (const member of typing.members) {
      if (member.tag !== "range") return null;
      if (member.domain !== "int") return null;
    }
    return typing;
  }
  return null;
}

/** `Eq.eq` as `["Eq", "eq"]`. Anything computed is not a path. */
function namePath(expr: Expr): readonly string[] | null {
  if (expr.tag === "var") return [expr.name];
  if (expr.tag !== "field") return null;
  const prefix = namePath(expr.target);
  if (prefix === null) return null;
  return [...prefix, expr.name];
}

function comptimeAt(
  path: readonly string[],
  scope: TypeEnv,
): Value | null {
  let value = lookupComptime(scope, path[0]);
  for (const name of path.slice(1)) {
    if (value === null) return null;
    if (value.tag !== "shape") return null;
    const found = value.fields.get(name);
    if (found === undefined) return null;
    value = found;
  }
  return value;
}

/**
 * A witness reached without running any user code.
 *
 * `-9` is `Num.negate 9`, an application, and evaluating it would mean calling
 * whatever `Num.negate` happens to name. So it is not a witness, and `if n == -9`
 * narrows nothing.
 */
export function comptimeInt(expr: Expr, scope: TypeEnv): bigint | null {
  if (expr.tag === "int") return expr.value;
  const path = namePath(expr);
  if (path === null) return null;
  const value = comptimeAt(path, scope);
  if (value === null) return null;
  if (value.tag !== "int") return null;
  return value.value;
}

/**
 * How many elements an array expression has, when that is decided by the source
 * rather than by running the program.
 *
 * A literal or compile-time array contributes a number. A runtime binding may
 * instead carry the length relationship recorded when it was initialized.
 */
function recordedArrayLength(
  expr: Expr,
  scope: TypeEnv,
): RefinementTerm | null {
  if (expr.tag === "array") {
    if (expr.elements.some((item) => item.spread)) return null;
    return { tag: "literal", value: BigInt(expr.elements.length) };
  }
  const path = namePath(expr);
  if (path === null) return null;
  const value = comptimeAt(path, scope);
  if (value !== null && value.tag === "array") {
    return { tag: "literal", value: BigInt(value.elements.length) };
  }
  // A runtime binding reaches the relationship recorded beside its type.
  if (path.length !== 1) return null;
  return lookupArrayLength(scope, path[0]);
}

/**
 * How many elements an array expression holds, as a refinement term.
 *
 * A number when the source decided it, and otherwise `length(b)` for the
 * immutable value identity the name denotes. The term names an integer the
 * compiler cannot see, which is exactly enough: an index compared against it
 * and an index used to read the same array share one value whatever it is.
 *
 * The number comes first because it says strictly more. `let xs = [1, 2, 3]`
 * gives every comparison against `@array.len xs` the witness `3`, so the
 * ordinary literal machinery decides it and no identity term is needed.
 *
 * A plain name carries the identity, and transparent aliases and immutable
 * field projections keep it. Call results are refused because no stable value
 * identity for them is in scope.
 */
export function arrayLength(expr: Expr, scope: TypeEnv): RefinementTerm | null {
  const decided = recordedArrayLength(expr, scope);
  if (decided !== null) return decided;
  if (expr.tag === "var") {
    const identity = lookupBinding(scope, expr.name);
    if (identity === null) return null;
    const nonnegative: RefinementProposition = {
      tag: "at-least",
      variable: identity,
      value: 0n,
    };
    if (
      !scope.refinements.entails(nonnegative) &&
      !scope.refinements.assume(nonnegative)
    ) {
      throw new Error(`array length for \`${expr.name}\` is inconsistent`);
    }
    return { tag: "variable", identity, offset: 0n };
  }
  if (expr.tag === "field") {
    const identity = projectedBinding(expr, scope);
    if (identity === null) return null;
    const nonnegative: RefinementProposition = {
      tag: "at-least",
      variable: identity,
      value: 0n,
    };
    if (
      !scope.refinements.entails(nonnegative) &&
      !scope.refinements.assume(nonnegative)
    ) {
      throw new Error(`array length for field .${expr.name} is inconsistent`);
    }
    return { tag: "variable", identity, offset: 0n };
  }
  const head = spine(expr);
  if (head === null || head.callee.tag !== "intrinsic") return null;
  if (
    (head.callee.name === "@linear.own" ||
      head.callee.name === "@linear.borrow" ||
      head.callee.name === "@linear.maybe") && head.args.length === 1
  ) {
    return arrayLength(head.args[0], scope);
  }
  if (head.callee.name === "@array.set" && head.args.length === 3) {
    return arrayLength(head.args[0], scope);
  }
  if (head.callee.name !== "@array.push" || head.args.length !== 2) return null;
  const previous = arrayLength(head.args[0], scope);
  if (previous === null) return null;
  return shiftRefinementTerm(previous, 1n);
}

/**
 * The value a comparison narrows against.
 *
 * A compile-time integer, the length of an array a stable name holds, or a
 * binding that retained that length or an affine shift of it. All are reached
 * without running user code — `@array.len` is compiler-owned, total, and pure.
 *
 * A comparison of one length against another has two witnesses and no subject,
 * so `narrowing` refuses it before either is used.
 */
export function witness(expr: Expr, scope: TypeEnv): ComparisonWitness | null {
  const literal = comptimeInt(expr, scope);
  if (literal !== null) return literal;
  if (expr.tag === "var") {
    const related = lookupIntegerValue(scope, expr.name);
    if (related !== null) return comparisonWitness(related);
  }
  const head = spine(expr);
  if (head === null) return null;
  if (
    head.callee.tag === "intrinsic" &&
    head.callee.name === "@array.len" && head.args.length === 1
  ) {
    const length = arrayLength(head.args[0], scope);
    if (length === null) return null;
    return comparisonWitness(length);
  }
  if (
    head.callee.tag === "intrinsic" &&
    (head.callee.name === "@int.add" || head.callee.name === "@int.sub") &&
    head.args.length === 2
  ) {
    const left = witness(head.args[0], scope);
    const right = witness(head.args[1], scope);
    if (
      left !== null && typeof left !== "bigint" && typeof right === "bigint"
    ) {
      let offset = right;
      if (head.callee.name === "@int.sub") offset = -right;
      return shiftRefinementTerm(left, offset);
    }
    if (
      head.callee.name === "@int.add" && typeof left === "bigint" &&
      right !== null && typeof right !== "bigint"
    ) return shiftRefinementTerm(right, left);
  }
  const path = namePath(head.callee);
  if (path === null) return null;
  const value = comptimeAt(path, scope);
  if (value === null) return null;
  const summary = relationalSummary(value);
  if (summary === null || summary.parameter >= head.args.length) return null;
  const argument = head.args[summary.parameter];
  const length = summary.measure === "array-length"
    ? arrayLength(argument, scope)
    : regionLength(argument, scope);
  if (length === null) return null;
  return comparisonWitness(shiftRefinementTerm(length, summary.offset));
}

/** Length of a private region, tracked in Phi without exposing its Store. */
export function regionLength(
  expr: Expr,
  scope: TypeEnv,
): RefinementTerm | null {
  const path = namePath(expr);
  if (path !== null) {
    const value = comptimeAt(path, scope);
    if (value !== null && value.tag === "region-array") {
      return { tag: "literal", value: value.end - value.start };
    }
  }
  if (expr.tag === "var") {
    const identity = lookupBinding(scope, expr.name);
    if (identity === null) return null;
    const nonnegative: RefinementProposition = {
      tag: "at-least",
      variable: identity,
      value: 0n,
    };
    if (
      !scope.refinements.entails(nonnegative) &&
      !scope.refinements.assume(nonnegative)
    ) {
      throw new Error(`region length for \`${expr.name}\` is inconsistent`);
    }
    return { tag: "variable", identity, offset: 0n };
  }
  const head = spine(expr);
  if (head === null || head.callee.tag !== "intrinsic") return null;
  if (
    (head.callee.name === "@linear.own" ||
      head.callee.name === "@linear.borrow" ||
      head.callee.name === "@linear.maybe") && head.args.length === 1
  ) {
    return regionLength(head.args[0], scope);
  }
  return null;
}

function comparisonWitness(term: RefinementTerm): ComparisonWitness {
  if (term.tag === "literal") return term.value;
  return term;
}

function shiftRefinementTerm(
  term: RefinementTerm,
  offset: bigint,
): RefinementTerm {
  if (term.tag === "literal") {
    return { tag: "literal", value: term.value + offset };
  }
  return { ...term, offset: term.offset + offset };
}

export function recordExpressionRelation(expr: Expr, context: Context): void {
  if (expr.tag === "var") {
    const related = lookupRelation(context.types, expr.name);
    if (related !== null) context.expressionRelations.set(expr, related);
    return;
  }
  if (expr.tag === "field") {
    const target = expressionRelation(expr.target, context);
    if (target === null) return;
    const projected = projectRelation(target, expr.name);
    if (projected !== null) {
      context.expressionRelations.set(expr, projected);
    }
    return;
  }
  if (expr.tag === "tuple") {
    const elements = expr.elements.map((element) =>
      expressionRelation(element, context)
    );
    if (elements.some((element) => element !== null)) {
      context.expressionRelations.set(expr, { tag: "tuple", elements });
    }
    return;
  }
  if (expr.tag === "shape") {
    const fields = new Map<string, RelationalValue | null>();
    for (const member of expr.members) {
      const relation = expressionRelation(member.value, context);
      if (member.tag === "field") {
        fields.set(member.name, relation);
        continue;
      }
      if (relation?.tag !== "record") {
        // An opaque spread may overwrite any earlier field. Forgetting is the
        // only sound structural transform until its field set is known.
        fields.clear();
        continue;
      }
      for (const [name, value] of relation.fields) fields.set(name, value);
    }
    if ([...fields.values()].some((field) => field !== null)) {
      context.expressionRelations.set(expr, { tag: "record", fields });
    }
    return;
  }
  if (expr.tag !== "apply") return;
  const application = spine(expr);
  if (application === null) return;
  if (application.callee.tag === "tag" && application.args.length === 1) {
    const payload = expressionRelation(application.args[0], context);
    if (payload !== null) {
      context.expressionRelations.set(expr, {
        tag: "variant",
        cases: new Map([[application.callee.name, payload]]),
      });
    }
    return;
  }
  const primitive = primitiveName(application.callee, context);
  if (primitive === "@array.indexed" && application.args.length === 1) {
    const length = arrayLength(application.args[0], context.types);
    if (length !== null) {
      context.expressionRelations.set(expr, {
        tag: "indexed-iterator",
        length,
      });
    }
    return;
  }
  if (
    application.callee.tag !== "field" ||
    application.callee.name !== "step" || application.args.length !== 1
  ) {
    const callee = relationshipValue(application.callee, context.types);
    if (callee === null) return;
    const summary = relationshipSummary(callee);
    if (summary === null || summary.arity !== application.args.length) return;
    const relation = instantiateRelationship(
      summary.result,
      application.args.map((argument) =>
        expressionRelation(argument, context)
      ),
    );
    if (relation !== null) context.expressionRelations.set(expr, relation);
    return;
  }
  const iterator = expressionRelation(
    application.callee.target,
    context,
  );
  if (iterator?.tag === "indexed-iterator") {
    const index = refinementExpression(application.args[0], context.types);
    if (index === null) return;
    context.expressionRelations.set(expr, {
      tag: "variant",
      cases: new Map([
        ["None", null],
        ["Some", {
          tag: "tuple",
          elements: [
            {
              tag: "tuple",
              elements: [
                { tag: "index", value: index, length: iterator.length },
                null,
              ],
            },
            null,
          ],
        }],
      ]),
    });
    return;
  }
  const callee = relationshipValue(application.callee, context.types);
  if (callee === null) return;
  const summary = relationshipSummary(callee);
  if (summary === null || summary.arity !== application.args.length) return;
  const relation = instantiateRelationship(
    summary.result,
    application.args.map((argument) => expressionRelation(argument, context)),
  );
  if (relation !== null) context.expressionRelations.set(expr, relation);
}

export function expressionRelation(
  expr: Expr,
  context: Context,
): RelationalValue | null {
  const recorded = context.expressionRelations.get(expr);
  if (recorded !== undefined) return recorded;
  if (expr.tag === "var") return lookupRelation(context.types, expr.name);
  if (expr.tag !== "field") return null;
  const target = expressionRelation(expr.target, context);
  if (target === null) return null;
  return projectRelation(target, expr.name);
}

function projectRelation(
  relation: RelationalValue,
  field: string,
): RelationalValue | null {
  if (relation.tag === "tuple" && /^\d+$/.test(field)) {
    return relation.elements[Number(field)] ?? null;
  }
  if (relation.tag === "record") return relation.fields.get(field) ?? null;
  return null;
}

function relationshipValue(expr: Expr, scope: TypeEnv): Value | null {
  const path = namePath(expr);
  if (path === null) return null;
  let value = lookupComptime(scope, path[0]);
  if (value === null) value = lookupRelationshipFunction(scope, path[0]);
  for (const name of path.slice(1)) {
    if (value === null) return null;
    let found: Value | undefined;
    if (value.tag === "shape") found = value.fields.get(name);
    if (value.tag === "extended") found = value.members.get(name);
    if (found === undefined) return null;
    value = found;
  }
  return value;
}

function instantiateRelationship(
  transform: RelationshipTransform,
  arguments_: readonly (RelationalValue | null)[],
): RelationalValue | null {
  if (transform.tag === "parameter") {
    return arguments_[transform.parameter] ?? null;
  }
  if (transform.tag === "project") {
    const target = instantiateRelationship(transform.target, arguments_);
    if (target === null) return null;
    return projectRelation(target, transform.field);
  }
  if (transform.tag === "payload") {
    const target = instantiateRelationship(transform.target, arguments_);
    if (target?.tag !== "variant") return null;
    return target.cases.get(transform.constructor) ?? null;
  }
  if (transform.tag === "tuple") {
    const elements = transform.elements.map((element) =>
      element === null ? null : instantiateRelationship(element, arguments_)
    );
    if (elements.every((element) => element === null)) return null;
    return { tag: "tuple", elements };
  }
  const source = transform.tag === "record" ? transform.fields : transform.cases;
  const values = new Map<string, RelationalValue | null>();
  for (const [name, value] of source) {
    values.set(
      name,
      value === null ? null : instantiateRelationship(value, arguments_),
    );
  }
  if ([...values.values()].every((value) => value === null)) return null;
  if (transform.tag === "record") return { tag: "record", fields: values };
  return { tag: "variant", cases: values };
}

export function bindPatternRelation(
  pattern: Pattern,
  relation: RelationalValue | null,
  scope: TypeEnv,
): void {
  if (relation === null) return;
  if (pattern.tag === "name") {
    recordRelation(scope, pattern.name, relation);
    if (relation.tag !== "index") return;
    recordIntegerValue(scope, pattern.name, relation.value);
    const identity = lookupBinding(scope, pattern.name);
    if (identity === null) {
      throw new Error(`proved index \`${pattern.name}\` has no identity`);
    }
    if (
      !scope.refinements.assume({
        tag: "at-least",
        variable: identity,
        value: 0n,
      })
    ) throw new Error(`proved index \`${pattern.name}\` is negative`);
    let upper: RefinementProposition;
    if (relation.length.tag === "literal") {
      upper = {
        tag: "at-most",
        variable: identity,
        value: relation.length.value - 1n,
      };
    } else {
      upper = {
        tag: "difference-at-most",
        left: identity,
        right: relation.length.identity,
        offset: relation.length.offset - 1n,
      };
    }
    if (!scope.refinements.assume(upper)) {
      throw new Error(`proved index \`${pattern.name}\` is out of bounds`);
    }
    return;
  }
  if (pattern.tag === "tuple" && relation.tag === "tuple") {
    for (const [index, element] of pattern.elements.entries()) {
      let elementRelation = relation.elements[index];
      if (elementRelation === undefined) elementRelation = null;
      bindPatternRelation(element, elementRelation, scope);
    }
    return;
  }
  if (pattern.tag === "shape" && relation.tag === "record") {
    for (const field of pattern.fields) {
      bindPatternRelation(
        field.pattern,
        relation.fields.get(field.name) ?? null,
        scope,
      );
    }
    return;
  }
  if (
    pattern.tag === "constructor" && pattern.payload !== null &&
    relation.tag === "variant"
  ) {
    let payload = relation.cases.get(pattern.name);
    if (payload === undefined) payload = null;
    bindPatternRelation(
      pattern.payload,
      payload,
      scope,
    );
  }
}

function showRefinementTerm(term: RefinementTerm, array: Expr): string {
  if (term.tag === "literal") return term.value.toString();
  let subject = `array#${term.identity}`;
  if (array.tag === "var") subject = array.name;
  const length = `len ${subject}`;
  if (term.offset === 0n) return length;
  if (term.offset < 0n) return `${length} - ${-term.offset}`;
  return `${length} + ${term.offset}`;
}

/** Direct access is admitted only when every possible index is in bounds. */
export function requireProvenIndex(
  expr: Expr,
  array: Expr,
  index: Expr,
  scope: TypeEnv,
): ArrayIndexProof {
  const length = arrayLength(array, scope);
  const indices = indexSet(index, scope);
  if (length === null) {
    fail(
      "BLOT_UNPROVEN_INDEX",
      "Direct array access needs an index proved against this array's length. Guard the call with `0 <= index` and `index < Array.length values`.",
      expr.span,
    );
  }
  const indexTerm = refinementExpression(index, scope);
  if (
    indexTerm !== null &&
    refinementAtLeastZero(indexTerm, scope.refinements) &&
    refinementLessThan(indexTerm, length, scope.refinements)
  ) {
    return {
      tag: "array-index",
      assumptions: scope.refinements.assumptions(),
      length,
      intervals: [{ low: indexTerm, high: indexTerm }],
    };
  }
  if (
    indexTerm !== null &&
    refinementAtLeast(indexTerm, length, scope.refinements)
  ) {
    if (indexTerm.tag === "literal" && length.tag === "literal") {
      fail(
        "BLOT_OUT_OF_BOUNDS",
        `Index ${indexTerm.value} is outside an array of ${length.value}.`,
        expr.span,
      );
    }
    fail(
      "BLOT_OUT_OF_BOUNDS",
      `Index ${showRefinementTerm(indexTerm, index)} is at or past ${
        showRefinementTerm(length, array)
      }.`,
      expr.span,
    );
  }
  if (indices === null) {
    fail(
      "BLOT_UNPROVEN_INDEX",
      "Direct array access needs an index proved against this array's length. Guard the call with `0 <= index` and `index < Array.length values`.",
      expr.span,
    );
  }
  const intervals = refinementIntervals(indices);
  if (intervals === null) {
    fail(
      "BLOT_UNPROVEN_INDEX",
      "Direct array access needs a closed integer interval or a relational proof for its index.",
      expr.span,
    );
  }
  const proved = intervals.every((interval) =>
    refinementAtLeastZero(interval.low, scope.refinements) &&
    refinementLessThan(interval.high, length, scope.refinements)
  );
  if (proved) {
    return {
      tag: "array-index",
      assumptions: scope.refinements.assumptions(),
      length,
      intervals,
    };
  }
  if (
    length.tag === "literal" &&
    intervals.every((interval) =>
      interval.high.tag === "literal" && interval.low.tag === "literal" &&
      (interval.high.value < 0n || interval.low.value >= length.value)
    )
  ) {
    fail(
      "BLOT_OUT_OF_BOUNDS",
      `Index ${showType(indices)} is outside an array of ${length.value}.`,
      expr.span,
    );
  }
  fail(
    "BLOT_UNPROVEN_INDEX",
    `Index ${showType(indices)} is not proved below ${
      showRefinementTerm(length, array)
    }. Guard the call with \`0 <= index\` and \`index < Array.length values\`.`,
    expr.span,
  );
}

function refinementIntervals(
  type: SimpleType,
): readonly RefinementInterval[] | null {
  if (type.tag === "range" && type.domain === "int") {
    if (type.low === null || type.high === null) return null;
    if (typeof type.low === "string" || typeof type.high === "string") {
      return null;
    }
    return [{
      low: { tag: "literal", value: type.low },
      high: { tag: "literal", value: type.high },
    }];
  }
  if (type.tag !== "union") return null;
  const intervals: RefinementInterval[] = [];
  for (const member of type.members) {
    const lowered = refinementIntervals(member);
    if (lowered === null) return null;
    intervals.push(...lowered);
  }
  return intervals;
}

function refinementExpression(
  expression: Expr,
  scope: TypeEnv,
): RefinementTerm | null {
  const known = witness(expression, scope);
  if (typeof known === "bigint") return { tag: "literal", value: known };
  if (known !== null) return known;
  if (expression.tag !== "var") return null;
  const identity = lookupBinding(scope, expression.name);
  if (identity === null) return null;
  return { tag: "variable", identity, offset: 0n };
}

function refinementAtLeastZero(
  term: RefinementTerm,
  refinements: RefinementContext,
): boolean {
  if (term.tag === "literal") return term.value >= 0n;
  return refinements.entails({
    tag: "at-least",
    variable: term.identity,
    value: -term.offset,
  });
}

function refinementLessThan(
  left: RefinementTerm,
  right: RefinementTerm,
  refinements: RefinementContext,
): boolean {
  if (left.tag === "literal" && right.tag === "literal") {
    return left.value < right.value;
  }
  if (left.tag === "variable" && right.tag === "literal") {
    return refinements.entails({
      tag: "at-most",
      variable: left.identity,
      value: right.value - left.offset - 1n,
    });
  }
  if (left.tag === "literal" && right.tag === "variable") {
    return refinements.entails({
      tag: "at-least",
      variable: right.identity,
      value: left.value - right.offset + 1n,
    });
  }
  if (left.tag === "literal" || right.tag === "literal") return false;
  return refinements.entails({
    tag: "difference-at-most",
    left: left.identity,
    right: right.identity,
    offset: right.offset - left.offset - 1n,
  });
}

function refinementAtLeast(
  left: RefinementTerm,
  right: RefinementTerm,
  refinements: RefinementContext,
): boolean {
  if (left.tag === "literal" && right.tag === "literal") {
    return left.value >= right.value;
  }
  if (left.tag === "variable" && right.tag === "literal") {
    return refinements.entails({
      tag: "at-least",
      variable: left.identity,
      value: right.value - left.offset,
    });
  }
  if (left.tag === "literal" && right.tag === "variable") {
    return refinements.entails({
      tag: "at-most",
      variable: right.identity,
      value: left.value - right.offset,
    });
  }
  if (left.tag === "literal" || right.tag === "literal") return false;
  return refinements.entails({
    tag: "difference-at-most",
    left: right.identity,
    right: left.identity,
    offset: left.offset - right.offset,
  });
}

/**
 * The integers an index expression can produce, when the source decides them.
 *
 * A compile-time integer, an exact retained relationship, or a name whose type
 * is already a ground set of integers — one a `sig` gave it or a branch proved.
 * Other computed expressions are refused because inferring them here would
 * infer them twice.
 */
function indexSet(expr: Expr, scope: TypeEnv): SimpleType | null {
  const value = witness(expr, scope);
  if (typeof value === "bigint") {
    return { tag: "range", domain: "int", low: value, high: value };
  }
  if (expr.tag !== "var") return null;
  const typing = lookupType(scope, expr.name);
  if (typing === undefined) return null;
  if (typing.tag !== "scheme") return groundIntType(typing);
  return groundIntType(typing.body);
}

/**
 * Whether two ground types are the same set, written the same way.
 *
 * Literal range bounds are primitive values, so exact equality is sufficient.
 */
function sameGround(left: SimpleType, right: SimpleType): boolean {
  if (left.tag === "range" && right.tag === "range") {
    return left.domain === right.domain && left.low === right.low &&
      left.high === right.high;
  }
  if (left.tag === "union" && right.tag === "union") {
    if (left.members.length !== right.members.length) return false;
    return left.members.every((member, index) =>
      sameGround(member, right.members[index])
    );
  }
  return false;
}
