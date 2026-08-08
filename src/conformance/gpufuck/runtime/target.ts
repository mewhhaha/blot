import {
  blotAbiCustomSectionName,
  type BlotAbiManifest,
  buildBlotAbiManifest,
  requireDirectBlotAbiBoundary,
  serializeBlotAbiManifest,
} from "./abi.ts";
import { compileBlotConstantAbi } from "./constant_abi.ts";
import {
  compileBlotCanonicalTextAbi,
  supportsBlotCanonicalTextAbi,
} from "./canonical_text_abi.ts";
import {
  type CoreBinaryOperator,
  type CoreBlockId,
  type CoreFunction,
  type CoreFunctionId,
  type CoreModule,
  type CoreOperation,
  type CoreSignatureId,
  type CoreType,
  type CoreTypeId,
  type CoreValueId,
  type CoreWasmArtifact,
  emitWasmPlanOnRustWasm,
  lowerCoreToWasm,
  PrimitiveId,
  type WasmTarget,
} from "@mewhhaha/gpupaper";
import type {
  BlotRuntimeFunction,
  BlotRuntimeModule,
  BlotRuntimeOperation,
  BlotRuntimeType,
  ValidatedBlotRuntimeModule,
} from "../../../runtime/hir.ts";
import { addBlotAbiModuleShell } from "./wasm_shell.ts";

export type BlotRuntimeTargetArtifact = CoreWasmArtifact & {
  readonly core: CoreModule;
  readonly manifest: BlotAbiManifest;
  readonly manifestBytes: Uint8Array;
};

export type RustWasmBlotRuntimeBatchArtifact = BlotRuntimeTargetArtifact & {
  readonly wasm: Uint8Array;
};

export type RustWasmBlotRuntimeBatch = {
  readonly artifacts: readonly RustWasmBlotRuntimeBatchArtifact[];
};

export function compileBlotRuntimeModule(
  module: ValidatedBlotRuntimeModule,
  options: {
    readonly emission?: "cpu" | "planOnly";
    readonly target?: WasmTarget;
  } = {},
): BlotRuntimeTargetArtifact {
  const core = lowerBlotRuntimeModuleToCore(module);
  const manifest = buildBlotAbiManifest(module);
  const manifestBytes = serializeBlotAbiManifest(manifest);
  const runtimeExports = module.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  let emission = options.emission;
  if (emission === undefined) emission = "cpu";
  let target = options.target;
  if (target === undefined) target = "wasm-simd128";
  let lowered: CoreWasmArtifact;
  let directBoundaryError: unknown;
  try {
    requireDirectBlotAbiBoundary(manifest);
  } catch (error) {
    directBoundaryError = error;
  }
  if (directBoundaryError === undefined) {
    lowered = lowerCoreToWasm(core, {
      emission,
      target,
      exports: runtimeExports.map((exported) => ({
        name: exported.wasmName,
        functionId: exported.function as CoreFunctionId,
      })),
      moduleShell: (builder) => {
        addBlotAbiModuleShell(builder, manifestBytes);
      },
    });
  } else {
    let canonical;
    if (supportsBlotCanonicalTextAbi(module, manifest)) {
      canonical = compileBlotCanonicalTextAbi(module, manifest, manifestBytes);
    } else {
      canonical = compileBlotConstantAbi(module, manifest, manifestBytes);
    }
    const support = lowerCoreToWasm(core, {
      emission: "planOnly",
      target,
      exports: [],
    });
    let wasm: Uint8Array | undefined = canonical.wasm;
    if (emission === "planOnly") wasm = undefined;
    lowered = {
      ...support,
      wasmPlan: canonical.wasmPlan,
      wasm,
    };
  }
  let embeddedManifest: ArrayBuffer[] = [];
  if (lowered.wasm !== undefined) {
    embeddedManifest = WebAssembly.Module.customSections(
      new WebAssembly.Module(lowered.wasm as BufferSource),
      blotAbiCustomSectionName,
    );
  }
  if (
    embeddedManifest.length === 1 &&
    !byteArraysEqual(new Uint8Array(embeddedManifest[0]), manifestBytes)
  ) {
    throw new Error(
      `${module.source}: emitted blot:abi custom section differs from its manifest bytes`,
    );
  }
  return { ...lowered, core, manifest, manifestBytes };
}

export async function compileBlotRuntimeModulesOnRustWasm(
  modules: readonly ValidatedBlotRuntimeModule[],
  options: {
    readonly target?: WasmTarget;
  } = {},
): Promise<RustWasmBlotRuntimeBatch> {
  const planned = modules.map((module) =>
    compileBlotRuntimeModule(module, {
      emission: "planOnly",
      target: options.target,
    })
  );
  const artifacts: RustWasmBlotRuntimeBatchArtifact[] = [];
  for (const [index, artifact] of planned.entries()) {
    const module = modules[index]!;
    const wasm = (await emitWasmPlanOnRustWasm(artifact.wasmPlan)).bytes;
    requireBlotWasm(module, wasm, artifact.manifestBytes, "Rust/WebAssembly");
    artifacts.push({ ...artifact, wasm });
  }
  return { artifacts };
}

function requireBlotWasm(
  module: ValidatedBlotRuntimeModule,
  wasm: Uint8Array,
  manifestBytes: Uint8Array,
  emitterName: "Rust/WebAssembly",
): {
  readonly wasmValidationMilliseconds: number;
  readonly manifestValidationMilliseconds: number;
} {
  const wasmValidationStart = performance.now();
  if (!WebAssembly.validate(Uint8Array.from(wasm))) {
    throw new Error(
      `${module.source}: ${emitterName} emitted invalid WebAssembly`,
    );
  }
  const wasmValidationMilliseconds = performance.now() -
    wasmValidationStart;
  const manifestValidationStart = performance.now();
  const embeddedManifest = WebAssembly.Module.customSections(
    new WebAssembly.Module(wasm as BufferSource),
    blotAbiCustomSectionName,
  );
  if (
    embeddedManifest.length !== 1 ||
    !byteArraysEqual(new Uint8Array(embeddedManifest[0]!), manifestBytes)
  ) {
    throw new Error(
      `${module.source}: ${emitterName} emitted a blot:abi custom section that differs from its manifest bytes`,
    );
  }
  return {
    wasmValidationMilliseconds,
    manifestValidationMilliseconds: performance.now() -
      manifestValidationStart,
  };
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

export function lowerBlotRuntimeModuleToCore(
  module: ValidatedBlotRuntimeModule,
): CoreModule {
  const runtimeExports = module.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  if (runtimeExports.length === 0) {
    throw new TypeError(
      `${module.source}: Blot Runtime HIR has no runtime export to select as the Core entry`,
    );
  }
  const types = lowerTypes(module);
  const signatures = module.signatures.map((signature) => ({
    parameters: signature.parameters.map((type) => type as CoreTypeId),
    result: signature.result as CoreTypeId,
  }));
  const checkedIntegerOperations = requiredCheckedIntegerOperations(module);
  const checkedIntegerHelpers = new Map<
    "add" | "subtract" | "multiply",
    CoreFunctionId
  >();
  let checkedIntegerSignature: CoreSignatureId | undefined;
  if (checkedIntegerOperations.length > 0) {
    const signedIntegerType = requiredRuntimeType(
      module,
      "signed-integer-64",
    );
    checkedIntegerSignature = signatures.length as CoreSignatureId;
    signatures.push({
      parameters: [signedIntegerType, signedIntegerType],
      result: signedIntegerType,
    });
    checkedIntegerOperations.forEach((operator, index) =>
      checkedIntegerHelpers.set(
        operator,
        (module.functions.length + index) as CoreFunctionId,
      )
    );
  }
  const functions: CoreFunction[] = module.functions.map((
    function_,
  ) => {
    const valueTypes = runtimeValueTypes(function_);
    return {
      id: function_.id as CoreFunctionId,
      name: function_.name,
      sourceIdentity: undefined,
      signature: function_.signature as CoreSignatureId,
      entryBlock: function_.entryBlock as CoreBlockId,
      blocks: function_.blocks.map((block) => {
        let terminator: CoreFunction["blocks"][number]["terminator"];
        if (block.terminator.kind === "branch") {
          terminator = {
            kind: "branch" as const,
            target: block.terminator.target as CoreBlockId,
            arguments: block.terminator.arguments.map((value) =>
              value as CoreValueId
            ),
            span: block.terminator.span,
          };
        } else if (block.terminator.kind === "conditional") {
          terminator = {
            kind: "conditional_branch" as const,
            condition: block.terminator.condition as CoreValueId,
            trueTarget: block.terminator.consequent as CoreBlockId,
            trueArguments: block.terminator.consequentArguments.map((value) =>
              value as CoreValueId
            ),
            falseTarget: block.terminator.alternate as CoreBlockId,
            falseArguments: block.terminator.alternateArguments.map((value) =>
              value as CoreValueId
            ),
            span: block.terminator.span,
          };
        } else if (block.terminator.kind === "return") {
          terminator = {
            kind: "return" as const,
            values: [block.terminator.value as CoreValueId],
            span: block.terminator.span,
          };
        } else {
          terminator = {
            kind: "trap" as const,
            span: block.terminator.span,
          };
        }
        return {
          id: block.id as CoreBlockId,
          parameters: block.parameters.map((parameter) => ({
            value: parameter.value as CoreValueId,
            type: parameter.type as CoreTypeId,
            span: parameter.span,
          })),
          operations: block.operations.map((operation) =>
            lowerOperation(
              module,
              operation,
              valueTypes,
              checkedIntegerHelpers,
            )
          ),
          terminator,
        };
      }),
      span: function_.span,
    };
  });
  if (checkedIntegerSignature !== undefined) {
    const signedIntegerType = requiredRuntimeType(
      module,
      "signed-integer-64",
    );
    const booleanType = requiredRuntimeType(module, "boolean");
    for (const operator of checkedIntegerOperations) {
      functions.push(
        checkedIntegerHelper(
          module,
          operator,
          checkedIntegerHelpers.get(operator)!,
          checkedIntegerSignature,
          signedIntegerType,
          booleanType,
        ),
      );
    }
  }
  return {
    schemaVersion: 1,
    file: module.source,
    types,
    signatures,
    functions,
    entryFunction: runtimeExports[0].function as CoreFunctionId,
  };
}

function lowerTypes(module: BlotRuntimeModule): readonly CoreType[] {
  const types: CoreType[] = [];
  const resolvingSeals = new Set<number>();
  const lowerType = (
    type: BlotRuntimeType,
    typeId: number,
  ): CoreType => {
    if (type.kind === "unit") return { kind: "scalar", scalar: "unit" };
    if (type.kind === "integer-32" || type.kind === "boolean") {
      return { kind: "scalar", scalar: "i32" };
    }
    if (type.kind === "signed-integer-64") {
      return { kind: "scalar", scalar: "i64" };
    }
    if (type.kind === "float-32") return { kind: "scalar", scalar: "f32" };
    if (type.kind === "float-64") return { kind: "scalar", scalar: "f64" };
    if (type.kind === "text") return { kind: "buffer", buffer: "text" };
    if (type.kind === "vector" || type.kind === "mask") {
      let element: "f32" | "i32" | "i16" | "i8" = "f32";
      if (type.element === "integer-32") element = "i32";
      if (type.element === "integer-16") element = "i16";
      if (type.element === "integer-8") element = "i8";
      return { kind: type.kind, lanes: type.lanes, element };
    }
    if (type.kind === "product") {
      return {
        kind: "product",
        fields: type.fields.map((field) => field.type as CoreTypeId),
      };
    }
    if (type.kind === "sum") {
      return {
        kind: "sum",
        cases: type.cases.map((case_) => case_.payloadType as CoreTypeId),
      };
    }
    if (type.kind === "function") {
      return {
        kind: "function",
        signature: type.signature as CoreSignatureId,
      };
    }
    if (type.kind === "store") {
      return { kind: "store", element: type.elementType as CoreTypeId };
    }
    if (type.kind === "sealed") {
      if (resolvingSeals.has(typeId)) {
        throw new TypeError(
          `${module.source}: sealed type ${type.name} has a cyclic representation`,
        );
      }
      resolvingSeals.add(typeId);
      const representation = module.types[type.representationType];
      const lowered = lowerType(representation, type.representationType);
      resolvingSeals.delete(typeId);
      return lowered;
    }
    throw new TypeError(
      `${module.source}: Blot Runtime HIR type ${typeId} has unsupported kind ${
        (type as BlotRuntimeType).kind
      }`,
    );
  };
  module.types.forEach((type, typeId) => types.push(lowerType(type, typeId)));
  return types;
}

function lowerOperation(
  module: BlotRuntimeModule,
  operation: BlotRuntimeOperation,
  valueTypes: ReadonlyMap<number, number>,
  checkedIntegerHelpers: ReadonlyMap<
    "add" | "subtract" | "multiply",
    CoreFunctionId
  >,
): CoreOperation {
  const base = {
    result: operation.result as CoreValueId,
    type: operation.type as CoreTypeId,
    operands: operation.operands.map((operand) => operand as CoreValueId),
    span: operation.span,
  };
  if (operation.kind === "constant") {
    let value: number | bigint | boolean | string | undefined;
    if (operation.value === null) value = undefined;
    else value = operation.value;
    return {
      ...base,
      kind: "constant",
      value,
    };
  }
  if (operation.kind === "scalar") {
    const checkedHelper = checkedIntegerHelperForOperation(
      module,
      operation,
      valueTypes,
      checkedIntegerHelpers,
    );
    if (checkedHelper !== undefined) {
      return {
        ...base,
        kind: "call.direct",
        functionId: checkedHelper,
      };
    }
    return {
      ...base,
      kind: "scalar.binary",
      operator: binaryOperator(operation.operator),
    };
  }
  if (operation.kind === "convert") {
    return {
      ...base,
      kind: "primitive",
      primitiveId: conversionPrimitive(module, operation),
    };
  }
  if (operation.kind === "text.append") {
    return {
      ...base,
      kind: "primitive",
      primitiveId: PrimitiveId.bufferAppend,
    };
  }
  if (
    operation.kind === "text.length" || operation.kind === "text.from-i64" ||
    operation.kind === "text.compare" || operation.kind === "text.contains"
  ) {
    return {
      ...base,
      kind: "primitive",
      primitiveId: {
        "text.length": PrimitiveId.textCodePointLength,
        "text.from-i64": PrimitiveId.textFromI64,
        "text.compare": PrimitiveId.textCompare,
        "text.contains": PrimitiveId.textContains,
      }[operation.kind],
    };
  }
  if (operation.kind === "vector") {
    return {
      ...base,
      kind: "primitive",
      primitiveId: vectorPrimitive(module, operation, valueTypes),
    };
  }
  if (operation.kind === "product.make") {
    return { ...base, kind: operation.kind };
  }
  if (operation.kind === "product.project") {
    return { ...base, kind: operation.kind, index: operation.field };
  }
  if (operation.kind === "sum.make") {
    return { ...base, kind: operation.kind, caseIndex: operation.case };
  }
  if (operation.kind === "sum.tag") return { ...base, kind: operation.kind };
  if (operation.kind === "sum.payload") {
    return { ...base, kind: operation.kind, caseIndex: operation.case };
  }
  if (
    operation.kind === "store.empty" || operation.kind === "store.new" ||
    operation.kind === "store.length" || operation.kind === "store.read"
  ) {
    return { ...base, kind: operation.kind };
  }
  if (operation.kind === "store.write" || operation.kind === "store.grow") {
    return { ...base, kind: operation.kind, update: operation.update };
  }
  if (operation.kind === "call.direct") {
    return {
      ...base,
      kind: operation.kind,
      functionId: operation.function as CoreFunctionId,
    };
  }
  if (operation.kind === "closure.make") {
    return {
      ...base,
      kind: operation.kind,
      functionId: operation.function as CoreFunctionId,
    };
  }
  if (operation.kind === "call.indirect") {
    return {
      ...base,
      kind: operation.kind,
      signature: operation.signature as CoreSignatureId,
    };
  }
  if (operation.kind === "host.call") {
    return {
      ...base,
      kind: operation.kind,
      effectName: `blot:host/${operation.capability}`,
      operationName: operation.operation,
    };
  }
  if (
    operation.kind === "seal.wrap" ||
    operation.kind === "seal.unwrap" ||
    operation.kind === "resource.move" ||
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze" ||
    operation.kind === "resource.drop"
  ) {
    return { ...base, kind: operation.kind };
  }
  throw new TypeError(
    `${module.source}:${operation.span.start}: Blot runtime target does not yet lower ${operation.kind}`,
  );
}

function checkedIntegerHelperForOperation(
  module: BlotRuntimeModule,
  operation: Extract<BlotRuntimeOperation, { readonly kind: "scalar" }>,
  valueTypes: ReadonlyMap<number, number>,
  helpers: ReadonlyMap<
    "add" | "subtract" | "multiply",
    CoreFunctionId
  >,
): CoreFunctionId | undefined {
  const operandType = valueTypes.get(operation.operands[0]);
  if (
    operandType === undefined ||
    module.types[operandType]?.kind !== "signed-integer-64"
  ) {
    return undefined;
  }
  if (
    operation.operator !== "add" && operation.operator !== "subtract" &&
    operation.operator !== "multiply"
  ) return undefined;
  const helper = helpers.get(operation.operator);
  if (helper !== undefined) return helper;
  throw new Error(
    `${module.source}:${operation.span.start}: checked ${operation.operator} helper was not constructed`,
  );
}

function runtimeValueTypes(
  function_: BlotRuntimeFunction,
): ReadonlyMap<number, number> {
  const types = new Map<number, number>();
  for (const block of function_.blocks) {
    block.parameters.forEach((parameter) =>
      types.set(parameter.value, parameter.type)
    );
    block.operations.forEach((operation) =>
      types.set(operation.result, operation.type)
    );
  }
  return types;
}

function requiredCheckedIntegerOperations(
  module: BlotRuntimeModule,
): readonly ("add" | "subtract" | "multiply")[] {
  const required = new Set<"add" | "subtract" | "multiply">();
  for (const function_ of module.functions) {
    const valueTypes = runtimeValueTypes(function_);
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (operation.kind !== "scalar") continue;
        if (
          operation.operator !== "add" &&
          operation.operator !== "subtract" &&
          operation.operator !== "multiply"
        ) continue;
        const operandType = valueTypes.get(operation.operands[0]);
        if (
          operandType !== undefined &&
          module.types[operandType]?.kind === "signed-integer-64"
        ) {
          required.add(operation.operator);
        }
      }
    }
  }
  return (["add", "subtract", "multiply"] as const).filter((operator) =>
    required.has(operator)
  );
}

function requiredRuntimeType(
  module: BlotRuntimeModule,
  kind: "signed-integer-64" | "boolean",
): CoreTypeId {
  const type = module.types.findIndex((candidate) => candidate.kind === kind);
  if (type !== -1) return type as CoreTypeId;
  throw new TypeError(
    `${module.source}: checked I64 arithmetic requires a Runtime HIR ${kind} type`,
  );
}

function checkedIntegerHelper(
  module: BlotRuntimeModule,
  operator: "add" | "subtract" | "multiply",
  functionId: CoreFunctionId,
  signature: CoreSignatureId,
  signedIntegerType: CoreTypeId,
  booleanType: CoreTypeId,
): CoreFunction {
  if (operator === "multiply") {
    return checkedMultiplyHelper(
      module,
      functionId,
      signature,
      signedIntegerType,
      booleanType,
    );
  }
  return checkedAdditiveHelper(
    module,
    operator,
    functionId,
    signature,
    signedIntegerType,
    booleanType,
  );
}

function checkedAdditiveHelper(
  module: BlotRuntimeModule,
  operator: "add" | "subtract",
  functionId: CoreFunctionId,
  signature: CoreSignatureId,
  signedIntegerType: CoreTypeId,
  booleanType: CoreTypeId,
): CoreFunction {
  const span = { file: module.source, start: 0, end: 0 };
  let leftXorOperands = [0, 1];
  let rightXorOperands = [0, 2];
  let coreOperator: CoreBinaryOperator = "-";
  if (operator === "add") {
    leftXorOperands = [0, 2];
    rightXorOperands = [1, 2];
    coreOperator = "+";
  }
  return {
    id: functionId,
    name: `blot$checked$i64$${operator}`,
    sourceIdentity: undefined,
    signature,
    entryBlock: 0 as CoreBlockId,
    blocks: [
      {
        id: 0 as CoreBlockId,
        parameters: [
          { value: 0 as CoreValueId, type: signedIntegerType, span },
          { value: 1 as CoreValueId, type: signedIntegerType, span },
        ],
        operations: [
          scalarOperation(
            2,
            signedIntegerType,
            coreOperator,
            [0, 1],
            span,
          ),
          primitiveOperation(
            3,
            signedIntegerType,
            PrimitiveId.bitXor,
            leftXorOperands,
            span,
          ),
          primitiveOperation(
            4,
            signedIntegerType,
            PrimitiveId.bitXor,
            rightXorOperands,
            span,
          ),
          primitiveOperation(
            5,
            signedIntegerType,
            PrimitiveId.bitAnd,
            [3, 4],
            span,
          ),
          constantOperation(6, signedIntegerType, 0n, span),
          scalarOperation(7, booleanType, "<", [5, 6], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 7 as CoreValueId,
          trueTarget: 1 as CoreBlockId,
          trueArguments: [],
          falseTarget: 2 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
      {
        id: 1 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: { kind: "trap", span },
      },
      {
        id: 2 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: {
          kind: "return",
          values: [2 as CoreValueId],
          span,
        },
      },
    ],
    span,
  };
}

function checkedMultiplyHelper(
  module: BlotRuntimeModule,
  functionId: CoreFunctionId,
  signature: CoreSignatureId,
  signedIntegerType: CoreTypeId,
  booleanType: CoreTypeId,
): CoreFunction {
  const span = { file: module.source, start: 0, end: 0 };
  return {
    id: functionId,
    name: "blot$checked$i64$multiply",
    sourceIdentity: undefined,
    signature,
    entryBlock: 0 as CoreBlockId,
    blocks: [
      {
        id: 0 as CoreBlockId,
        parameters: [
          { value: 0 as CoreValueId, type: signedIntegerType, span },
          { value: 1 as CoreValueId, type: signedIntegerType, span },
        ],
        operations: [
          scalarOperation(2, signedIntegerType, "*", [0, 1], span),
          constantOperation(3, signedIntegerType, 0n, span),
          scalarOperation(4, booleanType, "==", [1, 3], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 4 as CoreValueId,
          trueTarget: 1 as CoreBlockId,
          trueArguments: [],
          falseTarget: 2 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
      {
        id: 1 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: {
          kind: "return",
          values: [2 as CoreValueId],
          span,
        },
      },
      {
        id: 2 as CoreBlockId,
        parameters: [],
        operations: [
          constantOperation(
            5,
            signedIntegerType,
            -(1n << 63n),
            span,
          ),
          constantOperation(6, signedIntegerType, -1n, span),
          scalarOperation(7, booleanType, "==", [0, 5], span),
          scalarOperation(8, booleanType, "==", [1, 6], span),
          scalarOperation(9, booleanType, "&&", [7, 8], span),
          scalarOperation(10, booleanType, "==", [0, 6], span),
          scalarOperation(11, booleanType, "==", [1, 5], span),
          scalarOperation(12, booleanType, "&&", [10, 11], span),
          scalarOperation(13, booleanType, "||", [9, 12], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 13 as CoreValueId,
          trueTarget: 3 as CoreBlockId,
          trueArguments: [],
          falseTarget: 4 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
      {
        id: 3 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: { kind: "trap", span },
      },
      {
        id: 4 as CoreBlockId,
        parameters: [],
        operations: [
          scalarOperation(14, signedIntegerType, "/", [2, 1], span),
          scalarOperation(15, booleanType, "==", [14, 0], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 15 as CoreValueId,
          trueTarget: 1 as CoreBlockId,
          trueArguments: [],
          falseTarget: 3 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
    ],
    span,
  };
}

function scalarOperation(
  result: number,
  type: CoreTypeId,
  operator: CoreBinaryOperator,
  operands: readonly number[],
  span: { readonly file: string; readonly start: number; readonly end: number },
): CoreOperation {
  return {
    kind: "scalar.binary",
    result: result as CoreValueId,
    type,
    operands: operands.map((operand) => operand as CoreValueId),
    operator,
    span,
  };
}

function primitiveOperation(
  result: number,
  type: CoreTypeId,
  primitiveId: typeof PrimitiveId[keyof typeof PrimitiveId],
  operands: readonly number[],
  span: { readonly file: string; readonly start: number; readonly end: number },
): CoreOperation {
  return {
    kind: "primitive",
    result: result as CoreValueId,
    type,
    operands: operands.map((operand) => operand as CoreValueId),
    primitiveId,
    span,
  };
}

function constantOperation(
  result: number,
  type: CoreTypeId,
  value: bigint,
  span: { readonly file: string; readonly start: number; readonly end: number },
): CoreOperation {
  return {
    kind: "constant",
    result: result as CoreValueId,
    type,
    operands: [],
    value,
    span,
  };
}

function binaryOperator(
  operator: Extract<
    BlotRuntimeOperation,
    { readonly kind: "scalar" }
  >["operator"],
): CoreBinaryOperator {
  return {
    add: "+",
    subtract: "-",
    multiply: "*",
    divide: "/",
    remainder: "%",
    equal: "==",
    "not-equal": "!=",
    "less-than": "<",
    "less-than-or-equal": "<=",
    "greater-than": ">",
    "greater-than-or-equal": ">=",
  }[operator] as CoreBinaryOperator;
}

function conversionPrimitive(
  module: BlotRuntimeModule,
  operation: Extract<BlotRuntimeOperation, { readonly kind: "convert" }>,
): typeof PrimitiveId[keyof typeof PrimitiveId] {
  const primitive = {
    "signed-integer-64-to-signed-integer-32": PrimitiveId.i32WrapI64,
    "signed-integer-32-to-signed-integer-64": PrimitiveId.i64ExtendI32Signed,
    "signed-integer-32-to-float-32": PrimitiveId.f32FromI32,
    "signed-integer-32-to-float-64": PrimitiveId.f64FromI32,
    "float-32-to-signed-integer-32": PrimitiveId.i32FromF32,
    "float-64-to-signed-integer-32": PrimitiveId.i32FromF64,
    "reinterpret-float-32-as-signed-integer-32": PrimitiveId.i32ReinterpretF32,
    "reinterpret-signed-integer-32-as-float-32": PrimitiveId.f32ReinterpretI32,
  }[operation.conversion];
  if (primitive !== undefined) return primitive;
  throw new TypeError(
    `${module.source}:${operation.span.start}: Blot runtime target does not yet implement conversion ${operation.conversion}`,
  );
}

function vectorPrimitive(
  module: BlotRuntimeModule,
  operation: Extract<BlotRuntimeOperation, { readonly kind: "vector" }>,
  valueTypes: ReadonlyMap<number, number>,
): typeof PrimitiveId[keyof typeof PrimitiveId] {
  let simdType = module.types[operation.type];
  if (simdType.kind !== "vector" && simdType.kind !== "mask") {
    const operandType = valueTypes.get(operation.operands[0]);
    if (operandType === undefined) {
      throw new TypeError(
        `${module.source}:${operation.span.start}: vector operation ${operation.operator} has no typed SIMD operand`,
      );
    }
    simdType = module.types[operandType];
  }
  if (simdType.kind !== "vector" && simdType.kind !== "mask") {
    throw new TypeError(
      `${module.source}:${operation.span.start}: vector operation ${operation.operator} has no SIMD type`,
    );
  }
  const element = simdType.element;
  if (operation.operator === "extract" || operation.operator === "replace") {
    if (operation.lane === undefined) {
      throw new TypeError(
        `${module.source}:${operation.span.start}: vector ${operation.operator} requires a lane`,
      );
    }
    if (element === "float-32" && operation.operator === "extract") {
      return [
        PrimitiveId.f32x4ExtractLane0,
        PrimitiveId.f32x4ExtractLane1,
        PrimitiveId.f32x4ExtractLane2,
        PrimitiveId.f32x4ExtractLane3,
      ][operation.lane];
    }
    if (element === "float-32") {
      return [
        PrimitiveId.f32x4ReplaceLane0,
        PrimitiveId.f32x4ReplaceLane1,
        PrimitiveId.f32x4ReplaceLane2,
        PrimitiveId.f32x4ReplaceLane3,
      ][operation.lane];
    }
    if (element === "integer-32" && operation.operator === "extract") {
      return [
        PrimitiveId.i32x4ExtractLane0,
        PrimitiveId.i32x4ExtractLane1,
        PrimitiveId.i32x4ExtractLane2,
        PrimitiveId.i32x4ExtractLane3,
      ][operation.lane];
    }
    if (element === "integer-32") {
      return [
        PrimitiveId.i32x4ReplaceLane0,
        PrimitiveId.i32x4ReplaceLane1,
        PrimitiveId.i32x4ReplaceLane2,
        PrimitiveId.i32x4ReplaceLane3,
      ][operation.lane];
    }
    throw new TypeError(
      `${module.source}:${operation.span.start}: ${element} has no lane ${operation.operator} primitive`,
    );
  }
  const floatPrimitives: Partial<
    Record<
      typeof operation.operator,
      typeof PrimitiveId[keyof typeof PrimitiveId]
    >
  > = {
    make: PrimitiveId.f32x4Make,
    splat: PrimitiveId.f32x4Splat,
    add: PrimitiveId.f32x4Add,
    subtract: PrimitiveId.f32x4Subtract,
    multiply: PrimitiveId.f32x4Multiply,
    divide: PrimitiveId.f32x4Divide,
    equal: PrimitiveId.f32x4Equal,
    "not-equal": PrimitiveId.f32x4NotEqual,
    "less-than": PrimitiveId.f32x4LessThan,
    "less-than-or-equal": PrimitiveId.f32x4LessThanOrEqual,
    "greater-than": PrimitiveId.f32x4GreaterThan,
    "greater-than-or-equal": PrimitiveId.f32x4GreaterThanOrEqual,
    select: PrimitiveId.f32x4Select,
    absolute: PrimitiveId.f32x4Absolute,
    negate: PrimitiveId.f32x4Negate,
    "square-root": PrimitiveId.f32x4SquareRoot,
    ceiling: PrimitiveId.f32x4Ceiling,
    floor: PrimitiveId.f32x4Floor,
    truncate: PrimitiveId.f32x4Truncate,
    nearest: PrimitiveId.f32x4Nearest,
    minimum: PrimitiveId.f32x4Minimum,
    maximum: PrimitiveId.f32x4Maximum,
    "pseudo-minimum": PrimitiveId.f32x4PseudoMinimum,
    "pseudo-maximum": PrimitiveId.f32x4PseudoMaximum,
    "mask-bitmask": PrimitiveId.f32x4MaskBitmask,
    "mask-all": PrimitiveId.f32x4MaskAllTrue,
    "mask-any": PrimitiveId.f32x4MaskAnyTrue,
    "convert-i32-signed": PrimitiveId.f32x4ConvertI32x4Signed,
    "convert-i32-unsigned": PrimitiveId.f32x4ConvertI32x4Unsigned,
  };
  const floatPrimitive = floatPrimitives[operation.operator];
  if (element === "float-32" && floatPrimitive !== undefined) {
    return floatPrimitive;
  }
  const integer32Primitives: Partial<
    Record<
      typeof operation.operator,
      typeof PrimitiveId[keyof typeof PrimitiveId]
    >
  > = {
    make: PrimitiveId.i32x4Make,
    splat: PrimitiveId.i32x4Splat,
    add: PrimitiveId.i32x4Add,
    subtract: PrimitiveId.i32x4Subtract,
    multiply: PrimitiveId.i32x4Multiply,
    "bit-and": PrimitiveId.i32x4And,
    "bit-or": PrimitiveId.i32x4Or,
    "bit-xor": PrimitiveId.i32x4Xor,
    "bit-not": PrimitiveId.i32x4Not,
    "shift-left": PrimitiveId.i32x4ShiftLeft,
    "shift-right-signed": PrimitiveId.i32x4ShiftRightSigned,
    "shift-right-unsigned": PrimitiveId.i32x4ShiftRightUnsigned,
    equal: PrimitiveId.i32x4Equal,
    "not-equal": PrimitiveId.i32x4NotEqual,
    "less-than-signed": PrimitiveId.i32x4LessThanSigned,
    "less-than-unsigned": PrimitiveId.i32x4LessThanUnsigned,
    "greater-than-signed": PrimitiveId.i32x4GreaterThanSigned,
    "greater-than-unsigned": PrimitiveId.i32x4GreaterThanUnsigned,
    "less-than-or-equal-signed": PrimitiveId.i32x4LessThanOrEqualSigned,
    "less-than-or-equal-unsigned": PrimitiveId.i32x4LessThanOrEqualUnsigned,
    "greater-than-or-equal-signed": PrimitiveId.i32x4GreaterThanOrEqualSigned,
    "greater-than-or-equal-unsigned":
      PrimitiveId.i32x4GreaterThanOrEqualUnsigned,
    "minimum-signed": PrimitiveId.i32x4MinimumSigned,
    "minimum-unsigned": PrimitiveId.i32x4MinimumUnsigned,
    "maximum-signed": PrimitiveId.i32x4MaximumSigned,
    "maximum-unsigned": PrimitiveId.i32x4MaximumUnsigned,
    select: PrimitiveId.i32x4Select,
    "mask-bitmask": PrimitiveId.i32x4MaskBitmask,
    "mask-all": PrimitiveId.i32x4MaskAllTrue,
    "mask-any": PrimitiveId.i32x4MaskAnyTrue,
    "truncate-saturating-f32-signed":
      PrimitiveId.i32x4TruncateSaturateF32x4Signed,
    "truncate-saturating-f32-unsigned":
      PrimitiveId.i32x4TruncateSaturateF32x4Unsigned,
  };
  const integer32Primitive = integer32Primitives[operation.operator];
  if (element === "integer-32" && integer32Primitive !== undefined) {
    return integer32Primitive;
  }
  const narrowPrimitives: Record<
    "integer-16" | "integer-8",
    Partial<
      Record<
        typeof operation.operator,
        typeof PrimitiveId[keyof typeof PrimitiveId]
      >
    >
  > = {
    "integer-16": {
      splat: PrimitiveId.i16x8Splat,
      add: PrimitiveId.i16x8Add,
      subtract: PrimitiveId.i16x8Subtract,
      multiply: PrimitiveId.i16x8Multiply,
      "bit-and": PrimitiveId.i16x8And,
      "bit-or": PrimitiveId.i16x8Or,
      "bit-xor": PrimitiveId.i16x8Xor,
      "bit-not": PrimitiveId.i16x8Not,
      "shift-left": PrimitiveId.i16x8ShiftLeft,
      "shift-right-signed": PrimitiveId.i16x8ShiftRightSigned,
      "shift-right-unsigned": PrimitiveId.i16x8ShiftRightUnsigned,
      equal: PrimitiveId.i16x8Equal,
      "not-equal": PrimitiveId.i16x8NotEqual,
      "less-than-signed": PrimitiveId.i16x8LessThanSigned,
      "less-than-unsigned": PrimitiveId.i16x8LessThanUnsigned,
      "greater-than-signed": PrimitiveId.i16x8GreaterThanSigned,
      "greater-than-unsigned": PrimitiveId.i16x8GreaterThanUnsigned,
      "less-than-or-equal-signed": PrimitiveId.i16x8LessThanOrEqualSigned,
      "less-than-or-equal-unsigned": PrimitiveId.i16x8LessThanOrEqualUnsigned,
      "greater-than-or-equal-signed": PrimitiveId.i16x8GreaterThanOrEqualSigned,
      "greater-than-or-equal-unsigned":
        PrimitiveId.i16x8GreaterThanOrEqualUnsigned,
      "minimum-signed": PrimitiveId.i16x8MinimumSigned,
      "minimum-unsigned": PrimitiveId.i16x8MinimumUnsigned,
      "maximum-signed": PrimitiveId.i16x8MaximumSigned,
      "maximum-unsigned": PrimitiveId.i16x8MaximumUnsigned,
      select: PrimitiveId.i16x8Select,
      "mask-bitmask": PrimitiveId.i16x8MaskBitmask,
      "mask-all": PrimitiveId.i16x8MaskAllTrue,
      "mask-any": PrimitiveId.i16x8MaskAnyTrue,
    },
    "integer-8": {
      splat: PrimitiveId.i8x16Splat,
      add: PrimitiveId.i8x16Add,
      subtract: PrimitiveId.i8x16Subtract,
      "bit-and": PrimitiveId.i8x16And,
      "bit-or": PrimitiveId.i8x16Or,
      "bit-xor": PrimitiveId.i8x16Xor,
      "bit-not": PrimitiveId.i8x16Not,
      "shift-left": PrimitiveId.i8x16ShiftLeft,
      "shift-right-signed": PrimitiveId.i8x16ShiftRightSigned,
      "shift-right-unsigned": PrimitiveId.i8x16ShiftRightUnsigned,
      equal: PrimitiveId.i8x16Equal,
      "not-equal": PrimitiveId.i8x16NotEqual,
      "less-than-signed": PrimitiveId.i8x16LessThanSigned,
      "less-than-unsigned": PrimitiveId.i8x16LessThanUnsigned,
      "greater-than-signed": PrimitiveId.i8x16GreaterThanSigned,
      "greater-than-unsigned": PrimitiveId.i8x16GreaterThanUnsigned,
      "less-than-or-equal-signed": PrimitiveId.i8x16LessThanOrEqualSigned,
      "less-than-or-equal-unsigned": PrimitiveId.i8x16LessThanOrEqualUnsigned,
      "greater-than-or-equal-signed": PrimitiveId.i8x16GreaterThanOrEqualSigned,
      "greater-than-or-equal-unsigned":
        PrimitiveId.i8x16GreaterThanOrEqualUnsigned,
      "minimum-signed": PrimitiveId.i8x16MinimumSigned,
      "minimum-unsigned": PrimitiveId.i8x16MinimumUnsigned,
      "maximum-signed": PrimitiveId.i8x16MaximumSigned,
      "maximum-unsigned": PrimitiveId.i8x16MaximumUnsigned,
      select: PrimitiveId.i8x16Select,
      "mask-bitmask": PrimitiveId.i8x16MaskBitmask,
      "mask-all": PrimitiveId.i8x16MaskAllTrue,
      "mask-any": PrimitiveId.i8x16MaskAnyTrue,
    },
  };
  if (element === "integer-16" || element === "integer-8") {
    const primitive = narrowPrimitives[element][operation.operator];
    if (primitive !== undefined) return primitive;
  }
  throw new TypeError(
    `${module.source}:${operation.span.start}: unsupported vector operation ${operation.operator}`,
  );
}
