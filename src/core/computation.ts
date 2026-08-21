// Typed runtime Core.
//
// Surface blocks put declarations and their result in one AST because that is
// convenient for parsing. Runtime consumers need a stricter boundary: dead
// pure definitions are gone, sequencing is explicit, and every expression has
// the settled type inference assigned to that exact source occurrence.

import {
  FLOAT,
  intLiteral,
  type SimpleType,
  textLiteral,
  union,
  UNIT,
  variant,
} from "../check/type.ts";
import type { Env as ValueEnv, Value } from "../comptime/value.ts";
import { bridge } from "../check/bridge.ts";
import type {
  Decl,
  DeclarationTag,
  Expr,
  Pattern,
  Span,
} from "../syntax/ast.ts";
import { patternNames } from "../syntax/ast.ts";
import { freeNames, liveDeclarations } from "../syntax/live.ts";
import { TyRepBuilder, type TyRepId, type TyRepTable } from "./type_rep.ts";
import type {
  GrantSignature,
  RecordAdaptation,
  Shape,
  VariantCase,
} from "../check/infer.ts";
import type { ArrayIndexProof } from "./proof.ts";

export interface CoreNode {
  readonly id: number;
  readonly type: SimpleType;
  readonly typeRep: TyRepId;
  readonly span: Span;
  /** Type-directed record completion attached at the argument occurrence. */
  readonly adaptation: RecordAdaptation | null;
  /** Erasable bounds evidence for a proof-required intrinsic application. */
  readonly arrayProof: ArrayIndexProof | null;
  /** Settled structural field evidence for this exact occurrence. */
  readonly shape: Shape | null;
  /** Settled constructor evidence for this exact occurrence. */
  readonly variants: readonly VariantCase[] | null;
  /** Whether this exact case is the optional-record completion form. */
  readonly optionalCase: boolean;
  /** Settled host-capability signature for this exact projection. */
  readonly grant: GrantSignature | null;
  /** Progressive Runtime-HIR commitment made at the checked Core boundary. */
  readonly hirState: HirBuilderState;
  /** Provenance only. No Core consumer may recover semantics from this node. */
  readonly origin: Expr;
}

export type HirPendingReason =
  | "structural-fold"
  | "specialization-choice"
  | "open-representation"
  | "ownership-certificate";

export type HirBuilderState =
  | {
    readonly tag: "pending";
    readonly typeRep: TyRepId;
    readonly reason: HirPendingReason;
  }
  | {
    readonly tag: "settled";
    readonly typeRep: TyRepId;
    readonly effects: "pure";
    readonly representation: "structural-type-rep";
    readonly ownership: "certified";
    readonly safety: "not-required" | "proved";
    /** Final residual node consumed without rebuilding source semantics. */
    readonly node: HirSettledNode;
  };

export type HirSettledNode = {
  readonly tag: "static";
  readonly value: Value;
};

export interface HirProgress {
  readonly settled: number;
  readonly pending: Readonly<Record<HirPendingReason, number>>;
}

export type CoreExpression =
  & CoreNode
  & (
    | { readonly tag: "var"; readonly name: string }
    | { readonly tag: "int"; readonly value: bigint }
    | { readonly tag: "float"; readonly value: number }
    | { readonly tag: "text"; readonly value: string }
    | { readonly tag: "unit" }
    | { readonly tag: "intrinsic"; readonly name: string }
    | { readonly tag: "tag"; readonly name: string }
    | {
      readonly tag: "apply";
      readonly fn: CoreExpression;
      readonly arg: CoreExpression;
    }
    | {
      readonly tag: "intrinsic-apply";
      readonly name: string;
      readonly args: readonly CoreExpression[];
    }
    | {
      readonly tag: "import";
      readonly specifier: string;
      readonly args: readonly CoreExpression[];
      readonly dependency: CoreImportDependency;
    }
    | {
      readonly tag: "static-member-apply";
      readonly target: string;
      readonly name: string;
      readonly args: readonly CoreExpression[];
    }
    | {
      readonly tag: "constructor";
      readonly name: string;
      readonly payload: CoreExpression;
    }
    | { readonly tag: "checked"; readonly value: CoreExpression }
    | { readonly tag: "constant"; readonly value: Value }
    | {
      readonly tag: "field";
      readonly target: CoreExpression;
      readonly name: string;
    }
    | {
      readonly tag: "static-member";
      readonly target: string;
      readonly name: string;
    }
    | {
      readonly tag: "lambda";
      readonly parameter: Pattern;
      readonly body: CoreExpression;
      readonly deferred: boolean;
    }
    | {
      readonly tag: "array";
      readonly elements: readonly {
        readonly spread: boolean;
        readonly value: CoreExpression;
      }[];
    }
    | { readonly tag: "tuple"; readonly elements: readonly CoreExpression[] }
    | {
      readonly tag: "shape";
      readonly members: readonly CoreShapeMember[];
    }
    | {
      readonly tag: "if";
      readonly branches: readonly {
        readonly condition: CoreExpression;
        readonly consequence: CoreExpression;
      }[];
      readonly fallback: CoreExpression | null;
    }
    | {
      readonly tag: "case";
      readonly target: CoreExpression;
      readonly arms: readonly {
        readonly pattern: Pattern;
        readonly body: CoreExpression;
      }[];
    }
    | {
      readonly tag: "block";
      readonly computation: CoreComputation;
    }
    | { readonly tag: "rec"; readonly lambda: CoreExpression }
    | { readonly tag: "comptime"; readonly body: CoreExpression }
  );

export type CoreShapeMember =
  | {
    readonly tag: "field";
    readonly name: string;
    readonly value: CoreExpression;
  }
  | { readonly tag: "spread"; readonly value: CoreExpression };

export type CoreDefinition =
  | {
    readonly tag: "binding";
    readonly kind: "let" | "effect" | "const" | "sig";
    readonly tags: readonly DeclarationTag[];
    readonly pattern: Pattern;
    readonly value: CoreExpression;
    readonly span: Span;
    readonly origin: Decl;
  }
  | {
    /** A checked compile-time binding retained for residual Core scope. */
    readonly tag: "static";
    readonly pattern: Pattern;
    readonly value: Value;
    readonly span: Span;
    readonly origin: Decl;
  }
  | {
    readonly tag: "static-shadow";
    readonly name: string;
    readonly value: Value;
    readonly span: Span;
    readonly origin: Decl;
  }
  | {
    readonly tag: "shadow";
    readonly name: string;
    readonly value: CoreExpression;
    readonly span: Span;
    readonly origin: Decl;
  }
  | {
    readonly tag: "open";
    readonly bindings: ReadonlyMap<string, Value>;
    readonly span: Span;
    readonly origin: Decl;
  };

export type CoreStep =
  | { readonly tag: "define"; readonly definition: CoreDefinition }
  | { readonly tag: "bind"; readonly definition: CoreDefinition };

export type CoreResult =
  | { readonly tag: "return"; readonly value: CoreExpression }
  | { readonly tag: "tail"; readonly computation: CoreExpression };

export interface CoreComputation {
  readonly steps: readonly CoreStep[];
  readonly result: CoreResult;
}

export interface TypedCoreModule extends CoreComputation {
  readonly parameter: Pattern | null;
  readonly span: Span;
  readonly resultType: SimpleType;
  readonly typeRepresentations: TyRepTable;
  readonly hirProgress: HirProgress;
  /** Runtime closure bodies retained by static values, already typed as Core. */
  readonly residualClosures: ReadonlyMap<Value, CoreExpression>;
  readonly residualClosureTypes: ReadonlyMap<Value, SimpleType>;
  /** Checked module cores reachable through literal imports, including opens. */
  readonly dependencies: ReadonlySet<TypedCoreModule>;
}

export interface CoreImportDependency {
  readonly core: TypedCoreModule;
  readonly values: ValueEnv;
}

export function coreResultExpression(result: CoreResult): CoreExpression {
  if (result.tag === "return") return result.value;
  return result.computation;
}

export function elaborateModule(
  module: {
    readonly parameter: Pattern | null;
    readonly declarations: readonly Decl[];
    readonly result: Expr;
    readonly resultEffects: "pure" | "ambient";
    readonly span: Span;
  },
  expressionTypes: ReadonlyMap<Expr, SimpleType>,
  resultType: SimpleType,
  ownershipCertified = false,
  comptimeValues: ReadonlyMap<Expr, Value> = new Map(),
  opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>> = new Map(),
  recordAdaptations: ReadonlyMap<Expr, RecordAdaptation> = new Map(),
  arrayProofs: ReadonlyMap<Expr, ArrayIndexProof> = new Map(),
  shapes: ReadonlyMap<Expr, Shape> = new Map(),
  variants: ReadonlyMap<Expr, readonly VariantCase[]> = new Map(),
  optionalCases: ReadonlySet<Expr> = new Set(),
  grants: ReadonlyMap<Expr, GrantSignature> = new Map(),
  modules: ReadonlyMap<Expr, CoreImportDependency> = new Map(),
): TypedCoreModule {
  const elaborator = new Elaborator(
    expressionTypes,
    comptimeValues,
    opens,
    recordAdaptations,
    arrayProofs,
    shapes,
    variants,
    optionalCases,
    grants,
    modules,
    ownershipCertified,
  );
  elaborator.runtimeParameter(module.parameter);
  const computation = elaborator.computation(
    module.declarations,
    module.result,
    module.resultEffects,
    resultType,
  );
  return {
    ...computation,
    parameter: module.parameter,
    span: module.span,
    resultType,
    typeRepresentations: elaborator.typeRepresentations(),
    hirProgress: elaborator.hirProgress(),
    residualClosures: elaborator.residualClosures(),
    residualClosureTypes: elaborator.residualClosureTypes(),
    dependencies: new Set(
      [...modules.values()].map((dependency) => dependency.core),
    ),
  };
}

class Elaborator {
  readonly #expressionTypes: ReadonlyMap<Expr, SimpleType>;
  readonly #comptimeValues: ReadonlyMap<Expr, Value>;
  readonly #opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  readonly #recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>;
  readonly #arrayProofs: ReadonlyMap<Expr, ArrayIndexProof>;
  readonly #shapes: ReadonlyMap<Expr, Shape>;
  readonly #variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  readonly #optionalCases: ReadonlySet<Expr>;
  readonly #grants: ReadonlyMap<Expr, GrantSignature>;
  readonly #modules: ReadonlyMap<Expr, CoreImportDependency>;
  readonly #ownershipCertified: boolean;
  readonly #typeRepresentations = new TyRepBuilder();
  readonly #residualClosures = new Map<Value, CoreExpression>();
  readonly #residualClosureTypes = new Map<Value, SimpleType>();
  readonly #visitedResidualValues = new WeakSet<object>();
  readonly #visitedResidualEnvironments = new WeakSet<object>();
  readonly #closedRepresentations = new WeakMap<SimpleType, boolean>();
  #staticValues = new Map<string, Value>();
  #runtimeNames = new Set<string>();
  #nextNode = 0;
  #settledHirNodes = 0;
  readonly #pendingHirNodes: Record<HirPendingReason, number> = {
    "structural-fold": 0,
    "specialization-choice": 0,
    "open-representation": 0,
    "ownership-certificate": 0,
  };

  constructor(
    expressionTypes: ReadonlyMap<Expr, SimpleType>,
    comptimeValues: ReadonlyMap<Expr, Value>,
    opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>,
    recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>,
    arrayProofs: ReadonlyMap<Expr, ArrayIndexProof>,
    shapes: ReadonlyMap<Expr, Shape>,
    variants: ReadonlyMap<Expr, readonly VariantCase[]>,
    optionalCases: ReadonlySet<Expr>,
    grants: ReadonlyMap<Expr, GrantSignature>,
    modules: ReadonlyMap<Expr, CoreImportDependency>,
    ownershipCertified: boolean,
  ) {
    this.#expressionTypes = expressionTypes;
    this.#comptimeValues = comptimeValues;
    this.#opens = opens;
    this.#recordAdaptations = recordAdaptations;
    this.#arrayProofs = arrayProofs;
    this.#shapes = shapes;
    this.#variants = variants;
    this.#optionalCases = optionalCases;
    this.#grants = grants;
    this.#modules = modules;
    this.#ownershipCertified = ownershipCertified;
  }

  typeRepresentations(): TyRepTable {
    return this.#typeRepresentations.table();
  }

  hirProgress(): HirProgress {
    return {
      settled: this.#settledHirNodes,
      pending: { ...this.#pendingHirNodes },
    };
  }

  residualClosures(): ReadonlyMap<Value, CoreExpression> {
    return this.#residualClosures;
  }

  residualClosureTypes(): ReadonlyMap<Value, SimpleType> {
    return this.#residualClosureTypes;
  }

  runtimeParameter(pattern: Pattern | null): void {
    if (pattern === null) return;
    for (const name of patternNames(pattern)) this.#runtimeNames.add(name);
  }

  computation(
    declarations: readonly Decl[],
    result: Expr,
    resultEffects: "pure" | "ambient",
    expectedResult?: SimpleType,
  ): CoreComputation {
    const outerRuntimeNames = this.#runtimeNames;
    const outerStaticValues = this.#staticValues;
    this.#runtimeNames = new Set(outerRuntimeNames);
    this.#staticValues = new Map(outerStaticValues);
    const live = liveDeclarations(declarations, result);
    const steps: CoreStep[] = [];
    for (const declaration of declarations) {
      if (!live.has(declaration)) continue;
      if (declaration.tag === "binding" && declaration.kind === "sig") continue;
      if (declaration.tag === "shadow") {
        const value = this.#comptimeValues.get(declaration.value);
        if (value !== undefined && erasedComptimeValue(value)) {
          this.recordResidualValue(value);
          steps.push({
            tag: "define",
            definition: {
              tag: "static-shadow",
              name: declaration.name,
              value,
              span: declaration.span,
              origin: declaration,
            },
          });
          this.#staticValues.set(declaration.name, value);
          continue;
        }
      }
      if (declaration.tag === "binding" && declaration.kind === "const") {
        const value = this.#comptimeValues.get(declaration.value);
        if (
          value !== undefined &&
          !dependsOnNames(declaration.value, this.#runtimeNames)
        ) {
          this.recordResidualValue(value);
          steps.push({
            tag: "define",
            definition: {
              tag: "static",
              pattern: declaration.pattern,
              value,
              span: declaration.span,
              origin: declaration,
            },
          });
          if (declaration.pattern.tag === "name") {
            this.#staticValues.set(declaration.pattern.name, value);
          }
          continue;
        }
      }
      const definition = this.definition(declaration);
      let tag: CoreStep["tag"] = "define";
      if (declaration.tag === "binding" && declaration.kind === "effect") {
        tag = "bind";
      }
      steps.push({ tag, definition });
      if (declaration.tag === "binding") {
        for (const name of patternNames(declaration.pattern)) {
          this.#runtimeNames.add(name);
          this.#staticValues.delete(name);
        }
      } else if (declaration.tag === "shadow") {
        this.#runtimeNames.add(declaration.name);
        this.#staticValues.delete(declaration.name);
      }
    }
    const expression = this.expression(result, expectedResult);
    this.#runtimeNames = outerRuntimeNames;
    this.#staticValues = outerStaticValues;
    if (resultEffects === "pure") {
      return { steps, result: { tag: "return", value: expression } };
    }
    return { steps, result: { tag: "tail", computation: expression } };
  }

  definition(declaration: Decl): CoreDefinition {
    if (declaration.tag === "binding") {
      return {
        tag: "binding",
        kind: declaration.kind,
        tags: declaration.tags,
        pattern: declaration.pattern,
        value: this.expression(declaration.value),
        span: declaration.span,
        origin: declaration,
      };
    }
    if (declaration.tag === "shadow") {
      return {
        tag: "shadow",
        name: declaration.name,
        value: this.expression(declaration.value),
        span: declaration.span,
        origin: declaration,
      };
    }
    const bindings = this.#opens.get(declaration.value);
    if (bindings === undefined) {
      throw new Error(
        `typed Core is missing open bindings at ${declaration.span.start}..${declaration.span.end}`,
      );
    }
    for (const [name, value] of bindings) this.#staticValues.set(name, value);
    return {
      tag: "open",
      bindings,
      span: declaration.span,
      origin: declaration,
    };
  }

  expression(
    expression: Expr,
    expectedType?: SimpleType,
    foldConstants = true,
    trackStaticValue = true,
  ): CoreExpression {
    const type = this.typeOf(expression, expectedType);
    let adaptation: RecordAdaptation | null = null;
    const foundAdaptation = this.#recordAdaptations.get(expression);
    if (foundAdaptation !== undefined) adaptation = foundAdaptation;
    let arrayProof: ArrayIndexProof | null = null;
    const foundArrayProof = this.#arrayProofs.get(expression);
    if (foundArrayProof !== undefined) arrayProof = foundArrayProof;
    let shape: Shape | null = null;
    const foundShape = this.#shapes.get(expression);
    if (foundShape !== undefined) shape = foundShape;
    let variants: readonly VariantCase[] | null = null;
    const foundVariants = this.#variants.get(expression);
    if (foundVariants !== undefined) variants = foundVariants;
    let grant: GrantSignature | null = null;
    const foundGrant = this.#grants.get(expression);
    if (foundGrant !== undefined) grant = foundGrant;
    const typeRep = this.#typeRepresentations.reference(type);
    const constant = this.#comptimeValues.get(expression);
    if (constant !== undefined) this.recordResidualValue(constant);
    const constantClosed = foldConstants && constant !== undefined &&
      !dependsOnNames(expression, this.#runtimeNames);
    let settledConstant: Value | null = null;
    if (constantClosed && constant !== undefined) settledConstant = constant;
    const hirState = this.hirState(
      expression,
      type,
      typeRep,
      arrayProof,
      settledConstant,
    );
    const metadata = {
      id: this.#nextNode++,
      type,
      typeRep,
      span: expression.span,
      adaptation,
      arrayProof,
      shape,
      variants,
      optionalCase: this.#optionalCases.has(expression),
      grant,
      hirState,
      origin: expression,
    };
    if (constantClosed && constant !== undefined) {
      return { ...metadata, tag: "constant", value: constant };
    }
    switch (expression.tag) {
      case "var":
        if (trackStaticValue) {
          const value = this.#staticValues.get(expression.name);
          if (value !== undefined) this.recordResidualValue(value);
        }
        return { ...metadata, tag: "var", name: expression.name };
      case "int":
      case "float":
      case "text":
      case "intrinsic":
      case "tag":
        return {
          ...metadata,
          tag: expression.tag,
          ...scalar(expression),
        } as CoreExpression;
      case "unit":
        return { ...metadata, tag: "unit" };
      case "apply":
        {
          const application = applicationSpine(expression);
          if (application.callee.tag === "intrinsic") {
            if (
              application.callee.name === "@import" &&
              application.args.length >= 1 &&
              application.args[0].tag === "text"
            ) {
              const dependency = this.#modules.get(application.args[0]);
              if (dependency === undefined) {
                throw new Error(
                  `typed Core is missing import ${application.args[0].value}`,
                );
              }
              return {
                ...metadata,
                tag: "import",
                specifier: application.args[0].value,
                args: application.args.slice(1).map((argument) =>
                  this.expression(argument)
                ),
                dependency,
              };
            }
            if (
              application.callee.name === "@type.satisfies" &&
              application.args.length === 1 &&
              application.args[0].tag === "tuple" &&
              application.args[0].elements.length === 2
            ) {
              return {
                ...metadata,
                tag: "checked",
                value: this.expression(application.args[0].elements[0]),
              };
            }
            if (
              application.callee.name === "@satisfies" &&
              application.args.length === 2
            ) {
              return {
                ...metadata,
                tag: "checked",
                value: this.expression(application.args[0]),
              };
            }
            let args = application.args;
            if (
              application.callee.name === "@handle" && args.length === 1 &&
              args[0].tag === "tuple"
            ) {
              args = args[0].elements;
            }
            return {
              ...metadata,
              tag: "intrinsic-apply",
              name: application.callee.name,
              args: args.map((argument) => this.expression(argument)),
            };
          }
          if (
            application.callee.tag === "tag" &&
            application.args.length === 1
          ) {
            return {
              ...metadata,
              tag: "constructor",
              name: application.callee.name,
              payload: this.expression(application.args[0]),
            };
          }
          if (
            application.callee.tag === "field" &&
            !this.#expressionTypes.has(application.callee)
          ) {
            if (application.callee.target.tag !== "var") {
              throw new Error(
                "a static Core member call has a computed namespace",
              );
            }
            this.recordStaticMember(
              application.callee.target.name,
              application.callee.name,
            );
            return {
              ...metadata,
              tag: "static-member-apply",
              target: application.callee.target.name,
              name: application.callee.name,
              args: application.args.map((argument) =>
                this.expression(argument)
              ),
            };
          }
        }
        return {
          ...metadata,
          tag: "apply",
          fn: this.expression(expression.fn),
          arg: this.expression(expression.arg),
        };
      case "field":
        if (expression.target.tag === "var") {
          this.recordStaticMember(expression.target.name, expression.name);
        }
        if (
          expression.target.tag === "var" &&
          !this.#expressionTypes.has(expression.target)
        ) {
          this.recordStaticMember(expression.target.name, expression.name);
          return {
            ...metadata,
            tag: "static-member",
            target: expression.target.name,
            name: expression.name,
          };
        }
        return {
          ...metadata,
          tag: "field",
          target: this.expression(expression.target, undefined, true, false),
          name: expression.name,
        };
      case "lambda": {
        const outerRuntimeNames = this.#runtimeNames;
        this.#runtimeNames = new Set(outerRuntimeNames);
        for (const name of patternNames(expression.parameter)) {
          this.#runtimeNames.add(name);
        }
        const body = this.expression(expression.body);
        this.#runtimeNames = outerRuntimeNames;
        return {
          ...metadata,
          tag: "lambda",
          parameter: expression.parameter,
          body,
          deferred: expression.deferred === true,
        };
      }
      case "array":
        return {
          ...metadata,
          tag: "array",
          elements: expression.elements.map((element) => ({
            spread: element.spread,
            value: this.expression(
              element.value,
              this.arrayElement(type),
            ),
          })),
        };
      case "tuple":
        return {
          ...metadata,
          tag: "tuple",
          elements: expression.elements.map((element, index) =>
            this.expression(element, this.recordField(type, String(index)))
          ),
        };
      case "shape": {
        const members: CoreShapeMember[] = [];
        for (const member of expression.members) {
          if (member.tag === "field") {
            members.push({
              tag: "field",
              name: member.name,
              value: this.expression(
                member.value,
                this.recordField(type, member.name),
              ),
            });
          } else {
            members.push({
              tag: "spread",
              value: this.expression(member.value),
            });
          }
        }
        return { ...metadata, tag: "shape", members };
      }
      case "if": {
        let fallback: CoreExpression | null = null;
        if (expression.fallback !== null) {
          fallback = this.expression(expression.fallback, type);
        }
        return {
          ...metadata,
          tag: "if",
          branches: expression.branches.map((branch) => ({
            condition: this.expression(branch.condition),
            consequence: this.expression(branch.consequence, type),
          })),
          fallback,
        };
      }
      case "case":
        return {
          ...metadata,
          tag: "case",
          target: this.expression(expression.target),
          arms: expression.arms.map((arm) => ({
            pattern: arm.pattern,
            body: this.expression(arm.body, type),
          })),
        };
      case "block":
        return {
          ...metadata,
          tag: "block",
          computation: this.computation(
            expression.declarations,
            expression.result,
            expression.resultEffects,
            type,
          ),
        };
      case "rec":
        return {
          ...metadata,
          tag: "rec",
          lambda: this.expression(expression.lambda),
        };
      case "comptime": {
        const value = this.#comptimeValues.get(expression.body);
        if (value !== undefined) {
          return { ...metadata, tag: "constant", value };
        }
        return {
          ...metadata,
          tag: "comptime",
          body: this.expression(expression.body),
        };
      }
    }
  }

  hirState(
    expression: Expr,
    type: SimpleType,
    typeRep: TyRepId,
    arrayProof: ArrayIndexProof | null,
    constant: Value | null,
  ): HirBuilderState {
    let reason: HirPendingReason | null = null;
    if (!this.#ownershipCertified) {
      reason = "ownership-certificate";
    } else if (
      expression.tag === "if" || expression.tag === "case" ||
      expression.tag === "block" || expression.tag === "rec"
    ) {
      reason = "structural-fold";
    } else if (!this.closedRepresentation(type)) {
      reason = "open-representation";
    } else if (
      constant === null && expression.tag !== "int" &&
      expression.tag !== "float" && expression.tag !== "text" &&
      expression.tag !== "unit" && expression.tag !== "tag"
    ) {
      reason = "specialization-choice";
    }
    if (reason !== null) {
      this.#pendingHirNodes[reason] += 1;
      return { tag: "pending", typeRep, reason };
    }
    this.#settledHirNodes += 1;
    let safety: "not-required" | "proved" = "not-required";
    if (arrayProof !== null) safety = "proved";
    let value: Value;
    if (constant !== null) {
      value = constant;
    } else if (expression.tag === "int") {
      value = { tag: "int", value: expression.value };
    } else if (expression.tag === "float") {
      value = { tag: "float", value: expression.value };
    } else if (expression.tag === "text") {
      value = { tag: "text", value: expression.value };
    } else if (expression.tag === "unit") {
      value = { tag: "unit" };
    } else if (expression.tag === "tag") {
      value = { tag: "tag", name: expression.name, payload: null };
    } else {
      throw new Error("a settled progressive HIR node is not static");
    }
    return {
      tag: "settled",
      typeRep,
      effects: "pure",
      representation: "structural-type-rep",
      ownership: "certified",
      safety,
      node: { tag: "static", value },
    };
  }

  typeOf(expression: Expr, expectedType?: SimpleType): SimpleType {
    const type = this.#expressionTypes.get(expression);
    if (type !== undefined) return type;
    if (expectedType !== undefined) return expectedType;
    if (expression.tag === "rec") return this.typeOf(expression.lambda);
    if (expression.tag === "int") return intLiteral(expression.value);
    if (expression.tag === "float") return FLOAT;
    if (expression.tag === "text") return textLiteral(expression.value);
    if (expression.tag === "unit") return UNIT;
    if (expression.tag === "tag") return variant([[expression.name, UNIT]]);
    const constant = this.#comptimeValues.get(expression);
    if (constant !== undefined) {
      const bridged = bridge(constant);
      if (bridged !== null) return bridged;
    }
    throw new Error(
      `typed Core is missing inference for ${expression.tag} at ${expression.span.start}..${expression.span.end}`,
    );
  }

  closedRepresentation(type: SimpleType): boolean {
    const cached = this.#closedRepresentations.get(type);
    if (cached !== undefined) return cached;
    const closed = closedRepresentation(type, new Set());
    this.#closedRepresentations.set(type, closed);
    return closed;
  }

  recordField(
    type: SimpleType,
    name: string,
    seen = new Set<number>(),
  ): SimpleType | undefined {
    if (type.tag === "record") return type.fields.get(name);
    if (type.tag === "forall") return this.recordField(type.body, name, seen);
    if (type.tag === "union") {
      const found: SimpleType[] = [];
      for (const member of type.members) {
        const field = this.recordField(member, name, seen);
        if (field !== undefined) found.push(field);
      }
      if (found.length > 0) return union(found);
      return undefined;
    }
    if (type.tag !== "var" || seen.has(type.id)) return undefined;
    seen.add(type.id);
    const found: SimpleType[] = [];
    for (const bound of [...type.lower, ...type.upper]) {
      const field = this.recordField(bound, name, seen);
      if (field !== undefined) found.push(field);
    }
    if (found.length > 0) return union(found);
    return undefined;
  }

  arrayElement(
    type: SimpleType,
    seen = new Set<number>(),
  ): SimpleType | undefined {
    if (type.tag === "array") return type.element;
    if (type.tag === "forall") return this.arrayElement(type.body, seen);
    if (type.tag === "union") {
      const found: SimpleType[] = [];
      for (const member of type.members) {
        const element = this.arrayElement(member, seen);
        if (element !== undefined) found.push(element);
      }
      if (found.length > 0) return union(found);
      return undefined;
    }
    if (type.tag !== "var" || seen.has(type.id)) return undefined;
    seen.add(type.id);
    const found: SimpleType[] = [];
    for (const bound of [...type.lower, ...type.upper]) {
      const element = this.arrayElement(bound, seen);
      if (element !== undefined) found.push(element);
    }
    if (found.length > 0) return union(found);
    return undefined;
  }

  recordResidualValue(value: Value): void {
    if (this.#visitedResidualValues.has(value)) return;
    this.#visitedResidualValues.add(value);
    if (value.tag === "closure") {
      if (value.source !== undefined && value.source.tag === "lambda") {
        let expectedType: SimpleType | undefined;
        const recorded = this.#expressionTypes.get(value.source);
        if (recorded !== undefined) expectedType = recorded;
        const inferred = bridge(value);
        if (expectedType === undefined && inferred !== null) {
          expectedType = inferred;
        }
        if (expectedType === undefined) {
          return;
        }
        const lambda = this.expression(value.source, expectedType, false);
        if (lambda.tag !== "lambda") {
          throw new Error("a residual closure source is not a Core lambda");
        }
        this.#residualClosures.set(value, lambda.body);
        this.#residualClosureTypes.set(value, lambda.type);
      } else {
        const outerRuntimeNames = this.#runtimeNames;
        this.#runtimeNames = new Set(outerRuntimeNames);
        for (const name of patternNames(value.parameter)) {
          this.#runtimeNames.add(name);
        }
        this.#residualClosures.set(value, this.expression(value.body));
        this.#runtimeNames = outerRuntimeNames;
      }
      for (const name of freeNames(value.body)) {
        this.recordResidualBinding(value.env, name);
      }
      return;
    }
    if (value.tag === "core-closure") {
      this.#residualClosures.set(value, value.body);
      this.recordResidualEnvironment(value.env);
      return;
    }
    if (value.tag === "shape") {
      for (const field of value.fields.values()) {
        this.recordResidualValue(field);
      }
      return;
    }
    if (value.tag === "array") {
      for (const element of value.elements) this.recordResidualValue(element);
      return;
    }
    if (value.tag === "tag") {
      if (value.payload !== null) this.recordResidualValue(value.payload);
      return;
    }
    if (value.tag === "primitive" || value.tag === "native") {
      for (const applied of value.applied) this.recordResidualValue(applied);
      return;
    }
    if (value.tag === "range") {
      this.recordResidualValue(value.low);
      this.recordResidualValue(value.high);
      return;
    }
    if (value.tag === "union") {
      for (const member of value.members) this.recordResidualValue(member);
      return;
    }
    if (value.tag === "arrow") {
      this.recordResidualValue(value.domain);
      this.recordResidualValue(value.codomain);
      for (const effect of value.effects) this.recordResidualValue(effect);
      return;
    }
    if (value.tag === "forall") {
      this.recordResidualValue(value.body);
      return;
    }
    if (value.tag === "effect") {
      for (const operation of value.operations.values()) {
        this.recordResidualValue(operation);
      }
      return;
    }
    if (value.tag === "operation") {
      this.recordResidualValue(value.effect);
      return;
    }
    if (value.tag === "extended") {
      this.recordResidualValue(value.inner);
      for (const member of value.members.values()) {
        this.recordResidualValue(member);
      }
      return;
    }
    if (value.tag === "sealed") {
      this.recordResidualValue(value.inner);
      return;
    }
    if (value.tag === "region-type") {
      this.recordResidualValue(value.element);
      return;
    }
    if (value.tag === "deferred-type") {
      this.recordResidualValue(value.inner);
      return;
    }
    if (value.tag === "region-array") {
      for (const cell of value.store.cells) this.recordResidualValue(cell);
    }
  }

  recordResidualEnvironment(environment: ValueEnv): void {
    if (this.#visitedResidualEnvironments.has(environment)) return;
    this.#visitedResidualEnvironments.add(environment);
    for (const value of environment.names.values()) {
      this.recordResidualValue(value);
    }
    if (environment.parent !== null) {
      this.recordResidualEnvironment(environment.parent);
    }
  }

  recordResidualBinding(environment: ValueEnv, name: string): void {
    let current: ValueEnv | null = environment;
    while (current !== null) {
      const value = current.names.get(name);
      if (value !== undefined) {
        this.recordResidualValue(value);
        return;
      }
      current = current.parent;
    }
  }

  recordStaticMember(target: string, name: string): void {
    const namespace = this.#staticValues.get(target);
    if (namespace === undefined) return;
    let value = namespace;
    while (value.tag === "extended") {
      const member = value.members.get(name);
      if (member !== undefined) {
        this.recordResidualValue(member);
        return;
      }
      value = value.inner;
    }
    if (value.tag === "shape") {
      const member = value.fields.get(name);
      if (member !== undefined) this.recordResidualValue(member);
    }
  }
}

function closedRepresentation(
  type: SimpleType,
  seen: Set<SimpleType>,
): boolean {
  if (seen.has(type)) return true;
  seen.add(type);
  if (
    type.tag === "var" || type.tag === "rigid" || type.tag === "forall" ||
    type.tag === "open-effects" || type.tag === "top" ||
    type.tag === "bottom"
  ) return false;
  if (
    type.tag === "fun" || type.tag === "effects" || type.tag === "union" ||
    type.tag === "opaque"
  ) return false;
  if (type.tag === "record") {
    return [...type.fields.values()].every((field) =>
      closedRepresentation(field, seen)
    );
  }
  if (type.tag === "array" || type.tag === "region") {
    return closedRepresentation(type.element, seen);
  }
  if (type.tag === "variant") {
    if (type.open) return false;
    return [...type.cases.values()].every((payload) =>
      closedRepresentation(payload, seen)
    );
  }
  return true;
}

function erasedComptimeValue(value: Value): boolean {
  return value.tag === "range" || value.tag === "union" ||
    value.tag === "unbounded" || value.tag === "arrow" ||
    value.tag === "sealed" || value.tag === "extended" ||
    value.tag === "opaque-type" || value.tag === "type-variable" ||
    value.tag === "effect" || value.tag === "forall";
}

function dependsOnNames(
  expression: Expr,
  names: ReadonlySet<string>,
): boolean {
  for (const name of freeNames(expression)) {
    if (names.has(name)) return true;
  }
  return false;
}

function applicationSpine(
  expression: Expr & { readonly tag: "apply" },
): { readonly callee: Expr; readonly args: readonly Expr[] } {
  const args: Expr[] = [];
  let callee: Expr = expression;
  while (callee.tag === "apply") {
    args.unshift(callee.arg);
    callee = callee.fn;
  }
  return { callee, args };
}

function scalar(
  expression: Extract<
    Expr,
    { readonly tag: "var" | "int" | "float" | "text" | "intrinsic" | "tag" }
  >,
): Record<string, string | bigint | number> {
  if (
    expression.tag === "var" || expression.tag === "intrinsic" ||
    expression.tag === "tag"
  ) {
    return { name: expression.name };
  }
  return { value: expression.value };
}
