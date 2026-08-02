import {
  type BlotRuntimeFunction,
  type BlotRuntimeModule,
  type BlotRuntimeOperation,
  type BlotRuntimeType,
} from "../../../gpupaper/src/blot_runtime_hir.ts";
import {
  F32X4_TYPE_NAME,
  MASK32X4_TYPE_NAME,
  STORE_TYPE_NAME,
  TEXT_TYPE_NAME,
  type TypeSchema,
} from "gpufuck";
import type { Value } from "../comptime/value.ts";
import type { StagedExport } from "../stage.ts";
import type { Lowered, RuntimeTypeDeclaration } from "./lower.ts";

type RuntimeValueExport = {
  readonly staged: StagedExport;
  readonly wasmName: string;
  readonly type: TypeSchema;
  readonly value: Value;
  readonly hostCalls: readonly ResidualHostCall[];
};

export type ResidualHostCall = {
  readonly capability: string;
  readonly operation: string;
  readonly argument: Value;
};

export type ResidualRuntimeExport = {
  readonly value: Value;
  readonly hostCalls: readonly ResidualHostCall[];
};

export function exportConstantRuntimeHir(
  source: string,
  stagedExports: readonly StagedExport[],
  lowered: Lowered,
  residualExports: ReadonlyMap<string, ResidualRuntimeExport> = new Map(),
): BlotRuntimeModule {
  const runtimeExports = stagedExports.flatMap((staged) => {
    if (staged.phase !== "runtime") return [];
    const loweredExport = lowered.exports.find((candidate) =>
      candidate.sourceName === staged.sourceName
    );
    if (loweredExport === undefined) {
      throw new Error(`lowering omitted runtime export ${staged.sourceName}`);
    }
    const residual = residualExports.get(staged.sourceName);
    const value = residual?.value ?? staged.value;
    if (value === undefined) {
      throw new TypeError(
        `${source}: runtime export ${staged.sourceName} was not reduced to a value before constant HIR export`,
      );
    }
    return [{
      staged,
      wasmName: loweredExport.wasmName,
      type: loweredExport.type,
      value,
      hostCalls: residual?.hostCalls ?? [],
    }];
  });
  if (runtimeExports.length === 0) {
    throw new TypeError(
      `${source}: constant HIR export requires at least one runtime value`,
    );
  }

  const builder = new ConstantHirBuilder(source, lowered.runtimeTypes);
  const functions = runtimeExports.map((exported, functionId) =>
    builder.function(exported, functionId)
  );
  return {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source,
    types: builder.types,
    signatures: builder.signatures,
    functions,
    capabilities: builder.capabilities(),
    exports: stagedExports.map((staged) => {
      if (staged.phase === "comptime") {
        return {
          sourceName: staged.sourceName,
          phase: "comptime" as const,
        };
      }
      const functionId = runtimeExports.findIndex((candidate) =>
        candidate.staged === staged
      );
      return {
        sourceName: staged.sourceName,
        phase: "runtime" as const,
        wasmName: runtimeExports[functionId].wasmName,
        function: functionId,
        signature: functions[functionId].signature,
        ownership: "owned" as const,
      };
    }),
  };
}

class ConstantHirBuilder {
  readonly types: BlotRuntimeType[] = [];
  readonly signatures: {
    parameters: readonly number[];
    result: number;
    effects: readonly string[];
  }[] = [];
  readonly #typeBySchema = new Map<string, number>();
  readonly #capabilityOperations = new Map<
    string,
    Map<string, { signature: number; parameterKey: string }>
  >();
  readonly #runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>;
  readonly #source: string;
  readonly #span: { file: string; start: number; end: number };
  #nextValue = 0;

  constructor(
    source: string,
    runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
  ) {
    this.#source = source;
    this.#span = { file: source, start: 0, end: 0 };
    this.#runtimeTypes = runtimeTypes;
    this.type({ kind: "unit" });
  }

  function(
    exported: RuntimeValueExport,
    functionId: number,
  ): BlotRuntimeFunction {
    const resultType = this.type(exported.type);
    const signature = this.signatures.length;
    const effects = [
      ...new Set(
        exported.hostCalls.map((call) => call.capability),
      ),
    ].sort();
    this.signatures.push({ parameters: [], result: resultType, effects });
    this.#nextValue = 0;
    const operations: BlotRuntimeOperation[] = [];
    for (const call of exported.hostCalls) this.hostCall(call, operations);
    const result = this.value(exported.value, exported.type, operations);
    return {
      id: functionId,
      name: `blot$constant$${exported.staged.sourceName}`,
      signature,
      entryBlock: 0,
      blocks: [{
        id: 0,
        parameters: [],
        operations,
        terminator: { kind: "return", value: result, span: this.#span },
      }],
      span: this.#span,
    };
  }

  capabilities() {
    return [...this.#capabilityOperations].sort(([left], [right]) =>
      left.localeCompare(right)
    ).map(([name, operations]) => ({
      name,
      operations: [...operations].sort(([left], [right]) =>
        left.localeCompare(right)
      ).map(([operation, declaration]) => ({
        name: operation,
        signature: declaration.signature,
      })),
    }));
  }

  type(schema: TypeSchema): number {
    const key = JSON.stringify(schema);
    const existing = this.#typeBySchema.get(key);
    if (existing !== undefined) return existing;
    const typeId = this.types.length;
    this.#typeBySchema.set(key, typeId);
    this.types.push({ kind: "unit" });
    this.types[typeId] = this.buildType(schema);
    return typeId;
  }

  value(
    value: Value,
    schema: TypeSchema,
    operations: BlotRuntimeOperation[],
  ): number {
    const type = this.type(schema);
    if (schema.kind === "unit" && value.tag === "unit") {
      return this.constant(null, type, operations);
    }
    if (schema.kind === "signed-integer-64" && value.tag === "int") {
      return this.constant(value.value, type, operations);
    }
    if (schema.kind === "float-64" && value.tag === "float") {
      return this.constant(value.value, type, operations);
    }
    if (schema.kind === "float-32" && value.tag === "float32") {
      return this.constant(value.value, type, operations);
    }
    if (schema.kind === "boolean" && value.tag === "tag") {
      if (value.name !== "True" && value.name !== "False") {
        throw this.mismatch(value, schema);
      }
      return this.constant(value.name === "True", type, operations);
    }
    if (
      schema.kind === "named" && schema.name === TEXT_TYPE_NAME &&
      value.tag === "text"
    ) {
      return this.constant(value.value, type, operations);
    }
    if (
      schema.kind === "named" && schema.name === STORE_TYPE_NAME &&
      value.tag === "array"
    ) {
      return this.array(value.elements, schema, type, operations);
    }
    if (schema.kind === "named" && value.tag === "shape") {
      return this.record(value, schema, type, operations);
    }
    if (schema.kind === "named" && value.tag === "tag") {
      return this.variant(value, schema, type, operations);
    }
    if (schema.kind === "named" && value.tag === "sealed") {
      const innerSchema = schema.arguments[0];
      if (innerSchema === undefined) throw this.mismatch(value, schema);
      const inner = this.value(value.inner, innerSchema, operations);
      const result = this.nextValue();
      operations.push({
        kind: "seal.wrap",
        result,
        type,
        operands: [inner],
        ownership: "owned",
        span: this.#span,
      });
      return result;
    }
    throw this.mismatch(value, schema);
  }

  private buildType(schema: TypeSchema): BlotRuntimeType {
    if (schema.kind === "unit") return { kind: "unit" };
    if (schema.kind === "signed-integer-64") {
      return { kind: "signed-integer-64" };
    }
    if (schema.kind === "float-32") return { kind: "float-32" };
    if (schema.kind === "float-64") return { kind: "float-64" };
    if (schema.kind === "boolean") return { kind: "boolean" };
    if (schema.kind === "function") {
      throw new TypeError(
        `${this.#source}: a staged function value requires residual function lowering`,
      );
    }
    if (schema.kind !== "named") {
      throw new TypeError(
        `${this.#source}: constant HIR cannot publish ${schema.kind}`,
      );
    }
    if (schema.name === TEXT_TYPE_NAME) return { kind: "text" };
    if (schema.name === F32X4_TYPE_NAME) {
      return { kind: "vector", element: "float-32", lanes: 4 };
    }
    if (schema.name === MASK32X4_TYPE_NAME) {
      return { kind: "mask", element: "float-32", lanes: 4 };
    }
    if (schema.name === STORE_TYPE_NAME) {
      const element = schema.arguments[0];
      if (element === undefined || schema.arguments.length !== 1) {
        throw new TypeError(`${this.#source}: Store requires one element type`);
      }
      return { kind: "store", elementType: this.type(element) };
    }
    const declaration = this.#runtimeTypes.get(schema.name);
    if (declaration === undefined) {
      throw new TypeError(
        `${this.#source}: constant HIR omitted runtime type ${schema.name}`,
      );
    }
    if (declaration.kind === "record") {
      if (declaration.fields.length !== schema.arguments.length) {
        throw new TypeError(
          `${this.#source}: record ${schema.name} has ${schema.arguments.length} types for ${declaration.fields.length} fields`,
        );
      }
      return {
        kind: "product",
        name: schema.name,
        fields: declaration.fields.map((name, index) => ({
          name,
          type: this.type(schema.arguments[index]),
        })),
      };
    }
    if (declaration.kind === "sealed") {
      const representation = schema.arguments[0];
      if (representation === undefined || schema.arguments.length !== 1) {
        throw new TypeError(
          `${this.#source}: seal ${schema.name} requires one representation`,
        );
      }
      return {
        kind: "sealed",
        name: declaration.sourceName,
        representationType: this.type(representation),
      };
    }
    let argument = 0;
    const unit = this.type({ kind: "unit" });
    const cases = declaration.cases.map((case_) => {
      let payloadType = unit;
      if (case_.payload) {
        const payload = schema.arguments[argument++];
        if (payload === undefined) {
          throw new TypeError(
            `${this.#source}: variant ${schema.name} omitted ${case_.sourceName} payload`,
          );
        }
        payloadType = this.type(payload);
      }
      return { name: case_.sourceName, payloadType };
    });
    if (argument !== schema.arguments.length) {
      throw new TypeError(
        `${this.#source}: variant ${schema.name} has ${
          schema.arguments.length - argument
        } unused type arguments`,
      );
    }
    return { kind: "sum", name: schema.name, cases };
  }

  private array(
    elements: readonly Value[],
    schema: TypeSchema & { readonly kind: "named" },
    type: number,
    operations: BlotRuntimeOperation[],
  ): number {
    const elementSchema = schema.arguments[0];
    if (elementSchema === undefined) {
      throw this.mismatch({ tag: "array", elements }, schema);
    }
    if (elements.length === 0) {
      const result = this.nextValue();
      operations.push({
        kind: "store.empty",
        result,
        type,
        operands: [],
        ownership: "owned",
        span: this.#span,
      });
      return result;
    }
    const lengthType = this.type({ kind: "signed-integer-64" });
    const length = this.constant(
      BigInt(elements.length),
      lengthType,
      operations,
    );
    const first = this.value(elements[0], elementSchema, operations);
    let store = this.nextValue();
    operations.push({
      kind: "store.new",
      result: store,
      type,
      operands: [length, first],
      ownership: "owned",
      span: this.#span,
    });
    for (let index = 1; index < elements.length; index += 1) {
      const position = this.constant(BigInt(index), lengthType, operations);
      const element = this.value(elements[index], elementSchema, operations);
      const updated = this.nextValue();
      operations.push({
        kind: "store.write",
        result: updated,
        type,
        operands: [store, position, element],
        ownership: "owned",
        update: "owned-reuse",
        span: this.#span,
      });
      store = updated;
    }
    return store;
  }

  private record(
    value: Extract<Value, { readonly tag: "shape" }>,
    schema: TypeSchema & { readonly kind: "named" },
    type: number,
    operations: BlotRuntimeOperation[],
  ): number {
    const hirType = this.types[type];
    if (hirType.kind !== "product") throw this.mismatch(value, schema);
    const operands = hirType.fields.map((field, index) => {
      const fieldValue = value.fields.get(field.name);
      const fieldSchema = schema.arguments[index];
      if (fieldValue === undefined || fieldSchema === undefined) {
        throw this.mismatch(value, schema);
      }
      return this.value(fieldValue, fieldSchema, operations);
    });
    const result = this.nextValue();
    operations.push({
      kind: "product.make",
      result,
      type,
      operands,
      ownership: "owned",
      span: this.#span,
    });
    return result;
  }

  private variant(
    value: Extract<Value, { readonly tag: "tag" }>,
    schema: TypeSchema & { readonly kind: "named" },
    type: number,
    operations: BlotRuntimeOperation[],
  ): number {
    const hirType = this.types[type];
    if (hirType.kind !== "sum") throw this.mismatch(value, schema);
    const caseIndex = hirType.cases.findIndex((case_) =>
      case_.name === value.name
    );
    if (caseIndex < 0) throw this.mismatch(value, schema);
    const declaration = this.#runtimeTypes.get(schema.name);
    if (declaration === undefined || declaration.kind !== "variant") {
      throw this.mismatch(value, schema);
    }
    let schemaArgument = 0;
    let payloadSchema: TypeSchema = { kind: "unit" };
    for (let index = 0; index <= caseIndex; index += 1) {
      if (!declaration.cases[index].payload) continue;
      const argument = schema.arguments[schemaArgument++];
      if (argument === undefined) throw this.mismatch(value, schema);
      if (index === caseIndex) payloadSchema = argument;
    }
    const payload = value.payload === null
      ? this.constant(null, this.type({ kind: "unit" }), operations)
      : this.value(value.payload, payloadSchema, operations);
    const result = this.nextValue();
    operations.push({
      kind: "sum.make",
      result,
      type,
      operands: [payload],
      ownership: "owned",
      case: caseIndex,
      span: this.#span,
    });
    return result;
  }

  private constant(
    value: bigint | number | boolean | string | null,
    type: number,
    operations: BlotRuntimeOperation[],
  ): number {
    const result = this.nextValue();
    operations.push({
      kind: "constant",
      result,
      type,
      operands: [],
      ownership: typeof value === "string" ? "owned" : "plain",
      value,
      span: this.#span,
    });
    return result;
  }

  private hostCall(
    call: ResidualHostCall,
    operations: BlotRuntimeOperation[],
  ): void {
    const parameterSchema = valueSchema(this.#source, call.argument);
    const parameterType = this.type(parameterSchema);
    const unitType = this.type({ kind: "unit" });
    const parameterKey = JSON.stringify(parameterSchema);
    const capability = this.#capabilityOperations.get(call.capability) ??
      new Map<string, { signature: number; parameterKey: string }>();
    const existing = capability.get(call.operation);
    if (existing !== undefined && existing.parameterKey !== parameterKey) {
      throw new TypeError(
        `${this.#source}: residual host operation ${call.capability}.${call.operation} has inconsistent argument types`,
      );
    }
    if (existing === undefined) {
      const signature = this.signatures.length;
      this.signatures.push({
        parameters: [parameterType],
        result: unitType,
        effects: [call.capability],
      });
      capability.set(call.operation, { signature, parameterKey });
      this.#capabilityOperations.set(call.capability, capability);
    }
    const argument = this.value(call.argument, parameterSchema, operations);
    const result = this.nextValue();
    operations.push({
      kind: "host.call",
      result,
      type: unitType,
      operands: [argument],
      ownership: "plain",
      capability: call.capability,
      operation: call.operation,
      span: this.#span,
    });
  }

  private nextValue(): number {
    const value = this.#nextValue;
    this.#nextValue += 1;
    return value;
  }

  private mismatch(value: Value, schema: TypeSchema): TypeError {
    return new TypeError(
      `${this.#source}: staged ${value.tag} value does not inhabit lowered ${schema.kind} schema`,
    );
  }
}

function valueSchema(source: string, value: Value): TypeSchema {
  if (value.tag === "int") return { kind: "signed-integer-64" };
  if (value.tag === "float") return { kind: "float-64" };
  if (value.tag === "float32") return { kind: "float-32" };
  if (value.tag === "text") {
    return { kind: "named", name: TEXT_TYPE_NAME, arguments: [] };
  }
  if (value.tag === "unit") return { kind: "unit" };
  if (
    value.tag === "tag" && value.payload === null &&
    (value.name === "True" || value.name === "False")
  ) return { kind: "boolean" };
  throw new TypeError(
    `${source}: residual host argument ${value.tag} is not yet first-order`,
  );
}
