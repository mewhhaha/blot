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
  type HostCapabilityDeclaration,
  type HostDefinitionBinding,
  HostTypes,
  surface,
  type SurfaceDefinition,
  type SurfaceExpression,
  type SurfaceTypeDeclaration,
  type TypeSchema,
} from "gpufuck";
import type { Expr, Module, Pattern, Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import type { GrantSignature, VariantCase } from "../check/infer.ts";
import type { SimpleType } from "../check/type.ts";
import {
  type Env as ValueEnv,
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
  /** What each `open` brought into scope, so an inlined module keeps its own. */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  readonly shapes: ReadonlyMap<Expr, readonly string[]>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  /** Dependencies, so an import can be inlined rather than left opaque. */
  readonly modules: ReadonlyMap<string, { readonly module: Module }>;
  /** The field set of the value a shape pattern destructures. */
  readonly patternShapes: ReadonlyMap<Pattern, readonly string[]>;
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
}

const ENTRY = "main";

class Lowering {
  readonly nominals = new Map<string, Nominal>();
  readonly sums = new Map<string, Sum>();
  readonly definitions: SurfaceDefinition[] = [];
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

  constructor(readonly facts: Facts, values: ValueEnv) {
    this.declared = declaredUnions(values);
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
    const key = sorted.map((entry) => entry.name).join(" ");
    const existing = this.sums.get(key);
    if (existing !== undefined) return existing;
    const sum: Sum = {
      name: `Sum_${sorted.map((entry) => entry.name).join("_")}`,
      cases: sorted,
    };
    this.sums.set(key, sum);
    return sum;
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
    const key = [...fields].join(" ");
    const existing = this.nominals.get(key);
    if (existing !== undefined) return existing;
    const label = fields.length === 0
      ? "Empty"
      : fields.every((name) => /^\d+$/.test(name))
      ? `Tuple${fields.length}`
      : `Shape_${fields.join("_")}`;
    const nominal: Nominal = { name: label, fields };
    this.nominals.set(key, nominal);
    return nominal;
  }

  declarations(): SurfaceTypeDeclaration[] {
    const sums: SurfaceTypeDeclaration[] = [...this.sums.values()].map((
      sum,
    ) => ({
      name: sum.name,
      // One parameter per constructor that carries a payload, so `#Ready` and
      // `#Failed Text` can live in one union without agreeing on a type.
      parameters: sum.cases.map((_, index) => `p${index}`),
      constructors: sum.cases.map((entry, index) => ({
        name: constructorName(sum, entry.name),
        fields: entry.payload
          ? [{
            name: "payload",
            type: { kind: "parameter", name: `p${index}` } satisfies TypeSchema,
          }]
          : [],
      })),
    }));
    return [
      ...sums,
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

interface Scope {
  readonly names: Map<string, string>;
  /**
   * Bindings whose value is a shape written right there.
   *
   * A handler and the computation it wraps both have to be statically known to
   * be specialized, and binding one to a name does not make it less known —
   * `lowerHandle` needs their syntax, not the closures the evaluator would
   * build, so the expression is what is remembered.
   */
  readonly literals: Map<string, Expr>;
  readonly parent: Scope | null;
  /**
   * The compile-time bindings visible here — the prelude, and whatever a
   * closure captured. A name that is not a local is looked up here and
   * specialized, which is how `+` reaches Wasm at all: `Num.add` is a prelude
   * closure, not a primitive, and nothing would resolve it otherwise.
   */
  readonly values: ValueEnv;
  /** The module parameter's name, whose fields are granted capabilities. */
  granted?: string;
}

function childScope(parent: Scope | null, values?: ValueEnv): Scope {
  return {
    names: new Map(),
    literals: new Map(),
    parent,
    values: values ?? parent!.values,
    granted: parent?.granted,
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
    value.tag === "unbounded" || value.tag === "extended";
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

function resolve(scope: Scope, name: string): string | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const found = current.names.get(name);
    if (found !== undefined) return found;
    current = current.parent;
  }
  return null;
}

/** Primitives with a direct Core operator. Everything else is unsupported. */
const BINARY: ReadonlyMap<string, BinaryOperator> = new Map([
  ["@int.add", BinaryOperator.Add],
  ["@int.sub", BinaryOperator.Subtract],
  ["@int.mul", BinaryOperator.Multiply],
  ["@int.div", BinaryOperator.Divide],
  ["@int.rem", BinaryOperator.Remainder],
]);

export function lowerModule(
  module: Module,
  facts: Facts,
  values: ValueEnv,
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

  const body = lowerBlock(module.declarations, module.result, scope, lowering);
  lowering.definitions.push({
    name: ENTRY,
    parameters: [],
    annotation: null,
    body,
  });

  return {
    definitions: lowering.definitions,
    types: lowering.declarations(),
    entry: ENTRY,
    capabilities: [...lowering.capabilities.values()],
    hostDefinitions: lowering.hostDefinitions,
    shapes: new Map(
      [...lowering.nominals.values()].map((nominal) =>
        [nominal.name, nominal.fields] as const
      ),
    ),
  };
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
  const parameter = boundaryType(signature.domain, span);
  const result = boundaryType(signature.codomain, span);
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
    parameter: { name: "argument", type: boundaryType(signature.domain, span) },
    result: boundaryType(signature.codomain, span),
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
  unconstrained: TypeSchema | null = null,
  seen = new Set<number>(),
): TypeSchema {
  if (type.tag === "unit") return { kind: "unit" };
  if (type.tag === "range") {
    return type.domain === "int" ? { kind: "integer" } : HostTypes.text;
  }
  if (type.tag === "variant") {
    const names = [...type.cases.keys()].sort();
    if (names.length > 0 && names.every((n) => n === "True" || n === "False")) {
      return { kind: "boolean" };
    }
  }
  if (type.tag === "var" && !seen.has(type.id)) {
    seen.add(type.id);
    for (const bound of [...type.lower, ...type.upper]) {
      try {
        return schemaOf(bound, operation, span, unconstrained, seen);
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

  const parameter = schemaOf(signature.parameter, operation, span);
  const result = schemaOf(signature.result, operation, span, { kind: "unit" });
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
    effects: effectSet(TEXT_CAPABILITY),
    parameter,
    result,
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

/**
 * A blot type value, as a boundary type.
 *
 * Only the scalars and text cross today. A shape would need a nominal on both
 * sides of the boundary, and inventing one silently would make the import's
 * contract a guess.
 */
function boundaryType(value: Value, span: Span): TypeSchema {
  if (value.tag === "unit") return { kind: "unit" };
  if (value.tag === "range") {
    const domain = value.domain ??
      (value.low.tag === "int" || value.high.tag === "int" ? "int" : "text");
    if (domain === "int") return { kind: "integer" };
    return HostTypes.text;
  }
  fail(
    "BLOT_UNSUPPORTED_LOWERING",
    "Only integers, text, and `()` cross the host boundary today.",
    span,
  );
}

/**
 * A block, as nested Core forms.
 *
 * Each declaration contributes a wrapper around everything after it, because a
 * destructuring binding is a `case` and not a `let` — Core has no pattern
 * binder, so `let { .x; } = p;` becomes the match it always meant.
 */
function lowerBlock(
  declarations: Module["declarations"],
  result: Expr,
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const inner = childScope(scope);
  const wrappers: ((body: SurfaceExpression) => SurfaceExpression)[] = [];

  for (const declaration of declarations) {
    // A loop lowers to a recursive Core function over a tuple of the names its
    // body rebinds. That is not written yet, and emitting something that only
    // happens to work would be worse than saying so: the interpreter, the GPU
    // evaluator, and the Wasm are required to agree.
    if (declaration.tag === "for") {
      return unsupported(
        "a `for` loop — it runs and type checks, but the recursive Core function it lowers to is not written",
        declaration.span,
      );
    }
    // `open` emits nothing — a use of a name it brought in specializes to the
    // compile-time value, exactly as a `const` does — but the names still have
    // to be *in* this scope. An imported module is inlined into the importer's
    // scope, so its own `open` has to install them here rather than relying on
    // whatever the importer happened to open.
    if (declaration.tag === "open") {
      const opened = lowering.facts.opens.get(declaration.value);
      if (opened === undefined) {
        return unsupported("an `open` the checker did not record", declaration.span);
      }
      for (const [name, value] of opened) inner.values.names.set(name, value);
      continue;
    }
    if (declaration.tag === "shadow") {
      // A binding whose value has no runtime representation emits nothing, the
      // same rule that makes `const Message = #Ready | …` disappear. Shadowing
      // an effect or a type is rebinding a compile-time name, not code.
      if (compileTimeOnly(lookupValue(inner.values, declaration.name))) {
        continue;
      }
      const value = lower(declaration.value, inner, lowering);
      const name = lowering.fresh(declaration.name);
      inner.names.set(declaration.name, name);
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

    // A `const` the checker evaluated is compile time and emits nothing: a use
    // specializes it, so one holding a type disappears and one holding a
    // closure becomes a definition only if something calls it.
    //
    // A `const` inside a function body is a different animal. `const rest =
    // resume ();` depends on the parameter, so there is no compile-time value
    // to specialize and it has to become an ordinary binding.
    if (
      declaration.kind === "const" && declaration.pattern.tag === "name" &&
      lookupValue(inner.values, declaration.pattern.name) !== undefined
    ) {
      continue;
    }
    if (declaration.kind === "sig") continue;

    // `rec` becomes a *local* recursive binding. Lifting it to a top-level
    // definition would strand whatever the lambda captured.
    if (
      declaration.value.tag === "rec" &&
      declaration.value.lambda.tag === "lambda" &&
      declaration.pattern.tag === "name"
    ) {
      wrappers.push(
        recursiveBinding(
          declaration.pattern.name,
          declaration.value.lambda,
          inner,
          lowering,
        ),
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
    const value = lower(declaration.value, inner, lowering);
    wrappers.push(bind(declaration.pattern, value, inner, lowering));
  }

  let body = lower(result, inner, lowering);
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    body = wrappers[index](body);
  }
  return body;
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
    scope.names.set(pattern.name, name);
    return (body) => surface.let(name, value, body);
  }

  if (pattern.tag === "wildcard" || pattern.tag === "unit") {
    return (body) => surface.let(lowering.fresh("_"), value, body);
  }

  if (pattern.tag === "array") {
    // An array is a `Store`, which has no constructor to match on, so the
    // pattern reads each index instead. The length is what the pattern says;
    // a shorter store traps on the read, which is the same failure the
    // interpreter reports.
    const store = lowering.fresh("store");
    const reads = pattern.elements.map((element, index) => {
      if (element.tag === "wildcard") return null;
      if (element.tag !== "name") {
        return unsupported(
          "a nested pattern in an array binding",
          element.span,
        ) as never;
      }
      const bound = lowering.fresh(element.name);
      scope.names.set(element.name, bound);
      return { bound, index };
    });
    return (body) => {
      let inner = body;
      for (let position = reads.length - 1; position >= 0; position -= 1) {
        const read = reads[position];
        if (read === null) continue;
        inner = surface.let(
          read.bound,
          at.storeRead(at.name(store), at.integer(read.index)),
          inner,
        );
      }
      return surface.let(store, value, inner);
    };
  }

  if (pattern.tag === "tuple" || pattern.tag === "shape") {
    // The *value's* field set, not the pattern's: width subtyping means
    // `let { .x; } = point;` names fewer than arrive, and Core records are
    // nominal.
    const names = pattern.tag === "tuple"
      ? pattern.elements.map((_, index) => String(index))
      : lowering.facts.patternShapes.get(pattern) ??
        pattern.fields.map((field) => field.name);
    const nominal = lowering.nominal(names);
    const parts = pattern.tag === "tuple"
      ? pattern.elements.map((element, index) => ({
        name: String(index),
        element,
      }))
      : pattern.fields.map((field) => ({
        name: field.name,
        element: field.pattern,
      }));

    const binders = nominal.fields.map((name) => {
      const part = parts.find((entry) => entry.name === name);
      if (part === undefined) return lowering.fresh("_");
      if (part.element.tag === "wildcard") return lowering.fresh("_");
      if (part.element.tag !== "name") {
        return unsupported(
          "a nested pattern in a binding",
          part.element.span,
        ) as never;
      }
      const bound = lowering.fresh(part.element.name);
      scope.names.set(part.element.name, bound);
      return bound;
    });

    return (body) =>
      at.case(value, [{ constructor: nominal.name, binders, body }]);
  }

  return unsupported(`a ${pattern.tag} pattern in a binding`, pattern.span);
}

/**
 * A `rec` binding, as a local recursive group.
 *
 * Core has `let-rec`, which is what this needs: the lambda may capture names
 * from the block it is written in, and only a local binding keeps those in
 * scope. Lifting it to a top-level definition stranded them — `fold`'s inner
 * `go` closes over `values`, and a definition has no enclosing scope for that
 * to come from. The surface builder has no helper for this node, so it is a
 * literal.
 */
function recursiveBinding(
  name: string,
  lambda: Expr & { tag: "lambda" },
  scope: Scope,
  lowering: Lowering,
): (body: SurfaceExpression) => SurfaceExpression {
  const binding = lowering.fresh(name);
  scope.names.set(name, binding);
  const inner = childScope(scope);
  const parameter = lowering.fresh("arg");
  const wrap = bindParameter(
    lambda.parameter,
    parameter,
    inner,
    lowering,
    lambda.span,
  );
  const value = wrap(lambda.body);
  const span = { startByte: lambda.span.start, endByte: lambda.span.end };
  return (body) => ({
    kind: "let-rec-group",
    bindings: [{ name: binding, parameters: [parameter], body: value, span }],
    body,
    span,
  });
}

function lower(
  expr: Expr,
  scope: Scope,
  lowering: Lowering,
): SurfaceExpression {
  const at = surface.at({ startByte: expr.span.start, endByte: expr.span.end });

  switch (expr.tag) {
    case "int": {
      // gpufuck's `integer` is a signed 32-bit Core literal. blot's comptime
      // integers are arbitrary precision, so the narrowing is checked rather
      // than assumed — this is exactly the width obligation a `sig` of `I32`
      // would have carried.
      if (expr.value < -2147483648n || expr.value > 2147483647n) {
        return at.signedInteger64(expr.value);
      }
      return at.integer(Number(expr.value));
    }

    case "text":
      return at.text(expr.value);

    case "unit":
      return at.integer(0);

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
      // Not a local, so it is a compile-time binding: specialize it.
      const value = lookupValue(scope.values, expr.name);
      if (value === undefined) {
        fail("BLOT_UNBOUND", `\`${expr.name}\` is not in scope.`, expr.span);
      }
      return lowerValue(value, expr.name, expr.span, lowering);
    }

    case "lambda": {
      const inner = childScope(scope);
      const parameter = lowering.fresh("arg");
      const body = bindParameter(
        expr.parameter,
        parameter,
        inner,
        lowering,
        expr.span,
      );
      return at.lambda([parameter], body(expr.body));
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
      const written: { name: string; value: Expr }[] = [];
      const spreads: Expr[] = [];
      for (const member of expr.members) {
        if (member.tag === "field") {
          written.push({ name: member.name, value: member.value });
          continue;
        }
        spreads.push(member.value);
      }

      if (spreads.length === 0) {
        const nominal = lowering.nominal(written.map((field) => field.name));
        return at.apply(
          at.name(nominal.name),
          ...nominal.fields.map((name) => {
            const found = written.find((field) => field.name === name);
            if (found === undefined) {
              fail("BLOT_NO_FIELD", `No field \`.${name}\`.`, expr.span);
            }
            return lower(found.value, scope, lowering);
          }),
        );
      }

      if (spreads.length > 1) {
        return unsupported("more than one spread in one shape", expr.span);
      }

      // One destructure, not one projection per field: `{ ...origin; .x = 20; }`
      // takes `origin` apart once and rebuilds, which is both the shorter Core
      // and the shape a reuse pass could later write in place.
      const source = spreads[0];
      const carried = lowering.facts.shapes.get(source);
      if (carried === undefined) {
        return unsupported(
          "spreading a shape inference could not pin down",
          expr.span,
        );
      }
      const from = lowering.nominal(carried);
      const binders = from.fields.map((name) => lowering.fresh(name));
      const names = [...new Set([...carried, ...written.map((f) => f.name)])];
      const target = lowering.nominal(names);

      return at.case(lower(source, scope, lowering), [{
        constructor: from.name,
        binders,
        body: at.apply(
          at.name(target.name),
          ...target.fields.map((name) => {
            // A written member wins over the spread it overrides.
            const found = written.find((field) => field.name === name);
            if (found !== undefined) return lower(found.value, scope, lowering);
            const index = from.fields.indexOf(name);
            return at.name(binders[index]);
          }),
        ),
      }]);
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
      const names = lowering.facts.shapes.get(expr);
      if (names === undefined) {
        return unsupported(
          `projecting \`.${expr.name}\` from a value whose shape inference could not pin down`,
          expr.span,
        );
      }
      const nominal = lowering.nominal(names);
      const binders = names.map((name) => lowering.fresh(name));
      const index = names.indexOf(expr.name);
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
        ? at.runtimeFault("no branch matched")
        : lower(expr.fallback, scope, lowering);
      for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
        const branch = expr.branches[index];
        result = at.if(
          lower(branch.condition, scope, lowering),
          lower(branch.consequence, scope, lowering),
          result,
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
      return lowerBlock(expr.declarations, expr.result, scope, lowering);

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
  const guarded: { name: string; literal: Pattern; body: Expr }[] = [];
  for (const arm of expr.arms) {
    if (arm.pattern.tag !== "constructor") continue;
    const payload = arm.pattern.payload;
    if (payload === null) continue;
    if (payload.tag !== "int" && payload.tag !== "text") continue;
    guarded.push({ name: arm.pattern.name, literal: payload, body: arm.body });
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
        payload !== null && (payload.tag === "int" || payload.tag === "text")
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
          inner.names.set(payload.name, binder);
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
        const literal = test.literal;
        body = at.if(
          at.binary(
            BinaryOperator.Equal,
            at.name(binders[0]),
            literal.tag === "int"
              ? at.integer(Number(literal.value))
              : at.text(literal.tag === "text" ? literal.value : ""),
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
        inner.names.set(arm.pattern.name, binder);
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
  const tests: { literal: Pattern; body: SurfaceExpression }[] = [];

  for (const arm of expr.arms) {
    const inner = childScope(scope);
    const pattern = arm.pattern;
    if (pattern.tag === "int" || pattern.tag === "text") {
      tests.push({ literal: pattern, body: lower(arm.body, inner, lowering) });
      continue;
    }
    if (arm.pattern.tag === "wildcard" || arm.pattern.tag === "name") {
      if (arm.pattern.tag === "name") {
        inner.names.set(arm.pattern.name, scrutinee);
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

  let body = fallback ??
    at.runtimeFault("no arm matched");
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    const test = tests[index];
    const value = test.literal;
    const literal = value.tag === "int"
      ? at.integer(Number(value.value))
      : at.text(value.tag === "text" ? value.value : "");
    body = at.if(
      at.binary(BinaryOperator.Equal, at.name(scrutinee), literal),
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
 * Folds a chain of projections off a compile-time shape.
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
    if (value === undefined || value.tag !== "shape") return null;
    value = value.fields.get(name);
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
      return value.value < -2147483648n || value.value > 2147483647n
        ? at.signedInteger64(value.value)
        : at.integer(Number(value.value));
    case "text":
      return at.text(value.value);
    case "unit":
      return at.integer(0);
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

    case "closure": {
      const existing = lowering.hoisted.get(value);
      if (existing !== undefined) return at.name(existing);
      const name = lowering.fresh(hint);
      lowering.hoisted.set(value, name);

      const scope = childScope(null, value.env);
      // `rec` names the closure itself, so the definition has to be in scope
      // inside its own body.
      if (value.self !== null) scope.names.set(value.self, name);
      const parameter = lowering.fresh("arg");
      const body = bindParameter(
        value.parameter,
        parameter,
        scope,
        lowering,
        span,
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
  span: Span,
): (body: Expr) => SurfaceExpression {
  const at = surface.at({ startByte: span.start, endByte: span.end });

  if (pattern.tag === "name") {
    scope.names.set(pattern.name, parameter);
    return (body) => lower(body, scope, lowering);
  }
  if (pattern.tag === "wildcard" || pattern.tag === "unit") {
    return (body) => lower(body, scope, lowering);
  }
  if (pattern.tag === "tuple") {
    const nominal = lowering.nominal(
      pattern.elements.map((_, index) => String(index)),
    );
    const binders = pattern.elements.map((element) => {
      if (element.tag === "wildcard") return lowering.fresh("_");
      if (element.tag !== "name") {
        return unsupported("a nested tuple parameter", element.span) as never;
      }
      const bound = lowering.fresh(element.name);
      scope.names.set(element.name, bound);
      return bound;
    });
    return (body) =>
      at.case(at.name(parameter), [{
        constructor: nominal.name,
        binders,
        body: lower(body, scope, lowering),
      }]);
  }
  return unsupported(`a ${pattern.tag} parameter`, pattern.span);
}

function lowerApply(
  expr: Expr & { tag: "apply" },
  scope: Scope,
  lowering: Lowering,
  at: typeof surface,
): SurfaceExpression {
  // A primitive with a Core operator becomes that operator rather than a call:
  // `@int.add a b` is `a + b`, not an application of a function that does not
  // exist at this level.
  const spine = flatten(expr);

  // `#Busy 41` builds a value; typing it through application would make the
  // constructor a function it is not.
  if (spine.callee.tag === "tag" && spine.args.length === 1) {
    if (spine.callee.name === "True" || spine.callee.name === "False") {
      return unsupported("a boolean constructor with a payload", expr.span);
    }
    const sum = lowering.sumFor(spine.callee.name, true, expr.span);
    return at.apply(
      at.name(constructorName(sum, spine.callee.name)),
      lower(spine.args[0], scope, lowering),
    );
  }

  if (spine.callee.tag === "intrinsic") {
    const operator = BINARY.get(spine.callee.name);
    if (operator !== undefined && spine.args.length === 2) {
      return at.binary(
        operator,
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
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
            at.binary(BinaryOperator.Less, at.name(left), at.name(right)),
            tag("Less"),
            at.if(
              at.binary(BinaryOperator.Equal, at.name(left), at.name(right)),
              tag("Equal"),
              tag("Greater"),
            ),
          ),
        ),
      );
    }
    if (spine.callee.name === "@int.neg" && spine.args.length === 1) {
      return at.binary(
        BinaryOperator.Subtract,
        at.integer(0),
        lower(spine.args[0], scope, lowering),
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
            { kind: "integer" },
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
            { kind: "integer" },
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
        { kind: "integer" },
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
          at.binary(BinaryOperator.Less, at.name(sign), at.integer(0)),
          tag("Less"),
          at.if(
            at.binary(BinaryOperator.Equal, at.name(sign), at.integer(0)),
            tag("Equal"),
            tag("Greater"),
          ),
        ),
      );
    }
    if (spine.callee.name === "@array.len" && spine.args.length === 1) {
      return at.storeLength(lower(spine.args[0], scope, lowering));
    }
    if (spine.callee.name === "@array.get" && spine.args.length === 2) {
      return at.storeRead(
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
      );
    }
    if (spine.callee.name === "@array.set" && spine.args.length === 3) {
      return at.storeWrite(
        lower(spine.args[0], scope, lowering),
        lower(spine.args[1], scope, lowering),
        lower(spine.args[2], scope, lowering),
      );
    }
    // Growing by one and filling the new slot with the value is an append.
    if (spine.callee.name === "@array.push" && spine.args.length === 2) {
      const store = lowering.fresh("store");
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
        ),
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
    ...spine.args.map((argument) => lower(argument, scope, lowering)),
  );
}

/**
 * `@handle (Effect, computation, handler)`.
 *
 * gpufuck's handlers are lexical evidence: `withEffectHandler` replaces an
 * operation inside a body, and a *pure* replacement discharges the label. That
 * covers exactly the tail-resumptive handlers — the ones whose clause ends in
 * `resume e`, which are an operation replacement and nothing more.
 *
 * An aborting or multi-shot handler is a different thing. It needs a delimited
 * continuation, which Core does not have, and pretending a closed function is
 * equivalent would be wrong rather than merely incomplete.
 */
function lowerHandle(
  argument: Expr,
  scope: Scope,
  lowering: Lowering,
  span: Span,
): SurfaceExpression {
  const at = surface.at({ startByte: span.start, endByte: span.end });
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
    return unsupported(
      "handling a host effect, whose operations are imports the host answers",
      span,
    );
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

  let returnClause: Expr | null = null;
  const clauses: { operation: string; value: Expr }[] = [];
  for (const member of handler.members) {
    if (member.tag !== "field") {
      return unsupported("a spread in a handler", span);
    }
    if (member.name === "return") {
      returnClause = member.value;
      continue;
    }
    clauses.push({ operation: member.name, value: member.value });
  }

  // Core's evidence is *lexical*: a replacement reaches the calls written
  // inside its body. A computation passed as a closure has already resolved its
  // operations against the global definitions, so handling it means inlining
  // it — which is what handler specialization always was.
  const thunk = computation.tag === "lambda"
    ? computation
    : computation.tag === "var"
    ? resolveLiteral(scope, computation.name)
    : null;
  if (thunk === null || thunk.tag !== "lambda") {
    return unsupported(
      "a `@handle` whose computation is not a lambda written in this module",
      span,
    );
  }
  if (thunk.parameter.tag !== "unit" && thunk.parameter.tag !== "wildcard") {
    return unsupported("a handled computation that takes an argument", span);
  }
  let body = lower(thunk.body, childScope(scope), lowering);
  if (returnClause !== null) {
    body = at.apply(lower(returnClause, scope, lowering), body);
  }

  for (const clause of clauses) {
    const replacement = pureReplacement(clause.value, span);
    body = at.withEffectHandler(
      effectOperation(effect, clause.operation, lowering, span),
      lower(replacement, scope, lowering),
      body,
    );
  }
  return body;
}

/**
 * A tail-resumptive clause, as the pure operation that replaces it.
 *
 * `(m, ?resume) => resume e` becomes `m => e`. Resuming in tail position is
 * exactly "this operation computes `e`", which is what an evidence replacement
 * can express; resuming anywhere else needs the rest of the computation as a
 * value, and that is a continuation.
 */
function pureReplacement(clause: Expr, span: Span): Expr {
  if (clause.tag !== "lambda" || clause.parameter.tag !== "tuple") {
    return unsupported(
      "a handler clause that is not `(argument, ?resume) => …`",
      span,
    );
  }
  const [parameter, resume] = clause.parameter.elements;
  if (resume === undefined || resume.tag !== "name") {
    return unsupported("a handler clause without a named `resume`", span);
  }
  const rewritten = tailResume(clause.body, resume.name);
  if (rewritten === null) {
    return unsupported(
      `a handler that does not resume in tail position — aborting and multi-shot handlers need a delimited continuation, which Core does not have`,
      clause.body.span,
    );
  }
  if (mentions(rewritten, resume.name)) {
    return unsupported(
      "a handler that uses `resume` outside tail position",
      clause.body.span,
    );
  }
  return { tag: "lambda", parameter, body: rewritten, span: clause.span };
}

/** Replaces `resume e` in tail position with `e`, or reports that there is none. */
function tailResume(body: Expr, resume: string): Expr | null {
  if (
    body.tag === "apply" && body.fn.tag === "var" && body.fn.name === resume
  ) {
    return body.arg;
  }
  if (body.tag === "block") {
    const result = tailResume(body.result, resume);
    if (result === null) return null;
    return { ...body, result };
  }
  if (body.tag === "if") {
    const branches = body.branches.map((branch) => {
      const consequence = tailResume(branch.consequence, resume);
      return consequence === null ? null : { ...branch, consequence };
    });
    if (branches.some((branch) => branch === null)) return null;
    const fallback = body.fallback === null
      ? null
      : tailResume(body.fallback, resume);
    if (body.fallback !== null && fallback === null) return null;
    return { ...body, branches: branches as typeof body.branches, fallback };
  }
  if (body.tag === "case") {
    const arms = body.arms.map((arm) => {
      const rewritten = tailResume(arm.body, resume);
      return rewritten === null ? null : { ...arm, body: rewritten };
    });
    if (arms.some((arm) => arm === null)) return null;
    return { ...body, arms: arms as typeof body.arms };
  }
  return null;
}

function mentions(expr: Expr, name: string): boolean {
  switch (expr.tag) {
    case "var":
      return expr.name === name;
    case "apply":
      return mentions(expr.fn, name) || mentions(expr.arg, name);
    case "field":
      return mentions(expr.target, name);
    case "lambda":
      return mentions(expr.body, name);
    case "rec":
      return mentions(expr.lambda, name);
    case "comptime":
      return mentions(expr.body, name);
    case "tuple":
      return expr.elements.some((element) => mentions(element, name));
    case "array":
      return expr.elements.some((element) => mentions(element.value, name));
    case "shape":
      return expr.members.some((member) => mentions(member.value, name));
    case "if":
      return expr.branches.some((branch) =>
        mentions(branch.condition, name) || mentions(branch.consequence, name)
      ) || (expr.fallback !== null && mentions(expr.fallback, name));
    case "case":
      return mentions(expr.target, name) ||
        expr.arms.some((arm) => mentions(arm.body, name));
    case "block":
      return expr.declarations.some((declaration) =>
        declaration.tag === "for"
          ? mentions(declaration.source, name) ||
            declaration.body.some((inner) =>
              inner.tag !== "for" && mentions(inner.value, name)
            )
          : mentions(declaration.value, name)
      ) || mentions(expr.result, name);
    default:
      return false;
  }
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
  const dependency = lowering.facts.modules.get(specifier.value);
  if (dependency === undefined) {
    return unsupported(`the import \`${specifier.value}\``, span);
  }
  if (spine.args.length === 1) {
    return unsupported(
      `\`@import "${specifier.value}"\` used without calling it — a module is a function, and its exports are what calling it produces`,
      span,
    );
  }

  const inner = childScope(scope);
  const parameter = dependency.module.parameter;
  const wrapper = parameter === null
    ? null
    : bind(parameter, lower(spine.args[1], scope, lowering), inner, lowering);

  const body = lowerBlock(
    dependency.module.declarations,
    dependency.module.result,
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
