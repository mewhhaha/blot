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
  UNIT,
  variant,
} from "../check/type.ts";
import type { Value } from "../comptime/value.ts";
import { bridge } from "../check/bridge.ts";
import type {
  Decl,
  DeclarationTag,
  Expr,
  OpenMapping,
  Pattern,
  Span,
} from "../syntax/ast.ts";
import { patternNames } from "../syntax/ast.ts";
import { freeNames, liveDeclarations } from "../syntax/live.ts";
import { TyRepBuilder, type TyRepId, type TyRepTable } from "./type_rep.ts";
import type { RecordAdaptation } from "../check/infer.ts";
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
  /** Provenance only. No Core consumer may recover semantics from this node. */
  readonly origin: Expr;
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
    readonly mappings: readonly OpenMapping[];
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
  readonly resultType: SimpleType;
  readonly typeRepresentations: TyRepTable;
}

/**
 * The shared liveness/ordering decision used while consumers migrate to typed
 * Core. It contains source nodes, so it is not a runtime IR and must not gain
 * typing or lowering behavior.
 */
export interface ComputationSchedule {
  readonly steps: readonly {
    readonly tag: "define" | "bind";
    readonly declaration: Decl;
  }[];
  readonly result:
    | { readonly tag: "return"; readonly value: Expr }
    | { readonly tag: "tail"; readonly computation: Expr };
}

export function coreResultExpression(result: CoreResult): CoreExpression {
  if (result.tag === "return") return result.value;
  return result.computation;
}

export function elaborateComputation(
  declarations: readonly Decl[],
  result: Expr,
  resultEffects: "pure" | "ambient",
  expressionTypes: ReadonlyMap<Expr, SimpleType>,
  comptimeValues: ReadonlyMap<Expr, Value> = new Map(),
  opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>> = new Map(),
  recordAdaptations: ReadonlyMap<Expr, RecordAdaptation> = new Map(),
  arrayProofs: ReadonlyMap<Expr, ArrayIndexProof> = new Map(),
): CoreComputation {
  const elaborator = new Elaborator(
    expressionTypes,
    comptimeValues,
    opens,
    recordAdaptations,
    arrayProofs,
  );
  return elaborator.computation(declarations, result, resultEffects);
}

export function scheduleComputation(
  declarations: readonly Decl[],
  result: Expr,
  resultEffects: "pure" | "ambient",
): ComputationSchedule {
  const live = liveDeclarations(declarations, result);
  const steps: ComputationSchedule["steps"][number][] = [];
  for (const declaration of declarations) {
    if (!live.has(declaration)) continue;
    let tag: "define" | "bind" = "define";
    if (declaration.tag === "binding" && declaration.kind === "effect") {
      tag = "bind";
    }
    steps.push({ tag, declaration });
  }
  if (resultEffects === "pure") {
    return { steps, result: { tag: "return", value: result } };
  }
  return { steps, result: { tag: "tail", computation: result } };
}

export function scheduledResultExpression(
  result: ComputationSchedule["result"],
): Expr {
  if (result.tag === "return") return result.value;
  return result.computation;
}

export function elaborateModule(
  module: {
    readonly parameter: Pattern | null;
    readonly declarations: readonly Decl[];
    readonly result: Expr;
    readonly resultEffects: "pure" | "ambient";
  },
  expressionTypes: ReadonlyMap<Expr, SimpleType>,
  resultType: SimpleType,
  comptimeValues: ReadonlyMap<Expr, Value> = new Map(),
  opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>> = new Map(),
  recordAdaptations: ReadonlyMap<Expr, RecordAdaptation> = new Map(),
  arrayProofs: ReadonlyMap<Expr, ArrayIndexProof> = new Map(),
): TypedCoreModule {
  const elaborator = new Elaborator(
    expressionTypes,
    comptimeValues,
    opens,
    recordAdaptations,
    arrayProofs,
  );
  elaborator.runtimeParameter(module.parameter);
  const computation = elaborator.computation(
    module.declarations,
    module.result,
    module.resultEffects,
  );
  return {
    ...computation,
    parameter: module.parameter,
    resultType,
    typeRepresentations: elaborator.typeRepresentations(),
  };
}

class Elaborator {
  readonly #expressionTypes: ReadonlyMap<Expr, SimpleType>;
  readonly #comptimeValues: ReadonlyMap<Expr, Value>;
  readonly #opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  readonly #recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>;
  readonly #arrayProofs: ReadonlyMap<Expr, ArrayIndexProof>;
  readonly #typeRepresentations = new TyRepBuilder();
  #runtimeNames = new Set<string>();
  #nextNode = 0;

  constructor(
    expressionTypes: ReadonlyMap<Expr, SimpleType>,
    comptimeValues: ReadonlyMap<Expr, Value>,
    opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>,
    recordAdaptations: ReadonlyMap<Expr, RecordAdaptation>,
    arrayProofs: ReadonlyMap<Expr, ArrayIndexProof>,
  ) {
    this.#expressionTypes = expressionTypes;
    this.#comptimeValues = comptimeValues;
    this.#opens = opens;
    this.#recordAdaptations = recordAdaptations;
    this.#arrayProofs = arrayProofs;
  }

  typeRepresentations(): TyRepTable {
    return this.#typeRepresentations.table();
  }

  runtimeParameter(pattern: Pattern | null): void {
    if (pattern === null) return;
    for (const name of patternNames(pattern)) this.#runtimeNames.add(name);
  }

  computation(
    declarations: readonly Decl[],
    result: Expr,
    resultEffects: "pure" | "ambient",
  ): CoreComputation {
    const outerRuntimeNames = this.#runtimeNames;
    this.#runtimeNames = new Set(outerRuntimeNames);
    const live = liveDeclarations(declarations, result);
    const steps: CoreStep[] = [];
    for (const declaration of declarations) {
      if (!live.has(declaration)) continue;
      if (declaration.tag === "binding" && declaration.kind === "sig") continue;
      if (declaration.tag === "shadow") {
        const value = this.#comptimeValues.get(declaration.value);
        if (value !== undefined && erasedComptimeValue(value)) {
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
          continue;
        }
      }
      if (declaration.tag === "binding" && declaration.kind === "const") {
        const value = this.#comptimeValues.get(declaration.value);
        if (
          value !== undefined &&
          !dependsOnNames(declaration.value, this.#runtimeNames)
        ) {
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
        }
      } else if (declaration.tag === "shadow") {
        this.#runtimeNames.add(declaration.name);
      }
    }
    const expression = this.expression(result);
    this.#runtimeNames = outerRuntimeNames;
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
    return {
      tag: "open",
      mappings: declaration.mappings,
      bindings,
      span: declaration.span,
      origin: declaration,
    };
  }

  expression(expression: Expr): CoreExpression {
    const type = this.typeOf(expression);
    let adaptation: RecordAdaptation | null = null;
    const foundAdaptation = this.#recordAdaptations.get(expression);
    if (foundAdaptation !== undefined) adaptation = foundAdaptation;
    let arrayProof: ArrayIndexProof | null = null;
    const foundArrayProof = this.#arrayProofs.get(expression);
    if (foundArrayProof !== undefined) arrayProof = foundArrayProof;
    const metadata = {
      id: this.#nextNode++,
      type,
      typeRep: this.#typeRepresentations.reference(type),
      span: expression.span,
      adaptation,
      arrayProof,
      origin: expression,
    };
    const constant = this.#comptimeValues.get(expression);
    if (
      constant !== undefined &&
      !dependsOnNames(expression, this.#runtimeNames)
    ) {
      return { ...metadata, tag: "constant", value: constant };
    }
    switch (expression.tag) {
      case "var":
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
              return {
                ...metadata,
                tag: "import",
                specifier: application.args[0].value,
                args: application.args.slice(1).map((argument) =>
                  this.expression(argument)
                ),
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
        if (
          expression.target.tag === "var" &&
          !this.#expressionTypes.has(expression.target)
        ) {
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
          target: this.expression(expression.target),
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
        };
      }
      case "array":
        return {
          ...metadata,
          tag: "array",
          elements: expression.elements.map((element) => ({
            spread: element.spread,
            value: this.expression(element.value),
          })),
        };
      case "tuple":
        return {
          ...metadata,
          tag: "tuple",
          elements: expression.elements.map((element) =>
            this.expression(element)
          ),
        };
      case "shape": {
        const members: CoreShapeMember[] = [];
        for (const member of expression.members) {
          if (member.tag === "field") {
            members.push({
              tag: "field",
              name: member.name,
              value: this.expression(member.value),
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
          fallback = this.expression(expression.fallback);
        }
        return {
          ...metadata,
          tag: "if",
          branches: expression.branches.map((branch) => ({
            condition: this.expression(branch.condition),
            consequence: this.expression(branch.consequence),
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
            body: this.expression(arm.body),
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

  typeOf(expression: Expr): SimpleType {
    const type = this.#expressionTypes.get(expression);
    if (type !== undefined) return type;
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
