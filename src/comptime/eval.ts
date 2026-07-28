// The evaluator.
//
// blot needs one of these regardless — types are values, so `struct` and every
// type constructor run at compile time — so it is also the runtime until the
// gpufuck backend lands. One evaluator, one semantics, no drift between what
// `comptime` computes and what the program does.
//
// It is written as a generator so that performing an effect is a `yield` and a
// handler is a driver loop. That gives real one-shot continuations rather than
// an approximation: `resume` is affine and calling it twice is an error, not a
// convention.

import type { Decl, Expr, Module, Pattern, Span } from "../syntax/ast.ts";
import { expect, fail } from "../diagnostic.ts";
import {
  childEnv,
  type Env,
  equal,
  lookup,
  show,
  tupleOf,
  UNIT,
  type Value,
} from "./value.ts";
import { makeEffect, PRIMITIVE_VALUES, PRIMITIVES } from "./primitives.ts";

export interface Perform {
  readonly effectId: number;
  readonly effectName: string;
  readonly operation: string;
  readonly argument: Value;
  readonly span: Span;
}

export type Eval = Generator<Perform, Value, Value>;

/** Modules resolved before evaluation begins; `@import` never touches the disk. */
export type Imports = ReadonlyMap<string, Value>;

interface Runtime {
  readonly imports: Imports;
}

export function* evaluate(expr: Expr, env: Env, runtime: Runtime): Eval {
  switch (expr.tag) {
    case "int":
      return { tag: "int", value: expr.value };
    case "text":
      return { tag: "text", value: expr.value };
    case "unit":
      return UNIT;
    case "tag":
      return { tag: "tag", name: expr.name, payload: null };

    case "var": {
      const found = lookup(env, expr.name);
      if (found === undefined) {
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return found;
    }

    case "intrinsic": {
      const constant = PRIMITIVE_VALUES.get(expr.name);
      if (constant !== undefined) return constant;
      const primitive = PRIMITIVES.get(expr.name);
      if (primitive !== undefined) {
        return {
          tag: "primitive",
          name: expr.name,
          arity: primitive.arity,
          applied: [],
        };
      }
      if (SPECIAL.has(expr.name)) {
        return {
          tag: "primitive",
          name: expr.name,
          arity: SPECIAL.get(expr.name)!,
          applied: [],
        };
      }
      fail(
        "BLOT_UNKNOWN_PRIMITIVE",
        `\`${expr.name}\` is not a primitive.`,
        expr.span,
      );
      break;
    }

    case "apply": {
      const fn = yield* evaluate(expr.fn, env, runtime);
      const argument = yield* evaluate(expr.arg, env, runtime);
      return yield* apply(fn, argument, expr.span, runtime);
    }

    case "field": {
      const target = yield* evaluate(expr.target, env, runtime);
      return project(target, expr.name, expr.span);
    }

    case "lambda":
      return {
        tag: "closure",
        parameter: expr.parameter,
        body: expr.body,
        env,
        self: null,
      };

    case "rec":
      // `rec` is meaningful only on a named binding, because the name it makes
      // visible is that binding's own. Recursion then reads like ordinary
      // recursion rather than through a reserved self-reference.
      fail(
        "BLOT_MISPLACED_REC",
        "`rec` marks a named binding, as in `const go = rec (x => ... go ... );`.",
        expr.span,
      );
      break;

    case "comptime":
      // Everything already runs at compile time; the marker becomes meaningful
      // once there is a runtime stage to distinguish it from.
      return yield* evaluate(expr.body, env, runtime);

    case "tuple": {
      const elements: Value[] = [];
      for (const element of expr.elements) {
        elements.push(yield* evaluate(element, env, runtime));
      }
      return tupleOf(elements);
    }

    case "array": {
      const elements: Value[] = [];
      for (const element of expr.elements) {
        const value = yield* evaluate(element.value, env, runtime);
        if (!element.spread) {
          elements.push(value);
          continue;
        }
        if (value.tag !== "array") {
          fail(
            "BLOT_TYPE",
            `\`...\` spreads an array, found ${show(value)}.`,
            expr.span,
          );
        }
        elements.push(...value.elements);
      }
      return { tag: "array", elements };
    }

    case "shape": {
      const fields = new Map<string, Value>();
      for (const member of expr.members) {
        const value = yield* evaluate(member.value, env, runtime);
        if (member.tag === "field") {
          fields.set(member.name, value);
          continue;
        }
        if (value.tag !== "shape") {
          fail(
            "BLOT_TYPE",
            `\`...\` spreads a shape, found ${show(value)}.`,
            expr.span,
          );
        }
        for (const [name, inner] of value.fields) fields.set(name, inner);
      }
      return { tag: "shape", fields };
    }

    case "if": {
      for (const branch of expr.branches) {
        const condition = yield* evaluate(branch.condition, env, runtime);
        if (truth(condition, branch.condition.span)) {
          return yield* evaluate(branch.consequence, env, runtime);
        }
      }
      if (expr.fallback === null) {
        fail(
          "BLOT_NO_BRANCH",
          "No branch matched and there is no `else`.",
          expr.span,
        );
      }
      return yield* evaluate(expr.fallback, env, runtime);
    }

    case "case": {
      const target = yield* evaluate(expr.target, env, runtime);
      for (const arm of expr.arms) {
        const scope = childEnv(env);
        if (match(arm.pattern, target, scope)) {
          return yield* evaluate(arm.body, scope, runtime);
        }
      }
      fail(
        "BLOT_NO_MATCH",
        `No arm matched ${show(target)}.`,
        expr.span,
      );
      break;
    }

    case "block": {
      const scope = childEnv(env);
      yield* runDeclarations(expr.declarations, scope, runtime);
      return yield* evaluate(expr.result, scope, runtime);
    }
  }
  expect(false, `unhandled expression ${(expr as Expr).tag}`);
}

function* runDeclarations(
  declarations: readonly Decl[],
  scope: Env,
  runtime: Runtime,
): Generator<Perform, void, Value> {
  for (const declaration of declarations) {
    if (declaration.tag === "shadow") {
      const value = yield* evaluate(declaration.value, scope, runtime);
      scope.names.set(declaration.name, value);
      continue;
    }
    // `sig` constrains inference; it binds nothing and computes nothing here.
    if (declaration.kind === "sig") continue;
    const value = yield* bind(
      declaration.pattern,
      declaration.value,
      scope,
      runtime,
    );
    if (!match(declaration.pattern, value, scope)) {
      fail(
        "BLOT_BINDING_MISMATCH",
        `${show(value)} does not match this pattern.`,
        declaration.span,
      );
    }
  }
}

/**
 * Evaluates a binding's value, giving `rec` its meaning: the binding's own name
 * becomes visible inside the lambda.
 */
function* bind(
  pattern: Pattern,
  value: Expr,
  scope: Env,
  runtime: Runtime,
): Eval {
  if (value.tag !== "rec") {
    const result = yield* evaluate(value, scope, runtime);
    // `@effect` cannot know what it will be called, so the binding names it.
    // The identity is preserved: this is a rename, not a second effect.
    if (
      result.tag === "effect" && result.name === "Effect" &&
      pattern.tag === "name"
    ) {
      return { ...result, name: pattern.name };
    }
    return result;
  }
  if (pattern.tag !== "name") {
    fail(
      "BLOT_MISPLACED_REC",
      "`rec` marks a binding to a single name.",
      value.span,
    );
  }
  const inner = yield* evaluate(value.lambda, scope, runtime);
  if (inner.tag !== "closure") {
    fail("BLOT_TYPE", "`rec` applies to a lambda.", value.span);
  }
  return { ...inner, self: pattern.name };
}

function truth(value: Value, span: Span): boolean {
  if (value.tag === "tag" && value.payload === null) {
    if (value.name === "True") return true;
    if (value.name === "False") return false;
  }
  fail(
    "BLOT_TYPE",
    `A condition is \`#True\` or \`#False\`, found ${show(value)}.`,
    span,
  );
}

function project(target: Value, name: string, span: Span): Value {
  if (target.tag === "shape") {
    const found = target.fields.get(name);
    if (found === undefined) {
      fail("BLOT_NO_FIELD", `No field \`${name}\` on ${show(target)}.`, span);
    }
    return found;
  }
  // Reaching into an effect names one of its operations. Performing it is then
  // an ordinary call, which is why blot needs no `perform` syntax.
  if (target.tag === "effect") {
    if (!target.operations.has(name)) {
      fail(
        "BLOT_NO_OPERATION",
        `Effect \`${target.name}\` has no operation \`${name}\`.`,
        span,
      );
    }
    return { tag: "operation", effect: target, name };
  }
  fail("BLOT_NO_FIELD", `${show(target)} has no fields.`, span);
}

export function* apply(
  fn: Value,
  argument: Value,
  span: Span,
  runtime: Runtime,
): Eval {
  if (fn.tag === "closure") {
    const scope = childEnv(fn.env);
    if (fn.self !== null) scope.names.set(fn.self, fn);
    if (!match(fn.parameter, argument, scope)) {
      fail(
        "BLOT_ARGUMENT_MISMATCH",
        `${show(argument)} does not match this parameter.`,
        span,
      );
    }
    const inner = fn.imports === undefined ? runtime : { imports: fn.imports };
    return yield* evaluate(fn.body, scope, inner);
  }

  if (fn.tag === "tag") {
    if (fn.payload !== null) {
      fail("BLOT_TYPE", `\`#${fn.name}\` already carries a payload.`, span);
    }
    return { tag: "tag", name: fn.name, payload: argument };
  }

  if (fn.tag === "operation") {
    expect(fn.effect.tag === "effect", "operation without an effect");
    return yield {
      effectId: fn.effect.id,
      effectName: fn.effect.name,
      operation: fn.name,
      argument,
      span,
    };
  }

  if (fn.tag === "continuation") {
    if (fn.state.used) {
      fail(
        "BLOT_RESUME_TWICE",
        "`resume` is one-shot and has already been called.",
        span,
      );
    }
    fn.state.used = true;
    return yield* (fn.resume(argument) as Eval);
  }

  if (fn.tag === "native") {
    const applied = [...fn.applied, argument];
    if (applied.length < fn.arity) return { ...fn, applied };
    return fn.run(applied);
  }

  if (fn.tag === "primitive") {
    const applied = [...fn.applied, argument];
    if (applied.length < fn.arity) {
      return { tag: "primitive", name: fn.name, arity: fn.arity, applied };
    }
    return yield* runPrimitive(fn.name, applied, span, runtime);
  }

  fail("BLOT_NOT_CALLABLE", `${show(fn)} is not a function.`, span);
}

/** Primitives that need the evaluator itself rather than a pure value function. */
const SPECIAL: ReadonlyMap<string, number> = new Map([
  ["@effect", 1],
  ["@handle", 2],
  ["@import", 1],
]);

function* runPrimitive(
  name: string,
  args: readonly Value[],
  span: Span,
  runtime: Runtime,
): Eval {
  if (name === "@effect") {
    const shape = args[0];
    if (shape.tag !== "shape") {
      fail("BLOT_TYPE", "`@effect` takes a shape of operation types.", span);
    }
    return makeEffect("Effect", shape.fields);
  }

  if (name === "@import") {
    const path = args[0];
    if (path.tag !== "text") {
      fail("BLOT_TYPE", "`@import` takes a text path.", span);
    }
    const module = runtime.imports.get(path.value);
    if (module === undefined) {
      fail(
        "BLOT_UNRESOLVED_IMPORT",
        `\`${path.value}\` was not resolved.`,
        span,
      );
    }
    return module;
  }

  if (name === "@handle") {
    return yield* handle(args[0], args[1], span, runtime);
  }

  const primitive = PRIMITIVES.get(name);
  expect(primitive !== undefined, `missing primitive ${name}`);
  return primitive.run(args, span);
}

/**
 * A deep, one-shot handler.
 *
 * `handler` is an ordinary shape: one field per operation, taking
 * `(argument, resume)`, plus an optional `.return` clause applied to the
 * computation's result. A host capability is simply a handler blot did not
 * write, which is the whole of the capability story — no `try`, no `with`, no
 * handler keyword.
 */
function* handle(
  thunk: Value,
  handler: Value,
  span: Span,
  runtime: Runtime,
): Eval {
  if (handler.tag !== "shape") {
    fail("BLOT_TYPE", `A handler is a shape, found ${show(handler)}.`, span);
  }
  const computation = apply(thunk, UNIT, span, runtime);
  return yield* drive(computation, handler, span, runtime);
}

function* drive(
  computation: Eval,
  handler: Extract<Value, { tag: "shape" }>,
  span: Span,
  runtime: Runtime,
): Eval {
  let step = computation.next(UNIT);

  while (!step.done) {
    const perform = step.value;
    const operation = handler.fields.get(perform.operation);

    if (operation === undefined) {
      // Not ours. Forward it outward and continue with whatever comes back.
      const reply = yield perform;
      step = computation.next(reply);
      continue;
    }

    const state = { used: false };
    const resume: Value = {
      tag: "continuation",
      state,
      resume: (value: Value) =>
        drive(feed(computation, value), handler, span, runtime),
    };
    const clause = yield* apply(
      operation,
      tupleOf([perform.argument, resume]),
      perform.span,
      runtime,
    );
    return clause;
  }

  const returnClause = handler.fields.get("return");
  if (returnClause === undefined) return step.value;
  return yield* apply(returnClause, step.value, span, runtime);
}

/** Restarts a suspended computation with the value `resume` was given. */
function* feed(computation: Eval, value: Value): Eval {
  let step = computation.next(value);
  while (!step.done) {
    const reply = yield step.value;
    step = computation.next(reply);
  }
  return step.value;
}

// --- patterns ---------------------------------------------------------------

/** Binds into `scope` and reports whether the value matched. */
export function match(pattern: Pattern, value: Value, scope: Env): boolean {
  switch (pattern.tag) {
    case "wildcard":
      return true;
    case "name":
      scope.names.set(pattern.name, value);
      return true;
    case "int":
      return value.tag === "int" && value.value === pattern.value;
    case "text":
      return value.tag === "text" && value.value === pattern.value;
    case "unit":
      return value.tag === "unit";
    case "constructor":
      if (value.tag !== "tag" || value.name !== pattern.name) return false;
      if (pattern.payload === null) return value.payload === null;
      return value.payload !== null &&
        match(pattern.payload, value.payload, scope);
    case "array": {
      if (
        value.tag !== "array" ||
        value.elements.length !== pattern.elements.length
      ) {
        return false;
      }
      return pattern.elements.every((element, index) =>
        match(element, value.elements[index], scope)
      );
    }
    case "tuple": {
      if (
        value.tag !== "shape" || value.fields.size !== pattern.elements.length
      ) return false;
      return pattern.elements.every((element, index) => {
        const member = value.fields.get(String(index));
        if (member === undefined) return false;
        return match(element, member, scope);
      });
    }
    case "shape": {
      if (value.tag !== "shape") return false;
      // Width subtyping: a wider value matches a narrower pattern.
      return pattern.fields.every((entry) => {
        const member = value.fields.get(entry.name);
        if (member === undefined) return false;
        return match(entry.pattern, member, scope);
      });
    }
  }
}

// --- modules ----------------------------------------------------------------

/** A module is a function from its input record to its export record. */
export function moduleClosure(
  module: Module,
  env: Env,
  imports: Imports,
): Value {
  const body: Expr = {
    tag: "block",
    declarations: module.declarations,
    result: module.result,
    span: module.span,
  };
  const parameter: Pattern = module.parameter ??
    { tag: "wildcard", span: module.span };
  return { tag: "closure", parameter, body, env, self: null, imports };
}

/** Runs a computation with no ambient handler; an unhandled effect is an error. */
export function run(computation: Eval): Value {
  const step = computation.next(UNIT);
  if (!step.done) {
    const perform = step.value;
    fail(
      "BLOT_UNHANDLED_EFFECT",
      `No handler for \`${perform.effectName}.${perform.operation}\`.`,
      perform.span,
    );
  }
  return step.value;
}

export { equal };
