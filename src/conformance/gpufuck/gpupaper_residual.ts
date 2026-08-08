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
import {
  type CoreComputation,
  type CoreExpression,
  coreResultExpression,
  type CoreStep,
} from "../../core/computation.ts";
import type { Decl, Expr, Pattern, Span } from "../../syntax/ast.ts";
import { liveDeclarations } from "../../syntax/live.ts";
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
    readonly kind: "dynamic";
    readonly value: ValueId;
    readonly type: TypeId;
    readonly meaning?:
      | "ordering"
      | { readonly kind: "integer-ordering"; readonly right: ValueId }
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
  }
  | {
    readonly kind: "primitive";
    readonly name: string;
    readonly arity: number;
    readonly applied: readonly ResidualValue[];
  };

type ResidualEnvironment = {
  readonly names: Map<string, ResidualValue>;
  readonly parent: ResidualEnvironment | null;
  readonly staticParent: StaticEnv | null;
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
): BlotRuntimeModule {
  const runtimeExports = stagedExports.filter((exported) =>
    exported.phase === "runtime"
  );
  if (
    runtimeExports.length !== 1 || runtimeExports[0].sourceName !== "default"
  ) {
    throw new TypeError(
      `${source}: residual Runtime HIR currently requires one default runtime export`,
    );
  }
  const builder = new ResidualHirBuilder(source, checked);
  const function_ = builder.build(checked.core, wasmName);
  return {
    format: "blot-runtime-hir",
    schemaVersion: 2,
    source,
    types: builder.types,
    signatures: builder.signatures,
    functions: [function_],
    capabilities: builder.capabilities(),
    exports: stagedExports.map((exported) =>
      exported.phase === "comptime"
        ? { sourceName: exported.sourceName, phase: "comptime" as const }
        : {
          sourceName: exported.sourceName,
          phase: "runtime" as const,
          wasmName,
          function: 0,
          signature: function_.signature,
          ownership: "owned" as const,
        }
    ),
  };
}

class ResidualHirBuilder {
  readonly types: BlotRuntimeType[] = [];
  readonly signatures: {
    readonly parameters: readonly number[];
    readonly result: number;
    readonly effects: readonly string[];
  }[] = [];
  readonly #blocks: MutableBlock[] = [];
  readonly #capabilityOperations = new Map<
    string,
    Map<string, { readonly signature: number; readonly key: string }>
  >();
  readonly #checked: CheckResult;
  readonly #sourceHandlers: {
    readonly effect: number;
    readonly handler: ResidualValue;
  }[] = [];
  readonly #source: string;
  readonly #typeByName = new Map<string, TypeId>();
  #currentBlock = 0;
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
    computation: CoreComputation,
    wasmName: string,
  ): BlotRuntimeFunction {
    this.block();
    const environment = this.environment(null, this.#checked.values);
    this.coreDeclarations(computation.steps, environment);
    const resultExpression = coreResultExpression(computation.result);
    const result = this.dynamic(
      this.evaluate(resultExpression, environment),
    );
    this.terminate({
      kind: "return",
      value: result.value,
      span: this.span(resultExpression.span),
    });
    const effects = [...this.#capabilityOperations.keys()].sort();
    const signature = this.signatures.length;
    this.signatures.push({ parameters: [], result: result.type, effects });
    return {
      id: 0,
      name: `blot$residual$${wasmName}`,
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
      return value;
    }
    if (expr.tag === "intrinsic") {
      if (expr.name === "@array.empty") {
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
      const argument = this.evaluate(expr.arg, environment);
      return this.apply(fn, argument, expr.span);
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
      };
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
        return this.evaluate(
          coreResultExpression(coreBlock.computation.result),
          scope,
        );
      }
      const sourceBlock = expr as Extract<Expr, { readonly tag: "block" }>;
      const scheduled = scheduleSourceComputation(
        sourceBlock.declarations,
        sourceBlock.result,
        sourceBlock.resultEffects,
      );
      this.declarations(scheduled.steps, scope);
      return this.evaluate(
        scheduledSourceResultExpression(scheduled.result),
        scope,
      );
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
        value = { kind: "static", value: known };
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
  ): ResidualValue {
    if (fn.kind === "static") {
      const value = fn.value;
      if (value.tag === "closure" || value.tag === "core-closure") {
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
      const scope = this.environment(fn.environment, null);
      if (fn.self !== null) scope.names.set(fn.self, fn);
      this.bind(fn.parameter, argument, scope, span);
      return this.evaluate(fn.body, scope);
    }
    if (fn.kind !== "primitive") {
      throw this.outside(span, `application of ${fn.kind}`);
    }
    const applied = [...fn.applied, argument];
    if (applied.length < fn.arity) return { ...fn, applied };
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
    if (fn.name === "@array.push") {
      const elementType = this.typeForResidualValue(applied[1], span);
      if (applied[0].kind === "empty-store") {
        applied[0].elementType = elementType;
      }
      const store = this.store(applied[0], span, fn.name);
      const storeType = this.types[store.type];
      if (storeType.kind !== "store" || storeType.elementType !== elementType) {
        throw this.outside(span, `${fn.name} element type disagreement`);
      }
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
        meaning: { kind: "integer-ordering", right: right.value },
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
    const simd = this.simdPrimitive(fn.name, applied, span);
    if (simd !== undefined) return simd;
    throw this.outside(span, `dynamic primitive ${fn.name}`);
  }

  private conditional(
    expr: ResidualIf,
    environment: ResidualEnvironment,
  ): ResidualValue {
    if (expr.branches.length !== 1 || expr.fallback === null) {
      throw this.outside(expr.span, "multi-branch conditional");
    }
    const condition = this.evaluate(expr.branches[0].condition, environment);
    const known = this.staticBoolean(condition);
    if (known !== undefined) {
      return this.evaluate(
        known ? expr.branches[0].consequence : expr.fallback,
        environment,
      );
    }
    const dynamicCondition = this.dynamic(condition);
    if (this.types[dynamicCondition.type].kind !== "boolean") {
      throw this.outside(
        expr.branches[0].condition.span,
        "non-Boolean condition",
      );
    }
    const sourceBlock = this.current();
    const consequence = this.block();
    const alternate = this.block();
    const join = this.block();
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
    const consequentValue = this.evaluate(
      expr.branches[0].consequence,
      environment,
    );
    const consequenceEnd = this.#currentBlock;

    this.#currentBlock = alternate.id;
    const alternateValue = this.evaluate(expr.fallback, environment);
    const alternateEnd = this.#currentBlock;

    const joined = this.joinBranchValues(
      consequentValue,
      alternateValue,
      consequenceEnd,
      alternateEnd,
      expr.span,
    );
    this.#currentBlock = consequenceEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.consequent.value],
      span: this.span(expr.branches[0].consequence.span),
    });
    this.#currentBlock = alternateEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.alternate.value],
      span: this.span(expr.fallback.span),
    });

    const joinedValue = this.nextValue();
    join.parameters.push({
      value: joinedValue,
      type: joined.type,
      ownership: this.ownership(joined.type),
      span: this.span(expr.span),
    });
    this.#currentBlock = join.id;
    return {
      kind: "dynamic",
      value: joinedValue,
      type: joined.type,
      meaning: joined.meaning,
    };
  }

  private caseExpression(
    expr: ResidualCase,
    environment: ResidualEnvironment,
  ): ResidualValue {
    const target = this.evaluate(expr.target, environment);
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
          target.meaning.kind === "integer-ordering"))
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
    const join = this.block();
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
    const consequent = evaluateArm("True", trueBlock);
    const consequenceEnd = this.#currentBlock;
    const alternate = evaluateArm("False", falseBlock);
    const alternateEnd = this.#currentBlock;
    const joined = this.joinBranchValues(
      consequent.value,
      alternate.value,
      consequenceEnd,
      alternateEnd,
      expr.span,
    );
    this.#currentBlock = consequenceEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.consequent.value],
      span: this.span(consequent.arm.body.span),
    });
    this.#currentBlock = alternateEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.alternate.value],
      span: this.span(alternate.arm.body.span),
    });
    const joinedValue = this.nextValue();
    join.parameters.push({
      value: joinedValue,
      type: joined.type,
      ownership: this.ownership(joined.type),
      span: this.span(expr.span),
    });
    this.#currentBlock = join.id;
    return {
      kind: "dynamic",
      value: joinedValue,
      type: joined.type,
      meaning: joined.meaning,
    };
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
      const join = this.block();
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
      const consequenceValue = this.evaluate(
        arm.body,
        this.environment(environment, null),
      );
      const consequenceEnd = this.#currentBlock;

      this.#currentBlock = alternate.id;
      const alternateValue = evaluateArm(index + 1);
      const alternateEnd = this.#currentBlock;
      const joined = this.joinBranchValues(
        consequenceValue,
        alternateValue,
        consequenceEnd,
        alternateEnd,
        expr.span,
      );

      this.#currentBlock = consequenceEnd;
      this.terminate({
        kind: "branch",
        target: join.id,
        arguments: [joined.consequent.value],
        span: this.span(arm.body.span),
      });
      this.#currentBlock = alternateEnd;
      this.terminate({
        kind: "branch",
        target: join.id,
        arguments: [joined.alternate.value],
        span: this.span(expr.span),
      });

      const joinedValue = this.nextValue();
      join.parameters.push({
        value: joinedValue,
        type: joined.type,
        ownership: this.ownership(joined.type),
        span: this.span(expr.span),
      });
      this.#currentBlock = join.id;
      return {
        kind: "dynamic",
        value: joinedValue,
        type: joined.type,
        meaning: joined.meaning,
      };
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
    const join = this.block();
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
    const consequentValue = evaluateArm(0, consequence);
    const consequenceEnd = this.#currentBlock;
    const alternateValue = evaluateArm(1, alternate);
    const alternateEnd = this.#currentBlock;
    const joined = this.joinBranchValues(
      consequentValue,
      alternateValue,
      consequenceEnd,
      alternateEnd,
      expr.span,
    );
    this.#currentBlock = consequenceEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.consequent.value],
      span: this.span(arms[0]!.body.span),
    });
    this.#currentBlock = alternateEnd;
    this.terminate({
      kind: "branch",
      target: join.id,
      arguments: [joined.alternate.value],
      span: this.span(arms[1]!.body.span),
    });
    const joinedValue = this.nextValue();
    join.parameters.push({
      value: joinedValue,
      type: joined.type,
      ownership: this.ownership(joined.type),
      span: this.span(expr.span),
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
      consequent.kind === "empty-store" && alternate.kind === "dynamic" &&
      this.types[alternate.type].kind === "store"
    ) {
      const selected = this.types[alternate.type];
      if (selected.kind !== "store") {
        throw new Error("a checked store type changed while joining branches");
      }
      this.#currentBlock = consequenceEnd;
      return {
        consequent: this.emptyStore(selected.elementType, span),
        alternate,
        type: alternate.type,
      };
    }
    if (
      consequent.kind === "dynamic" && alternate.kind === "empty-store" &&
      this.types[consequent.type].kind === "store"
    ) {
      const selected = this.types[consequent.type];
      if (selected.kind !== "store") {
        throw new Error("a checked store type changed while joining branches");
      }
      this.#currentBlock = alternateEnd;
      return {
        consequent,
        alternate: this.emptyStore(selected.elementType, span),
        type: consequent.type,
      };
    }
    const consequentTag = this.residualTag(consequent);
    const alternateTag = this.residualTag(alternate);
    if (
      consequentTag !== null && alternate.kind === "dynamic" &&
      typeof alternate.meaning === "object" &&
      alternate.meaning.kind === "sum" &&
      alternate.meaning.cases.includes(consequentTag.name)
    ) {
      this.#currentBlock = consequenceEnd;
      const consequentValue = this.materializeTag(
        consequentTag,
        alternate.type,
        alternate.meaning.cases,
        alternate.meaning.wrappedPayloads,
        span,
      );
      return {
        consequent: consequentValue,
        alternate,
        type: alternate.type,
        meaning: alternate.meaning,
      };
    }
    if (
      consequent.kind === "dynamic" && alternateTag !== null &&
      typeof consequent.meaning === "object" &&
      consequent.meaning.kind === "sum" &&
      consequent.meaning.cases.includes(alternateTag.name)
    ) {
      this.#currentBlock = alternateEnd;
      const alternateValue = this.materializeTag(
        alternateTag,
        consequent.type,
        consequent.meaning.cases,
        consequent.meaning.wrappedPayloads,
        span,
      );
      return {
        consequent,
        alternate: alternateValue,
        type: consequent.type,
        meaning: consequent.meaning,
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
      const type = this.typeForResidualValue(consequent, span);
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

  private materializeTag(
    tagged: Extract<ResidualValue, { kind: "tag" }>,
    type: TypeId,
    cases: readonly string[],
    wrappedPayloads: readonly boolean[],
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const payload = tagged.payload.kind === "shape"
      ? tagged.payload.fields.get("value")
      : tagged.payload;
    if (payload === undefined) {
      throw this.outside(span, `tag ${tagged.name} without value payload`);
    }
    const selectedCase = cases.indexOf(tagged.name);
    const selectedType = this.types[type];
    if (selectedType.kind !== "sum" || selectedCase < 0) {
      throw this.outside(span, `tag ${tagged.name} outside its sum`);
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
      ownership: "plain",
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
    const handler = this.evaluate(arguments_[2], environment);
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
      environment.names.set(pattern.name, value);
      return true;
    }
    if (pattern.tag === "tuple" && value.kind === "tuple") {
      return pattern.elements.length === value.elements.length &&
        pattern.elements.every((element, index) =>
          this.match(element, value.elements[index], environment)
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
    if (value.kind === "empty-store" && value.elementType !== undefined) {
      return this.storeType(value.elementType);
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
    if (kind === "text" || kind === "product") return "owned";
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
    return { names: new Map(), parent, staticParent };
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
}
