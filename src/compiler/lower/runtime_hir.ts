import type {
  BlotRuntimeBlock,
  BlotRuntimeFunction,
  BlotRuntimeModule,
  BlotRuntimeOperation,
  BlotRuntimeType,
} from "../../runtime/hir.ts";
import { PRIMITIVES } from "../../comptime/primitives.ts";
import {
  type Env as StaticEnv,
  F32X4_MASK_NAME,
  F32X4_NAME,
  I16X8_MASK_NAME,
  I16X8_NAME,
  I32X4_MASK_NAME,
  I32X4_NAME,
  I8X16_MASK_NAME,
  I8X16_NAME,
  lookup,
  type Value,
} from "../../comptime/value.ts";
import type { CheckResult } from "../../check/mod.ts";
import { show as showType } from "../../check/print.ts";
import type { SimpleType } from "../../check/type.ts";
import { fail } from "../../diagnostic.ts";
import {
  type CoreComputation,
  type CoreExpression,
  coreResultExpression,
  type CoreStep,
} from "../../core/computation.ts";
import {
  type Decl,
  type Expr,
  type Module,
  type Pattern,
  patternNames,
  type Span,
} from "../../syntax/ast.ts";
import { freeNames, liveDeclarations } from "../../syntax/live.ts";
import { recursiveCallsAreOwnershipTail } from "../../linear/check.ts";
import type { StagedExport } from "../../stage.ts";

interface SourceComputationSchedule {
  readonly steps: readonly {
    readonly tag: "define" | "bind";
    readonly declaration: Decl;
  }[];
  readonly result:
    | { readonly tag: "return"; readonly value: Expr }
    | { readonly tag: "tail"; readonly computation: Expr };
}

function scheduleSourceComputation(
  declarations: readonly Decl[],
  result: Expr,
  resultEffects: "pure" | "ambient",
): SourceComputationSchedule {
  const live = liveDeclarations(declarations, result);
  const steps: SourceComputationSchedule["steps"][number][] = [];
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

function scheduledSourceResultExpression(
  result: SourceComputationSchedule["result"],
): Expr {
  if (result.tag === "return") return result.value;
  return result.computation;
}

type TypeId = number;
type ValueId = number;
type BlotRuntimeScalarOperator = Extract<
  BlotRuntimeOperation,
  { readonly kind: "scalar" }
>["operator"];
type ResidualExpression = Expr | CoreExpression;

function sourceExpression(expression: ResidualExpression): Expr {
  if ("origin" in expression) return expression.origin;
  return expression;
}
type ResidualIf =
  | Extract<Expr, { readonly tag: "if" }>
  | Extract<CoreExpression, { readonly tag: "if" }>;
type ResidualCase =
  | Extract<Expr, { readonly tag: "case" }>
  | Extract<CoreExpression, { readonly tag: "case" }>;

type ResidualValue =
  | { readonly kind: "static"; readonly value: Value }
  | { readonly kind: "empty-store"; elementType?: TypeId }
  | {
    readonly kind: "array";
    readonly elements: readonly ResidualValue[];
    readonly elementType?: TypeId;
  }
  | {
    readonly kind: "dynamic";
    readonly value: ValueId;
    readonly type: TypeId;
    readonly meaning?:
      | "ordering"
      | "fresh-store"
      | "reusable-store"
      | { readonly kind: "scalar-ordering"; readonly right: ValueId }
      | {
        readonly kind: "sum";
        readonly cases: readonly string[];
        readonly payloadTypes: readonly TypeId[];
        readonly wrappedPayloads: readonly boolean[];
      };
  }
  | { readonly kind: "tuple"; readonly elements: readonly ResidualValue[] }
  | {
    readonly kind: "shape";
    readonly fields: ReadonlyMap<string, ResidualValue>;
  }
  | {
    readonly kind: "module-argument";
    readonly fields: ReadonlyMap<string, ResidualValue>;
  }
  | {
    readonly kind: "tag";
    readonly name: string;
    readonly payload: ResidualValue;
  }
  | {
    readonly kind: "closure";
    readonly parameter: Pattern;
    readonly body: ResidualExpression;
    readonly environment: ResidualEnvironment;
    readonly self: string | null;
    readonly signature?: SimpleType;
  }
  | {
    readonly kind: "primitive";
    readonly name: string;
    readonly arity: number;
    readonly applied: readonly ResidualValue[];
  }
  | {
    readonly kind: "host-operation";
    readonly capability: "Init";
    readonly operation: string;
    readonly grant: {
      readonly parameter: SimpleType;
      readonly result: SimpleType;
    };
  }
  | {
    readonly kind: "tail-loop";
    readonly block: number;
    readonly parameterType: TypeId;
  }
  | {
    readonly kind: "direct-function";
    readonly captures: readonly Extract<ResidualValue, { kind: "dynamic" }>[];
    readonly function: number;
    readonly parameterType: TypeId;
    readonly resultType: TypeId;
  }
  | { readonly kind: "never" };

type ResidualEnvironment = {
  readonly names: Map<string, ResidualValue>;
  readonly parent: ResidualEnvironment | null;
  readonly staticParent: StaticEnv | null;
  readonly typeSubstitutions: Map<string, TypeId>;
};

type MutableBlock = {
  readonly id: number;
  readonly parameters: Array<BlotRuntimeBlock["parameters"][number]>;
  readonly operations: BlotRuntimeOperation[];
  terminator?: BlotRuntimeBlock["terminator"];
};

export function exportResidualRuntimeHir(
  source: string,
  checked: CheckResult,
  stagedExports: readonly StagedExport[],
  wasmName: string,
  stagedModule?: Module,
): BlotRuntimeModule {
  const builder = new ResidualHirBuilder(source, checked);
  let residualModule: CoreComputation | Module = checked.core;
  if (stagedModule !== undefined) residualModule = stagedModule;
  const runtimeFunctions = new Map<string, BlotRuntimeFunction>();
  for (const exported of stagedExports) {
    if (exported.phase !== "runtime") continue;
    let exportedWasmName = `blot:${exported.sourceName}`;
    if (exported.sourceName === "default") exportedWasmName = wasmName;
    const function_ = builder.build(
      residualModule,
      exportedWasmName,
      exported.sourceName,
      exported.named,
    );
    runtimeFunctions.set(exported.sourceName, function_);
  }

  const exports: BlotRuntimeModule["exports"][number][] = [];
  for (const exported of stagedExports) {
    if (exported.phase === "comptime") {
      exports.push({
        sourceName: exported.sourceName,
        phase: "comptime",
      });
      continue;
    }
    const function_ = runtimeFunctions.get(exported.sourceName);
    if (function_ === undefined) {
      throw new Error(
        `${source}: residual runtime export ${exported.sourceName} lost its function`,
      );
    }
    exports.push({
      sourceName: exported.sourceName,
      phase: "runtime",
      wasmName: function_.name,
      function: function_.id,
      signature: function_.signature,
      ownership: "owned",
    });
  }
  return {
    format: "blot-runtime-hir",
    schemaVersion: 2,
    source,
    types: builder.types,
    signatures: builder.signatures,
    functions: builder.functions,
    capabilities: builder.capabilities(),
    exports,
  };
}

interface ResidualRegion {
  readonly store: Extract<ResidualValue, { readonly kind: "dynamic" }>;
  readonly start: Extract<ResidualValue, { readonly kind: "dynamic" }>;
  readonly end: Extract<ResidualValue, { readonly kind: "dynamic" }>;
}

class ResidualHirBuilder {
  readonly types: BlotRuntimeType[] = [];
  readonly functions: BlotRuntimeFunction[] = [];
  readonly signatures: {
    readonly parameters: readonly number[];
    readonly result: number;
    readonly effects: readonly string[];
  }[] = [];
  #blocks: MutableBlock[] = [];
  readonly #capabilityOperations = new Map<
    string,
    Map<string, { readonly signature: number; readonly key: string }>
  >();
  readonly #checked: CheckResult;
  #functionCapabilities = new Set<string>();
  #sourceHandlers: {
    readonly effect: number;
    readonly handler: ResidualValue;
  }[] = [];
  readonly #source: string;
  readonly #typeByName = new Map<string, TypeId>();
  #currentBlock = 0;
  #dynamicBranchDepth = 0;
  #nextValue = 0;
  #residualOrigin: Span | null = null;

  constructor(source: string, checked: CheckResult) {
    this.#source = source;
    this.#checked = checked;
    this.type("unit");
    this.type("boolean");
    this.type("integer-32");
    this.type("text");
  }

  build(
    computation: CoreComputation | Module,
    wasmName: string,
    sourceName: string,
    namedExport: boolean,
  ): BlotRuntimeFunction {
    const functionId = this.reserveFunction();
    this.#blocks = [];
    this.#sourceHandlers = [];
    this.#functionCapabilities = new Set();
    this.#currentBlock = 0;
    this.#nextValue = 0;
    this.block();
    const environment = this.environment(null, this.#checked.values);
    this.bindModuleParameter(environment);
    let resultExpression: ResidualExpression;
    let forceResult = false;
    let projectResult = false;
    if ("declarations" in computation) {
      const sourceResult = computation.result;
      projectResult = namedExport;
      const scheduled = scheduleSourceComputation(
        computation.declarations,
        sourceResult,
        computation.resultEffects,
      );
      this.declarations(scheduled.steps, environment);
      resultExpression = scheduledSourceResultExpression(scheduled.result);
      forceResult = scheduled.result.tag === "tail";
    } else {
      this.coreDeclarations(computation.steps, environment);
      resultExpression = coreResultExpression(computation.result);
      forceResult = computation.result.tag === "tail";
      projectResult = namedExport;
    }
    let residual = this.evaluate(resultExpression, environment);
    if (forceResult) {
      residual = this.forceEffectValue(residual, resultExpression.span);
    }
    if (projectResult) {
      residual = this.project(residual, sourceName, resultExpression.span);
    }
    const resultType = this.typeForExportValue(
      residual,
      sourceName,
      namedExport,
      resultExpression.span,
    );
    const result = this.materialize(
      residual,
      resultType,
      resultExpression.span,
    );
    this.terminate({
      kind: "return",
      value: result.value,
      span: this.span(resultExpression.span),
    });
    const effects = [...this.#functionCapabilities].sort();
    const signature = this.signatures.length;
    this.signatures.push({ parameters: [], result: result.type, effects });
    const function_: BlotRuntimeFunction = {
      id: functionId,
      name: wasmName,
      signature,
      entryBlock: 0,
      blocks: this.#blocks.map((block) => {
        if (block.terminator === undefined) {
          throw new Error(
            `${this.#source}: residual block ${block.id} has no terminator`,
          );
        }
        return {
          id: block.id,
          parameters: block.parameters,
          operations: block.operations,
          terminator: block.terminator,
        };
      }),
      span: this.span(resultExpression.span),
    };
    this.functions[functionId] = function_;
    return function_;
  }

  capabilities() {
    return [...this.#capabilityOperations].map(([name, operations]) => ({
      name,
      operations: [...operations].map(([operation, declaration]) => ({
        name: operation,
        signature: declaration.signature,
      })),
    }));
  }

  private evaluate(
    expr: ResidualExpression,
    environment: ResidualEnvironment,
  ): ResidualValue {
    if (expr.tag === "int") {
      return { kind: "static", value: { tag: "int", value: expr.value } };
    }
    if (expr.tag === "float") {
      return { kind: "static", value: { tag: "float", value: expr.value } };
    }
    if (expr.tag === "text") {
      return { kind: "static", value: { tag: "text", value: expr.value } };
    }
    if (expr.tag === "unit") {
      return { kind: "static", value: { tag: "unit" } };
    }
    if (expr.tag === "tag") {
      return {
        kind: "static",
        value: { tag: "tag", name: expr.name, payload: null },
      };
    }
    if (expr.tag === "constant") {
      return { kind: "static", value: expr.value };
    }
    if (expr.tag === "var") {
      const value = this.lookup(environment, expr.name);
      if (value === undefined) {
        throw new TypeError(
          `${this.#source}:${expr.span.start}: residual name ${expr.name} is unbound`,
        );
      }
      return this.residualizeStatic(value, environment);
    }
    if (expr.tag === "intrinsic") {
      if (expr.name === "@array.empty") {
        const checked = this.#checked.expressionTypes.get(
          sourceExpression(expr),
        );
        if (checked !== undefined) {
          const type = this.typeForSimpleType(
            checked,
            expr.span,
            new Set(),
            environment.typeSubstitutions,
          );
          if (type !== null) {
            const runtimeType = this.types[type];
            if (runtimeType.kind === "store") {
              return {
                kind: "empty-store",
                elementType: runtimeType.elementType,
              };
            }
          }
        }
        return { kind: "empty-store" };
      }
      const primitive = PRIMITIVES.get(expr.name);
      if (primitive === undefined) {
        throw new TypeError(
          `${this.#source}:${expr.span.start}: residual intrinsic ${expr.name} is outside the admitted calculus`,
        );
      }
      return {
        kind: "primitive",
        name: expr.name,
        arity: primitive.arity,
        applied: [],
      };
    }
    if (expr.tag === "apply") {
      if (
        expr.fn.tag === "intrinsic" && expr.fn.name === "@handle" &&
        expr.arg.tag === "tuple" && expr.arg.elements.length === 3
      ) {
        return this.handleSourceEffect(
          expr.arg.elements,
          environment,
          expr.span,
        );
      }
      const fn = this.evaluate(expr.fn, environment);
      if (fn.kind === "never") return fn;
      const argument = this.evaluate(expr.arg, environment);
      return this.apply(
        fn,
        argument,
        expr.span,
        this.#checked.expressionTypes.get(sourceExpression(expr.arg)),
        this.#checked.expressionTypes.get(sourceExpression(expr)),
      );
    }
    if (expr.tag === "intrinsic-apply") {
      if (
        expr.name === "@handle" && expr.args.length === 1 &&
        expr.args[0].tag === "tuple" && expr.args[0].elements.length === 3
      ) {
        return this.handleSourceEffect(
          expr.args[0].elements,
          environment,
          expr.span,
        );
      }
      const primitive = PRIMITIVES.get(expr.name);
      if (primitive === undefined) {
        throw this.outside(expr.span, `intrinsic ${expr.name}`);
      }
      let value: ResidualValue = {
        kind: "primitive",
        name: expr.name,
        arity: primitive.arity,
        applied: [],
      };
      for (const argument of expr.args) {
        value = this.apply(
          value,
          this.evaluate(argument, environment),
          expr.span,
          this.#checked.expressionTypes.get(sourceExpression(argument)),
        );
      }
      return value;
    }
    if (expr.tag === "constructor") {
      return {
        kind: "tag",
        name: expr.name,
        payload: this.evaluate(expr.payload, environment),
      };
    }
    if (expr.tag === "checked") return this.evaluate(expr.value, environment);
    if (expr.tag === "field") {
      return this.project(
        this.evaluate(expr.target, environment),
        expr.name,
        expr.span,
      );
    }
    if (expr.tag === "lambda") {
      return {
        kind: "closure",
        parameter: expr.parameter,
        body: expr.body,
        environment,
        self: null,
        signature: this.#checked.expressionTypes.get(sourceExpression(expr)),
      };
    }
    if (expr.tag === "array") {
      const elements: ResidualValue[] = [];
      for (const element of expr.elements) {
        const value = this.evaluate(element.value, environment);
        if (!element.spread) {
          elements.push(value);
          continue;
        }
        if (value.kind === "array") {
          elements.push(...value.elements);
          continue;
        }
        const spread = this.staticValue(value);
        if (spread === undefined || spread.tag !== "array") {
          throw this.outside(element.value.span, "dynamic array spread");
        }
        for (const spreadElement of spread.elements) {
          elements.push({ kind: "static", value: spreadElement });
        }
      }
      let elementType: TypeId | undefined;
      const checkedType = this.#checked.expressionTypes.get(
        sourceExpression(expr),
      );
      if (checkedType !== undefined) {
        const type = this.typeForSimpleType(checkedType, expr.span, new Set());
        if (type !== null) {
          const runtimeType = this.types[type];
          if (runtimeType.kind === "store") {
            elementType = runtimeType.elementType;
          }
        }
      }
      return { kind: "array", elements, elementType };
    }
    if (expr.tag === "tuple") {
      return {
        kind: "tuple",
        elements: expr.elements.map((element) =>
          this.evaluate(element, environment)
        ),
      };
    }
    if (expr.tag === "shape") {
      const fields = new Map<string, ResidualValue>();
      for (const member of expr.members) {
        const value = this.evaluate(member.value, environment);
        if (member.tag === "field") {
          fields.set(member.name, value);
          continue;
        }
        if (value.kind !== "shape") {
          throw this.outside(expr.span, "dynamic shape spread");
        }
        for (const [name, field] of value.fields) fields.set(name, field);
      }
      return { kind: "shape", fields };
    }
    if (expr.tag === "block") {
      const scope = this.environment(environment, null);
      if ("computation" in expr) {
        const coreBlock = expr as Extract<
          CoreExpression,
          { readonly tag: "block" }
        >;
        this.coreDeclarations(coreBlock.computation.steps, scope);
        let result = this.evaluate(
          coreResultExpression(coreBlock.computation.result),
          scope,
        );
        if (coreBlock.computation.result.tag === "tail") {
          result = this.forceEffectValue(result, expr.span);
        }
        return result;
      }
      const sourceBlock = expr as Extract<Expr, { readonly tag: "block" }>;
      const scheduled = scheduleSourceComputation(
        sourceBlock.declarations,
        sourceBlock.result,
        sourceBlock.resultEffects,
      );
      this.declarations(scheduled.steps, scope);
      let result = this.evaluate(
        scheduledSourceResultExpression(scheduled.result),
        scope,
      );
      if (scheduled.result.tag === "tail") {
        result = this.forceEffectValue(result, expr.span);
      }
      return result;
    }
    if (expr.tag === "if") return this.conditional(expr, environment);
    if (expr.tag === "case") return this.caseExpression(expr, environment);
    throw this.outside(expr.span, expr.tag);
  }

  private coreDeclarations(
    steps: readonly CoreStep[],
    environment: ResidualEnvironment,
  ): void {
    for (const step of steps) {
      const definition = step.definition;
      if (definition.tag === "shadow") {
        environment.names.set(
          definition.name,
          this.evaluate(definition.value, environment),
        );
        continue;
      }
      if (definition.tag === "open") {
        for (const [name, value] of definition.bindings) {
          environment.names.set(name, { kind: "static", value });
        }
        continue;
      }
      if (definition.tag === "static") {
        this.bind(
          definition.pattern,
          { kind: "static", value: definition.value },
          environment,
          definition.span,
        );
        continue;
      }
      if (definition.tag === "static-shadow") {
        environment.names.set(
          definition.name,
          { kind: "static", value: definition.value },
        );
        continue;
      }
      let value: ResidualValue;
      if (definition.value.tag === "rec") {
        if (definition.pattern.tag !== "name") {
          throw this.outside(definition.span, "recursive non-name binding");
        }
        const recursive = this.evaluate(
          definition.value.lambda,
          environment,
        );
        if (recursive.kind !== "closure") {
          throw this.outside(definition.span, "recursive non-closure binding");
        }
        value = { ...recursive, self: definition.pattern.name };
      } else {
        value = this.evaluate(definition.value, environment);
      }
      if (step.tag === "bind") {
        value = this.forceEffectValue(value, definition.span);
      }
      this.bind(definition.pattern, value, environment, definition.span);
    }
  }

  private declarations(
    steps: SourceComputationSchedule["steps"],
    environment: ResidualEnvironment,
  ): void {
    for (const step of steps) {
      const declaration = step.declaration;
      if (declaration.tag === "open") {
        const opened = this.#checked.opens.get(declaration.value);
        if (opened === undefined) {
          throw new Error(
            `${this.#source}:${declaration.span.start}: checking omitted open bindings`,
          );
        }
        for (const [name, value] of opened) {
          environment.names.set(name, { kind: "static", value });
        }
        continue;
      }
      if (declaration.tag === "shadow") {
        environment.names.set(
          declaration.name,
          this.evaluate(declaration.value, environment),
        );
        continue;
      }
      if (declaration.kind === "sig") continue;
      let value: ResidualValue;
      if (declaration.kind === "const") {
        const known = this.#checked.comptimeValues.get(declaration.value);
        if (known === undefined) {
          throw new Error(
            `${this.#source}:${declaration.span.start}: checking omitted compile-time declaration value`,
          );
        }
        value = this.residualizeStatic(
          { kind: "static", value: known },
          environment,
        );
      } else if (declaration.value.tag === "rec") {
        if (declaration.pattern.tag !== "name") {
          throw this.outside(declaration.span, "recursive non-name binding");
        }
        const recursive = this.evaluate(
          declaration.value.lambda,
          environment,
        );
        if (recursive.kind !== "closure") {
          throw this.outside(declaration.span, "recursive non-closure binding");
        }
        value = { ...recursive, self: declaration.pattern.name };
      } else {
        value = this.evaluate(declaration.value, environment);
      }
      value = this.applyCheckedResidualType(
        value,
        declaration.value,
        declaration.span,
      );
      if (step.tag === "bind") {
        value = this.forceEffectValue(value, declaration.span);
      }
      this.bind(declaration.pattern, value, environment, declaration.span);
    }
  }

  private forceEffectValue(value: ResidualValue, span: Span): ResidualValue {
    if (value.kind === "closure" && value.parameter.tag === "unit") {
      return this.apply(
        value,
        { kind: "static", value: { tag: "unit" } },
        span,
      );
    }
    if (value.kind !== "static") return value;
    if (value.value.tag === "closure" && value.value.parameter.tag === "unit") {
      return this.apply(
        value,
        { kind: "static", value: { tag: "unit" } },
        span,
      );
    }
    if (
      value.value.tag !== "operation" || value.value.effect.tag !== "effect"
    ) {
      return value;
    }
    const signature = value.value.effect.operations.get(value.value.name);
    if (signature?.tag !== "arrow" || signature.domain.tag !== "unit") {
      return value;
    }
    return this.apply(value, { kind: "static", value: { tag: "unit" } }, span);
  }

  private apply(
    fn: ResidualValue,
    argument: ResidualValue,
    span: Span,
    expectedArgumentType?: SimpleType,
    expectedResultType?: SimpleType,
  ): ResidualValue {
    if (fn.kind === "never" || argument.kind === "never") {
      return { kind: "never" };
    }
    if (fn.kind === "static") {
      const value = fn.value;
      if (value.tag === "closure" || value.tag === "core-closure") {
        if (
          value.self !== null &&
          this.shouldLowerTailRecursion(value.body, value.self)
        ) {
          const residual = this.residualizeStatic(fn);
          if (residual.kind !== "closure") {
            throw new Error("recursive source closure did not residualize");
          }
          return this.apply(residual, argument, span, expectedArgumentType);
        }
        const scope = this.environment(null, value.env);
        if (value.self !== null) scope.names.set(value.self, fn);
        this.bind(value.parameter, argument, scope, span);
        const previousOrigin = this.#residualOrigin;
        if (previousOrigin === null) this.#residualOrigin = span;
        try {
          return this.evaluate(value.body, scope);
        } finally {
          this.#residualOrigin = previousOrigin;
        }
      }
      if (value.tag === "primitive") {
        return this.apply(
          {
            kind: "primitive",
            name: value.name,
            arity: value.arity,
            applied: value.applied.map((applied) => ({
              kind: "static" as const,
              value: applied,
            })),
          },
          argument,
          span,
        );
      }
      if (value.tag === "operation") {
        if (value.effect.tag !== "effect") {
          throw this.outside(span, "operation without an effect");
        }
        return value.effect.host
          ? this.hostCall(value, argument, span)
          : this.sourceCall(value, argument, span);
      }
      if (value.tag === "tag" && value.payload === null) {
        return { kind: "tag", name: value.name, payload: argument };
      }
      throw this.outside(span, `application of static ${value.tag}`);
    }
    if (fn.kind === "closure") {
      if (
        fn.self !== null &&
        this.shouldLowerTailRecursion(fn.body, fn.self)
      ) {
        return this.lowerTailRecursiveLoop(
          fn,
          argument,
          span,
          expectedArgumentType,
        );
      }
      if (
        fn.self !== null &&
        !this.recursionBecomesTailInBranch(fn.body, fn.self)
      ) {
        return this.lowerDirectRecursiveFunction(
          fn,
          argument,
          span,
          expectedResultType,
        );
      }
      const scope = this.environment(fn.environment, null);
      this.recordRuntimeTypeSubstitutions(
        fn.signature,
        argument,
        scope.typeSubstitutions,
        span,
      );
      if (fn.self !== null) scope.names.set(fn.self, fn);
      this.bind(fn.parameter, argument, scope, span);
      return this.evaluate(fn.body, scope);
    }
    if (fn.kind === "direct-function") {
      const dynamicArgument = this.materialize(
        argument,
        fn.parameterType,
        span,
      );
      const result = this.nextValue();
      this.current().operations.push({
        kind: "call.direct",
        result,
        type: fn.resultType,
        operands: [
          ...fn.captures.map((capture) => capture.value),
          dynamicArgument.value,
        ],
        ownership: this.ownership(fn.resultType),
        function: fn.function,
        span: this.span(span),
      });
      return { kind: "dynamic", value: result, type: fn.resultType };
    }
    if (fn.kind === "host-operation") {
      return this.hostGrantCall(fn, argument, span);
    }
    if (fn.kind === "tail-loop") {
      const dynamicArgument = this.materialize(
        argument,
        fn.parameterType,
        span,
      );
      this.terminate({
        kind: "branch",
        target: fn.block,
        arguments: [dynamicArgument.value],
        span: this.span(span),
      });
      return { kind: "never" };
    }
    if (fn.kind !== "primitive") {
      throw this.outside(span, `application of ${fn.kind}`);
    }
    const applied = [...fn.applied, argument];
    if (applied.length < fn.arity) return { ...fn, applied };
    if (fn.name === "@panic") {
      const message = this.staticValue(applied[0]);
      if (message === undefined || message.tag !== "text") {
        throw this.outside(span, "dynamic panic message");
      }
      this.terminate({
        kind: "trap",
        message: `BLOT_PANIC: ${message.value}`,
        span: this.span(span),
      });
      return { kind: "never" };
    }
    const staticArguments = applied.map((value) => this.staticValue(value));
    if (staticArguments.every((value) => value !== undefined)) {
      return {
        kind: "static",
        value: PRIMITIVES.get(fn.name)!.run(
          staticArguments as Value[],
          span,
          "runtime",
        ),
      };
    }
    if (fn.name === "@shape.get") {
      const name = this.staticValue(applied[1]);
      if (name === undefined || name.tag !== "text") {
        throw this.outside(span, "dynamic shape field name");
      }
      return this.project(applied[0], name.value, span);
    }
    if (fn.name === "@shape.set") {
      const name = this.staticValue(applied[1]);
      if (name === undefined || name.tag !== "text") {
        throw this.outside(span, "dynamic shape field name");
      }
      if (applied[0].kind !== "shape") {
        throw this.outside(span, "shape update of a non-record value");
      }
      const fields = new Map(applied[0].fields);
      fields.set(name.value, applied[2]);
      return { kind: "shape", fields };
    }
    if (fn.name === "@shape.remove") {
      const name = this.staticValue(applied[1]);
      if (name === undefined || name.tag !== "text") {
        throw this.outside(span, "dynamic shape field name");
      }
      if (applied[0].kind !== "shape") {
        throw this.outside(span, "shape removal from a non-record value");
      }
      const fields = new Map(applied[0].fields);
      fields.delete(name.value);
      return { kind: "shape", fields };
    }
    if (fn.name === "@type.seal") {
      const name = this.staticValue(applied[0]);
      if (name === undefined || name.tag !== "text") {
        throw this.outside(span, "dynamic sealed type name");
      }
      return applied[1];
    }
    if (fn.name === "@type.open") return applied[0];
    if (fn.name === "@linear.own" || fn.name === "@linear.borrow") {
      return applied[0];
    }
    if (fn.name === "@region.claim") {
      const original = applied[0];
      let store = this.store(original, span, fn.name);
      if (
        original.kind !== "array" &&
        !(original.kind === "dynamic" &&
          original.meaning === "reusable-store")
      ) {
        store = this.privateStoreCopy(store, span);
      }
      const length = this.storeLength(store, span);
      const zero = this.constant(0n, this.type("signed-integer-64"), span);
      return this.makeRegion(store, zero, length, span);
    }
    if (fn.name === "@region.length") {
      const { start, end } = this.region(applied[0], span, fn.name);
      return this.operation(
        "scalar",
        this.type("signed-integer-64"),
        [end.value, start.value],
        span,
        undefined,
        "subtract",
      );
    }
    if (fn.name === "@region.get") {
      const region = this.region(applied[0], span, fn.name);
      const index = this.integer(applied[1], span, fn.name);
      return this.regionGet(region, index, span);
    }
    if (fn.name === "@region.set") {
      const region = this.region(applied[0], span, fn.name);
      const storeType = this.types[region.store.type];
      if (storeType.kind !== "store") {
        throw this.outside(span, "Region Store projection lost its Store type");
      }
      const index = this.integer(applied[1], span, fn.name);
      const value = this.materialize(applied[2], storeType.elementType, span);
      return this.regionSet(region, index, value, span);
    }
    if (fn.name === "@region.replace") {
      const region = this.region(applied[0], span, fn.name);
      const storeType = this.types[region.store.type];
      if (storeType.kind !== "store") {
        throw this.outside(span, "Region Store projection lost its Store type");
      }
      const index = this.integer(applied[1], span, fn.name);
      const value = this.materialize(applied[2], storeType.elementType, span);
      return this.regionReplace(region, index, value, span);
    }
    if (fn.name === "@region.swap") {
      const region = this.region(applied[0], span, fn.name);
      const left = this.integer(applied[1], span, fn.name);
      const right = this.integer(applied[2], span, fn.name);
      return this.regionSwap(region, left, right, span);
    }
    if (fn.name === "@region.split") {
      const region = this.region(applied[0], span, fn.name);
      const offset = this.integer(applied[1], span, fn.name);
      return this.regionSplit(region, offset, span);
    }
    if (fn.name === "@region.join") {
      this.dynamic(applied[0]);
      const left = this.region(applied[1], span, fn.name);
      const right = this.region(applied[2], span, fn.name);
      return this.makeRegion(left.store, left.start, right.end, span);
    }
    if (
      fn.name === "@region.reassociate_left" ||
      fn.name === "@region.reassociate_right"
    ) {
      return {
        kind: "tuple",
        elements: [
          { kind: "static", value: { tag: "unit" } },
          { kind: "static", value: { tag: "unit" } },
        ],
      };
    }
    if (fn.name === "@region.freeze") {
      return this.region(applied[0], span, fn.name).store;
    }
    if (fn.name === "@array.take") {
      const store = this.store(applied[0], span, fn.name);
      const index = this.integer(applied[1], span, fn.name);
      return this.arrayTake(store, index, span);
    }
    if (fn.name === "@array.split") {
      const store = this.store(applied[0], span, fn.name);
      const index = this.integer(applied[1], span, fn.name);
      return this.arraySplit(store, index, span);
    }
    if (fn.name === "@array.len") {
      const store = this.store(applied[0], span, fn.name);
      const result = this.nextValue();
      this.current().operations.push({
        kind: "store.length",
        result,
        type: this.type("signed-integer-64"),
        operands: [store.value],
        ownership: "plain",
        span: this.span(span),
      });
      return {
        kind: "dynamic",
        value: result,
        type: this.type("signed-integer-64"),
      };
    }
    if (fn.name === "@array.get") {
      const store = this.store(applied[0], span, fn.name);
      const storeType = this.types[store.type];
      if (storeType.kind !== "store") {
        throw this.outside(span, `${fn.name} over a non-store`);
      }
      const index = this.integer(applied[1], span, fn.name);
      const result = this.nextValue();
      this.current().operations.push({
        kind: "store.read",
        result,
        type: storeType.elementType,
        operands: [store.value, index.value],
        ownership: this.ownership(storeType.elementType),
        span: this.span(span),
      });
      return { kind: "dynamic", value: result, type: storeType.elementType };
    }
    if (fn.name === "@array.set") {
      const store = this.store(applied[0], span, fn.name);
      const storeType = this.types[store.type];
      if (storeType.kind !== "store") {
        throw this.outside(span, `${fn.name} over a non-store`);
      }
      const index = this.integer(applied[1], span, fn.name);
      const element = this.materialize(
        applied[2],
        storeType.elementType,
        span,
      );
      const result = this.nextValue();
      this.current().operations.push({
        kind: "store.write",
        result,
        type: store.type,
        operands: [store.value, index.value, element.value],
        ownership: "owned",
        update: "persistent",
        span: this.span(span),
      });
      return {
        kind: "dynamic",
        value: result,
        type: store.type,
        meaning: "fresh-store",
      };
    }
    if (fn.name === "@array.push") {
      if (applied[0].kind === "empty-store") {
        if (applied[0].elementType === undefined) {
          let inferred: TypeId | null = null;
          if (expectedArgumentType !== undefined) {
            inferred = this.typeForSimpleType(
              expectedArgumentType,
              span,
              new Set(),
            );
          }
          if (inferred === null) {
            inferred = this.typeForResidualValue(applied[1], span);
          }
          applied[0].elementType = inferred;
        }
      }
      const store = this.store(applied[0], span, fn.name);
      const storeType = this.types[store.type];
      if (storeType.kind !== "store") {
        throw this.outside(span, `${fn.name} over a non-store`);
      }
      const elementType = storeType.elementType;
      const length = this.nextValue();
      this.current().operations.push({
        kind: "store.length",
        result: length,
        type: this.type("signed-integer-64"),
        operands: [store.value],
        ownership: "plain",
        span: this.span(span),
      });
      const one = this.constant(1n, this.type("signed-integer-64"), span);
      const grownLength = this.operation(
        "scalar",
        this.type("signed-integer-64"),
        [length, one.value],
        span,
        undefined,
        "add",
      );
      const element = this.materialize(applied[1], elementType, span);
      const result = this.nextValue();
      this.current().operations.push({
        kind: "store.grow",
        result,
        type: store.type,
        operands: [store.value, grownLength.value, element.value],
        ownership: "owned",
        update: "persistent",
        span: this.span(span),
      });
      return { kind: "dynamic", value: result, type: store.type };
    }
    const binaryIntegerOperators = new Map<string, BlotRuntimeScalarOperator>([
      ["@int.add", "add"],
      ["@int.sub", "subtract"],
      ["@int.mul", "multiply"],
      ["@int.div", "divide"],
      ["@int.rem", "remainder"],
    ]);
    const integerOperator = binaryIntegerOperators.get(fn.name);
    if (integerOperator !== undefined) {
      const left = this.integer(applied[0], span, fn.name);
      const right = this.integer(applied[1], span, fn.name);
      return this.operation(
        "scalar",
        this.type("signed-integer-64"),
        [left.value, right.value],
        span,
        undefined,
        integerOperator,
      );
    }
    if (fn.name === "@int.neg") {
      const value = this.integer(applied[0], span, fn.name);
      const zero = this.constant(0n, this.type("signed-integer-64"), span);
      return this.operation(
        "scalar",
        this.type("signed-integer-64"),
        [zero.value, value.value],
        span,
        undefined,
        "subtract",
      );
    }
    if (fn.name === "@int.cmp") {
      const left = this.integer(applied[0], span, fn.name);
      const right = this.integer(applied[1], span, fn.name);
      return {
        kind: "dynamic",
        value: left.value,
        type: left.type,
        meaning: { kind: "scalar-ordering", right: right.value },
      };
    }
    if (fn.name === "@text.of_int") {
      const value = this.integer(applied[0], span, fn.name);
      return this.operation(
        "text.from-i64",
        this.type("text"),
        [value.value],
        span,
      );
    }
    if (fn.name === "@text.concat" || fn.name === "@text.cmp") {
      const left = this.text(applied[0], span, fn.name);
      const right = this.text(applied[1], span, fn.name);
      if (fn.name === "@text.concat") {
        return this.operation("text.append", this.type("text"), [
          left.value,
          right.value,
        ], span);
      }
      return this.operation(
        "text.compare",
        this.type("integer-32"),
        [left.value, right.value],
        span,
        "ordering",
      );
    }
    if (fn.name === "@float.of_int") {
      return this.floatOfInteger(applied[0], span);
    }
    if (fn.name === "@f32.of_float") {
      const value = this.floating(
        applied[0],
        "float-64",
        span,
        fn.name,
      );
      return this.convert(
        value,
        this.type("float-32"),
        "float-64-to-float-32",
        span,
      );
    }
    if (fn.name === "@float.of_f32") {
      const value = this.floating(
        applied[0],
        "float-32",
        span,
        fn.name,
      );
      return this.convert(
        value,
        this.type("float-64"),
        "float-32-to-float-64",
        span,
      );
    }
    if (fn.name === "@int.of_float") {
      const value = this.floating(
        applied[0],
        "float-64",
        span,
        fn.name,
      );
      return this.convert(
        value,
        this.type("signed-integer-64"),
        "float-64-to-signed-integer-64",
        span,
      );
    }
    if (
      fn.name === "@float.add" || fn.name === "@float.sub" ||
      fn.name === "@float.mul" || fn.name === "@float.div" ||
      fn.name === "@float.rem" || fn.name === "@f32.add" ||
      fn.name === "@f32.sub" || fn.name === "@f32.mul" ||
      fn.name === "@f32.div"
    ) {
      let expected: "float-32" | "float-64" = "float-64";
      if (fn.name.startsWith("@f32.")) expected = "float-32";
      const left = this.floating(applied[0], expected, span, fn.name);
      const right = this.floating(applied[1], expected, span, fn.name);
      let operator: BlotRuntimeScalarOperator = "add";
      if (fn.name.endsWith(".sub")) operator = "subtract";
      if (fn.name.endsWith(".mul")) operator = "multiply";
      if (fn.name.endsWith(".div")) operator = "divide";
      if (fn.name.endsWith(".rem")) operator = "remainder";
      return this.operation(
        "scalar",
        left.type,
        [left.value, right.value],
        span,
        undefined,
        operator,
      );
    }
    if (fn.name === "@float.neg" || fn.name === "@f32.neg") {
      let expected: "float-32" | "float-64" = "float-64";
      if (fn.name === "@f32.neg") expected = "float-32";
      const value = this.floating(applied[0], expected, span, fn.name);
      const negativeOne = this.constant(-1, value.type, span);
      return this.operation(
        "scalar",
        value.type,
        [value.value, negativeOne.value],
        span,
        undefined,
        "multiply",
      );
    }
    if (fn.name === "@float.is_nan" || fn.name === "@f32.is_nan") {
      let expected: "float-32" | "float-64" = "float-64";
      if (fn.name === "@f32.is_nan") expected = "float-32";
      const value = this.floating(applied[0], expected, span, fn.name);
      return this.operation(
        "scalar",
        this.type("boolean"),
        [value.value, value.value],
        span,
        undefined,
        "not-equal",
      );
    }
    if (fn.name === "@float.cmp" || fn.name === "@f32.cmp") {
      let expected: "float-32" | "float-64" = "float-64";
      if (fn.name === "@f32.cmp") expected = "float-32";
      const left = this.floating(applied[0], expected, span, fn.name);
      const right = this.floating(applied[1], expected, span, fn.name);
      this.trapIfNaN(left, fn.name, span);
      this.trapIfNaN(right, fn.name, span);
      return {
        ...left,
        meaning: { kind: "scalar-ordering", right: right.value },
      };
    }
    const simd = this.simdPrimitive(fn.name, applied, span);
    if (simd !== undefined) return simd;
    if (fn.name === "@text.contains") {
      return this.unsupported(span, "dynamic @text.contains");
    }
    throw this.outside(span, `dynamic primitive ${fn.name}`);
  }

  private lowerTailRecursiveLoop(
    fn: Extract<ResidualValue, { readonly kind: "closure" }>,
    argument: ResidualValue,
    span: Span,
    expectedArgumentType?: SimpleType,
  ): ResidualValue {
    const substitutions = new Map(fn.environment.typeSubstitutions);
    this.recordRuntimeTypeSubstitutions(
      fn.signature,
      argument,
      substitutions,
      span,
    );
    if (this.valueHasUntypedStore(argument)) {
      const scope = this.environment(fn.environment, null);
      for (const [key, type] of substitutions) {
        scope.typeSubstitutions.set(key, type);
      }
      if (fn.self === null) {
        throw new Error("tail-recursive closure lost its self name");
      }
      scope.names.set(fn.self, fn);
      this.bind(fn.parameter, argument, scope, span);
      return this.evaluate(fn.body, scope);
    }
    let parameterType: TypeId | null = null;
    if (expectedArgumentType !== undefined) {
      parameterType = this.typeForSimpleType(
        expectedArgumentType,
        span,
        new Set(),
        substitutions,
      );
    }
    let functionType = fn.signature;
    while (functionType?.tag === "forall") functionType = functionType.body;
    if (parameterType === null && functionType?.tag === "fun") {
      parameterType = this.typeForSimpleType(
        functionType.param,
        span,
        new Set(),
        substitutions,
      );
    }
    if (parameterType === null) {
      parameterType = this.typeForResidualValue(argument, span);
    }
    const dynamicArgument = this.materialize(argument, parameterType, span);
    const source = this.current();
    const header = this.block();
    source.terminator = {
      kind: "branch",
      target: header.id,
      arguments: [dynamicArgument.value],
      span: this.span(span),
    };
    const parameter = this.nextValue();
    header.parameters.push({
      value: parameter,
      type: parameterType,
      ownership: this.ownership(parameterType),
      span: this.span(span),
    });
    this.#currentBlock = header.id;
    const scope = this.environment(fn.environment, null);
    for (const [key, type] of substitutions) {
      scope.typeSubstitutions.set(key, type);
    }
    if (fn.self === null) {
      throw new Error("tail-recursive closure lost its self name");
    }
    scope.names.set(fn.self, {
      kind: "tail-loop",
      block: header.id,
      parameterType,
    });
    this.bind(
      fn.parameter,
      { kind: "dynamic", value: parameter, type: parameterType },
      scope,
      span,
    );
    return this.evaluate(fn.body, scope);
  }

  private lowerDirectRecursiveFunction(
    fn: Extract<ResidualValue, { readonly kind: "closure" }>,
    argument: ResidualValue,
    span: Span,
    expectedResultType?: SimpleType,
  ): ResidualValue {
    if (fn.self === null) {
      throw new Error("direct-recursive closure lost its self name");
    }
    let signature = fn.signature;
    while (signature?.tag === "forall") signature = signature.body;
    if (signature?.tag !== "fun") {
      throw this.outside(
        span,
        "recursive function without a settled signature",
      );
    }
    const substitutions = new Map(fn.environment.typeSubstitutions);
    this.recordRuntimeType(
      signature.param,
      argument,
      substitutions,
      span,
    );
    let parameterType = this.typeForSimpleType(
      signature.param,
      span,
      new Set(),
      substitutions,
    );
    if (parameterType === null) {
      parameterType = this.typeForResidualValue(argument, span);
    }
    let resultType = this.typeForSimpleType(
      signature.result,
      span,
      new Set(),
      substitutions,
    );
    if (resultType === null && expectedResultType !== undefined) {
      resultType = this.typeForSimpleType(
        expectedResultType,
        span,
        new Set(),
        substitutions,
      );
    }
    if (resultType === null) {
      throw this.outside(
        span,
        `recursive function with an unsettled runtime signature ${
          showType(signature)
        }`,
      );
    }

    const functionId = this.reserveFunction();
    const captures = this.directFunctionCaptures(fn, span);
    const signatureId = this.signatures.length;
    this.signatures.push({
      parameters: [
        ...captures.map((capture) => capture.value.type),
        parameterType,
      ],
      result: resultType,
      effects: [],
    });
    const direct: ResidualValue = {
      kind: "direct-function",
      captures: captures.map((capture) => capture.value),
      function: functionId,
      parameterType,
      resultType,
    };
    const caller = {
      blocks: this.#blocks,
      currentBlock: this.#currentBlock,
      dynamicBranchDepth: this.#dynamicBranchDepth,
      functionCapabilities: this.#functionCapabilities,
      nextValue: this.#nextValue,
      residualOrigin: this.#residualOrigin,
      sourceHandlers: this.#sourceHandlers,
    };
    let effects: string[] = [];
    try {
      this.#blocks = [];
      this.#currentBlock = 0;
      this.#dynamicBranchDepth = 0;
      this.#functionCapabilities = new Set();
      this.#nextValue = 0;
      this.#residualOrigin = span;
      this.#sourceHandlers = [];
      const entry = this.block();
      const scope = this.environment(fn.environment, null);
      const functionCaptureValues: Extract<
        ResidualValue,
        { readonly kind: "dynamic" }
      >[] = [];
      for (const capture of captures) {
        const value = this.nextValue();
        entry.parameters.push({
          value,
          type: capture.value.type,
          ownership: this.ownership(capture.value.type),
          span: this.span(span),
        });
        const functionCapture: Extract<
          ResidualValue,
          { readonly kind: "dynamic" }
        > = {
          kind: "dynamic",
          value,
          type: capture.value.type,
        };
        functionCaptureValues.push(functionCapture);
        scope.names.set(capture.name, functionCapture);
      }
      const parameter = this.nextValue();
      entry.parameters.push({
        value: parameter,
        type: parameterType,
        ownership: this.ownership(parameterType),
        span: this.span(span),
      });
      for (const [key, type] of substitutions) {
        scope.typeSubstitutions.set(key, type);
      }
      scope.names.set(fn.self, {
        ...direct,
        captures: functionCaptureValues,
      });
      this.bind(
        fn.parameter,
        { kind: "dynamic", value: parameter, type: parameterType },
        scope,
        span,
      );
      const residual = this.evaluate(fn.body, scope);
      const result = this.materialize(residual, resultType, fn.body.span);
      this.terminate({
        kind: "return",
        value: result.value,
        span: this.span(fn.body.span),
      });
      effects = [...this.#functionCapabilities].sort();
      const blocks = this.#blocks.map((block) => {
        if (block.terminator === undefined) {
          throw new Error(
            `${this.#source}: residual block ${block.id} has no terminator`,
          );
        }
        return {
          id: block.id,
          parameters: block.parameters,
          operations: block.operations,
          terminator: block.terminator,
        };
      });
      this.signatures[signatureId] = {
        parameters: [
          ...captures.map((capture) => capture.value.type),
          parameterType,
        ],
        result: resultType,
        effects,
      };
      this.functions[functionId] = {
        id: functionId,
        name: `blot:recursive:${functionId}`,
        signature: signatureId,
        entryBlock: entry.id,
        blocks,
        span: this.span(fn.body.span),
      };
    } finally {
      this.#blocks = caller.blocks;
      this.#currentBlock = caller.currentBlock;
      this.#dynamicBranchDepth = caller.dynamicBranchDepth;
      this.#functionCapabilities = caller.functionCapabilities;
      this.#nextValue = caller.nextValue;
      this.#residualOrigin = caller.residualOrigin;
      this.#sourceHandlers = caller.sourceHandlers;
    }
    for (const effect of effects) this.#functionCapabilities.add(effect);
    return this.apply(direct, argument, span);
  }

  private directFunctionCaptures(
    fn: Extract<ResidualValue, { readonly kind: "closure" }>,
    span: Span,
  ): readonly {
    readonly name: string;
    readonly value: Extract<ResidualValue, { readonly kind: "dynamic" }>;
  }[] {
    const names = new Set(freeNames(sourceExpression(fn.body)));
    for (const name of patternNames(fn.parameter)) names.delete(name);
    if (fn.self !== null) names.delete(fn.self);
    const captures: {
      readonly name: string;
      readonly value: Extract<ResidualValue, { readonly kind: "dynamic" }>;
    }[] = [];
    for (const name of [...names].sort()) {
      const found = this.lookup(fn.environment, name);
      if (found === undefined) continue;
      const value = this.residualizeStatic(found, fn.environment);
      if (this.staticValue(value) !== undefined) continue;
      if (
        value.kind === "closure" || value.kind === "primitive" ||
        value.kind === "host-operation" || value.kind === "module-argument"
      ) continue;
      if (!this.valueContainsDynamic(value)) continue;
      const type = this.typeForResidualValue(value, span);
      captures.push({
        name,
        value: this.materialize(value, type, span),
      });
    }
    return captures;
  }

  private valueContainsDynamic(value: ResidualValue): boolean {
    if (value.kind === "dynamic") return true;
    if (value.kind === "array" || value.kind === "tuple") {
      return value.elements.some((element) =>
        this.valueContainsDynamic(element)
      );
    }
    if (value.kind === "shape") {
      return [...value.fields.values()].some((field) =>
        this.valueContainsDynamic(field)
      );
    }
    if (value.kind === "tag") return this.valueContainsDynamic(value.payload);
    return false;
  }

  private shouldLowerTailRecursion(
    body: ResidualExpression,
    self: string,
  ): boolean {
    const names = new Set([self]);
    if (
      recursiveCallsAreOwnershipTail(
        sourceExpression(body),
        names,
        true,
        false,
      )
    ) return true;
    if (this.#dynamicBranchDepth === 0) return false;
    return recursiveCallsAreOwnershipTail(
      sourceExpression(body),
      names,
      true,
    );
  }

  private recursionBecomesTailInBranch(
    body: ResidualExpression,
    self: string,
  ): boolean {
    if (this.#dynamicBranchDepth !== 0) return false;
    return recursiveCallsAreOwnershipTail(
      sourceExpression(body),
      new Set([self]),
      true,
    );
  }

  private withDynamicBranch<T>(run: () => T): T {
    this.#dynamicBranchDepth += 1;
    try {
      return run();
    } finally {
      this.#dynamicBranchDepth -= 1;
    }
  }

  private conditional(
    expr: ResidualIf,
    environment: ResidualEnvironment,
  ): ResidualValue {
    return this.conditionalBranch(expr, 0, environment);
  }

  private conditionalBranch(
    expr: ResidualIf,
    index: number,
    environment: ResidualEnvironment,
  ): ResidualValue {
    const branch = expr.branches[index];
    if (branch === undefined) {
      if (expr.fallback !== null) {
        return this.evaluate(expr.fallback, environment);
      }
      this.terminate({
        kind: "trap",
        message: "BLOT_NO_BRANCH: no conditional branch matched.",
        span: this.span(expr.span),
      });
      return { kind: "never" };
    }
    const condition = this.evaluate(branch.condition, environment);
    if (condition.kind === "never") return condition;
    const known = this.staticBoolean(condition);
    if (known !== undefined) {
      if (known) return this.evaluate(branch.consequence, environment);
      return this.conditionalBranch(expr, index + 1, environment);
    }
    const dynamicCondition = this.dynamic(condition);
    if (this.types[dynamicCondition.type].kind !== "boolean") {
      throw this.outside(
        branch.condition.span,
        "non-Boolean condition",
      );
    }
    const sourceBlock = this.current();
    const consequence = this.block();
    const alternate = this.block();
    sourceBlock.terminator = {
      kind: "conditional",
      condition: dynamicCondition.value,
      consequent: consequence.id,
      consequentArguments: [],
      alternate: alternate.id,
      alternateArguments: [],
      span: this.span(expr.span),
    };

    this.#currentBlock = consequence.id;
    const consequentValue = this.withDynamicBranch(() =>
      this.evaluate(branch.consequence, environment)
    );
    const consequenceEnd = this.#currentBlock;

    this.#currentBlock = alternate.id;
    const alternateValue = this.withDynamicBranch(() =>
      this.conditionalBranch(expr, index + 1, environment)
    );
    const alternateEnd = this.#currentBlock;

    return this.finishBranchJoin(
      consequentValue,
      alternateValue,
      consequenceEnd,
      alternateEnd,
      branch.consequence.span,
      expr.span,
      expr.span,
    );
  }

  private caseExpression(
    expr: ResidualCase,
    environment: ResidualEnvironment,
  ): ResidualValue {
    const target = this.evaluate(expr.target, environment);
    if (target.kind === "never") return target;
    if (target.kind === "tag") {
      for (const arm of expr.arms) {
        const scope = this.environment(environment, null);
        if (this.match(arm.pattern, target, scope)) {
          return this.evaluate(arm.body, scope);
        }
      }
      throw this.outside(expr.span, "non-exhaustive known-constructor case");
    }
    const staticTarget = this.staticValue(target);
    if (staticTarget !== undefined) {
      for (const arm of expr.arms) {
        const scope = this.environment(environment, null);
        if (
          this.match(
            arm.pattern,
            { kind: "static", value: staticTarget },
            scope,
          )
        ) {
          return this.evaluate(arm.body, scope);
        }
      }
      throw this.outside(expr.span, "non-exhaustive static case");
    }
    if (
      target.kind === "dynamic" && typeof target.meaning === "object" &&
      target.meaning.kind === "sum"
    ) {
      return this.sumCase(expr, target, target.meaning, environment);
    }
    if (target.kind === "dynamic") {
      const targetType = this.types[target.type];
      if (targetType.kind === "sum") {
        return this.sumCase(expr, target, {
          cases: targetType.cases.map((case_) => case_.name),
          payloadTypes: targetType.cases.map((case_) => case_.payloadType),
          wrappedPayloads: targetType.cases.map(() => false),
        }, environment);
      }
    }
    if (
      target.kind === "dynamic" &&
      this.types[target.type].kind === "boolean"
    ) {
      return this.booleanCase(expr, target, environment);
    }
    if (
      target.kind === "dynamic" && target.meaning === undefined &&
      this.types[target.type].kind === "signed-integer-64"
    ) {
      return this.integerCase(expr, target, environment);
    }
    if (
      target.kind !== "dynamic" ||
      (target.meaning !== "ordering" &&
        !(typeof target.meaning === "object" &&
          target.meaning.kind === "scalar-ordering"))
    ) {
      throw this.outside(expr.target.span, "dynamic non-ordering case");
    }
    const outcomes = new Map<-1 | 0 | 1, boolean>();
    for (const arm of expr.arms) {
      if (arm.pattern.tag !== "constructor" || arm.pattern.payload !== null) {
        throw this.outside(
          arm.pattern.span,
          "dynamic ordering payload pattern",
        );
      }
      const sign = arm.pattern.name === "Less"
        ? -1
        : arm.pattern.name === "Equal"
        ? 0
        : arm.pattern.name === "Greater"
        ? 1
        : undefined;
      if (sign === undefined) {
        throw this.outside(arm.pattern.span, "non-ordering constructor");
      }
      const outcome = this.staticBoolean(this.evaluate(arm.body, environment));
      if (outcome === undefined) {
        throw this.outside(arm.body.span, "non-Boolean ordering arm");
      }
      outcomes.set(sign, outcome);
    }
    if (outcomes.size !== 3) {
      throw this.outside(expr.span, "non-exhaustive ordering case");
    }
    const trueSigns = [...outcomes].filter(([, value]) => value).map(([sign]) =>
      sign
    );
    if (trueSigns.length === 0 || trueSigns.length === 3) {
      return {
        kind: "static",
        value: {
          tag: "tag",
          name: trueSigns.length === 3 ? "True" : "False",
          payload: null,
        },
      };
    }
    let right: ValueId;
    if (target.meaning === "ordering") {
      right = this.constant(0, this.type("integer-32"), expr.span).value;
    } else {
      right = target.meaning.right;
    }
    const operator = trueSigns.length === 1
      ? ({ [-1]: "less-than", [0]: "equal", [1]: "greater-than" } as const)[
        trueSigns[0]
      ]
      : !trueSigns.includes(-1)
      ? "greater-than-or-equal"
      : !trueSigns.includes(0)
      ? "not-equal"
      : "less-than-or-equal";
    return this.operation(
      "scalar",
      this.type("boolean"),
      [target.value, right],
      expr.span,
      undefined,
      operator,
    );
  }

  private booleanCase(
    expr: ResidualCase,
    target: Extract<ResidualValue, { kind: "dynamic" }>,
    environment: ResidualEnvironment,
  ): ResidualValue {
    const source = this.current();
    const trueBlock = this.block();
    const falseBlock = this.block();
    source.terminator = {
      kind: "conditional",
      condition: target.value,
      consequent: trueBlock.id,
      consequentArguments: [],
      alternate: falseBlock.id,
      alternateArguments: [],
      span: this.span(expr.span),
    };
    const evaluateArm = (
      name: "True" | "False",
      block: MutableBlock,
    ): {
      readonly arm: ResidualCase["arms"][number];
      readonly value: ResidualValue;
    } => {
      this.#currentBlock = block.id;
      for (const arm of expr.arms) {
        const scope = this.environment(environment, null);
        const matched = this.match(
          arm.pattern,
          {
            kind: "static",
            value: { tag: "tag", name, payload: null },
          },
          scope,
        );
        if (matched) return { arm, value: this.evaluate(arm.body, scope) };
      }
      throw this.outside(expr.span, "non-exhaustive Boolean case");
    };
    const consequent = this.withDynamicBranch(() =>
      evaluateArm("True", trueBlock)
    );
    const consequenceEnd = this.#currentBlock;
    const alternate = this.withDynamicBranch(() =>
      evaluateArm("False", falseBlock)
    );
    const alternateEnd = this.#currentBlock;
    return this.finishBranchJoin(
      consequent.value,
      alternate.value,
      consequenceEnd,
      alternateEnd,
      consequent.arm.body.span,
      alternate.arm.body.span,
      expr.span,
    );
  }

  private integerCase(
    expr: ResidualCase,
    target: Extract<ResidualValue, { kind: "dynamic" }>,
    environment: ResidualEnvironment,
  ): ResidualValue {
    const evaluateArm = (index: number): ResidualValue => {
      const arm = expr.arms[index];
      if (arm === undefined) {
        throw this.outside(expr.span, "non-exhaustive integer case");
      }
      if (arm.pattern.tag === "wildcard") {
        return this.evaluate(arm.body, this.environment(environment, null));
      }

      const expected = this.integerPatternValue(arm.pattern, environment);
      const constant = this.constant(
        expected,
        this.type("signed-integer-64"),
        arm.pattern.span,
      );
      const condition = this.operation(
        "scalar",
        this.type("boolean"),
        [target.value, constant.value],
        arm.pattern.span,
        undefined,
        "equal",
      );
      const source = this.current();
      const consequence = this.block();
      const alternate = this.block();
      source.terminator = {
        kind: "conditional",
        condition: condition.value,
        consequent: consequence.id,
        consequentArguments: [],
        alternate: alternate.id,
        alternateArguments: [],
        span: this.span(arm.pattern.span),
      };

      this.#currentBlock = consequence.id;
      const consequenceValue = this.withDynamicBranch(() =>
        this.evaluate(arm.body, this.environment(environment, null))
      );
      const consequenceEnd = this.#currentBlock;

      this.#currentBlock = alternate.id;
      const alternateValue = this.withDynamicBranch(() =>
        evaluateArm(index + 1)
      );
      const alternateEnd = this.#currentBlock;
      return this.finishBranchJoin(
        consequenceValue,
        alternateValue,
        consequenceEnd,
        alternateEnd,
        arm.body.span,
        expr.span,
        expr.span,
      );
    };

    return evaluateArm(0);
  }

  private integerPatternValue(
    pattern: Pattern,
    environment: ResidualEnvironment,
  ): bigint {
    if (pattern.tag === "int") return pattern.value;
    if (pattern.tag === "pin") {
      const pinned = this.lookup(environment, pattern.name);
      if (pinned !== undefined) {
        const value = this.staticValue(pinned);
        if (value?.tag === "int") return value.value;
      }
    }
    throw this.outside(pattern.span, "non-integer case pattern");
  }

  private sumCase(
    expr: ResidualCase,
    target: Extract<ResidualValue, { kind: "dynamic" }>,
    sum: {
      readonly cases: readonly string[];
      readonly payloadTypes: readonly TypeId[];
      readonly wrappedPayloads: readonly boolean[];
    },
    environment: ResidualEnvironment,
  ): ResidualValue {
    const cases = sum.cases;
    if (cases.length === 1) {
      const arm = expr.arms.find((candidate) =>
        candidate.pattern.tag === "constructor" &&
        candidate.pattern.name === cases[0]
      );
      if (arm === undefined) {
        throw this.outside(expr.span, "non-exhaustive dynamic sum case");
      }
      const payload = this.nextValue();
      this.current().operations.push({
        kind: "sum.payload",
        result: payload,
        type: sum.payloadTypes[0],
        operands: [target.value],
        ownership: this.ownership(sum.payloadTypes[0]),
        case: 0,
        span: this.span(expr.span),
      });
      const scope = this.environment(environment, null);
      const tagged: ResidualValue = {
        kind: "tag",
        name: cases[0],
        payload: sum.wrappedPayloads[0]
          ? {
            kind: "shape",
            fields: new Map([[
              "value",
              { kind: "dynamic", value: payload, type: sum.payloadTypes[0] },
            ]]),
          }
          : { kind: "dynamic", value: payload, type: sum.payloadTypes[0] },
      };
      if (!this.match(arm.pattern, tagged, scope)) {
        throw this.outside(arm.pattern.span, `sum pattern ${cases[0]}`);
      }
      return this.evaluate(arm.body, scope);
    }
    if (cases.length !== 2) {
      throw this.outside(expr.span, "sum case with more than two constructors");
    }
    const arms = cases.map((name) =>
      expr.arms.find((arm) =>
        arm.pattern.tag === "constructor" && arm.pattern.name === name
      )
    );
    if (arms.some((arm) => arm === undefined)) {
      throw this.outside(expr.span, "non-exhaustive dynamic sum case");
    }
    const tag = this.nextValue();
    this.current().operations.push({
      kind: "sum.tag",
      result: tag,
      type: this.type("integer-32"),
      operands: [target.value],
      ownership: "plain",
      span: this.span(expr.span),
    });
    const firstCase = this.constant(0, this.type("integer-32"), expr.span);
    const condition = this.operation(
      "scalar",
      this.type("boolean"),
      [tag, firstCase.value],
      expr.span,
      undefined,
      "equal",
    );
    const source = this.current();
    const consequence = this.block();
    const alternate = this.block();
    source.terminator = {
      kind: "conditional",
      condition: condition.value,
      consequent: consequence.id,
      consequentArguments: [],
      alternate: alternate.id,
      alternateArguments: [],
      span: this.span(expr.span),
    };
    const evaluateArm = (index: number, block: MutableBlock): ResidualValue => {
      this.#currentBlock = block.id;
      const payload = this.nextValue();
      this.current().operations.push({
        kind: "sum.payload",
        result: payload,
        type: sum.payloadTypes[index],
        operands: [target.value],
        ownership: "plain",
        case: index,
        span: this.span(expr.span),
      });
      const tagged: ResidualValue = {
        kind: "tag",
        name: cases[index],
        payload: sum.wrappedPayloads[index]
          ? {
            kind: "shape",
            fields: new Map([["value", {
              kind: "dynamic",
              value: payload,
              type: sum.payloadTypes[index],
            }]]),
          }
          : {
            kind: "dynamic",
            value: payload,
            type: sum.payloadTypes[index],
          },
      };
      const scope = this.environment(environment, null);
      const arm = arms[index]!;
      if (!this.match(arm.pattern, tagged, scope)) {
        throw this.outside(arm.pattern.span, `sum pattern ${cases[index]}`);
      }
      return this.evaluate(arm.body, scope);
    };
    const consequentValue = this.withDynamicBranch(() =>
      evaluateArm(0, consequence)
    );
    const consequenceEnd = this.#currentBlock;
    const alternateValue = this.withDynamicBranch(() =>
      evaluateArm(1, alternate)
    );
    const alternateEnd = this.#currentBlock;
    return this.finishBranchJoin(
      consequentValue,
      alternateValue,
      consequenceEnd,
      alternateEnd,
      arms[0]!.body.span,
      arms[1]!.body.span,
      expr.span,
    );
  }

  private finishBranchJoin(
    consequent: ResidualValue,
    alternate: ResidualValue,
    consequenceEnd: number,
    alternateEnd: number,
    consequenceSpan: Span,
    alternateSpan: Span,
    span: Span,
  ): ResidualValue {
    if (consequent.kind === "never" && alternate.kind === "never") {
      this.#currentBlock = alternateEnd;
      return { kind: "never" };
    }
    if (consequent.kind === "never") {
      this.#currentBlock = alternateEnd;
      return alternate;
    }
    if (alternate.kind === "never") {
      this.#currentBlock = consequenceEnd;
      return consequent;
    }
    const join = this.block();
    const joined = this.joinBranchValues(
      consequent,
      alternate,
      consequenceEnd,
      alternateEnd,
      span,
    );
    this.#currentBlock = consequenceEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.consequent.value],
      span: this.span(consequenceSpan),
    });
    this.#currentBlock = alternateEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.alternate.value],
      span: this.span(alternateSpan),
    });
    const joinedValue = this.nextValue();
    join.parameters.push({
      value: joinedValue,
      type: joined.type,
      ownership: this.ownership(joined.type),
      span: this.span(span),
    });
    this.#currentBlock = join.id;
    return {
      kind: "dynamic",
      value: joinedValue,
      type: joined.type,
      meaning: joined.meaning,
    };
  }

  private joinBranchValues(
    consequent: ResidualValue,
    alternate: ResidualValue,
    consequenceEnd: number,
    alternateEnd: number,
    span: Span,
  ): {
    readonly consequent: Extract<ResidualValue, { kind: "dynamic" }>;
    readonly alternate: Extract<ResidualValue, { kind: "dynamic" }>;
    readonly type: TypeId;
    readonly meaning?: Extract<ResidualValue, { kind: "dynamic" }>["meaning"];
  } {
    if (
      this.isEmptyStoreValue(consequent) && alternate.kind === "dynamic" &&
      this.types[alternate.type].kind === "store"
    ) {
      const selected = this.types[alternate.type];
      if (selected.kind !== "store") {
        throw new Error("a checked store type changed while joining branches");
      }
      this.#currentBlock = consequenceEnd;
      return {
        consequent: this.materialize(consequent, alternate.type, span),
        alternate,
        type: alternate.type,
      };
    }
    if (
      consequent.kind === "dynamic" && this.isEmptyStoreValue(alternate) &&
      this.types[consequent.type].kind === "store"
    ) {
      const selected = this.types[consequent.type];
      if (selected.kind !== "store") {
        throw new Error("a checked store type changed while joining branches");
      }
      this.#currentBlock = alternateEnd;
      return {
        consequent,
        alternate: this.materialize(alternate, consequent.type, span),
        type: consequent.type,
      };
    }
    const consequentBoolean = this.staticBoolean(consequent);
    const alternateBoolean = this.staticBoolean(alternate);
    if (
      consequentBoolean !== undefined && alternate.kind === "dynamic" &&
      this.types[alternate.type].kind === "boolean"
    ) {
      this.#currentBlock = consequenceEnd;
      return {
        consequent: this.constant(
          consequentBoolean,
          this.type("boolean"),
          span,
        ),
        alternate,
        type: alternate.type,
      };
    }
    if (
      consequent.kind === "dynamic" && alternateBoolean !== undefined &&
      this.types[consequent.type].kind === "boolean"
    ) {
      this.#currentBlock = alternateEnd;
      return {
        consequent,
        alternate: this.constant(
          alternateBoolean,
          this.type("boolean"),
          span,
        ),
        type: consequent.type,
      };
    }
    if (
      consequentBoolean !== undefined && alternateBoolean !== undefined
    ) {
      const type = this.type("boolean");
      this.#currentBlock = consequenceEnd;
      const consequentValue = this.constant(consequentBoolean, type, span);
      this.#currentBlock = alternateEnd;
      const alternateValue = this.constant(alternateBoolean, type, span);
      return {
        consequent: consequentValue,
        alternate: alternateValue,
        type,
      };
    }
    const consequentTag = this.residualTag(consequent);
    const alternateTag = this.residualTag(alternate);
    let consequentSum:
      | Extract<
        Extract<ResidualValue, { kind: "dynamic" }>["meaning"],
        { kind: "sum" }
      >
      | undefined;
    if (consequent.kind === "dynamic") {
      if (
        typeof consequent.meaning === "object" &&
        consequent.meaning.kind === "sum"
      ) {
        consequentSum = consequent.meaning;
      } else {
        const type = this.types[consequent.type];
        if (type.kind === "sum") {
          consequentSum = {
            kind: "sum",
            cases: type.cases.map((case_) => case_.name),
            payloadTypes: type.cases.map((case_) => case_.payloadType),
            wrappedPayloads: type.cases.map(() => false),
          };
        }
      }
    }
    let alternateSum:
      | Extract<
        Extract<ResidualValue, { kind: "dynamic" }>["meaning"],
        { kind: "sum" }
      >
      | undefined;
    if (alternate.kind === "dynamic") {
      if (
        typeof alternate.meaning === "object" &&
        alternate.meaning.kind === "sum"
      ) {
        alternateSum = alternate.meaning;
      } else {
        const type = this.types[alternate.type];
        if (type.kind === "sum") {
          alternateSum = {
            kind: "sum",
            cases: type.cases.map((case_) => case_.name),
            payloadTypes: type.cases.map((case_) => case_.payloadType),
            wrappedPayloads: type.cases.map(() => false),
          };
        }
      }
    }
    if (
      consequentTag !== null && alternate.kind === "dynamic" &&
      alternateSum !== undefined &&
      alternateSum.cases.includes(consequentTag.name)
    ) {
      this.#currentBlock = consequenceEnd;
      const consequentValue = this.materializeTag(
        consequentTag,
        alternate.type,
        alternateSum.cases,
        alternateSum.wrappedPayloads,
        span,
      );
      return {
        consequent: consequentValue,
        alternate,
        type: alternate.type,
        meaning: alternateSum,
      };
    }
    if (
      consequent.kind === "dynamic" && alternateTag !== null &&
      consequentSum !== undefined &&
      consequentSum.cases.includes(alternateTag.name)
    ) {
      this.#currentBlock = alternateEnd;
      const alternateValue = this.materializeTag(
        alternateTag,
        consequent.type,
        consequentSum.cases,
        consequentSum.wrappedPayloads,
        span,
      );
      return {
        consequent,
        alternate: alternateValue,
        type: consequent.type,
        meaning: consequentSum,
      };
    }
    if (consequentTag !== null && alternateTag !== null) {
      const cases = [...new Set([consequentTag.name, alternateTag.name])];
      const tagged = [consequentTag, alternateTag];
      const wrappedPayloads = cases.map((name) => {
        const selected = tagged.find((value) => value.name === name)!;
        return selected.payload.kind === "shape" &&
          selected.payload.fields.has("value");
      });
      const payloadTypes = cases.map((name) => {
        const selected = tagged.find((value) => value.name === name)!;
        const payload = selected.payload.kind === "shape"
          ? selected.payload.fields.get("value")
          : selected.payload;
        if (payload === undefined) {
          throw this.outside(span, `tag ${name} without value payload`);
        }
        return this.typeForResidualValue(payload, span);
      });
      const type = this.sumType(cases, payloadTypes);
      this.#currentBlock = consequenceEnd;
      const consequentValue = this.materializeTag(
        consequentTag,
        type,
        cases,
        wrappedPayloads,
        span,
      );
      this.#currentBlock = alternateEnd;
      const alternateValue = this.materializeTag(
        alternateTag,
        type,
        cases,
        wrappedPayloads,
        span,
      );
      return {
        consequent: consequentValue,
        alternate: alternateValue,
        type,
        meaning: { kind: "sum", cases, payloadTypes, wrappedPayloads },
      };
    }
    if (consequent.kind === "shape" && alternate.kind === "shape") {
      const type = this.commonBranchType(consequent, alternate, span);
      this.#currentBlock = consequenceEnd;
      const consequentValue = this.materialize(consequent, type, span);
      this.#currentBlock = alternateEnd;
      const alternateValue = this.materialize(alternate, type, span);
      return {
        consequent: consequentValue,
        alternate: alternateValue,
        type,
      };
    }
    this.#currentBlock = consequenceEnd;
    const consequentValue = this.dynamic(consequent);
    this.#currentBlock = alternateEnd;
    const alternateValue = this.dynamic(alternate);
    if (consequentValue.type !== alternateValue.type) {
      throw this.outside(span, "conditional branches with different types");
    }
    return {
      consequent: consequentValue,
      alternate: alternateValue,
      type: consequentValue.type,
      meaning: consequentValue.meaning === alternateValue.meaning
        ? consequentValue.meaning
        : undefined,
    };
  }

  private commonBranchType(
    left: ResidualValue,
    right: ResidualValue,
    span: Span,
  ): TypeId {
    if (this.isEmptyStoreValue(left)) {
      const rightType = this.typeForResidualValue(right, span);
      if (this.types[rightType].kind === "store") return rightType;
    }
    if (this.isEmptyStoreValue(right)) {
      const leftType = this.typeForResidualValue(left, span);
      if (this.types[leftType].kind === "store") return leftType;
    }
    if (
      left.kind === "tuple" && right.kind === "tuple" &&
      left.elements.length === right.elements.length
    ) {
      return this.productTypeFromRuntimeFields(
        new Map(
          left.elements.map((element, index) => [
            String(index),
            this.commonBranchType(element, right.elements[index], span),
          ]),
        ),
      );
    }
    if (left.kind === "shape" && right.kind === "shape") {
      const fields = new Map<string, TypeId>();
      for (const [name, leftField] of left.fields) {
        const rightField = right.fields.get(name);
        if (rightField === undefined) {
          throw this.outside(span, "conditional record fields disagree");
        }
        fields.set(name, this.commonBranchType(leftField, rightField, span));
      }
      if (fields.size !== right.fields.size) {
        throw this.outside(span, "conditional record fields disagree");
      }
      return this.productTypeFromRuntimeFields(fields);
    }
    const leftType = this.typeForResidualValue(left, span);
    const rightType = this.typeForResidualValue(right, span);
    if (leftType !== rightType) {
      throw this.outside(span, "conditional branches with different types");
    }
    return leftType;
  }

  private residualTag(
    value: ResidualValue,
  ): Extract<ResidualValue, { readonly kind: "tag" }> | null {
    if (value.kind === "tag") return value;
    const known = this.staticValue(value);
    if (
      known?.tag !== "tag" ||
      (known.payload === null &&
        (known.name === "True" || known.name === "False"))
    ) return null;
    return {
      kind: "tag",
      name: known.name,
      payload: {
        kind: "static",
        value: known.payload ?? { tag: "unit" },
      },
    };
  }

  private isEmptyStoreValue(value: ResidualValue): boolean {
    if (value.kind === "empty-store") return true;
    if (value.kind === "array") return value.elements.length === 0;
    if (value.kind === "static" && value.value.tag === "array") {
      return value.value.elements.length === 0;
    }
    return false;
  }

  private materializeTag(
    tagged: Extract<ResidualValue, { kind: "tag" }>,
    type: TypeId,
    cases: readonly string[],
    wrappedPayloads: readonly boolean[],
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const selectedCase = cases.indexOf(tagged.name);
    const selectedType = this.types[type];
    if (selectedType.kind !== "sum" || selectedCase < 0) {
      throw this.outside(span, `tag ${tagged.name} outside its sum`);
    }
    let payload: ResidualValue | undefined = tagged.payload;
    if (wrappedPayloads[selectedCase] && payload.kind === "shape") {
      payload = payload.fields.get("value");
    }
    if (payload === undefined) {
      throw this.outside(span, `tag ${tagged.name} without value payload`);
    }
    const dynamicPayload = this.materialize(
      payload,
      selectedType.cases[selectedCase].payloadType,
      span,
    );
    const result = this.nextValue();
    this.current().operations.push({
      kind: "sum.make",
      result,
      type,
      operands: [dynamicPayload.value],
      ownership: this.ownership(type),
      case: selectedCase,
      span: this.span(span),
    });
    return {
      kind: "dynamic",
      value: result,
      type,
      meaning: {
        kind: "sum",
        cases,
        payloadTypes: selectedType.cases.map((candidate) =>
          candidate.payloadType
        ),
        wrappedPayloads,
      },
    };
  }

  private hostCall(
    operation: Extract<Value, { readonly tag: "operation" }>,
    argument: ResidualValue,
    span: Span,
  ): ResidualValue {
    if (operation.effect.tag !== "effect" || !operation.effect.host) {
      throw this.outside(span, "non-host effect operation");
    }
    const arrow = operation.effect.operations.get(operation.name);
    if (arrow === undefined || arrow.tag !== "arrow") {
      throw new Error(
        `${this.#source}:${span.start}: checked host operation ${operation.name} has no arrow signature`,
      );
    }
    this.#functionCapabilities.add(operation.effect.name);
    const parameterType = this.typeFromValue(arrow.domain, span);
    const resultType = this.typeFromValue(arrow.codomain, span);
    const dynamicArgument = this.materialize(argument, parameterType, span);
    const key = `${parameterType}->${resultType}`;
    const operations = this.#capabilityOperations.get(operation.effect.name) ??
      new Map<string, { readonly signature: number; readonly key: string }>();
    const existing = operations.get(operation.name);
    if (existing !== undefined && existing.key !== key) {
      throw new TypeError(
        `${this.#source}:${span.start}: host operation ${operation.effect.name}.${operation.name} has inconsistent signatures`,
      );
    }
    if (existing === undefined) {
      const signature = this.signatures.length;
      this.signatures.push({
        parameters: [parameterType],
        result: resultType,
        effects: [operation.effect.name],
      });
      operations.set(operation.name, { signature, key });
      this.#capabilityOperations.set(operation.effect.name, operations);
    }
    const result = this.nextValue();
    this.current().operations.push({
      kind: "host.call",
      result,
      type: resultType,
      operands: [dynamicArgument.value],
      ownership: this.ownership(resultType),
      capability: operation.effect.name,
      operation: operation.name,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: resultType };
  }

  private hostGrantCall(
    operation: Extract<ResidualValue, { readonly kind: "host-operation" }>,
    argument: ResidualValue,
    span: Span,
  ): ResidualValue {
    this.#functionCapabilities.add(operation.capability);
    let parameterType = this.typeForSimpleType(
      operation.grant.parameter,
      span,
      new Set(),
    );
    if (parameterType === null) {
      parameterType = this.typeForResidualValue(argument, span);
    }
    let resultType = this.typeForSimpleType(
      operation.grant.result,
      span,
      new Set(),
    );
    if (resultType === null) resultType = this.type("unit");
    const dynamicArgument = this.materialize(argument, parameterType, span);
    const key = `${parameterType}->${resultType}`;
    let operations = this.#capabilityOperations.get(operation.capability);
    if (operations === undefined) {
      operations = new Map<
        string,
        { readonly signature: number; readonly key: string }
      >();
    }
    const existing = operations.get(operation.operation);
    if (existing !== undefined && existing.key !== key) {
      throw new TypeError(
        `${this.#source}:${span.start}: host operation ` +
          `${operation.capability}.${operation.operation} has inconsistent signatures`,
      );
    }
    if (existing === undefined) {
      const signature = this.signatures.length;
      this.signatures.push({
        parameters: [parameterType],
        result: resultType,
        effects: [operation.capability],
      });
      operations.set(operation.operation, { signature, key });
      this.#capabilityOperations.set(operation.capability, operations);
    }
    const result = this.nextValue();
    this.current().operations.push({
      kind: "host.call",
      result,
      type: resultType,
      operands: [dynamicArgument.value],
      ownership: this.ownership(resultType),
      capability: operation.capability,
      operation: operation.operation,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: resultType };
  }

  private handleSourceEffect(
    arguments_: readonly ResidualExpression[],
    environment: ResidualEnvironment,
    span: Span,
  ): ResidualValue {
    const selected = this.evaluate(arguments_[0], environment);
    if (selected.kind !== "static") {
      throw this.outside(span, "dynamic handled effect");
    }
    let effect = selected.value;
    while (effect.tag === "extended") effect = effect.inner;
    if (effect.tag !== "effect" || effect.host) {
      throw this.outside(span, "handled value that is not a source effect");
    }

    const computation = this.evaluate(arguments_[1], environment);
    const handler = this.residualizeStatic(
      this.evaluate(arguments_[2], environment),
      environment,
    );
    if (handler.kind !== "shape") {
      throw this.outside(span, "dynamic source effect handler");
    }

    this.#sourceHandlers.push({ effect: effect.id, handler });
    let result: ResidualValue;
    try {
      result = this.apply(
        computation,
        { kind: "static", value: { tag: "unit" } },
        span,
      );
    } finally {
      this.#sourceHandlers.pop();
    }

    const returnClause = handler.fields.get("return");
    return returnClause === undefined
      ? result
      : this.apply(returnClause, result, span);
  }

  private sourceCall(
    operation: Extract<Value, { readonly tag: "operation" }>,
    argument: ResidualValue,
    span: Span,
  ): ResidualValue {
    if (operation.effect.tag !== "effect") {
      throw this.outside(span, "source operation without an effect");
    }
    let index = this.#sourceHandlers.length - 1;
    while (
      index >= 0 &&
      this.#sourceHandlers[index].effect !== operation.effect.id
    ) index -= 1;
    if (index < 0) {
      throw this.outside(
        span,
        `unhandled source effect ${operation.effect.name}.${operation.name}`,
      );
    }

    const selected = this.#sourceHandlers[index];
    const clause = this.project(selected.handler, operation.name, span);
    const resumed = `resumed$${span.start}$${this.#nextValue}`;
    const resume: ResidualValue = {
      kind: "closure",
      parameter: {
        tag: "name",
        name: resumed,
        qualifier: "affine",
        span,
      },
      body: { tag: "var", name: resumed, span },
      environment: this.environment(null, null),
      self: null,
    };

    this.#sourceHandlers.splice(index, 1);
    try {
      return this.apply(
        clause,
        { kind: "tuple", elements: [argument, resume] },
        span,
      );
    } finally {
      this.#sourceHandlers.splice(index, 0, selected);
    }
  }

  private project(
    value: ResidualValue,
    name: string,
    span: Span,
  ): ResidualValue {
    if (value.kind === "never") return value;
    if (value.kind === "tuple") {
      const index = Number(name);
      if (Number.isSafeInteger(index) && index >= 0) {
        const element = value.elements[index];
        if (element !== undefined) return element;
      }
    }
    if (value.kind === "shape") {
      const field = value.fields.get(name);
      if (field !== undefined) return field;
    }
    if (value.kind === "module-argument") {
      const field = value.fields.get(name);
      if (field !== undefined) return field;
      return this.unsupported(
        span,
        `module capability ${name} is not a function`,
      );
    }
    if (value.kind === "dynamic") {
      const type = this.types[value.type];
      if (type.kind !== "product") {
        throw this.outside(span, `field ${name} of non-record host value`);
      }
      const field = type.fields.findIndex((candidate) =>
        candidate.name === name
      );
      if (field < 0) throw this.outside(span, `missing field ${name}`);
      const result = this.nextValue();
      this.current().operations.push({
        kind: "product.project",
        result,
        type: type.fields[field].type,
        operands: [value.value],
        ownership: this.ownership(type.fields[field].type),
        field,
        span: this.span(span),
      });
      return {
        kind: "dynamic",
        value: result,
        type: type.fields[field].type,
      };
    }
    if (value.kind !== "static") {
      throw this.outside(span, `dynamic projection from ${value.kind}`);
    }
    let target = value.value;
    while (target.tag === "extended") {
      const member = target.members.get(name);
      if (member !== undefined) return { kind: "static", value: member };
      target = target.inner;
    }
    if (target.tag === "shape") {
      const field = target.fields.get(name);
      if (field !== undefined) return { kind: "static", value: field };
    }
    if (target.tag === "effect" && target.operations.has(name)) {
      return {
        kind: "static",
        value: { tag: "operation", effect: target, name },
      };
    }
    throw this.outside(span, `missing field ${name}`);
  }

  private bind(
    pattern: Pattern,
    value: ResidualValue,
    environment: ResidualEnvironment,
    span: Span,
  ): void {
    if (!this.match(pattern, value, environment)) {
      throw this.outside(span, "residual pattern mismatch");
    }
  }

  private match(
    pattern: Pattern,
    value: ResidualValue,
    environment: ResidualEnvironment,
  ): boolean {
    if (pattern.tag === "wildcard") return true;
    if (pattern.tag === "name") {
      let bindable = value;
      if (
        value.kind === "array" && this.staticValue(value) === undefined
      ) {
        let elementType = value.elementType;
        if (elementType === undefined) {
          const first = value.elements[0];
          if (first === undefined) {
            throw this.outside(pattern.span, "untyped dynamic empty array");
          }
          elementType = this.typeForResidualValue(first, pattern.span);
        }
        bindable = {
          ...this.materialize(
            value,
            this.storeType(elementType),
            pattern.span,
          ),
          meaning: "fresh-store",
        };
      }
      let bound = bindable;
      if (
        bindable.kind === "dynamic" && bindable.meaning === "fresh-store"
      ) {
        if (pattern.qualifier === "linear") {
          bound = { ...bindable, meaning: "reusable-store" };
        } else {
          bound = {
            kind: "dynamic",
            value: bindable.value,
            type: bindable.type,
          };
        }
      }
      environment.names.set(pattern.name, bound);
      return true;
    }
    if (pattern.tag === "tuple" && value.kind === "tuple") {
      return pattern.elements.length === value.elements.length &&
        pattern.elements.every((element, index) =>
          this.match(element, value.elements[index], environment)
        );
    }
    if (pattern.tag === "tuple" && value.kind === "dynamic") {
      const type = this.types[value.type];
      if (type.kind !== "product") return false;
      if (type.fields.length !== pattern.elements.length) return false;
      return pattern.elements.every((element, index) =>
        this.match(
          element,
          this.project(value, String(index), element.span),
          environment,
        )
      );
    }
    if (pattern.tag === "constructor" && value.kind === "tag") {
      if (pattern.name !== value.name) return false;
      return pattern.payload === null ||
        this.match(pattern.payload, value.payload, environment);
    }
    if (pattern.tag === "shape" && value.kind === "shape") {
      return pattern.fields.every((field) => {
        const member = value.fields.get(field.name);
        return member !== undefined && this.match(
          field.pattern,
          member,
          environment,
        );
      });
    }
    if (pattern.tag === "shape" && value.kind === "module-argument") {
      return pattern.fields.every((field) => {
        const member = value.fields.get(field.name);
        return member !== undefined && this.match(
          field.pattern,
          member,
          environment,
        );
      });
    }
    if (pattern.tag === "shape" && value.kind === "dynamic") {
      if (this.types[value.type].kind !== "product") return false;
      return pattern.fields.every((field) =>
        this.match(
          field.pattern,
          this.project(value, field.name, field.pattern.span),
          environment,
        )
      );
    }
    const staticValue = this.staticValue(value);
    if (staticValue === undefined) return false;
    if (pattern.tag === "unit") return staticValue.tag === "unit";
    if (pattern.tag === "text") {
      return staticValue.tag === "text" && staticValue.value === pattern.value;
    }
    if (pattern.tag === "int") {
      return staticValue.tag === "int" && staticValue.value === pattern.value;
    }
    if (pattern.tag === "constructor") {
      if (staticValue.tag !== "tag" || staticValue.name !== pattern.name) {
        return false;
      }
      if (pattern.payload === null) return staticValue.payload === null;
      return staticValue.payload !== null && this.match(
        pattern.payload,
        { kind: "static", value: staticValue.payload },
        environment,
      );
    }
    return false;
  }

  private dynamic(
    value: ResidualValue,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    if (value.kind === "dynamic") return value;
    if (
      value.kind === "array" || value.kind === "shape" ||
      value.kind === "tuple"
    ) {
      const span = { start: 0, end: 0 };
      const type = this.typeForResidualValue(value, span);
      return this.materialize(value, type, span);
    }
    if (value.kind === "empty-store" && value.elementType !== undefined) {
      return this.emptyStore(value.elementType, { start: 0, end: 0 });
    }
    const staticValue = this.staticValue(value);
    if (staticValue === undefined) {
      throw new TypeError(
        `${this.#source}: residual ${value.kind} cannot enter Runtime HIR`,
      );
    }
    if (staticValue.tag === "unit") {
      return this.constant(null, this.type("unit"), { start: 0, end: 0 });
    }
    if (staticValue.tag === "text") {
      return this.constant(staticValue.value, this.type("text"), {
        start: 0,
        end: 0,
      });
    }
    if (staticValue.tag === "int") {
      return this.constant(
        staticValue.value,
        this.type("signed-integer-64"),
        { start: 0, end: 0 },
      );
    }
    if (staticValue.tag === "float") {
      return this.constant(
        staticValue.value,
        this.type("float-64"),
        { start: 0, end: 0 },
      );
    }
    if (staticValue.tag === "float32") {
      return this.constant(
        staticValue.value,
        this.type("float-32"),
        { start: 0, end: 0 },
      );
    }
    if (staticValue.tag === "vector") {
      return this.materializeVector(staticValue, { start: 0, end: 0 });
    }
    if (staticValue.tag === "vector-mask") {
      return this.materializeMask(staticValue, { start: 0, end: 0 });
    }
    if (
      staticValue.tag === "tag" && staticValue.payload === null &&
      (staticValue.name === "True" || staticValue.name === "False")
    ) {
      return this.constant(
        staticValue.name === "True",
        this.type("boolean"),
        { start: 0, end: 0 },
      );
    }
    if (staticValue.tag === "shape" || staticValue.tag === "array") {
      const span = { start: 0, end: 0 };
      const type = this.typeForResidualValue(value, span);
      return this.materialize(value, type, span);
    }
    if (staticValue.tag === "region-array") {
      const span = { start: 0, end: 0 };
      const first = staticValue.store.cells[0];
      if (first === undefined) {
        throw this.outside(span, "empty residual Region representation");
      }
      const elementType = this.typeForResidualValue(
        { kind: "static", value: first },
        span,
      );
      const store = this.materialize(
        {
          kind: "array",
          elements: staticValue.store.cells.map((cell) => ({
            kind: "static",
            value: cell,
          })),
          elementType,
        },
        this.storeType(elementType),
        span,
      );
      const start = this.constant(
        BigInt(staticValue.start),
        this.type("signed-integer-64"),
        span,
      );
      const end = this.constant(
        BigInt(staticValue.end),
        this.type("signed-integer-64"),
        span,
      );
      return this.makeRegion(store, start, end, span);
    }
    if (staticValue.tag === "region-rejoin") {
      return this.constant(null, this.type("unit"), { start: 0, end: 0 });
    }
    if (staticValue.tag === "sealed") {
      return this.dynamic({ kind: "static", value: staticValue.inner });
    }
    throw new TypeError(
      `${this.#source}: static ${staticValue.tag} is outside the residual Runtime-HIR calculus`,
    );
  }

  private materialize(
    value: ResidualValue,
    expectedType: TypeId,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    if (value.kind === "dynamic") {
      if (value.type !== expectedType) {
        throw this.outside(span, "host argument type disagreement");
      }
      return value;
    }
    const expected = this.types[expectedType];
    if (expected.kind === "sum") {
      const tagged = this.residualTag(value);
      if (tagged === null) {
        throw this.outside(span, "non-constructor sum value");
      }
      return this.materializeTag(
        tagged,
        expectedType,
        expected.cases.map((case_) => case_.name),
        expected.cases.map(() => false),
        span,
      );
    }
    if (expected.kind === "sealed") {
      if (value.kind !== "static" || value.value.tag !== "sealed") {
        throw this.outside(span, `non-sealed value for ${expected.name}`);
      }
      if (value.value.name !== expected.name) {
        throw this.outside(
          span,
          `sealed value ${value.value.name} for ${expected.name}`,
        );
      }
      const representation = this.materialize(
        { kind: "static", value: value.value.inner },
        expected.representationType,
        span,
      );
      const result = this.nextValue();
      this.current().operations.push({
        kind: "seal.wrap",
        result,
        type: expectedType,
        operands: [representation.value],
        ownership: "owned",
        span: this.span(span),
      });
      return { kind: "dynamic", value: result, type: expectedType };
    }
    if (expected.kind === "store") {
      if (value.kind === "empty-store") {
        return this.emptyStore(expected.elementType, span);
      }
      let elements: readonly ResidualValue[] | undefined;
      if (value.kind === "array") elements = value.elements;
      if (value.kind === "static" && value.value.tag === "array") {
        elements = value.value.elements.map((element) => ({
          kind: "static",
          value: element,
        }));
      }
      if (elements === undefined) {
        throw this.outside(span, "non-array Store value");
      }
      let store = this.emptyStore(expected.elementType, span);
      let index = 0;
      for (const element of elements) {
        index += 1;
        const grownLength = this.constant(
          BigInt(index),
          this.type("signed-integer-64"),
          span,
        );
        const dynamicElement = this.materialize(
          element,
          expected.elementType,
          span,
        );
        const result = this.nextValue();
        this.current().operations.push({
          kind: "store.grow",
          result,
          type: expectedType,
          operands: [store.value, grownLength.value, dynamicElement.value],
          ownership: "owned",
          update: "persistent",
          span: this.span(span),
        });
        store = { kind: "dynamic", value: result, type: expectedType };
      }
      return store;
    }
    if (expected.kind !== "product") {
      const scalar = this.dynamic(value);
      if (scalar.type !== expectedType) {
        throw this.outside(span, "host argument type disagreement");
      }
      return scalar;
    }

    let fields: ReadonlyMap<string, ResidualValue> | undefined;
    if (value.kind === "shape") fields = value.fields;
    if (value.kind === "tuple") {
      fields = new Map(
        value.elements.map((element, index) => [String(index), element]),
      );
    }
    if (value.kind === "static" && value.value.tag === "shape") {
      fields = new Map(
        [...value.value.fields].map(([name, field]) => [
          name,
          { kind: "static", value: field } as const,
        ]),
      );
    }
    if (fields === undefined) {
      throw this.outside(span, "non-record host argument");
    }
    const operands = expected.fields.map((field) => {
      const fieldValue = fields.get(field.name);
      if (fieldValue === undefined) {
        throw this.outside(span, `host argument missing field ${field.name}`);
      }
      return this.materialize(fieldValue, field.type, span).value;
    });
    const result = this.nextValue();
    this.current().operations.push({
      kind: "product.make",
      result,
      type: expectedType,
      operands,
      ownership: "owned",
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: expectedType };
  }

  private typeForResidualValue(value: ResidualValue, span: Span): TypeId {
    if (value.kind === "dynamic") return value.type;
    if (value.kind === "closure") {
      return this.unsupported(span, "function export");
    }
    if (value.kind === "module-argument") {
      return this.unsupported(span, "module argument as a runtime value");
    }
    if (value.kind === "empty-store" && value.elementType !== undefined) {
      return this.storeType(value.elementType);
    }
    if (value.kind === "array") {
      const first = value.elements[0];
      if (first === undefined) {
        if (value.elementType !== undefined) {
          return this.storeType(value.elementType);
        }
        throw this.outside(span, "untyped empty residual array");
      }
      const elementType = this.typeForResidualValue(first, span);
      for (const element of value.elements.slice(1)) {
        if (this.typeForResidualValue(element, span) !== elementType) {
          throw this.outside(span, "residual array element type disagreement");
        }
      }
      return this.storeType(elementType);
    }
    if (value.kind === "shape") {
      const fields = new Map<string, TypeId>();
      for (const [name, field] of value.fields) {
        fields.set(name, this.typeForResidualValue(field, span));
      }
      return this.productTypeFromRuntimeFields(fields);
    }
    if (value.kind === "tuple") {
      return this.productTypeFromRuntimeFields(
        new Map(
          value.elements.map((element, index) => [
            String(index),
            this.typeForResidualValue(element, span),
          ]),
        ),
      );
    }
    const staticValue = this.staticValue(value);
    if (staticValue === undefined) {
      throw this.outside(span, `runtime type for ${value.kind}`);
    }
    if (staticValue.tag === "unit") return this.type("unit");
    if (staticValue.tag === "int") return this.type("signed-integer-64");
    if (staticValue.tag === "float") return this.type("float-64");
    if (staticValue.tag === "float32") return this.type("float-32");
    if (staticValue.tag === "vector") {
      return this.simdType(staticValue.element, false);
    }
    if (staticValue.tag === "vector-mask") {
      return this.simdType(staticValue.element, true);
    }
    if (staticValue.tag === "text") return this.type("text");
    if (
      staticValue.tag === "tag" && staticValue.payload === null &&
      (staticValue.name === "True" || staticValue.name === "False")
    ) {
      return this.type("boolean");
    }
    if (staticValue.tag === "tag") {
      const payload = staticValue.payload;
      let payloadValue: Value = { tag: "unit" };
      if (payload !== null) payloadValue = payload;
      const payloadType = this.typeForResidualValue(
        { kind: "static", value: payloadValue },
        span,
      );
      return this.sumType([staticValue.name], [payloadType]);
    }
    if (staticValue.tag === "sealed") {
      const representationType = this.typeForResidualValue(
        { kind: "static", value: staticValue.inner },
        span,
      );
      return this.sealedType(staticValue.name, representationType);
    }
    if (staticValue.tag === "closure" || staticValue.tag === "core-closure") {
      return this.unsupported(span, "function export");
    }
    if (staticValue.tag === "array") {
      const first = staticValue.elements[0];
      if (first === undefined) {
        throw this.outside(span, "untyped empty residual array");
      }
      const elementType = this.typeForResidualValue(
        { kind: "static", value: first },
        span,
      );
      for (const element of staticValue.elements.slice(1)) {
        const type = this.typeForResidualValue(
          { kind: "static", value: element },
          span,
        );
        if (type !== elementType) {
          throw this.outside(span, "residual array element type disagreement");
        }
      }
      return this.storeType(elementType);
    }
    if (staticValue.tag === "region-array") {
      const first = staticValue.store.cells[0];
      if (first === undefined) {
        throw this.outside(span, "empty residual Region representation");
      }
      const elementType = this.typeForResidualValue(
        { kind: "static", value: first },
        span,
      );
      return this.regionType(this.storeType(elementType));
    }
    if (staticValue.tag === "region-rejoin") return this.type("unit");
    if (staticValue.tag === "shape") {
      const fields = new Map<string, TypeId>();
      for (const [name, field] of staticValue.fields) {
        fields.set(
          name,
          this.typeForResidualValue({ kind: "static", value: field }, span),
        );
      }
      return this.productTypeFromRuntimeFields(fields);
    }
    throw this.outside(span, `runtime type for static ${staticValue.tag}`);
  }

  private typeForExportValue(
    value: ResidualValue,
    sourceName: string,
    namedExport: boolean,
    span: Span,
  ): TypeId {
    const exported = this.checkedExportType(
      this.#checked.moduleType,
      sourceName,
      namedExport,
      new Set(),
    );
    if (exported !== null) {
      const expected = this.typeForSimpleType(exported, span, new Set());
      if (expected !== null) return expected;
      if (this.residualTag(value) !== null) {
        const cases = this.variantCasesForSimpleType(exported, new Set());
        if (cases !== null) {
          const names = [...cases.keys()];
          if (
            names.length > 0 &&
            names.every((name) => name === "True" || name === "False") &&
            [...cases.values()].every((payload) => payload.tag === "unit")
          ) {
            return this.type("boolean");
          }
          const payloadTypes: TypeId[] = [];
          for (const payload of cases.values()) {
            const payloadType = this.typeForSimpleType(
              payload,
              span,
              new Set(),
            );
            if (payloadType === null) {
              return this.typeForResidualValue(value, span);
            }
            payloadTypes.push(payloadType);
          }
          return this.sumType(names, payloadTypes);
        }
      }
    }
    return this.typeForResidualValue(value, span);
  }

  private checkedExportType(
    type: SimpleType,
    sourceName: string,
    namedExport: boolean,
    seen: Set<number>,
  ): SimpleType | null {
    if (!namedExport) return type;
    if (type.tag === "record") {
      const field = type.fields.get(sourceName);
      if (field !== undefined) return field;
      return null;
    }
    if (type.tag !== "var" || seen.has(type.id)) return null;
    seen.add(type.id);
    for (const bound of [...type.lower, ...type.upper]) {
      const field = this.checkedExportType(
        bound,
        sourceName,
        namedExport,
        seen,
      );
      if (field !== null) return field;
    }
    return null;
  }

  private typeForSimpleType(
    type: SimpleType,
    span: Span,
    seen: Set<number>,
    substitutions: ReadonlyMap<string, TypeId> = new Map(),
  ): TypeId | null {
    if (type.tag === "unit") return this.type("unit");
    if (type.tag === "range") {
      if (type.domain === "int") return this.type("signed-integer-64");
      if (type.domain === "float") return this.type("float-64");
      if (type.domain === "float32") return this.type("float-32");
      return this.type("text");
    }
    if (type.tag === "record") {
      const fields = new Map<string, TypeId>();
      for (const [name, field] of type.fields) {
        const fieldType = this.typeForSimpleType(
          field,
          span,
          new Set(seen),
          substitutions,
        );
        if (fieldType === null) return null;
        fields.set(name, fieldType);
      }
      return this.productTypeFromRuntimeFields(fields);
    }
    if (type.tag === "array") {
      const elementType = this.typeForSimpleType(
        type.element,
        span,
        seen,
        substitutions,
      );
      if (elementType === null) return null;
      return this.storeType(elementType);
    }
    if (type.tag === "region") {
      const elementType = this.typeForSimpleType(
        type.element,
        span,
        seen,
        substitutions,
      );
      if (elementType === null) return null;
      return this.regionType(this.storeType(elementType));
    }
    if (type.tag === "variant") {
      if (type.open) return null;
      const cases = [...type.cases.keys()];
      if (
        cases.length > 0 &&
        cases.every((name) => name === "True" || name === "False") &&
        [...type.cases.values()].every((payload) => payload.tag === "unit")
      ) {
        return this.type("boolean");
      }
      const payloadTypes: TypeId[] = [];
      for (const payload of type.cases.values()) {
        const payloadType = this.typeForSimpleType(
          payload,
          span,
          seen,
          substitutions,
        );
        if (payloadType === null) return null;
        payloadTypes.push(payloadType);
      }
      return this.sumType(cases, payloadTypes);
    }
    if (type.tag === "forall") {
      return this.typeForSimpleType(type.body, span, seen, substitutions);
    }
    if (type.tag === "var" || type.tag === "rigid") {
      const substituted = substitutions.get(this.typeVariableKey(type));
      if (substituted !== undefined) return substituted;
    }
    if (type.tag === "var") {
      if (seen.has(type.id)) return null;
      seen.add(type.id);
      const representations = new Set<TypeId>();
      for (const bound of [...type.lower, ...type.upper]) {
        const representation = this.typeForSimpleType(
          bound,
          span,
          new Set(seen),
          substitutions,
        );
        if (representation !== null) representations.add(representation);
      }
      if (representations.size !== 1) return null;
      return representations.values().next().value as TypeId;
    }
    if (type.tag === "union") {
      const representations = new Set<TypeId>();
      for (const member of type.members) {
        const representation = this.typeForSimpleType(
          member,
          span,
          new Set(seen),
          substitutions,
        );
        if (representation !== null) representations.add(representation);
      }
      if (representations.size !== 1) return null;
      return representations.values().next().value as TypeId;
    }
    if (type.tag === "opaque") {
      const simd = this.simdTypeFromName(type.name);
      if (simd !== undefined) return simd;
    }
    return null;
  }

  private recordRuntimeTypeSubstitutions(
    signature: SimpleType | undefined,
    argument: ResidualValue,
    substitutions: Map<string, TypeId>,
    span: Span,
  ): void {
    if (signature === undefined) return;
    let functionType = signature;
    while (functionType.tag === "forall") functionType = functionType.body;
    if (functionType.tag !== "fun") return;
    this.recordRuntimeType(
      functionType.param,
      argument,
      substitutions,
      span,
    );
  }

  private recordRuntimeType(
    type: SimpleType,
    value: ResidualValue,
    substitutions: Map<string, TypeId>,
    span: Span,
  ): void {
    if (type.tag === "forall") {
      this.recordRuntimeType(type.body, value, substitutions, span);
      return;
    }
    if (type.tag === "var" || type.tag === "rigid") {
      if (this.valueHasUntypedStore(value)) {
        if (type.tag === "var") {
          for (const bound of [...type.lower, ...type.upper]) {
            this.recordRuntimeType(bound, value, substitutions, span);
          }
        }
        return;
      }
      if (
        value.kind === "closure" || value.kind === "primitive" ||
        value.kind === "host-operation" || value.kind === "module-argument" ||
        value.kind === "tail-loop" || value.kind === "direct-function" ||
        value.kind === "never"
      ) return;
      const runtimeType = this.typeForResidualValue(value, span);
      substitutions.set(this.typeVariableKey(type), runtimeType);
      return;
    }
    if (type.tag === "array") {
      let storeType: TypeId | undefined;
      if (value.kind === "dynamic") storeType = value.type;
      if (value.kind === "array" && value.elementType !== undefined) {
        storeType = this.storeType(value.elementType);
      }
      if (value.kind === "empty-store" && value.elementType !== undefined) {
        storeType = this.storeType(value.elementType);
      }
      if (storeType === undefined) return;
      const runtimeType = this.types[storeType];
      if (runtimeType.kind !== "store") return;
      this.recordRuntimeTypeId(
        type.element,
        runtimeType.elementType,
        substitutions,
      );
      return;
    }
    if (type.tag !== "record") return;
    if (value.kind === "tuple") {
      for (const [name, fieldType] of type.fields) {
        const index = Number(name);
        const field = value.elements[index];
        if (field !== undefined) {
          this.recordRuntimeType(fieldType, field, substitutions, span);
        }
      }
      return;
    }
    if (value.kind === "shape") {
      for (const [name, fieldType] of type.fields) {
        const field = value.fields.get(name);
        if (field !== undefined) {
          this.recordRuntimeType(fieldType, field, substitutions, span);
        }
      }
      return;
    }
    if (value.kind !== "dynamic") return;
    const runtimeType = this.types[value.type];
    if (runtimeType.kind !== "product") return;
    for (const [name, fieldType] of type.fields) {
      const field = runtimeType.fields.find((candidate) =>
        candidate.name === name
      );
      if (field !== undefined) {
        this.recordRuntimeTypeId(fieldType, field.type, substitutions);
      }
    }
  }

  private valueHasUntypedStore(value: ResidualValue): boolean {
    if (value.kind === "empty-store") return value.elementType === undefined;
    if (value.kind === "array" || value.kind === "tuple") {
      return value.elements.some((element) =>
        this.valueHasUntypedStore(element)
      );
    }
    if (value.kind === "shape") {
      return [...value.fields.values()].some((field) =>
        this.valueHasUntypedStore(field)
      );
    }
    if (value.kind === "tag") return this.valueHasUntypedStore(value.payload);
    return false;
  }

  private recordRuntimeTypeId(
    type: SimpleType,
    runtimeType: TypeId,
    substitutions: Map<string, TypeId>,
  ): void {
    if (type.tag === "forall") {
      this.recordRuntimeTypeId(type.body, runtimeType, substitutions);
      return;
    }
    if (type.tag === "var" || type.tag === "rigid") {
      substitutions.set(this.typeVariableKey(type), runtimeType);
      return;
    }
    if (type.tag === "array") {
      const representation = this.types[runtimeType];
      if (representation.kind === "store") {
        this.recordRuntimeTypeId(
          type.element,
          representation.elementType,
          substitutions,
        );
      }
      return;
    }
    if (type.tag !== "record") return;
    const representation = this.types[runtimeType];
    if (representation.kind !== "product") return;
    for (const [name, fieldType] of type.fields) {
      const field = representation.fields.find((candidate) =>
        candidate.name === name
      );
      if (field !== undefined) {
        this.recordRuntimeTypeId(fieldType, field.type, substitutions);
      }
    }
  }

  private typeVariableKey(
    type: Extract<SimpleType, { readonly tag: "var" | "rigid" }>,
  ): string {
    return `${type.tag}:${type.id}`;
  }

  private variantCasesForSimpleType(
    type: SimpleType,
    seen: Set<number>,
  ): ReadonlyMap<string, SimpleType> | null {
    if (type.tag === "variant") {
      if (type.open) return null;
      return type.cases;
    }
    if (type.tag === "var") {
      if (seen.has(type.id)) return null;
      seen.add(type.id);
      const cases = new Map<string, SimpleType>();
      for (const bound of [...type.lower, ...type.upper]) {
        const found = this.variantCasesForSimpleType(
          bound,
          new Set(seen),
        );
        if (found === null) continue;
        for (const [name, payload] of found) cases.set(name, payload);
      }
      if (cases.size === 0) return null;
      return cases;
    }
    if (type.tag === "union") {
      const cases = new Map<string, SimpleType>();
      for (const member of type.members) {
        const found = this.variantCasesForSimpleType(
          member,
          new Set(seen),
        );
        if (found === null) return null;
        for (const [name, payload] of found) cases.set(name, payload);
      }
      if (cases.size === 0) return null;
      return cases;
    }
    return null;
  }

  private integer(
    value: ResidualValue,
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const dynamic = this.dynamic(value);
    if (this.types[dynamic.type].kind !== "signed-integer-64") {
      throw this.outside(span, `${primitive} over non-integer operand`);
    }
    return dynamic;
  }

  private floating(
    value: ResidualValue,
    expected: "float-32" | "float-64",
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const dynamic = this.dynamic(value);
    if (this.types[dynamic.type].kind !== expected) {
      throw this.outside(span, `${primitive} over non-${expected} operand`);
    }
    return dynamic;
  }

  private floatOfInteger(
    value: ResidualValue,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const integer = this.integer(value, span, "@float.of_int");
    const integerType = integer.type;
    const base = this.constant(2_147_483_648n, integerType, span);
    const quotient = this.operation(
      "scalar",
      integerType,
      [integer.value, base.value],
      span,
      undefined,
      "divide",
    );
    const quotientProduct = this.operation(
      "scalar",
      integerType,
      [quotient.value, base.value],
      span,
      undefined,
      "multiply",
    );
    const remainder = this.operation(
      "scalar",
      integerType,
      [integer.value, quotientProduct.value],
      span,
      undefined,
      "subtract",
    );
    const high = this.operation(
      "scalar",
      integerType,
      [quotient.value, base.value],
      span,
      undefined,
      "divide",
    );
    const highProduct = this.operation(
      "scalar",
      integerType,
      [high.value, base.value],
      span,
      undefined,
      "multiply",
    );
    const middle = this.operation(
      "scalar",
      integerType,
      [quotient.value, highProduct.value],
      span,
      undefined,
      "subtract",
    );
    const integer32Type = this.type("integer-32");
    const floatType = this.type("float-64");
    const high32 = this.convert(
      high,
      integer32Type,
      "signed-integer-64-to-signed-integer-32",
      span,
    );
    const middle32 = this.convert(
      middle,
      integer32Type,
      "signed-integer-64-to-signed-integer-32",
      span,
    );
    const remainder32 = this.convert(
      remainder,
      integer32Type,
      "signed-integer-64-to-signed-integer-32",
      span,
    );
    const highFloat = this.convert(
      high32,
      floatType,
      "signed-integer-32-to-float-64",
      span,
    );
    const middleFloat = this.convert(
      middle32,
      floatType,
      "signed-integer-32-to-float-64",
      span,
    );
    const remainderFloat = this.convert(
      remainder32,
      floatType,
      "signed-integer-32-to-float-64",
      span,
    );
    const floatBase = this.constant(2_147_483_648, floatType, span);
    const highScaled = this.operation(
      "scalar",
      floatType,
      [highFloat.value, floatBase.value],
      span,
      undefined,
      "multiply",
    );
    const highAndMiddle = this.operation(
      "scalar",
      floatType,
      [highScaled.value, middleFloat.value],
      span,
      undefined,
      "add",
    );
    const quotientFloat = this.operation(
      "scalar",
      floatType,
      [highAndMiddle.value, floatBase.value],
      span,
      undefined,
      "multiply",
    );
    return this.operation(
      "scalar",
      floatType,
      [quotientFloat.value, remainderFloat.value],
      span,
      undefined,
      "add",
    );
  }

  private trapIfNaN(
    value: Extract<ResidualValue, { kind: "dynamic" }>,
    primitive: string,
    span: Span,
  ): void {
    const unordered = this.operation(
      "scalar",
      this.type("boolean"),
      [value.value, value.value],
      span,
      undefined,
      "not-equal",
    );
    const source = this.current();
    const trap = this.block();
    const ordered = this.block();
    source.terminator = {
      kind: "conditional",
      condition: unordered.value,
      consequent: trap.id,
      consequentArguments: [],
      alternate: ordered.id,
      alternateArguments: [],
      span: this.span(span),
    };
    trap.terminator = {
      kind: "trap",
      message: `${primitive} cannot order NaN. Test for it before comparing.`,
      span: this.span(span),
    };
    this.#currentBlock = ordered.id;
  }

  private text(
    value: ResidualValue,
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const dynamic = this.dynamic(value);
    if (this.types[dynamic.type].kind !== "text") {
      throw this.outside(span, `${primitive} over non-text operand`);
    }
    return dynamic;
  }

  private constant(
    value: bigint | number | boolean | string | null,
    type: TypeId,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const result = this.nextValue();
    this.current().operations.push({
      kind: "constant",
      result,
      type,
      operands: [],
      ownership: typeof value === "string" ? "owned" : "plain",
      value,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type };
  }

  private convert(
    value: Extract<ResidualValue, { kind: "dynamic" }>,
    type: TypeId,
    conversion: string,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const result = this.nextValue();
    this.current().operations.push({
      kind: "convert",
      result,
      type,
      operands: [value.value],
      ownership: "plain",
      conversion,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type };
  }

  private operation(
    kind:
      | "text.append"
      | "text.compare"
      | "text.from-i64"
      | "scalar",
    type: TypeId,
    operands: readonly ValueId[],
    span: Span,
    meaning?: Extract<ResidualValue, { kind: "dynamic" }>["meaning"],
    operator?: BlotRuntimeScalarOperator,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const result = this.nextValue();
    let ownership: "plain" | "owned" = "plain";
    if (kind === "text.append" || kind === "text.from-i64") {
      ownership = "owned";
    }
    const operation: BlotRuntimeOperation = kind === "scalar"
      ? {
        kind,
        result,
        type,
        operands,
        ownership: "plain",
        operator: operator!,
        span: this.span(span),
      }
      : {
        kind,
        result,
        type,
        operands,
        ownership,
        span: this.span(span),
      };
    this.current().operations.push(operation);
    return { kind: "dynamic", value: result, type, meaning };
  }

  private vectorOperation(
    operator: Extract<
      BlotRuntimeOperation,
      { readonly kind: "vector" }
    >["operator"],
    type: TypeId,
    operands: readonly ValueId[],
    span: Span,
    lane?: 0 | 1 | 2 | 3,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const result = this.nextValue();
    this.current().operations.push({
      kind: "vector",
      result,
      type,
      operands,
      ownership: "plain",
      operator,
      lane,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type };
  }

  private materializeVector(
    value: Extract<Value, { readonly tag: "vector" }>,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const type = this.simdType(value.element, false);
    if (value.element === "f32") {
      const operands = value.lanes.map((lane) =>
        this.constant(lane, this.type("float-32"), span).value
      );
      return this.vectorOperation("make", type, operands, span);
    }
    if (value.element === "i32") {
      const operands = value.lanes.map((lane) =>
        this.constant(lane, this.type("integer-32"), span).value
      );
      return this.vectorOperation("make", type, operands, span);
    }
    const first = value.lanes[0];
    if (value.lanes.some((lane) => lane !== first)) {
      throw this.outside(
        span,
        `non-uniform ${value.element} constant vector`,
      );
    }
    const lane = this.constant(first, this.type("integer-32"), span);
    return this.vectorOperation("splat", type, [lane.value], span);
  }

  private materializeMask(
    value: Extract<Value, { readonly tag: "vector-mask" }>,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const first = value.lanes[0];
    if (value.lanes.some((lane) => lane !== first)) {
      const bits = value.lanes.map((lane) => {
        if (lane) return 1;
        return 0;
      });
      const left = this.materializeVector({
        tag: "vector",
        element: value.element,
        lanes: bits,
      }, span);
      const zero = this.materializeVector({
        tag: "vector",
        element: value.element,
        lanes: bits.map(() => 0),
      }, span);
      return this.vectorOperation(
        "not-equal",
        this.simdType(value.element, true),
        [left.value, zero.value],
        span,
      );
    }
    const zero = this.materializeVector({
      tag: "vector",
      element: value.element,
      lanes: value.lanes.map(() => 0),
    }, span);
    let operator: Extract<
      BlotRuntimeOperation,
      { readonly kind: "vector" }
    >["operator"] = "equal";
    if (!first) operator = "not-equal";
    return this.vectorOperation(
      operator,
      this.simdType(value.element, true),
      [zero.value, zero.value],
      span,
    );
  }

  private simdPrimitive(
    name: string,
    inputs: readonly ResidualValue[],
    span: Span,
  ): ResidualValue | undefined {
    const match = /^@(f32x4|i32x4|i16x8|i8x16)\.(.+)$/.exec(name);
    if (match === null) return undefined;
    const prefix = match[1];
    let operation = match[2];
    if (operation.endsWith("_wrapping")) {
      operation = operation.slice(0, -"_wrapping".length);
    }
    let element: "f32" | "i32" | "i16" | "i8" = "f32";
    if (prefix === "i32x4") element = "i32";
    if (prefix === "i16x8") element = "i16";
    if (prefix === "i8x16") element = "i8";
    const vectorType = this.simdType(element, false);
    const maskType = this.simdType(element, true);

    if (operation === "of") {
      const operands = inputs.map((argument) => {
        if (element === "f32") return this.float32(argument, span, name).value;
        return this.integer32(argument, span, name).value;
      });
      return this.vectorOperation("make", vectorType, operands, span);
    }
    if (operation === "splat") {
      let lane = this.float32(inputs[0], span, name);
      if (element !== "f32") lane = this.integer32(inputs[0], span, name);
      return this.vectorOperation("splat", vectorType, [lane.value], span);
    }
    if (element === "i32" && operation === "lane") {
      const selector = this.staticValue(inputs[1]);
      if (
        selector === undefined || selector.tag !== "int" ||
        selector.value < 0n || selector.value > 3n
      ) {
        throw this.outside(span, `${name} without a certified lane in 0..3`);
      }
      const vector = this.simd(inputs[0], element, false, span, name);
      const extracted = this.vectorOperation(
        "extract",
        this.type("integer-32"),
        [vector.value],
        span,
        Number(selector.value) as 0 | 1 | 2 | 3,
      );
      return this.extendInteger32(extracted, span);
    }
    const floatLane = ["x", "y", "z", "w"].indexOf(operation);
    if (element === "f32" && floatLane >= 0) {
      const vector = this.simd(inputs[0], "f32", false, span, name);
      return this.vectorOperation(
        "extract",
        this.type("float-32"),
        [vector.value],
        span,
        floatLane as 0 | 1 | 2 | 3,
      );
    }
    if (element === "f32" && operation === "sum") {
      const vector = this.simd(inputs[0], "f32", false, span, name);
      const lanes = ([0, 1, 2, 3] as const).map((lane) =>
        this.vectorOperation(
          "extract",
          this.type("float-32"),
          [vector.value],
          span,
          lane,
        )
      );
      const left = this.operation(
        "scalar",
        this.type("float-32"),
        [lanes[0].value, lanes[1].value],
        span,
        undefined,
        "add",
      );
      const right = this.operation(
        "scalar",
        this.type("float-32"),
        [lanes[2].value, lanes[3].value],
        span,
        undefined,
        "add",
      );
      return this.operation(
        "scalar",
        this.type("float-32"),
        [left.value, right.value],
        span,
        undefined,
        "add",
      );
    }
    const laneMatch = /^(?:lane|with_lane)([0-3])$/.exec(operation);
    if (laneMatch !== null) {
      const lane = Number(laneMatch[1]) as 0 | 1 | 2 | 3;
      const vector = this.simd(inputs[0], element, false, span, name);
      if (operation.startsWith("lane")) {
        const extracted = this.vectorOperation(
          "extract",
          this.type("integer-32"),
          [vector.value],
          span,
          lane,
        );
        return this.extendInteger32(extracted, span);
      }
      let replacement = this.float32(inputs[1], span, name);
      if (element !== "f32") {
        replacement = this.integer32(inputs[1], span, name);
      }
      return this.vectorOperation(
        "replace",
        vectorType,
        [vector.value, replacement.value],
        span,
        lane,
      );
    }
    const reductions = new Map<
      string,
      Extract<BlotRuntimeOperation, { readonly kind: "vector" }>["operator"]
    >([
      ["mask_bitmask", "mask-bitmask"],
      ["mask_all", "mask-all"],
      ["mask_any", "mask-any"],
    ]);
    const reduction = reductions.get(operation);
    if (reduction !== undefined) {
      const mask = this.simd(inputs[0], element, true, span, name);
      const reduced = this.vectorOperation(
        reduction,
        this.type("integer-32"),
        [mask.value],
        span,
      );
      return this.extendInteger32(reduced, span);
    }
    if (operation === "convert_i32_s" || operation === "convert_i32_u") {
      const vector = this.simd(inputs[0], "i32", false, span, name);
      let operator: "convert-i32-signed" | "convert-i32-unsigned" =
        "convert-i32-signed";
      if (operation.endsWith("_u")) operator = "convert-i32-unsigned";
      return this.vectorOperation(operator, this.simdType("f32", false), [
        vector.value,
      ], span);
    }
    if (operation === "trunc_sat_f32_s" || operation === "trunc_sat_f32_u") {
      const vector = this.simd(inputs[0], "f32", false, span, name);
      let operator:
        | "truncate-saturating-f32-signed"
        | "truncate-saturating-f32-unsigned" = "truncate-saturating-f32-signed";
      if (operation.endsWith("_u")) {
        operator = "truncate-saturating-f32-unsigned";
      }
      return this.vectorOperation(operator, this.simdType("i32", false), [
        vector.value,
      ], span);
    }
    const operators = new Map<
      string,
      Extract<BlotRuntimeOperation, { readonly kind: "vector" }>["operator"]
    >([
      ["add", "add"],
      ["sub", "subtract"],
      ["mul", "multiply"],
      ["div", "divide"],
      ["eq", "equal"],
      ["ne", "not-equal"],
      ["less", "less-than"],
      ["le", "less-than-or-equal"],
      ["gt", "greater-than"],
      ["ge", "greater-than-or-equal"],
      ["select", "select"],
      ["abs", "absolute"],
      ["neg", "negate"],
      ["sqrt", "square-root"],
      ["ceil", "ceiling"],
      ["floor", "floor"],
      ["trunc", "truncate"],
      ["nearest", "nearest"],
      ["min", "minimum"],
      ["max", "maximum"],
      ["pmin", "pseudo-minimum"],
      ["pmax", "pseudo-maximum"],
      ["and", "bit-and"],
      ["or", "bit-or"],
      ["xor", "bit-xor"],
      ["not", "bit-not"],
      ["shl", "shift-left"],
      ["shr_s", "shift-right-signed"],
      ["shr_u", "shift-right-unsigned"],
      ["min_s", "minimum-signed"],
      ["min_u", "minimum-unsigned"],
      ["max_s", "maximum-signed"],
      ["max_u", "maximum-unsigned"],
      ["lt_s", "less-than-signed"],
      ["lt_u", "less-than-unsigned"],
      ["gt_s", "greater-than-signed"],
      ["gt_u", "greater-than-unsigned"],
      ["le_s", "less-than-or-equal-signed"],
      ["le_u", "less-than-or-equal-unsigned"],
      ["ge_s", "greater-than-or-equal-signed"],
      ["ge_u", "greater-than-or-equal-unsigned"],
    ]);
    const operator = operators.get(operation);
    if (operator === undefined) return undefined;
    let resultType = vectorType;
    if (
      operation === "eq" || operation === "ne" || operation === "less" ||
      operation === "le" || operation === "gt" || operation === "ge" ||
      operation.startsWith("lt_") || operation.startsWith("gt_") ||
      operation.startsWith("le_") || operation.startsWith("ge_")
    ) {
      resultType = maskType;
    }
    const operands = inputs.map((argument, index) => {
      if (
        index === 1 &&
        (operation === "shl" || operation === "shr_s" || operation === "shr_u")
      ) {
        return this.integer32(argument, span, name).value;
      }
      if (index === 0 && operation === "select") {
        return this.simd(argument, element, true, span, name).value;
      }
      return this.simd(argument, element, false, span, name).value;
    });
    return this.vectorOperation(operator, resultType, operands, span);
  }

  private simd(
    value: ResidualValue,
    element: "f32" | "i32" | "i16" | "i8",
    mask: boolean,
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const dynamic = this.dynamic(value);
    if (dynamic.type !== this.simdType(element, mask)) {
      throw this.outside(span, `${primitive} over the wrong SIMD type`);
    }
    return dynamic;
  }

  private integer32(
    value: ResidualValue,
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const integer = this.integer(value, span, primitive);
    const result = this.nextValue();
    this.current().operations.push({
      kind: "convert",
      result,
      type: this.type("integer-32"),
      operands: [integer.value],
      ownership: "plain",
      conversion: "signed-integer-64-to-signed-integer-32",
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: this.type("integer-32") };
  }

  private extendInteger32(
    value: Extract<ResidualValue, { kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const result = this.nextValue();
    this.current().operations.push({
      kind: "convert",
      result,
      type: this.type("signed-integer-64"),
      operands: [value.value],
      ownership: "plain",
      conversion: "signed-integer-32-to-signed-integer-64",
      span: this.span(span),
    });
    return {
      kind: "dynamic",
      value: result,
      type: this.type("signed-integer-64"),
    };
  }

  private float32(
    value: ResidualValue,
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const dynamic = this.dynamic(value);
    if (this.types[dynamic.type].kind !== "float-32") {
      throw this.outside(span, `${primitive} over non-F32 operand`);
    }
    return dynamic;
  }

  private staticValue(value: ResidualValue): Value | undefined {
    if (value.kind === "static") return value.value;
    if (value.kind === "array") {
      const elements = value.elements.map((element) =>
        this.staticValue(element)
      );
      if (elements.some((element) => element === undefined)) return undefined;
      return {
        tag: "array",
        elements: elements as Value[],
      };
    }
    if (value.kind === "tuple") {
      const elements = value.elements.map((element) =>
        this.staticValue(element)
      );
      if (elements.some((element) => element === undefined)) return undefined;
      return {
        tag: "shape",
        fields: new Map(
          elements.map((element, index) => [String(index), element!]),
        ),
      };
    }
    if (value.kind === "shape") {
      const fields = new Map<string, Value>();
      for (const [name, field] of value.fields) {
        const staticField = this.staticValue(field);
        if (staticField === undefined) return undefined;
        fields.set(name, staticField);
      }
      return { tag: "shape", fields };
    }
    if (value.kind === "tag") {
      const payload = this.staticValue(value.payload);
      if (payload === undefined) return undefined;
      return { tag: "tag", name: value.name, payload };
    }
    return undefined;
  }

  private residualizeStatic(
    value: ResidualValue,
    environment: ResidualEnvironment | null = null,
  ): ResidualValue {
    if (value.kind !== "static") return value;
    const known = value.value;
    if (known.tag === "closure" || known.tag === "core-closure") {
      let signature: SimpleType | undefined;
      if (known.tag === "closure" && known.source !== undefined) {
        signature = this.#checked.expressionTypes.get(known.source);
      }
      return {
        kind: "closure",
        parameter: known.parameter,
        body: known.body,
        environment: this.environment(environment, known.env),
        self: known.self,
        signature,
      };
    }
    if (known.tag === "array") {
      return {
        kind: "array",
        elements: known.elements.map((element) =>
          this.residualizeStatic(
            { kind: "static", value: element },
            environment,
          )
        ),
      };
    }
    if (known.tag === "shape") {
      return {
        kind: "shape",
        fields: new Map(
          [...known.fields].map(([name, field]) => [
            name,
            this.residualizeStatic(
              { kind: "static", value: field },
              environment,
            ),
          ]),
        ),
      };
    }
    if (known.tag === "tag" && known.payload !== null) {
      return {
        kind: "tag",
        name: known.name,
        payload: this.residualizeStatic(
          {
            kind: "static",
            value: known.payload,
          },
          environment,
        ),
      };
    }
    return value;
  }

  private applyCheckedResidualType(
    value: ResidualValue,
    expression: Expr,
    span: Span,
  ): ResidualValue {
    if (value.kind === "closure") {
      const checked = this.#checked.expressionTypes.get(expression);
      if (checked !== undefined) return { ...value, signature: checked };
      return value;
    }
    if (
      value.kind !== "array" && value.kind !== "empty-store"
    ) return value;
    const checked = this.#checked.expressionTypes.get(expression);
    if (checked === undefined) return value;
    const type = this.typeForSimpleType(checked, span, new Set());
    if (type === null) return value;
    const runtimeType = this.types[type];
    if (runtimeType.kind !== "store") return value;
    if (value.kind === "array") {
      return { ...value, elementType: runtimeType.elementType };
    }
    return { ...value, elementType: runtimeType.elementType };
  }

  private staticBoolean(value: ResidualValue): boolean | undefined {
    const known = this.staticValue(value);
    if (known?.tag !== "tag" || known.payload !== null) return undefined;
    if (known.name === "True") return true;
    if (known.name === "False") return false;
    return undefined;
  }

  private typeFromValue(value: Value, span: Span): TypeId {
    if (value.tag === "extended") return this.typeFromValue(value.inner, span);
    if (value.tag === "unit") return this.type("unit");
    if (this.isBooleanType(value)) return this.type("boolean");
    if (value.tag === "range") {
      let domain = value.domain;
      if (
        domain === undefined &&
        (value.low.tag === "int" || value.low.tag === "float" ||
          value.low.tag === "float32" || value.low.tag === "text")
      ) {
        domain = value.low.tag;
      }
      if (
        domain === undefined &&
        (value.high.tag === "int" || value.high.tag === "float" ||
          value.high.tag === "float32" || value.high.tag === "text")
      ) {
        domain = value.high.tag;
      }
      if (domain === "int") return this.type("signed-integer-64");
      if (domain === "float") return this.type("float-64");
      if (domain === "float32") return this.type("float-32");
      if (domain === "text") return this.type("text");
    }
    if (value.tag === "shape") return this.productType(value.fields, span);
    if (value.tag === "opaque-type") {
      const simd = this.simdTypeFromName(value.name);
      if (simd !== undefined) return simd;
    }
    throw this.outside(span, `host type ${value.tag}`);
  }

  private isBooleanType(value: Value): boolean {
    if (value.tag !== "union" || value.members.length !== 2) return false;
    const names = value.members.flatMap((member) => {
      if (member.tag !== "tag" || member.payload !== null) return [];
      return [member.name];
    });
    return names.length === 2 && names.includes("True") &&
      names.includes("False");
  }

  private productType(
    fields: ReadonlyMap<string, Value>,
    span: Span,
  ): TypeId {
    const runtimeFields = new Map<string, TypeId>();
    for (const [name, value] of fields) {
      runtimeFields.set(name, this.typeFromValue(value, span));
    }
    return this.productTypeFromRuntimeFields(runtimeFields);
  }

  private productTypeFromRuntimeFields(
    fields: ReadonlyMap<string, TypeId>,
  ): TypeId {
    const runtimeFields = [...fields].map(([name, type]) => ({ name, type }));
    const key = `product:${
      runtimeFields.map((field) => `${field.name}:${field.type}`).join("|")
    }`;
    const existing = this.#typeByName.get(key);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    this.#typeByName.set(key, type);
    this.types.push({
      kind: "product",
      name: `residual$${type}`,
      fields: runtimeFields,
    });
    return type;
  }

  private storeType(elementType: TypeId): TypeId {
    const key = `store:${elementType}`;
    const existing = this.#typeByName.get(key);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    this.#typeByName.set(key, type);
    this.types.push({ kind: "store", elementType });
    return type;
  }

  private regionType(storeType: TypeId): TypeId {
    if (this.types[storeType].kind !== "store") {
      throw new Error("a Region requires a Store runtime type");
    }
    const key = `region:${storeType}`;
    const existing = this.#typeByName.get(key);
    if (existing !== undefined) return existing;
    const integer = this.type("signed-integer-64");
    const type = this.types.length;
    this.#typeByName.set(key, type);
    this.types.push({
      kind: "product",
      name: `$region:${storeType}`,
      fields: [
        { name: "end", type: integer },
        { name: "start", type: integer },
        { name: "store", type: storeType },
      ],
    });
    return type;
  }

  private makeRegion(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    start: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    end: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const value: ResidualValue = {
      kind: "shape",
      fields: new Map([
        ["end", end],
        ["start", start],
        ["store", store],
      ]),
    };
    return this.materialize(value, this.regionType(store.type), span);
  }

  private region(
    value: ResidualValue,
    span: Span,
    primitive: string,
  ): ResidualRegion {
    if (value.kind === "module-argument") {
      return this.unsupported(
        span,
        "live Region at the Blot Core Wasm ABI 1 boundary",
      );
    }
    const dynamic = this.dynamic(value);
    const type = this.types[dynamic.type];
    if (type.kind !== "product" || !type.name.startsWith("$region:")) {
      throw this.outside(span, `${primitive} over a non-Region`);
    }
    const store = this.dynamic(this.project(dynamic, "store", span));
    const start = this.integer(
      this.project(dynamic, "start", span),
      span,
      primitive,
    );
    const end = this.integer(
      this.project(dynamic, "end", span),
      span,
      primitive,
    );
    return { store, start, end };
  }

  private storeLength(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const result = this.nextValue();
    this.current().operations.push({
      kind: "store.length",
      result,
      type: this.type("signed-integer-64"),
      operands: [store.value],
      ownership: "plain",
      span: this.span(span),
    });
    return {
      kind: "dynamic",
      value: result,
      type: this.type("signed-integer-64"),
    };
  }

  private storeRead(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const storeType = this.types[store.type];
    if (storeType.kind !== "store") {
      throw this.outside(span, "Region read over a non-Store");
    }
    const result = this.nextValue();
    this.current().operations.push({
      kind: "store.read",
      result,
      type: storeType.elementType,
      operands: [store.value, index.value],
      ownership: this.ownership(storeType.elementType),
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: storeType.elementType };
  }

  private storeWrite(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    value: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    update: "owned-reuse" | "persistent",
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const result = this.nextValue();
    this.current().operations.push({
      kind: "store.write",
      result,
      type: store.type,
      operands: [store.value, index.value, value.value],
      ownership: "owned",
      update,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: store.type };
  }

  private appendStoreRange(
    sourceStore: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    start: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    end: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    initial: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const storeType = this.types[sourceStore.type];
    if (storeType.kind !== "store" || initial.type !== sourceStore.type) {
      throw this.outside(span, "Store range copy with mismatched stores");
    }
    const source = this.current();
    const header = this.block();
    source.terminator = {
      kind: "branch",
      target: header.id,
      arguments: [start.value, initial.value],
      span: this.span(span),
    };
    const cursor = this.nextValue();
    const output = this.nextValue();
    header.parameters.push({
      value: cursor,
      type: this.type("signed-integer-64"),
      ownership: "plain",
      span: this.span(span),
    }, {
      value: output,
      type: sourceStore.type,
      ownership: "owned",
      span: this.span(span),
    });
    this.#currentBlock = header.id;
    const hasNext = this.operation(
      "scalar",
      this.type("boolean"),
      [cursor, end.value],
      span,
      undefined,
      "less-than",
    );
    const body = this.block();
    const done = this.block();
    header.terminator = {
      kind: "conditional",
      condition: hasNext.value,
      consequent: body.id,
      consequentArguments: [],
      alternate: done.id,
      alternateArguments: [output],
      span: this.span(span),
    };
    this.#currentBlock = body.id;
    const element = this.storeRead(
      sourceStore,
      { kind: "dynamic", value: cursor, type: this.type("signed-integer-64") },
      span,
    );
    const outputValue: Extract<ResidualValue, { readonly kind: "dynamic" }> = {
      kind: "dynamic",
      value: output,
      type: sourceStore.type,
    };
    const outputLength = this.storeLength(outputValue, span);
    const one = this.constant(1n, this.type("signed-integer-64"), span);
    const grownLength = this.operation(
      "scalar",
      this.type("signed-integer-64"),
      [outputLength.value, one.value],
      span,
      undefined,
      "add",
    );
    const grown = this.nextValue();
    this.current().operations.push({
      kind: "store.grow",
      result: grown,
      type: sourceStore.type,
      operands: [output, grownLength.value, element.value],
      ownership: "owned",
      update: "persistent",
      span: this.span(span),
    });
    const next = this.operation(
      "scalar",
      this.type("signed-integer-64"),
      [cursor, one.value],
      span,
      undefined,
      "add",
    );
    this.terminate({
      kind: "branch",
      target: header.id,
      arguments: [next.value, grown],
      span: this.span(span),
    });
    this.#currentBlock = done.id;
    const result = this.nextValue();
    done.parameters.push({
      value: result,
      type: sourceStore.type,
      ownership: "owned",
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: sourceStore.type };
  }

  private arrayTake(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const storeType = this.types[store.type];
    if (storeType.kind !== "store") {
      throw this.outside(span, "@array.take over a non-Store");
    }
    const selected = this.storeRead(store, index, span);
    const zero = this.constant(0n, this.type("signed-integer-64"), span);
    const empty = this.emptyStore(storeType.elementType, span);
    const before = this.appendStoreRange(store, zero, index, empty, span);
    const one = this.constant(1n, this.type("signed-integer-64"), span);
    const afterStart = this.operation(
      "scalar",
      this.type("signed-integer-64"),
      [index.value, one.value],
      span,
      undefined,
      "add",
    );
    const length = this.storeLength(store, span);
    const remainder = this.appendStoreRange(
      store,
      afterStart,
      length,
      before,
      span,
    );
    return { kind: "tuple", elements: [selected, remainder] };
  }

  private arraySplit(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const storeType = this.types[store.type];
    if (storeType.kind !== "store") {
      throw this.outside(span, "@array.split over a non-Store");
    }
    const selected = this.storeRead(store, index, span);
    const zero = this.constant(0n, this.type("signed-integer-64"), span);
    const before = this.appendStoreRange(
      store,
      zero,
      index,
      this.emptyStore(storeType.elementType, span),
      span,
    );
    const one = this.constant(1n, this.type("signed-integer-64"), span);
    const afterStart = this.operation(
      "scalar",
      this.type("signed-integer-64"),
      [index.value, one.value],
      span,
      undefined,
      "add",
    );
    const length = this.storeLength(store, span);
    const after = this.appendStoreRange(
      store,
      afterStart,
      length,
      this.emptyStore(storeType.elementType, span),
      span,
    );
    return { kind: "tuple", elements: [before, selected, after] };
  }

  private branchValue(
    condition: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    consequent: () => ResidualValue,
    alternate: () => ResidualValue,
    span: Span,
  ): ResidualValue {
    if (this.types[condition.type].kind !== "boolean") {
      throw this.outside(span, "non-Boolean Region condition");
    }
    const source = this.current();
    const consequence = this.block();
    const alternative = this.block();
    source.terminator = {
      kind: "conditional",
      condition: condition.value,
      consequent: consequence.id,
      consequentArguments: [],
      alternate: alternative.id,
      alternateArguments: [],
      span: this.span(span),
    };
    this.#currentBlock = consequence.id;
    const consequentValue = this.withDynamicBranch(consequent);
    const consequenceEnd = this.#currentBlock;
    this.#currentBlock = alternative.id;
    const alternateValue = this.withDynamicBranch(alternate);
    const alternateEnd = this.#currentBlock;
    return this.finishBranchJoin(
      consequentValue,
      alternateValue,
      consequenceEnd,
      alternateEnd,
      span,
      span,
      span,
    );
  }

  private privateStoreCopy(
    store: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const length = this.storeLength(store, span);
    const zero = this.constant(0n, this.type("signed-integer-64"), span);
    const empty = this.operation(
      "scalar",
      this.type("boolean"),
      [length.value, zero.value],
      span,
      undefined,
      "equal",
    );
    return this.dynamic(this.branchValue(
      empty,
      () => store,
      () => {
        const first = this.storeRead(store, zero, span);
        return this.storeWrite(store, zero, first, "persistent", span);
      },
      span,
    ));
  }

  private regionIndexInBounds(
    region: ResidualRegion,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const integer = this.type("signed-integer-64");
    const zero = this.constant(0n, integer, span);
    const negative = this.operation(
      "scalar",
      this.type("boolean"),
      [index.value, zero.value],
      span,
      undefined,
      "less-than",
    );
    return this.dynamic(this.branchValue(
      negative,
      () => this.constant(false, this.type("boolean"), span),
      () => {
        const length = this.operation(
          "scalar",
          integer,
          [region.end.value, region.start.value],
          span,
          undefined,
          "subtract",
        );
        return this.operation(
          "scalar",
          this.type("boolean"),
          [index.value, length.value],
          span,
          undefined,
          "less-than",
        );
      },
      span,
    ));
  }

  private booleanAnd(
    left: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    right: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    return this.dynamic(this.branchValue(
      left,
      () => right,
      () => this.constant(false, this.type("boolean"), span),
      span,
    ));
  }

  private absoluteRegionIndex(
    region: ResidualRegion,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    return this.operation(
      "scalar",
      this.type("signed-integer-64"),
      [region.start.value, index.value],
      span,
      undefined,
      "add",
    );
  }

  private regionGet(
    region: ResidualRegion,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const inBounds = this.regionIndexInBounds(region, index, span);
    return this.branchValue(
      inBounds,
      () => ({
        kind: "tag",
        name: "Some",
        payload: this.storeRead(
          region.store,
          this.absoluteRegionIndex(region, index, span),
          span,
        ),
      }),
      () => ({
        kind: "tag",
        name: "None",
        payload: { kind: "static", value: { tag: "unit" } },
      }),
      span,
    );
  }

  private regionSet(
    region: ResidualRegion,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    value: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const inBounds = this.regionIndexInBounds(region, index, span);
    return this.branchValue(
      inBounds,
      () => {
        const store = this.storeWrite(
          region.store,
          this.absoluteRegionIndex(region, index, span),
          value,
          "owned-reuse",
          span,
        );
        return {
          kind: "tag",
          name: "Updated",
          payload: this.makeRegion(store, region.start, region.end, span),
        };
      },
      () => ({
        kind: "tag",
        name: "SetOutOfBounds",
        payload: this.makeRegion(
          region.store,
          region.start,
          region.end,
          span,
        ),
      }),
      span,
    );
  }

  private regionSwap(
    region: ResidualRegion,
    left: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    right: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const leftOk = this.regionIndexInBounds(region, left, span);
    const rightOk = this.regionIndexInBounds(region, right, span);
    const inBounds = this.booleanAnd(leftOk, rightOk, span);
    return this.branchValue(
      inBounds,
      () => {
        const leftIndex = this.absoluteRegionIndex(region, left, span);
        const rightIndex = this.absoluteRegionIndex(region, right, span);
        const leftValue = this.storeRead(region.store, leftIndex, span);
        const rightValue = this.storeRead(region.store, rightIndex, span);
        const first = this.storeWrite(
          region.store,
          leftIndex,
          rightValue,
          "owned-reuse",
          span,
        );
        const second = this.storeWrite(
          first,
          rightIndex,
          leftValue,
          "owned-reuse",
          span,
        );
        return {
          kind: "tag",
          name: "Updated",
          payload: this.makeRegion(second, region.start, region.end, span),
        };
      },
      () => ({
        kind: "tag",
        name: "SwapOutOfBounds",
        payload: this.makeRegion(
          region.store,
          region.start,
          region.end,
          span,
        ),
      }),
      span,
    );
  }

  private regionReplace(
    region: ResidualRegion,
    index: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    value: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const inBounds = this.regionIndexInBounds(region, index, span);
    return this.branchValue(
      inBounds,
      () => {
        const absolute = this.absoluteRegionIndex(region, index, span);
        const displaced = this.storeRead(region.store, absolute, span);
        const store = this.storeWrite(
          region.store,
          absolute,
          value,
          "owned-reuse",
          span,
        );
        return {
          kind: "tag",
          name: "Replaced",
          payload: {
            kind: "tuple",
            elements: [
              displaced,
              this.makeRegion(store, region.start, region.end, span),
            ],
          },
        };
      },
      () => ({
        kind: "tag",
        name: "ReplaceOutOfBounds",
        payload: {
          kind: "tuple",
          elements: [
            value,
            this.makeRegion(region.store, region.start, region.end, span),
          ],
        },
      }),
      span,
    );
  }

  private regionSplit(
    region: ResidualRegion,
    offset: Extract<ResidualValue, { readonly kind: "dynamic" }>,
    span: Span,
  ): ResidualValue {
    const integer = this.type("signed-integer-64");
    const failure = (): ResidualValue => ({
      kind: "tag",
      name: "SplitOutOfBounds",
      payload: this.makeRegion(
        region.store,
        region.start,
        region.end,
        span,
      ),
    });
    const zero = this.constant(0n, integer, span);
    const negative = this.operation(
      "scalar",
      this.type("boolean"),
      [offset.value, zero.value],
      span,
      undefined,
      "less-than",
    );
    return this.branchValue(
      negative,
      failure,
      () => {
        const length = this.operation(
          "scalar",
          integer,
          [region.end.value, region.start.value],
          span,
          undefined,
          "subtract",
        );
        const tooHigh = this.operation(
          "scalar",
          this.type("boolean"),
          [length.value, offset.value],
          span,
          undefined,
          "less-than",
        );
        return this.branchValue(
          tooHigh,
          failure,
          () => {
            const middle = this.operation(
              "scalar",
              integer,
              [region.start.value, offset.value],
              span,
              undefined,
              "add",
            );
            const left = this.makeRegion(
              region.store,
              region.start,
              middle,
              span,
            );
            const right = this.makeRegion(
              region.store,
              middle,
              region.end,
              span,
            );
            return {
              kind: "tag",
              name: "Split",
              payload: {
                kind: "tuple",
                elements: [
                  left,
                  right,
                  { kind: "static", value: { tag: "unit" } },
                ],
              },
            };
          },
          span,
        );
      },
      span,
    );
  }

  private sealedType(name: string, representationType: TypeId): TypeId {
    const key = `sealed:${name}:${representationType}`;
    const existing = this.#typeByName.get(key);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    this.#typeByName.set(key, type);
    this.types.push({ kind: "sealed", name, representationType });
    return type;
  }

  private emptyStore(
    elementType: TypeId,
    span: Span,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    const type = this.storeType(elementType);
    const result = this.nextValue();
    this.current().operations.push({
      kind: "store.empty",
      result,
      type,
      operands: [],
      ownership: "owned",
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type };
  }

  private store(
    value: ResidualValue,
    span: Span,
    primitive: string,
  ): Extract<ResidualValue, { readonly kind: "dynamic" }> {
    if (value.kind === "empty-store") {
      if (value.elementType === undefined) {
        throw this.outside(
          span,
          `${primitive} cannot infer an empty Store type`,
        );
      }
      return this.emptyStore(value.elementType, span);
    }
    const dynamic = this.dynamic(value);
    if (this.types[dynamic.type].kind !== "store") {
      throw this.outside(span, `${primitive} over a non-store`);
    }
    return dynamic;
  }

  private ownership(type: TypeId): "plain" | "owned" {
    const kind = this.types[type].kind;
    if (
      kind === "text" || kind === "product" || kind === "store" ||
      kind === "sum" || kind === "sealed"
    ) return "owned";
    return "plain";
  }

  private type(
    name:
      | "unit"
      | "boolean"
      | "integer-32"
      | "signed-integer-64"
      | "float-32"
      | "float-64"
      | "text",
  ): TypeId {
    const existing = this.#typeByName.get(name);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    this.#typeByName.set(name, type);
    this.types.push({ kind: name });
    return type;
  }

  private simdType(
    element: "f32" | "i32" | "i16" | "i8",
    mask: boolean,
  ): TypeId {
    let kind: "vector" | "mask" = "vector";
    if (mask) kind = "mask";
    const name = `${kind}:${element}`;
    const existing = this.#typeByName.get(name);
    if (existing !== undefined) return existing;
    let runtimeElement:
      | "float-32"
      | "integer-32"
      | "integer-16"
      | "integer-8" = "float-32";
    if (element === "i32") runtimeElement = "integer-32";
    if (element === "i16") runtimeElement = "integer-16";
    if (element === "i8") runtimeElement = "integer-8";
    let lanes: 4 | 8 | 16 = 4;
    if (element === "i16") lanes = 8;
    if (element === "i8") lanes = 16;
    const type = this.types.length;
    this.#typeByName.set(name, type);
    this.types.push({ kind, element: runtimeElement, lanes });
    return type;
  }

  private simdTypeFromName(name: string): TypeId | undefined {
    const types = new Map<
      string,
      readonly ["f32" | "i32" | "i16" | "i8", boolean]
    >([
      [F32X4_NAME, ["f32", false]],
      [F32X4_MASK_NAME, ["f32", true]],
      [I32X4_NAME, ["i32", false]],
      [I32X4_MASK_NAME, ["i32", true]],
      [I16X8_NAME, ["i16", false]],
      [I16X8_MASK_NAME, ["i16", true]],
      [I8X16_NAME, ["i8", false]],
      [I8X16_MASK_NAME, ["i8", true]],
    ]);
    const found = types.get(name);
    if (found === undefined) return undefined;
    return this.simdType(found[0], found[1]);
  }

  private sumType(
    cases: readonly string[],
    payloadTypes: readonly TypeId[],
  ): TypeId {
    const key = `sum:${
      cases.map((name, index) => `${name}:${payloadTypes[index]}`).join("|")
    }`;
    const existing = this.#typeByName.get(key);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    this.#typeByName.set(key, type);
    this.types.push({
      kind: "sum",
      name: `residual$${type}`,
      cases: cases.map((name, index) => ({
        name,
        payloadType: payloadTypes[index],
      })),
    });
    return type;
  }

  private environment(
    parent: ResidualEnvironment | null,
    staticParent: StaticEnv | null,
  ): ResidualEnvironment {
    const typeSubstitutions = new Map<string, TypeId>();
    if (parent !== null) {
      for (const [name, type] of parent.typeSubstitutions) {
        typeSubstitutions.set(name, type);
      }
    }
    return { names: new Map(), parent, staticParent, typeSubstitutions };
  }

  private bindModuleParameter(environment: ResidualEnvironment): void {
    const parameter = this.#checked.core.parameter;
    if (parameter === null) return;
    const fields = new Map<string, ResidualValue>();
    for (const [projection, grant] of this.#checked.grants) {
      if (projection.tag !== "field") {
        throw new Error(
          `${this.#source}:${projection.span.start}: a module grant is not a field projection`,
        );
      }
      fields.set(projection.name, {
        kind: "host-operation",
        capability: "Init",
        operation: projection.name,
        grant,
      });
    }
    this.bind(
      parameter,
      { kind: "module-argument", fields },
      environment,
      parameter.span,
    );
  }

  private lookup(
    environment: ResidualEnvironment,
    name: string,
  ): ResidualValue | undefined {
    let scope: ResidualEnvironment | null = environment;
    while (scope !== null) {
      const value = scope.names.get(name);
      if (value !== undefined) return value;
      const staticValue = scope.staticParent === null
        ? undefined
        : lookup(scope.staticParent, name);
      if (staticValue !== undefined) {
        return { kind: "static", value: staticValue };
      }
      scope = scope.parent;
    }
    return undefined;
  }

  private block(): MutableBlock {
    const block: MutableBlock = {
      id: this.#blocks.length,
      parameters: [],
      operations: [],
    };
    this.#blocks.push(block);
    return block;
  }

  private reserveFunction(): number {
    const functionId = this.functions.length;
    this.functions.push(undefined as unknown as BlotRuntimeFunction);
    return functionId;
  }

  private current(): MutableBlock {
    return this.#blocks[this.#currentBlock];
  }

  private terminate(terminator: BlotRuntimeBlock["terminator"]): void {
    const block = this.current();
    if (block.terminator !== undefined) {
      throw new Error(
        `${this.#source}: residual block ${block.id} is already terminated`,
      );
    }
    block.terminator = terminator;
  }

  private nextValue(): ValueId {
    const value = this.#nextValue;
    this.#nextValue += 1;
    return value;
  }

  private span(span: Span) {
    const origin = this.#residualOrigin ?? span;
    return { file: this.#source, start: origin.start, end: origin.end };
  }

  private outside(span: Span, construct: string): TypeError {
    return new TypeError(
      `${this.#source}:${span.start}: ${construct} is outside the checked residual Runtime-HIR calculus`,
    );
  }

  private unsupported(span: Span, construct: string): never {
    fail(
      "BLOT_UNSUPPORTED_LOWERING",
      `${construct} is outside the Node residual calculus.`,
      span,
    );
  }
}
