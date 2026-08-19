// Erased relational summaries for compile-time function values.
//
// The first production fragment is intentionally narrow: a unary function may
// return the length of its argument plus a literal affine offset. Summaries are
// derived from the value's closure body and trusted primitive contracts, never
// from a source-level name or an unchecked annotation.

import type { Expr } from "../syntax/ast.ts";
import { type Env, lookup, type Value } from "../comptime/value.ts";

export type RelationalMeasure = "array-length" | "region-length";

/** A checked affine observation of one curried parameter. */
export interface AffineMeasureSummary {
  readonly tag: "affine-measure";
  readonly measure: RelationalMeasure;
  readonly parameter: number;
  readonly offset: bigint;
}

export type RelationalSummary = AffineMeasureSummary;

export const RELATIONAL_SUMMARY_SCHEMA = 2;

const summaries = new WeakMap<object, RelationalSummary | null>();

export function relationalSummary(value: Value): RelationalSummary | null {
  const cached = summaries.get(value);
  if (cached !== undefined) return cached;
  const active = new Set<object>();
  return derive(value, active);
}

/** Canonical local summaries included in a sealed in-process module boundary. */
export function relationalSummaryFingerprint(env: Env): string {
  const facts: {
    path: string;
    measure: RelationalMeasure;
    parameter: number;
    offset: string;
  }[] = [];
  const seen = new WeakSet<object>();
  const visit = (path: string, value: Value): void => {
    if (seen.has(value)) return;
    seen.add(value);
    const summary = relationalSummary(value);
    if (summary !== null) {
      facts.push({
        path,
        measure: summary.measure,
        parameter: summary.parameter,
        offset: summary.offset.toString(),
      });
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
  if (value.tag === "primitive" && value.applied.length === 0) {
    const measure = primitiveMeasure(value.name);
    if (measure !== null) {
      result = {
        tag: "affine-measure",
        measure,
        parameter: 0,
        offset: 0n,
      };
    }
  } else if (
    value.tag === "closure" &&
    (value.parameter.tag === "name" || value.parameter.tag === "wildcard")
  ) {
    result = resultMeasure(
      value.body,
      [value.parameter.tag === "name" ? value.parameter.name : null],
      value.env,
      active,
    );
  }

  active.delete(value);
  summaries.set(value, result);
  return result;
}

function resultMeasure(
  expression: Expr,
  parameters: readonly (string | null)[],
  env: Env,
  active: Set<object>,
): AffineMeasureSummary | null {
  if (
    expression.tag === "lambda" &&
    (expression.parameter.tag === "name" ||
      expression.parameter.tag === "wildcard")
  ) {
    return resultMeasure(
      expression.body,
      [
        ...parameters,
        expression.parameter.tag === "name"
          ? expression.parameter.name
          : null,
      ],
      env,
      active,
    );
  }
  const call = application(expression);
  if (call === null) return null;

  if (call.callee.tag === "intrinsic" && call.arguments.length === 1) {
    const measure = primitiveMeasure(call.callee.name);
    const parameter = parameters.findIndex((name) =>
      name !== null && isParameter(call.arguments[0], name)
    );
    if (measure !== null && parameter >= 0) {
      return {
        tag: "affine-measure",
        measure,
        parameter,
        offset: 0n,
      };
    }
  }

  if (
    call.callee.tag === "intrinsic" &&
    (call.callee.name === "@int.add" ||
      call.callee.name === "@int.sub") &&
    call.arguments.length === 2
  ) {
    const left = resultMeasure(call.arguments[0], parameters, env, active);
    const right = integer(call.arguments[1], env);
    if (left !== null && right !== null) {
      return {
        ...left,
        offset: call.callee.name === "@int.sub"
          ? left.offset - right
          : left.offset + right,
      };
    }
    if (call.callee.name !== "@int.add") return null;
    const reversed = resultMeasure(
      call.arguments[1],
      parameters,
      env,
      active,
    );
    const literal = integer(call.arguments[0], env);
    if (reversed === null || literal === null) return null;
    return { ...reversed, offset: reversed.offset + literal };
  }

  const callee = valueAt(call.callee, env);
  if (callee === null) return null;
  const summary = derive(callee, active);
  if (summary === null || summary.parameter >= call.arguments.length) {
    return null;
  }
  const parameter = parameters.findIndex((name) =>
    name !== null && isParameter(call.arguments[summary.parameter], name)
  );
  if (parameter < 0) return null;
  return { ...summary, parameter };
}

function primitiveMeasure(name: string): RelationalMeasure | null {
  if (name === "@array.len") return "array-length";
  if (name === "@region.length") return "region-length";
  return null;
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
