// Pure predicate-defined integer types.
//
// This module deliberately normalizes into the existing range/union value
// domain. A predicate never reaches inference or Runtime HIR. Recognition is
// semantic: operator values are interrogated by `narrow.ts`, while this module
// proves that the predicate parameter is observed only by those operators.

import type { Expr, Pattern, Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import {
  junction,
  mirror,
  negation,
  type Ordering,
  recognise,
} from "../check/narrow.ts";
import { type Env, lookup, type Value } from "./value.ts";

interface Interval {
  readonly low: bigint | null;
  readonly high: bigint | null;
}

const MIN_I64 = -0x8000000000000000n;
const MAX_I64 = 0x7fffffffffffffffn;
const RUNTIME_INTEGER_DOMAIN: readonly Interval[] = [{
  low: MIN_I64,
  high: MAX_I64,
}];
const MAX_PREDICATE_NODES = 256;

export function refineIntegerType(
  base: Value,
  predicate: Value,
  span: Span,
): Value {
  const intervals = intersection(
    baseIntervals(base, span),
    RUNTIME_INTEGER_DOMAIN,
  );
  if (predicate.tag !== "closure" || predicate.self !== null) {
    unsupported(span, "The predicate must be a non-recursive unary function.");
  }
  const subject = patternName(predicate.parameter);
  if (subject === null) {
    unsupported(span, "The predicate parameter must be one unqualified name.");
  }
  const budget = { remaining: MAX_PREDICATE_NODES };
  const accepted = predicateIntervals(
    predicate.body,
    subject,
    predicate.env,
    span,
    budget,
  );
  const refined = intersection(intervals, accepted);
  if (refined.length === 0) {
    fail(
      "BLOT_EMPTY_REFINEMENT",
      "The predicate accepts no value from its base integer type.",
      span,
    );
  }
  return preserveExtensions(base, intervalValue(refined));
}

function preserveExtensions(base: Value, refined: Value): Value {
  if (base.tag !== "extended") return refined;
  return {
    ...base,
    inner: preserveExtensions(base.inner, refined),
  };
}

function patternName(pattern: Pattern): string | null {
  if (pattern.tag !== "name" || pattern.qualifier !== "none") return null;
  return pattern.name;
}

function predicateIntervals(
  expression: Expr,
  subject: string,
  env: Env,
  span: Span,
  budget: { remaining: number },
): readonly Interval[] {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    unsupported(
      span,
      `A predicate may contain at most ${MAX_PREDICATE_NODES} expression nodes.`,
    );
  }
  const call = application(expression);
  if (call === null) {
    unsupported(
      expression.span,
      "The predicate must be built from integer comparisons and boolean operators.",
    );
  }
  const callee = resolve(call.callee, subject, env);
  if (callee === null) {
    unsupported(
      call.callee.span,
      "This predicate function is not compile-time-known.",
    );
  }

  if (call.arguments.length === 2) {
    const shape = junction(callee);
    if (shape !== null) {
      const left = predicateIntervals(
        call.arguments[0],
        subject,
        env,
        span,
        budget,
      );
      const right = predicateIntervals(
        call.arguments[1],
        subject,
        env,
        span,
        budget,
      );
      if (shape === "and") return intersection(left, right);
      return normalize([...left, ...right]);
    }

    let answers = recognise(callee);
    if (answers !== null) {
      const left = call.arguments[0];
      const right = call.arguments[1];
      if (isSubject(left, subject)) {
        const witness = integerWitness(right, subject, env);
        if (witness === null) {
          unsupported(
            right.span,
            "A comparison witness must be a compile-time integer.",
          );
        }
        return orderingIntervals(answers, witness);
      }
      if (isSubject(right, subject)) {
        const witness = integerWitness(left, subject, env);
        if (witness === null) {
          unsupported(
            left.span,
            "A comparison witness must be a compile-time integer.",
          );
        }
        answers = mirror(answers);
        return orderingIntervals(answers, witness);
      }
    }
  }

  if (call.arguments.length === 1 && negation(callee)) {
    return complement(
      predicateIntervals(call.arguments[0], subject, env, span, budget),
    );
  }

  unsupported(
    expression.span,
    "This call is not a recognized comparison, conjunction, disjunction, or negation.",
  );
}

function application(
  expression: Expr,
): { readonly callee: Expr; readonly arguments: readonly Expr[] } | null {
  const args: Expr[] = [];
  let current = expression;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  if (args.length === 0) return null;
  return { callee: current, arguments: args };
}

function resolve(expression: Expr, subject: string, env: Env): Value | null {
  if (expression.tag === "var") {
    if (expression.name === subject) return null;
    const value = lookup(env, expression.name);
    if (value === undefined) return null;
    return value;
  }
  if (expression.tag !== "field") return null;
  const target = resolve(expression.target, subject, env);
  if (target === null) return null;
  if (target.tag === "shape") {
    const value = target.fields.get(expression.name);
    if (value === undefined) return null;
    return value;
  }
  if (target.tag === "extended") {
    const value = target.members.get(expression.name);
    if (value === undefined) return null;
    return value;
  }
  return null;
}

function isSubject(expression: Expr, subject: string): boolean {
  return expression.tag === "var" && expression.name === subject;
}

function integerWitness(
  expression: Expr,
  subject: string,
  env: Env,
): bigint | null {
  if (expression.tag === "int") return expression.value;
  if (expression.tag !== "var" || expression.name === subject) return null;
  const value = lookup(env, expression.name);
  if (value === undefined || value.tag !== "int") return null;
  return value.value;
}

function orderingIntervals(
  orderings: ReadonlySet<Ordering>,
  witness: bigint,
): readonly Interval[] {
  const pieces: Interval[] = [];
  if (orderings.has("less")) {
    pieces.push({ low: null, high: witness - 1n });
  }
  if (orderings.has("equal")) {
    pieces.push({ low: witness, high: witness });
  }
  if (orderings.has("greater")) {
    pieces.push({ low: witness + 1n, high: null });
  }
  return normalize(pieces);
}

function baseIntervals(base: Value, span: Span): readonly Interval[] {
  if (base.tag === "extended") return baseIntervals(base.inner, span);
  if (base.tag === "int") return [{ low: base.value, high: base.value }];
  if (base.tag === "union") {
    return normalize(
      base.members.flatMap((member) => baseIntervals(member, span)),
    );
  }
  if (base.tag === "range") {
    let domain = base.domain;
    if (domain === undefined) {
      domain = "int";
      if (base.low.tag === "text" || base.high.tag === "text") {
        domain = "text";
      }
    }
    if (domain !== "int") {
      unsupported(
        span,
        "The first predicate-refinement slice accepts integer bases only.",
      );
    }
    const low = bound(base.low, span);
    const high = bound(base.high, span);
    return [{ low, high }];
  }
  unsupported(span, "The refinement base must be an integer type.");
}

function bound(value: Value, span: Span): bigint | null {
  if (value.tag === "unbounded") return null;
  if (value.tag === "int") return value.value;
  unsupported(span, "An integer range has a non-integer bound.");
}

function normalize(intervals: readonly Interval[]): readonly Interval[] {
  const valid = intervals.filter((interval) =>
    interval.low === null || interval.high === null ||
    interval.low <= interval.high
  );
  const sorted = [...valid].sort((left, right) => {
    if (left.low === null) {
      if (right.low === null) return 0;
      return -1;
    }
    if (right.low === null) return 1;
    if (left.low < right.low) return -1;
    if (left.low > right.low) return 1;
    return 0;
  });
  const merged: Interval[] = [];
  for (const next of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push(next);
      continue;
    }
    const touches = previous.high === null || next.low === null ||
      next.low <= previous.high + 1n;
    if (!touches) {
      merged.push(next);
      continue;
    }
    let high = previous.high;
    if (high !== null && (next.high === null || next.high > high)) {
      high = next.high;
    }
    merged[merged.length - 1] = { low: previous.low, high };
  }
  return merged;
}

function intersection(
  left: readonly Interval[],
  right: readonly Interval[],
): readonly Interval[] {
  const overlaps: Interval[] = [];
  for (const one of left) {
    for (const other of right) {
      const low = maximumLow(one.low, other.low);
      const high = minimumHigh(one.high, other.high);
      if (low === null || high === null || low <= high) {
        overlaps.push({ low, high });
      }
    }
  }
  return normalize(overlaps);
}

function complement(intervals: readonly Interval[]): readonly Interval[] {
  const normalized = normalize(intervals);
  const pieces: Interval[] = [];
  let low: bigint | null = null;
  for (const interval of normalized) {
    if (interval.low !== null) {
      pieces.push({ low, high: interval.low - 1n });
    }
    if (interval.high === null) return normalize(pieces);
    low = interval.high + 1n;
  }
  pieces.push({ low, high: null });
  return normalize(pieces);
}

function maximumLow(left: bigint | null, right: bigint | null): bigint | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left > right) return left;
  return right;
}

function minimumHigh(left: bigint | null, right: bigint | null): bigint | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left < right) return left;
  return right;
}

function intervalValue(intervals: readonly Interval[]): Value {
  const values = intervals.map((interval): Value => {
    let low = interval.low;
    if (low === null) low = MIN_I64;
    let high = interval.high;
    if (high === null) high = MAX_I64;
    if (low === high) return { tag: "int", value: low };
    return {
      tag: "range",
      low: { tag: "int", value: low },
      high: { tag: "int", value: high },
      domain: "int",
    };
  });
  if (values.length === 1) return values[0];
  return { tag: "union", members: values };
}

function unsupported(span: Span, reason: string): never {
  fail("BLOT_REFINEMENT_PREDICATE", reason, span);
}
