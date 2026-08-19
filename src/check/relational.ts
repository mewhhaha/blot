// Erased relational summaries for compile-time function values.
//
// The first production fragment is intentionally narrow: a unary function may
// return the length of its argument plus a literal affine offset. Summaries are
// derived from the value's closure body and trusted primitive contracts, never
// from a source-level name or an unchecked annotation.

import type { Expr, Pattern } from "../syntax/ast.ts";
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

/**
 * A name-independent description of how a checked function moves erased
 * relationship evidence through ordinary data.
 *
 * These are not source types and never reach Runtime HIR. `parameter` is an
 * existential package slot at the call boundary; every other node merely
 * rebuilds or projects evidence that was already present in one of those
 * slots. Consequently a same-shaped value assembled from unrelated fields
 * carries no proof.
 */
export type RelationshipTransform =
  | { readonly tag: "parameter"; readonly parameter: number }
  | {
    readonly tag: "tuple";
    readonly elements: readonly (RelationshipTransform | null)[];
  }
  | {
    readonly tag: "record";
    readonly fields: ReadonlyMap<string, RelationshipTransform | null>;
  }
  | {
    readonly tag: "variant";
    readonly cases: ReadonlyMap<string, RelationshipTransform | null>;
  }
  | {
    readonly tag: "project";
    readonly target: RelationshipTransform;
    readonly field: string;
  }
  | {
    readonly tag: "payload";
    readonly target: RelationshipTransform;
    readonly constructor: string;
  };

export interface RelationshipSummary {
  readonly tag: "relationship";
  readonly arity: number;
  readonly result: RelationshipTransform;
}

export const RELATIONAL_SUMMARY_SCHEMA = 3;

const summaries = new WeakMap<object, RelationalSummary | null>();
const relationshipSummaries = new WeakMap<
  object,
  RelationshipSummary | null
>();

export function relationalSummary(value: Value): RelationalSummary | null {
  const cached = summaries.get(value);
  if (cached !== undefined) return cached;
  const active = new Set<object>();
  return derive(value, active);
}

export function relationshipSummary(value: Value): RelationshipSummary | null {
  const cached = relationshipSummaries.get(value);
  if (cached !== undefined) return cached;
  return deriveRelationship(value, new Set());
}

/** Canonical local summaries included in a sealed in-process module boundary. */
export function relationalSummaryFingerprint(env: Env): string {
  const facts: {
    path: string;
    measure: RelationalMeasure;
    parameter: number;
    offset: string;
  }[] = [];
  const relationships: {
    path: string;
    arity: number;
    result: unknown;
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
    const relationship = relationshipSummary(value);
    if (relationship !== null) {
      relationships.push({
        path,
        arity: relationship.arity,
        result: canonicalTransform(relationship.result),
      });
    }
    if (value.tag !== "shape") return;
    for (const [name, field] of value.fields) visit(`${path}.${name}`, field);
  };
  for (const [name, value] of env.names) visit(name, value);
  facts.sort((left, right) => left.path.localeCompare(right.path));
  relationships.sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify({
    schema: RELATIONAL_SUMMARY_SCHEMA,
    facts,
    relationships,
  });
}

function deriveRelationship(
  value: Value,
  active: Set<object>,
): RelationshipSummary | null {
  const cached = relationshipSummaries.get(value);
  if (cached !== undefined) return cached;
  if (active.has(value)) return null;
  active.add(value);

  let result: RelationshipSummary | null = null;
  if (value.tag === "closure") {
    const bindings = new Map<string, RelationshipTransform>();
    bindTransformPattern(
      value.parameter,
      { tag: "parameter", parameter: 0 },
      bindings,
    );
    result = relationshipResult(value.body, bindings, 1, value.env, active);
  }

  active.delete(value);
  relationshipSummaries.set(value, result);
  return result;
}

function relationshipResult(
  expression: Expr,
  bindings: ReadonlyMap<string, RelationshipTransform>,
  arity: number,
  env: Env,
  active: Set<object>,
): RelationshipSummary | null {
  if (expression.tag === "lambda") {
    const nested = new Map(bindings);
    bindTransformPattern(
      expression.parameter,
      { tag: "parameter", parameter: arity },
      nested,
    );
    return relationshipResult(
      expression.body,
      nested,
      arity + 1,
      env,
      active,
    );
  }
  const result = transformExpression(expression, bindings, env, active);
  if (result === null) return null;
  return { tag: "relationship", arity, result };
}

function transformExpression(
  expression: Expr,
  bindings: ReadonlyMap<string, RelationshipTransform>,
  env: Env,
  active: Set<object>,
): RelationshipTransform | null {
  if (expression.tag === "var") return bindings.get(expression.name) ?? null;
  if (expression.tag === "field") {
    const target = transformExpression(expression.target, bindings, env, active);
    if (target === null) return null;
    return { tag: "project", target, field: expression.name };
  }
  if (expression.tag === "tuple") {
    const elements = expression.elements.map((element) =>
      transformExpression(element, bindings, env, active)
    );
    if (elements.every((element) => element === null)) return null;
    return { tag: "tuple", elements };
  }
  if (expression.tag === "shape") {
    const fields = new Map<string, RelationshipTransform | null>();
    for (const member of expression.members) {
      if (member.tag !== "field") return null;
      fields.set(
        member.name,
        transformExpression(member.value, bindings, env, active),
      );
    }
    if ([...fields.values()].every((field) => field === null)) return null;
    return { tag: "record", fields };
  }
  if (expression.tag === "block") {
    const nested = new Map(bindings);
    for (const declaration of expression.declarations) {
      if (declaration.tag === "open") return null;
      const value = transformExpression(
        declaration.value,
        nested,
        env,
        active,
      );
      if (declaration.tag === "shadow") {
        if (value === null) nested.delete(declaration.name);
        else nested.set(declaration.name, value);
        continue;
      }
      bindTransformPattern(declaration.pattern, value, nested);
    }
    return transformExpression(expression.result, nested, env, active);
  }
  if (expression.tag === "if") {
    const branches = expression.branches.map((branch) =>
      transformExpression(branch.consequence, bindings, env, active)
    );
    if (expression.fallback === null) branches.push(null);
    else {
      branches.push(
        transformExpression(expression.fallback, bindings, env, active),
      );
    }
    return commonTransform(branches);
  }
  if (expression.tag === "case") {
    const target = transformExpression(expression.target, bindings, env, active);
    const branches = expression.arms.map((arm) => {
      const nested = new Map(bindings);
      bindTransformPattern(arm.pattern, target, nested);
      return transformExpression(arm.body, nested, env, active);
    });
    return commonTransform(branches);
  }
  const call = application(expression);
  if (call === null) return null;
  if (call.callee.tag === "tag" && call.arguments.length <= 1) {
    const payload = call.arguments.length === 0
      ? null
      : transformExpression(call.arguments[0], bindings, env, active);
    if (payload === null) return null;
    return {
      tag: "variant",
      cases: new Map([[call.callee.name, payload]]),
    };
  }
  if (
    call.callee.tag === "intrinsic" && call.arguments.length === 1 &&
    (call.callee.name === "@linear.own" ||
      call.callee.name === "@linear.borrow" ||
      call.callee.name === "@linear.maybe")
  ) {
    return transformExpression(call.arguments[0], bindings, env, active);
  }
  const callee = valueAt(call.callee, env);
  if (callee === null) return null;
  const summary = deriveRelationship(callee, active);
  if (summary === null || call.arguments.length !== summary.arity) return null;
  const arguments_ = call.arguments.map((argument) =>
    transformExpression(argument, bindings, env, active)
  );
  return substituteTransform(summary.result, arguments_);
}

function bindTransformPattern(
  pattern: Pattern,
  relation: RelationshipTransform | null,
  bindings: Map<string, RelationshipTransform>,
): void {
  if (pattern.tag === "name") {
    if (relation === null) bindings.delete(pattern.name);
    else bindings.set(pattern.name, relation);
    return;
  }
  if (pattern.tag === "tuple") {
    for (const [index, element] of pattern.elements.entries()) {
      bindTransformPattern(
        element,
        relation === null
          ? null
          : { tag: "project", target: relation, field: String(index) },
        bindings,
      );
    }
    return;
  }
  if (pattern.tag === "shape") {
    for (const field of pattern.fields) {
      bindTransformPattern(
        field.pattern,
        relation === null
          ? null
          : { tag: "project", target: relation, field: field.name },
        bindings,
      );
    }
    return;
  }
  if (pattern.tag === "constructor" && pattern.payload !== null) {
    bindTransformPattern(
      pattern.payload,
      relation === null
        ? null
        : {
          tag: "payload",
          target: relation,
          constructor: pattern.name,
        },
      bindings,
    );
  }
}

function substituteTransform(
  transform: RelationshipTransform,
  arguments_: readonly (RelationshipTransform | null)[],
): RelationshipTransform | null {
  if (transform.tag === "parameter") {
    return arguments_[transform.parameter] ?? null;
  }
  if (transform.tag === "project") {
    const target = substituteTransform(transform.target, arguments_);
    if (target === null) return null;
    return { ...transform, target };
  }
  if (transform.tag === "payload") {
    const target = substituteTransform(transform.target, arguments_);
    if (target === null) return null;
    return { ...transform, target };
  }
  if (transform.tag === "tuple") {
    const elements = transform.elements.map((element) =>
      element === null ? null : substituteTransform(element, arguments_)
    );
    if (elements.every((element) => element === null)) return null;
    return { tag: "tuple", elements };
  }
  const values = transform.tag === "record" ? transform.fields : transform.cases;
  const mapped = new Map<string, RelationshipTransform | null>();
  for (const [name, value] of values) {
    mapped.set(
      name,
      value === null ? null : substituteTransform(value, arguments_),
    );
  }
  if ([...mapped.values()].every((value) => value === null)) return null;
  if (transform.tag === "record") return { tag: "record", fields: mapped };
  return { tag: "variant", cases: mapped };
}

function commonTransform(
  transforms: readonly (RelationshipTransform | null)[],
): RelationshipTransform | null {
  const first = transforms[0];
  if (first === undefined || first === null) return null;
  const canonical = JSON.stringify(canonicalTransform(first));
  if (
    transforms.some((transform) =>
      transform === null ||
      JSON.stringify(canonicalTransform(transform)) !== canonical
    )
  ) return null;
  return first;
}

function canonicalTransform(transform: RelationshipTransform): unknown {
  if (transform.tag === "parameter") return ["parameter", transform.parameter];
  if (transform.tag === "project") {
    return ["project", canonicalTransform(transform.target), transform.field];
  }
  if (transform.tag === "payload") {
    return [
      "payload",
      canonicalTransform(transform.target),
      transform.constructor,
    ];
  }
  if (transform.tag === "tuple") {
    return [
      "tuple",
      transform.elements.map((element) =>
        element === null ? null : canonicalTransform(element)
      ),
    ];
  }
  const values = transform.tag === "record" ? transform.fields : transform.cases;
  return [
    transform.tag,
    [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        value === null ? null : canonicalTransform(value),
      ]),
  ];
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
