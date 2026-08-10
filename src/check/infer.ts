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

import type {
  Decl,
  Expr,
  Module,
  Pattern,
  RecursiveMember,
  Span,
} from "../syntax/ast.ts";
import { patternNames, recursiveGroups } from "../syntax/ast.ts";
import { freeNames } from "../syntax/live.ts";
import { BlotError, expect, fail } from "../diagnostic.ts";
import type { Env as ValueEnv } from "../comptime/value.ts";
import {
  childEnv,
  show,
  type Value,
  withInferredType,
} from "../comptime/value.ts";
import {
  apply,
  bind,
  evaluate,
  evaluationRuntime,
  type Imports,
  run,
} from "../comptime/eval.ts";
import { bridge, effectLabel, reify } from "./bridge.ts";
import {
  showLiterals,
  uncovered,
  uncoveredTuple,
  unlistable,
} from "./coverage.ts";
import { difference } from "./setops.ts";
import {
  arrayLength,
  bindPatternRelation,
  comptimeInt,
  expressionRelation,
  narrowing,
  proven,
  recordExpressionRelation,
  requireProvenIndex,
  spine,
  witness,
} from "./refine.ts";
import {
  constrain,
  type Instances,
  instantiate,
  instantiateForall,
  scheme,
  TypeError_,
} from "./constrain.ts";
import { PRIMITIVE_TYPES } from "./primitives.ts";
import { show as showType } from "./print.ts";
import type { ArrayIndexProof, RefinementTerm } from "../core/proof.ts";
import {
  RefinementContext,
  type RefinementVariable,
} from "../core/refinement.ts";
import {
  admitsOmission,
  type Domain,
  effects,
  evidenceOf,
  FLOAT,
  freshVar,
  I64_HIGH,
  I64_LOW,
  INT,
  intLiteral,
  type Level,
  openVariant,
  record,
  type SimpleType,
  TEXT,
  textLiteral,
  TOP,
  tupleType,
  type Typing,
  union as unionType,
  UNIT,
  type Variable,
  variant,
} from "./type.ts";

export type RelationalValue =
  | {
    readonly tag: "index";
    readonly value: RefinementTerm;
    readonly length: RefinementTerm;
  }
  | {
    readonly tag: "tuple";
    readonly elements: readonly (RelationalValue | null)[];
  }
  | {
    readonly tag: "variant";
    readonly cases: ReadonlyMap<string, RelationalValue | null>;
  }
  | { readonly tag: "indexed-iterator"; readonly length: RefinementTerm };

export interface TypeEnv {
  readonly names: Map<string, Typing>;
  readonly literals: Map<string, Expr>;
  /** Value relationships proved in this lexical and control-flow scope. */
  readonly refinements: RefinementContext;
  /**
   * The compile-time value a binding installed *alongside* the type it put in
   * `names`, together with that exact `Typing` object.
   *
   * `context.values` cannot answer this question. A plain `let` and a lambda
   * parameter write only the type environment, so a runtime shadow of `Eq` is
   * invisible there while being entirely visible to evaluation — and a checker
   * that read the compile-time `Eq` through a runtime shadow of it would prove
   * facts about a function the program never calls. Pairing the value with the
   * `Typing` object makes that detectable: a later binding installs a different
   * object, so `lookupComptime` sees the mismatch and declines.
   */
  readonly comptime: Map<string, { value: Value; typing: Typing }>;
  /**
   * The known length of the array value a binding holds, paired with the
   * `Typing` installed beside it.
   *
   * A length is a fact about a value, not about a type: `[a]` carries no
   * length, and this deliberately does not put one there. A literal contributes
   * a number; an alias, replacement, or append may contribute a relationship to
   * another immutable array value.
   *
   * The `Typing` pairing is the same discipline `comptime` uses, and it is
   * needed for the same reason: a lambda parameter named `xs` installs a fresh
   * `Typing`, so this answers `null` for it rather than reporting the length of
   * an array the callee never receives.
   */
  readonly arrayLengths: Map<
    string,
    { length: RefinementTerm; typing: Typing }
  >;
  /** Exact relational integer values retained by immutable bindings. */
  readonly integerValues: Map<
    string,
    { value: RefinementTerm; typing: Typing }
  >;
  /** Erased relationship packages carried by ordinary runtime values. */
  readonly relations: Map<
    string,
    { value: RelationalValue; typing: Typing }
  >;
  /**
   * The immutable value identity a name currently denotes, paired with the
   * `Typing` that binding installed.
   *
   * The identity is what `length(b)` in `Phi` is keyed to. blot has no
   * assignment and arrays are immutable, so one identity denotes exactly one
   * value for its whole lifetime. A transparent alias keeps it; a new value
   * gets another.
   *
   * The `Typing` pairing makes the map fail closed. A scope that shadows a name
   * without minting — a `case` arm narrowing its target, say — installs a
   * different `Typing`, so this answers `null` and no length is symbolised
   * rather than one being read off a binding that is no longer the one in
   * scope.
   */
  readonly bindings: Map<string, { id: number; typing: Typing }>;
  /** Lexical phase of the active binding, paired to survive shadowing safely. */
  readonly phases: Map<
    string,
    { phase: "runtime" | "comptime"; typing: Typing }
  >;
  /** Stable identities for immutable projections, keyed by parent identity and field. */
  readonly projections: Map<string, number>;
  /**
   * The value a binding holds, when typing it required the checker to compute
   * one, paired with the `Typing` installed beside it.
   *
   * A declaration records what `inferMemberApplication` computed, and
   * `foldedEnv` is the only reader: typing a call to a member means running it,
   * and a call whose argument is one of these bindings needs its value to run
   * at all. The value is the one the program will hold — evaluation is
   * deterministic, an effect performed at compile time fails rather than
   * happens, and blot has no assignment for the two runs to disagree about —
   * but it is deliberately kept out of `comptime` and out of `context.values`,
   * because a `let` is still a runtime binding and a `const` that captured it
   * would still be a phase error.
   *
   * The `Typing` pairing is the discipline `comptime` uses, for the same
   * reason: a name rebound to something the checker cannot compute must answer
   * nothing rather than answer with the value it used to hold.
   */
  readonly folded: Map<string, { value: Value; typing: Typing }>;
  readonly parent: TypeEnv | null;
}

export function childTypeEnv(parent: TypeEnv | null): TypeEnv {
  let refinements = new RefinementContext();
  if (parent !== null) refinements = parent.refinements.clone();
  return {
    names: new Map(),
    literals: new Map(),
    refinements,
    comptime: new Map(),
    arrayLengths: new Map(),
    integerValues: new Map(),
    relations: new Map(),
    bindings: new Map(),
    phases: new Map(),
    projections: new Map(),
    folded: new Map(),
    parent,
  };
}

let nextBinding = 0;

/** Records the immutable value identity the new binding denotes. */
export function recordBinding(
  scope: TypeEnv,
  name: string,
  identity: number | null = null,
): number {
  const typing = scope.names.get(name);
  if (typing === undefined) {
    throw new Error(`cannot record binding \`${name}\` before its type`);
  }
  if (identity === null) {
    nextBinding += 1;
    identity = nextBinding;
  }
  scope.bindings.set(name, { id: identity, typing });
  return identity;
}

export function lookupBinding(env: TypeEnv, name: string): number | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.bindings.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.id;
    }
    scope = scope.parent;
  }
  return null;
}

function recordBindingPhase(
  scope: TypeEnv,
  name: string,
  phase: "runtime" | "comptime",
): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.phases.set(name, { phase, typing });
}

function lookupBindingPhase(
  env: TypeEnv,
  name: string,
): "runtime" | "comptime" | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.phases.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.phase;
    }
    scope = scope.parent;
  }
  return null;
}

export function lookupIntegerValue(
  env: TypeEnv,
  name: string,
): RefinementTerm | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.integerValues.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.value;
    }
    scope = scope.parent;
  }
  return null;
}

export function recordIntegerValue(
  scope: TypeEnv,
  name: string,
  value: RefinementTerm,
): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.integerValues.set(name, { value, typing });
  const identity = lookupBinding(scope, name);
  if (identity === null || !assumeTerm(scope.refinements, identity, value)) {
    throw new Error(`integer relationship for \`${name}\` is inconsistent`);
  }
}

export function lookupRelation(
  env: TypeEnv,
  name: string,
): RelationalValue | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.relations.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.value;
    }
    scope = scope.parent;
  }
  return null;
}

export function recordRelation(
  scope: TypeEnv,
  name: string,
  value: RelationalValue,
): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.relations.set(name, { value, typing });
}

function assumeTerm(
  refinements: RefinementContext,
  variable: RefinementVariable,
  term: RefinementTerm,
): boolean {
  if (term.tag === "literal") {
    return refinements.assume({
      tag: "at-least",
      variable,
      value: term.value,
    }) && refinements.assume({
      tag: "at-most",
      variable,
      value: term.value,
    });
  }
  return refinements.assume({
    tag: "equal-offset",
    left: variable,
    right: term.identity,
    offset: term.offset,
  });
}

/** The immutable value identity an alias keeps. */
function aliasedBinding(expr: Expr, scope: TypeEnv): number | null {
  if (expr.tag === "var") return lookupBinding(scope, expr.name);
  if (expr.tag === "field") return projectedBinding(expr, scope);
  const head = spine(expr);
  if (head === null || head.args.length !== 1) return null;
  if (head.callee.tag !== "intrinsic") return null;
  if (
    head.callee.name !== "@linear.own" &&
    head.callee.name !== "@linear.borrow" &&
    head.callee.name !== "@linear.maybe"
  ) return null;
  return aliasedBinding(head.args[0], scope);
}

export function projectedBinding(
  expression: Expr & { tag: "field" },
  scope: TypeEnv,
): number | null {
  const parent = aliasedBinding(expression.target, scope);
  if (parent === null) return null;
  const key = `${parent}.${expression.name}`;
  let current: TypeEnv | null = scope;
  while (current !== null) {
    const found = current.projections.get(key);
    if (found !== undefined) return found;
    current = current.parent;
  }
  nextBinding += 1;
  scope.projections.set(key, nextBinding);
  return nextBinding;
}

export function lookupType(env: TypeEnv, name: string): Typing | undefined {
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.names.get(name);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

/**
 * The compile-time value of `name`, but only when the binding that gives `name`
 * its type is the same one that recorded the value.
 *
 * This is the whole of the shadowing story. `let Eq = { .eq = a => (b => True); };`
 * installs a fresh `Typing` for `Eq` and records no value, so the recorded pair
 * from the enclosing `open` no longer matches and this answers `null` — the
 * checker proves nothing rather than proving something about the prelude's `Eq`
 * while the program calls the user's. A lambda parameter named `Eq` is refused
 * for the same reason, which matters because no analysis of a compile-time value
 * could ever be sound when the caller supplies the function.
 */
export function lookupComptime(env: TypeEnv, name: string): Value | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.comptime.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.value;
    }
    scope = scope.parent;
  }
  return null;
}

/** Pairs a computed value with the `Typing` installed beside it. */
function recordFolded(scope: TypeEnv, name: string, value: Value): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.folded.set(name, { value, typing });
}

/**
 * The evaluation environment a member call runs in: the compile-time bindings,
 * plus the ones whose values the checker computed while typing an earlier call.
 *
 * Built outermost first, so an inner scope's binding shadows an outer one the
 * way it does everywhere else.
 */
function foldedEnv(context: Context): ValueEnv {
  const scopes: TypeEnv[] = [];
  let scope: TypeEnv | null = context.types;
  while (scope !== null) {
    scopes.unshift(scope);
    scope = scope.parent;
  }
  const env = childEnv(context.values);
  for (const each of scopes) {
    for (const [name, found] of each.folded) {
      if (found.typing !== lookupType(context.types, name)) continue;
      env.names.set(name, found.value);
    }
  }
  return env;
}

/** Pairs a name's compile-time value with the `Typing` installed beside it. */
function recordComptimeBinding(
  scope: TypeEnv,
  name: string,
  value: Value,
): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.comptime.set(name, { value, typing });
}

/** Pairs a known array length with the binding that keeps that value. */
function recordArrayLength(
  scope: TypeEnv,
  name: string,
  length: RefinementTerm,
): void {
  const typing = scope.names.get(name);
  if (typing === undefined) return;
  scope.arrayLengths.set(name, { length, typing });
}

export function lookupArrayLength(
  env: TypeEnv,
  name: string,
): RefinementTerm | null {
  const typing = lookupType(env, name);
  if (typing === undefined) return null;
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.arrayLengths.get(name);
    if (found !== undefined) {
      if (found.typing !== typing) return null;
      return found.length;
    }
    scope = scope.parent;
  }
  return null;
}

function lookupLiteral(env: TypeEnv, name: string): Expr | undefined {
  let scope: TypeEnv | null = env;
  while (scope !== null) {
    const found = scope.literals.get(name);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

/**
 * The fact reads a compilation owes, and the instantiation copies that answer
 * them.
 *
 * A field set is not a property of the module that wrote the projection.
 * `fn c => c.zoom` demands one field; the record that reaches `c` is built by
 * whoever calls the function, and that caller is often in another file. Reading
 * the set when the defining module finishes checking would pin it to the local
 * demand, so lowering would mint a one-field nominal for a value the caller
 * built with two.
 *
 * So the reads are held until every module in the compilation has been checked,
 * and every module shares this one registry of copies — a dependency's
 * definition-site variable and its importer's instantiation of it have to be
 * the same edge for the read to find the record at all.
 *
 * One of these per root check, which is what keeps it bounded and what keeps
 * one compilation's records out of another's. Hanging the edge off the
 * `Variable` instead would attach unbounded growth to `PRIMITIVE_TYPES`, whose
 * scheme variables are process-global and outlive every check.
 */
export interface Staging {
  readonly instances: Instances;
  readonly reads: (() => void)[];
  /** A module may use its live context only while its own body is being checked. */
  readonly activeOrigins: Map<object, Context>;
  /** Closed lexical interfaces used to type closures imported from completed modules. */
  readonly interfaces: Map<object, SpecializationInterface>;
}

export function newStaging(): Staging {
  return {
    instances: new Map(),
    reads: [],
    activeOrigins: new Map(),
    interfaces: new Map(),
  };
}

interface SpecializationInterface {
  readonly declarationIdentity: string;
  readonly types: TypeEnv;
  readonly values: ValueEnv;
  readonly imports: Imports;
  readonly modules: ReadonlyMap<string, SimpleType>;
  readonly parameterName: string | null;
}

/** Loader identities change with any source, include, or transitive import revision. */
const specializationInterfaces = new WeakMap<
  object,
  SpecializationInterface
>();

/**
 * Answer every held read. A compilation settles once, at its root, because that
 * is the first moment no further constraint can arrive.
 */
export function settle(staging: Staging): void {
  for (const read of staging.reads) read();
  staging.reads.length = 0;
}

export interface Context {
  /** The phase whose expressions are currently being inferred. */
  readonly phase: "runtime" | "comptime";
  /** A function body may defer a local `const` until a concrete specialization. */
  readonly deferComptimeBindings: boolean;
  /** Settled type terms produced by this inference run, keyed by expression identity. */
  readonly expressionTypes: Map<Expr, SimpleType>;
  /** Erasable evidence for direct array accesses proved in bounds. */
  readonly arrayProofs: Map<Expr, ArrayIndexProof>;
  /** Erased relationship packages produced and projected by runtime expressions. */
  readonly expressionRelations: Map<Expr, RelationalValue>;
  /** Field sets and constructor sets, recorded for the backend. */
  readonly shapes: Map<Expr, Shape>;
  readonly recordAdaptations: Map<Expr, RecordAdaptation>;
  readonly optionalCases: Set<Expr>;
  /** Compile-time declaration values, keyed by their source expression. */
  readonly comptimeValues: Map<Expr, Value>;
  /**
   * What a member call produced while being typed, keyed by the call.
   *
   * Read only where a declaration turns it into a `folded` binding. Separate
   * from `comptimeValues` because that map is the backend's record of which
   * declarations are compile-time, and a member call in a `let` is not one.
   */
  readonly memberValues: Map<Expr, Value>;
  /**
   * Constraints this module still owes, applied once its own body has been
   * inferred. Its row is read at the module boundary right after, so these
   * cannot wait for the compilation the way a fact read does.
   */
  readonly pending: (() => void)[];
  /** Fact reads and instantiation copies for the whole compilation. */
  readonly staging: Staging;
  readonly variants: Map<Expr, readonly VariantCase[]>;
  readonly patternShapes: Map<Pattern, Shape>;
  readonly pinnedPatterns: Map<Pattern, PinnedDomain>;
  /** Stable value identities introduced by source patterns. */
  readonly patternBindings: Map<Pattern, number>;
  /** Bindings proved to be handler continuations by a checked `@handle`. */
  readonly continuationBindings: Set<number>;
  /** Affine or linear bindings that may later prove to be continuations. */
  readonly continuationCandidates: Set<number>;
  /** Direct cancellation sites, validated after every handler is known. */
  readonly cancelledContinuations: Map<Expr, number>;
  readonly grants: Map<Expr, GrantSignature>;
  /** The entry module's parameter name, when it has one. */
  parameterName: string | null;
  /** Bindings supplied afresh by each application of this source module. */
  readonly moduleParameters: ReadonlySet<string>;
  readonly types: TypeEnv;
  /** Comptime bindings, for bridging `sig` expressions and `const` values. */
  readonly values: ValueEnv;
  readonly imports: Imports;
  /** Checked types of imported modules, keyed by the specifier as written. */
  readonly modules: ReadonlyMap<string, SimpleType>;
  readonly opens: Map<Expr, ReadonlyMap<string, Value>>;
  readonly declarationTags: Map<Decl, TaggedDeclaration>;
  /**
   * The names the declaration lists being checked have still to bind, innermost
   * and enclosing together.
   *
   * Read only to tell one unbound name from another. Declarations bind in
   * source order, so a name that is bound further down is not a typo but an
   * ordering mistake, and the two deserve different sentences. An enclosing
   * list counts because a nested block is inside one of its declarations: a
   * name that block reads too early is early for the same reason.
   */
  forward: ReadonlySet<string>;
}

const CONTINUATION_CANCEL_EFFECT = "@continuation.cancel";

export function primitiveName(
  expr: Expr,
  context: Context,
): string | null {
  if (expr.tag === "intrinsic") return expr.name;
  if (expr.tag === "var") {
    const value = lookupComptime(context.types, expr.name);
    if (value !== null && value.tag === "primitive") return value.name;
    return null;
  }
  if (expr.tag !== "field" || expr.target.tag !== "var") return null;
  const target = lookupComptime(context.types, expr.target.name);
  if (target === null) return null;
  let member: Value | undefined;
  if (target.tag === "shape") member = target.fields.get(expr.name);
  if (target.tag === "extended") member = target.members.get(expr.name);
  if (member === undefined || member.tag !== "primitive") return null;
  return member.name;
}

function refuseCancellationValue(expr: Expr, context: Context): void {
  if (context.phase !== "runtime") return;
  if (primitiveName(expr, context) !== "@continuation.cancel") return;
  fail(
    "BLOT_CANCEL_NOT_DIRECT",
    "`Continuation.cancel` is an operational form and cannot be stored or passed as a first-class function. Apply it directly to a handler continuation.",
    expr.span,
  );
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
function comptime(
  expr: Expr,
  context: Context,
  values: ValueEnv = context.values,
): ReturnType<typeof run> | null {
  try {
    return run(
      evaluate(
        expr,
        values,
        evaluationRuntime(
          context.imports,
          "comptime",
          undefined,
          context.recordAdaptations,
        ),
      ),
    );
  } catch (error) {
    // A refusal is the program asking to fail, not the evaluator failing to
    // reach a value. Swallowing it would make `expect` silent at `blot check`
    // and only speak at `blot run`, which is the wrong half of the compiler.
    rethrowRefusal(error, expr.span);
    return null;
  }
}

/**
 * A refusal is raised where `@fail` runs, which is inside whichever module
 * defined the predicate — for `expect` that is the prelude. Its span therefore
 * indexes a file the user did not write, while the module being checked is the
 * one that claims the origin, so the pair renders as a line that does not
 * exist. The message belongs to the program and the location belongs to the
 * caller: re-span to the expression that triggered it.
 */
function rethrowRefusal(error: unknown, span: Span): void {
  if (error instanceof BlotError && error.diagnostic.code === "BLOT_REFUSED") {
    throw new BlotError({ ...error.diagnostic, span });
  }
}

function requireComptime(
  expr: Expr,
  context: Context,
  what: string,
): ReturnType<typeof run> {
  try {
    return run(
      evaluate(
        expr,
        context.values,
        evaluationRuntime(
          context.imports,
          "comptime",
          undefined,
          context.recordAdaptations,
        ),
      ),
    );
  } catch (error) {
    rethrowRefusal(error, expr.span);
    if (
      error instanceof BlotError &&
      (error.diagnostic.code === "BLOT_UNBOUND" ||
        error.diagnostic.code === "BLOT_UNHANDLED_EFFECT")
    ) {
      fail(
        "BLOT_NOT_COMPTIME",
        `${what} must be known at compile time: ${error.diagnostic.message}`,
        expr.span,
      );
    }
    throw error;
  }
}

function requireComptimeBinding(
  pattern: Pattern,
  expr: Expr,
  context: Context,
): ReturnType<typeof run> | null {
  try {
    return run(
      bind(
        pattern,
        expr,
        context.values,
        evaluationRuntime(
          context.imports,
          "comptime",
          undefined,
          context.recordAdaptations,
        ),
      ),
    );
  } catch (error) {
    rethrowRefusal(error, expr.span);
    if (
      error instanceof BlotError &&
      (error.diagnostic.code === "BLOT_UNBOUND" ||
        error.diagnostic.code === "BLOT_UNHANDLED_EFFECT")
    ) {
      if (context.deferComptimeBindings) return null;
      fail(
        "BLOT_NOT_COMPTIME",
        `A \`const\` binding must be known at compile time: ${error.diagnostic.message}`,
        expr.span,
      );
    }
    throw error;
  }
}

/**
 * A closure created for a `const` is hoisted out of the runtime frame. Its own
 * parameters and locals remain legal because they are bound inside the
 * closure; only a free name that resolves to a runtime binding is unavailable.
 */
function refuseRuntimeConstCaptures(
  pattern: Pattern,
  value: Value,
  context: Context,
  span: Span,
): void {
  const seen = new Set<Value>();
  const inspect = (candidate: Value): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (candidate.tag === "closure" && candidate.source !== undefined) {
      for (const name of freeNames(candidate.source)) {
        if (name === candidate.self) continue;
        if (lookupBindingPhase(context.types, name) !== "runtime") continue;
        let binding = "this compile-time closure";
        if (pattern.tag === "name") {
          binding = `the compile-time closure \`${pattern.name}\``;
        }
        let captureSpan = freeNameSpan(candidate.source, name);
        if (captureSpan === null) captureSpan = span;
        fail(
          "BLOT_CONST_CAPTURES_RUNTIME",
          `\`${name}\` is a runtime binding, so it has no value at compile time and ${binding} cannot capture it. Write a \`let\` binding for the closure, or make \`${name}\` available with \`const\`.`,
          captureSpan,
        );
      }
      return;
    }
    switch (candidate.tag) {
      case "shape":
        for (const member of candidate.fields.values()) inspect(member);
        return;
      case "array":
        for (const element of candidate.elements) inspect(element);
        return;
      case "region-type":
        inspect(candidate.element);
        return;
      case "deferred-type":
        inspect(candidate.inner);
        return;
      case "region-array":
      case "region-rejoin":
        for (const element of candidate.store.cells) inspect(element);
        return;
      case "tag":
        if (candidate.payload !== null) inspect(candidate.payload);
        return;
      case "primitive":
      case "native":
        for (const argument of candidate.applied) inspect(argument);
        return;
      case "range":
        inspect(candidate.low);
        inspect(candidate.high);
        return;
      case "union":
        for (const member of candidate.members) inspect(member);
        return;
      case "arrow":
        inspect(candidate.domain);
        inspect(candidate.codomain);
        for (const effect of candidate.effects) inspect(effect);
        return;
      case "forall":
        inspect(candidate.body);
        return;
      case "effect":
        for (const operation of candidate.operations.values()) {
          inspect(operation);
        }
        return;
      case "operation":
        inspect(candidate.effect);
        return;
      case "extended":
        inspect(candidate.inner);
        for (const member of candidate.members.values()) inspect(member);
        return;
      case "sealed":
        inspect(candidate.inner);
        return;
      default:
        return;
    }
  };
  inspect(value);
}

/** Finds the source read represented by `freeNames`, preserving inner binders. */
function freeNameSpan(expr: Expr, name: string): Span | null {
  if (!freeNames(expr).has(name)) return null;
  const find = (candidate: Expr): Span | null => {
    if (!freeNames(candidate).has(name)) return null;
    return freeNameSpan(candidate, name);
  };
  switch (expr.tag) {
    case "var": {
      if (expr.name === name) return expr.span;
      return null;
    }
    case "apply": {
      const fn = find(expr.fn);
      if (fn !== null) return fn;
      return find(expr.arg);
    }
    case "field":
      return find(expr.target);
    case "lambda":
      return find(expr.body);
    case "rec":
      return find(expr.lambda);
    case "comptime":
      return find(expr.body);
    case "tuple":
      for (const element of expr.elements) {
        const found = find(element);
        if (found !== null) return found;
      }
      return null;
    case "array":
      for (const element of expr.elements) {
        const found = find(element.value);
        if (found !== null) return found;
      }
      return null;
    case "shape":
      for (const member of expr.members) {
        const found = find(member.value);
        if (found !== null) return found;
      }
      return null;
    case "if":
      for (const branch of expr.branches) {
        const condition = find(branch.condition);
        if (condition !== null) return condition;
        const consequence = find(branch.consequence);
        if (consequence !== null) return consequence;
      }
      if (expr.fallback === null) return null;
      return find(expr.fallback);
    case "case": {
      const target = find(expr.target);
      if (target !== null) return target;
      for (const arm of expr.arms) {
        if (patternNames(arm.pattern).includes(name)) continue;
        const found = find(arm.body);
        if (found !== null) return found;
      }
      return null;
    }
    case "block":
      for (const declaration of expr.declarations) {
        const found = find(declaration.value);
        if (found !== null) return found;
        if (
          (declaration.tag === "shadow" && declaration.name === name) ||
          (declaration.tag === "binding" &&
            patternNames(declaration.pattern).includes(name))
        ) return null;
      }
      return find(expr.result);
    default:
      return null;
  }
}

export function infer(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  const type = inferUnrecorded(expr, context, level, row);
  context.expressionTypes.set(expr, type);
  recordExpressionRelation(expr, context);
  return type;
}

function functionDeferredness(
  type: SimpleType,
  seen = new Set<number>(),
): boolean | null {
  if (type.tag === "fun") return type.deferred === true;
  if (type.tag === "forall") return functionDeferredness(type.body, seen);
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  let answer: boolean | null = null;
  for (const bound of [...type.lower, ...type.upper]) {
    const found = functionDeferredness(bound, seen);
    if (found === null) continue;
    if (answer !== null && answer !== found) return null;
    answer = found;
  }
  return answer;
}

function inferUnrecorded(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  switch (expr.tag) {
    case "int":
      if (
        context.phase === "runtime" &&
        (expr.value < I64_LOW || expr.value > I64_HIGH)
      ) {
        fail(
          "BLOT_RUNTIME_INTEGER_RANGE",
          `Runtime integer ${expr.value} is outside signed i64 ${I64_LOW}..${I64_HIGH}. Keep it in a \`const\` storage descriptor, or add a distinct word type before using it at run time.`,
          expr.span,
        );
      }
      return intLiteral(expr.value);
    case "float":
      return FLOAT;
    case "text":
      return textLiteral(expr.value);
    case "unit":
      return UNIT;

    case "var": {
      refuseCancellationValue(expr, context);
      const found = lookupType(context.types, expr.name);
      if (found === undefined) {
        if (context.forward.has(expr.name)) {
          fail(
            "BLOT_FORWARD_REFERENCE",
            `\`${expr.name}\` is bound further down, so it is not in scope here. Declarations are evaluated in order: move the binding above this one, or — if the two call each other — write both as \`rec\` bindings of functions with nothing between them.`,
            expr.span,
          );
        }
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return instantiate(found, level, context.staging.instances);
    }

    case "intrinsic": {
      refuseCancellationValue(expr, context);
      if (expr.name === "@include" && context.phase !== "comptime") {
        fail(
          "BLOT_INCLUDE_NOT_COMPTIME",
          "`@include` is compile-time-only; bind its result with `const`.",
          expr.span,
        );
      }
      if (expr.name === "@json.parse" && context.phase !== "comptime") {
        fail(
          "BLOT_JSON_NOT_COMPTIME",
          "`@json.parse` is compile-time-only; bind its result with `const`.",
          expr.span,
        );
      }
      if (expr.name === "@array.get" || expr.name === "@array.set") {
        fail(
          "BLOT_ARRAY_ACCESS_NOT_DIRECT",
          `\`${expr.name}\` must be fully applied at its use site so the checker can attach a bounds proof. Use the total prelude operation when the index is not proved there.`,
          expr.span,
        );
      }
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
      return instantiate(primitive, level, context.staging.instances);
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

      const applied = inferMemberApplication(expr, context, level, row);
      if (applied !== null) return applied;

      const fnType = infer(expr.fn, context, level, row);
      const deferred = functionDeferredness(fnType) === true;
      const argType = deferred
        ? inferPure(expr.arg, context, level, "A deferred argument")
        : infer(expr.arg, context, level, row);
      requireEvidencedRuntimeType(argType, expr.arg, context);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(fnType, {
          tag: "fun",
          param: argType,
          effects: row,
          result,
          deferred: deferred || undefined,
        });
      });
      recordApplicationAdaptation(expr.arg, fnType, argType, context);
      return result;
    }

    case "field": {
      refuseCancellationValue(expr, context);
      // A type value's namespace is compile-time, and the ordinary field rule
      // does not describe it: `Point` bridges to its storage, so `.new` is not
      // a field of the type and asking for one would be a false error. When
      // the target is a name bound to such a value and the name is a member,
      // the member decides.
      const member = compileTimeMemberOf(expr, context);
      if (member !== null && !member.ordinary) {
        context.comptimeValues.set(expr, member.value);
        const bridged = bridge(member.value);
        if (bridged !== null) return bridged;
        if (member.value.tag === "shape") {
          const computed = typeComputedValue(member.value, context, level);
          if (computed !== null) {
            return instantiate(computed, level, context.staging.instances);
          }
        }
        // A namespace closure with no recoverable defining scope has no arrow
        // to read off the value. A variable would be the opposite claim,
        // because every constraint on it is satisfiable and a `sig` naming any
        // type at all would then be believed without being checked.
        return TOP;
      }
      const target = infer(expr.target, context, level, row);
      requireEvidencedRuntimeType(target, expr.target, context);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(target, record([[expr.name, result]]));
      });
      // Record what the target's whole field set is, if it is known. Lowering
      // cannot see it and cannot build the nominal without it. Held until the
      // compilation settles, because a later use may add a field this one does
      // not mention — and because a generalized projection learns its shape
      // from call sites that may not even be in this file.
      context.staging.reads.push(() => {
        const shape = shapeOf(target, context.staging.instances);
        if (shape !== null) context.shapes.set(expr, shape);
      });
      // A projection off the module parameter is a granted capability. Read
      // after checking, because the signature comes from how the program
      // *uses* it and at the projection nothing has used it yet.
      if (
        expr.target.tag === "var" &&
        expr.target.name === context.parameterName
      ) {
        context.staging.reads.push(() => {
          const signature = arrowOf(result);
          if (signature !== null) context.grants.set(expr, signature);
        });
      }
      return result;
    }

    case "lambda": {
      const scope = childTypeEnv(context.types);
      const inner: Context = {
        ...context,
        types: scope,
        deferComptimeBindings: true,
      };
      let parameterPhase: "runtime" | "comptime" = "runtime";
      if (expr.deferred === true) parameterPhase = "comptime";
      const parameterContext: Context = {
        ...inner,
        phase: parameterPhase,
      };
      const param = bindPattern(expr.parameter, parameterContext, level);
      // A fresh row per lambda is what makes the inferred effect minimal:
      // nothing becomes effectful because something else nearby was.
      const bodyRow = freshVar(level);
      let result: SimpleType;
      if (expr.body.tag === "block" || isReturnScopeBoundary(expr.body)) {
        result = infer(expr.body, inner, level, bodyRow);
      } else {
        result = inferPure(
          expr.body,
          inner,
          level,
          "A function result",
        );
      }
      if (expr.deferred === true) {
        return { tag: "fun", param, effects: bodyRow, result, deferred: true };
      }
      return { tag: "fun", param, effects: bodyRow, result };
    }

    case "rec": {
      if (expr.lambda.tag !== "lambda") {
        // The names of a recursive group are in scope throughout it but hold
        // no value until the whole group is bound, so a member that is not a
        // function would have to read one of them before it exists.
        fail(
          "BLOT_TYPE_ERROR",
          "`rec` applies to a lambda: a recursive binding is a function, because its group's names are in scope before any of them has a value.",
          expr.span,
        );
      }
      return infer(expr.lambda, context, level, row);
    }

    case "comptime": {
      const value = requireComptime(
        expr.body,
        context,
        "A `comptime` expression",
      );
      context.comptimeValues.set(expr.body, value);
      const bridged = bridge(value);
      if (bridged !== null) return bridged;
      return infer(expr.body, context, level, row);
    }

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
      const written = new Set<string>();
      for (const member of expr.members) {
        const memberType = infer(member.value, context, level, row);
        if (member.tag === "field") {
          if (written.has(member.name)) {
            fail(
              "BLOT_DUPLICATE_FIELD",
              `Field \`.${member.name}\` is written more than once in this shape.`,
              member.value.span,
            );
          }
          written.add(member.name);
          fields.set(member.name, memberType);
          continue;
        }
        // A spread contributes whatever the spread value holds, and the
        // backend has to copy those fields one by one — so record the set.
        context.staging.reads.push(() => {
          const spread = shapeOf(memberType, context.staging.instances);
          if (spread !== null) context.shapes.set(member.value, spread);
        });
        if (memberType.tag === "record") {
          for (const [name, inner] of memberType.fields) {
            fields.set(name, inner);
          }
          continue;
        }
        // A spread of a shape whose fields are not statically known contributes
        // no names, which is honest about what it adds and silent about what it
        // may *replace*. A later spread overrides an earlier field, so the
        // fields written before this one are no longer known to survive it:
        // `{ .tag = 1; ...r; }` has whatever `.tag` `r` carries, and typing it
        // `1` is a claim the run refutes rather than a type the checker merely
        // failed to widen. Width subtyping is why nothing here can rule it out —
        // a value typed `{ .x = Int; }` may carry a `.tag` as well — so the
        // shape is refused where it is written.
        if (fields.size > 0) {
          fail(
            "BLOT_SPREAD_MAY_OVERWRITE",
            `This spread may carry a field already written in this shape — ${
              [...fields.keys()].map((name) => `\`.${name}\``).join(", ")
            } — and its own fields are not known here, so which value wins is not decided until the program runs. Write the spread before those fields, or name the fields you want from it.`,
            member.value.span,
          );
        }
      }
      return record(fields);
    }

    case "if": {
      const result = freshVar(level);
      // `else if` is one flat chain of branches, so the knowledge accumulates:
      // branch `i` is inferred already knowing that branches `0..i-1` did not
      // fire, and the fallback knows that none of them did. `outer` is that
      // running scope.
      let outer = context.types;
      for (const branch of expr.branches) {
        const scoped: Context = { ...context, types: outer };
        const condition = infer(branch.condition, scoped, level, row);
        located(branch.condition.span, () => {
          constrain(condition, variant([["True", UNIT], ["False", UNIT]]));
        });
        const proof = narrowing(branch.condition, outer);
        const consequence = infer(
          branch.consequence,
          { ...context, types: proven(outer, proof, "taken") },
          level,
          row,
        );
        located(branch.consequence.span, () => constrain(consequence, result));
        outer = proven(outer, proof, "untaken");
      }
      if (expr.fallback !== null) {
        const inner: Context = { ...context, types: outer };
        const fallback = infer(expr.fallback, inner, level, row);
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
      if (expr.resultEffects === "pure") {
        return inferPure(expr.result, inner, level, "This value");
      }
      return infer(expr.result, inner, level, row);
    }
  }
}

function inferSpecial(
  expr: Expr & { tag: "apply" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType | null {
  let head = spine(expr);
  if (head === null) return null;
  const callee = head.callee;
  const resolvedPrimitive = primitiveName(callee, context);
  if (resolvedPrimitive === "@i32x4.lane" && head.args.length === 2) {
    const selector = head.args[1];
    const lane = comptimeInt(selector, context.types);
    if (lane === null) {
      fail(
        "BLOT_SIMD_IMMEDIATE_NOT_COMPTIME",
        "An SIMD lane selector must be known at compile time. Bind it with `const`, or use `.x`, `.y`, `.z`, or `.w`.",
        selector.span,
      );
    }
    if (lane < 0n || lane > 3n) {
      fail(
        "BLOT_SIMD_IMMEDIATE_RANGE",
        `I32x4 lane ${lane} is outside 0..3.`,
        selector.span,
      );
    }
    context.comptimeValues.set(selector, { tag: "int", value: lane });
  }
  let handleTuple: (Expr & { tag: "tuple" }) | null = null;
  if (
    primitiveName(callee, context) === "@continuation.cancel" &&
    head.args.length === 1
  ) {
    const primitive = PRIMITIVE_TYPES.get("@continuation.cancel");
    if (primitive === undefined) {
      throw new Error("missing continuation cancellation primitive type");
    }
    if (callee.tag === "field") {
      infer(callee.target, context, level, row);
    }
    context.expressionTypes.set(
      callee,
      instantiate(primitive, level, context.staging.instances),
    );
    const continuation = head.args[0];
    if (continuation.tag !== "var") {
      fail(
        "BLOT_CANCEL_NOT_CONTINUATION",
        "`Continuation.cancel` must consume a named handler continuation.",
        continuation.span,
      );
    }
    const identity = lookupBinding(context.types, continuation.name);
    if (identity === null) {
      fail(
        "BLOT_CANCEL_NOT_CONTINUATION",
        `\`${continuation.name}\` does not identify a handler continuation.`,
        continuation.span,
      );
    }
    if (!context.continuationCandidates.has(identity)) {
      fail(
        "BLOT_CANCEL_NOT_CONTINUATION",
        `\`${continuation.name}\` is not an affine or linear handler continuation.`,
        continuation.span,
      );
    }
    infer(continuation, context, level, row);
    located(expr.span, () => {
      constrain(effects([CONTINUATION_CANCEL_EFFECT]), row);
    });
    context.cancelledContinuations.set(expr, identity);
    return UNIT;
  }
  if (callee.tag !== "intrinsic") return null;

  if (callee.name === "@include" && head.args.length >= 1) {
    if (context.phase !== "comptime") {
      fail(
        "BLOT_INCLUDE_NOT_COMPTIME",
        "`@include` is compile-time-only; bind its result with `const`.",
        expr.span,
      );
    }
    if (head.args[0].tag !== "text") {
      fail(
        "BLOT_INCLUDE_PATH",
        "`@include` requires a literal text path.",
        head.args[0].span,
      );
    }
    if (head.args.length === 2) {
      const included = comptime(expr, context, foldedEnv(context));
      if (included === null) {
        fail(
          "BLOT_INCLUDE_NOT_COMPTIME",
          "The `@include` parser and its result must be known at compile time.",
          expr.span,
        );
      }
      context.comptimeValues.set(expr, included);
    }
  }

  if (callee.name === "@json.parse" && context.phase !== "comptime") {
    fail(
      "BLOT_JSON_NOT_COMPTIME",
      "`@json.parse` is compile-time-only; bind its result with `const`.",
      expr.span,
    );
  }

  const comptimeIntegerArity = COMPTIME_INTEGER_ARITIES.get(callee.name);
  if (
    context.phase === "comptime" &&
    comptimeIntegerArity === head.args.length
  ) {
    for (const argument of head.args) infer(argument, context, level, row);
    const value = comptime(expr, context, foldedEnv(context));
    if (value !== null) {
      const exact = bridge(value);
      if (exact !== null) return exact;
    }
  }

  if (
    (callee.name === "@effect" || callee.name === "@effect.host") &&
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
  if (callee.name === "@import" && head.args.length >= 1) {
    const specifier = head.args[0];
    if (specifier.tag !== "text") return null;
    const moduleType = context.modules.get(specifier.value);
    if (moduleType === undefined) return null;
    let result = instantiate(
      scheme(moduleType, -1),
      level,
      context.staging.instances,
    );
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

  // Direct indexed access is the proof-carrying path. Total access lives in
  // prelude source and reaches this primitive only inside its successful guard.
  if (
    (callee.name === "@array.get" || callee.name === "@array.set") &&
    head.args.length >= 2
  ) {
    const proof = requireProvenIndex(
      expr,
      head.args[0],
      head.args[1],
      context.types,
    );
    context.arrayProofs.set(expr, proof);
    const arrayType = infer(head.args[0], context, level, row);
    const indexType = infer(head.args[1], context, level, row);
    const element = freshVar(level);
    const result: SimpleType = { tag: "array", element };
    located(expr.span, () => {
      constrain(arrayType, result);
      constrain(indexType, INT);
    });
    if (callee.name === "@array.get" && head.args.length === 2) {
      return element;
    }
    if (callee.name === "@array.set" && head.args.length === 3) {
      const valueType = infer(head.args[2], context, level, row);
      located(expr.span, () => constrain(valueType, element));
      return result;
    }
  }

  if (callee.name === "@type.reflect" && head.args.length === 1) {
    infer(head.args[0], context, level, row);
    const reflected = comptime(expr, context, foldedEnv(context));
    if (reflected !== null) {
      const exact = bridge(reflected);
      if (exact === null) {
        throw new Error("a reflected compile-time value has no inferred type");
      }
      return exact;
    }
  }

  if (SHAPE_PROJECTIONS.get(callee.name) === head.args.length) {
    return inferShapeProjection(
      expr,
      callee.name,
      head.args,
      context,
      level,
      row,
    );
  }

  if (callee.name === "@handle" && head.args.length === 1) {
    const parts = head.args[0];
    if (parts.tag !== "tuple" || parts.elements.length !== 3) {
      fail(
        "BLOT_TYPE_ERROR",
        "`@handle` takes `(effect, computation, handler)`.",
        expr.span,
      );
    }
    handleTuple = parts;
    head = { callee: head.callee, args: [...parts.elements] };
  }

  if (callee.name === "@handle" && head.args.length === 3) {
    // `@handle` names the effect it discharges, so the row arithmetic is real:
    // everything the computation performs *except* that effect still has to be
    // handled somewhere, and flows on into the ambient row.
    const effect = comptime(head.args[0], context);
    if (effect === null || effect.tag !== "effect") {
      fail(
        "BLOT_TYPE_ERROR",
        "`@handle` takes the effect it discharges as its first argument.",
        head.args[0].span,
      );
    }
    const discharged = effectLabel(effect);
    const effectType = infer(head.args[0], context, level, row);
    let handlerExpression: Expr | undefined = head.args[2];
    if (handlerExpression.tag === "var") {
      handlerExpression = lookupLiteral(context.types, handlerExpression.name);
    }
    if (handlerExpression === undefined || handlerExpression.tag !== "shape") {
      fail(
        "BLOT_TYPE_ERROR",
        "A handler must be a statically known shape of clauses.",
        head.args[2].span,
      );
    }
    const resumePatterns: Pattern[] = [];
    for (const member of handlerExpression.members) {
      if (member.tag !== "field" || member.name === "return") continue;
      const clause = member.value;
      let resume: Pattern | undefined;
      if (clause.tag === "lambda" && clause.parameter.tag === "tuple") {
        resume = clause.parameter.elements[1];
      }
      if (
        resume === undefined || resume.tag !== "name" ||
        (resume.qualifier !== "affine" && resume.qualifier !== "linear")
      ) {
        fail(
          "BLOT_HANDLER_RESUME_NOT_AFFINE",
          `Handler clause \`.${member.name}\` must bind its continuation as \`?resume\`, or as \`!resume\` when aborting would discard a linear resource.`,
          clause.span,
        );
      }
      resumePatterns.push(resume);
    }

    const thunkRow = freshVar(level);
    const handlerRow = freshVar(level);
    const thunk = infer(head.args[1], context, level, row);
    const handler = infer(head.args[2], context, level, row);
    for (const resume of resumePatterns) {
      const identity = context.patternBindings.get(resume);
      if (identity === undefined) {
        throw new Error("a checked handler resume has no binding identity");
      }
      context.continuationBindings.add(identity);
    }
    const computationResult = freshVar(level);
    const handledResult = freshVar(level);

    located(expr.span, () => {
      constrain(thunk, {
        tag: "fun",
        param: UNIT,
        effects: thunkRow,
        result: computationResult,
      });
      // A clause per operation, each taking `(argument, resume)`. Checking the
      // handler against the effect is what makes a typo in an operation name a
      // type error rather than a silent no-op at run time.
      for (const [name, signature] of effect.operations) {
        let bridged = bridge(signature);
        if (bridged !== null && bridged.tag === "forall") {
          bridged = instantiateForall(bridged, level);
        }
        if (bridged === null || bridged.tag !== "fun") continue;
        const clause = freshVar(level);
        constrain(handler, record([[name, clause]]));
        const continuation = {
          tag: "fun" as const,
          param: bridged.result,
          effects: handlerRow,
          result: handledResult,
        };
        constrain(clause, {
          tag: "fun",
          param: tupleType([bridged.param, continuation]),
          effects: handlerRow,
          result: handledResult,
        });
      }
      const handlerShape = shapeOf(handler, context.staging.instances);
      if (
        handlerShape !== null && handlerShape.tag === "fields" &&
        handlerShape.fields.includes("return")
      ) {
        const returnClause = freshVar(level);
        constrain(handler, record([["return", returnClause]]));
        constrain(returnClause, {
          tag: "fun",
          param: computationResult,
          effects: handlerRow,
          result: handledResult,
        });
      } else {
        constrain(computationResult, handledResult);
      }
    });

    // Whatever the computation performs beyond this effect is still owed.
    context.pending.push(() => {
      const remaining = rowLabels(thunkRow, new Set()).filter((label) =>
        label !== discharged
      );
      if (remaining.length > 0) {
        located(expr.span, () => constrain(effects(remaining), row));
      }
      const clauseEffects = rowLabels(handlerRow, new Set()).filter((label) =>
        label !== CONTINUATION_CANCEL_EFFECT
      );
      if (clauseEffects.length > 0) {
        located(expr.span, () => constrain(effects(clauseEffects), row));
      }
    });
    if (handleTuple !== null) {
      const argumentType = tupleType([effectType, thunk, handler]);
      context.expressionTypes.set(handleTuple, argumentType);
      context.expressionTypes.set(callee, {
        tag: "fun",
        param: argumentType,
        effects: row,
        result: handledResult,
      });
    }
    return handledResult;
  }

  // Does this expression's *inferred* type satisfy a compile-time predicate?
  //
  // Distinct from `@satisfies`, which asks whether a compile-time value
  // inhabits a type. This asks a question about the type itself — has it an
  // `.a`, is it a record at all — and the type of an expression that is not
  // itself compile-time lives only in the lattice, so it has to be reified
  // before a predicate can be handed it. `@type.of` cannot stand in: it answers
  // the type of a *value*, so it evaluates one, and on a runtime expression
  // that is an unhandled effect rather than a type.
  // Takes a tuple rather than being curried, for the reason `@handle` does:
  // the checker has to see the whole call to type it at all, and a partially
  // applied one would be a closure whose parameter is not a compile-time value.
  if (
    callee.name === "@type.satisfies" && head.args.length === 1 &&
    head.args[0].tag === "tuple" && head.args[0].elements.length === 2
  ) {
    const [subjectExpr, predicateExpr] = head.args[0].elements;
    const valueType = infer(subjectExpr, context, level, row);
    const subject = reify(valueType);
    if (subject === null) {
      fail(
        "BLOT_TYPE_NOT_REIFIABLE",
        `\`${
          showType(valueType)
        }\` has no compile-time reading, so a predicate cannot be given it. An inference variable, an effect row, and an open variant are the usual reasons.`,
        subjectExpr.span,
      );
    }
    const predicate = comptime(predicateExpr, context);
    if (predicate === null) {
      fail(
        "BLOT_SIG_NOT_COMPTIME",
        "The second argument to `@type.satisfies` must be a compile-time function from a type to a `Bool`.",
        predicateExpr.span,
      );
    }
    const answer = comptimeApply(
      predicate,
      subject,
      context,
      predicateExpr.span,
    );
    if (answer === null || answer.tag !== "tag") {
      fail(
        "BLOT_TYPE_ERROR",
        "The predicate given to `@type.satisfies` must answer `#True` or `#False`.",
        predicateExpr.span,
      );
    }
    if (answer.name !== "True") {
      fail(
        "BLOT_DOES_NOT_SATISFY",
        `\`${showType(valueType)}\` does not satisfy the predicate.`,
        expr.span,
      );
    }
    return valueType;
  }

  if (callee.name === "@satisfies" && head.args.length === 2) {
    const valueType = infer(head.args[0], context, level, row);
    // A type this pass cannot evaluate is deferred, not refused: `struct`'s
    // `.new` names the field's type through a loop variable that only
    // specialization binds, and refusing here would refuse `struct` itself.
    const typeValue = comptime(head.args[1], context);
    if (typeValue === null) return null;
    // But one that evaluates to something which is not a type is refused. It
    // used to fall through to the ordinary scheme, which checks nothing — so
    // handing this a predicate rather than a type passed silently, and the
    // program went on believing it had been checked.
    const expected = bridge(typeValue);
    if (expected === null) {
      fail(
        "BLOT_TYPE_ERROR",
        `The second argument to \`@satisfies\` must be a type; this is ${
          show(typeValue)
        }. To ask a question *about* a type rather than to check a value against one, use \`@type.satisfies\`.`,
        head.args[1].span,
      );
    }
    located(expr.span, () => constrain(valueType, expected));
    return valueType;
  }

  return null;
}

/** Applies a compile-time function to a value the checker built. */
function comptimeApply(
  fn: Value,
  argument: Value,
  context: Context,
  span: Span,
): Value | null {
  try {
    return run(
      apply(
        fn,
        argument,
        span,
        evaluationRuntime(
          context.imports,
          "comptime",
          undefined,
          context.recordAdaptations,
        ),
      ),
    );
  } catch (error) {
    // A refusal is the program asking to fail and must reach the user. Anything
    // else means the predicate could not be run, which the caller reports.
    rethrowRefusal(error, span);
    return null;
  }
}

/** The shape primitives whose result no fixed scheme can describe. */
const SHAPE_PROJECTIONS: ReadonlyMap<string, number> = new Map([
  ["@shape.get", 2],
  ["@shape.set", 3],
  ["@shape.remove", 2],
]);

const COMPTIME_INTEGER_ARITIES: ReadonlyMap<string, number> = new Map([
  ["@int.add", 2],
  ["@int.sub", 2],
  ["@int.mul", 2],
  ["@int.div", 2],
  ["@int.rem", 2],
  ["@int.neg", 1],
  ["@int.cmp", 2],
  ["@text.of_int", 1],
]);

/**
 * `@shape.get`, `@shape.set` and `@shape.remove`, typed at their call site.
 *
 * These name their field with a value rather than with a literal, so the scheme
 * in `primitives.ts` cannot say what they produce and used to answer with an
 * unconstrained variable. That is not "the checker knows nothing" — every
 * constraint on a variable holds, so it is the most permissive claim the lattice
 * has, and `sig z = 0; let z = @shape.get r "a";` was believed for an `r` whose
 * `.a` is `7`.
 *
 * The name is what decides, and it is a compile-time value. Two rules read it,
 * in the order a call gets more specific:
 *
 *   * when the whole projection runs at compile time, what it produced is the
 *     type — the rule a member call already lives by, and sound for the same
 *     reason: the evaluator answering here is the one that will run the program;
 *   * otherwise, when the name alone is known, the call *is* an ordinary field
 *     projection and is typed as one, so the result is that field's type and a
 *     `sig` on it lands on the shape.
 *
 * A genuinely run-time name has no structural result type: heterogeneous
 * records do not have one element type, and width subtyping means even the full
 * field set is unknown. Such a lookup belongs on a homogeneous dictionary with
 * an `Option` result, not on a structural record, so it is rejected here.
 */
function inferShapeProjection(
  expr: Expr & { tag: "apply" },
  callee: string,
  args: readonly Expr[],
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  // The arguments are checked whether or not the projection can be decided.
  // They are ordinary expressions, and the field sets the backend reads are
  // recorded while inferring them.
  const argTypes = args.map((argument) => infer(argument, context, level, row));

  const value = comptime(expr, context, foldedEnv(context));
  if (value !== null) {
    const bridged = bridge(value);
    if (bridged !== null) return bridged;
  }

  const name = comptime(args[1], context, foldedEnv(context));
  if (name !== null && name.tag === "text") {
    if (callee === "@shape.get") {
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(argTypes[0], record([[name.value, result]]));
      });
      return result;
    }
    // `@shape.set` and `@shape.remove` answer with a whole shape rather than
    // with one field, so they need the fields the target has. A demand cannot
    // supply those — asking for one field says nothing about the rest — so this
    // rule speaks only when a record reached the argument.
    const fields = recordFields(argTypes[0], new Set());
    if (fields !== null) {
      const rebuilt = new Map(fields);
      if (callee === "@shape.remove") rebuilt.delete(name.value);
      else rebuilt.set(name.value, argTypes[2]);
      return record(rebuilt);
    }
  }

  if (context.phase === "comptime") {
    return freshVar(level, "dynamic-shape");
  }
  fail(
    "BLOT_DYNAMIC_SHAPE_FIELD",
    `\`${callee}\` requires a field name known at compile time. Use a structural projection with a literal name, or represent dynamic keys with a homogeneous dictionary.`,
    args[1].span,
  );
}

/** The record that reached a type, following what flowed into a variable. */
function recordFields(
  type: SimpleType,
  seen: Set<number>,
): ReadonlyMap<string, SimpleType> | null {
  if (type.tag === "record") return type.fields;
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  for (const bound of type.lower) {
    const found = recordFields(bound, seen);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A member reached through a compile-time namespace or record.
 *
 * The whole path is followed because generated namespaces commonly attach an
 * ordinary record of callable operations. Stopping after `World.Position`
 * would discard the structural type needed to type
 * `World.Position.insert entity`.
 *
 * Through `lookupComptime` rather than through the value environment, so a
 * runtime shadow of the root name is declined instead of read as the
 * compile-time one.
 */
function compileTimeMemberOf(
  expr: Expr & { tag: "field" },
  context: Context,
): { readonly value: Value; readonly ordinary: boolean } | null {
  const path: string[] = [];
  let current: Expr = expr;
  while (current.tag === "field") {
    path.unshift(current.name);
    current = current.target;
  }
  if (current.tag !== "var") return null;

  let value = lookupComptime(context.types, current.name);
  if (value === null) return null;
  let ordinary = false;
  for (const name of path) {
    if (value.tag === "extended") {
      const member = value.members.get(name);
      if (member === undefined) return null;
      value = member;
      ordinary = false;
      continue;
    }
    if (value.tag === "shape") {
      const member = value.fields.get(name);
      if (member === undefined) return null;
      value = member;
      ordinary = true;
      continue;
    }
    return null;
  }
  return { value, ordinary };
}

/**
 * A call to a member that is a function.
 *
 * The member itself has no type — see the `field` rule — so the call is typed by
 * *making* the value rather than by applying an arrow: a member is a
 * compile-time value, and when the arguments are compile-time values too the
 * whole application runs during checking and what it produces is the type. This
 * is the rule `const` already lives by, and it is sound for the same reason —
 * the evaluator answering here is the one that will run the program, an effect
 * performed at compile time fails rather than happens, and blot has no
 * assignment for the two runs to disagree about.
 *
 * When an argument is only known at run time there is no value to read, and `⊤`
 * says exactly that. It is the answer that costs the feature nothing it was
 * entitled to: `Point.x somewhere` was never given a type, only a variable that
 * agreed with whatever was asked of it.
 */
function inferMemberApplication(
  expr: Expr & { tag: "apply" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType | null {
  const head = spine(expr);
  if (head === null) return null;
  if (head.callee.tag !== "field") return null;
  const found = compileTimeMemberOf(head.callee, context);
  if (found === null) return null;
  // A member that bridges has a type of its own, and the ordinary application
  // rule is both more precise and more permissive about its arguments.
  if (!found.ordinary && bridge(found.value) !== null) return null;
  // The arguments are checked whether or not the call can be evaluated. They
  // are ordinary expressions, and the field sets the backend reads are recorded
  // while inferring them.
  const argumentTypes = head.args.map((argument) =>
    infer(argument, context, level, row)
  );
  let needsSpecialization = !found.ordinary;
  let ordinaryResult: SimpleType | null = null;
  if (found.ordinary) {
    const applications: (Expr & { tag: "apply" })[] = [];
    let current: Expr = expr;
    while (current.tag === "apply") {
      applications.unshift(current);
      current = current.fn;
    }
    let target = infer(head.callee, context, level, row);
    for (const [index, argument] of head.args.entries()) {
      const argumentType = argumentTypes[index];
      if (argumentType === undefined) {
        throw new Error("member application omitted an argument type");
      }
      requireEvidencedRuntimeType(argumentType, argument, context);
      const result = freshVar(level);
      located(expr.span, () => {
        constrain(target, {
          tag: "fun",
          param: argumentType,
          effects: row,
          result,
        });
      });
      recordApplicationAdaptation(argument, target, argumentType, context);
      const application = applications[index];
      if (application === undefined) {
        throw new Error("member application omitted an application node");
      }
      context.expressionTypes.set(application, result);
      target = result;
    }
    ordinaryResult = target;
    let structuralAlternatives = 0;
    if (target.tag === "var") {
      for (const bound of target.lower) {
        if (bound.tag !== "record" && bound.tag !== "fun") continue;
        structuralAlternatives += 1;
        if (structuralAlternatives > 1) break;
      }
    }
    needsSpecialization = containsUnevidencedType(target) ||
      structuralAlternatives > 1 ||
      containsTypeValue(target, new Set());
  }
  if (!needsSpecialization) return ordinaryResult;
  const value = comptime(expr, context, foldedEnv(context));
  if (value === null) {
    if (found.ordinary) return ordinaryResult;
    return TOP;
  }
  const computed = typeComputedValue(value, context, level);
  if (computed === null) {
    if (found.ordinary) return ordinaryResult;
    return TOP;
  }
  context.memberValues.set(expr, value);
  return instantiate(computed, level, context.staging.instances);
}

function containsTypeValue(
  type: SimpleType,
  seen: Set<number>,
): boolean {
  if (type.tag === "opaque") return type.name === "Type";
  if (type.tag !== "var" || seen.has(type.id)) return false;
  seen.add(type.id);
  return type.lower.some((bound) => containsTypeValue(bound, seen));
}

function inferCase(
  expr: Expr & { tag: "case" },
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  const target = infer(expr.target, context, level, row);
  const targetRelation = expressionRelation(expr.target, context);
  requireEvidencedRuntimeType(target, expr.target, context);
  const result = freshVar(level);
  const accepted: AcceptedArm[] = [];
  let unitExcluded = false;

  // The grammar demands an arm, so an arm-less `case` is one the guard
  // desugaring left behind: every arm the program wrote was guarded, and a
  // guarded row is dropped from the matrix that decides coverage. Reading no
  // arms as no requirement is how that hole would reopen.
  if (expr.arms.length === 0) {
    fail(
      "BLOT_INCOMPLETE_CASE",
      "No arm of this `case` can be the one that matches. A guarded arm is " +
        "not one — its guard may be false — so a `case` needs an arm without " +
        "a guard.",
      expr.target.span,
    );
  }

  // An arm that matches every value leaves the constructor set unbounded, but
  // not unknown: the refutable arms still say what their payloads carry.
  const open = expr.arms.some((arm) => irrefutable(arm.pattern));

  for (const arm of expr.arms) {
    const scope = childTypeEnv(context.types);
    const inner: Context = { ...context, types: scope };
    const armType = bindPattern(arm.pattern, inner, level);
    bindPatternRelation(arm.pattern, targetRelation, scope);

    if (arm.pattern.tag === "name") {
      // An irrefutable name matches every value, so it *is* the scrutinee.
      const matched = unitExcluded ? withoutOmission(target) : target;
      located(arm.pattern.span, () => constrain(matched, armType));
    }
    if (patternContainsPin(arm.pattern)) {
      // Equality is defined within one scalar domain. A requirement made only
      // from the pins checks those domains without pretending the refutable
      // pattern covers every value around them.
      const required = pinnedRequirement(arm.pattern, context, level);
      located(arm.pattern.span, () => constrain(target, required));
    }
    if (!irrefutable(arm.pattern)) {
      accepted.push({ pattern: arm.pattern, accepted: armType });
      // Narrowing: inside the arm, a matched name is known to have the arm's
      // shape. This is what "branches prove stuff" amounts to over a union
      // lattice — refinement, not dependent types.
      if (expr.target.tag === "var") {
        const phase = lookupBindingPhase(scope, expr.target.name);
        scope.names.set(expr.target.name, armType);
        if (phase !== null) recordBindingPhase(scope, expr.target.name, phase);
      }
    }

    const body = infer(arm.body, inner, level, row);
    located(arm.body.span, () => constrain(body, result));
    if (arm.pattern.tag === "unit") unitExcluded = true;
  }

  // Tuple arms are a pattern matrix, and one is exhaustive when the rows cover
  // the cross-product of the columns rather than any one column. Checked before
  // the constraint below, because that constraint is what closes an undeclared
  // column and a column closed by the arms is trivially covered by them.
  if (!open) {
    const patterns = accepted.map((arm) => arm.pattern);
    if (patterns.length > 0 && patterns.every((p) => p.tag === "tuple")) {
      const gap = uncoveredTuple(target, patterns);
      if (gap !== null) {
        fail(
          "BLOT_INCOMPLETE_CASE",
          `No arm covers \`${gap}\`.`,
          expr.target.span,
        );
      }
    }
  }

  // The scrutinee must be covered by the arms taken together. A variant with a
  // case no arm mentions is caught here rather than at runtime. When an arm is
  // irrefutable the requirement is open instead of absent — dropping it is what
  // left `case c of #Some v => v, _ => 0 end` with `v` unrelated to `c`.
  let covered = mergeAccepted(accepted, open);
  if (covered === null && !open) covered = mergeColumns(accepted);
  if (covered !== null) {
    located(expr.target.span, () => constrain(target, covered));
  }
  // A literal set is covered by membership rather than by subtyping, so it is
  // checked instead of constrained. `mergeAccepted` gives up the moment an arm
  // is not a constructor, which left `case n of 1 => "one" end` over `1 | 2 | 3`
  // with no requirement at all — accepted here and trapping at runtime.
  //
  // Constraining `target` against the union of the literal arms would pass this
  // program's gate and be wrong: with no `sig` the target is a bare variable,
  // and the constraint would pin it to whatever the arms happen to list rather
  // than reporting what they miss. Literal arms stay non-constraining.
  if (!open) {
    const armTypes = accepted
      .filter((arm) => !patternContainsPin(arm.pattern))
      .map((arm) => arm.accepted);
    if (
      armTypes.length === 0 &&
      accepted.some((arm) => patternContainsPin(arm.pattern))
    ) {
      fail(
        "BLOT_INCOMPLETE_CASE",
        "A pinned pattern may not match. Add an arm for the remaining values, usually `_`.",
        expr.target.span,
      );
    }
    const missing = uncovered(target, armTypes);
    if (missing !== null && missing.length > 0) {
      fail(
        "BLOT_INCOMPLETE_CASE",
        `No arm covers \`${showLiterals(missing)}\`.`,
        expr.target.span,
      );
    }
    // An unlistable scrutinee cannot be proved exhaustive from literal arms.
    // `uncovered` returns nothing to list, and reading that as "covered" is
    // what let this trap at run time instead.
    if (missing === null && armTypes.length > 0 && scalarArms(armTypes)) {
      const scrutinee = groundScalar(target);
      if (scrutinee === null) {
        fail(
          "BLOT_INCOMPLETE_CASE",
          "The scrutinee's values are not known well enough to prove these arms exhaustive. Add a `_` arm, or give the scrutinee a finite declared type.",
          expr.target.span,
        );
      }
      if (unlistable(scrutinee)) {
        fail(
          "BLOT_INCOMPLETE_CASE",
          `\`${
            showType(scrutinee)
          }\` has more values than these arms can cover. ` +
            "Add the arms it is missing, or a `_` arm — `@panic` says why " +
            "reaching it is impossible.",
          expr.target.span,
        );
      }
    }
  }
  // Recorded after the arms, not before: the scrutinee's constructor set is
  // what the arms proved it must be, and before them there is nothing to read.
  const cases = casesOf(target);
  if (cases !== null) context.variants.set(expr, cases);
  context.staging.reads.push(() => {
    if (optionalType(target)) context.optionalCases.add(expr);
  });
  return result;
}

function withoutOmission(
  type: SimpleType,
  seen = new Set<number>(),
): SimpleType {
  if (type.tag === "union") {
    const remaining = difference(type, UNIT);
    if (remaining.tag === "type" && remaining.type.tag !== "bottom") {
      return remaining.type;
    }
    return type;
  }
  if (type.tag === "forall") return withoutOmission(type.body, seen);
  if (type.tag !== "var" || seen.has(type.id)) return type;
  seen.add(type.id);
  if (type.lower.length > 1) {
    const remaining = difference(unionType(type.lower), UNIT);
    if (remaining.tag === "type" && remaining.type.tag !== "bottom") {
      return remaining.type;
    }
  }
  for (const bound of [...type.lower, ...type.upper]) {
    const remaining = withoutOmission(bound, seen);
    if (remaining !== bound) return remaining;
  }
  return type;
}

function optionalType(type: SimpleType, seen = new Set<number>()): boolean {
  if (!admitsOmission(type)) return false;
  if (type.tag === "union") {
    return type.members.some((member) => !admitsOmission(member));
  }
  if (type.tag === "forall") return optionalType(type.body, seen);
  if (type.tag !== "var" || seen.has(type.id)) return false;
  seen.add(type.id);
  const bounds = [...type.lower, ...type.upper];
  if (bounds.some((bound) => !admitsOmission(bound))) return true;
  return bounds.some((bound) => optionalType(bound, seen));
}

export type OptionalFieldAdaptation =
  | "absent"
  | "present"
  | "preserved"
  | "unit";

export interface RecordAdaptationField {
  readonly name: string;
  readonly optional: OptionalFieldAdaptation | null;
}

export interface RecordAdaptation {
  readonly sourceFields: readonly string[];
  readonly fields: readonly RecordAdaptationField[];
}

function recordApplicationAdaptation(
  argument: Expr,
  fn: SimpleType,
  source: SimpleType,
  context: Context,
): void {
  if (fn.tag !== "fun" || fn.param.tag !== "record") return;
  if (source.tag !== "record") return;

  const fields: RecordAdaptationField[] = [];
  let changed = source.fields.size !== fn.param.fields.size;
  for (const [name, required] of fn.param.fields) {
    const present = source.fields.get(name);
    let optional: OptionalFieldAdaptation | null = null;
    if (optionalType(required)) {
      if (present === undefined || present.tag === "unit") {
        optional = "absent";
      } else if (admitsOmission(present)) {
        optional = "preserved";
      } else {
        optional = "present";
      }
      if (optional !== "preserved") changed = true;
    } else if (admitsOmission(required) && present === undefined) {
      optional = "unit";
      changed = true;
    } else if (present === undefined) {
      throw new Error(`record adaptation omitted required field .${name}`);
    }
    fields.push({ name, optional });
    if (!source.fields.has(name)) changed = true;
  }
  if (!changed) return;
  context.recordAdaptations.set(argument, {
    sourceFields: [...source.fields.keys()],
    fields,
  });
}

/**
 * What checking learned about the record at one node.
 *
 * A field set is what the backend needs: Core records are nominal, so a
 * projection cannot be lowered without the whole set. A disagreement is the
 * other answer inference can honestly give — two different records reached this
 * node, which width subtyping accepts and Core has no single type for. Carrying
 * the two sets is what lets lowering refuse by name instead of inventing a
 * third.
 */
export type Shape =
  | { readonly tag: "fields"; readonly fields: readonly string[] }
  | Disagreement;

export interface Disagreement {
  readonly tag: "disagreement";
  readonly left: readonly string[];
  readonly right: readonly string[];
}

/**
 * Refuse an unspecialized residual node that two different records reach.
 *
 * This is a lowering refusal and not a type error: the program is well typed
 * under width subtyping, and `blot check` still accepts it. Direct runtime
 * calls specialize before reaching this fallback; a residual position that
 * cannot be cloned has no single Core nominal, and the two shapes are the
 * whole explanation.
 */
export function refuseDisagreement(
  disagreement: Disagreement,
  span: Span,
): never {
  fail(
    "BLOT_SHAPE_DISAGREEMENT",
    `${shownShape(disagreement.left)} and ${
      shownShape(disagreement.right)
    } both reach this unspecialized position. Blot's shapes are width-subtyped ` +
      "and Core's are nominal, so no one record type is both. Give the two " +
      "values the same fields, or keep the use at call sites the compiler " +
      "can specialize.",
    span,
  );
}

function shownShape(fields: readonly string[]): string {
  return `{ ${[...fields].sort().map((name) => `.${name}`).join("; ")}; }`;
}

/**
 * The record at a node: the one shape that flows to it.
 *
 * A variable's lower bounds are the records that flowed into it and its upper
 * bounds are the records the program demanded of it, and those answer different
 * questions. What flowed in decides, because a value carries exactly the fields
 * of the record that reached it. A demand speaks only when nothing flowed in at
 * all — a parameter whose caller is outside the module is pinned from above,
 * which is what makes `(&p) => p.x + p.y` a shape with `.x` and `.y` — and
 * demands are unioned, because each projection writes its own one-field record.
 *
 * Instantiation copies are followed as well. A `let`-bound projection is
 * generalized, so the record its callers pass never reaches the definition-site
 * variable through the bound graph at all; the copy is where it landed.
 *
 * Two *different* records flowing to one node is not a wider record, it is two
 * shapes — including when one's fields contain the other's, because a value of
 * each is really built and gpufuck's records are invariant. No nominal is both,
 * and their union would name a record the program never writes, so the answer
 * is which two disagreed rather than a guess between them.
 */
function shapeOf(
  type: SimpleType,
  instances: Instances,
): Shape | null {
  const flowed = reachedRecords(type, instances, "lower");
  if (flowed.size > 1) {
    const [left, right] = [...flowed.values()];
    return { tag: "disagreement", left, right };
  }
  for (const fields of flowed.values()) return { tag: "fields", fields };

  const demanded = reachedRecords(type, instances, "upper");
  if (demanded.size === 0) return null;
  const union = new Set<string>();
  for (const fields of demanded.values()) {
    for (const name of fields) union.add(name);
  }
  return { tag: "fields", fields: [...union] };
}

/**
 * The distinct field sets on records reachable along one bound direction,
 * keyed canonically so two spellings of the same shape count once.
 */
function reachedRecords(
  type: SimpleType,
  instances: Instances,
  direction: "lower" | "upper",
): Map<string, readonly string[]> {
  const found = new Map<string, readonly string[]>();
  const seen = new Set<number>();

  const walk = (current: SimpleType): void => {
    if (current.tag === "record") {
      const fields = [...current.fields.keys()];
      found.set([...fields].sort().join(" "), fields);
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    for (const bound of current[direction]) walk(bound);
    const copies = instances.get(current);
    if (copies === undefined) return;
    for (const copy of copies) walk(copy);
  };

  walk(type);
  return found;
}

/**
 * The constructor set of a variant type, with each tag's arity.
 *
 * Arity matters to the backend and to nothing else: Core constructors declare
 * their fields, and `#Ready` with no payload cannot share a field list with
 * `#Busy n`.
 *
 * Unlike `shapeOf` this walks both directions in one pass and unions what it
 * finds. It does not follow instantiation copies: a closed scrutinee records its
 * set here, while an open set left by a wildcard is resolved during lowering
 * from the declared union membership of the named arms.
 */
function casesOf(type: SimpleType): readonly VariantCase[] | null {
  const found = new Map<string, boolean>();
  let sawVariant = false;

  const walk = (current: SimpleType, seen: Set<number>): void => {
    if (current.tag === "variant") {
      // An open variant names the constructors one `case` read, not the whole
      // set. The backend needs the whole set, so this is not it.
      if (current.open) return;
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

/** The concrete effect labels a row carries. */
function rowLabels(type: SimpleType, seen: Set<number>): string[] {
  if (type.tag === "effects") return [...type.labels];
  if (type.tag === "open-effects") {
    return [...type.labels, ...rowLabels(type.tail, seen)];
  }
  if (type.tag !== "var" || seen.has(type.id)) return [];
  seen.add(type.id);
  return type.lower.flatMap((bound) => rowLabels(bound, seen));
}

/** A refutable arm's pattern together with what it accepts. */
interface AcceptedArm {
  readonly pattern: Pattern;
  readonly accepted: SimpleType;
}

/**
 * Arms of one `case` accept the union of their patterns.
 *
 * `open` is set when some arm matched everything: the constructors named here
 * then constrain their payloads without closing the set. An arm that is not a
 * constructor — a literal, a shape — is not a union at all, and saying nothing
 * beats inventing a coverage it does not have.
 *
 * One constructor may have several arms, and only the first that can match it
 * runs. A total payload pattern settles the constructor: it cannot fail, so
 * every later arm for that constructor is unreachable, which is the same rule
 * the backend lowers by. A literal payload is a guard rather than a
 * requirement, so it constrains nothing on its own.
 */
/** Every arm matches a single scalar literal — nothing structural. */
function scalarArms(arms: readonly SimpleType[]): boolean {
  return arms.every((arm) => arm.tag === "range");
}

/** The scrutinee as a scalar set, through a variable's bounds if need be. */
function groundScalar(type: SimpleType): SimpleType | null {
  if (type.tag === "range") return type;
  // An opaque type is ground in the sense this asks about: it is a set of
  // values with nothing to enumerate, so literal arms over one can never
  // cover it. Without this the `unlistable` gate never fires for `F32x4` and
  // `case v of 1 => …` is accepted, then fails to match at run time.
  if (type.tag === "opaque") return type;
  if (type.tag === "union") {
    if (type.members.every((member) => member.tag === "range")) return type;
    return null;
  }
  if (type.tag === "var") {
    for (const bound of type.upper) {
      const found = groundScalar(bound);
      if (found !== null) return found;
    }
  }
  return null;
}

function mergeAccepted(
  accepted: readonly AcceptedArm[],
  open: boolean,
): SimpleType | null {
  const cases = new Map<string, SimpleType>();
  const settled = new Set<string>();
  for (const arm of accepted) {
    if (arm.accepted.tag !== "variant") return null;
    const total = arm.pattern.tag === "constructor" &&
      (arm.pattern.payload === null || totalPattern(arm.pattern.payload));
    for (const [name, payload] of arm.accepted.cases) {
      if (settled.has(name)) continue;
      if (total) {
        cases.set(name, payload);
        settled.add(name);
        continue;
      }
      if (!cases.has(name)) cases.set(name, TOP);
    }
  }
  if (cases.size === 0) return null;
  if (open) return openVariant(cases);
  return variant(cases);
}

/**
 * Tuple arms, merged one column at a time.
 *
 * `mergeAccepted` gives up on a tuple because a tuple is not a union, but each
 * *column* of one is exactly what it already knows how to merge. Column by
 * column rather than row by row loses the correlation between columns, and that
 * is the right thing to lose here: what the scrutinee owes is only that each of
 * its columns is one of the ones some arm names, and which combinations of them
 * an arm actually reaches is what `uncoveredTuple` decides.
 *
 * A column some arm matches irrefutably says nothing, so it is left out — and a
 * merge that leaves out every column says nothing at all.
 */
function mergeColumns(accepted: readonly AcceptedArm[]): SimpleType | null {
  if (accepted.length === 0) return null;
  const first = accepted[0].pattern;
  if (first.tag !== "tuple") return null;
  const arity = first.elements.length;

  const columns: [string, SimpleType][] = [];
  for (let index = 0; index < arity; index += 1) {
    const column: AcceptedArm[] = [];
    for (const arm of accepted) {
      if (arm.pattern.tag !== "tuple") return null;
      if (arm.pattern.elements.length !== arity) return null;
      if (arm.accepted.tag !== "record") return null;
      const pattern = arm.pattern.elements[index];
      const at = arm.accepted.fields.get(String(index));
      if (at === undefined) return null;
      if (irrefutable(pattern)) {
        column.length = 0;
        break;
      }
      column.push({ pattern, accepted: at });
    }
    if (column.length === 0) continue;
    const merged = mergeAccepted(column, false);
    if (merged === null) continue;
    columns.push([String(index), merged]);
  }
  if (columns.length === 0) return null;
  return record(columns);
}

/** Does this pattern match every value of the type it is written against? */
function totalPattern(pattern: Pattern): boolean {
  switch (pattern.tag) {
    case "wildcard":
    case "name":
    case "unit":
      return true;
    case "tuple":
      return pattern.elements.every(totalPattern);
    case "shape":
      return pattern.fields.every((field) => totalPattern(field.pattern));
    default:
      return false;
  }
}

function irrefutable(pattern: Pattern): boolean {
  return pattern.tag === "wildcard" || pattern.tag === "name";
}

function patternContainsPin(pattern: Pattern): boolean {
  switch (pattern.tag) {
    case "pin":
      return true;
    case "tuple":
    case "array":
      return pattern.elements.some(patternContainsPin);
    case "constructor":
      return pattern.payload !== null && patternContainsPin(pattern.payload);
    case "shape":
      return pattern.fields.some((field) => patternContainsPin(field.pattern));
    default:
      return false;
  }
}

function pinnedRequirement(
  pattern: Pattern,
  context: Context,
  level: Level,
): SimpleType {
  switch (pattern.tag) {
    case "pin": {
      const domain = context.pinnedPatterns.get(pattern);
      if (domain === undefined) {
        throw new Error(
          `inference omitted the domain of pinned \`${pattern.name}\` at ${pattern.span.start}`,
        );
      }
      if (domain === "int") return INT;
      return TEXT;
    }
    case "tuple":
      return tupleType(
        pattern.elements.map((element) => {
          if (patternContainsPin(element)) {
            return pinnedRequirement(element, context, level);
          }
          return freshVar(level);
        }),
      );
    case "array": {
      const element = freshVar(level);
      for (const inner of pattern.elements) {
        if (!patternContainsPin(inner)) continue;
        constrain(element, pinnedRequirement(inner, context, level));
      }
      return { tag: "array", element };
    }
    case "constructor": {
      if (pattern.payload === null) {
        throw new Error("a constructor without a payload contains a pin");
      }
      return openVariant([[
        pattern.name,
        pinnedRequirement(pattern.payload, context, level),
      ]]);
    }
    case "shape":
      return record(
        pattern.fields
          .filter((field) => patternContainsPin(field.pattern))
          .map((field) =>
            [
              field.name,
              pinnedRequirement(field.pattern, context, level),
            ] as const
          ),
      );
    default:
      return freshVar(level);
  }
}

/** Types a pattern and binds its names. Returns what the pattern accepts. */
function bindPattern(
  pattern: Pattern,
  context: Context,
  level: Level,
): SimpleType {
  const scope = context.types;
  switch (pattern.tag) {
    case "wildcard":
      return freshVar(level);
    case "name": {
      const type = freshVar(level);
      scope.names.set(pattern.name, type);
      const identity = recordBinding(scope, pattern.name);
      recordBindingPhase(scope, pattern.name, context.phase);
      context.patternBindings.set(pattern, identity);
      if (
        pattern.qualifier === "affine" || pattern.qualifier === "linear"
      ) {
        context.continuationCandidates.add(identity);
      }
      return type;
    }
    case "pin": {
      const found = lookupType(scope, pattern.name);
      if (found === undefined) {
        if (context.forward.has(pattern.name)) {
          fail(
            "BLOT_FORWARD_REFERENCE",
            `\`${pattern.name}\` is bound further down, so it is not in scope here. Move the binding above this pattern.`,
            pattern.span,
          );
        }
        fail(
          "BLOT_UNBOUND",
          `\`${pattern.name}\` is not in scope.`,
          pattern.span,
        );
      }
      const type = instantiate(found, level, context.staging.instances);
      const domain = pinnedDomain(type);
      if (domain === null) {
        fail(
          "BLOT_UNMATCHABLE_PIN",
          `Pinned \`${pattern.name}\` must have a known Int or Str type, found ${
            showType(type)
          }.`,
          pattern.span,
        );
      }
      context.pinnedPatterns.set(pattern, domain);
      if (domain === "int") return INT;
      return TEXT;
    }
    case "int":
      return intLiteral(pattern.value);
    // A float pattern accepts every float, not the one it names: the type says
    // what the arm may receive, and a float carries no singleton to say less.
    // The arm still runs only on a match — this is why a `case` over floats
    // never becomes exhaustive without a wildcard.
    case "float":
      return FLOAT;
    case "text":
      return textLiteral(pattern.value);
    case "unit":
      return UNIT;
    case "tuple":
      return tupleType(
        pattern.elements.map((p) => bindPattern(p, context, level)),
      );
    case "array": {
      const element = freshVar(level);
      for (const inner of pattern.elements) {
        constrain(element, bindPattern(inner, context, level));
      }
      return { tag: "array", element };
    }
    case "constructor": {
      const payload = pattern.payload === null
        ? UNIT
        : bindPattern(pattern.payload, context, level);
      return variant([[pattern.name, payload]]);
    }
    case "shape":
      return record(
        pattern.fields.map((field) =>
          [field.name, bindPattern(field.pattern, context, level)] as const
        ),
      );
  }
}

export type PinnedDomain = Extract<Domain, "int" | "text">;

function pinnedDomain(type: SimpleType): PinnedDomain | null {
  const domains = new Set<Domain>();
  const seen = new Set<number>();
  const visit = (current: SimpleType): void => {
    if (current.tag === "range") {
      domains.add(current.domain);
      return;
    }
    if (current.tag === "union") {
      for (const member of current.members) visit(member);
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    for (const bound of [...current.lower, ...current.upper]) visit(bound);
  };
  visit(type);
  if (domains.size !== 1) return null;
  for (const domain of domains) {
    if (domain === "int" || domain === "text") return domain;
  }
  return null;
}

/**
 * The names a declaration puts in scope, as far as the syntax says.
 *
 * An `open` is missing here on purpose: which names it binds is a compile-time
 * value, not a fact about the declaration's shape. That only costs a sharper
 * sentence on a name an `open` would have bound later, and the ordinary
 * unbound message is still correct.
 */
function boundNames(declaration: Decl): readonly string[] {
  if (declaration.tag !== "binding") return [];
  if (declaration.kind === "sig") return [];
  return patternNames(declaration.pattern);
}

function declaredNames(declarations: readonly Decl[]): Set<string> {
  return new Set(declarations.flatMap(boundNames));
}

function inferDeclarations(
  declarations: readonly Decl[],
  context: Context,
  level: Level,
  row: SimpleType,
): void {
  let pendingSig:
    | { name: string; type: SimpleType; span: Span }
    | null = null;
  const groups = recursiveGroups(declarations);
  const groupTypes = new Map<Decl, Typing>();
  const enclosing = context.forward;
  const remaining = declaredNames(declarations);

  for (const declaration of declarations) {
    // Spent before the declaration is checked, so a name this one binds is not
    // reported to itself as a forward reference.
    for (const name of boundNames(declaration)) remaining.delete(name);
    context.forward = new Set([...enclosing, ...remaining]);

    if (pendingSig !== null) {
      const adjacent = declaration.tag === "binding" &&
        declaration.kind !== "sig" &&
        declaration.pattern.tag === "name" &&
        declaration.pattern.name === pendingSig.name;
      if (!adjacent) {
        fail(
          "BLOT_BAD_SIG",
          `The signature for \`${pendingSig.name}\` must be immediately followed by that binding.`,
          pendingSig.span,
        );
      }
    }

    if (declaration.tag === "open") {
      // Opening is the field rule applied once per resulting binding rather
      // than a new typing rule. The names come from the compile-time value
      // because that is the only place the set of them is known; the types
      // come from constraining the inferred record, because a closure has no
      // type to read off its value.
      const value = comptime(declaration.value, context);
      if (value === null || value.tag !== "shape") {
        fail(
          "BLOT_CANNOT_OPEN",
          "`open` spreads the fields of a compile-time record into scope.",
          declaration.span,
        );
      }
      context.opens.set(
        declaration.value,
        new Map(value.fields),
      );
      const target = inferPure(
        declaration.value,
        context,
        level,
        "An `open` value",
      );
      for (const [name, fieldValue] of value.fields) {
        context.values.names.set(name, fieldValue);
        const field = freshVar(level);
        located(declaration.span, () => {
          constrain(target, record([[name, field]]));
        });
        // Quantified below ground level, for the reason the module scope is:
        // these variables are already at level 0, and generalizing at 0 would
        // make every use share them — `fold` used once on text could then
        // never be used on integers.
        context.types.names.set(name, scheme(field, -1));
        recordBinding(context.types, name);
        recordBindingPhase(context.types, name, "comptime");
        recordComptimeBinding(context.types, name, fieldValue);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      const previous = lookupType(context.types, declaration.name);
      if (previous === undefined) {
        fail(
          "BLOT_UNBOUND",
          `\`${declaration.name} := ...\` cannot shadow a name that is not in scope.`,
          declaration.span,
        );
      }
      const integerValue = witness(declaration.value, context.types);
      const knownArrayLength = arrayLength(
        declaration.value,
        context.types,
      );
      // Same as a binding: evaluate first, name what it produced, and let the
      // *named* value be what gets bridged. Bridging first would mint the
      // effect's label from the placeholder name, and the rename afterwards
      // would come too late to matter.
      const named = namedComptime(declaration.name, declaration.value, context);
      let bridged: SimpleType | null = null;
      if (named !== null) bridged = bridge(named);
      let inferred: Typing;
      if (bridged === null) {
        inferred = generalizePure(
          declaration.value,
          context,
          level,
          "A `:=` value",
        );
      } else {
        inferred = bridged;
      }
      const relation = expressionRelation(declaration.value, context);
      const previousType = stableRebindingType(
        instantiate(previous, level + 1, context.staging.instances),
      );
      const inferredType = stableRebindingType(
        instantiate(inferred, level + 1, context.staging.instances),
      );
      try {
        constrain(previousType, inferredType);
        constrain(inferredType, previousType);
      } catch (error) {
        if (!(error instanceof TypeError_)) throw error;
        fail(
          "BLOT_TYPE_ERROR",
          `\`${declaration.name} := ...\` must preserve ${
            showType(previousType)
          }, found ${
            showType(inferredType)
          }. Use \`let ${declaration.name} = ...;\` to shadow it with a different type.`,
          declaration.span,
        );
      }
      if (named !== null) {
        context.values.names.set(declaration.name, named);
        context.comptimeValues.set(declaration.value, named);
      }
      if (previous.tag === "scheme") {
        context.types.names.set(
          declaration.name,
          scheme(stableRebindingType(previous.body), previous.level),
        );
      } else {
        context.types.names.set(
          declaration.name,
          stableRebindingType(previous),
        );
      }
      // A rebinding to another value gets that value's identity or a fresh one.
      // `stableRebindingType` can hand back the very type it was given, so the
      // `Typing` pairing alone would not notice a `:=` in the same scope.
      const identity = aliasedBinding(declaration.value, context.types);
      recordBinding(context.types, declaration.name, identity);
      recordBindingPhase(context.types, declaration.name, "runtime");
      // A rebinding whose value is not known at compile time erases the one the
      // name had.
      context.types.comptime.delete(declaration.name);
      // And the length, for the same reason: after `xs := f ()` the name holds
      // an array of unknown size, and the literal it was declared with says
      // nothing about it. A rebinding to another literal records that one.
      context.types.arrayLengths.delete(declaration.name);
      context.types.integerValues.delete(declaration.name);
      context.types.relations.delete(declaration.name);
      // And the computed value, which is a fact about the value the name held
      // rather than about the name.
      context.types.folded.delete(declaration.name);
      const computed = context.memberValues.get(declaration.value);
      if (computed !== undefined) {
        recordFolded(context.types, declaration.name, computed);
      }
      if (named !== null) {
        recordComptimeBinding(context.types, declaration.name, named);
      }
      if (knownArrayLength !== null) {
        recordArrayLength(
          context.types,
          declaration.name,
          knownArrayLength,
        );
      }
      if (integerValue !== null && typeof integerValue !== "bigint") {
        recordIntegerValue(context.types, declaration.name, integerValue);
      }
      if (relation !== null) {
        recordRelation(context.types, declaration.name, relation);
      }
      continue;
    }

    const resolvedTags = resolveDeclarationTags(declaration, context);

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
        // Naming what it got matters here: the commonest mistake is reaching
        // for a namespace whose name reads like a type — `Text` is the record
        // of text functions and `Str` is the type — and the old message left
        // the reader to guess which of the two they had.
        fail(
          "BLOT_SIG_NOT_A_TYPE",
          `A \`sig\` must evaluate to a type; this one evaluates to ${
            show(value)
          }.`,
          declaration.span,
        );
      }
      const unrepresentable = unrepresentableInteger(bridged);
      if (unrepresentable !== null) {
        fail(
          "BLOT_UNREPRESENTABLE_INTEGER",
          `Runtime signature \`${declaration.pattern.name}\` contains ${
            showType(unrepresentable)
          }, which has inhabitants outside signed i64 ${I64_LOW}..${I64_HIGH}. Storage widths are compile-time descriptors; they are not wider runtime integers.`,
          declaration.span,
        );
      }
      pendingSig = {
        name: declaration.pattern.name,
        type: bridged,
        span: declaration.span,
      };
      continue;
    }

    // A `const` whose value is a type *is* its type. Bridging beats inferring
    // here: `const Console = @effect {...}` has no inferable structure, but its
    // value knows exactly which operations exist and which row they carry.
    let type: Typing | null = null;
    let signature: SimpleType | null = null;
    if (
      pendingSig !== null && declaration.pattern.tag === "name" &&
      pendingSig.name === declaration.pattern.name
    ) {
      signature = pendingSig.type;
    }
    let bound: Value | null = null;
    if (declaration.kind === "const") {
      // Through `bind`, not `evaluate`: a `const` may be `rec`, and `rec` only
      // means anything when it knows the name it is being bound to.
      const raw = requireComptimeBinding(
        declaration.pattern,
        declaration.value,
        context,
      );
      if (raw !== null) {
        refuseRuntimeConstCaptures(
          declaration.pattern,
          raw,
          context,
          declaration.value.span,
        );
      }
      // `@effect` cannot know what it will be called, so the binding names it.
      // The identity is preserved: this is a rename, not a second effect.
      const value =
        raw !== null && raw.tag === "effect" && raw.name === "Effect" &&
          declaration.pattern.tag === "name"
          ? { ...raw, name: declaration.pattern.name }
          : raw;
      if (value !== null) {
        recordComptime(declaration.pattern, value, context);
        context.comptimeValues.set(declaration.value, value);
        bound = value;
        const bridged = bridge(value);
        if (bridged !== null) type = bridged;
      }
    }

    let declarationContext = context;
    if (declaration.kind === "const") {
      declarationContext = { ...context, phase: "comptime" };
    }

    const group = groups.get(declaration);
    if (type === null && group !== undefined) {
      // Typed once, at the first member: the group's names have to be in scope
      // together, and one pass over the whole run is the only way to do that.
      if (!groupTypes.has(declaration)) {
        inferRecursiveGroup(
          group,
          declarationContext,
          level,
          row,
          groupTypes,
        );
      }
      const member = groupTypes.get(declaration);
      expect(member !== undefined, "recursive group missed one of its members");
      type = member;
    }
    // After the group, because a declaration that *is* a recursive group is
    // typed with the rest of it: its names enter scope together, and a knot tied
    // around one of them cannot say what a mutual pair means. What reaches here
    // is a closure that arrived as a value — selected by a compile-time
    // conditional, returned from a compile-time function — where there is no
    // group to belong to.
    if (type === null && bound !== null) {
      type = typeClosure(bound, declarationContext, level);
    }
    if (type === null) {
      if (
        signature !== null && declaration.value.tag === "lambda" &&
        declaration.kind !== "effect"
      ) {
        type = checkAgainstPure(
          declaration.value,
          signature,
          declarationContext,
          level,
          "A `let` value",
        );
      } else if (declaration.kind === "effect") {
        type = generalizeEffect(declaration.value, context, level, row);
      } else {
        let description = "A `let` value";
        if (declaration.kind === "const") description = "A `const` value";
        type = generalizePure(
          declaration.value,
          declarationContext,
          level,
          description,
        );
      }
    }

    if (
      pendingSig !== null && declaration.pattern.tag === "name" &&
      pendingSig.name === declaration.pattern.name
    ) {
      const expected = pendingSig.type;
      if (
        containsUnevidencedType(type as Typing) ||
        expressionUsesUnevidencedType(declaration.value, context)
      ) {
        fail(
          "BLOT_REFLECTION_NOT_INDEXED",
          `The inferred value for \`${pendingSig.name}\` depends on a generic compile-time inspection result. Reflection and structural inspection can prove a signature only after their inputs are known at compile time.`,
          declaration.span,
        );
      }
      located(declaration.span, () => {
        constrain(
          instantiate(type as Typing, level, context.staging.instances),
          expected,
        );
      });
      type = expected;
      pendingSig = null;
    }

    if (bound?.tag === "closure") {
      const inferred = reify(
        instantiate(type, level, context.staging.instances),
      );
      if (inferred !== null) withInferredType(bound, inferred);
    }

    const identity = aliasedBinding(declaration.value, context.types);
    const integerValue = witness(declaration.value, context.types);
    const knownArrayLength = arrayLength(declaration.value, context.types);
    const relation = expressionRelation(declaration.value, context);
    let bindingPhase: "runtime" | "comptime" = "runtime";
    if (declaration.kind === "const") bindingPhase = "comptime";
    bindDeclaration(
      declaration.pattern,
      type,
      context,
      level,
      identity,
      bindingPhase,
    );
    bindPatternRelation(declaration.pattern, relation, context.types);
    if (
      declaration.pattern.tag === "name" && integerValue !== null &&
      typeof integerValue !== "bigint"
    ) {
      recordIntegerValue(
        context.types,
        declaration.pattern.name,
        integerValue,
      );
    }
    if (declaration.pattern.tag === "name" && knownArrayLength !== null) {
      recordArrayLength(
        context.types,
        declaration.pattern.name,
        knownArrayLength,
      );
    }
    if (resolvedTags.length > 0) {
      context.declarationTags.set(declaration, {
        tags: resolvedTags,
        type: instantiate(type, level, context.staging.instances),
      });
    }
    if (bound !== null && declaration.pattern.tag === "name") {
      recordComptimeBinding(context.types, declaration.pattern.name, bound);
    }
    // A member call the checker had to run to type it is a value the name now
    // holds, and the next member call may need it as an argument. `sig` widening
    // the binding's type does not take the value back: which value a name holds
    // and which type it was declared at are separate facts, exactly as they are
    // for a `const`.
    if (declaration.pattern.tag === "name") {
      const computed = context.memberValues.get(declaration.value);
      if (computed !== undefined) {
        recordFolded(context.types, declaration.pattern.name, computed);
      }
    }
    if (
      declaration.pattern.tag === "name" &&
      (declaration.value.tag === "shape" ||
        declaration.value.tag === "lambda")
    ) {
      context.types.literals.set(
        declaration.pattern.name,
        declaration.value,
      );
    }
  }

  if (pendingSig !== null) {
    fail(
      "BLOT_BAD_SIG",
      `The signature for \`${pendingSig.name}\` has no adjacent binding.`,
      pendingSig.span,
    );
  }
}

function expressionUsesUnevidencedType(
  expression: Expr,
  context: Context,
): boolean {
  for (const [candidate, type] of context.expressionTypes) {
    if (
      candidate.span.start < expression.span.start ||
      candidate.span.end > expression.span.end
    ) continue;
    if (containsUnevidencedType(type)) return true;
  }
  return false;
}

function unrepresentableInteger(
  type: SimpleType,
  seen = new Set<number>(),
): SimpleType | null {
  if (type.tag === "range") {
    if (type.domain !== "int") return null;
    if (typeof type.low === "bigint" && type.low < I64_LOW) return type;
    if (typeof type.high === "bigint" && type.high > I64_HIGH) return type;
    return null;
  }
  if (type.tag === "var") {
    if (seen.has(type.id)) return null;
    seen.add(type.id);
    for (const bound of [...type.lower, ...type.upper]) {
      const found = unrepresentableInteger(bound, seen);
      if (found !== null) return found;
    }
    return null;
  }
  if (type.tag === "forall") return unrepresentableInteger(type.body, seen);
  if (type.tag === "fun") {
    const parameter = unrepresentableInteger(type.param, seen);
    if (parameter !== null) return parameter;
    return unrepresentableInteger(type.result, seen);
  }
  if (type.tag === "record") {
    for (const field of type.fields.values()) {
      const found = unrepresentableInteger(field, seen);
      if (found !== null) return found;
    }
    return null;
  }
  if (type.tag === "array") {
    return unrepresentableInteger(type.element, seen);
  }
  if (type.tag === "variant") {
    for (const payload of type.cases.values()) {
      const found = unrepresentableInteger(payload, seen);
      if (found !== null) return found;
    }
    return null;
  }
  if (type.tag === "union") {
    for (const member of type.members) {
      const found = unrepresentableInteger(member, seen);
      if (found !== null) return found;
    }
  }
  return null;
}

function containsUnevidencedType(
  typing: Typing,
  seen = new Set<number>(),
): boolean {
  let type: SimpleType;
  if (typing.tag === "scheme") type = typing.body;
  else type = typing;
  if (type.tag === "var") {
    if (evidenceOf(type) !== null) return true;
    if (seen.has(type.id)) return false;
    seen.add(type.id);
    return [...type.lower, ...type.upper].some((bound) =>
      containsUnevidencedType(bound, seen)
    );
  }
  if (type.tag === "forall") {
    return containsUnevidencedType(type.body, seen);
  }
  if (type.tag === "fun") {
    return containsUnevidencedType(type.param, seen) ||
      containsUnevidencedType(type.effects, seen) ||
      containsUnevidencedType(type.result, seen);
  }
  if (type.tag === "record") {
    return [...type.fields.values()].some((field) =>
      containsUnevidencedType(field, seen)
    );
  }
  if (type.tag === "array") {
    return containsUnevidencedType(type.element, seen);
  }
  if (type.tag === "variant") {
    return [...type.cases.values()].some((payload) =>
      containsUnevidencedType(payload, seen)
    );
  }
  if (type.tag === "union") {
    return type.members.some((member) => containsUnevidencedType(member, seen));
  }
  return false;
}

function requireEvidencedRuntimeType(
  type: Typing,
  expression: Expr,
  context: Context,
): void {
  if (context.phase !== "runtime" || !containsUnevidencedType(type)) return;
  if (comptime(expression, context, foldedEnv(context)) !== null) return;
  fail(
    "BLOT_REFLECTION_NOT_INDEXED",
    "A generic compile-time inspection result cannot determine a runtime operation. Make the inspected value known at compile time so reflection has an exact result type.",
    expression.span,
  );
}

function resolveDeclarationTags(
  declaration: Decl & { tag: "binding" },
  context: Context,
): readonly ResolvedDeclarationTag[] {
  return declaration.tags.map((tag) => {
    const descriptor = requireComptime(
      tag.descriptor,
      context,
      "A declaration tag descriptor",
    );
    if (descriptor.tag !== "shape") {
      fail(
        "BLOT_BAD_DECLARATION_TAG",
        `A declaration tag descriptor must be a shape, found ${
          show(descriptor)
        }.`,
        tag.span,
      );
    }
    const name = descriptor.fields.get("name");
    if (name === undefined || name.tag !== "text" || name.value.length === 0) {
      fail(
        "BLOT_BAD_DECLARATION_TAG",
        `A declaration tag descriptor needs a non-empty text member \`.name\`, found ${
          show(descriptor)
        }.`,
        tag.span,
      );
    }
    const metadata = descriptor.fields.get("metadata");
    if (metadata === undefined) {
      fail(
        "BLOT_BAD_DECLARATION_TAG",
        `Declaration tag \`${name.value}\` has no \`.metadata\` member.`,
        tag.span,
      );
    }
    const transform = descriptor.fields.get("transform");
    if (transform === undefined || !callable(transform)) {
      let found = "nothing";
      if (transform !== undefined) found = show(transform);
      fail(
        "BLOT_BAD_DECLARATION_TAG",
        `Declaration tag \`${name.value}\` needs a callable \`.transform\`, found ${found}.`,
        tag.span,
      );
    }
    return { name: name.value, metadata, span: tag.span };
  });
}

function callable(value: Value): boolean {
  return value.tag === "closure" || value.tag === "primitive" ||
    value.tag === "native" || value.tag === "tag" ||
    value.tag === "operation" || value.tag === "continuation";
}

/** Widens singleton literals so rebinding preserves their domain. */
function stableRebindingType(
  type: SimpleType,
): SimpleType {
  if (type.tag === "range") {
    if (type.domain === "int") return INT;
    return TEXT;
  }
  if (type.tag === "array") {
    return { tag: "array", element: stableRebindingType(type.element) };
  }
  if (type.tag === "record") {
    return record(
      [...type.fields].map(([name, member]) => [
        name,
        stableRebindingType(member),
      ]),
    );
  }
  if (type.tag === "variant") {
    const cases = [...type.cases].map((
      [name, payload],
    ) => [name, stableRebindingType(payload)] as const);
    if (type.open) return openVariant(cases);
    return variant(cases);
  }
  if (type.tag === "fun") {
    return {
      tag: "fun",
      param: stableRebindingType(type.param),
      effects: stableRebindingType(type.effects),
      result: stableRebindingType(type.result),
      deferred: type.deferred,
    };
  }
  if (type.tag === "forall") {
    return {
      tag: "forall",
      variables: type.variables,
      body: stableRebindingType(type.body),
    };
  }
  if (type.tag === "union") {
    return {
      tag: "union",
      members: type.members.map(stableRebindingType),
    };
  }
  return type;
}

function checkAgainst(
  expr: Expr,
  expected: SimpleType,
  context: Context,
  level: Level,
  row: SimpleType,
): SimpleType {
  if (expr.tag !== "lambda" || expected.tag !== "fun") {
    const inferred = infer(expr, context, level + 1, row);
    located(expr.span, () => constrain(inferred, expected));
    return expected;
  }

  if ((expr.deferred ?? false) !== (expected.deferred ?? false)) {
    fail(
      "BLOT_TYPE_ERROR",
      expected.deferred === true
        ? "This function signature requires a deferred parameter; write fn ~name => ...."
        : "This function signature requires a strict parameter; remove ~ from the lambda parameter.",
      expr.span,
    );
  }

  const scope = childTypeEnv(context.types);
  const inner: Context = { ...context, types: scope };
  let parameterPhase: "runtime" | "comptime" = "runtime";
  if (expr.deferred === true) parameterPhase = "comptime";
  const parameterContext: Context = { ...inner, phase: parameterPhase };
  bindPatternAgainst(
    expr.parameter,
    expected.param,
    parameterContext,
    level + 1,
  );
  const bodyRow = freshVar(level + 1);
  if (expr.body.tag === "block" || isReturnScopeBoundary(expr.body)) {
    checkAgainst(
      expr.body,
      expected.result,
      inner,
      level + 1,
      bodyRow,
    );
  } else {
    checkAgainstPure(
      expr.body,
      expected.result,
      inner,
      level + 1,
      "A function result",
    );
  }
  located(expr.span, () => constrain(bodyRow, expected.effects));
  context.expressionTypes.set(expr, expected);
  return expected;
}

function isReturnScopeBoundary(expr: Expr): boolean {
  return expr.tag === "case" &&
    expr.arms.some((arm) =>
      arm.pattern.tag === "constructor" &&
      arm.pattern.name.startsWith("ScopeReturn$")
    );
}

function checkAgainstPure(
  expr: Expr,
  expected: SimpleType,
  context: Context,
  level: Level,
  description: string,
): SimpleType {
  const row = freshVar(level + 1);
  const inferred = checkAgainst(expr, expected, context, level, row);
  requirePure(row, expr.span, description);
  return inferred;
}

function bindPatternAgainst(
  pattern: Pattern,
  expected: SimpleType,
  context: Context,
  level: Level,
): void {
  const scope = context.types;
  if (pattern.tag === "name") {
    scope.names.set(pattern.name, expected);
    const identity = recordBinding(scope, pattern.name);
    recordBindingPhase(scope, pattern.name, context.phase);
    context.patternBindings.set(pattern, identity);
    if (pattern.qualifier === "affine" || pattern.qualifier === "linear") {
      context.continuationCandidates.add(identity);
    }
    return;
  }
  const accepted = bindPattern(pattern, context, level);
  located(pattern.span, () => constrain(expected, accepted));
}

function bindDeclaration(
  pattern: Pattern,
  type: Typing,
  context: Context,
  level: Level,
  identity: number | null,
  phase: "runtime" | "comptime",
): void {
  if (pattern.tag === "name") {
    context.types.names.set(pattern.name, type);
    const binding = recordBinding(context.types, pattern.name, identity);
    recordBindingPhase(context.types, pattern.name, phase);
    context.patternBindings.set(pattern, binding);
    if (pattern.qualifier === "affine" || pattern.qualifier === "linear") {
      context.continuationCandidates.add(binding);
    }
    return;
  }
  // A destructuring binding types its parts by constraining the whole against
  // the shape the pattern requires.
  const required = bindPattern(pattern, { ...context, phase }, level);
  const whole = instantiate(type, level, context.staging.instances);
  located(pattern.span, () => constrain(whole, required));
  recordPatternShapes(pattern, whole, context);
}

/** A function type, dug out of whatever bounds carry it. */
function arrowOf(
  type: SimpleType,
  seen = new Set<number>(),
): GrantSignature | null {
  if (type.tag === "fun") {
    return { parameter: type.param, result: type.result };
  }
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  for (const bound of [...type.upper, ...type.lower]) {
    const found = arrowOf(bound, seen);
    if (found !== null) return found;
  }
  return null;
}

/** What the value actually carries, wherever a shape pattern reads part of it. */
function recordPatternShapes(
  pattern: Pattern,
  type: SimpleType,
  context: Context,
): void {
  if (pattern.tag !== "shape") return;
  context.staging.reads.push(() => {
    const shape = shapeOf(type, context.staging.instances);
    if (shape !== null) context.patternShapes.set(pattern, shape);
  });
}

/** The precise type of a value produced by compile-time specialization. */
function typeComputedValue(
  value: Value,
  context: Context,
  level: Level,
  seen: ReadonlySet<Value> = new Set(),
): Typing | null {
  const bridged = bridge(value);
  if (bridged !== null) return bridged;
  if (value.tag === "closure") {
    return typeClosure(value, context, level, seen);
  }
  if (value.tag === "extended") {
    return typeComputedValue(value.inner, context, level, seen);
  }
  if (value.tag !== "shape") return null;

  const fields: [string, SimpleType][] = [];
  for (const [name, fieldValue] of value.fields) {
    const fieldTyping = typeComputedValue(fieldValue, context, level, seen);
    if (fieldTyping === null) return null;
    fields.push([
      name,
      instantiate(fieldTyping, level, context.staging.instances),
    ]);
  }
  return record(fields);
}

function snapshotSpecializationInterface(
  context: Context,
): SpecializationInterface | null {
  if (context.values.module === null) {
    throw new Error("specialization interface requires a module value scope");
  }
  const identity = context.values.module.identity;
  const declarationIdentity = declarationIdentityOf(context);
  const cached = specializationInterfaces.get(identity);
  if (
    cached !== undefined &&
    cached.declarationIdentity === declarationIdentity
  ) return cached;

  for (const [name, typing] of context.types.names) {
    if (context.moduleParameters.has(name)) continue;
    if (hasUnquantifiedVariable(typing)) return null;
  }

  const types = new Map<SimpleType, SimpleType>();
  const typings = new Map<Typing, Typing>();
  const snapshot = snapshotTypeEnv(
    context.types,
    context.moduleParameters,
    types,
    typings,
  );
  const modules = new Map<string, SimpleType>();
  for (const [specifier, type] of context.modules) {
    modules.set(specifier, snapshotType(type, types));
  }
  const published = Object.freeze({
    declarationIdentity,
    types: snapshot,
    values: context.values,
    imports: context.imports,
    modules,
    parameterName: context.parameterName,
  });
  specializationInterfaces.set(identity, published);
  return published;
}

function declarationIdentityOf(context: Context): string {
  const labels = new Set<string>();
  const seen = new Set<SimpleType>();
  const collect = (type: SimpleType): void => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.tag === "var") {
      for (const bound of type.lower) collect(bound);
      for (const bound of type.upper) collect(bound);
      return;
    }
    if (type.tag === "fun") {
      collect(type.param);
      collect(type.effects);
      collect(type.result);
      return;
    }
    if (type.tag === "record") {
      for (const field of type.fields.values()) collect(field);
      return;
    }
    if (type.tag === "array") {
      collect(type.element);
      return;
    }
    if (type.tag === "variant") {
      for (const payload of type.cases.values()) collect(payload);
      return;
    }
    if (type.tag === "union") {
      for (const member of type.members) collect(member);
      return;
    }
    if (type.tag === "forall") {
      collect(type.body);
      return;
    }
    if (type.tag !== "effects") return;
    for (const label of type.labels) labels.add(label);
  };
  for (const typing of context.types.names.values()) {
    if (typing.tag === "scheme") collect(typing.body);
    else collect(typing);
  }
  for (const module of context.modules.values()) collect(module);
  return [...labels].sort().join("\u0000");
}

function hasUnquantifiedVariable(typing: Typing): boolean {
  let limit: Level | null = null;
  let type = typing as SimpleType;
  if (typing.tag === "scheme") {
    limit = typing.level;
    type = typing.body;
  }
  const seen = new Set<SimpleType>();
  const visit = (candidate: SimpleType): boolean => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (candidate.tag === "var") {
      if (limit === null || candidate.level <= limit) return true;
      return candidate.lower.some(visit) || candidate.upper.some(visit);
    }
    if (candidate.tag === "fun") {
      return visit(candidate.param) || visit(candidate.effects) ||
        visit(candidate.result);
    }
    if (candidate.tag === "record") {
      return [...candidate.fields.values()].some(visit);
    }
    if (candidate.tag === "array") return visit(candidate.element);
    if (candidate.tag === "variant") {
      return [...candidate.cases.values()].some(visit);
    }
    if (candidate.tag === "union") return candidate.members.some(visit);
    if (candidate.tag === "forall") return visit(candidate.body);
    return false;
  };
  return visit(type);
}

function snapshotTypeEnv(
  source: TypeEnv,
  omittedNames: ReadonlySet<string>,
  types: Map<SimpleType, SimpleType>,
  typings: Map<Typing, Typing>,
): TypeEnv {
  let parent: TypeEnv | null = null;
  if (source.parent !== null) {
    parent = snapshotTypeEnv(source.parent, omittedNames, types, typings);
  }
  const snapshot: TypeEnv = {
    names: new Map(),
    literals: new Map(),
    refinements: source.refinements.clone(),
    comptime: new Map(),
    arrayLengths: new Map(),
    integerValues: new Map(),
    relations: new Map(),
    bindings: new Map(),
    phases: new Map(),
    projections: new Map(),
    folded: new Map(),
    parent,
  };
  for (const [name, typing] of source.names) {
    if (omittedNames.has(name)) continue;
    snapshot.names.set(name, snapshotTyping(typing, types, typings));
  }
  for (const [name, literal] of source.literals) {
    if (omittedNames.has(name)) continue;
    snapshot.literals.set(name, literal);
  }
  for (const [name, entry] of source.comptime) {
    if (omittedNames.has(name)) continue;
    snapshot.comptime.set(name, {
      value: entry.value,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  for (const [name, entry] of source.arrayLengths) {
    if (omittedNames.has(name)) continue;
    snapshot.arrayLengths.set(name, {
      length: entry.length,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  for (const [name, entry] of source.integerValues) {
    if (omittedNames.has(name)) continue;
    snapshot.integerValues.set(name, {
      value: entry.value,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  for (const [name, entry] of source.relations) {
    if (omittedNames.has(name)) continue;
    snapshot.relations.set(name, {
      value: entry.value,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  for (const [name, entry] of source.bindings) {
    if (omittedNames.has(name)) continue;
    snapshot.bindings.set(name, {
      id: entry.id,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  for (const [name, entry] of source.phases) {
    if (omittedNames.has(name)) continue;
    snapshot.phases.set(name, {
      phase: entry.phase,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  for (const [name, identity] of source.projections) {
    if (omittedNames.has(name)) continue;
    snapshot.projections.set(name, identity);
  }
  for (const [name, entry] of source.folded) {
    if (omittedNames.has(name)) continue;
    snapshot.folded.set(name, {
      value: entry.value,
      typing: snapshotTyping(entry.typing, types, typings),
    });
  }
  return snapshot;
}

function snapshotTyping(
  source: Typing,
  types: Map<SimpleType, SimpleType>,
  typings: Map<Typing, Typing>,
): Typing {
  const existing = typings.get(source);
  if (existing !== undefined) return existing;
  if (source.tag !== "scheme") {
    const snapshot = snapshotType(source, types);
    typings.set(source, snapshot);
    return snapshot;
  }
  const snapshot = Object.freeze({
    tag: "scheme" as const,
    level: source.level,
    body: snapshotType(source.body, types),
  });
  typings.set(source, snapshot);
  return snapshot;
}

function snapshotType(
  source: SimpleType,
  snapshots: Map<SimpleType, SimpleType>,
): SimpleType {
  const existing = snapshots.get(source);
  if (existing !== undefined) return existing;

  if (source.tag === "var") {
    const evidence = evidenceOf(source);
    let snapshot: Variable;
    if (evidence === null) snapshot = freshVar(source.level);
    else snapshot = freshVar(source.level, evidence);
    snapshots.set(source, snapshot);
    snapshot.lower.push(
      ...source.lower.map((bound) => snapshotType(bound, snapshots)),
    );
    snapshot.upper.push(
      ...source.upper.map((bound) => snapshotType(bound, snapshots)),
    );
    Object.freeze(snapshot.lower);
    Object.freeze(snapshot.upper);
    return Object.freeze(snapshot);
  }
  if (source.tag === "rigid") {
    const snapshot = Object.freeze({ ...source });
    snapshots.set(source, snapshot);
    return snapshot;
  }
  if (source.tag === "fun") {
    const snapshot = {
      tag: "fun" as const,
      param: TOP,
      effects: TOP,
      result: TOP,
    };
    snapshots.set(source, snapshot);
    snapshot.param = snapshotType(source.param, snapshots);
    snapshot.effects = snapshotType(source.effects, snapshots);
    snapshot.result = snapshotType(source.result, snapshots);
    return Object.freeze(snapshot);
  }
  if (source.tag === "record") {
    const fields = new Map<string, SimpleType>();
    const snapshot: SimpleType = { tag: "record", fields };
    snapshots.set(source, snapshot);
    for (const [name, field] of source.fields) {
      fields.set(name, snapshotType(field, snapshots));
    }
    return Object.freeze(snapshot);
  }
  if (source.tag === "array") {
    const snapshot = { tag: "array" as const, element: TOP };
    snapshots.set(source, snapshot);
    snapshot.element = snapshotType(source.element, snapshots);
    return Object.freeze(snapshot);
  }
  if (source.tag === "variant") {
    const cases = new Map<string, SimpleType>();
    const snapshot: SimpleType = {
      tag: "variant",
      cases,
      open: source.open,
    };
    snapshots.set(source, snapshot);
    for (const [name, payload] of source.cases) {
      cases.set(name, snapshotType(payload, snapshots));
    }
    return Object.freeze(snapshot);
  }
  if (source.tag === "union") {
    const members: SimpleType[] = [];
    const snapshot: SimpleType = { tag: "union", members };
    snapshots.set(source, snapshot);
    members.push(
      ...source.members.map((member) => snapshotType(member, snapshots)),
    );
    Object.freeze(members);
    return Object.freeze(snapshot);
  }
  if (source.tag === "forall") {
    const snapshot = {
      tag: "forall" as const,
      variables: Object.freeze([...source.variables]),
      body: TOP,
    };
    snapshots.set(source, snapshot);
    snapshot.body = snapshotType(source.body, snapshots);
    return Object.freeze(snapshot);
  }
  if (source.tag === "effects") {
    const snapshot: SimpleType = {
      tag: "effects",
      labels: new Set(source.labels),
    };
    snapshots.set(source, snapshot);
    return Object.freeze(snapshot);
  }
  if (source.tag === "open-effects") {
    const snapshot = {
      tag: "open-effects" as const,
      labels: new Set(source.labels),
      tail: TOP,
    };
    snapshots.set(source, snapshot);
    snapshot.tail = snapshotType(source.tail, snapshots);
    return Object.freeze(snapshot);
  }
  if (source.tag === "range") {
    const snapshot = Object.freeze({ ...source });
    snapshots.set(source, snapshot);
    return snapshot;
  }
  if (source.tag === "opaque") {
    const snapshot = Object.freeze({ ...source });
    snapshots.set(source, snapshot);
    return snapshot;
  }
  const snapshot = Object.freeze({ ...source });
  snapshots.set(source, snapshot);
  return snapshot;
}

/**
 * The type of the closure a `const` actually evaluated to.
 *
 * `bridge` answers `null` for a closure because a closure's type comes from its
 * body — but nothing then goes and infers that body, so the declaration falls
 * back to inferring the expression that *produced* the closure. For
 * `const on_int = pick Int` that expression is a `case`/`if` over types, and
 * inferring it joins every arm: `on_int` ends up with the arrow of the branch
 * that lost as well as the one that won.
 *
 * The evaluator already decided which branch ran, and the backend already emits
 * that decision — `lower.ts` resolves a `const` name straight to this value. So
 * the checker asks the evaluator rather than deciding a second time, and types
 * the lambda it was handed.
 */
function typeClosure(
  value: Value,
  context: Context,
  level: Level,
  seen: ReadonlySet<Value> = new Set(),
): Typing | null {
  if (value.tag !== "closure" || value.source === undefined) return null;
  const captured = capturedScope(value.env, context, level, value, seen);
  if (captured === null) return null;
  const inner: Context = {
    ...captured.context,
    phase: context.phase,
    types: captured.types,
  };
  // A lambda performs nothing when it is evaluated, so its own row is internal
  // to the arrow and a fresh one keeps the binding site's row out of it.
  const row = freshVar(level + 1);
  if (value.self === null) return generalize(value.source, inner, level, row);
  // A `rec` closure is an ordinary function whose body names itself. The name
  // is not a capture — it is the declaration in progress — so it cannot come
  // from the environment and is bound to a placeholder the body is then
  // constrained against, the knot `inferRecursiveGroup` ties for a group of
  // them.
  const placeholder = freshVar(level + 1);
  captured.types.names.set(value.self, placeholder);
  recordBinding(captured.types, value.self);
  let selfPhase = context.phase;
  const lexicalSelfPhase = lookupBindingPhase(context.types, value.self);
  if (lexicalSelfPhase !== null) selfPhase = lexicalSelfPhase;
  recordBindingPhase(captured.types, value.self, selfPhase);
  const inferred = infer(value.source, inner, level + 1, row);
  located(value.source.span, () => constrain(inferred, placeholder));
  return scheme(inferred, level);
}

/**
 * A type scope for a closure's body, over the names it captured.
 *
 * A closure's environment chains up through the module and the prelude, and
 * those scopes are already typed at the binding site — walking them again would
 * mean bridging hundreds of values to rediscover what `context.types` holds.
 * What the binding site is missing is only what was bound *inside* the function
 * that produced the closure: a parameter like `T`, a local `let`. Those are the
 * names that differ per call, and the evaluator has a value for each.
 *
 * Answers `null` if any of them is a value with no type — a nested closure, a
 * native. The caller then keeps the behaviour this function is an improvement
 * on, rather than inferring a body with a name missing from scope. Deciding it
 * here, before inferring, is what keeps a genuine type error in the selected
 * lambda from being swallowed as "could not specialize".
 */
function capturedScope(
  env: ValueEnv,
  context: Context,
  level: Level,
  self: Value,
  seen: ReadonlySet<Value>,
): { readonly context: Context; readonly types: TypeEnv } | null {
  if (self.tag !== "closure" || self.source === undefined) return null;
  const captures = freeNames(self.source);
  const alreadyTyped = new Set<ValueEnv>();
  for (
    let scope: ValueEnv | null = context.values;
    scope !== null;
    scope = scope.parent
  ) {
    alreadyTyped.add(scope);
  }
  const inner: ValueEnv[] = [];
  let origin: Context | null = null;
  for (
    let scope: ValueEnv | null = env;
    scope !== null;
    scope = scope.parent
  ) {
    if (alreadyTyped.has(scope)) {
      origin = context;
      const needsCapturedScope = [...scope.names].some(([name, value]) =>
        captures.has(name) && lookupComptime(context.types, name) !== value
      );
      if (needsCapturedScope) inner.push(scope);
      break;
    }
    if (scope.module !== null && scope.module.scope === "body") {
      const published = context.staging.interfaces.get(scope.module.identity);
      if (published !== undefined) {
        origin = {
          ...context,
          types: published.types,
          values: published.values,
          imports: published.imports,
          modules: published.modules,
          parameterName: published.parameterName,
          moduleParameters: new Set(),
          forward: new Set(),
        };
        const parameterScope = scope.parent;
        if (
          parameterScope !== null && parameterScope.module !== null &&
          parameterScope.module.identity === scope.module.identity &&
          parameterScope.module.scope === "parameter"
        ) {
          inner.push(parameterScope);
        }
        break;
      }
      const active = context.staging.activeOrigins.get(scope.module.identity);
      if (active !== undefined) {
        origin = active;
        break;
      }
    }
    inner.push(scope);
  }
  if (origin === null) return null;
  const built = childTypeEnv(origin.types);
  const values = childEnv(origin.values);
  const capturePhase = (name: string): "runtime" | "comptime" => {
    if (
      context.values.module !== null && origin.values.module !== null &&
      context.values.module.identity === origin.values.module.identity
    ) {
      const lexical = lookupBindingPhase(context.types, name);
      if (lexical !== null) return lexical;
    }
    return "comptime";
  };
  // Outermost first, so a name bound twice ends up meaning the inner one.
  for (const scope of inner.reverse()) {
    for (const [name, captured] of scope.names) {
      if (!captures.has(name)) continue;
      values.names.set(name, captured);
      // A recursive closure is in the environment it captured, under the name
      // its body calls. That is not a capture to bridge — it is the binding
      // being typed, and `typeClosure` binds it to a placeholder — so skipping
      // it here is what keeps `rec` from bailing on itself.
      if (captured === self) continue;
      const bridged = bridge(captured);
      if (bridged !== null) {
        built.names.set(name, bridged);
        recordBinding(built, name);
        recordBindingPhase(built, name, capturePhase(name));
        recordComptimeBinding(built, name, captured);
        continue;
      }
      // A captured function has no type to bridge to, so it is typed the same
      // way this one is. A helper bound beside the closure is the ordinary case;
      // without this, one local function in scope would sink the whole attempt.
      // `seen` stops a cycle of closures that capture each other, which no
      // single knot can tie.
      if (seen.has(captured)) return null;
      const captive = typeComputedValue(
        captured,
        origin,
        level,
        new Set([...seen, captured]),
      );
      if (captive === null) return null;
      built.names.set(name, captive);
      recordBinding(built, name);
      recordBindingPhase(built, name, capturePhase(name));
      recordComptimeBinding(built, name, captured);
    }
  }
  return { context: { ...origin, values }, types: built };
}

function generalize(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): Typing {
  const inner = infer(expr, context, level + 1, row);
  return scheme(inner, level);
}

function generalizeEffect(
  expr: Expr,
  context: Context,
  level: Level,
  row: SimpleType,
): Typing {
  const inferred = infer(expr, context, level + 1, row);
  const suspended = effectValueSignature(inferred);
  if (suspended === null) return scheme(inferred, level);
  located(expr.span, () => constrain(suspended.effects, row));
  return scheme(suspended.result, level);
}

function effectValueSignature(
  type: SimpleType,
  seen = new Set<number>(),
): { readonly effects: SimpleType; readonly result: SimpleType } | null {
  if (type.tag === "forall") return effectValueSignature(type.body, seen);
  if (type.tag === "fun" && type.param.tag === "unit") {
    return { effects: type.effects, result: type.result };
  }
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  for (const bound of [...type.lower, ...type.upper]) {
    const found = effectValueSignature(bound, seen);
    if (found !== null) return found;
  }
  return null;
}

function generalizePure(
  expr: Expr,
  context: Context,
  level: Level,
  description: string,
): Typing {
  const row = freshVar(level + 1);
  const inner = infer(expr, context, level + 1, row);
  requirePure(row, expr.span, description);
  return scheme(inner, level);
}

function inferPure(
  expr: Expr,
  context: Context,
  level: Level,
  description: string,
): SimpleType {
  const row = freshVar(level);
  const inferred = infer(expr, context, level, row);
  requirePure(row, expr.span, description);
  return inferred;
}

function requirePure(
  row: SimpleType,
  span: Span,
  description: string,
): void {
  try {
    constrain(row, effects([]));
  } catch (error) {
    if (!(error instanceof TypeError_)) throw error;
    fail(
      "BLOT_UNSEQUENCED_EFFECT",
      `${description} performs an effect. Sequence it with ` +
        "`name <- expression` instead.",
      span,
    );
  }
}

/**
 * A recursive group: every member's name is in scope inside every member's
 * lambda, so all of them are bound before any body is inferred.
 *
 * The names are bound monomorphically — a recursive call sees one type — and
 * generalization happens per member once its body is known. A group of one is
 * ordinary self-recursion, which is why there is no separate rule for it.
 */
function inferRecursiveGroup(
  members: readonly RecursiveMember[],
  context: Context,
  level: Level,
  row: SimpleType,
  into: Map<Decl, Typing>,
): void {
  const scope = childTypeEnv(context.types);
  const inner: Context = { ...context, types: scope };
  const placeholders = new Map<string, SimpleType>();
  for (const member of members) {
    if (placeholders.has(member.name)) {
      fail(
        "BLOT_DUPLICATE_RECURSIVE_BINDING",
        `\`${member.name}\` is bound twice in one recursive group. The group's names all enter scope together, so there is no order in which one could shadow the other; rename one, or put another declaration between them.`,
        member.declaration.span,
      );
    }
    const placeholder = freshVar(level + 1);
    placeholders.set(member.name, placeholder);
    scope.names.set(member.name, placeholder);
    recordBinding(scope, member.name);
    recordBindingPhase(scope, member.name, context.phase);
  }
  for (const member of members) {
    const inferred = infer(member.lambda, inner, level + 1, row);
    const placeholder = placeholders.get(member.name);
    expect(placeholder !== undefined, "recursive member lost its placeholder");
    located(
      member.declaration.span,
      () => constrain(inferred, placeholder),
    );
    into.set(member.declaration, scheme(inferred, level));
  }
}

/** Evaluates a shadow's value and names the effect it may have produced. */
function namedComptime(
  name: string,
  expr: Expr,
  context: Context,
): ReturnType<typeof run> | null {
  return nameEffect(name, comptime(expr, context));
}

/**
 * `@effect` cannot know what it will be called, so the binding names it. The
 * identity is preserved: this is a rename, not a second effect.
 */
function nameEffect(
  name: string,
  value: ReturnType<typeof run> | null,
): ReturnType<typeof run> | null {
  if (value === null) return null;
  if (value.tag !== "effect" || value.name !== "Effect") return value;
  return { ...value, name };
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
  /**
   * The type of the module's own parameter, or null where it takes none.
   *
   * An importer applies the module to a record, and this is the variable that
   * record has to satisfy. Standing in a fresh variable instead would accept
   * every argument, including one missing a field the module reads.
   */
  readonly parameter: SimpleType | null;
  readonly effects: SimpleType;
  /** The existing inference result for each expression; backends must not re-infer it. */
  readonly expressionTypes: ReadonlyMap<Expr, SimpleType>;
  /** Independently consumable evidence for every admitted direct array access. */
  readonly arrayProofs: ReadonlyMap<Expr, ArrayIndexProof>;
  /**
   * What each `open` brought into scope.
   *
   * The backend inlines an imported module into the *importer's* scope, so a
   * dependency's own `open` would otherwise install nothing there. The names
   * are compile-time, and inference already had to compute them, so they
   * travel with the rest of the facts rather than being recomputed.
   */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  /**
   * Compile-time declaration values keyed by the expression that produced
   * them. Local bindings do not live in the module's final value environment,
   * but lowering still needs their identities while traversing a residual
   * block.
   */
  readonly comptimeValues: ReadonlyMap<Expr, Value>;
  /**
   * What inference learned that lowering needs.
   *
   * gpufuck has no records: they become nominal declarations, and a nominal
   * needs the *whole* field set. `p.x` alone does not say what else `p` has —
   * inference does, so it writes it down here rather than making the backend
   * re-derive it. Same for the constructor set behind a `case`.
   */
  readonly shapes: ReadonlyMap<Expr, Shape>;
  readonly recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>;
  readonly optionalCases: ReadonlySet<Expr>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  /**
   * The field set of the *value* a shape pattern destructures.
   *
   * blot has width subtyping, so `let { .x; } = point` names fewer fields than
   * the value has. Core records are nominal, so the backend needs the value's
   * set rather than the pattern's — the pattern says what is wanted, not what
   * arrives.
   */
  readonly patternShapes: ReadonlyMap<Pattern, Shape>;
  /** Scalar equality domains for pinned-value patterns. */
  readonly pinnedPatterns: ReadonlyMap<Pattern, PinnedDomain>;
  /**
   * The type of each projection off the entry module's parameter.
   *
   * The parameter is the program's whole authority, and at the WebAssembly
   * boundary that authority *is* the module's imports — so each field the
   * program reaches for becomes a declared host operation, and inference is
   * what knows its signature.
   */
  readonly grants: ReadonlyMap<Expr, GrantSignature>;
  /** Resolved compile-time tag metadata and each transformed binding's type. */
  readonly declarationTags: ReadonlyMap<Decl, TaggedDeclaration>;
}

export interface ResolvedDeclarationTag {
  readonly name: string;
  readonly metadata: Value;
  readonly span: Span;
}

export interface TaggedDeclaration {
  readonly tags: readonly ResolvedDeclarationTag[];
  readonly type: SimpleType;
}

/** A granted capability's shape, as the boundary needs it. */
export interface GrantSignature {
  readonly parameter: SimpleType;
  readonly result: SimpleType;
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
  modules: ReadonlyMap<string, SimpleType>,
  staging: Staging,
): Checked {
  const types = childTypeEnv(null);
  if (prelude !== null) {
    // Quantified below ground level: the prelude's exports were already
    // instantiated once when its result record was built, which left their
    // variables at level 0. Re-generalizing at 0 would make every use share
    // them, so `fold` used once on text could never be used on integers.
    for (const [name, type] of prelude) {
      types.names.set(name, scheme(type, -1));
      recordBindingPhase(types, name, "comptime");
    }
  }
  const shapes = new Map<Expr, Shape>();
  const recordAdaptations = new Map<Expr, RecordAdaptation>();
  const optionalCases = new Set<Expr>();
  const expressionTypes = new Map<Expr, SimpleType>();
  const arrayProofs = new Map<Expr, ArrayIndexProof>();
  const expressionRelations = new Map<Expr, RelationalValue>();
  const variants = new Map<Expr, readonly VariantCase[]>();
  const patternShapes = new Map<Pattern, Shape>();
  const pinnedPatterns = new Map<Pattern, PinnedDomain>();
  const patternBindings = new Map<Pattern, number>();
  const continuationBindings = new Set<number>();
  const continuationCandidates = new Set<number>();
  const cancelledContinuations = new Map<Expr, number>();
  const grants = new Map<Expr, GrantSignature>();
  const opens = new Map<Expr, ReadonlyMap<string, Value>>();
  const comptimeValues = new Map<Expr, Value>();
  const memberValues = new Map<Expr, Value>();
  const declarationTags = new Map<Decl, TaggedDeclaration>();
  const pending: (() => void)[] = [];
  const moduleParameters = new Set<string>();
  if (module.parameter !== null) {
    for (const name of patternNames(module.parameter)) {
      moduleParameters.add(name);
    }
  }
  const context: Context = {
    phase: "runtime",
    deferComptimeBindings: false,
    expressionTypes,
    arrayProofs,
    expressionRelations,
    opens,
    comptimeValues,
    memberValues,
    staging,
    shapes,
    recordAdaptations,
    optionalCases,
    variants,
    patternShapes,
    pinnedPatterns,
    patternBindings,
    continuationBindings,
    continuationCandidates,
    cancelledContinuations,
    grants,
    parameterName: module.parameter !== null && module.parameter.tag === "name"
      ? module.parameter.name
      : null,
    moduleParameters,
    pending,
    types,
    values,
    imports,
    modules,
    declarationTags,
    forward: new Set(),
  };
  if (values.module === null || values.module.scope !== "body") {
    throw new Error("module checking requires a marked module value scope");
  }
  staging.activeOrigins.set(values.module.identity, context);
  const level = 0;
  const row = freshVar(level);

  // The entry module's parameter is the program's whole authority, and its
  // shape is whatever the program actually reaches for — inference discovers
  // the capability requirement rather than the program declaring it. An
  // imported module's parameter is the same variable, and reporting it is what
  // lets an importer's argument be checked against what the module reads. It
  // is also available to a hoisted `const` closure: field projections become
  // host imports rather than captures from an enclosing runtime frame.
  let parameter: SimpleType | null = null;
  if (module.parameter !== null) {
    const parameterContext: Context = { ...context, phase: "comptime" };
    parameter = bindPattern(module.parameter, parameterContext, level);
  }

  inferDeclarations(module.declarations, context, level, row);
  let result: SimpleType;
  if (module.resultEffects === "pure") {
    result = inferPure(
      module.result,
      context,
      level,
      "The module result",
    );
  } else {
    result = infer(module.result, context, level, row);
  }
  for (const [cancellation, identity] of cancelledContinuations) {
    if (continuationBindings.has(identity)) continue;
    fail(
      "BLOT_CANCEL_NOT_CONTINUATION",
      "`Continuation.cancel` accepts only the one-shot continuation bound by a statically known handler clause.",
      cancellation.span,
    );
  }
  // The module's own body has been inferred, so a constraint it owed can be
  // applied before anything reads its row at the boundary.
  for (const owed of pending) owed();
  const published = snapshotSpecializationInterface(context);
  staging.activeOrigins.delete(values.module.identity);
  if (published !== null) {
    staging.interfaces.set(values.module.identity, published);
  }
  return {
    type: result,
    parameter,
    effects: row,
    expressionTypes,
    arrayProofs,
    opens,
    comptimeValues,
    shapes,
    recordAdaptations,
    optionalCases,
    variants,
    patternShapes,
    pinnedPatterns,
    grants,
    declarationTags,
  };
}

export { effects, PRIMITIVE_TYPES };
