import {
  type BlotRuntimeBlock,
  type BlotRuntimeFunction,
  type BlotRuntimeModule,
  type BlotRuntimeOperation,
  type BlotRuntimeType,
} from "../../../gpupaper/src/blot_runtime_hir.ts";
import { PRIMITIVES } from "../comptime/primitives.ts";
import {
  type Env as StaticEnv,
  lookup,
  type Value,
} from "../comptime/value.ts";
import type { CheckResult } from "../check/mod.ts";
import { liveDeclarations } from "../syntax/live.ts";
import type { Decl, Expr, Pattern, Span } from "../syntax/ast.ts";
import type { StagedExport } from "../stage.ts";
import type { Lowered } from "./lower.ts";

type TypeId = number;
type ValueId = number;

type ResidualValue =
  | { readonly kind: "static"; readonly value: Value }
  | {
    readonly kind: "dynamic";
    readonly value: ValueId;
    readonly type: TypeId;
    readonly meaning?:
      | "ordering"
      | { readonly kind: "sum"; readonly cases: readonly string[] };
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
    readonly body: Expr;
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
  module: { readonly declarations: readonly Decl[]; readonly result: Expr },
  checked: CheckResult,
  stagedExports: readonly StagedExport[],
  lowered: Lowered,
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
  const loweredExport = lowered.exports.find((exported) =>
    exported.sourceName === "default"
  );
  if (loweredExport === undefined) {
    throw new Error(`${source}: lowering omitted runtime export default`);
  }

  const builder = new ResidualHirBuilder(source, checked);
  const function_ = builder.build(module, loweredExport.wasmName);
  return {
    format: "blot-runtime-hir",
    schemaVersion: 1,
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
          wasmName: loweredExport.wasmName,
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
    module: { readonly declarations: readonly Decl[]; readonly result: Expr },
    wasmName: string,
  ): BlotRuntimeFunction {
    this.block();
    const environment = this.environment(null, this.#checked.values);
    this.declarations(
      module.declarations,
      liveDeclarations(module.declarations, module.result),
      environment,
    );
    const result = this.dynamic(this.evaluate(module.result, environment));
    const resultType = this.types[result.type];
    if (resultType.kind !== "unit") {
      throw new TypeError(
        `${this.#source}: residual default export currently requires Unit, found ${resultType.kind}`,
      );
    }
    this.terminate({
      kind: "return",
      value: result.value,
      span: this.span(module.result.span),
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
      span: this.span(module.result.span),
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
    expr: Expr,
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
      const fn = this.evaluate(expr.fn, environment);
      const argument = this.evaluate(expr.arg, environment);
      return this.apply(fn, argument, expr.span);
    }
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
      this.declarations(
        expr.declarations,
        liveDeclarations(expr.declarations, expr.result),
        scope,
      );
      return this.evaluate(expr.result, scope);
    }
    if (expr.tag === "if") return this.conditional(expr, environment);
    if (expr.tag === "case") return this.caseExpression(expr, environment);
    throw this.outside(expr.span, expr.tag);
  }

  private declarations(
    declarations: readonly Decl[],
    live: ReadonlySet<Decl>,
    environment: ResidualEnvironment,
  ): void {
    for (const declaration of declarations) {
      if (!live.has(declaration)) continue;
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
      } else {
        value = this.evaluate(declaration.value, environment);
      }
      this.bind(declaration.pattern, value, environment, declaration.span);
    }
  }

  private apply(
    fn: ResidualValue,
    argument: ResidualValue,
    span: Span,
  ): ResidualValue {
    if (fn.kind === "static") {
      const value = fn.value;
      if (value.tag === "closure") {
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
        return this.hostCall(value, argument, span);
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
    if (fn.name !== "@text.concat" && fn.name !== "@text.cmp") {
      throw this.outside(span, `dynamic primitive ${fn.name}`);
    }
    const left = this.dynamic(applied[0]);
    const right = this.dynamic(applied[1]);
    if (
      this.types[left.type].kind !== "text" ||
      this.types[right.type].kind !== "text"
    ) {
      throw this.outside(span, `${fn.name} over non-text operands`);
    }
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

  private conditional(
    expr: Extract<Expr, { readonly tag: "if" }>,
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
      ownership: this.types[joined.type].kind === "text" ? "owned" : "plain",
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
    expr: Extract<Expr, { readonly tag: "case" }>,
    environment: ResidualEnvironment,
  ): ResidualValue {
    const target = this.evaluate(expr.target, environment);
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
      return this.sumCase(expr, target, target.meaning.cases, environment);
    }
    if (target.kind !== "dynamic" || target.meaning !== "ordering") {
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
    const zero = this.constant(0, this.type("integer-32"), expr.span);
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
      [target.value, zero.value],
      expr.span,
      undefined,
      operator,
    );
  }

  private sumCase(
    expr: Extract<Expr, { readonly tag: "case" }>,
    target: Extract<ResidualValue, { kind: "dynamic" }>,
    cases: readonly string[],
    environment: ResidualEnvironment,
  ): ResidualValue {
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
        type: this.type("unit"),
        operands: [target.value],
        ownership: "plain",
        case: index,
        span: this.span(expr.span),
      });
      const tagged: ResidualValue = {
        kind: "tag",
        name: cases[index],
        payload: {
          kind: "shape",
          fields: new Map([["value", {
            kind: "dynamic",
            value: payload,
            type: this.type("unit"),
          }]]),
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
      ownership: this.types[joined.type].kind === "text" ? "owned" : "plain",
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
    if (consequent.kind === "tag" && alternate.kind === "tag") {
      const cases = [...new Set([consequent.name, alternate.name])];
      const type = this.sumType(cases);
      this.#currentBlock = consequenceEnd;
      const consequentValue = this.materializeTag(
        consequent,
        type,
        cases,
        span,
      );
      this.#currentBlock = alternateEnd;
      const alternateValue = this.materializeTag(alternate, type, cases, span);
      return {
        consequent: consequentValue,
        alternate: alternateValue,
        type,
        meaning: { kind: "sum", cases },
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

  private materializeTag(
    tagged: Extract<ResidualValue, { kind: "tag" }>,
    type: TypeId,
    cases: readonly string[],
    span: Span,
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const payload = tagged.payload.kind === "shape"
      ? tagged.payload.fields.get("value")
      : tagged.payload;
    if (payload === undefined) {
      throw this.outside(span, `tag ${tagged.name} without value payload`);
    }
    const dynamicPayload = this.dynamic(payload);
    if (this.types[dynamicPayload.type].kind !== "unit") {
      throw this.outside(span, `non-Unit tag payload for ${tagged.name}`);
    }
    const result = this.nextValue();
    this.current().operations.push({
      kind: "sum.make",
      result,
      type,
      operands: [dynamicPayload.value],
      ownership: "plain",
      case: cases.indexOf(tagged.name),
      span: this.span(span),
    });
    return {
      kind: "dynamic",
      value: result,
      type,
      meaning: { kind: "sum", cases },
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
    const dynamicArgument = this.dynamic(argument);
    if (dynamicArgument.type !== parameterType) {
      throw this.outside(span, "host argument type disagreement");
    }
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
      ownership: this.types[resultType].kind === "text" ? "owned" : "plain",
      capability: operation.effect.name,
      operation: operation.name,
      span: this.span(span),
    });
    return { kind: "dynamic", value: result, type: resultType };
  }

  private project(
    value: ResidualValue,
    name: string,
    span: Span,
  ): ResidualValue {
    if (value.kind === "shape") {
      const field = value.fields.get(name);
      if (field !== undefined) return field;
    }
    if (value.kind !== "static") throw this.outside(span, "dynamic projection");
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
    const staticValue = this.staticValue(value);
    if (staticValue === undefined) {
      throw new TypeError(
        `${this.#source}: residual composite cannot enter Runtime HIR`,
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
    throw new TypeError(
      `${this.#source}: static ${staticValue.tag} is outside the residual Runtime-HIR calculus`,
    );
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
    kind: "text.append" | "text.compare" | "scalar",
    type: TypeId,
    operands: readonly ValueId[],
    span: Span,
    meaning?: Extract<ResidualValue, { kind: "dynamic" }>["meaning"],
    operator?:
      | "equal"
      | "not-equal"
      | "less-than"
      | "less-than-or-equal"
      | "greater-than"
      | "greater-than-or-equal",
  ): Extract<ResidualValue, { kind: "dynamic" }> {
    const result = this.nextValue();
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
        ownership: kind === "text.append" ? "owned" : "plain",
        span: this.span(span),
      };
    this.current().operations.push(operation);
    return { kind: "dynamic", value: result, type, meaning };
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
    if (
      value.tag === "range" && value.domain === "text" &&
      value.low.tag === "unbounded" && value.high.tag === "unbounded"
    ) return this.type("text");
    throw this.outside(span, `host type ${value.tag}`);
  }

  private type(name: "unit" | "boolean" | "integer-32" | "text"): TypeId {
    const existing = this.#typeByName.get(name);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    this.#typeByName.set(name, type);
    this.types.push({ kind: name });
    return type;
  }

  private sumType(cases: readonly string[]): TypeId {
    const key = `sum:${cases.join("|")}`;
    const existing = this.#typeByName.get(key);
    if (existing !== undefined) return existing;
    const type = this.types.length;
    const unit = this.type("unit");
    this.#typeByName.set(key, type);
    this.types.push({
      kind: "sum",
      name: `residual$${type}`,
      cases: cases.map((name) => ({ name, payloadType: unit })),
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
