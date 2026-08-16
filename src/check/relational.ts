// Erased relational summaries for compile-time function values.
//
// The first production fragment is intentionally narrow: a unary function may
// return the length of its argument plus a literal affine offset. Summaries are
// derived from the value's closure body and trusted primitive contracts, never
// from a source-level name or an unchecked annotation.

import type { Expr } from "../syntax/ast.ts";
import { type Env, lookup, type Value } from "../comptime/value.ts";

export interface ArrayLengthSummary {
  readonly tag: "array-length";
  readonly parameter: 0;
  readonly offset: bigint;
}

export type RelationalSummary = ArrayLengthSummary;

export const RELATIONAL_SUMMARY_SCHEMA = 1;

const summaries = new WeakMap<object, RelationalSummary | null>();

export function relationalSummary(value: Value): RelationalSummary | null {
  const cached = summaries.get(value);
  if (cached !== undefined) return cached;
  const active = new Set<object>();
  return derive(value, active);
}

/** Canonical local summaries included in a sealed in-process module boundary. */
export function relationalSummaryFingerprint(env: Env): string {
  const facts: { path: string; offset: string }[] = [];
  const seen = new WeakSet<object>();
  const visit = (path: string, value: Value): void => {
    if (seen.has(value)) return;
    seen.add(value);
    const summary = relationalSummary(value);
    if (summary !== null && summary.tag === "array-length") {
      facts.push({ path, offset: summary.offset.toString() });
    }
    if (value.tag !== "shape") return;
    for (const [name, field] of value.fields) visit(`${path}.${name}`, field);
  };
  for (const [name, value] of env.names) visit(name, value);
  facts.sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({ schema: RELATIONAL_SUMMARY_SCHEMA, facts });
}

function derive(
  value: Value,
  active: Set<object>,
): RelationalSummary | null {
  const cached = summaries.get(value);
  if (cached !== undefined) return cached;
  if (active.has(value)) return null;
  active.add(value);

  let result: RelationalSummary | null = null;
  if (
    value.tag === "primitive" && value.name === "@array.len" &&
    value.applied.length === 0
  ) {
    result = { tag: "array-length", parameter: 0, offset: 0n };
  } else if (value.tag === "closure" && value.parameter.tag === "name") {
    const offset = resultOffset(
      value.body,
      value.parameter.name,
      value.env,
      active,
    );
    if (offset !== null) {
      result = { tag: "array-length", parameter: 0, offset };
    }
  }

  active.delete(value);
  summaries.set(value, result);
  return result;
}

function resultOffset(
  expression: Expr,
  parameter: string,
  env: Env,
  active: Set<object>,
): bigint | null {
  const call = application(expression);
  if (call === null) return null;

  if (
    call.callee.tag === "intrinsic" &&
    call.callee.name === "@array.len" && call.arguments.length === 1 &&
    isParameter(call.arguments[0], parameter)
  ) return 0n;

  if (
    call.callee.tag === "intrinsic" &&
    (call.callee.name === "@int.add" ||
      call.callee.name === "@int.sub") &&
    call.arguments.length === 2
  ) {
    const left = resultOffset(call.arguments[0], parameter, env, active);
    const right = integer(call.arguments[1], env);
    if (left !== null && right !== null) {
      if (call.callee.name === "@int.sub") return left - right;
      return left + right;
    }
    if (call.callee.name !== "@int.add") return null;
    const reversed = resultOffset(call.arguments[1], parameter, env, active);
    const literal = integer(call.arguments[0], env);
    if (reversed === null || literal === null) return null;
    return reversed + literal;
  }

  if (
    call.arguments.length !== 1 || !isParameter(call.arguments[0], parameter)
  ) {
    return null;
  }
  const callee = valueAt(call.callee, env);
  if (callee === null) return null;
  const summary = derive(callee, active);
  if (summary === null || summary.tag !== "array-length") return null;
  return summary.offset;
}

function isParameter(expression: Expr, parameter: string): boolean {
  if (expression.tag === "var") return expression.name === parameter;
  const call = application(expression);
  if (
    call === null || call.callee.tag !== "intrinsic" ||
    call.arguments.length !== 1
  ) return false;
  if (
    call.callee.name !== "@linear.borrow" &&
    call.callee.name !== "@linear.own" &&
    call.callee.name !== "@linear.maybe"
  ) return false;
  return isParameter(call.arguments[0], parameter);
}

function integer(expression: Expr, env: Env): bigint | null {
  if (expression.tag === "int") return expression.value;
  const value = valueAt(expression, env);
  if (value === null || value.tag !== "int") return null;
  return value.value;
}

function valueAt(expression: Expr, env: Env): Value | null {
  const path = namePath(expression);
  if (path === null) return null;
  let value = lookup(env, path[0]);
  for (const name of path.slice(1)) {
    if (value === undefined || value.tag !== "shape") return null;
    value = value.fields.get(name);
  }
  if (value === undefined) return null;
  return value;
}

function namePath(expression: Expr): readonly string[] | null {
  if (expression.tag === "var") return [expression.name];
  if (expression.tag !== "field") return null;
  const prefix = namePath(expression.target);
  if (prefix === null) return null;
  return [...prefix, expression.name];
}

function application(expression: Expr): {
  readonly callee: Expr;
  readonly arguments: readonly Expr[];
} | null {
  const args: Expr[] = [];
  let current = expression;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  if (args.length === 0) return null;
  return { callee: current, arguments: args };
}
