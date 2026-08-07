// blot AST -> gpufuck Functional Surface.
//
// gpufuck re-runs Hindley-Milner on whatever it is handed, so blot's
// algebraic-subtyping result is the authority and what reaches here has to be
// specialized enough for HM to re-check. A gpufuck inference failure on a
// well-typed blot program is a lowering bug, never a type-system disagreement
// to paper over.
//
// Three structural gaps between the languages, and how each is closed:
//
//   * **Records and tuples are not Core primitives.** gpufuck lowers them to
//     nominal declarations, so one nominal type is synthesized per distinct
//     field-name set. A tuple is a shape with integer labels, so it needs no
//     second mechanism.
//   * **`if` wants a boolean.** blot's conditions are `#True | #False`, ordinary
//     prelude constructors, so those two tags become gpufuck booleans.
//   * **Application is unary in both languages.** That one costs nothing, which
//     is exactly why blot's single-parameter rule was worth keeping.

import {
  BinaryOperator,
  defineEffectOperation,
  effectSet,
  f32x4,
  F32X4_TYPE_NAME,
  FIXED_VECTOR_DEFINITIONS,
  FIXED_VECTOR_TYPE_DECLARATIONS,
  type HostCapabilityDeclaration,
  type HostDefinitionBinding,
  HostTypes,
  MASK32X4_TYPE_NAME,
  NumericConversion,
  storeType,
  surface,
  type SurfaceDefinition,
  type SurfaceExpression,
  type SurfaceTypeDeclaration,
  type TypeSchema,
  UnaryOperator,
  UNIT_CONSTRUCTOR_NAME,
  WasmIntrinsic,
} from "gpufuck";
import type {
  ArrayElement,
  Decl,
  Expr,
  Module,
  Pattern,
  RecursiveMember,
  ShapeMember,
  Span,
} from "../syntax/ast.ts";
import {
  scheduleComputation,
  scheduledResultExpression,
} from "../core/computation.ts";
import { freeNames } from "../syntax/live.ts";
import { recursiveGroups } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import {
  type GrantSignature,
  type PinnedDomain,
  type RecordAdaptation,
  refuseDisagreement,
  type Shape,
  type VariantCase,
} from "../check/infer.ts";
import {
  type ArrayIndexProof,
  verifiesArrayIndexProof,
} from "../core/proof.ts";
import type { OwnedBinding } from "../check/mod.ts";
import type { NamePattern } from "../linear/check.ts";
import {
  type OwnershipCertificate,
  ownershipUseIdentity,
  verifyOwnershipCertificate,
} from "../linear/certificate.ts";
import {
  type Domain,
  F32X4,
  F32X4_MASK,
  type SimpleType,
} from "../check/type.ts";
import {
  childEnv,
  type Env as ValueEnv,
  F32X4_MASK_NAME,
  F32X4_NAME,
  inferredTypeOf,
  lookup as lookupValue,
  type Value,
} from "../comptime/value.ts";

/**
 * What inference recorded for the backend: the whole field set behind a
 * projection, and the whole constructor set behind a `case`. Neither is
 * recoverable from the syntax, and re-deriving them here would mean a second
 * type checker.
 */
export interface Facts {
  /** Binding-level ownership proofs produced after inference. */
  readonly ownership: ReadonlyMap<NamePattern, OwnedBinding>;
  readonly ownershipCertificate: OwnershipCertificate;
  /** Bounds certificates for direct Store accesses. */
  readonly arrayProofs: ReadonlyMap<Expr, ArrayIndexProof>;
  /** Settled source types used only to select closed specializations. */
  readonly expressionTypes: ReadonlyMap<Expr, SimpleType>;
  /** What each `open` brought into scope, so an inlined module keeps its own. */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  /** Compile-time declaration values that remain inside residual blocks. */
  readonly comptimeValues: ReadonlyMap<Expr, Value>;
  readonly shapes: ReadonlyMap<Expr, Shape>;
  readonly recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>;
  readonly optionalCases: ReadonlySet<Expr>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  /** Dependencies keyed by literal import site, so relative paths never alias. */
  readonly modules: ReadonlyMap<
    Expr,
    { readonly module: Module; readonly values: ValueEnv }
  >;
  /** The field set of the value a shape pattern destructures. */
  readonly patternShapes: ReadonlyMap<Pattern, Shape>;
  /** Equality domains for pins, recorded by inference rather than re-derived. */
  readonly pinnedPatterns: ReadonlyMap<Pattern, PinnedDomain>;
  /** Signatures of the capabilities granted through the module parameter. */
  readonly grants: ReadonlyMap<Expr, GrantSignature>;
}

/** Every union of constructors bound to a compile-time name, in scope order. */
function declaredUnions(values: ValueEnv): (readonly VariantCase[])[] {
  const found: (readonly VariantCase[])[] = [];
  let scope: ValueEnv | null = values;
  while (scope !== null) {
    for (const value of scope.names.values()) {
      if (value.tag !== "union") continue;
      const cases: VariantCase[] = [];
      let allTags = true;
      for (const member of value.members) {
        if (member.tag !== "tag") {
          allTags = false;
          break;
        }
        cases.push({ name: member.name, payload: member.payload !== null });
      }
      if (allTags && cases.length > 0) found.push(cases);
    }
    scope = scope.parent;
  }
  return found;
}

/** A nominal type standing in for one shape of record. */
interface Nominal {
  readonly name: string;
  readonly fields: readonly string[];
}

/** A nominal type standing in for one set of constructors. */
interface Sum {
  readonly name: string;
  readonly cases: readonly VariantCase[];
}

interface Sealed {
  readonly name: string;
  readonly constructor: string;
  readonly sourceName: string;
}

/** Constructors share one namespace in Core, so they are qualified by their type. */
function constructorName(sum: Sum, tag: string): string {
  return `${sum.name}_${tag}`;
}

export interface Lowered {
  readonly definitions: readonly SurfaceDefinition[];
  readonly types: readonly SurfaceTypeDeclaration[];
  readonly entry: string;
  /** Host-implemented effects, as capabilities the module imports. */
  readonly capabilities: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions: readonly HostDefinitionBinding[];
  /**
   * Field names per synthesized nominal, so a caller can read a record back.
   * The boundary hands out a constructor; without this the field names are a
   * lowering detail nobody outside can recover.
   */
  readonly shapes: ReadonlyMap<string, readonly string[]>;
  /** Source spellings for variant and sealed constructors at the ABI. */
  readonly constructors: ReadonlyMap<string, RuntimeConstructor>;
  /** Structural declarations needed to publish the stable caller ABI. */
  readonly runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>;
  readonly exports: readonly LoweredExport[];
  /** Integer vectors use tuple emulation only in the gpufuck conformance path. */
  readonly usesIntegerVectors: boolean;
}

export type RuntimeTypeDeclaration =
  | {
    readonly kind: "record";
    readonly fields: readonly string[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly sourceName: string;
      readonly runtimeName: string;
      readonly payload: boolean;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly sourceName: string;
    readonly runtimeName: string;
  };

export interface RuntimeConstructor {
  readonly kind: "variant" | "sealed";
  readonly sourceName: string;
  readonly payload: boolean;
}

const ENTRY = "main";
const MODULE_RESULT = "blot$module$result";
const OPTIONAL_ABSENT = "OptionalAbsent$";
const OPTIONAL_PRESENT = "OptionalPresent$";

export interface RuntimeExport {
  readonly sourceName: string;
  readonly type: SimpleType;
  readonly value?: Value;
}

export interface LoweredExport {
  readonly sourceName: string;
  readonly wasmName: string;
  readonly definition: string;
  readonly type: TypeSchema;
}

class Lowering {
  readonly nominals = new Map<string, Nominal>();
  readonly sums = new Map<string, Sum>();
  readonly seals = new Map<string, Sealed>();
  readonly definitions: SurfaceDefinition[] = [];
  /**
   * Lambdas that became definitions, by the expression that wrote them.
   *
   * A binding whose value is one of these aliases the definition's name rather
   * than binding a local to it, because the difference is visible downstream:
   * gpufuck reasons about an application of a *definition*, and an application
   * of a local that happens to hold one is opaque to it.
   */
  readonly lifted = new Map<Expr, string>();
  /**
   * Whether this module used a four-lane vector.
   *
   * The declarations and the scalar bodies are gpufuck's, under names its
   * codegen matches to decide whether an application can become one
   * instruction. Emitting them unconditionally would put four unused
   * definitions in every artifact, so a program that never mentions a vector
   * carries none of it.
   */
  vectors = false;
  usesIntegerVectors = false;
  /** Hoisted prelude closures, by identity: one definition per closure. */
  readonly hoisted = new Map<Value, string>();
  /** One capability per host effect, and one definition per operation. */
  readonly capabilities = new Map<string, HostCapabilityDeclaration>();
  readonly hostDefinitions: HostDefinitionBinding[] = [];
  readonly hostOperations = new Map<string, string>();
  /** Which effect owns each capability name; see `hostOperation`. */
  readonly capabilityOwners = new Map<string, number>();
  /** Blot effect operations, as Core evidence a handler can replace. */
  readonly effectOperations = new Map<string, string>();
  private next = 0;

  /**
   * Constructor sets declared as compile-time unions.
   *
   * `const Message = #Ready | #Progress Int` *is* a constructor set, and it is
   * often the only place the whole set appears — a `case` with a wildcard arm
   * names one tag and inference has nothing else to read. Harvesting the
   * declarations is what makes that recoverable without duplicating a
   * definition per instantiation.
   */
  readonly declared: readonly (readonly VariantCase[])[];
  readonly reusableOwnership: ReadonlySet<string>;

  constructor(readonly facts: Facts, values: ValueEnv) {
    this.declared = declaredUnions(values);
    const verified = verifyOwnershipCertificate(facts.ownershipCertificate);
    if (verified === null) {
      throw new Error("lowering received an invalid ownership certificate");
    }
    this.reusableOwnership = verified.reusable;
  }

  /**
   * One nominal per distinct constructor set, and every tag carries a payload
   * slot. blot's `#Ready` has none and `#Progress n` has one; giving both a
   * field and passing unit for the empty case keeps the two forms one shape,
   * which is cheaper than two constructor kinds in Core.
   */
  sum(cases: readonly VariantCase[]): Sum {
    const sorted = [...cases].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const key = sorted.map((entry) => {
      let arity = "0";
      if (entry.payload) arity = "1";
      return `${entry.name}:${arity}`;
    }).join(" ");
    const existing = this.sums.get(key);
    if (existing !== undefined) return existing;
    const sum: Sum = {
      name: `Sum${this.sums.size}`,
      cases: sorted,
    };
    this.sums.set(key, sum);
    return sum;
  }

  seal(sourceName: string): Sealed {
    const existing = this.seals.get(sourceName);
    if (existing !== undefined) return existing;
    const sealed = {
      name: `Sealed${this.seals.size}`,
      constructor: `Sealed${this.seals.size}`,
      sourceName,
    };
    this.seals.set(sourceName, sealed);
    return sealed;
  }

  /**
   * The constructor set a tag belongs to.
   *
   * Inference records the whole set at each `case`, which is where it is
   * knowable; a construction site only knows its own tag. Matching the tag
   * against the recorded sets recovers the rest. An ambiguous tag — one that
   * two different variants both use — is refused rather than guessed.
   */
  sumFor(tag: string, payload: boolean, span: Span): Sum {
    const candidates = new Map<string, readonly VariantCase[]>();
    for (const cases of [...this.facts.variants.values(), ...this.declared]) {
      if (!cases.some((entry) => entry.name === tag)) continue;
      const key = cases.map((entry) => entry.name).sort().join(" ");
      candidates.set(key, cases);
    }
    if (candidates.size === 0) return this.sum([{ name: tag, payload }]);
    if (candidates.size > 1) {
      fail(
        "BLOT_UNSUPPORTED_LOWERING",
        `\`#${tag}\` belongs to more than one union in this module, and lowering cannot tell which one is meant here.`,
        span,
      );
    }
    return this.sum([...candidates.values()][0]);
  }

  fresh(hint: string): string {
    this.next += 1;
    return `${hint}$${this.next}`;
  }

  /**
   * One nominal per distinct field-name set. Two records with the same labels
   * are the same type to gpufuck, which is what makes blot's structural shapes
   * survive a nominal Core.
   */
  nominal(fields: readonly string[]): Nominal {
    // Keyed by the canonical order, because two records with the same *labels*
    // are the same type however they were written. A field set is recorded in
    // the order the program first projected it, so `pair.1` before `pair.0`
    // yields `["1", "0"]` where a tuple literal yields `["0", "1"]` — the same
    // type, and keying on the written order declared both as `Tuple2`.
    const ordered = [...fields].sort((left, right) => {
      const both = /^\d+$/.test(left) && /^\d+$/.test(right);
      if (both) return Number(left) - Number(right);
      if (left < right) return -1;
      return left > right ? 1 : 0;
    });
    const key = ordered.join("\u0000");
    const existing = this.nominals.get(key);
    if (existing !== undefined) return existing;
    let label = `Shape${this.nominals.size}`;
    if (ordered.length === 0) {
      label = "Empty";
    } else if (ordered.every((name) => /^\d+$/.test(name))) {
      label = `Tuple${ordered.length}`;
    }
    // The key is canonical so both orderings find one nominal; construction
    // and projection preserve the source order that established the shape.
    const nominal: Nominal = { name: label, fields };
    this.nominals.set(key, nominal);
    return nominal;
  }

  declarations(): SurfaceTypeDeclaration[] {
    const sums: SurfaceTypeDeclaration[] = [...this.sums.values()].map((
      sum,
    ) => {
      const payloads = sum.cases.filter((entry) => entry.payload);
      return {
        name: sum.name,
        parameters: payloads.map((_, index) => `p${index}`),
        constructors: sum.cases.map((entry) => {
          if (!entry.payload) {
            return {
              name: constructorName(sum, entry.name),
              fields: [],
            };
          }
          const index = payloads.indexOf(entry);
          return {
            name: constructorName(sum, entry.name),
            fields: [{
              name: "payload",
              type: {
                kind: "parameter",
                name: `p${index}`,
              } satisfies TypeSchema,
            }],
          };
        }),
      };
    });
    return [
      ...(this.vectors ? FIXED_VECTOR_TYPE_DECLARATIONS : []),
      ...sums,
      ...[...this.seals.values()].map((sealed) => ({
        name: sealed.name,
        parameters: ["value"],
        constructors: [{
          name: sealed.constructor,
          fields: [{
            name: "value",
            type: { kind: "parameter", name: "value" } satisfies TypeSchema,
          }],
        }],
      })),
      ...[...this.nominals.values()].map((nominal) => ({
        name: nominal.name,
        // Polymorphic in every field: gpufuck's HM decides what each one holds,
        // so the nominal carries structure without committing to content.
        parameters: nominal.fields.map((_, index) => `t${index}`),
        constructors: [{
          name: nominal.name,
          fields: nominal.fields.map((name, index) => ({
            name: `f${index}_${name}`,
            type: { kind: "parameter", name: `t${index}` } satisfies TypeSchema,
          })),
        }],
      })),
    ];
  }
}

interface RuntimeLambda {
  readonly expression: Expr & { readonly tag: "lambda" };
  readonly environment: Scope;
  readonly inferredEffects?: ReadonlySet<number>;
}

interface RuntimeLambdaChoice {
  readonly selector: string;
  readonly consequent: RuntimeLambda;
  readonly alternate: RuntimeLambda;
}

interface RuntimeLambdaAggregate {
  readonly members: ReadonlyMap<string, RuntimeLambda>;
  readonly complete: boolean;
}

interface Scope {
  readonly names: Map<string, string>;
  /** Source binding identities behind names in this lexical scope. */
  readonly patterns: Map<string, NamePattern>;
  /** Source-unspellable control constructors lowered as typed forward jumps. */
  readonly exits: Map<string, string>;
  /**
   * Bindings whose value is a shape written right there.
   *
   * A handler and the computation it wraps both have to be statically known to
   * be specialized, and binding one to a name does not make it less known —
   * `lowerHandle` needs their syntax, not the closures the evaluator would
   * build, so the expression is what is remembered.
   */
  readonly literals: Map<string, Expr>;
  /** Runtime lambdas elaborated at each call site's concrete representation. */
  readonly runtimeLambdas: Map<string, RuntimeLambda>;
  /** Specializable functions retained through a concrete aggregate binding. */
  readonly runtimeLambdaMembers: Map<
    string,
    RuntimeLambdaAggregate
  >;
  /** A runtime choice of lambdas, retained until each concrete application. */
  readonly runtimeLambdaChoices: Map<string, RuntimeLambdaChoice>;
  /** Concrete record representation selected for a specialized binding. */
  readonly recordShapes: Map<string, readonly string[]>;
  /** Concrete record representation selected for a specialized parameter. */
  readonly parameterShapes: Map<Pattern, readonly string[]>;
  /** Concrete argument type selected for a specialized binding. */
  readonly specializedTypes: Map<string, SimpleType>;
  readonly parent: Scope | null;
  /**
   * Set on a lambda's own scope, and flipped when a name resolves past it.
   *
   * A lambda that reaches nothing outside itself is a function; one that does
   * is a closure, and only the first can become a top-level definition without
   * carrying an environment along with it.
   */
  capture?: { escaped: boolean };
  /**
   * The compile-time bindings visible here — the prelude, and whatever a
   * closure captured. A name that is not a local is looked up here and
   * specialized, which is how `+` reaches Wasm at all: `Num.add` is a prelude
   * closure, not a primitive, and nothing would resolve it otherwise.
   */
  readonly values: ValueEnv;
  /** The module parameter's name, whose fields are granted capabilities. */
  granted?: string;
  /**
   * The compile-time value being hoisted into a top-level definition, when
   * this scope is inside one.
   *
   * A hoisted definition has no enclosing frame, so a name it fails to resolve
   * is not an unbound name — the checker already proved every name is bound.
   * It is a `const` reaching for a binding that only exists at run time.
   */
  hoisting?: string;
}

function childScope(parent: Scope | null, values?: ValueEnv): Scope {
  const visibleValues = values === undefined
    ? childEnv(parent!.values)
    : childEnv(values);
  return {
    names: new Map(),
    patterns: new Map(),
    exits: new Map(),
    literals: new Map(),
    runtimeLambdas: new Map(),
    runtimeLambdaMembers: new Map(),
    runtimeLambdaChoices: new Map(),
    recordShapes: new Map(),
    parameterShapes: new Map(),
    specializedTypes: new Map(),
    parent,
    values: visibleValues,
    granted: parent?.granted,
    hoisting: parent?.hoisting,
  };
}

function snapshotValueEnv(environment: ValueEnv): ValueEnv {
  let parent: ValueEnv | null = null;
  if (environment.parent !== null) {
    parent = snapshotValueEnv(environment.parent);
  }
  return {
    names: new Map(environment.names),
    parent,
    module: environment.module,
  };
}

function snapshotScope(scope: Scope): Scope {
  let parent: Scope | null = null;
  if (scope.parent !== null) parent = snapshotScope(scope.parent);
  return {
    names: new Map(scope.names),
    patterns: new Map(scope.patterns),
    exits: new Map(scope.exits),
    literals: new Map(scope.literals),
    runtimeLambdas: new Map(scope.runtimeLambdas),
    runtimeLambdaMembers: new Map(scope.runtimeLambdaMembers),
    runtimeLambdaChoices: new Map(scope.runtimeLambdaChoices),
    recordShapes: new Map(scope.recordShapes),
    parameterShapes: new Map(scope.parameterShapes),
    specializedTypes: new Map(scope.specializedTypes),
    parent,
    capture: scope.capture,
    values: snapshotValueEnv(scope.values),
    granted: scope.granted,
    hoisting: scope.hoisting,
  };
}

/** A value that exists only while compiling: a type, a union, an effect. */
function compileTimeOnly(value: Value | undefined): boolean {
  if (value === undefined) return false;
  // `extended` is a type carrying a namespace — what `struct` returns. Its
  // members are constructors and accessors that have already been applied by
  // the time anything reaches here, so the binding itself never runs.
  return value.tag === "effect" || value.tag === "range" ||
    value.tag === "union" || value.tag === "arrow" ||
    value.tag === "unbounded" || value.tag === "extended" ||
    value.tag === "opaque-type";
}

function resolveLiteral(scope: Scope, name: string): Expr | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.literals.get(name);
    if (found !== undefined) return found;
    current = current.parent;
  }
  return null;
}

function resolveRuntimeLambda(
  scope: Scope,
  name: string,
): RuntimeLambda | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.runtimeLambdas.get(name);
    if (found !== undefined) return found;
    if (current.names.has(name)) return null;
    current = current.parent;
  }
  return null;
}

function resolveRuntimeLambdaMember(
  scope: Scope,
  name: string,
  member: string,
): RuntimeLambda | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const aggregate = current.runtimeLambdaMembers.get(name);
    if (aggregate !== undefined) {
      const found = aggregate.members.get(member);
      if (found === undefined) return null;
      return found;
    }
    if (current.names.has(name)) return null;
    current = current.parent;
  }
  return null;
}

function resolveRuntimeLambdaMembers(
  scope: Scope,
  name: string,
): RuntimeLambdaAggregate | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const aggregate = current.runtimeLambdaMembers.get(name);
    if (aggregate !== undefined) return aggregate;
    if (current.names.has(name)) return null;
    current = current.parent;
  }
  return null;
}

function resolveRuntimeLambdaChoice(
  scope: Scope,
  name: string,
): RuntimeLambdaChoice | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.runtimeLambdaChoices.get(name);
    if (found !== undefined) return found;
    if (current.names.has(name)) return null;
    current = current.parent;
  }
  return null;
}

function runtimeLambdaChoice(
  expr: Expr,
  scope: Scope,
): {
  readonly condition: Expr;
  readonly consequent: RuntimeLambda;
  readonly alternate: RuntimeLambda;
} | null {
  if (
    expr.tag !== "if" || expr.branches.length !== 1 || expr.fallback === null
  ) return null;
  const consequent = specializableLambda(
    expr.branches[0].consequence,
    scope,
  );
  const alternate = specializableLambda(expr.fallback, scope);
  if (consequent === null || alternate === null) return null;
  return {
    condition: expr.branches[0].condition,
    consequent,
    alternate,
  };
}

function specializableLambda(expr: Expr, scope: Scope): RuntimeLambda | null {
  if (expr.tag === "lambda") return { expression: expr, environment: scope };
  if (expr.tag === "var") return resolveRuntimeLambda(scope, expr.name);
  const member = runtimeLambdaMemberReference(expr);
  if (member !== null && member.path.length > 0) {
    return resolveRuntimeLambdaMember(
      scope,
      member.root,
      runtimeLambdaMemberKey(member.path),
    );
  }
  if (expr.tag !== "apply") return null;

  const callable = specializableLambda(expr.fn, scope);
  if (callable === null || callable.expression.parameter.tag !== "name") {
    return null;
  }
  const argumentLambda = specializableLambda(expr.arg, scope);
  const argumentAggregate = specializableRuntimeLambdaAggregate(
    expr.arg,
    scope,
  );
  if (argumentLambda === null && argumentAggregate === null) return null;

  const inner = childScope(callable.environment);
  const parameter = callable.expression.parameter.name;
  if (argumentLambda !== null) {
    inner.runtimeLambdas.set(parameter, argumentLambda);
  }
  if (argumentAggregate !== null) {
    inner.runtimeLambdaMembers.set(parameter, argumentAggregate);
  }
  return specializableLambda(callable.expression.body, inner);
}

function runtimeLambdaMemberReference(
  expr: Expr,
): { readonly root: string; readonly path: readonly string[] } | null {
  if (expr.tag === "var") return { root: expr.name, path: [] };
  if (expr.tag === "field") {
    const target = runtimeLambdaMemberReference(expr.target);
    if (target === null) return null;
    return { root: target.root, path: [...target.path, expr.name] };
  }
  if (expr.tag !== "apply") return null;

  const application = flatten(expr);
  if (
    application.callee.tag !== "intrinsic" ||
    application.callee.name !== "@array.get" ||
    application.args.length !== 2 || application.args[1].tag !== "int"
  ) return null;
  const target = runtimeLambdaMemberReference(application.args[0]);
  if (target === null) return null;
  return {
    root: target.root,
    path: [...target.path, application.args[1].value.toString()],
  };
}

function runtimeLambdaMemberKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function specializableRuntimeLambdaAggregate(
  expr: Expr,
  scope: Scope,
): RuntimeLambdaAggregate | null {
  const reference = runtimeLambdaMemberReference(expr);
  if (reference !== null) {
    const aggregate = resolveRuntimeLambdaMembers(scope, reference.root);
    if (aggregate !== null) {
      if (reference.path.length === 0) return aggregate;
      const prefix = `${runtimeLambdaMemberKey(reference.path)}\u0000`;
      const members = new Map<string, RuntimeLambda>();
      for (const [key, lambda] of aggregate.members) {
        if (key.startsWith(prefix)) {
          members.set(key.slice(prefix.length), lambda);
        }
      }
      if (members.size > 0) {
        return { members, complete: aggregate.complete };
      }
    }
  }
  return aggregateRuntimeLambdas(expr, scope);
}

function handledLambda(expr: Expr, scope: Scope): RuntimeLambda | null {
  const runtime = specializableLambda(expr, scope);
  if (runtime !== null) return runtime;

  let value: Value | null = null;
  if (expr.tag === "var" && resolve(scope, expr.name) === null) {
    value = lookupValue(scope.values, expr.name) ?? null;
  } else if (expr.tag === "field") {
    value = comptimeShapeMember(expr, scope);
  }
  if (value === null || value.tag !== "closure" || value.self !== null) {
    return null;
  }

  const inferredEffects = closureEffectIds(value);

  if (value.source?.tag === "lambda") {
    return {
      expression: value.source,
      environment: childScope(null, value.env),
      inferredEffects,
    };
  }

  const span = value.body.span;
  return {
    expression: {
      tag: "lambda",
      parameter: value.parameter,
      body: value.body,
      span,
    },
    environment: childScope(null, value.env),
    inferredEffects,
  };
}

function closureEffectIds(
  closure: Value & { readonly tag: "closure" },
): ReadonlySet<number> | undefined {
  let inferred = inferredTypeOf(closure);
  while (inferred?.tag === "forall") inferred = inferred.body;
  if (inferred?.tag !== "arrow") return undefined;
  const ids = new Set<number>();
  for (const performed of inferred.effects) {
    let selected = performed;
    if (selected.tag === "extended") selected = selected.inner;
    if (selected.tag === "effect") ids.add(selected.id);
  }
  return ids;
}

function lambdaMayPerform(
  lambda: RuntimeLambda,
  effect: Value & { readonly tag: "effect" },
  lowering: Lowering,
): boolean {
  if (containsIntrinsic(lambda.expression.body, "@handle")) return true;
  if (lambda.inferredEffects !== undefined) {
    return lambda.inferredEffects.has(effect.id);
  }
  const inferred = lowering.facts.expressionTypes.get(lambda.expression);
  if (inferred === undefined || inferred.tag !== "fun") return true;
  return effectRowMayContain(
    inferred.effects,
    `${effect.name}#${effect.id}`,
    new Set(),
  );
}

function containsIntrinsic(expr: Expr, name: string): boolean {
  switch (expr.tag) {
    case "intrinsic":
      return expr.name === name;
    case "apply":
      return containsIntrinsic(expr.fn, name) ||
        containsIntrinsic(expr.arg, name);
    case "field":
      return containsIntrinsic(expr.target, name);
    case "lambda":
      return containsIntrinsic(expr.body, name);
    case "rec":
      return containsIntrinsic(expr.lambda, name);
    case "comptime":
      return containsIntrinsic(expr.body, name);
    case "tuple":
      return expr.elements.some((element) => containsIntrinsic(element, name));
    case "array":
      return expr.elements.some((element) =>
        containsIntrinsic(element.value, name)
      );
    case "shape":
      return expr.members.some((member) =>
        containsIntrinsic(member.value, name)
      );
    case "if":
      return expr.branches.some((branch) =>
        containsIntrinsic(branch.condition, name) ||
        containsIntrinsic(branch.consequence, name)
      ) || (expr.fallback !== null && containsIntrinsic(expr.fallback, name));
    case "case":
      return containsIntrinsic(expr.target, name) ||
        expr.arms.some((arm) => containsIntrinsic(arm.body, name));
    case "block":
      return expr.declarations.some((declaration) =>
        containsIntrinsic(declaration.value, name)
      ) || containsIntrinsic(expr.result, name);
    default:
      return false;
  }
}

function effectRowMayContain(
  row: SimpleType,
  label: string,
  seen: Set<number>,
): boolean {
  if (row.tag === "effects") return row.labels.has(label);
  if (row.tag === "forall") {
    return effectRowMayContain(row.body, label, seen);
  }
  if (row.tag !== "var") return true;
  if (seen.has(row.id)) return false;
  seen.add(row.id);
  const bounds = [...row.lower, ...row.upper];
  if (bounds.length === 0) return false;
  return bounds.some((bound) => effectRowMayContain(bound, label, seen));
}

function aggregateRuntimeLambdas(
  expr: Expr,
  scope: Scope,
): RuntimeLambdaAggregate | null {
  if (expr.tag !== "shape" && expr.tag !== "tuple" && expr.tag !== "array") {
    return null;
  }
  const members = new Map<string, RuntimeLambda>();

  function collect(value: Expr, path: readonly string[]): boolean {
    const lambda = specializableLambda(value, scope);
    if (lambda !== null) {
      members.set(runtimeLambdaMemberKey(path), lambda);
      return true;
    }

    const candidates: { readonly name: string; readonly value: Expr }[] = [];
    if (value.tag === "shape") {
      if (value.members.some((member) => member.tag !== "field")) return false;
      for (const member of value.members) {
        if (member.tag !== "field") {
          throw new Error("a checked direct shape member is a spread");
        }
        candidates.push({ name: member.name, value: member.value });
      }
    }
    if (value.tag === "tuple") {
      for (const [index, element] of value.elements.entries()) {
        candidates.push({ name: String(index), value: element });
      }
    }
    if (value.tag === "array") {
      if (value.elements.some((element) => element.spread)) return false;
      for (const [index, element] of value.elements.entries()) {
        candidates.push({ name: String(index), value: element.value });
      }
    }
    if (candidates.length === 0) return false;

    let complete = true;
    for (const candidate of candidates) {
      if (!collect(candidate.value, [...path, candidate.name])) {
        complete = false;
      }
    }
    return complete;
  }

  const complete = collect(expr, []);
  if (members.size === 0) return null;
  return { members, complete };
}

function capturesRuntimeBinding(lambda: Expr, scope: Scope): boolean {
  for (const name of freeNames(lambda)) {
    let current: Scope | null = scope;
    while (current !== null) {
      if (current.names.has(name)) return true;
      if (current.runtimeLambdas.has(name)) break;
      current = current.parent;
    }
  }
  return false;
}

function resolveRecordShape(
  scope: Scope,
  name: string,
): readonly string[] | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const fields = current.recordShapes.get(name);
    if (fields !== undefined) return fields;
    if (current.names.has(name)) return null;
    current = current.parent;
  }
  return null;
}

function concreteRecordShape(
  expr: Expr,
  lowering: Lowering,
): readonly string[] | null {
  const type = lowering.facts.expressionTypes.get(expr);
  if (type === undefined) return null;
  return concreteRecordShapeFromType(type);
}

function concreteRecordShapeFromType(
  type: SimpleType,
): readonly string[] | null {
  const shapes = new Map<string, readonly string[]>();
  const seen = new Set<number>();
  const visit = (current: SimpleType): void => {
    if (current.tag === "record") {
      const fields = [...current.fields.keys()];
      shapes.set([...fields].sort().join("\u0000"), fields);
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    for (const bound of current.lower) visit(bound);
  };
  visit(type);
  if (shapes.size !== 1) return null;
  for (const fields of shapes.values()) return fields;
  return null;
}

function resolveSpecializedType(
  scope: Scope,
  name: string,
): SimpleType | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const type = current.specializedTypes.get(name);
    if (type !== undefined) return type;
    if (current.names.has(name)) return null;
    current = current.parent;
  }
  return null;
}

function concreteFieldType(type: SimpleType, name: string): SimpleType | null {
  const found = new Set<SimpleType>();
  const seen = new Set<number>();
  const visit = (current: SimpleType): void => {
    if (current.tag === "record") {
      const field = current.fields.get(name);
      if (field !== undefined) found.add(field);
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    for (const bound of current.lower) visit(bound);
  };
  visit(type);
  if (found.size !== 1) return null;
  for (const field of found) return field;
  return null;
}

function specializePatternShapes(
  pattern: Pattern,
  type: SimpleType,
  scope: Scope,
): void {
  if (pattern.tag === "shape") {
    const fields = concreteRecordShapeFromType(type);
    if (fields !== null) scope.parameterShapes.set(pattern, fields);
    return;
  }
  if (pattern.tag !== "tuple") return;
  for (let index = 0; index < pattern.elements.length; index += 1) {
    const field = concreteFieldType(type, String(index));
    if (field !== null) {
      specializePatternShapes(pattern.elements[index], field, scope);
    }
  }
}

function resolve(scope: Scope, name: string): string | null {
  // Every lambda boundary walked past before the name was found is a lambda
  // that captured it.
  const crossed: { escaped: boolean }[] = [];
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.names.get(name);
    if (found !== undefined) {
      for (const boundary of crossed) boundary.escaped = true;
      return found;
    }
    if (current.capture !== undefined) crossed.push(current.capture);
    current = current.parent;
  }
  return null;
}

function bindName(
  pattern: NamePattern,
  name: string,
  scope: Scope,
): void {
  scope.names.set(pattern.name, name);
  scope.patterns.set(pattern.name, pattern);
}

function resolvePattern(scope: Scope, name: string): NamePattern | null {
  let current: Scope | null = scope;
  while (current !== null) {
    if (current.names.has(name)) {
      const pattern = current.patterns.get(name);
      if (pattern === undefined) return null;
      return pattern;
    }
    current = current.parent;
  }
  return null;
}

function resolveExit(scope: Scope, constructor: string): string | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.exits.get(constructor);
    if (found !== undefined) return found;
    current = current.parent;
  }
  return null;
}

/** Primitives with a direct Core operator. Everything else is unsupported. */
/**
 * What a four-lane vector says at the module boundary.
 *
 * It says the truth, which the boundary then refuses. The domain switches that
 * produce a boundary type ended in `return HostTypes.text`, so a domain none of
 * them named was published as `Text` — a vector reached gpufuck claiming to be
 * a string, and the diagnostic was a type mismatch in the target rather than a
 * fact about the program.
 */
const VECTOR_SCHEMA: TypeSchema = {
  kind: "named",
  name: F32X4_TYPE_NAME,
  arguments: [],
};

const VECTOR_MASK_SCHEMA: TypeSchema = {
  kind: "named",
  name: MASK32X4_TYPE_NAME,
  arguments: [],
};

/**
 * What an opaque type says at the module boundary.
 *
 * `F32x4` is the only opaque the backend knows a layout for, and saying it here
 * is what lets `compile.ts` refuse a vector export as a fact about the boundary
 * rather than as a lowering it could not perform. Every other opaque is a name
 * the checker was handed and nothing more — a host capability, a seal the
 * caller cannot see through — so there is no layout to publish and `null` says
 * so rather than a schema that guesses.
 */
function opaqueSchema(name: string): TypeSchema | null {
  if (name === F32X4_NAME) return VECTOR_SCHEMA;
  if (name === F32X4_MASK_NAME) return VECTOR_MASK_SCHEMA;
  return null;
}

/**
 * What a range says at the module boundary.
 *
 * One function rather than the four copies this used to be. Each copy ended in
 * `return HostTypes.text`, so every domain added since — `float32`, and the
 * vector that was briefly a domain of its own — silently became `Text` in
 * whichever copies were missed, and the diagnostic arrived as a type mismatch
 * inside gpufuck rather than as a fact about the program. A `switch` the
 * compiler checks for exhaustiveness cannot miss the next one.
 */
function rangeSchema(domain: Domain): TypeSchema {
  switch (domain) {
    case "int":
      return { kind: "signed-integer-64" };
    case "float":
      return { kind: "float-64" };
    case "float32":
      return { kind: "float-32" };
    case "text":
      return HostTypes.text;
  }
}

const BINARY: ReadonlyMap<string, BinaryOperator> = new Map([
  ["@int.add", BinaryOperator.AddSignedInteger64],
  ["@int.sub", BinaryOperator.SubtractSignedInteger64],
  ["@int.mul", BinaryOperator.MultiplySignedInteger64],
  ["@int.div", BinaryOperator.DivideSignedInteger64],
  ["@int.rem", BinaryOperator.RemainderSignedInteger64],
  // No overflow guard for these: `lowerIntegerBinary` passes anything that is
  // not signed add, subtract, or multiply straight through, and IEEE 754 has
  // an answer for every float operation — an infinity or a NaN, both of which
  // are values the program may go on to use.
  ["@float.add", BinaryOperator.AddFloat64],
  ["@float.sub", BinaryOperator.SubtractFloat64],
  ["@float.mul", BinaryOperator.MultiplyFloat64],
  ["@float.div", BinaryOperator.DivideFloat64],
  ["@float.rem", BinaryOperator.RemainderFloat64],
  ["@f32.add", BinaryOperator.AddFloat32],
  ["@f32.sub", BinaryOperator.SubtractFloat32],
  ["@f32.mul", BinaryOperator.MultiplyFloat32],
  ["@f32.div", BinaryOperator.DivideFloat32],
]);

export function lowerModule(
  module: Module,
  facts: Facts,
  values: ValueEnv,
  runtimeExports: readonly RuntimeExport[] = [],
): Lowered {
  const lowering = new Lowering(facts, values);
  const scope = childScope(null, values);

  // The entry module's parameter is the program's whole authority, and at this
  // boundary that authority *is* the module's imports. It has no runtime
  // representation of its own: each field the program reaches for becomes a
  // declared host operation, so nothing is passed in and nothing is ambient.
  if (module.parameter !== null && module.parameter.tag === "name") {
    scope.granted = module.parameter.name;
  } else if (module.parameter !== null) {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      "A module parameter must be a single name to be granted as capabilities.",
      module.span,
    );
  }

  const body = lowerBlock(
    module.declarations,
    module.result,
    module.resultEffects,
    scope,
    lowering,
  );
  // Canonical calls reclaim their private arena, so module evaluation cannot be a memoized global
  // thunk. The unit parameter also lets every export share this body without copying it.
  const moduleArgument = lowering.fresh("module");
  lowering.definitions.push({
    name: MODULE_RESULT,
    parameters: [moduleArgument],
    annotation: null,
    body,
  });
  const exports = lowerExports(
    module.result,
    runtimeExports,
    lowering,
  );
  if (exports.some((exported) => exported.type.kind === "function")) {
    const initialized = lowering.fresh("module");
    lowering.definitions.push({
      name: ENTRY,
      parameters: [],
      annotation: { kind: "unit" },
      body: surface.let(
        initialized,
        moduleResultCall(),
        surface.name(UNIT_CONSTRUCTOR_NAME),
      ),
    });
  } else {
    lowering.definitions.push({
      name: ENTRY,
      parameters: [],
      annotation: null,
      body: moduleResultCall(),
    });
  }

  return {
    // The scalar bodies come first: they are ordinary definitions the rest of
    // the module may call, and gpufuck replaces their call sites rather than
    // their bodies.
    definitions: lowering.vectors
      ? [...FIXED_VECTOR_DEFINITIONS, ...lowering.definitions]
      : lowering.definitions,
    types: lowering.declarations(),
    entry: ENTRY,
    capabilities: [...lowering.capabilities.values()],
    hostDefinitions: lowering.hostDefinitions,
    exports,
    shapes: new Map(
      [...lowering.nominals.values()].map((nominal) =>
        [nominal.name, nominal.fields] as const
      ),
    ),
    constructors: new Map<string, RuntimeConstructor>([
      ...[...lowering.sums.values()].flatMap((sum) =>
        sum.cases.map((entry) =>
          [
            constructorName(sum, entry.name),
            {
              kind: "variant",
              sourceName: entry.name,
              payload: entry.payload,
            },
          ] as const
        )
      ),
      ...[...lowering.seals.values()].map((sealed) =>
        [
          sealed.constructor,
          {
            kind: "sealed",
            sourceName: sealed.sourceName,
            payload: true,
          },
        ] as const
      ),
    ]),
    runtimeTypes: new Map<string, RuntimeTypeDeclaration>([
      ...[...lowering.nominals.values()].map((nominal) =>
        [
          nominal.name,
          { kind: "record", fields: nominal.fields },
        ] as const
      ),
      ...[...lowering.sums.values()].map((sum) =>
        [
          sum.name,
          {
            kind: "variant",
            cases: sum.cases.map((case_) => ({
              sourceName: case_.name,
              runtimeName: constructorName(sum, case_.name),
              payload: case_.payload,
            })),
          },
        ] as const
      ),
      ...[...lowering.seals.values()].map((sealed) =>
        [
          sealed.name,
          {
            kind: "sealed",
            sourceName: sealed.sourceName,
            runtimeName: sealed.constructor,
          },
        ] as const
      ),
    ]),
    usesIntegerVectors: lowering.usesIntegerVectors,
  };
}

function moduleResultCall(): SurfaceExpression {
  return surface.apply(
    surface.name(MODULE_RESULT),
    surface.name(UNIT_CONSTRUCTOR_NAME),
  );
}

function lowerExports(
  result: Expr,
  exports: readonly RuntimeExport[],
  lowering: Lowering,
): LoweredExport[] {
  if (exports.length === 0) return [];
  const [first] = exports;
  if (exports.length === 1 && first.sourceName === "default") {
    return [lowerExport(
      first,
      moduleResultCall(),
      0,
      result.span,
      lowering,
    )];
  }
  let shape: (Expr & { readonly tag: "shape" }) | null = null;
  if (result.tag === "shape") shape = result;
  if (result.tag === "block" && result.result.tag === "shape") {
    shape = result.result;
  }
  if (shape === null) {
    throw new Error("named exports require a record module result");
  }

  const nominal = lowering.nominal(
    exports.map((exported) => exported.sourceName),
  );
  const binders = nominal.fields.map((field) => lowering.fresh(field));
  return exports.map((exported, index) => {
    const field = nominal.fields.indexOf(exported.sourceName);
    if (field < 0) {
      throw new Error(
        `module result omitted runtime export ${exported.sourceName}`,
      );
    }
    const body = surface.case(moduleResultCall(), [{
      constructor: nominal.name,
      binders,
      body: surface.name(binders[field]),
    }]);
    return lowerExport(exported, body, index, result.span, lowering);
  });
}

function lowerExport(
  exported: RuntimeExport,
  body: SurfaceExpression,
  index: number,
  span: Span,
  lowering: Lowering,
): LoweredExport {
  const definition = `blot$export$${index}`;
  const wasmName = `blot:${exported.sourceName}`;
  let type: TypeSchema;
  if (exported.value !== undefined && exported.value.tag === "sealed") {
    type = valueExportSchema(
      exported.value,
      exported.sourceName,
      span,
      lowering,
    );
  } else {
    type = exportSchema(exported.type, exported.sourceName, span, lowering);
  }
  const parameters: string[] = [];
  let definitionBody = body;
  let residualType = type;
  while (residualType.kind === "function") {
    parameters.push(lowering.fresh("parameter"));
    residualType = residualType.result;
  }
  let compiledType = type;
  if (parameters.length === 0) {
    parameters.push(lowering.fresh("export"));
    compiledType = {
      kind: "function",
      parameter: { kind: "unit" },
      result: type,
    };
  } else {
    definitionBody = surface.apply(
      definitionBody,
      ...parameters.map((parameter) => surface.name(parameter)),
    );
  }
  lowering.definitions.push({
    name: definition,
    parameters,
    annotation: compiledType,
    body: definitionBody,
  });
  return {
    sourceName: exported.sourceName,
    wasmName,
    definition,
    type,
  };
}

function exportSchema(
  type: SimpleType,
  name: string,
  span: Span,
  lowering: Lowering,
  seen = new Set<number>(),
): TypeSchema {
  switch (type.tag) {
    case "unit":
      return { kind: "unit" };
    case "range":
      return rangeSchema(type.domain);
    case "opaque": {
      // Before `F32x4` was opaque this fell to `unsupportedExport`, which was
      // right for every opaque there was. It is not right for a type the
      // backend has a layout for: the boundary is what refuses a vector, and it
      // can only do that if it is shown one.
      const opaque = opaqueSchema(type.name);
      if (opaque === null) return unsupportedExport(name, span);
      return opaque;
    }
    case "fun":
      return {
        kind: "function",
        parameter: exportSchema(type.param, name, span, lowering, seen),
        result: exportSchema(type.result, name, span, lowering, seen),
      };
    case "record": {
      const nominal = lowering.nominal([...type.fields.keys()]);
      return {
        kind: "named",
        name: nominal.name,
        arguments: nominal.fields.map((field) => {
          const fieldType = type.fields.get(field);
          if (fieldType === undefined) {
            throw new Error(
              `inferred record for export ${name} omitted field ${field}`,
            );
          }
          return exportSchema(fieldType, name, span, lowering, seen);
        }),
      };
    }
    case "array":
      return storeType(exportSchema(type.element, name, span, lowering, seen));
    case "variant": {
      const names = [...type.cases.keys()];
      if (
        names.length > 0 &&
        names.every((constructor) =>
          constructor === "True" || constructor === "False"
        )
      ) {
        return { kind: "boolean" };
      }
      const cases = names.map((constructor) => {
        const payload = type.cases.get(constructor);
        if (payload === undefined) {
          throw new Error(
            `inferred variant for export ${name} omitted ${constructor}`,
          );
        }
        return { name: constructor, payload: payload.tag !== "unit" };
      });
      const sum = lowering.sum(cases);
      return {
        kind: "named",
        name: sum.name,
        arguments: sum.cases.flatMap((constructor) => {
          if (!constructor.payload) return [];
          const payload = type.cases.get(constructor.name);
          if (payload === undefined) {
            throw new Error(
              `inferred variant for export ${name} omitted ${constructor.name}`,
            );
          }
          return [exportSchema(payload, name, span, lowering, seen)];
        }),
      };
    }
    case "var": {
      if (seen.has(type.id)) return unsupportedExport(name, span);
      seen.add(type.id);
      let bounds = type.lower;
      if (bounds.length === 0) bounds = type.upper;
      if (bounds.length === 0) return unsupportedExport(name, span);
      if (bounds.every((bound) => bound.tag === "range")) {
        const ranges = bounds as (SimpleType & { readonly tag: "range" })[];
        const domain = ranges[0].domain;
        if (ranges.every((range) => range.domain === domain)) {
          return rangeSchema(domain);
        }
      }
      // An open bound names the constructors one `case` read rather than the
      // whole union, and an export needs the whole one.
      if (bounds.every((bound) => bound.tag === "variant" && !bound.open)) {
        const cases = new Map<string, SimpleType>();
        for (const bound of bounds) {
          if (bound.tag !== "variant") {
            throw new Error("variant bounds changed while lowering an export");
          }
          for (const [constructor, payload] of bound.cases) {
            cases.set(constructor, payload);
          }
        }
        return exportSchema(
          { tag: "variant", cases, open: false },
          name,
          span,
          lowering,
          new Set(seen),
        );
      }
      const schemas = bounds.map((bound) =>
        exportSchema(bound, name, span, lowering, new Set(seen))
      );
      const [first] = schemas;
      const key = JSON.stringify(first);
      if (schemas.some((schema) => JSON.stringify(schema) !== key)) {
        return unsupportedExport(name, span);
      }
      return first;
    }
    case "union": {
      const schemas = type.members.map((member) =>
        exportSchema(member, name, span, lowering, new Set(seen))
      );
      const [first] = schemas;
      if (first === undefined) return unsupportedExport(name, span);
      const key = JSON.stringify(first);
      if (schemas.some((schema) => JSON.stringify(schema) !== key)) {
        return unsupportedExport(name, span);
      }
      return first;
    }
    default:
      return unsupportedExport(name, span);
  }
}

function valueExportSchema(
  value: Value,
  name: string,
  span: Span,
  lowering: Lowering,
): TypeSchema {
  if (value.tag === "sealed") {
    const sealed = lowering.seal(value.name);
    return {
      kind: "named",
      name: sealed.name,
      arguments: [valueExportSchema(value.inner, name, span, lowering)],
    };
  }
  const bridged = bridgeRuntimeValue(value);
  if (bridged === null) return unsupportedExport(name, span);
  return exportSchema(bridged, name, span, lowering);
}

function bridgeRuntimeValue(value: Value): SimpleType | null {
  switch (value.tag) {
    case "int":
      return {
        tag: "range",
        domain: "int",
        low: value.value,
        high: value.value,
      };
    case "float":
      return { tag: "range", domain: "float", low: null, high: null };
    case "float32":
      return { tag: "range", domain: "float32", low: null, high: null };
    case "vector":
      return F32X4;
    case "vector-mask":
      return F32X4_MASK;
    // Deliberately absent: `opaque-type`. This maps a runtime value to its
    // type, and a type value has none to give — saying `F32x4` here would
    // claim the type of the type `F32x4` is `F32x4`. Every other type-shaped
    // value falls through to `null`, which becomes
    // BLOT_EXPORT_NOT_FIRST_ORDER, and this one belongs with them.
    case "text":
      return {
        tag: "range",
        domain: "text",
        low: value.value,
        high: value.value,
      };
    case "unit":
      return { tag: "unit" };
    case "array": {
      const elements: SimpleType[] = [];
      for (const element of value.elements) {
        const type = bridgeRuntimeValue(element);
        if (type === null) return null;
        elements.push(type);
      }
      return { tag: "array", element: { tag: "union", members: elements } };
    }
    case "shape": {
      const fields = new Map<string, SimpleType>();
      for (const [field, member] of value.fields) {
        const type = bridgeRuntimeValue(member);
        if (type === null) return null;
        fields.set(field, type);
      }
      return { tag: "record", fields };
    }
    case "tag": {
      let payload: SimpleType = { tag: "unit" };
      if (value.payload !== null) {
        const bridged = bridgeRuntimeValue(value.payload);
        if (bridged === null) return null;
        payload = bridged;
      }
      return {
        tag: "variant",
        cases: new Map([[value.name, payload]]),
        open: false,
      };
    }
    default:
      return null;
  }
}

function unsupportedExport(name: string, span: Span): never {
  return fail(
    "BLOT_EXPORT_NOT_FIRST_ORDER",
    `Export \`${name}\` does not have a concrete first-order WebAssembly type.`,
    span,
  );
}

/**
 * A host effect's operation, as the definition that calls it.
 *
 * gpufuck's capabilities are exactly blot's host effects: a named record of
 * operations, each with a parameter type, a result type, and the effect it
 * performs. Declaring one turns it into a typed WebAssembly import, so blot
 * needs no raw import form — you declare an effect, and the boundary follows.
 */
function hostOperation(
  effect: Value & { tag: "effect" },
  operation: string,
  lowering: Lowering,
  span: Span,
): string {
  const key = `${effect.name}#${effect.id}.${operation}`;
  const existing = lowering.hostOperations.get(key);
  if (existing !== undefined) return existing;

  const signature = effect.operations.get(operation);
  if (signature === undefined || signature.tag !== "arrow") {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      `\`${effect.name}.${operation}\` has no operation type to import against.`,
      span,
    );
  }
  const parameter = boundaryType(signature.domain, span, lowering);
  const result = boundaryType(signature.codomain, span, lowering);
  // Named by identity, not by spelling. The memo that stops this being minted
  // twice is keyed on the effect's id, and a name that is less unique than its
  // memo is a duplicate definition waiting for two effects to share a name.
  const name = `${effect.name}$${effect.id}$${operation}`;

  lowering.hostOperations.set(key, name);
  lowering.definitions.push({
    name,
    parameters: [],
    annotation: { kind: "function", parameter, result },
    // Never executed: the binding below replaces the body with the import.
    body: surface.runtimeFault(`host operation ${effect.name}.${operation}`),
  });

  const capability = lowering.capabilities.get(effect.name);
  // Unlike a definition name, a capability name *is* the host-facing contract —
  // the host supplies `init.Console` by that name — so it cannot be made unique
  // behind the programmer's back. Two distinct host effects claiming it are
  // ambiguous at the boundary, and merging their operations would be worse than
  // saying so.
  if (
    capability !== undefined &&
    lowering.capabilityOwners.get(effect.name) !== effect.id
  ) {
    fail(
      "BLOT_AMBIGUOUS_CAPABILITY",
      `Two different host effects are both named \`${effect.name}\`, so the host cannot tell which one it is implementing.`,
      span,
    );
  }
  lowering.capabilityOwners.set(effect.name, effect.id);
  const field = {
    kind: "operation" as const,
    name: operation,
    effects: effectSet(effect.name),
    parameter,
    result,
  };
  if (capability === undefined) {
    lowering.capabilities.set(effect.name, {
      name: effect.name,
      fields: [field],
    });
  } else {
    lowering.capabilities.set(effect.name, {
      name: effect.name,
      fields: [...capability.fields, field],
    });
  }
  lowering.hostDefinitions.push({
    definition: name,
    capability: effect.name,
    field: operation,
  });
  return name;
}

/**
 * A blot effect's operation, as Core evidence.
 *
 * gpufuck carries an effect label on a definition and lets a handler *replace*
 * the operation lexically; a pure replacement discharges the label. So an
 * operation is an ordinary definition whose body traps — unhandled is exactly
 * what a trap means — and handling it is substituting a real implementation.
 */
function effectOperation(
  effect: Value & { tag: "effect" },
  operation: string,
  lowering: Lowering,
  span: Span,
): string {
  const key = `${effect.name}#${effect.id}.${operation}`;
  const existing = lowering.effectOperations.get(key);
  if (existing !== undefined) return existing;

  const signature = effect.operations.get(operation);
  if (signature === undefined || signature.tag !== "arrow") {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      `\`${effect.name}.${operation}\` has no operation type.`,
      span,
    );
  }
  const name = `${effect.name}$${effect.id}$${operation}`;

  lowering.effectOperations.set(key, name);
  lowering.definitions.push(defineEffectOperation({
    name,
    parameter: {
      name: "argument",
      type: boundaryType(signature.domain, span, lowering),
    },
    result: boundaryType(signature.codomain, span, lowering),
    effects: effectSet(`${effect.name}.${operation}`),
    // Performing with nothing to handle it is a trap, which is what the
    // checker already refuses statically. This is the residue of that rule.
    body: surface.runtimeFault(`unhandled effect ${effect.name}.${operation}`),
  }));
  return name;
}

function grantedName(scope: Scope): string | undefined {
  let current: Scope | null = scope;
  while (current !== null) {
    if (current.granted !== undefined) return current.granted;
    current = current.parent;
  }
  return undefined;
}

/**
 * An inferred type, as a boundary type.
 *
 * Distinct from `boundaryType`, which reads a compile-time *value*: a granted
 * capability's signature comes from inference, not from a written type, so the
 * lattice is what has to be read here.
 */
function schemaOf(
  type: SimpleType,
  operation: string,
  span: Span,
  lowering: Lowering,
  unconstrained: TypeSchema | null = null,
  seen = new Set<number>(),
): TypeSchema {
  if (type.tag === "unit") return { kind: "unit" };
  if (type.tag === "range") {
    return rangeSchema(type.domain);
  }
  if (type.tag === "opaque") {
    const opaque = opaqueSchema(type.name);
    if (opaque !== null) return opaque;
  }
  if (type.tag === "variant") {
    const names = [...type.cases.keys()].sort();
    if (names.length > 0 && names.every((n) => n === "True" || n === "False")) {
      return { kind: "boolean" };
    }
    return exportSchema(type, operation, span, lowering);
  }
  if (type.tag === "record" || type.tag === "array") {
    return exportSchema(type, operation, span, lowering);
  }
  if (type.tag === "var" && !seen.has(type.id)) {
    seen.add(type.id);
    for (const bound of [...type.lower, ...type.upper]) {
      try {
        return schemaOf(
          bound,
          operation,
          span,
          lowering,
          unconstrained,
          seen,
        );
      } catch {
        continue;
      }
    }
    // A result nothing observes has no constraints to read, and `()` is what
    // "nothing observes it" means at the boundary. Only the result position
    // passes a fallback: an unconstrained *parameter* would mean the host
    // cannot know what it is being handed.
    if (unconstrained !== null) return unconstrained;
  }
  fail(
    "BLOT_UNSUPPORTED_LOWERING",
    `The granted capability \`${operation}\` takes or returns something that cannot cross the host boundary — only integers, text, booleans, and \`()\` can.`,
    span,
  );
}

/** The capability a module parameter's field names. */
const GRANT_CAPABILITY = "Init";

function grantOperation(
  operation: string,
  signature: GrantSignature,
  lowering: Lowering,
  span: Span,
): string {
  const key = `${GRANT_CAPABILITY}.${operation}`;
  const existing = lowering.hostOperations.get(key);
  if (existing !== undefined) return existing;

  const parameter = schemaOf(signature.parameter, operation, span, lowering);
  const result = schemaOf(
    signature.result,
    operation,
    span,
    lowering,
    { kind: "unit" },
  );
  const name = `${GRANT_CAPABILITY}$${operation}`;
  lowering.hostOperations.set(key, name);
  lowering.definitions.push({
    name,
    parameters: [],
    annotation: { kind: "function", parameter, result },
    body: surface.runtimeFault(`host operation ${key}`),
  });

  const capability = lowering.capabilities.get(GRANT_CAPABILITY);
  const field = {
    kind: "operation" as const,
    name: operation,
    effects: effectSet(GRANT_CAPABILITY),
    parameter,
    result,
  };
  lowering.capabilities.set(GRANT_CAPABILITY, {
    name: GRANT_CAPABILITY,
    fields: capability === undefined ? [field] : [...capability.fields, field],
  });
  lowering.capabilityOwners.set(GRANT_CAPABILITY, -1);
  lowering.hostDefinitions.push({
    definition: name,
    capability: GRANT_CAPABILITY,
    field: operation,
  });
  return name;
}

/** The capability blot declares for text it cannot inspect in Core. */
const TEXT_CAPABILITY = "Text";

function textOperation(
  operation: string,
  parameter: TypeSchema,
  result: TypeSchema,
  lowering: Lowering,
): string {
  const key = `${TEXT_CAPABILITY}.${operation}`;
  const existing = lowering.hostOperations.get(key);
  if (existing !== undefined) return existing;

  const name = `${TEXT_CAPABILITY}$${operation}`;
  lowering.hostOperations.set(key, name);
  lowering.definitions.push({
    name,
    parameters: [],
    annotation: { kind: "function", parameter, result },
    body: surface.runtimeFault(`host operation ${key}`),
  });

  const capability = lowering.capabilities.get(TEXT_CAPABILITY);
  const field = {
    kind: "operation" as const,
    name: operation,
    effects: effectSet(),
    parameter,
    result,
    wasmIntrinsic: textIntrinsic(operation),
  };
  lowering.capabilities.set(TEXT_CAPABILITY, {
    name: TEXT_CAPABILITY,
    fields: capability === undefined ? [field] : [...capability.fields, field],
  });
  lowering.capabilityOwners.set(TEXT_CAPABILITY, -1);
  lowering.hostDefinitions.push({
    definition: name,
    capability: TEXT_CAPABILITY,
    field: operation,
  });
  return name;
}

function textIntrinsic(operation: string): WasmIntrinsic {
  if (operation === "length") return WasmIntrinsic.TextCodePointLength;
  if (operation === "of_int") {
    return WasmIntrinsic.TextFromSignedInteger64;
  }
  if (operation === "compare") return WasmIntrinsic.TextCompare;
  if (operation === "contains") return WasmIntrinsic.TextContains;
  throw new Error(`Blot text operation ${operation} has no Wasm intrinsic`);
}

/**
 * A blot type value, as a boundary type.
 *
 * Only the scalars and text cross today. A shape would need a nominal on both
 * sides of the boundary, and inventing one silently would make the import's
 * contract a guess.
 */
function boundaryType(
  value: Value,
  span: Span,
  lowering: Lowering,
): TypeSchema {
  if (value.tag === "extended") {
    return boundaryType(value.inner, span, lowering);
  }
  if (value.tag === "unit") return { kind: "unit" };
  if (value.tag === "range") {
    const domain = value.domain ??
      (value.low.tag === "int" || value.high.tag === "int" ? "int" : "text");
    return rangeSchema(domain);
  }
  if (value.tag === "shape") {
    const nominal = lowering.nominal([...value.fields.keys()]);
    return {
      kind: "named",
      name: nominal.name,
      arguments: nominal.fields.map((field) => {
        const member = value.fields.get(field);
        if (member === undefined) {
          throw new Error(`host boundary record omitted field ${field}`);
        }
        return boundaryType(member, span, lowering);
      }),
    };
  }
  if (value.tag === "sealed") {
    const sealed = lowering.seal(value.name);
    return {
      kind: "named",
      name: sealed.name,
      arguments: [boundaryType(value.inner, span, lowering)],
    };
  }
  if (value.tag === "tag") {
    let payload = false;
    if (value.payload !== null) payload = true;
    const sum = lowering.sum([{ name: value.name, payload }]);
    const arguments_: TypeSchema[] = [];
    if (value.payload !== null) {
      arguments_.push(boundaryType(value.payload, span, lowering));
    }
    return { kind: "named", name: sum.name, arguments: arguments_ };
  }
  if (value.tag === "union") {
    const cases: { readonly name: string; readonly payload: Value | null }[] =
      [];
    for (const member of value.members) {
      if (member.tag !== "tag") {
        return valueExportSchema(value, "host operation", span, lowering);
      }
      cases.push({
        name: member.name,
        payload: member.payload,
      });
    }
    const names = cases.map((case_) => case_.name);
    if (
      names.length > 0 &&
      names.every((name) => name === "True" || name === "False")
    ) return { kind: "boolean" };
    const sum = lowering.sum(cases.map((case_) => ({
      name: case_.name,
      payload: case_.payload !== null,
    })));
    return {
      kind: "named",
      name: sum.name,
      arguments: sum.cases.flatMap((case_) => {
        const matching = cases.find((candidate) =>
          candidate.name === case_.name
        );
        if (matching === undefined) {
          throw new Error(`host boundary variant omitted case ${case_.name}`);
        }
        if (matching.payload === null) return [];
        return [boundaryType(matching.payload, span, lowering)];
      }),
    };
  }
  return valueExportSchema(value, "host operation", span, lowering);
}

/**
 * A block, as nested Core forms.
 *
 * Each declaration contributes a wrapper around everything after it, because a
 * destructuring binding is a `case` and not a `let` — Core has no pattern
 * binder, so `let { .x; } = p` becomes the match it always meant.
 */
function lowerBlock(
  declarations: Module["declarations"],
  result: Expr,
  resultEffects: "pure" | "ambient",
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const inner = childScope(scope);
  const wrappers: ((body: SurfaceExpression) => SurfaceExpression)[] = [];
  const groups = recursiveGroups(declarations);
  const computation = scheduleComputation(
    declarations,
    result,
    resultEffects,
  );

  for (const step of computation.steps) {
    const declaration = step.declaration;
    // `open` emits nothing — a use of a name it brought in specializes to the
    // compile-time value, exactly as a `const` does — but the names still have
    // to be *in* this scope. An imported module is inlined into the importer's
    // scope, so its own `open` has to install them here rather than relying on
    // whatever the importer happened to open.
    if (declaration.tag === "open") {
      const opened = lowering.facts.opens.get(declaration.value);
      if (opened === undefined) {
        return unsupported(
          "an `open` the checker did not record",
          declaration.span,
        );
      }
      for (const [name, value] of opened) inner.values.names.set(name, value);
      continue;
    }
    if (declaration.tag === "shadow") {
      const known = lowering.facts.comptimeValues.get(declaration.value);
      if (known !== undefined) inner.values.names.set(declaration.name, known);
      // A binding whose value has no runtime representation emits nothing, the
      // same rule that makes `const Message = #Ready | …` disappear. Shadowing
      // an effect or a type is rebinding a compile-time name, not code.
      if (compileTimeOnly(known)) continue;
      const value = lower(declaration.value, inner, lowering);
      const name = lowering.fresh(declaration.name);
      const pattern = resolvePattern(inner, declaration.name);
      inner.names.set(declaration.name, name);
      if (pattern !== null) inner.patterns.set(declaration.name, pattern);
      wrappers.push((body) => surface.let(name, value, body));
      continue;
    }

    // Remembered before the compile-time skip below: a handler bound to a
    // `const` is still written in this module, and `@handle` needs its clauses.
    if (
      (declaration.value.tag === "shape" ||
        declaration.value.tag === "lambda") &&
      declaration.pattern.tag === "name"
    ) {
      inner.literals.set(declaration.pattern.name, declaration.value);
    }
    let specializedAggregate = false;
    if (step.tag !== "bind" && declaration.pattern.tag === "name") {
      const members = specializableRuntimeLambdaAggregate(
        declaration.value,
        inner,
      );
      if (members !== null) {
        inner.runtimeLambdaMembers.set(declaration.pattern.name, members);
        specializedAggregate = members.complete;
      }
    }
    if (specializedAggregate) continue;

    // A recursive group becomes a *local* `let-rec` binding all its members at
    // once. Lifting it to top-level definitions would strand whatever the
    // lambdas captured.
    //
    // A group whose members are all compile-time values is specialized instead,
    // through the `const` branch below: each use hoists the closure it names,
    // and the hoisted definitions reach each other through the environment the
    // checker evaluated them in. Deciding for the whole group is what keeps the
    // two routes from splitting one knot in half.
    const group = groups.get(declaration);
    if (group !== undefined && !specialized(group, lowering)) {
      if (group[0].declaration === declaration) {
        wrappers.push(recursiveGroup(group, inner, lowering));
      }
      continue;
    }

    // A `const` the checker evaluated is compile time and emits nothing: a use
    // specializes it, so one holding a type disappears and one holding a
    // closure becomes a definition only if something calls it.
    //
    // A `const` inside a function body is a different animal. `const rest =
    // resume ();` depends on the parameter, so there is no compile-time value
    // to specialize and it has to become an ordinary binding.
    if (declaration.kind === "const" && declaration.pattern.tag === "name") {
      const known = lowering.facts.comptimeValues.get(declaration.value);
      if (known !== undefined) {
        inner.values.names.set(declaration.pattern.name, known);
        continue;
      }
    }
    if (declaration.kind === "sig") continue;

    if (step.tag !== "bind" && declaration.pattern.tag === "name") {
      const choice = runtimeLambdaChoice(declaration.value, inner);
      if (choice !== null) {
        const selector = lowering.fresh(`${declaration.pattern.name}$choice`);
        inner.runtimeLambdaChoices.set(declaration.pattern.name, {
          selector,
          consequent: {
            expression: choice.consequent.expression,
            environment: snapshotScope(choice.consequent.environment),
          },
          alternate: {
            expression: choice.alternate.expression,
            environment: snapshotScope(choice.alternate.environment),
          },
        });
        wrappers.push((body) =>
          surface.let(selector, lower(choice.condition, inner, lowering), body)
        );
        continue;
      }
      const aliased = specializableLambda(declaration.value, inner);
      if (
        aliased !== null && declaration.value.tag !== "lambda" &&
        !capturesRuntimeBinding(aliased.expression, aliased.environment)
      ) {
        inner.runtimeLambdas.set(declaration.pattern.name, {
          expression: aliased.expression,
          environment: snapshotScope(aliased.environment),
        });
        continue;
      }
    }

    if (
      step.tag !== "bind" &&
      declaration.value.tag === "lambda" &&
      declaration.pattern.tag === "name" &&
      !capturesRuntimeBinding(declaration.value, inner)
    ) {
      inner.runtimeLambdas.set(
        declaration.pattern.name,
        {
          expression: declaration.value,
          environment: snapshotScope(inner),
        },
      );
      continue;
    }

    if (
      (declaration.value.tag === "shape" ||
        declaration.value.tag === "lambda") &&
      declaration.pattern.tag === "name"
    ) {
      inner.literals.set(declaration.pattern.name, declaration.value);
    }
    let value = lower(declaration.value, inner, lowering);
    const effectType = lowering.facts.expressionTypes.get(declaration.value);
    if (step.tag === "bind" && isNullaryEffectValue(effectType)) {
      value = surface.apply(value, surface.name(UNIT_CONSTRUCTOR_NAME));
    }
    // A lifted lambda is already a definition, so the binding is a name for
    // one rather than a local holding a function.
    const definition = lowering.lifted.get(declaration.value);
    if (
      step.tag !== "bind" && definition !== undefined &&
      declaration.pattern.tag === "name"
    ) {
      bindName(declaration.pattern, definition, inner);
      continue;
    }
    wrappers.push(bind(declaration.pattern, value, inner, lowering));
  }

  let body = lower(
    scheduledResultExpression(computation.result),
    inner,
    lowering,
  );
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    body = wrappers[index](body);
  }
  return body;
}

function isNullaryEffectValue(
  type: SimpleType | undefined,
  seen = new Set<number>(),
): boolean {
  if (type === undefined) return false;
  if (type.tag === "forall") return isNullaryEffectValue(type.body, seen);
  if (type.tag === "fun") return type.param.tag === "unit";
  if (type.tag !== "var" || seen.has(type.id)) return false;
  seen.add(type.id);
  return [...type.lower, ...type.upper].some((bound) =>
    isNullaryEffectValue(bound, seen)
  );
}

/**
 * Binds a pattern, returning a wrapper around whatever follows it. A compound
 * pattern is a `case` with one arm: Core has no destructuring binder, and the
 * match is what the pattern always described.
 */
function bind(
  pattern: Pattern,
  value: SurfaceExpression,
  scope: Scope,
  lowering: Lowering,
): (body: SurfaceExpression) => SurfaceExpression {
  const at = surface.at({
    startByte: pattern.span.start,
    endByte: pattern.span.end,
  });

  if (pattern.tag === "name") {
    const name = lowering.fresh(pattern.name);
    bindName(pattern, name, scope);
    return (body) => surface.let(name, value, body);
  }

  if (pattern.tag === "wildcard" || pattern.tag === "unit") {
    return (body) => surface.let(lowering.fresh("_"), value, body);
  }

  if (pattern.tag === "pin") {
    return (body) =>
      at.if(
        pinnedCondition(pattern, value, scope, lowering),
        body,
        at.runtimeFault(`pinned \`${pattern.name}\` did not match`),
      );
  }

  if (pattern.tag === "array") {
    const store = lowering.fresh("store");
    const wrappers = pattern.elements.map((element, index) =>
      bind(
        element,
        at.storeRead(at.name(store), at.integer(index)),
        scope,
        lowering,
      )
    );
    return (body) => {
      let inner = body;
      for (let index = wrappers.length - 1; index >= 0; index -= 1) {
        inner = wrappers[index](inner);
      }
      return surface.let(
        store,
        value,
        at.if(
          at.binary(
            BinaryOperator.Equal,
            at.storeLength(at.name(store)),
            at.integer(pattern.elements.length),
          ),
          inner,
          at.runtimeFault(
            `array pattern expected ${pattern.elements.length} elements`,
          ),
        ),
      );
    };
  }

  if (pattern.tag === "tuple" || pattern.tag === "shape") {
    // The *value's* field set, not the pattern's: width subtyping means
    // `let { .x; } = point` names fewer than arrive, and Core records are
    // nominal.
    const nominal = lowering.nominal(
      destructuredFields(pattern, scope, lowering),
    );
    const parts = pattern.tag === "tuple"
      ? pattern.elements.map((element, index) => ({
        name: String(index),
        element,
      }))
      : pattern.fields.map((field) => ({
        name: field.name,
        element: field.pattern,
      }));

    const nested: ((body: SurfaceExpression) => SurfaceExpression)[] = [];
    const binders = nominal.fields.map((name) => {
      const part = parts.find((entry) => entry.name === name);
      if (part === undefined) return lowering.fresh("_");
      if (part.element.tag === "wildcard") return lowering.fresh("_");
      const bound = lowering.fresh("part");
      if (part.element.tag === "name") {
        bindName(part.element, bound, scope);
      } else {
        nested.push(
          bind(part.element, at.name(bound), scope, lowering),
        );
      }
      return bound;
    });

    return (body) => {
      let inner = body;
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        inner = nested[index](inner);
      }
      return at.case(value, [{
        constructor: nominal.name,
        binders,
        body: inner,
      }]);
    };
  }

  if (pattern.tag === "constructor") {
    const sum = lowering.sumFor(
      pattern.name,
      pattern.payload !== null,
      pattern.span,
    );
    if (pattern.payload === null) {
      return (body) =>
        at.case(value, [{
          constructor: constructorName(sum, pattern.name),
          binders: [],
          body,
        }], { body: at.runtimeFault("constructor pattern did not match") });
    }
    const payload = lowering.fresh("payload");
    const nested = bind(
      pattern.payload,
      at.name(payload),
      scope,
      lowering,
    );
    return (body) =>
      at.case(value, [{
        constructor: constructorName(sum, pattern.name),
        binders: [payload],
        body: nested(body),
      }], { body: at.runtimeFault("constructor pattern did not match") });
  }

  if (
    pattern.tag === "int" || pattern.tag === "text" || pattern.tag === "float"
  ) {
    let literal: SurfaceExpression;
    let operator: BinaryOperator = BinaryOperator.Equal;
    if (pattern.tag === "int") {
      literal = at.signedInteger64(pattern.value);
      operator = BinaryOperator.EqualSignedInteger64;
    } else if (pattern.tag === "float") {
      literal = at.float64(pattern.value);
      operator = BinaryOperator.EqualFloat64;
    } else {
      literal = at.text(pattern.value);
    }
    return (body) =>
      at.if(
        at.binary(operator, value, literal),
        body,
        at.runtimeFault("literal pattern did not match"),
      );
  }

  pattern satisfies never;
  throw new Error("unhandled pattern in lowering");
}

function pinnedCondition(
  pattern: Pattern & { tag: "pin" },
  value: SurfaceExpression,
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const domain = lowering.facts.pinnedPatterns.get(pattern);
  if (domain === undefined) {
    throw new Error(
      `inference omitted the domain of pinned \`${pattern.name}\` at ${pattern.span.start}`,
    );
  }
  const at = surface.at({
    startByte: pattern.span.start,
    endByte: pattern.span.end,
  });
  const pinned = lower(
    { tag: "var", name: pattern.name, span: pattern.span },
    scope,
    lowering,
  );
  let operator: BinaryOperator = BinaryOperator.StructuralEqual;
  if (domain === "int") operator = BinaryOperator.EqualSignedInteger64;
  return at.binary(operator, value, pinned);
}

/**
 * The field set of the value a tuple or shape pattern takes apart.
 *
 * A tuple pattern is its own answer: it names every position, and a tuple of a
 * different arity is a different type rather than a wider one. A shape pattern
 * is not, because width subtyping means fewer fields are named than arrive, so
 * inference records what the value carries. Where it recorded nothing — a
 * pattern no declaration bound, whose value type it could not pin down — the
 * pattern's own fields are all there is to go on.
 */
function destructuredFields(
  pattern: Extract<Pattern, { tag: "tuple" | "shape" }>,
  scope: Scope,
  lowering: Lowering,
): readonly string[] {
  if (pattern.tag === "tuple") {
    return pattern.elements.map((_, index) => String(index));
  }
  const specialized = scope.parameterShapes.get(pattern);
  if (specialized !== undefined) return specialized;
  const shape = lowering.facts.patternShapes.get(pattern);
  if (shape === undefined) return pattern.fields.map((field) => field.name);
  if (shape.tag === "disagreement") refuseDisagreement(shape, pattern.span);
  return shape.fields;
}

/**
 * Does this group have a compile-time value for every member?
 *
 * Asked of the whole group rather than of each member: a group half specialized
 * and half emitted would leave the emitted half calling names that never became
 * locals.
 */
function specialized(
  members: readonly RecursiveMember[],
  lowering: Lowering,
): boolean {
  return members.every((member) =>
    member.declaration.kind === "const" &&
    lowering.facts.comptimeValues.get(member.declaration.value) !== undefined
  );
}

/**
 * A run of `rec` bindings, as one local recursive group.
 *
 * Core has `let-rec`, which is what this needs: the lambdas may capture names
 * from the block they are written in, and only a local binding keeps those in
 * scope. Lifting them to top-level definitions stranded those — `fold`'s inner
 * `go` closes over `values`, and a definition has no enclosing scope for that
 * to come from. Every member's name goes into scope before any body is lowered,
 * which is the whole of what makes the members visible to each other. The
 * surface builder has no helper for this node, so it is a literal.
 */
function recursiveGroup(
  members: readonly RecursiveMember[],
  scope: Scope,
  lowering: Lowering,
): (body: SurfaceExpression) => SurfaceExpression {
  const names = members.map((member) => {
    const binding = lowering.fresh(member.name);
    bindName(member.pattern, binding, scope);
    return binding;
  });
  const bindings = members.map((member, index) => {
    const inner = childScope(scope);
    const parameter = lowering.fresh("arg");
    const wrap = bindParameter(
      member.lambda.parameter,
      parameter,
      inner,
      lowering,
    );
    return {
      name: names[index],
      parameters: [parameter],
      body: wrap(member.lambda.body),
      span: {
        startByte: member.lambda.span.start,
        endByte: member.lambda.span.end,
      },
    };
  });
  const first = members[0].lambda.span;
  const last = members[members.length - 1].lambda.span;
  const span = { startByte: first.start, endByte: last.end };
  return (body) => ({ kind: "let-rec-group", bindings, body, span });
}

function lower(
  expr: Expr,
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const at = surface.at({ startByte: expr.span.start, endByte: expr.span.end });

  switch (expr.tag) {
    case "int":
      return at.signedInteger64(expr.value);

    case "float":
      return at.float64(expr.value);

    case "text":
      return at.text(expr.value);

    case "unit":
      return at.name(UNIT_CONSTRUCTOR_NAME);

    // `#True` and `#False` are ordinary prelude constructors, and gpufuck's
    // conditions are booleans. Mapping the two is what lets `if` lower at all.
    case "tag": {
      if (expr.name === "True") return at.boolean(true);
      if (expr.name === "False") return at.boolean(false);
      const sum = lowering.sumFor(expr.name, false, expr.span);
      return at.name(constructorName(sum, expr.name));
    }

    case "var": {
      const name = resolve(scope, expr.name);
      if (name !== null) return at.name(name);
      const runtimeLambda = resolveRuntimeLambda(scope, expr.name);
      if (runtimeLambda !== null) {
        return lower(
          runtimeLambda.expression,
          runtimeLambda.environment,
          lowering,
        );
      }
      if (resolveRuntimeLambdaMembers(scope, expr.name) !== null) {
        return unsupported(
          `the function aggregate \`${expr.name}\` escaping a specialized member call`,
          expr.span,
        );
      }
      // Not a local, so it is a compile-time binding: specialize it.
      const value = lookupValue(scope.values, expr.name);
      if (value === undefined) {
        // Inside a hoisted compile-time closure there is no enclosing frame,
        // and the checker has already proved this name is bound. So it is a
        // `let` — a binding with no value until the program runs — and the
        // `const` that reached for it was never computable at compile time.
        if (scope.hoisting !== undefined) {
          fail(
            "BLOT_CONST_CAPTURES_RUNTIME",
            `\`${expr.name}\` is bound by \`let\`, so it has no value at compile time and the compile-time closure \`${scope.hoisting}\` cannot capture it. Write \`let ${scope.hoisting} = …\`, or bind \`${expr.name}\` with \`const\`.`,
            expr.span,
          );
        }
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return lowerValue(value, expr.name, expr.span, lowering);
    }

    case "lambda": {
      const inner = childScope(scope);
      inner.capture = { escaped: false };
      const parameter = lowering.fresh("arg");
      const body = bindParameter(
        expr.parameter,
        parameter,
        inner,
        lowering,
      );
      const lowered = body(expr.body);
      // A lambda that captured nothing is a function, and saying so is worth
      // more than it looks. gpufuck decides whether a four-lane vector can stay
      // in a register per *definition parameter*, so the same arithmetic behind
      // a local lambda boxes every operand where behind a definition it does
      // not — five splats, nine extracts and fifteen lane replacements against
      // one, one and three. A closure still has to be a closure: hoisting one
      // would mean carrying its environment, which is a different change.
      if (!inner.capture.escaped) {
        const name = lowering.fresh("fn");
        lowering.definitions.push({
          name,
          parameters: [parameter],
          annotation: null,
          body: lowered,
        });
        lowering.lifted.set(expr, name);
        return at.name(name);
      }
      return at.lambda([parameter], lowered);
    }

    case "apply":
      return lowerApply(expr, scope, lowering, at);

    case "tuple": {
      const nominal = lowering.nominal(
        expr.elements.map((_, index) => String(index)),
      );
      return at.apply(
        at.name(nominal.name),
        ...expr.elements.map((element) => lower(element, scope, lowering)),
      );
    }

    case "shape": {
      let fields: string[] = [];
      let built: SurfaceExpression = at.name(lowering.nominal([]).name);

      for (const member of expr.members) {
        if (member.tag === "field") {
          const previous = lowering.nominal(fields);
          const previousName = lowering.fresh("shape");
          const previousBinders = previous.fields.map((name) =>
            lowering.fresh(name)
          );
          const memberName = lowering.fresh(member.name);
          const nextFields = [...fields];
          if (!nextFields.includes(member.name)) nextFields.push(member.name);
          const next = lowering.nominal(nextFields);

          built = surface.let(
            previousName,
            built,
            surface.let(
              memberName,
              lower(member.value, scope, lowering),
              at.case(at.name(previousName), [{
                constructor: previous.name,
                binders: previousBinders,
                body: at.apply(
                  at.name(next.name),
                  ...next.fields.map((name) => {
                    if (name === member.name) return at.name(memberName);
                    const index = previous.fields.indexOf(name);
                    return at.name(previousBinders[index]);
                  }),
                ),
              }]),
            ),
          );
          fields = nextFields;
          continue;
        }

        const spreadShape = lowering.facts.shapes.get(member.value);
        if (spreadShape === undefined) {
          return unsupported(
            "spreading a shape inference could not pin down",
            expr.span,
          );
        }
        if (spreadShape.tag === "disagreement") {
          refuseDisagreement(spreadShape, member.value.span);
        }
        const carried = spreadShape.fields;

        const previous = lowering.nominal(fields);
        const previousName = lowering.fresh("shape");
        const previousBinders = previous.fields.map((name) =>
          lowering.fresh(name)
        );
        const spread = lowering.nominal(carried);
        const spreadName = lowering.fresh("spread");
        const spreadBinders = spread.fields.map((name) => lowering.fresh(name));
        const nextFields = [...fields];
        for (const name of carried) {
          if (!nextFields.includes(name)) nextFields.push(name);
        }
        const next = lowering.nominal(nextFields);

        built = surface.let(
          previousName,
          built,
          surface.let(
            spreadName,
            lower(member.value, scope, lowering),
            at.case(at.name(previousName), [{
              constructor: previous.name,
              binders: previousBinders,
              body: at.case(at.name(spreadName), [{
                constructor: spread.name,
                binders: spreadBinders,
                body: at.apply(
                  at.name(next.name),
                  ...next.fields.map((name) => {
                    const spreadIndex = spread.fields.indexOf(name);
                    if (spreadIndex >= 0) {
                      return at.name(spreadBinders[spreadIndex]);
                    }
                    const previousIndex = previous.fields.indexOf(name);
                    return at.name(previousBinders[previousIndex]);
                  }),
                ),
              }]),
            }]),
          ),
        );
        fields = nextFields;
      }

      return built;
    }

    case "field": {
      // A field of the module parameter is a granted capability: an import,
      // declared from the signature inference found for it.
      if (
        expr.target.tag === "var" && expr.target.name === grantedName(scope)
      ) {
        const signature = lowering.facts.grants.get(expr);
        if (signature === undefined) {
          return unsupported(
            `the granted capability \`${expr.name}\`, whose signature inference could not pin down`,
            expr.span,
          );
        }
        return at.name(
          grantOperation(expr.name, signature, lowering, expr.span),
        );
      }
      // An operation on an effect is evidence, not a projection. A host
      // effect's is an import the host answers; a blot effect's is a definition
      // a handler can replace lexically.
      const performed = comptimeEffect(expr, scope);
      if (performed !== null) {
        return at.name(
          performed.host
            ? hostOperation(performed, expr.name, lowering, expr.span)
            : effectOperation(performed, expr.name, lowering, expr.span),
        );
      }
      // Projecting from a compile-time shape is folded rather than compiled:
      // `Num.add` should become a call to one definition, not a record built at
      // run time and immediately taken apart.
      const constant = comptimeShapeMember(expr, scope);
      if (constant !== null) {
        return lowerValue(constant, expr.name, expr.span, lowering);
      }
      const target = lower(expr.target, scope, lowering);
      // The whole field set comes from inference. A projection alone does not
      // say what else the record holds, and the nominal needs all of it.
      let specializedShape: readonly string[] | null = null;
      if (expr.target.tag === "var") {
        specializedShape = resolveRecordShape(scope, expr.target.name);
      }
      let shape = lowering.facts.shapes.get(expr);
      if (specializedShape !== null) {
        shape = { tag: "fields", fields: specializedShape };
      }
      if (shape === undefined) {
        return unsupported(
          `projecting \`.${expr.name}\` from a value whose shape inference could not pin down`,
          expr.span,
        );
      }
      if (shape.tag === "disagreement") refuseDisagreement(shape, expr.span);
      const nominal = lowering.nominal(shape.fields);
      // The nominal's own order, not this site's. Inference records a field set
      // in the order the program first projected it, so two sites can disagree
      // about the order of the same type — the nominal is the one that
      // decides, and construction already goes through it.
      const binders = nominal.fields.map((name) => lowering.fresh(name));
      const index = nominal.fields.indexOf(expr.name);
      if (index < 0) {
        fail("BLOT_NO_FIELD", `No field \`.${expr.name}\`.`, expr.span);
      }
      return at.case(target, [{
        constructor: nominal.name,
        binders,
        body: at.name(binders[index]),
      }]);
    }

    // An array is Core's `Store`: allocate at the first element's value, then
    // write the rest. There is no literal form, and `storeNew` needs something
    // to fill with, which is why an empty literal has no lowering — the element
    // type is not determined by anything.
    case "array": {
      if (expr.elements.length === 0) return at.storeEmpty();
      if (expr.elements.some((element) => element.spread)) {
        return lowerSpreadArray(expr, scope, lowering, at);
      }
      // A `Store` write returns a *new* store, so each element threads through
      // its own binding: allocate at the first element, then write the rest,
      // each read from the store the previous write produced.
      const steps: { name: string; value: SurfaceExpression }[] = [];
      const first = lowering.fresh("store");
      steps.push({
        name: first,
        value: at.storeNew(
          at.integer(expr.elements.length),
          lower(expr.elements[0].value, scope, lowering),
        ),
      });
      for (let index = 1; index < expr.elements.length; index += 1) {
        const previous = steps[steps.length - 1].name;
        steps.push({
          name: lowering.fresh("store"),
          value: at.storeWrite(
            at.name(previous),
            at.integer(index),
            lower(expr.elements[index].value, scope, lowering),
          ),
        });
      }
      let body: SurfaceExpression = at.name(steps[steps.length - 1].name);
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        body = surface.let(steps[index].name, steps[index].value, body);
      }
      return body;
    }

    case "if": {
      let result = expr.fallback === null
        ? at.unreachable("no branch matched")
        : lower(expr.fallback, scope, lowering);
      for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
        const branch = expr.branches[index];
        const conditionSpine = flatten(branch.condition);
        let branchPrimitive = conditionSpine.callee.tag === "intrinsic"
          ? conditionSpine.callee.name
          : undefined;
        if (conditionSpine.callee.tag === "var") {
          const value = lookupValue(scope.values, conditionSpine.callee.name);
          const expanded = value === undefined
            ? null
            : etaExpandedPrimitive(value, conditionSpine.args);
          branchPrimitive = expanded?.primitive;
        }
        const likelihood = conditionSpine.args.length === 1 &&
            (branchPrimitive === "@branch.likely" ||
              branchPrimitive === "@branch.unlikely")
          ? branchPrimitive === "@branch.likely"
            ? "consequent" as const
            : "alternate" as const
          : undefined;
        const condition = likelihood === undefined
          ? branch.condition
          : conditionSpine.args[0];
        result = at.if(
          lower(condition, scope, lowering),
          lower(branch.consequence, scope, lowering),
          result,
          likelihood === undefined ? undefined : { likely: likelihood },
        );
      }
      return result;
    }

    case "intrinsic": {
      if (expr.name === "@shape.empty") {
        return at.name(lowering.nominal([]).name);
      }
      // `storeEmpty` allocates a zero-length `Store a` and lets the
      // surrounding constraints infer `a`, which is exactly what an empty array
      // needs: there is no element to offer, and it should not have to invent
      // one. blot used to record the element type during checking and write a
      // typed placeholder — that worked only where the element was already
      // pinned, so `map` and `filter` did not compile.
      if (expr.name === "@array.empty") return at.storeEmpty();
      return unsupported(
        `the primitive \`${expr.name}\` as a value`,
        expr.span,
      );
    }

    case "case":
      return lowerCase(expr, scope, lowering, at);

    case "block":
      return lowerBlock(
        expr.declarations,
        expr.result,
        expr.resultEffects,
        scope,
        lowering,
      );

    case "comptime":
      return lower(expr.body, scope, lowering);

    case "rec":
      return unsupported("`rec` outside a named binding", expr.span);
  }
  // Every expression kind is handled above; this is the compiler's own
  // exhaustiveness check rather than a fallback.
  expr satisfies never;
  throw new Error("unhandled expression in lowering");
}

/**
 * An array literal with a spread.
 *
 * Lengths are not known until it runs, so it is built rather than allocated:
 * start empty, push each written element, and copy each spread with a local
 * recursive loop. `let-rec` is what makes the loop expressible — Core has no
 * other one, which is the same reason `rec` is a local binding.
 */
function lowerSpreadArray(
  expr: Expr & { tag: "array" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  // Each step names the store it produced, because a `Store` write returns a
  // new one rather than mutating.
  const steps: { name: string; value: SurfaceExpression }[] = [];
  const start = lowering.fresh("store");
  steps.push({ name: start, value: at.storeEmpty() });

  const push = (
    into: string,
    value: SurfaceExpression,
  ): string => {
    const next = lowering.fresh("store");
    steps.push({
      name: next,
      value: at.storeGrow(
        at.name(into),
        at.binary(
          BinaryOperator.Add,
          at.storeLength(at.name(into)),
          at.integer(1),
        ),
        value,
      ),
    });
    return next;
  };

  let current = start;
  for (const element of expr.elements) {
    const value = lower(element.value, scope, lowering);
    if (!element.spread) {
      current = push(current, value);
      continue;
    }
    current = appendAll(current, value, lowering, at, steps);
  }

  let body: SurfaceExpression = at.name(current);
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    body = surface.let(steps[index].name, steps[index].value, body);
  }
  return body;
}

/**
 * Copies every element of `source` onto `into`, as a local recursive loop.
 *
 * The loop carries an index and an accumulator, so it takes the pair as one
 * argument — Core application is unary, and a tuple is the shape blot already
 * uses for that.
 */
function appendAll(
  into: string,
  source: SurfaceExpression,
  lowering: Lowering,
  at: typeof surface,
  steps: { name: string; value: SurfaceExpression }[],
): string {
  const from = lowering.fresh("source");
  steps.push({ name: from, value: source });

  const pair = lowering.nominal(["0", "1"]);
  const loop = lowering.fresh("append");
  const argument = lowering.fresh("state");
  const index = lowering.fresh("index");
  const accumulator = lowering.fresh("acc");

  const grown = at.storeGrow(
    at.name(accumulator),
    at.binary(
      BinaryOperator.Add,
      at.storeLength(at.name(accumulator)),
      at.integer(1),
    ),
    at.storeRead(at.name(from), at.name(index)),
  );
  const step = at.apply(
    at.name(loop),
    at.apply(
      at.name(pair.name),
      at.binary(BinaryOperator.Add, at.name(index), at.integer(1)),
      grown,
    ),
  );
  const body = at.case(at.name(argument), [{
    constructor: pair.name,
    binders: [index, accumulator],
    body: at.if(
      at.binary(
        BinaryOperator.Less,
        at.name(index),
        at.storeLength(at.name(from)),
      ),
      step,
      at.name(accumulator),
    ),
  }]);

  const result = lowering.fresh("store");
  steps.push({
    name: result,
    value: {
      kind: "let-rec-group",
      bindings: [{ name: loop, parameters: [argument], body }],
      body: at.apply(
        at.name(loop),
        at.apply(at.name(pair.name), at.integer(0), at.name(into)),
      ),
    },
  });
  return result;
}

function lowerCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  if (controlCase(expr)) return lowerControlCase(expr, scope, lowering, at);
  if (lowering.facts.optionalCases.has(expr)) {
    return lowerOptionalCase(expr, scope, lowering, at);
  }
  // A tuple scrutinee pins no variant — the tuple is the dispatch, and its
  // elements are what the arms discriminate on — so the arms decide this
  // before anything asks inference for a constructor set.
  if (expr.arms.some((arm) => arm.pattern.tag === "tuple")) {
    return lowerTupleCase(expr, scope, lowering, at);
  }
  // The constructor set inference pinned, or — when a wildcard arm left it
  // open — the union the named arms belong to. Recovering it from the arms is
  // what avoids monomorphizing: gpufuck keeps Core polymorphic on measured
  // grounds, and duplicating a definition per instantiation to learn a name
  // blot could have looked up would be the wrong trade.
  const cases = lowering.facts.variants.get(expr) ??
    unionFromArms(expr, lowering);
  if (cases === undefined) {
    // Not a union: matching literals is a chain of equality tests, which is
    // what the arms always described.
    return lowerLiteralCase(expr, scope, lowering, at);
  }

  // `#True | #False` is the prelude's `Bool`, and Core has a boolean. Matching
  // on it is an `if`, not a two-constructor dispatch.
  const sorted = [...cases].map((entry) => entry.name).sort();
  if (sorted.length === 2 && sorted[0] === "False" && sorted[1] === "True") {
    return lowerBooleanCase(expr, scope, lowering, at);
  }

  const sum = lowering.sum(cases);
  const target = lower(expr.target, scope, lowering);
  const arms: {
    constructor: string;
    binders: string[];
    body: SurfaceExpression;
  }[] = [];
  // Literal payloads collected first, because they are guards inside their
  // constructor's arm rather than arms of their own.
  const guarded: { name: string; pattern: Pattern; body: Expr }[] = [];
  for (const arm of expr.arms) {
    if (arm.pattern.tag !== "constructor") continue;
    const payload = arm.pattern.payload;
    if (payload === null) continue;
    if (
      payload.tag !== "int" && payload.tag !== "text" &&
      payload.tag !== "pin"
    ) continue;
    guarded.push({ name: arm.pattern.name, pattern: payload, body: arm.body });
  }
  let fallback: SurfaceExpression | null = null;

  const covered = new Set<string>();
  for (const arm of expr.arms) {
    const inner = childScope(scope);
    if (arm.pattern.tag === "constructor") {
      // A constructor's payload has one type, so a second arm for it can only
      // be reached when the first was refutable — and the refutable ones are
      // the literal payloads, already lifted out as guards. Core takes one arm
      // per constructor, and the first is the one that runs.
      if (covered.has(arm.pattern.name)) continue;
      // A literal payload is a guard, not a binder: `#Progress 0` and
      // `#Progress n` are one Core arm with a test inside, because Core
      // dispatches on the constructor and nothing else.
      const payload = arm.pattern.payload;
      if (
        payload !== null &&
        (payload.tag === "int" || payload.tag === "text" ||
          payload.tag === "pin")
      ) {
        continue;
      }
      const binders: string[] = [];
      // A compound payload binds one name and then destructures it, which is
      // the same `case` a compound binding already becomes.
      let wrap: ((body: SurfaceExpression) => SurfaceExpression) | null = null;
      if (payload !== null) {
        const binder = lowering.fresh("payload");
        binders.push(binder);
        if (payload.tag === "name") {
          bindName(payload, binder, inner);
        } else if (payload.tag !== "wildcard") {
          wrap = bind(payload, at.name(binder), inner, lowering);
        }
      }
      const armBody = lower(arm.body, inner, lowering);
      // Guards for this constructor run before its general arm.
      const constructor = arm.pattern.name;
      const tests = guarded.filter((entry) => entry.name === constructor);
      let body = wrap === null ? armBody : wrap(armBody);
      for (let index = tests.length - 1; index >= 0; index -= 1) {
        const test = tests[index];
        const pattern = test.pattern;
        if (pattern.tag === "pin") {
          body = at.if(
            pinnedCondition(pattern, at.name(binders[0]), inner, lowering),
            lower(test.body, inner, lowering),
            body,
          );
          continue;
        }
        let compared: SurfaceExpression = at.text("");
        let operator: BinaryOperator = BinaryOperator.Equal;
        if (pattern.tag === "int") {
          compared = at.signedInteger64(pattern.value);
          operator = BinaryOperator.EqualSignedInteger64;
        } else if (pattern.tag === "text") {
          compared = at.text(pattern.value);
        }
        body = at.if(
          at.binary(
            operator,
            at.name(binders[0]),
            compared,
          ),
          lower(test.body, inner, lowering),
          body,
        );
      }
      covered.add(constructor);
      arms.push({
        constructor: constructorName(sum, constructor),
        binders,
        body,
      });
      continue;
    }
    if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      if (arm.pattern.tag === "name") {
        const binder = lowering.fresh(arm.pattern.name);
        bindName(arm.pattern, binder, inner);
        // The default binds the scrutinee, which Core spells with its own
        // binder rather than reusing the arm's.
        fallback = surface.let(
          binder,
          target,
          lower(arm.body, inner, lowering),
        );
      } else {
        fallback = lower(arm.body, inner, lowering);
      }
      continue;
    }
    return unsupported(
      `a ${arm.pattern.tag} pattern in \`case\``,
      arm.pattern.span,
    );
  }

  if (fallback === null) return at.case(target, arms);
  return at.case(target, arms, { body: fallback });
}

function lowerOptionalCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const optional = lowering.sum([
    { name: OPTIONAL_ABSENT, payload: false },
    { name: OPTIONAL_PRESENT, payload: true },
  ]);
  const target = lower(expr.target, scope, lowering);

  let absent = at.unreachable("no optional arm matched unit");
  for (const arm of expr.arms) {
    if (
      arm.pattern.tag !== "unit" && arm.pattern.tag !== "wildcard" &&
      arm.pattern.tag !== "name"
    ) continue;
    const inner = childScope(scope);
    if (arm.pattern.tag === "name") {
      const binder = lowering.fresh(arm.pattern.name);
      bindName(arm.pattern, binder, inner);
      absent = surface.let(
        binder,
        at.name(UNIT_CONSTRUCTOR_NAME),
        lower(arm.body, inner, lowering),
      );
    } else {
      absent = lower(arm.body, inner, lowering);
    }
    break;
  }

  const carried = lowering.fresh("optional");
  let present = at.unreachable("no optional arm matched a present value");
  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index];
    if (arm.pattern.tag === "unit") continue;
    const inner = childScope(scope);
    const next = present;
    const matched = matchElement(
      arm.pattern,
      at.name(carried),
      inner,
      lowering,
      () => next,
    );
    present = matched(lower(arm.body, inner, lowering));
  }

  return at.case(target, [
    {
      constructor: constructorName(optional, OPTIONAL_ABSENT),
      binders: [],
      body: absent,
    },
    {
      constructor: constructorName(optional, OPTIONAL_PRESENT),
      binders: [carried],
      body: present,
    },
  ]);
}

function controlCase(expr: Expr & { tag: "case" }): boolean {
  return expr.arms.length > 0 &&
    expr.arms.every((arm) =>
      arm.pattern.tag === "constructor" &&
      syntheticControlName(arm.pattern.name)
    );
}

function syntheticControlName(name: string): boolean {
  return /^(?:Function|Conditional|Loop(?:Body)?)(?:Return|Continue|Break)\$\d+\$\d+$/
    .test(name);
}

function controlPayloadPattern(pattern: Pattern | null): Pattern | null {
  if (pattern?.tag !== "shape" || pattern.fields.length !== 1) return pattern;
  const field = pattern.fields[0];
  return field?.name === "value" ? field.pattern : pattern;
}

function controlPayloadValue(value: Expr): Expr {
  if (value.tag !== "shape" || value.members.length !== 1) return value;
  const member = value.members[0];
  return member?.tag === "field" && member.name === "value"
    ? member.value
    : value;
}

/** Lowers the parser's control outcomes to typed join points instead of nominal sums. */
function lowerControlCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const targetScope = childScope(scope);
  const joins = expr.arms.map((arm) => {
    if (arm.pattern.tag !== "constructor") {
      throw new Error("control case contains a non-constructor arm");
    }
    const name = lowering.fresh("exit");
    targetScope.exits.set(arm.pattern.name, name);
    return { arm, name, parameter: lowering.fresh("exit-value") };
  });

  let body = lower(expr.target, targetScope, lowering);
  for (let index = joins.length - 1; index >= 0; index -= 1) {
    const join = joins[index];
    if (join === undefined) {
      throw new Error(`control case omitted join ${index}`);
    }
    if (join.arm.pattern.tag !== "constructor") {
      throw new Error(`control case join ${index} has a non-constructor arm`);
    }
    const inner = childScope(scope);
    const payload = controlPayloadPattern(join.arm.pattern.payload);
    let wrap = (value: SurfaceExpression): SurfaceExpression => value;
    if (payload !== null) {
      wrap = bind(
        payload,
        at.name(join.parameter),
        inner,
        lowering,
      );
    }
    const continuation = wrap(lower(join.arm.body, inner, lowering));
    body = at.join(join.name, join.parameter, body, continuation);
  }
  return body;
}

/**
 * The union a `case`'s arms belong to, when inference could not pin it.
 *
 * A wildcard arm leaves the scrutinee's constructor set open, which is common
 * inside a polymorphic function — `case o of #Less => …, _ => …` says nothing
 * about `#Equal`. But the named arms do belong to a union, and the module has
 * only so many; the same membership lookup that resolves a construction
 * resolves this.
 */
function unionFromArms(
  expr: Expr & { tag: "case" },
  lowering: Lowering,
): readonly VariantCase[] | undefined {
  const named = expr.arms
    .map((arm) => arm.pattern)
    .filter((pattern) => pattern.tag === "constructor");
  if (named.length === 0) return undefined;
  const first = named[0];
  if (first.tag !== "constructor") return undefined;
  return lowering.sumFor(first.name, first.payload !== null, first.span).cases;
}

/**
 * The binders a tuple of a given width comes apart into.
 *
 * A nominal's field order is the order the module first met that shape, and
 * that need not be positional: `pair.1` before `pair.0` records `["1", "0"]`
 * for the same type. Reading a column back by name rather than by its place in
 * the binder list is what keeps a pattern from matching the wrong element.
 */
function tupleColumns(width: number, lowering: Lowering): {
  readonly nominal: Nominal;
  readonly binders: readonly string[];
  readonly column: (index: number) => string;
} {
  const nominal = lowering.nominal(
    Array.from({ length: width }, (_, index) => String(index)),
  );
  const binders = nominal.fields.map((field) =>
    lowering.fresh(`element${field}`)
  );
  return {
    nominal,
    binders,
    column: (index) => {
      const position = nominal.fields.indexOf(String(index));
      const binder = binders[position];
      if (binder === undefined) {
        throw new Error(`${nominal.name} has no field ${index}`);
      }
      return binder;
    },
  };
}

/**
 * `case` over a tuple, which is a pattern matrix one column per element.
 *
 * The scrutinee is bound and taken apart once, and the arms are then tried in
 * source order: each tests its sub-patterns left to right and falls to the next
 * arm as soon as one of them fails. The fall-through is a join point rather
 * than a copy of the arms that follow, because a copy per test is exponential
 * in the width — four arms of four elements would emit the last one's body two
 * hundred and fifty-six times.
 */
function lowerTupleCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  let width: number | null = null;
  for (const arm of expr.arms) {
    if (arm.pattern.tag !== "tuple") continue;
    // Two widths would be two scrutinee types. A tuple of a different arity is
    // a different type rather than a wider one, so inference cannot have let
    // this through.
    if (width !== null && width !== arm.pattern.elements.length) {
      throw new Error("a `case` matches tuples of two different widths");
    }
    width = arm.pattern.elements.length;
  }
  if (width === null) throw new Error("a tuple `case` with no tuple arm");

  const target = lower(expr.target, scope, lowering);
  const subject = lowering.fresh("subject");
  const columns = tupleColumns(width, lowering);

  let fallback: SurfaceExpression | null = null;
  const rows: { readonly next: string; readonly body: SurfaceExpression }[] =
    [];
  for (const arm of expr.arms) {
    const inner = childScope(scope);
    if (expr.target.tag === "var") {
      const type = resolveSpecializedType(scope, expr.target.name);
      if (type !== null) specializePatternShapes(arm.pattern, type, inner);
    }
    if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      if (arm.pattern.tag === "name") {
        bindName(arm.pattern, subject, inner);
      }
      // An arm that cannot fail ends the matrix. Every arm after it is
      // unreachable, and emitting one would put a test in front of the arm
      // that was written to catch everything.
      fallback = lower(arm.body, inner, lowering);
      break;
    }
    if (arm.pattern.tag !== "tuple") {
      return unsupported(
        `a ${arm.pattern.tag} pattern over a tuple`,
        arm.pattern.span,
      );
    }
    const next = lowering.fresh("next");
    const fail = () => at.jump(next, at.name(UNIT_CONSTRUCTOR_NAME));
    // The tests come first because they are what binds the arm's names, and
    // the body is lowered in the scope they leave behind.
    const tests = arm.pattern.elements.map((element, index) =>
      matchElement(
        element,
        at.name(columns.column(index)),
        inner,
        lowering,
        fail,
      )
    );
    let body = lower(arm.body, inner, lowering);
    for (let index = tests.length - 1; index >= 0; index -= 1) {
      body = tests[index](body);
    }
    rows.push({ next, body });
  }

  // An arm-less tail is a path the tuple coverage matrix proved cannot be
  // taken. It remains explicit Core so a violated checker invariant traps
  // instead of choosing an arm the source did not contain.
  let matrix = fallback ?? at.unreachable("no arm matched");
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    matrix = at.join(row.next, lowering.fresh("unmatched"), row.body, matrix);
  }
  return surface.let(
    subject,
    target,
    at.case(at.name(subject), [{
      constructor: columns.nominal.name,
      binders: [...columns.binders],
      body: matrix,
    }]),
  );
}

/**
 * One sub-pattern of a tuple arm, against the element the scrutinee was already
 * taken apart into.
 *
 * `bind` is this without a fall-through: a binding has no next arm, so it
 * faults where a pattern does not match, and that difference is the whole of
 * it. The value handed in is always a binder's name, which is why a sub-pattern
 * that tests nothing can drop it instead of keeping an evaluation alive.
 */
function matchElement(
  pattern: Pattern,
  value: SurfaceExpression,
  scope: Scope,
  lowering: Lowering,
  fail: () => SurfaceExpression,
): (body: SurfaceExpression) => SurfaceExpression {
  const at = surface.at({
    startByte: pattern.span.start,
    endByte: pattern.span.end,
  });

  if (pattern.tag === "wildcard" || pattern.tag === "unit") {
    return (body) => body;
  }

  if (pattern.tag === "name") {
    const name = lowering.fresh(pattern.name);
    bindName(pattern, name, scope);
    return (body) => surface.let(name, value, body);
  }

  if (pattern.tag === "pin") {
    return (body) =>
      at.if(
        pinnedCondition(pattern, value, scope, lowering),
        body,
        fail(),
      );
  }

  if (
    pattern.tag === "int" || pattern.tag === "text" || pattern.tag === "float"
  ) {
    let literal: SurfaceExpression;
    let operator: BinaryOperator = BinaryOperator.Equal;
    if (pattern.tag === "int") {
      literal = at.signedInteger64(pattern.value);
      operator = BinaryOperator.EqualSignedInteger64;
    } else if (pattern.tag === "float") {
      literal = at.float64(pattern.value);
      operator = BinaryOperator.EqualFloat64;
    } else {
      literal = at.text(pattern.value);
    }
    return (body) => at.if(at.binary(operator, value, literal), body, fail());
  }

  if (pattern.tag === "constructor") {
    // `#True` and `#False` are Core's own boolean, so the element holds one
    // rather than a tagged value with a constructor to strip.
    if (pattern.payload === null) {
      if (pattern.name === "True") {
        return (body) => at.if(value, body, fail());
      }
      if (pattern.name === "False") {
        return (body) => at.if(value, fail(), body);
      }
    }
    const sum = lowering.sumFor(
      pattern.name,
      pattern.payload !== null,
      pattern.span,
    );
    const constructor = constructorName(sum, pattern.name);
    const payload = pattern.payload;
    if (payload === null) {
      return (body) =>
        at.case(value, [{ constructor, binders: [], body }], {
          body: fail(),
        });
    }
    const binder = lowering.fresh("payload");
    const nested = matchElement(
      payload,
      at.name(binder),
      scope,
      lowering,
      fail,
    );
    return (body) =>
      at.case(value, [{ constructor, binders: [binder], body: nested(body) }], {
        body: fail(),
      });
  }

  if (pattern.tag === "tuple") {
    const columns = tupleColumns(pattern.elements.length, lowering);
    const nested = pattern.elements.map((element, index) =>
      matchElement(
        element,
        at.name(columns.column(index)),
        scope,
        lowering,
        fail,
      )
    );
    return (body) => {
      let inner = body;
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        inner = nested[index](inner);
      }
      return at.case(value, [{
        constructor: columns.nominal.name,
        binders: [...columns.binders],
        body: inner,
      }]);
    };
  }

  if (pattern.tag === "shape") {
    return bind(pattern, value, scope, lowering);
  }

  // An array pattern would need a length test coverage does not account for.
  return unsupported(
    `a ${pattern.tag} pattern inside a tuple pattern`,
    pattern.span,
  );
}

/**
 * `case` over literals, which is a chain of equality tests.
 *
 * A union dispatches on its constructor; an integer or a text has nothing to
 * dispatch on, so the arms become the comparisons they always meant.
 */
function lowerLiteralCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const scrutinee = lowering.fresh("subject");
  let fallback: SurfaceExpression | null = null;
  const tests: { pattern: Pattern; body: SurfaceExpression }[] = [];

  for (const arm of expr.arms) {
    const inner = childScope(scope);
    const pattern = arm.pattern;
    if (
      pattern.tag === "int" || pattern.tag === "text" || pattern.tag === "pin"
    ) {
      tests.push({ pattern, body: lower(arm.body, inner, lowering) });
      continue;
    }
    if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      if (arm.pattern.tag === "name") {
        bindName(arm.pattern, scrutinee, inner);
      }
      fallback = fallback ?? lower(arm.body, inner, lowering);
      continue;
    }
    if (pattern.tag === "constructor") {
      // The arms name constructors, so this *is* a union — inference just could
      // not pin the whole set, which happens when a wildcard arm leaves it open
      // inside a polymorphic function. Monomorphizing per call site is what
      // would close it.
      return unsupported(
        "matching a union whose constructor set a wildcard arm left open",
        arm.pattern.span,
      );
    }
    return unsupported(`a ${pattern.tag} pattern over a literal`, pattern.span);
  }

  // Exhaustiveness is a checked error, so an arm-less tail is a path the
  // checker proved cannot be taken — not a fault the program can hit. `@panic`
  // is how a program opts into a reachable one, and it stays an explicit
  // fault so the two are distinguishable at the boundary.
  let body = fallback ??
    at.unreachable("no arm matched");
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    const test = tests[index];
    const value = test.pattern;
    if (value.tag === "pin") {
      body = at.if(
        pinnedCondition(value, at.name(scrutinee), scope, lowering),
        test.body,
        body,
      );
      continue;
    }
    let literal = at.text("");
    let operator: BinaryOperator = BinaryOperator.Equal;
    if (value.tag === "int") {
      literal = at.signedInteger64(value.value);
      operator = BinaryOperator.EqualSignedInteger64;
    } else if (value.tag === "text") {
      literal = at.text(value.value);
    }
    body = at.if(
      at.binary(operator, at.name(scrutinee), literal),
      test.body,
      body,
    );
  }
  return surface.let(scrutinee, lower(expr.target, scope, lowering), body);
}

/** `case` over `#True | #False`, which Core already has as `if`. */
function lowerBooleanCase(
  expr: Expr & { tag: "case" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const target = lower(expr.target, scope, lowering);
  let whenTrue: SurfaceExpression | null = null;
  let whenFalse: SurfaceExpression | null = null;

  for (const arm of expr.arms) {
    const body = () => lower(arm.body, childScope(scope), lowering);
    if (arm.pattern.tag === "constructor" && arm.pattern.name === "True") {
      whenTrue = whenTrue ?? body();
    } else if (
      arm.pattern.tag === "constructor" && arm.pattern.name === "False"
    ) {
      whenFalse = whenFalse ?? body();
    } else if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      const rest = body();
      whenTrue = whenTrue ?? rest;
      whenFalse = whenFalse ?? rest;
    }
  }

  if (whenTrue === null || whenFalse === null) {
    return unsupported(
      "a `case` over booleans that covers only one of them",
      expr.span,
    );
  }
  return at.if(target, whenTrue, whenFalse);
}

/** `Console.write` when `Console` is an effect: the operation being performed. */
function comptimeEffect(
  expr: Expr & { tag: "field" },
  scope: Scope,
): (Value & { tag: "effect" }) | null {
  if (expr.target.tag !== "var") return null;
  if (resolve(scope, expr.target.name) !== null) return null;
  const value = lookupValue(scope.values, expr.target.name);
  if (value === undefined || value.tag !== "effect") return null;
  return value;
}

/**
 * Folds a chain of projections off a compile-time shape or namespace.
 *
 * `prelude.Num.add` is `.add` off `.Num` off a name, and stopping at the first
 * projection would leave `Num` — a shape of closures — as a value to compile.
 * Following the whole chain reaches the closure that is actually meant.
 */
function comptimeShapeMember(
  expr: Expr & { tag: "field" },
  scope: Scope,
): Value | null {
  const path: string[] = [];
  let current: Expr = expr;
  while (current.tag === "field") {
    path.unshift(current.name);
    current = current.target;
  }
  if (current.tag !== "var") return null;
  if (resolve(scope, current.name) !== null) return null;

  let value = lookupValue(scope.values, current.name);
  for (const name of path) {
    if (value === undefined) return null;
    if (value.tag === "shape") {
      value = value.fields.get(name);
      continue;
    }
    if (value.tag === "extended") {
      value = value.members.get(name);
      continue;
    }
    return null;
  }
  return value ?? null;
}

/**
 * A compile-time value, as Core.
 *
 * A closure becomes a hoisted top-level definition, once per closure, so the
 * prelude is compiled rather than inlined at every use. Its body is lowered in
 * the environment it captured, which is what makes the recursion terminate on
 * closed values instead of chasing the whole prelude.
 */
function lowerValue(
  value: Value,
  hint: string,
  span: Span,
  lowering: Lowering,
): SurfaceExpression {
  const at = surface.at({ startByte: span.start, endByte: span.end });

  switch (value.tag) {
    case "int":
      return at.signedInteger64(value.value);
    case "float":
      return at.float64(value.value);
    case "float32":
      return at.float32(value.value);
    case "vector":
      if (value.element !== "f32") {
        lowering.usesIntegerVectors = true;
        const nominal = lowering.nominal(
          value.lanes.map((_, index) => String(index)),
        );
        return at.apply(
          at.name(nominal.name),
          ...value.lanes.map((lane) => at.signedInteger64(BigInt(lane))),
        );
      }
      lowering.vectors = true;
      return f32x4.make([
        at.float32(value.lanes[0]),
        at.float32(value.lanes[1]),
        at.float32(value.lanes[2]),
        at.float32(value.lanes[3]),
      ]);
    case "vector-mask":
      if (value.element !== "f32") {
        lowering.usesIntegerVectors = true;
        const nominal = lowering.nominal(
          value.lanes.map((_, index) => String(index)),
        );
        return at.apply(
          at.name(nominal.name),
          ...value.lanes.map((lane) => at.boolean(lane)),
        );
      }
      lowering.vectors = true;
      return f32x4.makeMask([
        at.boolean(value.lanes[0]),
        at.boolean(value.lanes[1]),
        at.boolean(value.lanes[2]),
        at.boolean(value.lanes[3]),
      ]);
    case "text":
      return at.text(value.value);
    case "unit":
      return at.name(UNIT_CONSTRUCTOR_NAME);
    case "tag": {
      if (value.name === "True") return at.boolean(true);
      if (value.name === "False") return at.boolean(false);
      const sum = lowering.sumFor(value.name, value.payload !== null, span);
      const constructor = at.name(constructorName(sum, value.name));
      if (value.payload === null) return constructor;
      return at.apply(
        constructor,
        lowerValue(value.payload, hint, span, lowering),
      );
    }
    // Compile-time data crossing into run time. A `const` array or shape is an
    // ordinary value at that point, and building it is the same construction
    // the syntax would have produced.
    case "array": {
      if (value.elements.length === 0) return at.storeEmpty();
      const steps: { name: string; value: SurfaceExpression }[] = [];
      const first = lowering.fresh("store");
      steps.push({
        name: first,
        value: at.storeNew(
          at.integer(value.elements.length),
          lowerValue(value.elements[0], hint, span, lowering),
        ),
      });
      for (let index = 1; index < value.elements.length; index += 1) {
        const previous = steps[steps.length - 1].name;
        steps.push({
          name: lowering.fresh("store"),
          value: at.storeWrite(
            at.name(previous),
            at.integer(index),
            lowerValue(value.elements[index], hint, span, lowering),
          ),
        });
      }
      let built: SurfaceExpression = at.name(steps[steps.length - 1].name);
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        built = surface.let(steps[index].name, steps[index].value, built);
      }
      return built;
    }

    case "shape": {
      const nominal = lowering.nominal([...value.fields.keys()]);
      return at.apply(
        at.name(nominal.name),
        ...nominal.fields.map((name) =>
          lowerValue(value.fields.get(name)!, name, span, lowering)
        ),
      );
    }

    case "sealed": {
      const sealed = lowering.seal(value.name);
      return at.apply(
        at.name(sealed.constructor),
        lowerValue(value.inner, hint, span, lowering),
      );
    }

    case "closure": {
      const existing = lowering.hoisted.get(value);
      if (existing !== undefined) return at.name(existing);
      const name = lowering.fresh(hint);
      lowering.hoisted.set(value, name);

      const scope = childScope(null, value.env);
      scope.hoisting = hint;
      // `rec` names the closure itself, so the definition has to be in scope
      // inside its own body.
      if (value.self !== null) scope.names.set(value.self, name);
      const parameter = lowering.fresh("arg");
      const body = bindParameter(
        value.parameter,
        parameter,
        scope,
        lowering,
      );
      lowering.definitions.push({
        name,
        parameters: [parameter],
        annotation: null,
        body: body(value.body),
      });
      return at.name(name);
    }
    // A type, a union, an effect: real compile-time values with no runtime
    // representation at all. Saying "not lowered yet" would suggest it is
    // coming; it is not, because there is nothing to lower it to.
    case "range":
    case "opaque-type":
    case "union":
    case "arrow":
    case "unbounded":
    case "effect":
      fail(
        "BLOT_NOT_A_RUNTIME_VALUE",
        `\`${hint}\` is a compile-time value — a type or an effect — and has no runtime representation. It cannot cross into WebAssembly.`,
        span,
      );
      break;

    default:
      return unsupported(`the compile-time value \`${hint}\``, span);
  }
  return unsupported(`the compile-time value \`${hint}\``, span);
}

/**
 * Binds a lambda's parameter, returning a function that wraps a lowered body.
 * A tuple parameter is one shape argument, so it becomes one binder and a
 * projection per element.
 */
function bindParameter(
  pattern: Pattern,
  parameter: string,
  scope: Scope,
  lowering: Lowering,
): (body: Expr) => SurfaceExpression {
  const at = surface.at({
    startByte: pattern.span.start,
    endByte: pattern.span.end,
  });
  const wrapper = bind(
    pattern,
    at.name(parameter),
    scope,
    lowering,
  );
  return (body) => wrapper(lower(body, scope, lowering));
}

function lowerIntegerBinary(
  operator: BinaryOperator,
  left: SurfaceExpression,
  right: SurfaceExpression,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  if (
    operator !== BinaryOperator.AddSignedInteger64 &&
    operator !== BinaryOperator.SubtractSignedInteger64 &&
    operator !== BinaryOperator.MultiplySignedInteger64
  ) {
    return at.binary(operator, left, right);
  }

  const leftName = lowering.fresh("left");
  const rightName = lowering.fresh("right");
  const resultName = lowering.fresh("result");
  const leftValue = at.name(leftName);
  const rightValue = at.name(rightName);
  const resultValue = at.name(resultName);
  const zero = at.signedInteger64(0n);
  const overflow = at.runtimeFault("integer overflow");
  let checked: SurfaceExpression;

  if (operator === BinaryOperator.AddSignedInteger64) {
    checked = at.if(
      at.binary(BinaryOperator.GreaterSignedInteger64, rightValue, zero),
      at.if(
        at.binary(
          BinaryOperator.LessSignedInteger64,
          resultValue,
          leftValue,
        ),
        overflow,
        resultValue,
      ),
      at.if(
        at.binary(BinaryOperator.LessSignedInteger64, rightValue, zero),
        at.if(
          at.binary(
            BinaryOperator.GreaterSignedInteger64,
            resultValue,
            leftValue,
          ),
          overflow,
          resultValue,
        ),
        resultValue,
      ),
    );
  } else if (operator === BinaryOperator.SubtractSignedInteger64) {
    checked = at.if(
      at.binary(BinaryOperator.GreaterSignedInteger64, rightValue, zero),
      at.if(
        at.binary(
          BinaryOperator.GreaterSignedInteger64,
          resultValue,
          leftValue,
        ),
        overflow,
        resultValue,
      ),
      at.if(
        at.binary(BinaryOperator.LessSignedInteger64, rightValue, zero),
        at.if(
          at.binary(
            BinaryOperator.LessSignedInteger64,
            resultValue,
            leftValue,
          ),
          overflow,
          resultValue,
        ),
        resultValue,
      ),
    );
  } else {
    const minimum = at.signedInteger64(-0x8000000000000000n);
    const negativeOne = at.signedInteger64(-1n);
    const minimumTimesNegativeOne = at.if(
      at.binary(
        BinaryOperator.EqualSignedInteger64,
        leftValue,
        negativeOne,
      ),
      at.if(
        at.binary(
          BinaryOperator.EqualSignedInteger64,
          rightValue,
          minimum,
        ),
        overflow,
        resultValue,
      ),
      at.if(
        at.binary(
          BinaryOperator.EqualSignedInteger64,
          rightValue,
          negativeOne,
        ),
        at.if(
          at.binary(
            BinaryOperator.EqualSignedInteger64,
            leftValue,
            minimum,
          ),
          overflow,
          resultValue,
        ),
        at.if(
          at.binary(BinaryOperator.EqualSignedInteger64, leftValue, zero),
          resultValue,
          at.if(
            at.binary(
              BinaryOperator.NotEqualSignedInteger64,
              at.binary(
                BinaryOperator.DivideSignedInteger64,
                resultValue,
                leftValue,
              ),
              rightValue,
            ),
            overflow,
            resultValue,
          ),
        ),
      ),
    );
    checked = minimumTimesNegativeOne;
  }

  return surface.let(
    leftName,
    left,
    surface.let(
      rightName,
      right,
      surface.let(
        resultName,
        at.binary(operator, leftValue, rightValue),
        checked,
      ),
    ),
  );
}

/**
 * The primitive a compile-time closure is an eta-expansion of, if it is one.
 *
 * The prelude spells its operations as closures over primitives —
 * `Vec4.add = fn left => fn right => @f32x4.add left right` — because a primitive
 * is not a value a module can put in a record. Lowering hoists such a closure
 * into a definition and calls it, which is right for a closure that does
 * something, and pure overhead for one that does nothing but pass its
 * arguments along in order.
 *
 * gpufuck now carries provable vectors through strict let bindings and native
 * workers, but the proof still begins with the Core shape it receives. Leaving
 * a pass-through wrapper in front of the primitive hides that shape at the
 * immediate use and creates a call that serves no source-level behavior.
 *
 * Recognising the eta-expansion costs nothing and terminates by construction:
 * the body must be one primitive application whose arguments are exactly the
 * parameters, in order, so there is no recursion to chase and no code to
 * duplicate. This is what makes "every operator is prelude source" true of the
 * emitted module and not only of the grammar.
 */
function etaExpandedPrimitive(
  value: Value,
  args: readonly Expr[],
): { readonly primitive: string; readonly args: readonly Expr[] } | null {
  if (value.tag !== "closure" || value.self !== null) return null;

  // A wrapper over a primitive of more than one argument takes them as one
  // tuple, because that is how the prelude spells every such function. The
  // call site has to spell it the same way for the arguments to be recoverable
  // one by one, which a tuple literal does and a name holding a tuple does not.
  let parameters: string[];
  let passed: readonly Expr[];
  if (value.parameter.tag === "tuple") {
    if (args.length !== 1 || args[0].tag !== "tuple") return null;
    if (value.parameter.elements.length !== args[0].elements.length) {
      return null;
    }
    if (!value.parameter.elements.every((element) => element.tag === "name")) {
      return null;
    }
    parameters = value.parameter.elements.map((element) =>
      (element as Pattern & { tag: "name" }).name
    );
    passed = args[0].elements;
  } else if (value.parameter.tag === "name") {
    parameters = [value.parameter.name];
    passed = args;
  } else {
    return null;
  }

  let body: Expr = value.body;
  while (parameters.length < passed.length) {
    if (body.tag !== "lambda" || body.parameter.tag !== "name") return null;
    parameters.push(body.parameter.name);
    body = body.body;
  }
  if (parameters.length !== passed.length) return null;

  if (body.tag !== "apply") return null;
  const spine = flatten(body);
  if (spine.callee.tag !== "intrinsic") return null;
  // Exactly the parameters, in order. A closure that reorders, drops, or
  // repeats one is doing something, and doing something is what a hoisted
  // definition is for.
  if (spine.args.length !== parameters.length) return null;
  const passthrough = spine.args.every((argument, index) =>
    argument.tag === "var" && argument.name === parameters[index]
  );
  if (!passthrough) return null;
  return { primitive: spine.callee.name, args: passed };
}

function storeUpdateOptions(
  source: Expr,
  scope: Scope,
  lowering: Lowering,
): { readonly owned: boolean } | undefined {
  if (source.tag !== "var") return undefined;
  const pattern = resolvePattern(scope, source.name);
  if (pattern === null || pattern.qualifier !== "linear") {
    return undefined;
  }
  const ownership = lowering.facts.ownership.get(pattern);
  if (!ownership?.spent || ownership.lastUse === null) return undefined;
  const use = ownershipUseIdentity(
    { path: ownership.path, bindingId: ownership.bindingId },
    source.span,
  );
  if (!lowering.reusableOwnership.has(use)) return undefined;
  // A read some closure makes across its own boundary happens when that closure
  // is called, and a recursive group's members call each other in an order the
  // block does not write down. Where the pass says so, the recorded last use is
  // the last one it walked past rather than the last one taken, and updating in
  // place would overwrite what a sibling still reads.
  if (ownership.reentrant) return undefined;
  if (
    ownership.lastUse.start !== source.span.start ||
    ownership.lastUse.end !== source.span.end
  ) return undefined;
  return { owned: true };
}

function lowerRecordArgument(
  argument: Expr,
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const adaptation = lowering.facts.recordAdaptations.get(argument);
  if (adaptation === undefined) return lower(argument, scope, lowering);

  const source = lowering.nominal(adaptation.sourceFields);
  const target = lowering.nominal(
    adaptation.fields.map((field) => field.name),
  );
  const optional = lowering.sum([
    { name: OPTIONAL_ABSENT, payload: false },
    { name: OPTIONAL_PRESENT, payload: true },
  ]);
  const value = lowering.fresh("record");
  const binders = source.fields.map((field) => lowering.fresh(field));
  const fields = new Map(
    adaptation.fields.map((field) => [field.name, field]),
  );
  const arguments_ = target.fields.map((name) => {
    const field = fields.get(name);
    if (field === undefined) {
      throw new Error(`record adaptation omitted target field .${name}`);
    }
    if (field.optional === "absent") {
      return at.name(constructorName(optional, OPTIONAL_ABSENT));
    }
    if (field.optional === "unit") {
      return at.name(UNIT_CONSTRUCTOR_NAME);
    }
    const index = source.fields.indexOf(name);
    if (index < 0) {
      throw new Error(`record adaptation omitted source field .${name}`);
    }
    const present = at.name(binders[index]);
    if (field.optional === "present") {
      return at.apply(
        at.name(constructorName(optional, OPTIONAL_PRESENT)),
        present,
      );
    }
    return present;
  });
  let rebuilt: SurfaceExpression = at.name(target.name);
  if (arguments_.length > 0) {
    rebuilt = at.apply(at.name(target.name), ...arguments_);
  }
  return surface.let(
    value,
    lower(argument, scope, lowering),
    at.case(at.name(value), [{
      constructor: source.name,
      binders,
      body: rebuilt,
    }]),
  );
}

function lowerIntegerSimd(
  name: string,
  arguments_: readonly Expr[],
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression | null {
  const matched = /^@(i32x4|i16x8|i8x16)\.(.+)$/.exec(name);
  if (matched === null) return null;
  lowering.usesIntegerVectors = true;
  const prefix = matched[1];
  let operation = matched[2];
  if (operation.endsWith("_wrapping")) {
    operation = operation.slice(0, -"_wrapping".length);
  }
  let bits = 32;
  let laneCount = 4;
  if (prefix === "i16x8") {
    bits = 16;
    laneCount = 8;
  }
  if (prefix === "i8x16") {
    bits = 8;
    laneCount = 16;
  }
  const fields = Array.from({ length: laneCount }, (_, index) => String(index));
  const nominal = lowering.nominal(fields);
  const make = (lanes: readonly SurfaceExpression[]): SurfaceExpression =>
    at.apply(at.name(nominal.name), ...lanes);
  const destructure = (
    value: SurfaceExpression,
    hint: string,
    body: (lanes: readonly SurfaceExpression[]) => SurfaceExpression,
  ): SurfaceExpression => {
    const binders = fields.map(() => lowering.fresh(hint));
    return at.case(value, [{
      constructor: nominal.name,
      binders,
      body: body(binders.map((binder) => at.name(binder))),
    }]);
  };
  const binary = (
    left: SurfaceExpression,
    right: SurfaceExpression,
    combine: (
      left: SurfaceExpression,
      right: SurfaceExpression,
    ) => SurfaceExpression,
  ): SurfaceExpression =>
    destructure(
      left,
      "leftLane",
      (leftLanes) =>
        destructure(right, "rightLane", (rightLanes) =>
          make(leftLanes.map((lane, index) =>
            combine(lane, rightLanes[index])
          ))),
    );
  const mask = (value: bigint): SurfaceExpression => at.signedInteger64(value);
  const modulus = 1n << BigInt(bits);
  const sign = modulus >> 1n;
  const laneMask = modulus - 1n;
  const normalize = (value: SurfaceExpression): SurfaceExpression => {
    const wrapped = at.binary(
      BinaryOperator.BitwiseAndSignedInteger64,
      value,
      mask(laneMask),
    );
    const saved = lowering.fresh("wrappedLane");
    return surface.let(
      saved,
      wrapped,
      at.if(
        at.binary(
          BinaryOperator.GreaterEqualSignedInteger64,
          at.name(saved),
          mask(sign),
        ),
        at.binary(
          BinaryOperator.SubtractSignedInteger64,
          at.name(saved),
          mask(modulus),
        ),
        at.name(saved),
      ),
    );
  };
  const unsigned = (value: SurfaceExpression): SurfaceExpression =>
    at.if(
      at.binary(
        BinaryOperator.LessSignedInteger64,
        value,
        mask(0n),
      ),
      at.binary(
        BinaryOperator.AddSignedInteger64,
        value,
        mask(modulus),
      ),
      value,
    );
  if (operation === "lane" && arguments_.length === 2) {
    const selector = lowering.facts.comptimeValues.get(arguments_[1]);
    if (
      selector === undefined || selector.tag !== "int" ||
      selector.value < 0n || selector.value > 3n
    ) {
      throw new Error("certified I32x4 lane selector is missing");
    }
    return destructure(
      lower(arguments_[0], scope, lowering),
      "lane",
      (lanes) => lanes[Number(selector.value)],
    );
  }
  const lowered = arguments_.map((argument) =>
    lower(argument, scope, lowering)
  );
  if (operation === "of" && lowered.length === laneCount) {
    return make(lowered.map(normalize));
  }
  if (operation === "splat" && lowered.length === 1) {
    const lane = lowering.fresh("splatLane");
    return surface.let(
      lane,
      normalize(lowered[0]),
      make(fields.map(() => at.name(lane))),
    );
  }
  const extracted = /^(?:lane)([0-3])$/.exec(operation);
  if (extracted !== null && lowered.length === 1) {
    const lane = Number(extracted[1]);
    return destructure(lowered[0], "lane", (lanes) => lanes[lane]);
  }
  const replaced = /^with_lane([0-3])$/.exec(operation);
  if (replaced !== null && lowered.length === 2) {
    const lane = Number(replaced[1]);
    return destructure(
      lowered[0],
      "lane",
      (lanes) =>
        make(lanes.map((value, index) => {
          if (index === lane) return normalize(lowered[1]);
          return value;
        })),
    );
  }
  if (operation === "select" && lowered.length === 3) {
    return destructure(
      lowered[0],
      "maskLane",
      (maskLanes) =>
        destructure(
          lowered[1],
          "trueLane",
          (trueLanes) =>
            destructure(lowered[2], "falseLane", (falseLanes) =>
              make(maskLanes.map((lane, index) =>
                at.if(lane, trueLanes[index], falseLanes[index])
              ))),
        ),
    );
  }
  if (operation.startsWith("mask_") && lowered.length === 1) {
    return destructure(lowered[0], "maskLane", (lanes) => {
      if (operation === "mask_bitmask") {
        return lanes.reduce((result, lane, index) =>
          at.binary(
            BinaryOperator.AddSignedInteger64,
            result,
            at.if(lane, mask(1n << BigInt(index)), mask(0n)),
          ), mask(0n));
      }
      if (operation === "mask_all") {
        return lanes.reduceRight(
          (result, lane) => at.if(lane, result, mask(0n)),
          mask(1n),
        );
      }
      return lanes.reduceRight(
        (result, lane) => at.if(lane, mask(1n), result),
        mask(0n),
      );
    });
  }
  const unaryOperators = new Map<
    string,
    (lane: SurfaceExpression) => SurfaceExpression
  >([
    ["not", (lane) =>
      normalize(at.binary(
        BinaryOperator.BitwiseXorSignedInteger64,
        lane,
        mask(-1n),
      ))],
  ]);
  const unary = unaryOperators.get(operation);
  if (unary !== undefined && lowered.length === 1) {
    return destructure(lowered[0], "lane", (lanes) => make(lanes.map(unary)));
  }
  if (
    (operation === "shl" || operation === "shr_s" || operation === "shr_u") &&
    lowered.length === 2
  ) {
    const amount = at.binary(
      BinaryOperator.BitwiseAndSignedInteger64,
      lowered[1],
      mask(BigInt(bits - 1)),
    );
    return destructure(lowered[0], "lane", (lanes) =>
      make(lanes.map((lane) => {
        if (operation === "shl") {
          return normalize(at.binary(
            BinaryOperator.ShiftLeftSignedInteger64,
            lane,
            amount,
          ));
        }
        if (operation === "shr_u") {
          return normalize(at.binary(
            BinaryOperator.ShiftRightUnsignedSignedInteger64,
            unsigned(lane),
            amount,
          ));
        }
        return at.if(
          at.binary(BinaryOperator.LessSignedInteger64, lane, mask(0n)),
          normalize(at.binary(
            BinaryOperator.BitwiseXorSignedInteger64,
            at.binary(
              BinaryOperator.ShiftRightUnsignedSignedInteger64,
              at.binary(
                BinaryOperator.BitwiseXorSignedInteger64,
                lane,
                mask(-1n),
              ),
              amount,
            ),
            mask(-1n),
          )),
          at.binary(
            BinaryOperator.ShiftRightUnsignedSignedInteger64,
            lane,
            amount,
          ),
        );
      })));
  }
  const arithmeticOperators = new Map<string, BinaryOperator>([
    ["add", BinaryOperator.AddSignedInteger64],
    ["sub", BinaryOperator.SubtractSignedInteger64],
    ["mul", BinaryOperator.MultiplySignedInteger64],
    ["and", BinaryOperator.BitwiseAndSignedInteger64],
    ["or", BinaryOperator.BitwiseOrSignedInteger64],
    ["xor", BinaryOperator.BitwiseXorSignedInteger64],
  ]);
  const arithmetic = arithmeticOperators.get(operation);
  if (arithmetic !== undefined && lowered.length === 2) {
    return binary(
      lowered[0],
      lowered[1],
      (left, right) => normalize(at.binary(arithmetic, left, right)),
    );
  }
  const comparisonOperators = new Map<string, BinaryOperator>([
    ["eq", BinaryOperator.EqualSignedInteger64],
    ["ne", BinaryOperator.NotEqualSignedInteger64],
    ["lt_s", BinaryOperator.LessSignedInteger64],
    ["gt_s", BinaryOperator.GreaterSignedInteger64],
    ["le_s", BinaryOperator.LessEqualSignedInteger64],
    ["ge_s", BinaryOperator.GreaterEqualSignedInteger64],
    ["lt_u", BinaryOperator.LessSignedInteger64],
    ["gt_u", BinaryOperator.GreaterSignedInteger64],
    ["le_u", BinaryOperator.LessEqualSignedInteger64],
    ["ge_u", BinaryOperator.GreaterEqualSignedInteger64],
  ]);
  const comparison = comparisonOperators.get(operation);
  if (comparison !== undefined && lowered.length === 2) {
    const isUnsigned = operation.endsWith("_u");
    return binary(lowered[0], lowered[1], (left, right) => {
      if (isUnsigned) {
        return at.binary(comparison, unsigned(left), unsigned(right));
      }
      return at.binary(comparison, left, right);
    });
  }
  if (
    (operation === "min_s" || operation === "max_s" ||
      operation === "min_u" || operation === "max_u") &&
    lowered.length === 2
  ) {
    const chooseLeftOnLess = operation.startsWith("min_");
    const isUnsigned = operation.endsWith("_u");
    return binary(lowered[0], lowered[1], (left, right) => {
      let comparedLeft = left;
      let comparedRight = right;
      if (isUnsigned) {
        comparedLeft = unsigned(left);
        comparedRight = unsigned(right);
      }
      let operator: BinaryOperator = BinaryOperator.GreaterSignedInteger64;
      if (chooseLeftOnLess) operator = BinaryOperator.LessSignedInteger64;
      return at.if(
        at.binary(operator, comparedLeft, comparedRight),
        left,
        right,
      );
    });
  }
  return null;
}

function lowerApply(
  expr: Expr & { tag: "apply" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  if (expr.fn.tag === "var") {
    const choice = resolveRuntimeLambdaChoice(scope, expr.fn.name);
    if (choice !== null) {
      const argument = lowering.fresh("specialized$argument");
      return surface.let(
        argument,
        lower(expr.arg, scope, lowering),
        at.if(
          at.name(choice.selector),
          lowerSpecializedApplication(
            choice.consequent,
            expr.arg,
            at.name(argument),
            lowering,
          ),
          lowerSpecializedApplication(
            choice.alternate,
            expr.arg,
            at.name(argument),
            lowering,
          ),
        ),
      );
    }
  }

  const specialized = specializableLambda(expr.fn, scope);
  if (specialized !== null) {
    return lowerSpecializedApplication(
      specialized,
      expr.arg,
      lower(expr.arg, scope, lowering),
      lowering,
    );
  }

  // A primitive with a Core operator becomes that operator rather than a call:
  // `@int.add a b` is `a + b`, not an application of a function that does not
  // exist at this level.
  const spine = flatten(expr);

  // A prelude wrapper that only passes its arguments to a primitive is that
  // primitive. Resolved before anything else looks at the callee, because the
  // point is for the rest of this function to see `@f32x4.add a b` exactly as
  // if the program had written it.
  if (spine.callee.tag === "field") {
    const member = comptimeShapeMember(spine.callee, scope);
    if (member !== null) {
      if (member.tag === "primitive") {
        let rebuilt: Expr = {
          tag: "intrinsic",
          name: member.name,
          span: spine.callee.span,
        };
        for (const argument of spine.args) {
          rebuilt = {
            tag: "apply",
            fn: rebuilt,
            arg: argument,
            span: expr.span,
          };
        }
        return lowerApply(
          rebuilt as Expr & { tag: "apply" },
          scope,
          lowering,
          at,
        );
      }
      const expanded = etaExpandedPrimitive(member, spine.args);
      if (expanded !== null) {
        let rebuilt: Expr = {
          tag: "intrinsic",
          name: expanded.primitive,
          span: spine.callee.span,
        };
        for (const argument of expanded.args) {
          rebuilt = {
            tag: "apply",
            fn: rebuilt,
            arg: argument,
            span: expr.span,
          };
        }
        return lowerApply(
          rebuilt as Expr & { tag: "apply" },
          scope,
          lowering,
          at,
        );
      }
    }
  }

  // `#Busy 41` builds a value; typing it through application would make the
  // constructor a function it is not.
  if (spine.callee.tag === "tag" && spine.args.length === 1) {
    if (spine.callee.name === "True" || spine.callee.name === "False") {
      return unsupported("a boolean constructor with a payload", expr.span);
    }
    const exit = resolveExit(scope, spine.callee.name);
    if (exit !== null) {
      return at.jump(
        exit,
        lower(controlPayloadValue(spine.args[0]), scope, lowering),
      );
    }
    const sum = lowering.sumFor(spine.callee.name, true, expr.span);
    return at.apply(
      at.name(constructorName(sum, spine.callee.name)),
      lower(spine.args[0], scope, lowering),
    );
  }

  if (spine.callee.tag === "intrinsic") {
    const integerSimd = lowerIntegerSimd(
      spine.callee.name,
      spine.args,
      scope,
      lowering,
      at,
    );
    if (integerSimd !== null) return integerSimd;
  }

  if (spine.callee.tag === "intrinsic") {
    if (
      spine.callee.name === "@continuation.cancel" &&
      spine.args.length === 1
    ) {
      return at.name(UNIT_CONSTRUCTOR_NAME);
    }
    const operator = BINARY.get(spine.callee.name);
    if (operator !== undefined && spine.args.length === 2) {
      return lowerIntegerBinary(
        operator,
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
        lowering,
        at,
      );
    }
    // Text concatenation is its own Core node rather than an operator; the
    // builder has no helper for it, which is why this is a node literal.
    if (spine.callee.name === "@text.concat" && spine.args.length === 2) {
      return {
        kind: "text-append",
        left: lower(spine.args[0], scope, lowering),
        right: lower(spine.args[1], scope, lowering),
        span: { startByte: expr.span.start, endByte: expr.span.end },
      };
    }
    // One comparison primitive becomes two Core comparisons and a constructor.
    // `Eq` and `Ord` are prelude source over `@int.cmp`, so lowering it is what
    // makes every comparison in the language reach Wasm.
    if (spine.callee.name === "@int.cmp" && spine.args.length === 2) {
      const sum = lowering.sum([
        { name: "Less", payload: false },
        { name: "Equal", payload: false },
        { name: "Greater", payload: false },
      ]);
      const left = lowering.fresh("left");
      const right = lowering.fresh("right");
      const tag = (name: string): SurfaceExpression =>
        at.name(constructorName(sum, name));
      return surface.let(
        left,
        lower(spine.args[0], scope, lowering),
        surface.let(
          right,
          lower(spine.args[1], scope, lowering),
          at.if(
            at.binary(
              BinaryOperator.LessSignedInteger64,
              at.name(left),
              at.name(right),
            ),
            tag("Less"),
            at.if(
              at.binary(
                BinaryOperator.EqualSignedInteger64,
                at.name(left),
                at.name(right),
              ),
              tag("Equal"),
              tag("Greater"),
            ),
          ),
        ),
      );
    }
    // A value is NaN exactly when it is unequal to itself, which is the one
    // thing `@float.cmp` cannot report — it refuses NaN rather than ordering
    // it. The binding is so the argument is evaluated once.
    if (spine.callee.name === "@float.is_nan" && spine.args.length === 1) {
      const value = lowering.fresh("value");
      return surface.let(
        value,
        lower(spine.args[0], scope, lowering),
        at.binary(
          BinaryOperator.NotEqualFloat64,
          at.name(value),
          at.name(value),
        ),
      );
    }
    // The same shape as `@int.cmp`, plus a fourth case the integers do not
    // have. Testing `greater` explicitly rather than falling through to it is
    // what makes the remaining branch mean *unordered*, and NaN is the only
    // way to reach it. Without that test NaN answered `#Greater` in both
    // directions at once — not an order at all, and a disagreement with the
    // comptime evaluator, which refuses.
    //
    // The cost is one comparison, and only on the path that is not already
    // `Less` or `Equal`.
    if (spine.callee.name === "@float.cmp" && spine.args.length === 2) {
      const sum = lowering.sum([
        { name: "Less", payload: false },
        { name: "Equal", payload: false },
        { name: "Greater", payload: false },
      ]);
      const left = lowering.fresh("left");
      const right = lowering.fresh("right");
      const tag = (name: string): SurfaceExpression =>
        at.name(constructorName(sum, name));
      return surface.let(
        left,
        lower(spine.args[0], scope, lowering),
        surface.let(
          right,
          lower(spine.args[1], scope, lowering),
          at.if(
            at.binary(
              BinaryOperator.LessFloat64,
              at.name(left),
              at.name(right),
            ),
            tag("Less"),
            at.if(
              at.binary(
                BinaryOperator.EqualFloat64,
                at.name(left),
                at.name(right),
              ),
              tag("Equal"),
              at.if(
                at.binary(
                  BinaryOperator.GreaterFloat64,
                  at.name(left),
                  at.name(right),
                ),
                tag("Greater"),
                at.runtimeFault("float comparison against NaN"),
              ),
            ),
          ),
        ),
      );
    }
    // --- four lanes --------------------------------------------------------
    //
    // These become `f32x4.*` instructions when the backend is asked for
    // `wasm-simd` and the scalar bodies gpufuck ships when it is not. The names
    // are the whole contract: its codegen matches them and checks both
    // arguments are provably vectors, so a chain of these stays in a register
    // rather than being rebuilt between operations.
    if (spine.callee.name === "@f32x4.of" && spine.args.length === 4) {
      lowering.vectors = true;
      return f32x4.make([
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
        lower(spine.args[2], scope, lowering),
        lower(spine.args[3], scope, lowering),
      ]);
    }
    if (spine.callee.name === "@f32x4.splat" && spine.args.length === 1) {
      lowering.vectors = true;
      return f32x4.splat(lower(spine.args[0], scope, lowering));
    }
    if (spine.callee.name === "@f32x4.sum" && spine.args.length === 1) {
      lowering.vectors = true;
      return f32x4.reduceAdd(lower(spine.args[0], scope, lowering));
    }
    const LANES: ReadonlyMap<string, number> = new Map([
      ["@f32x4.x", 0],
      ["@f32x4.y", 1],
      ["@f32x4.z", 2],
      ["@f32x4.w", 3],
    ]);
    const lane = LANES.get(spine.callee.name);
    if (lane !== undefined && spine.args.length === 1) {
      lowering.vectors = true;
      return f32x4.extractLane(lower(spine.args[0], scope, lowering), lane);
    }
    const VECTOR: ReadonlyMap<
      string,
      (left: SurfaceExpression, right: SurfaceExpression) => SurfaceExpression
    > = new Map([
      ["@f32x4.add", f32x4.add],
      ["@f32x4.sub", f32x4.subtract],
      ["@f32x4.mul", f32x4.multiply],
      ["@f32x4.div", f32x4.divide],
      ["@f32x4.eq", f32x4.equal],
      ["@f32x4.less", f32x4.less],
    ]);
    const vectorOp = VECTOR.get(spine.callee.name);
    if (vectorOp !== undefined && spine.args.length === 2) {
      lowering.vectors = true;
      return vectorOp(
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
      );
    }
    if (spine.callee.name === "@f32x4.select" && spine.args.length === 3) {
      lowering.vectors = true;
      return f32x4.select(
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
        lower(spine.args[2], scope, lowering),
      );
    }
    if (spine.callee.name === "@f32x4.shuffle" && spine.args.length === 6) {
      const lanes = spine.args.slice(2).map((selector) => {
        const known = selector.tag === "int"
          ? selector
          : lowering.facts.comptimeValues.get(selector);
        return known?.tag === "int" ? Number(known.value) : undefined;
      });
      if (
        lanes.some((lane) =>
          lane === undefined || !Number.isSafeInteger(lane) || lane < 0 ||
          lane > 7
        )
      ) {
        return unsupported(
          "an F32x4 shuffle without four constant lanes in 0..7",
          expr.span,
        );
      }
      lowering.vectors = true;
      return f32x4.shuffle(
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
        lanes as [number, number, number, number],
      );
    }
    if (spine.callee.name === "@f32.is_nan" && spine.args.length === 1) {
      const value = lowering.fresh("value");
      return surface.let(
        value,
        lower(spine.args[0], scope, lowering),
        at.binary(
          BinaryOperator.NotEqualFloat32,
          at.name(value),
          at.name(value),
        ),
      );
    }
    // The same four-way shape `@float.cmp` takes, so the unordered branch is
    // reachable only by NaN and refuses there too.
    if (spine.callee.name === "@f32.cmp" && spine.args.length === 2) {
      const sum = lowering.sum([
        { name: "Less", payload: false },
        { name: "Equal", payload: false },
        { name: "Greater", payload: false },
      ]);
      const left = lowering.fresh("left");
      const right = lowering.fresh("right");
      const tag = (name: string): SurfaceExpression =>
        at.name(constructorName(sum, name));
      return surface.let(
        left,
        lower(spine.args[0], scope, lowering),
        surface.let(
          right,
          lower(spine.args[1], scope, lowering),
          at.if(
            at.binary(
              BinaryOperator.LessFloat32,
              at.name(left),
              at.name(right),
            ),
            tag("Less"),
            at.if(
              at.binary(
                BinaryOperator.EqualFloat32,
                at.name(left),
                at.name(right),
              ),
              tag("Equal"),
              at.if(
                at.binary(
                  BinaryOperator.GreaterFloat32,
                  at.name(left),
                  at.name(right),
                ),
                tag("Greater"),
                at.runtimeFault("float comparison against NaN"),
              ),
            ),
          ),
        ),
      );
    }
    if (spine.callee.name === "@f32.neg" && spine.args.length === 1) {
      return at.unary(
        UnaryOperator.NegateFloat32,
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@f32.of_float" && spine.args.length === 1) {
      return at.convert(
        NumericConversion.Float64ToFloat32,
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@float.of_f32" && spine.args.length === 1) {
      return at.convert(
        NumericConversion.Float32ToFloat64,
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@float.neg" && spine.args.length === 1) {
      return at.unary(
        UnaryOperator.NegateFloat64,
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@float.of_int" && spine.args.length === 1) {
      return at.convert(
        NumericConversion.SignedInteger64ToFloat64,
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@int.of_float" && spine.args.length === 1) {
      return at.convert(
        NumericConversion.Float64ToSignedInteger64,
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@int.neg" && spine.args.length === 1) {
      return lowerIntegerBinary(
        BinaryOperator.SubtractSignedInteger64,
        at.signedInteger64(0n),
        lower(spine.args[0], scope, lowering),
        lowering,
        at,
      );
    }
    // A module is a function from a record to a record, and both are known at
    // compile time, so importing one is inlining it. `@import "x" arg` is the
    // imported module's body with `arg` bound to its parameter.
    if (spine.callee.name === "@import" && spine.args.length >= 1) {
      return lowerImport(spine, scope, lowering, expr.span);
    }
    if (spine.callee.name === "@handle" && spine.args.length === 1) {
      return lowerHandle(spine.args[0], scope, lowering, expr.span);
    }
    // Core carries text without measuring or rendering it, so inspecting text
    // *is* a host operation. blot declares the capability itself rather than
    // making every program declare an effect for something the language already
    // has — the import is still typed, declared, and visible in the module.
    if (spine.callee.name === "@text.len" && spine.args.length === 1) {
      return at.apply(
        at.name(
          textOperation(
            "length",
            HostTypes.text,
            { kind: "signed-integer-64" },
            lowering,
          ),
        ),
        lower(spine.args[0], scope, lowering),
      );
    }
    if (spine.callee.name === "@text.of_int" && spine.args.length === 1) {
      return at.apply(
        at.name(
          textOperation(
            "of_int",
            { kind: "signed-integer-64" },
            HostTypes.text,
            lowering,
          ),
        ),
        lower(spine.args[0], scope, lowering),
      );
    }
    // The host answers with a sign, and the ordering is built here — a variant
    // has no boundary representation, and inventing one for three constructors
    // would be a worse trade than one comparison.
    if (spine.callee.name === "@text.cmp" && spine.args.length === 2) {
      // Host operations are unary, and Core has tuple *types* but no tuple
      // expression — so the pair crosses as blot's own pair nominal, which the
      // boundary already knows how to encode as a constructor.
      const pair = lowering.nominal(["0", "1"]);
      const compare = textOperation(
        "compare",
        {
          kind: "named",
          name: pair.name,
          arguments: [HostTypes.text, HostTypes.text],
        },
        { kind: "signed-integer-64" },
        lowering,
      );
      const sign = lowering.fresh("sign");
      const sum = lowering.sum([
        { name: "Less", payload: false },
        { name: "Equal", payload: false },
        { name: "Greater", payload: false },
      ]);
      const tag = (name: string): SurfaceExpression =>
        at.name(constructorName(sum, name));
      return surface.let(
        sign,
        at.apply(
          at.name(compare),
          at.apply(
            at.name(pair.name),
            lower(spine.args[0], scope, lowering),
            lower(spine.args[1], scope, lowering),
          ),
        ),
        at.if(
          at.binary(
            BinaryOperator.LessSignedInteger64,
            at.name(sign),
            at.signedInteger64(0n),
          ),
          tag("Less"),
          at.if(
            at.binary(
              BinaryOperator.EqualSignedInteger64,
              at.name(sign),
              at.signedInteger64(0n),
            ),
            tag("Equal"),
            tag("Greater"),
          ),
        ),
      );
    }
    if (
      spine.callee.name === "@text.contains" && spine.args.length === 2
    ) {
      const pair = lowering.nominal(["0", "1"]);
      const contains = textOperation(
        "contains",
        {
          kind: "named",
          name: pair.name,
          arguments: [HostTypes.text, HostTypes.text],
        },
        { kind: "boolean" },
        lowering,
      );
      return at.apply(
        at.name(contains),
        at.apply(
          at.name(pair.name),
          lower(spine.args[0], scope, lowering),
          lower(spine.args[1], scope, lowering),
        ),
      );
    }
    if (spine.callee.name === "@array.len" && spine.args.length === 1) {
      return at.convert(
        NumericConversion.SignedInteger32ToSignedInteger64,
        at.storeLength(lower(spine.args[0], scope, lowering)),
      );
    }
    if (spine.callee.name === "@array.get" && spine.args.length === 2) {
      const proof = lowering.facts.arrayProofs.get(expr);
      if (proof === undefined) {
        throw new Error("checked direct array read omitted its bounds proof");
      }
      if (!verifiesArrayIndexProof(proof)) {
        throw new Error(
          "checked direct array read carried an invalid bounds proof",
        );
      }
      return at.storeRead(
        lower(spine.args[0], scope, lowering),
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          lower(spine.args[1], scope, lowering),
        ),
      );
    }
    if (spine.callee.name === "@array.set" && spine.args.length === 3) {
      const proof = lowering.facts.arrayProofs.get(expr);
      if (proof === undefined) {
        throw new Error("checked direct array write omitted its bounds proof");
      }
      if (!verifiesArrayIndexProof(proof)) {
        throw new Error(
          "checked direct array write carried an invalid bounds proof",
        );
      }
      return at.storeWrite(
        lower(spine.args[0], scope, lowering),
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          lower(spine.args[1], scope, lowering),
        ),
        lower(spine.args[2], scope, lowering),
        storeUpdateOptions(spine.args[0], scope, lowering),
      );
    }
    // Growing by one and filling the new slot with the value is an append.
    if (spine.callee.name === "@array.push" && spine.args.length === 2) {
      const store = lowering.fresh("store");
      const options = storeUpdateOptions(spine.args[0], scope, lowering);
      return surface.let(
        store,
        lower(spine.args[0], scope, lowering),
        at.storeGrow(
          at.name(store),
          at.binary(
            BinaryOperator.Add,
            at.storeLength(at.name(store)),
            at.integer(1),
          ),
          lower(spine.args[1], scope, lowering),
          options,
        ),
      );
    }
    if (spine.callee.name === "@array.take" && spine.args.length === 2) {
      return lowerArrayTake(
        spine.args[0],
        spine.args[1],
        scope,
        lowering,
        at,
      );
    }
    if (spine.callee.name === "@array.split" && spine.args.length === 2) {
      return lowerArraySplit(
        spine.args[0],
        spine.args[1],
        scope,
        lowering,
        at,
      );
    }
    if (spine.callee.name === "@array.indexed" && spine.args.length === 1) {
      return lowerIndexedIterator(
        spine.args[0],
        scope,
        lowering,
        at,
      );
    }
    // A refusal that survived compiling is one the program reached at run time,
    // so it becomes a fault with the same message. `expect` is a prelude
    // function and gets lowered like any other, whether or not this arm of it
    // can be taken.
    // The escape from exhaustiveness. `@fail` refuses while compiling; this one
    // is reachable by construction, so it lowers to an explicit fault carrying
    // the reason the program gave for it.
    if (spine.callee.name === "@panic" && spine.args.length === 1) {
      const reason = spine.args[0];
      return surface.runtimeFault(
        reason.tag === "text" ? reason.value : "panicked",
      );
    }
    if (spine.callee.name === "@fail" && spine.args.length === 1) {
      const message = spine.args[0];
      return surface.runtimeFault(
        message.tag === "text" ? message.value : "refused",
      );
    }
    // Checked while compiling, so nothing survives into the runtime: the value
    // passes through, and a failure was already a diagnostic.
    if (spine.callee.name === "@satisfies" && spine.args.length === 2) {
      return lower(spine.args[0], scope, lowering);
    }
    if (
      spine.callee.name === "@linear.own" ||
      spine.callee.name === "@linear.borrow"
    ) {
      return lower(spine.args[0], scope, lowering);
    }
    return unsupported(`the primitive \`${spine.callee.name}\``, expr.span);
  }

  return at.apply(
    lower(spine.callee, scope, lowering),
    ...spine.args.map((argument) =>
      lowerRecordArgument(argument, scope, lowering, at)
    ),
  );
}

function lowerSpecializedApplication(
  specialized: RuntimeLambda,
  argument: Expr,
  value: SurfaceExpression,
  lowering: Lowering,
): SurfaceExpression {
  const inner = childScope(specialized.environment);
  const parameter = lowering.fresh("specialized");
  const fields = concreteRecordShape(argument, lowering);
  if (fields !== null) {
    if (specialized.expression.parameter.tag === "name") {
      inner.recordShapes.set(specialized.expression.parameter.name, fields);
    } else if (specialized.expression.parameter.tag === "shape") {
      inner.parameterShapes.set(specialized.expression.parameter, fields);
    }
  }
  if (specialized.expression.parameter.tag === "name") {
    const type = lowering.facts.expressionTypes.get(argument);
    if (type !== undefined) {
      inner.specializedTypes.set(specialized.expression.parameter.name, type);
    }
  }
  const body = bindParameter(
    specialized.expression.parameter,
    parameter,
    inner,
    lowering,
  );
  return surface.let(
    parameter,
    value,
    body(specialized.expression.body),
  );
}

function lowerIndexedIterator(
  array: Expr,
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const source = lowering.fresh("indexed");
  const index = lowering.fresh("index");
  const index32 = lowering.fresh("index32");
  const iterator = lowering.nominal(["state", "step"]);
  const pair = lowering.nominal(["0", "1"]);
  const option = lowering.sum([
    { name: "None", payload: false },
    { name: "Some", payload: true },
  ]);
  const none = at.name(constructorName(option, "None"));
  const selected = at.apply(
    at.name(pair.name),
    at.name(index),
    at.storeRead(at.name(source), at.name(index32)),
  );
  const next = at.binary(
    BinaryOperator.AddSignedInteger64,
    at.name(index),
    at.signedInteger64(1n),
  );
  const success = at.apply(
    at.name(constructorName(option, "Some")),
    at.apply(at.name(pair.name), selected, next),
  );
  const length = at.convert(
    NumericConversion.SignedInteger32ToSignedInteger64,
    at.storeLength(at.name(source)),
  );
  const body = at.if(
    at.binary(
      BinaryOperator.LessSignedInteger64,
      at.name(index),
      at.signedInteger64(0n),
    ),
    none,
    at.if(
      at.binary(
        BinaryOperator.LessSignedInteger64,
        at.name(index),
        length,
      ),
      surface.let(
        index32,
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          at.name(index),
        ),
        success,
      ),
      none,
    ),
  );
  return surface.let(
    source,
    lower(array, scope, lowering),
    at.apply(
      at.name(iterator.name),
      at.signedInteger64(0n),
      at.lambda([index], body),
    ),
  );
}

function lowerArrayTake(
  array: Expr,
  index: Expr,
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const source = lowering.fresh("source");
  const wideIndex = lowering.fresh("index");
  const narrowIndex = lowering.fresh("index32");
  const result = lowering.sum([
    { name: "Taken", payload: true },
    { name: "TakeOutOfBounds", payload: true },
  ]);
  const failure = at.apply(
    at.name(constructorName(result, "TakeOutOfBounds")),
    at.name(source),
  );
  const pair = lowering.nominal(["0", "1"]);
  const selected = at.storeRead(at.name(source), at.name(narrowIndex));
  const remainder = copyWithoutIndex(source, narrowIndex, lowering, at);
  const success = at.apply(
    at.name(constructorName(result, "Taken")),
    at.apply(at.name(pair.name), selected, remainder),
  );
  const length = at.convert(
    NumericConversion.SignedInteger32ToSignedInteger64,
    at.storeLength(at.name(source)),
  );
  const inBounds = at.if(
    at.binary(
      BinaryOperator.LessSignedInteger64,
      at.name(wideIndex),
      at.signedInteger64(0n),
    ),
    failure,
    at.if(
      at.binary(
        BinaryOperator.LessSignedInteger64,
        at.name(wideIndex),
        length,
      ),
      surface.let(
        narrowIndex,
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          at.name(wideIndex),
        ),
        success,
      ),
      failure,
    ),
  );
  return surface.let(
    source,
    lower(array, scope, lowering),
    surface.let(wideIndex, lower(index, scope, lowering), inBounds),
  );
}

function lowerArraySplit(
  array: Expr,
  index: Expr,
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const source = lowering.fresh("source");
  const wideIndex = lowering.fresh("index");
  const narrowIndex = lowering.fresh("index32");
  const result = lowering.sum([
    { name: "Split", payload: true },
    { name: "SplitOutOfBounds", payload: true },
  ]);
  const failure = at.apply(
    at.name(constructorName(result, "SplitOutOfBounds")),
    at.name(source),
  );
  const parts = copyAroundIndex(source, narrowIndex, lowering, at);
  const triple = lowering.nominal(["0", "1", "2"]);
  const binders = [
    lowering.fresh("before"),
    lowering.fresh("selected"),
    lowering.fresh("after"),
  ];
  const payload = at.apply(
    at.name(triple.name),
    at.name(binders[0]),
    at.name(binders[1]),
    at.name(binders[2]),
  );
  const built = at.case(parts, [{
    constructor: triple.name,
    binders,
    body: at.apply(at.name(constructorName(result, "Split")), payload),
  }]);
  const length = at.convert(
    NumericConversion.SignedInteger32ToSignedInteger64,
    at.storeLength(at.name(source)),
  );
  const inBounds = at.if(
    at.binary(
      BinaryOperator.LessSignedInteger64,
      at.name(wideIndex),
      at.signedInteger64(0n),
    ),
    failure,
    at.if(
      at.binary(
        BinaryOperator.LessSignedInteger64,
        at.name(wideIndex),
        length,
      ),
      surface.let(
        narrowIndex,
        at.convert(
          NumericConversion.SignedInteger64ToSignedInteger32,
          at.name(wideIndex),
        ),
        built,
      ),
      failure,
    ),
  );
  return surface.let(
    source,
    lower(array, scope, lowering),
    surface.let(wideIndex, lower(index, scope, lowering), inBounds),
  );
}

function copyWithoutIndex(
  source: string,
  selected: string,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const pair = lowering.nominal(["0", "1"]);
  const loop = lowering.fresh("take");
  const state = lowering.fresh("state");
  const current = lowering.fresh("current");
  const remainder = lowering.fresh("remainder");
  const nextRemainder = at.if(
    at.binary(BinaryOperator.Equal, at.name(current), at.name(selected)),
    at.name(remainder),
    at.storeGrow(
      at.name(remainder),
      at.binary(
        BinaryOperator.Add,
        at.storeLength(at.name(remainder)),
        at.integer(1),
      ),
      at.storeRead(at.name(source), at.name(current)),
    ),
  );
  const body = at.case(at.name(state), [{
    constructor: pair.name,
    binders: [current, remainder],
    body: at.if(
      at.binary(
        BinaryOperator.Less,
        at.name(current),
        at.storeLength(at.name(source)),
      ),
      at.apply(
        at.name(loop),
        at.apply(
          at.name(pair.name),
          at.binary(BinaryOperator.Add, at.name(current), at.integer(1)),
          nextRemainder,
        ),
      ),
      at.name(remainder),
    ),
  }]);
  return {
    kind: "let-rec-group",
    bindings: [{ name: loop, parameters: [state], body }],
    body: at.apply(
      at.name(loop),
      at.apply(at.name(pair.name), at.integer(0), at.storeEmpty()),
    ),
  };
}

function copyAroundIndex(
  source: string,
  selected: string,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  const stateType = lowering.nominal(["0", "1", "2"]);
  const resultType = lowering.nominal(["0", "1", "2"]);
  const loop = lowering.fresh("split");
  const state = lowering.fresh("state");
  const current = lowering.fresh("current");
  const before = lowering.fresh("before");
  const after = lowering.fresh("after");
  const element = at.storeRead(at.name(source), at.name(current));
  const nextBefore = at.if(
    at.binary(BinaryOperator.Less, at.name(current), at.name(selected)),
    at.storeGrow(
      at.name(before),
      at.binary(
        BinaryOperator.Add,
        at.storeLength(at.name(before)),
        at.integer(1),
      ),
      element,
    ),
    at.name(before),
  );
  const nextAfter = at.if(
    at.binary(BinaryOperator.Greater, at.name(current), at.name(selected)),
    at.storeGrow(
      at.name(after),
      at.binary(
        BinaryOperator.Add,
        at.storeLength(at.name(after)),
        at.integer(1),
      ),
      element,
    ),
    at.name(after),
  );
  const body = at.case(at.name(state), [{
    constructor: stateType.name,
    binders: [current, before, after],
    body: at.if(
      at.binary(
        BinaryOperator.Less,
        at.name(current),
        at.storeLength(at.name(source)),
      ),
      at.apply(
        at.name(loop),
        at.apply(
          at.name(stateType.name),
          at.binary(BinaryOperator.Add, at.name(current), at.integer(1)),
          nextBefore,
          nextAfter,
        ),
      ),
      at.apply(
        at.name(resultType.name),
        at.name(before),
        at.storeRead(at.name(source), at.name(selected)),
        at.name(after),
      ),
    ),
  }]);
  return {
    kind: "let-rec-group",
    bindings: [{ name: loop, parameters: [state], body }],
    body: at.apply(
      at.name(loop),
      at.apply(
        at.name(stateType.name),
        at.integer(0),
        at.storeEmpty(),
        at.storeEmpty(),
      ),
    ),
  };
}

/** `@handle` becomes selective CPS before anything reaches gpufuck. */
function lowerHandle(
  argument: Expr,
  scope: Scope,
  lowering: Lowering,
  span: Span,
): SurfaceExpression {
  if (argument.tag !== "tuple" || argument.elements.length !== 3) {
    return unsupported(
      "`@handle` without `(effect, computation, handler)`",
      span,
    );
  }
  const [effectExpr, computation, handlerExpr] = argument.elements;

  if (effectExpr.tag !== "var") {
    return unsupported("a `@handle` whose effect is not a name", span);
  }
  const effect = lookupValue(scope.values, effectExpr.name);
  if (effect === undefined || effect.tag !== "effect") {
    return unsupported("a `@handle` whose effect is not compile-time", span);
  }
  if (effect.host) {
    return unsupported("handling a host effect inside blot", span);
  }
  const handler = handlerExpr.tag === "shape"
    ? handlerExpr
    : handlerExpr.tag === "var"
    ? resolveLiteral(scope, handlerExpr.name)
    : null;
  if (handler === null || handler.tag !== "shape") {
    return unsupported(
      "a handler whose clauses are not written as a shape in this module",
      span,
    );
  }

  let returnClause: RuntimeLambda | null = null;
  const clauses = new Map<string, RuntimeLambda>();
  for (const member of handler.members) {
    if (member.tag !== "field") {
      return unsupported("a spread in a handler", span);
    }
    if (member.name === "return") {
      returnClause = specializableLambda(member.value, scope);
      if (returnClause === null) {
        return unsupported(
          "a handler return clause that is not a function",
          span,
        );
      }
      continue;
    }
    const clause = specializableLambda(member.value, scope);
    if (clause === null) {
      return unsupported(
        `a handler clause \`.${member.name}\` that is not a function`,
        span,
      );
    }
    clauses.set(member.name, clause);
  }

  const thunk = handledLambda(computation, scope);
  if (thunk === null) {
    return unsupported(
      "a `@handle` whose computation is not a lambda written in this module",
      span,
    );
  }
  if (
    thunk.expression.parameter.tag !== "unit" &&
    thunk.expression.parameter.tag !== "wildcard"
  ) {
    return unsupported("a handled computation that takes an argument", span);
  }

  const transformedScope = childScope(thunk.environment);
  const clauseNames = new Map<string, string>();
  for (const [operation, clause] of clauses) {
    const name = lowering.fresh(`handler$${operation}`);
    clauseNames.set(operation, name);
    transformedScope.runtimeLambdas.set(name, {
      expression: clause.expression,
      environment: snapshotScope(clause.environment),
    });
  }
  let returnClauseName: string | null = null;
  if (returnClause !== null) {
    returnClauseName = lowering.fresh("handler$return");
    transformedScope.runtimeLambdas.set(returnClauseName, {
      expression: returnClause.expression,
      environment: snapshotScope(returnClause.environment),
    });
  }

  const cps = (
    expr: Expr,
    activeScope: Scope,
    continuation: (value: Expr) => Expr,
  ): Expr => {
    if (expr.tag === "apply") {
      const performed = flatten(expr);
      if (performed.callee.tag === "field" && performed.args.length === 1) {
        const performedEffect = comptimeEffect(performed.callee, activeScope);
        if (performedEffect !== null && performedEffect.id === effect.id) {
          const clauseName = clauseNames.get(performed.callee.name);
          if (clauseName === undefined) {
            fail(
              "BLOT_TYPE_ERROR",
              `Handler for \`${effect.name}\` has no \`.${performed.callee.name}\` clause.`,
              expr.span,
            );
          }
          return cps(performed.args[0], activeScope, (operationArgument) => {
            const resumed = lowering.fresh("resumed");
            const resume: Expr = {
              tag: "lambda",
              parameter: {
                tag: "name",
                name: resumed,
                qualifier: "affine",
                span: expr.span,
              },
              body: continuation({
                tag: "var",
                name: resumed,
                span: expr.span,
              }),
              span: expr.span,
            };
            return {
              tag: "apply",
              fn: {
                tag: "var",
                name: clauseName,
                span: expr.span,
              },
              arg: {
                tag: "tuple",
                elements: [operationArgument, resume],
                span: expr.span,
              },
              span: expr.span,
            };
          });
        }
      }

      const specialized = handledLambda(expr.fn, activeScope);
      if (
        specialized !== null && lambdaMayPerform(specialized, effect, lowering)
      ) {
        return cps(expr.arg, activeScope, (argument) => {
          const calleeScope = childScope(specialized.environment);
          const continuationName = lowering.fresh("handler$continuation");
          const resumed = lowering.fresh("handler$result");
          const continued = continuation({
            tag: "var",
            name: resumed,
            span: expr.span,
          });
          calleeScope.runtimeLambdas.set(continuationName, {
            expression: {
              tag: "lambda",
              parameter: {
                tag: "name",
                name: resumed,
                qualifier: "none",
                span: expr.span,
              },
              body: continued,
              span: expr.span,
            },
            environment: snapshotScope(activeScope),
          });
          const body = cps(
            specialized.expression.body,
            calleeScope,
            (value) => ({
              tag: "apply",
              fn: {
                tag: "var",
                name: continuationName,
                span: expr.span,
              },
              arg: value,
              span: expr.span,
            }),
          );
          const calleeName = lowering.fresh("handler$callee");
          activeScope.runtimeLambdas.set(calleeName, {
            expression: { ...specialized.expression, body },
            environment: calleeScope,
          });
          return {
            tag: "apply",
            fn: { tag: "var", name: calleeName, span: expr.span },
            arg: argument,
            span: expr.span,
          };
        });
      }

      return cps(
        expr.fn,
        activeScope,
        (fn) =>
          cps(
            expr.arg,
            activeScope,
            (arg) => continuation({ tag: "apply", fn, arg, span: expr.span }),
          ),
      );
    }

    if (expr.tag === "field") {
      return cps(
        expr.target,
        activeScope,
        (target) => continuation({ ...expr, target }),
      );
    }

    if (expr.tag === "tuple") {
      const elements: Expr[] = [];
      const sequence = (index: number): Expr => {
        if (index === expr.elements.length) {
          return continuation({ ...expr, elements });
        }
        return cps(expr.elements[index], activeScope, (element) => {
          elements.push(element);
          return sequence(index + 1);
        });
      };
      return sequence(0);
    }

    if (expr.tag === "array") {
      const elements: ArrayElement[] = [];
      const sequence = (index: number): Expr => {
        if (index === expr.elements.length) {
          return continuation({ ...expr, elements });
        }
        const element = expr.elements[index];
        return cps(element.value, activeScope, (value) => {
          elements.push({ spread: element.spread, value });
          return sequence(index + 1);
        });
      };
      return sequence(0);
    }

    if (expr.tag === "shape") {
      const members: ShapeMember[] = [];
      const sequence = (index: number): Expr => {
        if (index === expr.members.length) {
          return continuation({ ...expr, members });
        }
        const member = expr.members[index];
        return cps(member.value, activeScope, (value) => {
          if (member.tag === "field") {
            members.push({ tag: "field", name: member.name, value });
          } else {
            members.push({ tag: "spread", value });
          }
          return sequence(index + 1);
        });
      };
      return sequence(0);
    }

    if (expr.tag === "if") {
      const branch = (index: number): Expr | null => {
        if (index === expr.branches.length) {
          if (expr.fallback === null) return null;
          return cps(expr.fallback, activeScope, continuation);
        }
        const current = expr.branches[index];
        return cps(current.condition, activeScope, (condition) => ({
          tag: "if",
          branches: [{
            condition,
            consequence: cps(current.consequence, activeScope, continuation),
          }],
          fallback: branch(index + 1),
          span: expr.span,
        }));
      };
      const transformed = branch(0);
      if (transformed === null) {
        fail(
          "BLOT_TYPE_ERROR",
          "A handled conditional must have at least one branch.",
          expr.span,
        );
      }
      return transformed;
    }

    if (expr.tag === "case") {
      return cps(expr.target, activeScope, (target) => ({
        ...expr,
        target,
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: cps(arm.body, activeScope, continuation),
        })),
      }));
    }

    if (expr.tag === "block") {
      const sequence = (index: number): Expr => {
        if (index === expr.declarations.length) {
          return cps(expr.result, activeScope, continuation);
        }
        const declaration = expr.declarations[index];
        if (declaration.tag === "binding" && declaration.kind === "sig") {
          return sequence(index + 1);
        }
        return cps(declaration.value, activeScope, (value) => {
          const rewritten = { ...declaration, value } as Decl;
          return {
            tag: "block",
            declarations: [rewritten],
            result: sequence(index + 1),
            resultEffects: "ambient",
            span: expr.span,
          };
        });
      };
      return sequence(0);
    }

    return continuation(expr);
  };

  const transformed = cps(thunk.expression.body, transformedScope, (value) => {
    if (returnClauseName === null) return value;
    return {
      tag: "apply",
      fn: { tag: "var", name: returnClauseName, span },
      arg: value,
      span,
    };
  });
  return lower(transformed, transformedScope, lowering);
}

/**
 * An imported module, inlined.
 *
 * A module is a function from its input record to its export record, resolved
 * while compiling. Its body is ordinary blot, so lowering it is lowering a
 * block — the import boundary exists for authority, not for code generation.
 */
function lowerImport(
  spine: { callee: Expr; args: Expr[] },
  scope: Scope,
  lowering: Lowering,
  span: Span,
): SurfaceExpression {
  const specifier = spine.args[0];
  if (specifier.tag !== "text") {
    return unsupported("an `@import` whose path is not a literal", span);
  }
  const dependency = lowering.facts.modules.get(specifier);
  if (dependency === undefined) {
    return unsupported(`the import \`${specifier.value}\``, span);
  }
  if (spine.args.length === 1) {
    return unsupported(
      `\`@import "${specifier.value}"\` used without calling it — a module is a function, and its exports are what calling it produces`,
      span,
    );
  }

  const inner = childScope(scope, dependency.values);
  const parameter = dependency.module.parameter;
  const wrapper = parameter === null
    ? null
    : bind(parameter, lower(spine.args[1], scope, lowering), inner, lowering);

  const body = lowerBlock(
    dependency.module.declarations,
    dependency.module.result,
    dependency.module.resultEffects,
    inner,
    lowering,
  );
  return wrapper === null ? body : wrapper(body);
}

function flatten(expr: Expr): { callee: Expr; args: Expr[] } {
  const args: Expr[] = [];
  let current = expr;
  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.fn;
  }
  return { callee: current, args };
}

function unsupported(what: string, span: Span): never {
  fail(
    "BLOT_UNSUPPORTED_LOWERING",
    `${what} is not lowered to Wasm yet.`,
    span,
  );
}
