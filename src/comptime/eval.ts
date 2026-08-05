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

import type {
  Expr,
  Module,
  OpenMapping,
  Pattern,
  Span,
} from "../syntax/ast.ts";
import type { RecordAdaptation } from "../check/infer.ts";
import {
  type ComputationSchedule,
  type CoreComputation,
  type CoreExpression,
  type CoreStep,
  scheduleComputation,
  scheduledResultExpression,
  type TypedCoreModule,
} from "../core/computation.ts";
import { BlotError, expect, fail } from "../diagnostic.ts";
import { reify } from "../check/bridge.ts";
import {
  asTuple,
  childEnv,
  type Env,
  equal,
  lookup,
  moduleEnv,
  moduleParameterEnv,
  show,
  tupleOf,
  UNIT,
  type Value,
  withInferredType,
} from "./value.ts";
import { makeEffect, PRIMITIVE_VALUES, PRIMITIVES } from "./primitives.ts";

export interface Perform {
  readonly effectId: number;
  readonly effectName: string;
  readonly operation: string;
  readonly argument: Value;
  /** Declared result type, retained so symbolic hosts only answer inhabited results. */
  readonly resultType: Value;
  readonly span: Span;
  /** Whether the host implements this effect rather than a blot handler. */
  readonly host: boolean;
}

export type Eval = Generator<Perform, Value, Value>;

/** Modules resolved before evaluation begins; `@import` never touches the disk. */
export type Imports = ReadonlyMap<string, Value>;

const INCLUDED_FILE_KEY_PREFIX = "\0include:";

/** Keeps included source values private while sharing the module import table. */
export function includedFileKey(specifier: string): string {
  return `${INCLUDED_FILE_KEY_PREFIX}${specifier}`;
}

export type EvaluationPhase = "comptime" | "runtime";

interface EvaluationBudget {
  remaining: number;
  readonly limit: number;
}

export interface Runtime {
  readonly imports: Imports;
  readonly phase: EvaluationPhase;
  readonly budget: EvaluationBudget;
  readonly recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>;
}

const DEFAULT_EVALUATION_FUEL = 1_000_000;

export interface OpenBinding {
  readonly source: string;
  readonly target: string;
  readonly value: Value;
}

export function resolveOpenBindings(
  fields: ReadonlyMap<string, Value>,
  mappings: readonly OpenMapping[],
  span: Span,
): readonly OpenBinding[] {
  const mappingsBySource = new Map<string, OpenMapping>();
  for (const mapping of mappings) {
    const previous = mappingsBySource.get(mapping.source);
    if (previous !== undefined) {
      fail(
        "BLOT_DUPLICATE_OPEN_FIELD",
        `The open mask maps field \`.${mapping.source}\` more than once.`,
        mapping.span,
      );
    }
    if (!fields.has(mapping.source)) {
      fail(
        "BLOT_NO_FIELD",
        `The open mask names field \`.${mapping.source}\`, but the opened record has no such field.`,
        mapping.span,
      );
    }
    mappingsBySource.set(mapping.source, mapping);
  }

  const bindingsByTarget = new Map<string, OpenBinding>();
  for (const [source, value] of fields) {
    const mapping = mappingsBySource.get(source);
    let target: string | null = source;
    if (mapping !== undefined) target = mapping.target;
    if (target === null) continue;

    const previous = bindingsByTarget.get(target);
    if (previous !== undefined) {
      let collisionSpan = span;
      if (mapping !== undefined) collisionSpan = mapping.span;
      fail(
        "BLOT_OPEN_COLLISION",
        `Fields \`.${previous.source}\` and \`.${source}\` would both enter scope as \`${target}\`. Rename or suppress one of them.`,
        collisionSpan,
      );
    }
    bindingsByTarget.set(target, { source, target, value });
  }
  return [...bindingsByTarget.values()];
}

export function evaluationRuntime(
  imports: Imports,
  phase: EvaluationPhase,
  fuel = DEFAULT_EVALUATION_FUEL,
  recordAdaptations: ReadonlyMap<Expr, RecordAdaptation> = new Map(),
): Runtime {
  return {
    imports,
    phase,
    budget: { remaining: fuel, limit: fuel },
    recordAdaptations,
  };
}

export function* evaluate(expr: Expr, env: Env, runtime: Runtime): Eval {
  runtime.budget.remaining -= 1;
  if (runtime.budget.remaining < 0) {
    fail(
      "BLOT_EVALUATION_LIMIT",
      `Evaluation exceeded its deterministic limit of ${runtime.budget.limit} steps.`,
      expr.span,
    );
  }

  switch (expr.tag) {
    case "int":
      if (
        runtime.phase === "runtime" &&
        (expr.value < -0x8000000000000000n ||
          expr.value > 0x7fffffffffffffffn)
      ) {
        fail(
          "BLOT_INTEGER_OVERFLOW",
          `The runtime integer ${expr.value} is outside signed i64 -9223372036854775808..9223372036854775807.`,
          expr.span,
        );
      }
      return { tag: "int", value: expr.value };
    // No range check: every literal the grammar admits is a finite double, and
    // one too large for the format rounded to an infinity while being read
    // rather than being a value the program can still name.
    case "float":
      return { tag: "float", value: expr.value };
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
      let argument = yield* evaluate(expr.arg, env, runtime);
      const adaptation = runtime.recordAdaptations.get(expr.arg);
      if (adaptation !== undefined) {
        argument = adaptRecord(argument, adaptation, expr.arg.span);
      }
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
        source: expr,
      };

    case "rec":
      // `rec` is meaningful only on a named binding, because the name it makes
      // visible is that binding's own. Recursion then reads like ordinary
      // recursion rather than through a reserved self-reference.
      fail(
        "BLOT_MISPLACED_REC",
        "`rec` marks a named binding, as in `const go = rec (fn x => ... go ... );`.",
        expr.span,
      );
      break;

    case "comptime": {
      const comptimeRuntime: Runtime = {
        imports: runtime.imports,
        phase: "comptime",
        budget: runtime.budget,
        recordAdaptations: runtime.recordAdaptations,
      };
      return yield* evaluate(expr.body, env, comptimeRuntime);
    }

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
      let scope = childEnv(env);
      if (env.module !== null && env.module.scope === "parameter") {
        scope = moduleEnv(env, env.module.identity);
      }
      const computation = scheduleComputation(
        expr.declarations,
        expr.result,
        expr.resultEffects,
      );
      yield* runDeclarations(computation.steps, scope, runtime);
      return yield* evaluate(
        scheduledResultExpression(computation.result),
        scope,
        runtime,
      );
    }
  }
  expect(false, `unhandled expression ${(expr as Expr).tag}`);
}

/** Evaluates checked runtime Core without recovering behavior from its AST provenance. */
export function* evaluateCoreModule(
  module: TypedCoreModule,
  argument: Value,
  env: Env,
  runtime: Runtime,
): Eval {
  const scope = childEnv(env);
  let parameter: Pattern;
  if (module.parameter === null) {
    let span: Span;
    if (module.result.tag === "return") span = module.result.value.span;
    else span = module.result.computation.span;
    parameter = { tag: "wildcard", span };
  } else parameter = module.parameter;
  if (!match(parameter, argument, scope)) {
    fail(
      "BLOT_ARGUMENT_MISMATCH",
      `${show(argument)} does not match this module parameter.`,
      parameter.span,
    );
  }
  return yield* evaluateCoreComputation(module, scope, runtime);
}

function* evaluateCoreComputation(
  computation: CoreComputation,
  scope: Env,
  runtime: Runtime,
): Eval {
  yield* runCoreSteps(computation.steps, scope, runtime);
  if (computation.result.tag === "return") {
    return yield* evaluateCoreExpression(
      computation.result.value,
      scope,
      runtime,
    );
  }
  return yield* evaluateCoreExpression(
    computation.result.computation,
    scope,
    runtime,
  );
}

function* runCoreSteps(
  steps: readonly CoreStep[],
  scope: Env,
  runtime: Runtime,
): Generator<Perform, void, Value> {
  for (const step of steps) {
    const definition = step.definition;
    if (definition.tag === "open") {
      for (const [name, value] of definition.bindings) {
        scope.names.set(name, value);
      }
      continue;
    }
    if (definition.tag === "static") {
      if (!match(definition.pattern, definition.value, scope)) {
        fail(
          "BLOT_BINDING_MISMATCH",
          `${show(definition.value)} does not match this pattern.`,
          definition.span,
        );
      }
      continue;
    }
    if (definition.tag === "static-shadow") {
      if (lookup(scope, definition.name) === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${definition.name} := ...\` cannot shadow a name that is not in scope.`,
          definition.span,
        );
      }
      scope.names.set(definition.name, definition.value);
      continue;
    }
    if (definition.tag === "shadow") {
      if (lookup(scope, definition.name) === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${definition.name} := ...\` cannot shadow a name that is not in scope.`,
          definition.span,
        );
      }
      const value = yield* evaluateCoreExpression(
        definition.value,
        scope,
        runtime,
      );
      scope.names.set(definition.name, namedEffect(value, definition.name));
      continue;
    }

    let value: Value;
    if (definition.value.tag === "rec") {
      const recursive = yield* evaluateCoreExpression(
        definition.value.lambda,
        scope,
        runtime,
      );
      if (
        definition.pattern.tag !== "name" ||
        recursive.tag !== "core-closure"
      ) {
        fail(
          "BLOT_MISPLACED_REC",
          "`rec` marks a binding to one lambda name.",
          definition.span,
        );
      }
      value = { ...recursive, self: definition.pattern.name };
    } else {
      value = yield* evaluateCoreExpression(
        definition.value,
        scope,
        runtime,
      );
      if (definition.pattern.tag === "name") {
        value = namedEffect(value, definition.pattern.name);
      }
    }
    if (!match(definition.pattern, value, scope)) {
      fail(
        "BLOT_BINDING_MISMATCH",
        `${show(value)} does not match this pattern.`,
        definition.span,
      );
    }
  }
}

function namedEffect(value: Value, name: string): Value {
  if (value.tag !== "effect" || value.name !== "Effect") return value;
  return { ...value, name };
}

function* evaluateCoreExpression(
  expression: CoreExpression,
  env: Env,
  runtime: Runtime,
): Eval {
  runtime.budget.remaining -= 1;
  if (runtime.budget.remaining < 0) {
    fail(
      "BLOT_EVALUATION_LIMIT",
      `Evaluation exceeded its deterministic limit of ${runtime.budget.limit} steps.`,
      expression.span,
    );
  }

  switch (expression.tag) {
    case "int":
      if (
        runtime.phase === "runtime" &&
        (expression.value < -0x8000000000000000n ||
          expression.value > 0x7fffffffffffffffn)
      ) {
        fail(
          "BLOT_INTEGER_OVERFLOW",
          `The runtime integer ${expression.value} is outside signed i64 -9223372036854775808..9223372036854775807.`,
          expression.span,
        );
      }
      return { tag: "int", value: expression.value };
    case "float":
      return { tag: "float", value: expression.value };
    case "text":
      return { tag: "text", value: expression.value };
    case "unit":
      return UNIT;
    case "tag":
      return { tag: "tag", name: expression.name, payload: null };
    case "constant":
      return expression.value;
    case "var": {
      const value = lookup(env, expression.name);
      if (value === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${expression.name}\` is not in scope.`,
          expression.span,
        );
      }
      return value;
    }
    case "intrinsic":
      return intrinsicValue(expression.name, expression.span);
    case "apply": {
      const fn = yield* evaluateCoreExpression(expression.fn, env, runtime);
      let argument = yield* evaluateCoreExpression(
        expression.arg,
        env,
        runtime,
      );
      if (expression.arg.adaptation !== null) {
        argument = adaptRecord(
          argument,
          expression.arg.adaptation,
          expression.arg.span,
        );
      }
      return yield* apply(fn, argument, expression.span, runtime);
    }
    case "intrinsic-apply": {
      let fn = intrinsicValue(expression.name, expression.span);
      if (expression.name === "@handle" && expression.args.length === 3) {
        const values: Value[] = [];
        for (const argument of expression.args) {
          values.push(yield* evaluateCoreExpression(argument, env, runtime));
        }
        return yield* apply(
          fn,
          tupleOf(values),
          expression.span,
          runtime,
        );
      }
      for (const argumentExpression of expression.args) {
        let argument = yield* evaluateCoreExpression(
          argumentExpression,
          env,
          runtime,
        );
        if (argumentExpression.adaptation !== null) {
          argument = adaptRecord(
            argument,
            argumentExpression.adaptation,
            argumentExpression.span,
          );
        }
        fn = yield* apply(fn, argument, expression.span, runtime);
      }
      return fn;
    }
    case "import": {
      let value = runtime.imports.get(expression.specifier);
      if (value === undefined) {
        fail(
          "BLOT_UNRESOLVED_IMPORT",
          `\`${expression.specifier}\` was not resolved.`,
          expression.span,
        );
      }
      for (const argumentExpression of expression.args) {
        const argument = yield* evaluateCoreExpression(
          argumentExpression,
          env,
          runtime,
        );
        value = yield* apply(value, argument, expression.span, runtime);
      }
      return value;
    }
    case "static-member": {
      const target = lookup(env, expression.target);
      if (target === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${expression.target}\` is not in scope.`,
          expression.span,
        );
      }
      return project(target, expression.name, expression.span);
    }
    case "static-member-apply": {
      const target = lookup(env, expression.target);
      if (target === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${expression.target}\` is not in scope.`,
          expression.span,
        );
      }
      let fn = project(target, expression.name, expression.span);
      for (const argumentExpression of expression.args) {
        let argument = yield* evaluateCoreExpression(
          argumentExpression,
          env,
          runtime,
        );
        if (argumentExpression.adaptation !== null) {
          argument = adaptRecord(
            argument,
            argumentExpression.adaptation,
            argumentExpression.span,
          );
        }
        fn = yield* apply(fn, argument, expression.span, runtime);
      }
      return fn;
    }
    case "constructor":
      return {
        tag: "tag",
        name: expression.name,
        payload: yield* evaluateCoreExpression(
          expression.payload,
          env,
          runtime,
        ),
      };
    case "checked":
      return yield* evaluateCoreExpression(expression.value, env, runtime);
    case "field": {
      const target = yield* evaluateCoreExpression(
        expression.target,
        env,
        runtime,
      );
      return project(target, expression.name, expression.span);
    }
    case "lambda": {
      const closure: Value = {
        tag: "core-closure",
        parameter: expression.parameter,
        body: expression.body,
        env,
        self: null,
      };
      const inferred = reify(expression.type);
      if (inferred === null) return closure;
      return withInferredType(closure, inferred);
    }
    case "array": {
      const elements: Value[] = [];
      for (const element of expression.elements) {
        const value = yield* evaluateCoreExpression(
          element.value,
          env,
          runtime,
        );
        if (!element.spread) {
          elements.push(value);
          continue;
        }
        if (value.tag !== "array") {
          fail(
            "BLOT_TYPE",
            `\`...\` spreads an array, found ${show(value)}.`,
            expression.span,
          );
        }
        elements.push(...value.elements);
      }
      return { tag: "array", elements };
    }
    case "tuple": {
      const elements: Value[] = [];
      for (const element of expression.elements) {
        elements.push(yield* evaluateCoreExpression(element, env, runtime));
      }
      return tupleOf(elements);
    }
    case "shape": {
      const fields = new Map<string, Value>();
      for (const member of expression.members) {
        const value = yield* evaluateCoreExpression(
          member.value,
          env,
          runtime,
        );
        if (member.tag === "field") {
          fields.set(member.name, value);
          continue;
        }
        if (value.tag !== "shape") {
          fail(
            "BLOT_TYPE",
            `\`...\` spreads a shape, found ${show(value)}.`,
            expression.span,
          );
        }
        for (const [name, field] of value.fields) fields.set(name, field);
      }
      return { tag: "shape", fields };
    }
    case "if": {
      for (const branch of expression.branches) {
        const condition = yield* evaluateCoreExpression(
          branch.condition,
          env,
          runtime,
        );
        if (truth(condition, branch.condition.span)) {
          return yield* evaluateCoreExpression(
            branch.consequence,
            env,
            runtime,
          );
        }
      }
      if (expression.fallback === null) {
        fail(
          "BLOT_NO_BRANCH",
          "No branch matched and there is no `else`.",
          expression.span,
        );
      }
      return yield* evaluateCoreExpression(expression.fallback, env, runtime);
    }
    case "case": {
      const target = yield* evaluateCoreExpression(
        expression.target,
        env,
        runtime,
      );
      for (const arm of expression.arms) {
        const scope = childEnv(env);
        if (!match(arm.pattern, target, scope)) continue;
        return yield* evaluateCoreExpression(arm.body, scope, runtime);
      }
      fail(
        "BLOT_NO_MATCH",
        `No arm matched ${show(target)}.`,
        expression.span,
      );
      break;
    }
    case "block":
      return yield* evaluateCoreComputation(
        expression.computation,
        childEnv(env),
        runtime,
      );
    case "rec":
      fail(
        "BLOT_MISPLACED_REC",
        "`rec` marks a named binding.",
        expression.span,
      );
      break;
    case "comptime": {
      const comptimeRuntime: Runtime = {
        imports: runtime.imports,
        phase: "comptime",
        budget: runtime.budget,
        recordAdaptations: runtime.recordAdaptations,
      };
      return yield* evaluateCoreExpression(
        expression.body,
        env,
        comptimeRuntime,
      );
    }
  }
  expect(false, `unhandled Core expression ${expression.tag}`);
}

/**
 * Every declaration of a block binds into one environment, and every closure a
 * declaration produces captures that environment rather than a copy of it. That
 * is the whole of what makes a recursive group run: a member's body resolves
 * its siblings when it is called, by which time the block has bound all of
 * them. Giving each declaration its own scope would leave the evaluator
 * disagreeing with a checker that already accepted the group.
 *
 * Reading a name the block has not bound yet is a scope error the checker
 * refuses (`BLOT_FORWARD_REFERENCE`), so nothing here relies on the order in
 * which the bodies happen to be forced.
 */
function* runDeclarations(
  steps: ComputationSchedule["steps"],
  scope: Env,
  runtime: Runtime,
): Generator<Perform, void, Value> {
  for (const step of steps) {
    const declaration = step.declaration;
    if (declaration.tag === "open") {
      const value = yield* evaluate(declaration.value, scope, runtime);
      if (value.tag !== "shape") {
        fail(
          "BLOT_CANNOT_OPEN",
          `\`open\` spreads a record's fields into scope, found ${
            show(value)
          }.`,
          declaration.span,
        );
      }
      const bindings = resolveOpenBindings(
        value.fields,
        declaration.mappings,
        declaration.span,
      );
      for (const binding of bindings) {
        scope.names.set(binding.target, binding.value);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      if (lookup(scope, declaration.name) === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${declaration.name} := ...\` cannot shadow a name that is not in scope.`,
          declaration.span,
        );
      }
      const value = yield* evaluate(declaration.value, scope, runtime);
      // A shadow names its effect for the same reason a binding does: without
      // it every row reads `{ Effect }` and says nothing.
      let namedValue = value;
      if (value.tag === "effect" && value.name === "Effect") {
        namedValue = { ...value, name: declaration.name };
      }
      scope.names.set(declaration.name, namedValue);
      continue;
    }
    // `sig` constrains inference; it binds nothing and computes nothing here.
    if (declaration.kind === "sig") continue;
    let declarationRuntime = runtime;
    if (declaration.kind === "const" && runtime.phase === "runtime") {
      declarationRuntime = {
        imports: runtime.imports,
        phase: "comptime",
        budget: runtime.budget,
        recordAdaptations: runtime.recordAdaptations,
      };
    }
    const value = yield* bind(
      declaration.pattern,
      declaration.value,
      scope,
      declarationRuntime,
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
export function* bind(
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
  // A type value's namespace. Looked up before the carrier, so `Point.new`
  // reaches the constructor rather than slot `"new"`.
  if (target.tag === "extended") {
    const member = target.members.get(name);
    if (member !== undefined) return member;
    return project(target.inner, name, span);
  }
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

function adaptRecord(
  value: Value,
  adaptation: RecordAdaptation,
  span: Span,
): Value {
  if (value.tag !== "shape") {
    fail("BLOT_TYPE", `Record adaptation received ${show(value)}.`, span);
  }
  const fields = new Map<string, Value>();
  for (const field of adaptation.fields) {
    const present = value.fields.get(field.name);
    if (field.optional === "absent" || field.optional === "unit") {
      fields.set(field.name, UNIT);
      continue;
    }
    if (present === undefined) {
      fail(
        "BLOT_NO_FIELD",
        `Record adaptation needs field \`.${field.name}\` on ${show(value)}.`,
        span,
      );
    }
    fields.set(field.name, present);
  }
  return { tag: "shape", fields };
}

export function* apply(
  fn: Value,
  argument: Value,
  span: Span,
  runtime: Runtime,
): Eval {
  if (fn.tag === "core-closure") {
    const scope = childEnv(fn.env);
    if (fn.self !== null) scope.names.set(fn.self, fn);
    if (!match(fn.parameter, argument, scope)) {
      fail(
        "BLOT_ARGUMENT_MISMATCH",
        `${show(argument)} does not match this parameter.`,
        span,
      );
    }
    return yield* evaluateCoreExpression(fn.body, scope, runtime);
  }

  if (fn.tag === "closure") {
    let scope = childEnv(fn.env);
    if (fn.imports !== undefined) scope = moduleParameterEnv(fn.env, fn);
    if (fn.self !== null) scope.names.set(fn.self, fn);
    if (!match(fn.parameter, argument, scope)) {
      fail(
        "BLOT_ARGUMENT_MISMATCH",
        `${show(argument)} does not match this parameter.`,
        span,
      );
    }
    let inner = runtime;
    if (fn.imports !== undefined) {
      inner = {
        imports: fn.imports,
        phase: runtime.phase,
        budget: runtime.budget,
        recordAdaptations: runtime.recordAdaptations,
      };
    }
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
    const signature = fn.effect.operations.get(fn.name);
    expect(
      signature !== undefined && signature.tag === "arrow",
      "operation without an arrow signature",
    );
    return yield {
      effectId: fn.effect.id,
      effectName: fn.effect.name,
      operation: fn.name,
      argument,
      resultType: signature.codomain,
      span,
      host: fn.effect.host,
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
  ["@effect.host", 1],
  ["@forall", 1],
  ["@handle", 1],
  ["@include", 2],
  ["@import", 1],
]);

function intrinsicValue(name: string, span: Span): Value {
  const constant = PRIMITIVE_VALUES.get(name);
  if (constant !== undefined) return constant;
  const primitive = PRIMITIVES.get(name);
  if (primitive !== undefined) {
    return {
      tag: "primitive",
      name,
      arity: primitive.arity,
      applied: [],
    };
  }
  const special = SPECIAL.get(name);
  if (special !== undefined) {
    return { tag: "primitive", name, arity: special, applied: [] };
  }
  fail("BLOT_UNKNOWN_PRIMITIVE", `\`${name}\` is not a primitive.`, span);
}

let nextTypeVariable = 0;

function* runPrimitive(
  name: string,
  args: readonly Value[],
  span: Span,
  runtime: Runtime,
): Eval {
  if (name === "@effect" || name === "@effect.host") {
    const shape = args[0];
    if (shape.tag !== "shape") {
      fail("BLOT_TYPE", `\`${name}\` takes a shape of operation types.`, span);
    }
    return makeEffect("Effect", shape.fields, name === "@effect.host");
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

  if (name === "@include") {
    if (runtime.phase !== "comptime") {
      fail(
        "BLOT_INCLUDE_NOT_COMPTIME",
        "`@include` can only be evaluated at compile time.",
        span,
      );
    }
    const specifier = args[0];
    if (specifier.tag !== "text") {
      fail("BLOT_INCLUDE_PATH", "`@include` takes a literal text path.", span);
    }
    const included = runtime.imports.get(includedFileKey(specifier.value));
    if (included === undefined) {
      fail(
        "BLOT_INCLUDE_PATH",
        `Included path \`${specifier.value}\` must be written as a literal at the \`@include\` call site.`,
        span,
      );
    }
    try {
      return yield* apply(args[1], included, span, runtime);
    } catch (error) {
      if (
        error instanceof BlotError &&
        (error.diagnostic.code === "BLOT_JSON_PARSE" ||
          error.diagnostic.code === "BLOT_JSON_NUMBER")
      ) {
        throw new BlotError({ ...error.diagnostic, span });
      }
      throw error;
    }
  }

  if (name === "@forall") {
    nextTypeVariable += 1;
    const variable: Value = { tag: "type-variable", id: nextTypeVariable };
    const body = yield* apply(args[0], variable, span, runtime);
    return { tag: "forall", variable: nextTypeVariable, body };
  }

  if (name === "@handle") {
    // The one primitive that takes a tuple rather than being curried. The
    // checker has to see this call site — the effect being discharged is part
    // of the typing rule — and a prelude wrapper would hide it behind a
    // closure whose parameter is not a compile-time value.
    const parts = asTuple(args[0], 3);
    if (parts === null) {
      fail(
        "BLOT_TYPE",
        "`@handle` takes `(effect, computation, handler)`.",
        span,
      );
    }
    return yield* handle(parts[0], parts[1], parts[2], span, runtime);
  }

  const primitive = PRIMITIVES.get(name);
  expect(primitive !== undefined, `missing primitive ${name}`);
  return primitive.run(args, span, runtime.phase);
}

/**
 * A deep, one-shot handler.
 *
 * Takes the effect it discharges, not only the handler. Dispatching on
 * operation names alone was ambiguous — two effects may both declare `.write` —
 * and it left the checker unable to say *which* effect a `@handle` removed from
 * a row. Naming the effect makes discharge checkable and makes the lowering
 * possible; guessing it made neither.
 *
 * `handler` is an ordinary shape: one field per operation, taking
 * `(argument, ?resume)`, plus an optional `.return` clause applied to the
 * computation's result. There is no `try`, no `with`, and no handler keyword.
 */
function* handle(
  effect: Value,
  thunk: Value,
  handler: Value,
  span: Span,
  runtime: Runtime,
): Eval {
  if (effect.tag !== "effect") {
    fail(
      "BLOT_TYPE",
      `\`@handle\` takes the effect it discharges, found ${show(effect)}.`,
      span,
    );
  }
  if (handler.tag !== "shape") {
    fail("BLOT_TYPE", `A handler is a shape, found ${show(handler)}.`, span);
  }
  for (const name of handler.fields.keys()) {
    if (name === "return") continue;
    if (!effect.operations.has(name)) {
      fail(
        "BLOT_NO_OPERATION",
        `Effect \`${effect.name}\` has no operation \`${name}\`, so this handler cannot discharge it.`,
        span,
      );
    }
  }
  const computation = apply(thunk, UNIT, span, runtime);
  return yield* drive(computation, effect.id, handler, span, runtime);
}

function* drive(
  computation: Eval,
  effectId: number,
  handler: Extract<Value, { tag: "shape" }>,
  span: Span,
  runtime: Runtime,
): Eval {
  let step = computation.next(UNIT);

  while (!step.done) {
    const perform = step.value;
    // Only this effect's operations. A different effect that happens to have an
    // operation of the same name passes straight through to its own handler.
    const operation = perform.effectId === effectId
      ? handler.fields.get(perform.operation)
      : undefined;

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
        drive(feed(computation, value), effectId, handler, span, runtime),
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
    case "pin": {
      const pinned = lookup(scope, pattern.name);
      if (pinned === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${pattern.name}\` is not in scope.`,
          pattern.span,
        );
      }
      return equal(value, pinned);
    }
    case "int":
      return value.tag === "int" && value.value === pattern.value;
    // `Object.is`, so a `NaN` pattern matches a `NaN` scrutinee. `==` would
    // make the arm unreachable, and an arm that can never run is worse than
    // one that disagrees with IEEE about a value no ordering accepts anyway.
    case "float":
      return value.tag === "float" && Object.is(value.value, pattern.value);
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
    resultEffects: module.resultEffects,
    span: module.span,
  };
  const parameter: Pattern = module.parameter ??
    { tag: "wildcard", span: module.span };
  return { tag: "closure", parameter, body, env, self: null, imports };
}

/**
 * Answers a host effect's operation. `null` means the host does not implement
 * it, which is the same as there being no handler at all.
 */
export type Host = (perform: Perform) => Value | null;

/**
 * Runs a computation to completion.
 *
 * A blot effect must be discharged by a blot handler. A *host* effect is
 * answered here instead, because the host is its implementation — the same
 * split the backend makes when it turns one into a WebAssembly import.
 */
export function run(computation: Eval, host: Host = () => null): Value {
  let step = computation.next(UNIT);
  while (!step.done) {
    const perform = step.value;
    const answer = host(perform);
    if (answer === null) {
      fail(
        "BLOT_UNHANDLED_EFFECT",
        `No handler for \`${perform.effectName}.${perform.operation}\`.`,
        perform.span,
      );
    }
    step = computation.next(answer);
  }
  return step.value;
}

export { equal };
