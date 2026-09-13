import { runtimeHirSchema } from "../compiler/protocol.ts";

export type BlotRuntimeSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

export type BlotRuntimeOwnership = "plain" | "owned" | "borrowed";

export type BlotRuntimeType =
  | {
    readonly kind: "callback";
    readonly function: number;
    readonly signature: number;
    readonly environmentType: number;
  }
  | {
    readonly kind: "resource";
    readonly name: string;
    readonly payloadType: number;
  }
  | {
    readonly kind:
      | "unit"
      | "integer-32"
      | "signed-integer-64"
      | "float-32"
      | "float-64"
      | "boolean"
      | "text";
  }
  | {
    readonly kind: "vector" | "mask";
    readonly element: "float-32" | "integer-32" | "integer-16" | "integer-8";
    readonly lanes: 4 | 8 | 16;
  }
  | {
    readonly kind: "store";
    readonly elementType: number;
  }
  | {
    readonly kind: "scratch";
    readonly elementType: number;
  }
  | {
    readonly kind: "indirect";
    readonly targetType: number;
  }
  | {
    readonly kind: "product";
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly type: number;
    }[];
  }
  | {
    readonly kind: "sum";
    readonly name: string;
    readonly cases: readonly {
      readonly name: string;
      readonly payloadType: number;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly representationType: number;
  }
  | {
    readonly kind: "function";
    readonly signature: number;
  };

export type BlotRuntimeSignature = {
  readonly parameters: readonly number[];
  readonly result: number;
  readonly effects: readonly string[];
};

export type BlotRuntimeConstant = bigint | number | boolean | string | null;

export type BlotRuntimeOperation =
  | {
    readonly kind: "constant";
    readonly value: bigint | number | boolean | string | null;
  }
  | {
    readonly kind: "scalar";
    readonly operator:
      | "add"
      | "subtract"
      | "multiply"
      | "divide"
      | "remainder"
      | "equal"
      | "not-equal"
      | "less-than"
      | "less-than-or-equal"
      | "greater-than"
      | "greater-than-or-equal";
  }
  | {
    readonly kind: "scalar.unary";
    readonly operator: "negate" | "square-root";
  }
  | {
    readonly kind: "convert";
    readonly conversion: string;
  }
  | {
    readonly kind:
      | "text.append"
      | "text.join"
      | "text.length"
      | "text.byte-length"
      | "text.scalar-at"
      | "text.next-byte"
      | "text.slice"
      | "text.slice-bytes"
      | "text.find-from"
      | "text.find-byte-from"
      | "text.from-i64"
      | "text.compare"
      | "text.contains";
  }
  | {
    readonly kind: "vector";
    readonly operator:
      | "make"
      | "splat"
      | "add"
      | "subtract"
      | "multiply"
      | "divide"
      | "extract"
      | "replace"
      | "equal"
      | "not-equal"
      | "less-than"
      | "less-than-or-equal"
      | "greater-than"
      | "greater-than-or-equal"
      | "select"
      | "shuffle"
      | "absolute"
      | "negate"
      | "square-root"
      | "ceiling"
      | "floor"
      | "truncate"
      | "nearest"
      | "minimum"
      | "maximum"
      | "pseudo-minimum"
      | "pseudo-maximum"
      | "bit-and"
      | "bit-or"
      | "bit-xor"
      | "bit-not"
      | "shift-left"
      | "shift-right-signed"
      | "shift-right-unsigned"
      | "minimum-signed"
      | "minimum-unsigned"
      | "maximum-signed"
      | "maximum-unsigned"
      | "less-than-signed"
      | "less-than-unsigned"
      | "greater-than-signed"
      | "greater-than-unsigned"
      | "less-than-or-equal-signed"
      | "less-than-or-equal-unsigned"
      | "greater-than-or-equal-signed"
      | "greater-than-or-equal-unsigned"
      | "mask-bitmask"
      | "mask-all"
      | "mask-any"
      | "convert-i32-signed"
      | "convert-i32-unsigned"
      | "truncate-saturating-f32-signed"
      | "truncate-saturating-f32-unsigned";
    readonly lane?: 0 | 1 | 2 | 3;
  }
  | {
    readonly kind: "product.make";
  }
  | {
    readonly kind: "product.project";
    readonly field: number;
  }
  | {
    readonly kind: "sum.make";
    readonly case: number;
  }
  | {
    readonly kind: "sum.tag";
  }
  | {
    readonly kind: "sum.payload";
    readonly case: number;
  }
  | {
    readonly kind: "indirect.make" | "indirect.load";
  }
  | {
    readonly kind: "store.empty";
  }
  | {
    readonly kind: "store.literal";
    readonly staticStore?: number;
  }
  | {
    readonly kind: "store.new";
  }
  | {
    readonly kind: "store.length";
  }
  | {
    readonly kind: "store.read";
  }
  | {
    readonly kind: "store.read.field";
    readonly field: number;
  }
  | {
    readonly kind: "store.write" | "store.grow";
    readonly update: "persistent" | "owned-reuse";
  }
  | {
    readonly kind:
      | "scratch.with-capacity"
      | "scratch.push"
      | "scratch.finish"
      | "scratch.recycle";
  }
  | {
    readonly kind: "closure.make";
    readonly function: number;
  }
  | {
    readonly kind:
      | "seal.wrap"
      | "callback.make"
      | "seal.unwrap"
      | "resource.move"
      | "resource.borrow"
      | "resource.freeze"
      | "resource.drop";
  };

export type BlotRuntimeDefinition = {
  readonly value: number;
  readonly type: number;
  readonly ownership: BlotRuntimeOwnership;
  readonly span: BlotRuntimeSpan;
};

export type BlotRuntimeInstruction = {
  readonly definition: BlotRuntimeDefinition;
  readonly operands: readonly number[];
  readonly operation: BlotRuntimeOperation;
};

export type BlotRuntimeArgument =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "result" };

export type BlotRuntimeEdge = {
  readonly target: number;
  readonly arguments: readonly BlotRuntimeArgument[];
};

export type BlotRuntimeCallTarget =
  | { readonly kind: "function"; readonly function: number }
  | {
    readonly kind: "host";
    readonly capability: string;
    readonly operation: string;
  }
  | { readonly kind: "link"; readonly unit: string; readonly name: string };

export type BlotRuntimeTransition =
  | { readonly kind: "jump"; readonly edge: BlotRuntimeEdge }
  | {
    readonly kind: "branch";
    readonly condition: number;
    readonly consequent: BlotRuntimeEdge;
    readonly alternate: BlotRuntimeEdge;
  }
  | {
    readonly kind: "switch";
    readonly selector: number;
    readonly cases:
      readonly (readonly [BlotRuntimeConstant, BlotRuntimeEdge])[];
    readonly fallback: BlotRuntimeEdge;
  }
  | {
    readonly kind: "call";
    readonly target: BlotRuntimeCallTarget;
    readonly signature: number;
    readonly arguments: readonly number[];
    readonly next: BlotRuntimeEdge;
    readonly suspends: boolean;
  }
  | { readonly kind: "return"; readonly value: number }
  | { readonly kind: "trap"; readonly message: string };

export type BlotRuntimeContinuation = {
  readonly id: number;
  readonly parameters: readonly BlotRuntimeDefinition[];
  readonly captures: readonly BlotRuntimeDefinition[];
  readonly instructions: readonly BlotRuntimeInstruction[];
  readonly transition: BlotRuntimeTransition;
  readonly span: BlotRuntimeSpan;
};

export type BlotRuntimeFunction = {
  readonly id: number;
  readonly name: string;
  readonly signature: number;
  readonly entry: number;
  readonly continuations: readonly BlotRuntimeContinuation[];
  readonly suspends: boolean;
  readonly framed: boolean;
  readonly reuse: "checked" | null;
  readonly span: BlotRuntimeSpan;
};

export type BlotEffectOwnership =
  | "unrestricted"
  | "affine"
  | "linear"
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly ownership: BlotEffectOwnership;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly ownership: BlotEffectOwnership;
    }[];
  };

export type BlotRuntimeCapability = {
  readonly name: string;
  readonly operations: readonly {
    readonly name: string;
    readonly sourceName: string;
    readonly signature: number;
    readonly contract: {
      readonly input: BlotEffectOwnership;
      readonly result: BlotEffectOwnership;
      readonly suspends: boolean;
    };
  }[];
};

export type BlotRuntimeLink = {
  readonly unit: string;
  readonly name: string;
  readonly signature: number;
  readonly suspends: boolean;
};

export type BlotRuntimeExport =
  | {
    readonly sourceName: string;
    readonly phase: "runtime";
    readonly wasmName: string;
    readonly function: number;
    readonly signature: number;
    readonly ownership: "owned";
  }
  | {
    readonly sourceName: string;
    readonly phase: "comptime";
  };

export type BlotRuntimeModule = {
  readonly format: "blot-runtime-hir";
  readonly schemaVersion: typeof runtimeHirSchema;
  readonly source: string;
  readonly types: readonly BlotRuntimeType[];
  readonly signatures: readonly BlotRuntimeSignature[];
  readonly staticStores: readonly {
    readonly elementType: number;
    readonly values: readonly (bigint | number | boolean | null)[];
  }[];
  readonly functions: readonly BlotRuntimeFunction[];
  readonly capabilities: readonly BlotRuntimeCapability[];
  readonly links: readonly BlotRuntimeLink[];
  readonly exports: readonly BlotRuntimeExport[];
};

/**
 * Closed physical representation selected before emission.
 *
 * It is intentionally not a source subtype.  The fingerprint includes the
 * complete nested representation, while size/alignment/stride are the facts an
 * allocator or adapter may consume.  Direct recursive layouts are rejected;
 * recursion must cross `indirect` or `store`.
 */
export interface BlotRuntimeLayoutWitness {
  readonly fingerprint: string;
  readonly size: number;
  readonly alignment: number;
  readonly stride: number;
}

export function runtimeLayoutWitness(
  module: Pick<BlotRuntimeModule, "source" | "types">,
  typeId: number,
): BlotRuntimeLayoutWitness {
  const memo = new Map<number, BlotRuntimeLayoutWitness>();
  const active = new Set<number>();
  const visit = (id: number): BlotRuntimeLayoutWitness => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const type = module.types[id];
    if (type === undefined) {
      throw new TypeError(`${module.source}: layout names absent type ${id}`);
    }
    if (active.has(id)) {
      throw new TypeError(
        `${module.source}: type ${id} has a direct recursive layout; use an indirect or Store representation`,
      );
    }
    active.add(id);
    let witness: BlotRuntimeLayoutWitness;
    const scalar = (size: number, alignment: number, name: string) => ({
      fingerprint: name,
      size,
      alignment,
      stride: alignTo(size, alignment),
    });
    switch (type.kind) {
      case "unit":
        witness = scalar(0, 1, "unit");
        break;
      case "integer-32":
      case "float-32":
      case "boolean":
        witness = scalar(4, 4, type.kind);
        break;
      case "signed-integer-64":
      case "float-64":
        witness = scalar(8, 8, type.kind);
        break;
      case "text":
        witness = scalar(8, 4, "text(memory32)");
        break;
      case "vector":
      case "mask":
        witness = scalar(16, 16, `${type.kind}(${type.element}x${type.lanes})`);
        break;
      case "indirect":
        // The target is deliberately not visited: indirection is the recursion
        // boundary and all memory32 references share one carrier layout.
        witness = scalar(4, 4, `indirect(${type.targetType})`);
        break;
      case "function":
        witness = scalar(4, 4, `function(${type.signature})`);
        break;
      case "resource":
        if (typeof type.name !== "string" || type.name.length === 0) {
          throw new TypeError("resource type has no family name");
        }
        witness = scalar(
          8,
          8,
          `resource(${type.name.length}:${type.name})${
            visit(type.payloadType).fingerprint
          }`,
        );
        break;
      case "callback": {
        const environment = visit(type.environmentType);
        witness = {
          ...environment,
          fingerprint:
            `callback(${type.function}:${type.signature};${environment.fingerprint})`,
        };
        break;
      }
      case "store": {
        // A Store is the recursion boundary.  Publish its fixed memory32
        // carrier before visiting the element so `Store (Node (Store ...))`
        // closes instead of looking like a direct inline cycle.
        memo.set(id, {
          fingerprint: `store@${id}`,
          size: 8,
          alignment: 4,
          stride: 8,
        });
        const element = visit(type.elementType);
        witness = {
          fingerprint: `store(${element.fingerprint};stride=${element.stride})`,
          size: 8,
          alignment: 4,
          stride: 8,
        };
        break;
      }
      case "scratch": {
        memo.set(id, {
          fingerprint: `scratch@${id}`,
          size: 12,
          alignment: 4,
          stride: 12,
        });
        const element = visit(type.elementType);
        witness = {
          fingerprint:
            `scratch(${element.fingerprint};stride=${element.stride})`,
          size: 12,
          alignment: 4,
          stride: 12,
        };
        break;
      }
      case "sealed": {
        const representation = visit(type.representationType);
        witness = {
          ...representation,
          fingerprint: `sealed(${
            JSON.stringify(type.name)
          },${representation.fingerprint})`,
        };
        break;
      }
      case "product": {
        let offset = 0;
        let alignment = 1;
        const fields: string[] = [];
        for (const field of type.fields) {
          const layout = visit(field.type);
          offset = alignTo(offset, layout.alignment);
          fields.push(
            `${JSON.stringify(field.name)}@${offset}:${layout.fingerprint}`,
          );
          offset += layout.size;
          alignment = Math.max(alignment, layout.alignment);
        }
        const size = alignTo(offset, alignment);
        witness = {
          fingerprint: `product(${JSON.stringify(type.name)}){${
            fields.join(",")
          }}`,
          size,
          alignment,
          stride: alignTo(size, alignment),
        };
        break;
      }
      case "sum": {
        const payloads = type.cases.map((case_) => ({
          name: case_.name,
          layout: visit(case_.payloadType),
        }));
        const payloadAlignment = Math.max(
          1,
          ...payloads.map(({ layout }) => layout.alignment),
        );
        const payloadSize = Math.max(
          0,
          ...payloads.map(({ layout }) => layout.size),
        );
        const alignment = Math.max(4, payloadAlignment);
        const payloadOffset = alignTo(4, payloadAlignment);
        const size = alignTo(payloadOffset + payloadSize, alignment);
        witness = {
          fingerprint: `sum(${JSON.stringify(type.name)}){${
            payloads.map(({ name, layout }) =>
              `${JSON.stringify(name)}:${layout.fingerprint}`
            ).join(",")
          }}`,
          size,
          alignment,
          stride: alignTo(size, alignment),
        };
        break;
      }
    }
    active.delete(id);
    memo.set(id, witness);
    return witness;
  };
  return visit(typeId);
}

function alignTo(offset: number, alignment: number): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(alignment)) {
    throw new TypeError("runtime layout exceeds safe integer arithmetic");
  }
  if (offset < 0 || alignment <= 0 || (alignment & (alignment - 1)) !== 0) {
    throw new TypeError(`invalid runtime layout alignment ${alignment}`);
  }
  return Math.ceil(offset / alignment) * alignment;
}

declare const validatedBlotRuntimeModule: unique symbol;

export type ValidatedBlotRuntimeModule = BlotRuntimeModule & {
  readonly [validatedBlotRuntimeModule]: true;
};

type BlotRuntimeValueDefinition = {
  readonly type: number;
  readonly ownership: BlotRuntimeOwnership;
  readonly instruction?: BlotRuntimeInstruction;
};

export function validateBlotRuntimeModule(
  module: BlotRuntimeModule,
): ValidatedBlotRuntimeModule {
  if (
    module.format !== "blot-runtime-hir" ||
    module.schemaVersion !== runtimeHirSchema
  ) {
    throw new TypeError(
      `Blot Runtime HIR requires format blot-runtime-hir schema ${runtimeHirSchema}; received ${module.format} schema ${module.schemaVersion}`,
    );
  }
  if (module.types.length === 0) {
    throw new TypeError(`${module.source}: Blot Runtime HIR has no types`);
  }
  module.types.forEach((type, typeId) => validateType(module, type, typeId));
  module.types.forEach((_, typeId) => runtimeLayoutWitness(module, typeId));
  module.staticStores.forEach((store, storeId) => {
    const elementType = requireType(
      module,
      store.elementType,
      `static Store ${storeId} element`,
    );
    store.values.forEach((value, index) => {
      if (!isStaticStoreValue(elementType, value)) {
        throw new TypeError(
          `${module.source}: static Store ${storeId} value ${index} does not match element type ${store.elementType}`,
        );
      }
    });
  });
  module.signatures.forEach((signature, signatureId) => {
    signature.parameters.forEach((type, parameter) =>
      requireType(
        module,
        type,
        `signature ${signatureId} parameter ${parameter}`,
      )
    );
    requireType(module, signature.result, `signature ${signatureId} result`);
    requireUniqueNames(
      signature.effects,
      `${module.source}: signature ${signatureId} effects`,
    );
  });
  const capabilityOperations = new Map<string, number>();
  requireUniqueNames(
    module.capabilities.map((capability) => capability.name),
    `${module.source}: capabilities`,
  );
  for (const capability of module.capabilities) {
    requireUniqueNames(
      capability.operations.map((operation) => operation.name),
      `${module.source}: capability ${capability.name} operations`,
    );
    for (const operation of capability.operations) {
      if (
        typeof operation.sourceName !== "string" ||
        operation.sourceName.length === 0
      ) {
        throw new TypeError(
          `${module.source}: capability operation has no checked source name`,
        );
      }
      if (typeof operation.contract.suspends !== "boolean") {
        throw new TypeError(
          `${module.source}: capability ${capability.name}.${operation.name} has no checked suspension contract`,
        );
      }
      const signature = requireSignature(
        module,
        operation.signature,
        `capability ${capability.name}.${operation.name}`,
      );
      if (signature.parameters.length !== 1) {
        throw new TypeError(
          `${module.source}: capability ${capability.name}.${operation.name} requires exactly one input type; signature ${operation.signature} has ${signature.parameters.length}`,
        );
      }
      capabilityOperations.set(
        `${capability.name}\u0000${operation.name}`,
        operation.signature,
      );
      validateEffectOwnership(
        operation.contract.input,
        `${module.source}: capability ${capability.name}.${operation.name} input ownership`,
      );
      validateEffectOwnership(
        operation.contract.result,
        `${module.source}: capability ${capability.name}.${operation.name} result ownership`,
      );
      validateEffectOwnershipType(
        module,
        operation.contract.input,
        signature.parameters[0],
        `${module.source}: capability ${capability.name}.${operation.name} input ownership`,
      );
      validateEffectOwnershipType(
        module,
        operation.contract.result,
        signature.result,
        `${module.source}: capability ${capability.name}.${operation.name} result ownership`,
      );
    }
  }
  const linkOperations = new Map<string, number>();
  for (const link of module.links) {
    if (typeof link.suspends !== "boolean") {
      throw new TypeError("development link omitted its suspension contract");
    }
    if (link.unit.length === 0 || link.name.length === 0) {
      throw new TypeError(
        `${module.source}: development links require non-empty unit and operation names`,
      );
    }
    const key = `${link.unit}\u0000${link.name}`;
    if (linkOperations.has(key)) {
      throw new TypeError(
        `${module.source}: development link ${link.unit}.${link.name} is repeated`,
      );
    }
    requireSignature(
      module,
      link.signature,
      `development link ${link.unit}.${link.name}`,
    );
    linkOperations.set(key, link.signature);
  }
  module.functions.forEach((function_, functionId) => {
    if (function_.id !== functionId) {
      throw new TypeError(
        `${module.source}: function table index ${functionId} contains ID ${function_.id}`,
      );
    }
    validateFunction(
      module,
      function_,
      capabilityOperations,
      linkOperations,
    );
  });
  requireUniqueNames(
    module.exports.map((exported) => exported.sourceName),
    `${module.source}: source exports`,
  );
  requireUniqueNames(
    module.exports.flatMap((exported) => {
      if (exported.phase === "runtime") return [exported.wasmName];
      return [];
    }),
    `${module.source}: Wasm exports`,
  );
  for (const exported of module.exports) {
    if (exported.phase === "comptime") continue;
    const function_ = requireFunction(
      module,
      exported.function,
      `export ${exported.sourceName}`,
    );
    requireSignature(
      module,
      exported.signature,
      `export ${exported.sourceName}`,
    );
    if (function_.signature !== exported.signature) {
      throw new TypeError(
        `${module.source}: export ${exported.sourceName} declares signature ${exported.signature} but function ${function_.name} has signature ${function_.signature}`,
      );
    }
    const signature = module.signatures[exported.signature];
    const exposedTypes = [...signature.parameters, signature.result];
    if (exposedTypes.some((type) => typeContainsScratch(module, type))) {
      throw new TypeError(
        `${module.source}: export ${exported.sourceName} exposes compiler-private Scratch storage`,
      );
    }
  }
  return module as ValidatedBlotRuntimeModule;
}

function validateType(
  module: BlotRuntimeModule,
  type: BlotRuntimeType,
  typeId: number,
): void {
  if (type.kind === "store" || type.kind === "scratch") {
    requireType(
      module,
      type.elementType,
      `${type.kind} type ${typeId} element`,
    );
    if (typeContainsScratch(module, type.elementType)) {
      throw new TypeError(
        `${module.source}: ${type.kind} type ${typeId} nests compiler-private Scratch storage`,
      );
    }
    return;
  }
  if (type.kind === "indirect") {
    requireType(module, type.targetType, `indirect type ${typeId} target`);
    return;
  }
  if (type.kind === "product") {
    requireUniqueNames(
      type.fields.map((field) => field.name),
      `${module.source}: product type ${type.name} fields`,
    );
    type.fields.forEach((field, fieldIndex) =>
      requireType(
        module,
        field.type,
        `product type ${type.name} field ${fieldIndex}`,
      )
    );
    return;
  }
  if (type.kind === "sum") {
    if (type.cases.length === 0) {
      throw new TypeError(
        `${module.source}: sum type ${type.name} has no cases`,
      );
    }
    requireUniqueNames(
      type.cases.map((case_) => case_.name),
      `${module.source}: sum type ${type.name} cases`,
    );
    type.cases.forEach((case_, caseIndex) =>
      requireType(
        module,
        case_.payloadType,
        `sum type ${type.name} case ${caseIndex}`,
      )
    );
    return;
  }
  if (type.kind === "sealed") {
    requireType(
      module,
      type.representationType,
      `sealed type ${type.name} representation`,
    );
    return;
  }
  if (type.kind === "function") {
    requireSignature(module, type.signature, `function type ${typeId}`);
  }
}

function validateFunction(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  capabilityOperations: ReadonlyMap<string, number>,
  linkOperations: ReadonlyMap<string, number>,
): void {
  if (function_.reuse !== null && function_.reuse !== "checked") {
    throw new TypeError(
      `${module.source}: function ${function_.name} has unknown reuse certificate ${function_.reuse}`,
    );
  }
  if (
    typeof function_.suspends !== "boolean" ||
    typeof function_.framed !== "boolean"
  ) {
    throw new TypeError(
      `${module.source}: function ${function_.name} omitted checked suspension/frame facts`,
    );
  }
  const signature = requireSignature(
    module,
    function_.signature,
    `function ${function_.name}`,
  );
  const entry = function_.continuations[function_.entry];
  if (!Number.isSafeInteger(function_.entry) || entry === undefined) {
    throw new TypeError(
      `${module.source}: function ${function_.name} has an absent entry continuation ${function_.entry}`,
    );
  }
  if (
    entry.captures.length !== 0 ||
    entry.parameters.length !== signature.parameters.length ||
    entry.parameters.some((parameter, index) =>
      parameter.type !== signature.parameters[index]
    )
  ) {
    throw new TypeError(
      `${module.source}: function ${function_.name} entry inputs disagree with signature ${function_.signature}`,
    );
  }
  const definitions = new Map<number, BlotRuntimeValueDefinition>();
  for (const [ordinal, continuation] of function_.continuations.entries()) {
    if (continuation.id !== ordinal) {
      throw new TypeError(
        `${module.source}: continuation table index ${ordinal} contains ID ${continuation.id}`,
      );
    }
    for (const definition of continuation.parameters) {
      defineValue(module, function_, definitions, definition);
    }
    for (const instruction of continuation.instructions) {
      defineValue(
        module,
        function_,
        definitions,
        instruction.definition,
        instruction,
      );
    }
  }
  for (const continuation of function_.continuations) {
    const available = new Map<number, BlotRuntimeValueDefinition>();
    for (
      const definition of [...continuation.parameters, ...continuation.captures]
    ) {
      const original = definitions.get(definition.value);
      if (
        original === undefined || original.type !== definition.type ||
        original.ownership !== definition.ownership
      ) {
        throw new TypeError(
          `${module.source}: continuation ${function_.name}:${continuation.id} input ${definition.value} disagrees with its definition`,
        );
      }
      if (available.has(definition.value)) {
        throw new TypeError(
          `${module.source}: continuation ${function_.name}:${continuation.id} repeats input ${definition.value}`,
        );
      }
      available.set(definition.value, original);
    }
    for (const instruction of continuation.instructions) {
      for (const operand of instruction.operands) {
        requireValue(module, function_, available, operand);
      }
      validateInstruction(module, function_, instruction, available);
      if (
        function_.reuse === "checked" &&
        (instruction.operation.kind === "store.write" ||
          instruction.operation.kind === "store.grow") &&
        instruction.operation.update !== "owned-reuse"
      ) {
        throw new TypeError(
          `${module.source}: reuse-checked function ${function_.name} contains persistent ${instruction.operation.kind}`,
        );
      }
      const definition = definitions.get(instruction.definition.value);
      if (definition === undefined) {
        throw new TypeError("instruction lost its definition");
      }
      available.set(instruction.definition.value, definition);
    }
    const transition = continuation.transition;
    const edges: BlotRuntimeEdge[] = [];
    let resultType: number | undefined;
    switch (transition.kind) {
      case "jump":
        edges.push(transition.edge);
        break;
      case "branch": {
        const condition = requireValue(
          module,
          function_,
          available,
          transition.condition,
        );
        if (module.types[condition.type].kind !== "boolean") {
          throw new TypeError(
            `${module.source}: branch ${function_.name}:${continuation.id} requires a boolean condition`,
          );
        }
        edges.push(transition.consequent, transition.alternate);
        break;
      }
      case "switch": {
        const selector = requireValue(
          module,
          function_,
          available,
          transition.selector,
        );
        const kind = module.types[selector.type].kind;
        if (kind !== "integer-32" && kind !== "signed-integer-64") {
          throw new TypeError(
            `${module.source}: switch requires an integer selector`,
          );
        }
        const seen = new Set<BlotRuntimeConstant>();
        for (const [constant, edge] of transition.cases) {
          if (
            (kind === "integer-32" &&
              (typeof constant !== "number" || !Number.isInteger(constant))) ||
            (kind === "signed-integer-64" && typeof constant !== "bigint")
          ) {
            throw new TypeError(
              `${module.source}: switch case does not match its selector type`,
            );
          }
          if (seen.has(constant)) {
            throw new TypeError(
              `${module.source}: switch repeats case ${constant}`,
            );
          }
          seen.add(constant);
          edges.push(edge);
        }
        edges.push(transition.fallback);
        break;
      }
      case "call": {
        const called = requireSignature(
          module,
          transition.signature,
          `call ${function_.name}:${continuation.id}`,
        );
        if (typeof transition.suspends !== "boolean") {
          throw new TypeError(
            `${module.source}: call omitted its checked suspension fact`,
          );
        }
        if (
          transition.arguments.length !== called.parameters.length ||
          transition.arguments.some((argument, index) =>
            requireValue(module, function_, available, argument).type !==
              called.parameters[index]
          )
        ) {
          throw new TypeError(
            `${module.source}: call arguments disagree with signature ${transition.signature}`,
          );
        }
        const target = transition.target;
        let expectedSignature: number | undefined;
        let expectedSuspension: boolean | undefined;
        switch (target.kind) {
          case "function": {
            const callee = requireFunction(
              module,
              target.function,
              `call ${function_.name}:${continuation.id}`,
            );
            expectedSignature = callee.signature;
            expectedSuspension = callee.suspends;
            break;
          }
          case "host": {
            expectedSignature = capabilityOperations.get(
              `${target.capability}\u0000${target.operation}`,
            );
            expectedSuspension = module.capabilities.find((capability) =>
              capability.name === target.capability
            )?.operations.find((operation) =>
              operation.name === target.operation
            )?.contract.suspends;
            break;
          }
          case "link": {
            expectedSignature = linkOperations.get(
              `${target.unit}\u0000${target.name}`,
            );
            expectedSuspension = module.links.find((link) =>
              link.unit === target.unit && link.name === target.name
            )?.suspends;
            break;
          }
          default:
            throw new TypeError(
              `${module.source}: call has an unknown target kind`,
            );
        }
        if (
          expectedSignature === undefined || expectedSuspension === undefined
        ) {
          throw new TypeError(`${module.source}: call target is not declared`);
        }
        if (
          expectedSignature !== transition.signature ||
          expectedSuspension !== transition.suspends
        ) {
          throw new TypeError(
            `${module.source}: call disagrees with its target signature or suspension contract`,
          );
        }
        resultType = called.result;
        edges.push(transition.next);
        break;
      }
      case "return":
        if (
          requireValue(module, function_, available, transition.value).type !==
            signature.result
        ) {
          throw new TypeError(
            `${module.source}: return disagrees with function signature`,
          );
        }
        break;
      case "trap":
        if (typeof transition.message !== "string") {
          throw new TypeError(`${module.source}: trap has no message`);
        }
        break;
      default:
        throw new TypeError(
          `${module.source}: continuation has an unknown transition kind`,
        );
    }
    for (const edge of edges) {
      const successor = function_.continuations[edge.target];
      if (!Number.isSafeInteger(edge.target) || successor === undefined) {
        throw new TypeError(
          `${module.source}: edge targets absent continuation ${edge.target}`,
        );
      }
      if (edge.arguments.length !== successor.parameters.length) {
        throw new TypeError(
          `${module.source}: edge arguments disagree with continuation parameters`,
        );
      }
      edge.arguments.forEach((argument, index) => {
        let type: number;
        if (argument.kind === "value") {
          type =
            requireValue(module, function_, available, argument.value).type;
        } else if (argument.kind === "result" && resultType !== undefined) {
          type = resultType;
        } else {throw new TypeError(
            `${module.source}: edge has an invalid argument or references a result outside a call`,
          );}
        if (type !== successor.parameters[index].type) {
          throw new TypeError(
            `${module.source}: edge argument ${index} disagrees with continuation parameter type`,
          );
        }
      });
      for (const capture of successor.captures) {
        if (
          requireValue(module, function_, available, capture.value).type !==
            capture.type
        ) {
          throw new TypeError(
            `${module.source}: edge capture disagrees with its definition`,
          );
        }
      }
    }
  }
}

function defineValue(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  values: Map<number, BlotRuntimeValueDefinition>,
  definition: BlotRuntimeDefinition,
  instruction?: BlotRuntimeInstruction,
): void {
  requireType(
    module,
    definition.type,
    `value ${function_.name}:${definition.value}`,
  );
  if (!Number.isSafeInteger(definition.value) || definition.value < 0) {
    throw new TypeError(
      `${module.source}: function ${function_.name} defines invalid value ID ${definition.value}`,
    );
  }
  if (!["plain", "owned", "borrowed"].includes(definition.ownership)) {
    throw new TypeError(
      `${module.source}: value ${definition.value} has unknown ownership`,
    );
  }
  if (values.has(definition.value)) {
    throw new TypeError(
      `${module.source}: function ${function_.name} defines value ${definition.value} more than once`,
    );
  }
  values.set(definition.value, {
    type: definition.type,
    ownership: definition.ownership,
    instruction,
  });
}

function requireValue(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  available: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  value: number,
): BlotRuntimeValueDefinition {
  const definition = available.get(value);
  if (definition === undefined) {
    throw new TypeError(
      `${module.source}: continuation in ${function_.name} reads unavailable value ${value}`,
    );
  }
  return definition;
}

const operationKinds: Readonly<Record<BlotRuntimeOperation["kind"], true>> = {
  "constant": true,
  "scalar": true,
  "scalar.unary": true,
  "convert": true,
  "text.append": true,
  "text.join": true,
  "text.length": true,
  "text.byte-length": true,
  "text.scalar-at": true,
  "text.next-byte": true,
  "text.slice": true,
  "text.slice-bytes": true,
  "text.find-from": true,
  "text.find-byte-from": true,
  "text.from-i64": true,
  "text.compare": true,
  "text.contains": true,
  "vector": true,
  "product.make": true,
  "product.project": true,
  "sum.make": true,
  "sum.tag": true,
  "sum.payload": true,
  "indirect.make": true,
  "indirect.load": true,
  "store.empty": true,
  "store.literal": true,
  "store.new": true,
  "store.length": true,
  "store.read": true,
  "store.read.field": true,
  "store.write": true,
  "store.grow": true,
  "scratch.with-capacity": true,
  "scratch.push": true,
  "scratch.finish": true,
  "scratch.recycle": true,
  "closure.make": true,
  "seal.wrap": true,
  "callback.make": true,
  "seal.unwrap": true,
  "resource.move": true,
  "resource.borrow": true,
  "resource.freeze": true,
  "resource.drop": true,
};

function validateInstruction(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  instruction: BlotRuntimeInstruction,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
): void {
  const operation = instruction.operation;
  if (!Object.hasOwn(operationKinds, operation.kind)) {
    throw new TypeError(
      `${module.source}: unknown instruction operation ${operation.kind}`,
    );
  }
  if (operation.kind === "store.literal") {
    const resultType = module.types[instruction.definition.type];
    if (resultType.kind !== "store") {
      throw new TypeError(
        `${module.source}: store.literal ${function_.name}:${instruction.definition.value} has non-Store result type ${instruction.definition.type}`,
      );
    }
    if (operation.staticStore !== undefined) {
      if (instruction.operands.length !== 0) {
        throw new TypeError(
          `${module.source}: static store.literal ${function_.name}:${instruction.definition.value} retains runtime operands`,
        );
      }
      const staticStore = module.staticStores[operation.staticStore];
      if (staticStore === undefined) {
        throw new TypeError(
          `${module.source}: store.literal ${function_.name}:${instruction.definition.value} references absent static Store ${operation.staticStore}`,
        );
      }
      if (staticStore.elementType !== resultType.elementType) {
        throw new TypeError(
          `${module.source}: store.literal ${function_.name}:${instruction.definition.value} static Store element type ${staticStore.elementType} does not match ${resultType.elementType}`,
        );
      }
    }
    for (const operand of instruction.operands) {
      const definition = values.get(operand);
      if (
        definition === undefined || definition.type !== resultType.elementType
      ) {
        throw new TypeError(
          `${module.source}: store.literal ${function_.name}:${instruction.definition.value} operand ${operand} does not have element type ${resultType.elementType}`,
        );
      }
    }
  }
  if (operation.kind.startsWith("scratch.")) {
    validateScratchOperation(module, function_, instruction, values);
  }
  if (operation.kind === "store.read.field") {
    const source = values.get(instruction.operands[0]);
    const index = values.get(instruction.operands[1]);
    let sourceType: BlotRuntimeType | undefined;
    if (source !== undefined) {
      sourceType = module.types[source.type];
    }
    let fieldType: number | undefined;
    if (sourceType?.kind === "store") {
      const elementType = module.types[sourceType.elementType];
      if (elementType.kind === "product") {
        fieldType = elementType.fields[operation.field]?.type;
      }
    }
    if (
      instruction.operands.length !== 2 ||
      index === undefined ||
      module.types[index.type].kind !== "signed-integer-64" ||
      fieldType === undefined || fieldType !== instruction.definition.type
    ) {
      throw new TypeError(
        `${module.source}: store.read.field ${function_.name}:${instruction.definition.value} requires (Store Product, Int) -> selected field`,
      );
    }
  }
  if (operation.kind === "text.join") {
    const resultType = module.types[instruction.definition.type];
    const source = values.get(instruction.operands[0]);
    let sourceType: BlotRuntimeType | undefined;
    if (source !== undefined) {
      sourceType = module.types[source.type];
    }
    if (
      instruction.operands.length !== 1 || resultType.kind !== "text" ||
      sourceType?.kind !== "store" ||
      module.types[sourceType.elementType].kind !== "text"
    ) {
      throw new TypeError(
        `${module.source}: text.join ${function_.name}:${instruction.definition.value} requires Store Text -> Text`,
      );
    }
  }
  if (operation.kind === "text.next-byte") {
    const source = values.get(instruction.operands[0]);
    const byte = values.get(instruction.operands[1]);
    const resultType = module.types[instruction.definition.type];
    let noneType: BlotRuntimeType | undefined;
    let payloadType: BlotRuntimeType | undefined;
    if (
      resultType.kind === "sum" && resultType.cases.length === 2 &&
      resultType.cases[0].name === "None" && resultType.cases[1].name === "Some"
    ) {
      noneType = module.types[resultType.cases[0].payloadType];
      payloadType = module.types[resultType.cases[1].payloadType];
    }
    if (
      instruction.operands.length !== 2 || source === undefined ||
      byte === undefined || module.types[source.type].kind !== "text" ||
      module.types[byte.type].kind !== "signed-integer-64" ||
      noneType?.kind !== "unit" || payloadType?.kind !== "product" ||
      payloadType.fields.length !== 2 || payloadType.fields[0].name !== "0" ||
      payloadType.fields[1].name !== "1" ||
      module.types[payloadType.fields[0].type].kind !== "text" ||
      module.types[payloadType.fields[1].type].kind !== "signed-integer-64"
    ) {
      throw new TypeError(
        `${module.source}: text.next-byte ${function_.name}:${instruction.definition.value} requires (Text, Int) -> None | Some (Text, Int)`,
      );
    }
  }
  if (operation.kind === "vector" && operation.operator === "shuffle") {
    if (instruction.operands.length !== 6) {
      throw new TypeError(
        `${module.source}: vector shuffle ${function_.name}:${instruction.definition.value} requires two vectors and four selectors; received ${instruction.operands.length} operands`,
      );
    }
    const resultType = module.types[instruction.definition.type];
    const vectorOperands = instruction.operands.slice(0, 2).map((operand) => {
      const definition = values.get(operand);
      if (definition === undefined) {
        throw new TypeError(
          `${module.source}: vector shuffle ${function_.name}:${instruction.definition.value} uses undefined vector ${operand}`,
        );
      }
      return module.types[definition.type];
    });
    if (
      resultType.kind !== "vector" ||
      resultType.element !== "float-32" ||
      resultType.lanes !== 4 ||
      vectorOperands.some((type) =>
        type.kind !== "vector" ||
        type.element !== "float-32" ||
        type.lanes !== 4
      )
    ) {
      throw new TypeError(
        `${module.source}: vector shuffle ${function_.name}:${instruction.definition.value} requires F32x4 operands and result`,
      );
    }
    for (const selector of instruction.operands.slice(2)) {
      const definition = values.get(selector);
      if (definition === undefined) {
        throw new TypeError(
          `${module.source}: vector shuffle ${function_.name}:${instruction.definition.value} uses undefined selector ${selector}`,
        );
      }
      const selectorType = module.types[definition.type];
      const definingOperation = definition.instruction?.operation;
      if (
        selectorType.kind !== "integer-32" ||
        definingOperation?.kind !== "constant" ||
        typeof definingOperation.value !== "number" ||
        !Number.isInteger(definingOperation.value) ||
        definingOperation.value < 0 ||
        definingOperation.value > 7
      ) {
        throw new TypeError(
          `${module.source}: vector shuffle ${function_.name}:${instruction.definition.value} selector ${selector} must be a integer-32 constant from 0 through 7`,
        );
      }
    }
  }
  if (operation.kind === "closure.make") {
    requireFunction(
      module,
      operation.function,
      `${operation.kind} ${function_.name}:${instruction.definition.value}`,
    );
  }
  if (
    (operation.kind === "store.write" || operation.kind === "store.grow") &&
    operation.update === "owned-reuse"
  ) {
    if (instruction.definition.ownership !== "owned") {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${instruction.definition.value} claims owned reuse with ${instruction.definition.ownership} ownership`,
      );
    }
    const source = values.get(instruction.operands[0]);
    if (source === undefined) {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${instruction.definition.value} has no source Store`,
      );
    }
    const sourceType = module.types[source.type];
    const resultType = module.types[instruction.definition.type];
    if (sourceType.kind !== "store" || resultType.kind !== "store") {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${instruction.definition.value} claims owned reuse without Store source and result types`,
      );
    }
    const sourceLayout = runtimeLayoutWitness(module, source.type);
    const resultLayout = runtimeLayoutWitness(
      module,
      instruction.definition.type,
    );
    if (sourceLayout.fingerprint !== resultLayout.fingerprint) {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${instruction.definition.value} claims owned reuse across incompatible layouts ${sourceLayout.fingerprint} and ${resultLayout.fingerprint}`,
      );
    }
  }
}

function isStaticStoreValue(
  type: BlotRuntimeType,
  value: bigint | number | boolean | null,
): boolean {
  if (type.kind === "unit") return value === null;
  if (type.kind === "boolean") return typeof value === "boolean";
  if (type.kind === "signed-integer-64") return typeof value === "bigint";
  if (type.kind === "integer-32") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type.kind === "float-32" || type.kind === "float-64") {
    return typeof value === "number";
  }
  return false;
}

function validateScratchOperation(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  instruction: BlotRuntimeInstruction,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
): void {
  const operation = instruction.operation;
  const location =
    `${operation.kind} ${function_.name}:${instruction.definition.value}`;
  const resultType = module.types[instruction.definition.type];
  const operandTypeId = (index: number): number => {
    const operand = instruction.operands[index];
    if (operand === undefined) {
      throw new TypeError(
        `${module.source}: ${location} omits operand ${index}`,
      );
    }
    const definition = values.get(operand);
    if (definition === undefined) {
      throw new TypeError(
        `${module.source}: ${location} omits operand ${index}`,
      );
    }
    return definition.type;
  };
  const operandType = (index: number): BlotRuntimeType => {
    return module.types[operandTypeId(index)];
  };
  if (operation.kind === "scratch.with-capacity") {
    if (
      instruction.operands.length !== 1 || resultType.kind !== "scratch" ||
      operandType(0).kind !== "signed-integer-64"
    ) {
      throw new TypeError(
        `${module.source}: ${location} requires Int -> Scratch T`,
      );
    }
    return;
  }
  if (operation.kind === "scratch.push") {
    const sourceType = operandType(0);
    const valueType = operandTypeId(1);
    if (
      instruction.operands.length !== 2 || resultType.kind !== "scratch" ||
      sourceType.kind !== "scratch" ||
      sourceType.elementType !== resultType.elementType ||
      valueType !== resultType.elementType
    ) {
      throw new TypeError(
        `${module.source}: ${location} requires (Scratch T, T) -> Scratch T`,
      );
    }
    return;
  }
  const sourceType = operandType(0);
  if (operation.kind === "scratch.finish") {
    if (
      instruction.operands.length !== 1 || resultType.kind !== "store" ||
      sourceType.kind !== "scratch" ||
      sourceType.elementType !== resultType.elementType
    ) {
      throw new TypeError(
        `${module.source}: ${location} requires Scratch T -> Store T`,
      );
    }
    return;
  }
  if (
    instruction.operands.length !== 1 || resultType.kind !== "scratch" ||
    sourceType.kind !== "store" ||
    sourceType.elementType !== resultType.elementType
  ) {
    throw new TypeError(
      `${module.source}: ${location} requires Store T -> Scratch T`,
    );
  }
}

function typeContainsScratch(
  module: BlotRuntimeModule,
  typeId: number,
  seen = new Set<number>(),
): boolean {
  if (seen.has(typeId)) return false;
  seen.add(typeId);
  const type = module.types[typeId];
  if (type.kind === "scratch") return true;
  if (type.kind === "store") {
    return typeContainsScratch(module, type.elementType, seen);
  }
  if (type.kind === "indirect") {
    return typeContainsScratch(module, type.targetType, seen);
  }
  if (type.kind === "product") {
    return type.fields.some((field) =>
      typeContainsScratch(module, field.type, seen)
    );
  }
  if (type.kind === "sum") {
    return type.cases.some((case_) =>
      typeContainsScratch(module, case_.payloadType, seen)
    );
  }
  if (type.kind === "sealed") {
    return typeContainsScratch(module, type.representationType, seen);
  }
  return false;
}

function requireType(
  module: BlotRuntimeModule,
  type: number,
  location: string,
): BlotRuntimeType {
  if (!Number.isSafeInteger(type) || type < 0 || type >= module.types.length) {
    throw new TypeError(
      `${module.source}: ${location} uses type ${type}; ${module.types.length} types are defined`,
    );
  }
  return module.types[type];
}

function requireSignature(
  module: BlotRuntimeModule,
  signature: number,
  location: string,
): BlotRuntimeSignature {
  if (
    !Number.isSafeInteger(signature) || signature < 0 ||
    signature >= module.signatures.length
  ) {
    throw new TypeError(
      `${module.source}: ${location} uses signature ${signature}; ${module.signatures.length} signatures are defined`,
    );
  }
  return module.signatures[signature];
}

function requireFunction(
  module: BlotRuntimeModule,
  functionId: number,
  location: string,
): BlotRuntimeFunction {
  if (
    !Number.isSafeInteger(functionId) || functionId < 0 ||
    functionId >= module.functions.length
  ) {
    throw new TypeError(
      `${module.source}: ${location} uses function ${functionId}; ${module.functions.length} functions are defined`,
    );
  }
  return module.functions[functionId];
}

function validateEffectOwnership(
  ownership: BlotEffectOwnership,
  location: string,
): void {
  if (
    ownership === "unrestricted" || ownership === "affine" ||
    ownership === "linear"
  ) {
    return;
  }
  if (typeof ownership !== "object" || ownership === null) {
    throw new TypeError(`${location} has an invalid ownership mode`);
  }
  if (ownership.kind === "record") {
    requireUniqueNames(
      ownership.fields.map((field) => field.name),
      `${location} fields`,
    );
    for (const field of ownership.fields) {
      validateEffectOwnership(field.ownership, `${location}.${field.name}`);
    }
    return;
  }
  if (ownership.kind === "variant") {
    requireUniqueNames(
      ownership.cases.map((case_) => case_.name),
      `${location} cases`,
    );
    for (const case_ of ownership.cases) {
      validateEffectOwnership(case_.ownership, `${location}.#${case_.name}`);
    }
    return;
  }
  throw new TypeError(`${location} has an invalid structural ownership kind`);
}

function validateEffectOwnershipType(
  module: BlotRuntimeModule,
  ownership: BlotEffectOwnership,
  typeId: number,
  location: string,
): void {
  if (typeof ownership === "string") return;
  const type = requireType(module, typeId, location);
  if (ownership.kind === "record") {
    if (type.kind !== "product") {
      throw new TypeError(
        `${location} describes a record but runtime type ${typeId} is ${type.kind}`,
      );
    }
    requireMatchingOwnershipNames(
      ownership.fields.map((field) => field.name),
      type.fields.map((field) => field.name),
      location,
    );
    for (const field of ownership.fields) {
      const runtimeField = type.fields.find((candidate) =>
        candidate.name === field.name
      );
      if (runtimeField === undefined) {
        throw new TypeError(
          `${location} omits field ${JSON.stringify(field.name)}`,
        );
      }
      validateEffectOwnershipType(
        module,
        field.ownership,
        runtimeField.type,
        `${location}.${field.name}`,
      );
    }
    return;
  }
  if (type.kind !== "sum") {
    throw new TypeError(
      `${location} describes a variant but runtime type ${typeId} is ${type.kind}`,
    );
  }
  requireMatchingOwnershipNames(
    ownership.cases.map((case_) => case_.name),
    type.cases.map((case_) => case_.name),
    location,
  );
  for (const case_ of ownership.cases) {
    const runtimeCase = type.cases.find((candidate) =>
      candidate.name === case_.name
    );
    if (runtimeCase === undefined) {
      throw new TypeError(
        `${location} omits case ${JSON.stringify(case_.name)}`,
      );
    }
    validateEffectOwnershipType(
      module,
      case_.ownership,
      runtimeCase.payloadType,
      `${location}.#${case_.name}`,
    );
  }
}

function requireMatchingOwnershipNames(
  ownershipNames: readonly string[],
  typeNames: readonly string[],
  location: string,
): void {
  if (
    ownershipNames.length === typeNames.length &&
    ownershipNames.every((name) => typeNames.includes(name))
  ) {
    return;
  }
  throw new TypeError(
    `${location} names [${
      ownershipNames.join(", ")
    }] but its runtime type names [${typeNames.join(", ")}]`,
  );
}

function requireUniqueNames(names: readonly string[], location: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length === 0) {
      throw new TypeError(`${location} contains an empty name`);
    }
    if (seen.has(name)) {
      throw new TypeError(`${location} repeats ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
}
