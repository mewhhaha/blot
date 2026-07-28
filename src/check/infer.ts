// The typing rules.
//
// Two things here are not standard bookkeeping and are worth reading closely.
//
// **Effects are ambient.** `infer` carries a row that every performed effect and
// every called function's row flows into. A lambda gives its body a fresh row
// and puts it in its own type. That is all effect inference is — there is no
// separate pass, because a row is a lattice element and `constrain` already
// knows how to join one.
//
// **`const` is checked through its value.** A `const` is a compile-time value,
// and if that value is a type — a range, a union, an effect, a shape of types —
// then it *is* the binding's type, bridged rather than inferred. That is the
// mechanism that lets `const Console = @effect {...}` give `Console.write` a row
// without a single annotation, and it is why blot needs no type sublanguage.

import type { Decl, Expr, Module, Pattern, Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import type { Env as ValueEnv } from "../comptime/value.ts";
import { childEnv } from "../comptime/value.ts";
import { bind, evaluate, type Imports, run } from "../comptime/eval.ts";
import { bridge } from "./bridge.ts";
import { constrain, instantiate, scheme, TypeError_ } from "./constrain.ts";
import { PRIMITIVE_TYPES } from "./primitives.ts";
import {
  effects,
  freshVar,
  intLiteral,
  type Level,
  record,
  type SimpleType,
  textLiteral,
  tupleType,
  type Typing,
  UNIT,
  variant,
} from "./type.ts";

interface TypeEnv {
  readonly names: Map<string, Typing>;
  readonly parent: TypeEnv | null;
}

function childTypeEnv(parent: TypeEnv | null): TypeEnv {
  return { names: new Map(), parent };
}

function lookupType(env: TypeEnv, name: string): Typing | undefined {
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.names.get(name);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

interface Context {
  /** Field sets and constructor sets, recorded for the backend. */
  readonly shapes: Map<Expr, readonly string[]>;
  /** Facts read after checking, once every constraint has been seen. */
  readonly pending: (() => void)[];
  readonly variants: Map<Expr, readonly VariantCase[]>;
  readonly types: TypeEnv;
  /** Comptime bindings, for bridging `sig` expressions and `const` values. */
  readonly values: ValueEnv;
  readonly imports: Imports;
  /** Checked types of imported modules, keyed by the specifier as written. */
  readonly modules: ReadonlyMap<string, SimpleType>;
}

function located<T>(span: Span, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TypeError_) {
      fail("BLOT_TYPE_ERROR", `${error.detail}.`, span);
    }
    throw error;
  }
}

/**
 * Evaluates a compile-time expression, or returns null if it cannot be reached
 * without running the program. A `sig` that depends on a runtime value is a
 * diagnostic elsewhere, not a reason to guess here.
 */
function comptime(expr: Expr, context: Context): ReturnType<typeof run> | null {
  try {
    return run(evaluate(expr, context.values, { imports: context.imports }));
  } catch {
    return null;
  }
}

function comptimeBinding(
  pattern: Pattern,
  expr: Expr,
  context: Context,
): ReturnType<typeof run> | null {
  try {
    return run(
      bind(pattern, expr, context.values, { imports: context.imports }),
    );
  } catch {
    return null;
  }
}

export function infer(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  switch (expr.tag) {
    case "int":
      return intLiteral(expr.value);
    case "text":
      return textLiteral(expr.value);
    case "unit":
      return UNIT;

    case "var": {
      const found = lookupType(context.types, expr.name);
      if (found === undefined) {
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return instantiate(found, level);
    }

    case "intrinsic": {
      const primitive = PRIMITIVE_TYPES.get(expr.name);
      if (primitive === undefined) {
        // `@effect` and `@handle` are handled at their application sites,
        // because their types depend on the argument's shape.
        if (
          expr.name === "@effect" || expr.name === "@effect.host" ||
          expr.name === "@handle"
        ) {
          return freshVar(level);
        }
        fail(
          "BLOT_UNKNOWN_PRIMITIVE",
          `\`${expr.name}\` is not a primitive.`,
          expr.span,
        );
      }
      return instantiate(primitive, level);
    }

    case "tag":
      return variant([[expr.name, UNIT]]);

    case "apply": {
      // A constructor applied to a payload is not a call: `#Progress 2` builds
      // `#Progress Int`, and typing it through a function would lose the tag.
      if (expr.fn.tag === "tag") {
        const payload = infer(expr.arg, context, level, row);
        return variant([[expr.fn.name, payload]]);
      }

      const special = inferSpecial(expr, context, level, row);
      if (special !== null) return special;

      const fnType = infer(expr.fn, context, level, row);
      const argType = infer(expr.arg, context, level, row);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(fnType, { tag: "fun", param: argType, effects: row, result });
      });
      return result;
    }

    case "field": {
      const target = infer(expr.target, context, level, row);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(target, record([[expr.name, result]]));
      });
      // Record what the target's whole field set is, if it is known. Lowering
      // cannot see it and cannot build the nominal without it. Deferred to the
      // end of checking, because a later use may add a field this one does not
      // mention.
      context.pending.push(() => {
        const fields = fieldsOf(target);
        if (fields !== null) context.shapes.set(expr, fields);
      });
      return result;
    }

    case "lambda": {
      const scope = childTypeEnv(context.types);
      const inner: Context = { ...context, types: scope };
      const param = bindPattern(expr.parameter, scope, level);
      // A fresh row per lambda is what makes the inferred effect minimal:
      // nothing becomes effectful because something else nearby was.
      const bodyRow = freshVar(level);
      const result = infer(expr.body, inner, level, bodyRow);
      return { tag: "fun", param, effects: bodyRow, result };
    }

    case "rec": {
      if (expr.lambda.tag !== "lambda") {
        fail("BLOT_TYPE_ERROR", "`rec` applies to a lambda.", expr.span);
      }
      return infer(expr.lambda, context, level, row);
    }

    case "comptime":
      return infer(expr.body, context, level, row);

    case "tuple":
      return tupleType(expr.elements.map((e) => infer(e, context, level, row)));

    case "array": {
      const element = freshVar(level);
      for (const item of expr.elements) {
        const itemType = infer(item.value, context, level, row);
        located(expr.span, () => {
          if (item.spread) constrain(itemType, { tag: "array", element });
          else constrain(itemType, element);
        });
      }
      return { tag: "array", element };
    }

    case "shape": {
      const fields = new Map<string, SimpleType>();
      for (const member of expr.members) {
        const memberType = infer(member.value, context, level, row);
        if (member.tag === "field") {
          fields.set(member.name, memberType);
          continue;
        }
        // A spread contributes whatever the spread value holds, and the
        // backend has to copy those fields one by one — so record the set.
        context.pending.push(() => {
          const spread = fieldsOf(memberType);
          if (spread !== null) context.shapes.set(member.value, spread);
        });
        // A spread of a shape whose fields are not statically known cannot
        // contribute names. Saying so is better than inventing them.
        if (memberType.tag === "record") {
          for (const [name, inner] of memberType.fields) {
            fields.set(name, inner);
          }
        }
      }
      return record(fields);
    }

    case "if": {
      const result = freshVar(level);
      for (const branch of expr.branches) {
        const condition = infer(branch.condition, context, level, row);
        located(branch.condition.span, () => {
          constrain(condition, variant([["True", UNIT], ["False", UNIT]]));
        });
        const consequence = infer(branch.consequence, context, level, row);
        located(branch.consequence.span, () => constrain(consequence, result));
      }
      if (expr.fallback !== null) {
        const fallback = infer(expr.fallback, context, level, row);
        located(expr.fallback.span, () => constrain(fallback, result));
      }
      return result;
    }

    case "case":
      return inferCase(expr, context, level, row);

    case "block": {
      const scope = childTypeEnv(context.types);
      const values = childEnv(context.values);
      const inner: Context = { ...context, types: scope, values };
      inferDeclarations(expr.declarations, inner, level, row);
      return infer(expr.result, inner, level, row);
    }
  }
}

/**
 * `@effect` and `@handle` depend on the shape of their arguments rather than on
 * a fixed scheme, so they are typed at the application site.
 */
function inferSpecial(
  expr: Expr & { tag: "apply" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType | null {
  const head = spine(expr);
  if (head === null || head.callee.tag !== "intrinsic") return null;

  if (
    (head.callee.name === "@effect" || head.callee.name === "@effect.host") &&
    head.args.length === 1
  ) {
    // An effect's identity comes from evaluating it: two effects that both
    // declare `.write` are still different effects.
    const value = comptime(expr, context);
    if (value !== null && value.tag === "effect") {
      const bridged = bridge(value);
      if (bridged !== null) return bridged;
    }
    return freshVar(level);
  }

  // A module is a function from its input record to its export record, and it
  // is checked once and shared. Typing the import is what lets a caller see
  // the module's exports instead of an opaque value.
  if (head.callee.name === "@import" && head.args.length >= 1) {
    const specifier = head.args[0];
    if (specifier.tag !== "text") return null;
    const moduleType = context.modules.get(specifier.value);
    if (moduleType === undefined) return null;
    let result = instantiate(scheme(moduleType, -1), level);
    for (const argument of head.args.slice(1)) {
      const argumentType = infer(argument, context, level, row);
      const applied = freshVar(level);
      const target = result;
      located(expr.span, () => {
        constrain(target, {
          tag: "fun",
          param: argumentType,
          effects: row,
          result: applied,
        });
      });
      result = applied;
    }
    return result;
  }

  if (head.callee.name === "@handle" && head.args.length === 2) {
    const thunk = infer(head.args[0], context, level, row);
    infer(head.args[1], context, level, row);
    const result = freshVar(level);
    // The thunk's row is deliberately *not* joined into the ambient row: the
    // handler discharges it. Which effect it discharges is not recoverable from
    // a handler shape's field names alone, so what is checked here is that the
    // thunk is callable — see docs/inference.md.
    located(expr.span, () => {
      constrain(thunk, {
        tag: "fun",
        param: UNIT,
        effects: freshVar(level),
        result,
      });
    });
    return result;
  }

  return null;
}

function spine(expr: Expr): { callee: Expr; args: Expr[] } | null {
  const args: Expr[] = [];
  let current = expr;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  if (args.length === 0) return null;
  return { callee: current, args };
}

function inferCase(
  expr: Expr & { tag: "case" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  const target = infer(expr.target, context, level, row);
  const result = freshVar(level);
  const accepted: SimpleType[] = [];

  for (const arm of expr.arms) {
    const scope = childTypeEnv(context.types);
    const inner: Context = { ...context, types: scope };
    const armType = bindPattern(arm.pattern, scope, level);
    accepted.push(armType);

    // Narrowing: inside the arm, a matched name is known to have the arm's
    // shape. This is what "branches prove stuff" amounts to over a union
    // lattice — refinement, not dependent types.
    if (expr.target.tag === "var" && !irrefutable(arm.pattern)) {
      scope.names.set(expr.target.name, armType);
    }

    const body = infer(arm.body, inner, level, row);
    located(arm.body.span, () => constrain(body, result));
  }

  // The scrutinee must be covered by the arms taken together. A variant with a
  // case no arm mentions is caught here rather than at runtime.
  const covered = mergeAccepted(accepted);
  if (covered !== null) {
    located(expr.target.span, () => constrain(target, covered));
  }
  // Recorded after the arms, not before: the scrutinee's constructor set is
  // what the arms proved it must be, and before them there is nothing to read.
  const cases = casesOf(target);
  if (cases !== null) context.variants.set(expr, cases);
  return result;
}

/**
 * The field set of a record type, digging through a variable's bounds.
 *
 * A variable's lower bounds are what flowed into it, and a record among them is
 * the shape the value actually has. Several disagreeing records mean the field
 * set is not known here, and saying so beats picking one.
 */
function fieldsOf(type: SimpleType): readonly string[] | null {
  const found = new Set<string>();
  let sawRecord = false;

  const walk = (current: SimpleType, seen: Set<number>): void => {
    if (current.tag === "record") {
      sawRecord = true;
      for (const name of current.fields.keys()) found.add(name);
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    // Both directions: a value's fields are what flowed in, and a parameter's
    // are what the body demanded. `(&p) => p.x + p.y` pins `p` from above.
    for (const bound of [...current.lower, ...current.upper]) walk(bound, seen);
  };

  walk(type, new Set());
  return sawRecord ? [...found] : null;
}

/**
 * The constructor set of a variant type, with each tag's arity.
 *
 * Arity matters to the backend and to nothing else: Core constructors declare
 * their fields, and `#Ready` with no payload cannot share a field list with
 * `#Busy n`.
 */
function casesOf(type: SimpleType): readonly VariantCase[] | null {
  const found = new Map<string, boolean>();
  let sawVariant = false;

  const walk = (current: SimpleType, seen: Set<number>): void => {
    if (current.tag === "variant") {
      sawVariant = true;
      for (const [name, payload] of current.cases) {
        found.set(name, found.get(name) === true || payload.tag !== "unit");
      }
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    for (const bound of [...current.lower, ...current.upper]) walk(bound, seen);
  };

  walk(type, new Set());
  if (!sawVariant) return null;
  return [...found].map(([name, payload]) => ({ name, payload }));
}

/** Arms of one `case` accept the union of their patterns. */
function mergeAccepted(accepted: readonly SimpleType[]): SimpleType | null {
  const cases = new Map<string, SimpleType>();
  for (const type of accepted) {
    // An irrefutable arm accepts everything, so coverage says nothing.
    if (type.tag === "var") return null;
    if (type.tag !== "variant") return null;
    for (const [name, payload] of type.cases) cases.set(name, payload);
  }
  if (cases.size === 0) return null;
  return variant(cases);
}

function irrefutable(pattern: Pattern): boolean {
  return pattern.tag === "wildcard" || pattern.tag === "name";
}

/** Types a pattern and binds its names. Returns what the pattern accepts. */
function bindPattern(
  pattern: Pattern,
  scope: TypeEnv,
  level: Level,
): SimpleType {
  switch (pattern.tag) {
    case "wildcard":
      return freshVar(level);
    case "name": {
      const type = freshVar(level);
      scope.names.set(pattern.name, type);
      return type;
    }
    case "int":
      return intLiteral(pattern.value);
    case "text":
      return textLiteral(pattern.value);
    case "unit":
      return UNIT;
    case "tuple":
      return tupleType(
        pattern.elements.map((p) => bindPattern(p, scope, level)),
      );
    case "array": {
      const element = freshVar(level);
      for (const inner of pattern.elements) {
        constrain(element, bindPattern(inner, scope, level));
      }
      return { tag: "array", element };
    }
    case "constructor": {
      const payload = pattern.payload === null
        ? UNIT
        : bindPattern(pattern.payload, scope, level);
      return variant([[pattern.name, payload]]);
    }
    case "shape":
      return record(
        pattern.fields.map((field) =>
          [field.name, bindPattern(field.pattern, scope, level)] as const
        ),
      );
  }
}

function inferDeclarations(
  declarations: readonly Decl[],
  context: Context,
  level: Level,
  row: SimpleType,
): void {
  let pendingSig: { name: string; type: SimpleType } | null = null;

  for (const declaration of declarations) {
    if (declaration.tag === "shadow") {
      const type = generalize(declaration.value, context, level, row);
      context.types.names.set(declaration.name, type);
      recordValue(declaration.name, declaration.value, context);
      continue;
    }

    if (declaration.kind === "sig") {
      if (declaration.pattern.tag !== "name") {
        fail("BLOT_BAD_SIG", "`sig` names a single binding.", declaration.span);
      }
      const value = comptime(declaration.value, context);
      if (value === null) {
        fail(
          "BLOT_SIG_NOT_COMPTIME",
          "A `sig` must evaluate at compile time.",
          declaration.span,
        );
      }
      const bridged = bridge(value);
      if (bridged === null) {
        fail(
          "BLOT_SIG_NOT_A_TYPE",
          "This `sig` does not evaluate to a type.",
          declaration.span,
        );
      }
      pendingSig = { name: declaration.pattern.name, type: bridged };
      continue;
    }

    // A `const` whose value is a type *is* its type. Bridging beats inferring
    // here: `const Console = @effect {...}` has no inferable structure, but its
    // value knows exactly which operations exist and which row they carry.
    let type: Typing | null = null;
    if (declaration.kind === "const") {
      // Through `bind`, not `evaluate`: a `const` may be `rec`, and `rec` only
      // means anything when it knows the name it is being bound to.
      const raw = comptimeBinding(
        declaration.pattern,
        declaration.value,
        context,
      );
      // `@effect` cannot know what it will be called, so the binding names it.
      // The identity is preserved: this is a rename, not a second effect.
      const value =
        raw !== null && raw.tag === "effect" && raw.name === "Effect" &&
          declaration.pattern.tag === "name"
          ? { ...raw, name: declaration.pattern.name }
          : raw;
      if (value !== null) {
        recordComptime(declaration.pattern, value, context);
        const bridged = bridge(value);
        if (bridged !== null) type = bridged;
      }
    }

    if (type === null) {
      type =
        declaration.value.tag === "rec" && declaration.pattern.tag === "name"
          ? generalizeRec(
            declaration.pattern.name,
            declaration.value,
            context,
            level,
            row,
          )
          : generalize(declaration.value, context, level, row);
    }

    if (
      pendingSig !== null && declaration.pattern.tag === "name" &&
      pendingSig.name === declaration.pattern.name
    ) {
      const expected = pendingSig.type;
      located(declaration.span, () => {
        constrain(instantiate(type as Typing, level), expected);
      });
      type = expected;
      pendingSig = null;
    }

    bindDeclaration(declaration.pattern, type, context, level);
  }
}

function bindDeclaration(
  pattern: Pattern,
  type: Typing,
  context: Context,
  level: Level,
): void {
  if (pattern.tag === "name") {
    context.types.names.set(pattern.name, type);
    return;
  }
  // A destructuring binding types its parts by constraining the whole against
  // the shape the pattern requires.
  const scope = context.types;
  const required = bindPattern(pattern, scope, level);
  located(pattern.span, () => constrain(instantiate(type, level), required));
}

/** `let`-polymorphism: infer one level deeper, then quantify what stayed there. */
function generalize(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): Typing {
  const inner = infer(expr, context, level + 1, row);
  return scheme(inner, level);
}

/**
 * `rec` makes a binding's own name visible inside its lambda, so the name has to
 * be in scope before the body is inferred. It is bound monomorphically: a
 * recursive call sees one type, and generalization happens once the body is
 * known.
 */
function generalizeRec(
  name: string,
  expr: Expr & { tag: "rec" },
  context: Context,
  level: Level,
  row: SimpleType,
): Typing {
  const scope = childTypeEnv(context.types);
  const placeholder = freshVar(level + 1);
  scope.names.set(name, placeholder);
  const inner = infer(
    expr.lambda,
    { ...context, types: scope },
    level + 1,
    row,
  );
  located(expr.span, () => constrain(inner, placeholder));
  return scheme(inner, level);
}

function recordValue(name: string, expr: Expr, context: Context): void {
  const value = comptime(expr, context);
  if (value !== null) context.values.names.set(name, value);
}

function recordComptime(
  pattern: Pattern,
  value: ReturnType<typeof run>,
  context: Context,
): void {
  if (pattern.tag === "name") {
    context.values.names.set(pattern.name, value);
    return;
  }
  if (pattern.tag === "shape" && value.tag === "shape") {
    for (const field of pattern.fields) {
      const member = value.fields.get(field.name);
      if (member !== undefined) recordComptime(field.pattern, member, context);
    }
  }
}

export interface Checked {
  readonly type: SimpleType;
  readonly effects: SimpleType;
  /**
   * What inference learned that lowering needs.
   *
   * gpufuck has no records: they become nominal declarations, and a nominal
   * needs the *whole* field set. `p.x` alone does not say what else `p` has —
   * inference does, so it writes it down here rather than making the backend
   * re-derive it. Same for the constructor set behind a `case`.
   */
  readonly shapes: ReadonlyMap<Expr, readonly string[]>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
}

/** One constructor of a union, and whether it carries a payload. */
export interface VariantCase {
  readonly name: string;
  readonly payload: boolean;
}

export function checkModule(
  module: Module,
  values: ValueEnv,
  imports: Imports,
  prelude: ReadonlyMap<string, SimpleType> | null,
  modules: ReadonlyMap<string, SimpleType> = new Map(),
): Checked {
  const types = childTypeEnv(null);
  if (prelude !== null) {
    // Quantified below ground level: the prelude's exports were already
    // instantiated once when its result record was built, which left their
    // variables at level 0. Re-generalizing at 0 would make every use share
    // them, so `fold` used once on text could never be used on integers.
    for (const [name, type] of prelude) types.names.set(name, scheme(type, -1));
  }
  const shapes = new Map<Expr, readonly string[]>();
  const variants = new Map<Expr, readonly VariantCase[]>();
  const pending: (() => void)[] = [];
  const context: Context = {
    shapes,
    variants,
    pending,
    types,
    values,
    imports,
    modules,
  };
  const level = 0;
  const row = freshVar(level);

  if (module.parameter !== null) {
    // The entry module's parameter is the program's whole authority, and its
    // shape is whatever the program actually reaches for — inference discovers
    // the capability requirement rather than the program declaring it.
    bindPattern(module.parameter, types, level);
  }

  inferDeclarations(module.declarations, context, level, row);
  const result = infer(module.result, context, level, row);
  // Every constraint has been seen by now, so a field set read here is the
  // whole one rather than whatever the first projection happened to mention.
  for (const read of pending) read();
  return { type: result, effects: row, shapes, variants };
}

export { effects, PRIMITIVE_TYPES };
