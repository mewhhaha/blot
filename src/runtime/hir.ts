import { runtimeHirSchema } from "../compiler/protocol.ts";

export type BlotRuntimeSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

export type BlotRuntimeOwnership = "plain" | "owned" | "borrowed";

export type BlotRuntimeType =
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

type BlotRuntimeOperationBase = {
  readonly result: number;
  readonly type: number;
  readonly operands: readonly number[];
  readonly ownership: BlotRuntimeOwnership;
  readonly span: BlotRuntimeSpan;
};

export type BlotRuntimeOperation =
  & BlotRuntimeOperationBase
  & (
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
        | "text.length"
        | "text.scalar-at"
        | "text.slice"
        | "text.find-from"
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
      readonly kind: "store.new";
    }
    | {
      readonly kind: "store.length";
    }
    | {
      readonly kind: "store.read";
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
      readonly kind: "call.direct";
      readonly function: number;
    }
    | {
      readonly kind: "call.external";
      readonly capability: string;
      readonly operation: string;
      readonly signature: number;
    }
    | {
      readonly kind: "closure.make";
      readonly function: number;
    }
    | {
      readonly kind: "call.indirect";
      readonly signature: number;
    }
    | {
      readonly kind: "host.call";
      readonly capability: string;
      readonly operation: string;
    }
    | {
      readonly kind:
        | "seal.wrap"
        | "seal.unwrap"
        | "resource.move"
        | "resource.borrow"
        | "resource.freeze"
        | "resource.drop";
    }
  );

export type BlotRuntimeTerminator =
  | {
    readonly kind: "branch";
    readonly target: number;
    readonly arguments: readonly number[];
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "conditional";
    readonly condition: number;
    readonly consequent: number;
    readonly consequentArguments: readonly number[];
    readonly alternate: number;
    readonly alternateArguments: readonly number[];
    readonly likely?: "consequent" | "alternate";
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "switch";
    readonly selector: number;
    readonly cases: readonly {
      readonly value:
        | { readonly kind: "integer-32"; readonly value: number }
        | { readonly kind: "signed-integer-64"; readonly value: string };
      readonly target: number;
    }[];
    readonly fallback: number;
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "return";
    readonly value: number;
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "trap";
    readonly message: string;
    readonly span: BlotRuntimeSpan;
  };

export type BlotRuntimeBlock = {
  readonly id: number;
  readonly parameters: readonly {
    readonly value: number;
    readonly type: number;
    readonly ownership: BlotRuntimeOwnership;
    readonly span: BlotRuntimeSpan;
  }[];
  readonly operations: readonly BlotRuntimeOperation[];
  readonly terminator: BlotRuntimeTerminator;
};

export type BlotRuntimeFunction = {
  readonly id: number;
  readonly name: string;
  readonly signature: number;
  readonly reuse?: "checked";
  readonly entryBlock: number;
  readonly blocks: readonly BlotRuntimeBlock[];
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
    readonly signature: number;
    readonly ownership: {
      readonly input: BlotEffectOwnership;
      readonly result: BlotEffectOwnership;
    };
  }[];
};

export type BlotRuntimeLink = {
  readonly unit: string;
  readonly name: string;
  readonly signature: number;
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
  readonly block: number;
  readonly operation: number;
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
        operation.ownership.input,
        `${module.source}: capability ${capability.name}.${operation.name} input ownership`,
      );
      validateEffectOwnership(
        operation.ownership.result,
        `${module.source}: capability ${capability.name}.${operation.name} result ownership`,
      );
      validateEffectOwnershipType(
        module,
        operation.ownership.input,
        signature.parameters[0],
        `${module.source}: capability ${capability.name}.${operation.name} input ownership`,
      );
      validateEffectOwnershipType(
        module,
        operation.ownership.result,
        signature.result,
        `${module.source}: capability ${capability.name}.${operation.name} result ownership`,
      );
    }
  }
  const linkOperations = new Map<string, number>();
  for (const link of module.links) {
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
  validateEffectClosure(module);
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
  if (function_.reuse !== undefined && function_.reuse !== "checked") {
    throw new TypeError(
      `${module.source}: function ${function_.name} has unknown reuse certificate ${function_.reuse}`,
    );
  }
  const signature = requireSignature(
    module,
    function_.signature,
    `function ${function_.name}`,
  );
  if (function_.blocks.length === 0) {
    throw new TypeError(
      `${module.source}: function ${function_.name} has no blocks`,
    );
  }
  if (
    function_.entryBlock < 0 || function_.entryBlock >= function_.blocks.length
  ) {
    throw new TypeError(
      `${module.source}: function ${function_.name} entry block ${function_.entryBlock} is outside ${function_.blocks.length} blocks`,
    );
  }
  const entry = function_.blocks[function_.entryBlock];
  if (
    entry.parameters.length !== signature.parameters.length ||
    entry.parameters.some((parameter, index) =>
      parameter.type !== signature.parameters[index]
    )
  ) {
    throw new TypeError(
      `${module.source}: function ${function_.name} entry parameters disagree with signature ${function_.signature}`,
    );
  }
  const values = new Map<number, BlotRuntimeValueDefinition>();
  for (const [blockIndex, block] of function_.blocks.entries()) {
    if (block.id !== blockIndex) {
      throw new TypeError(
        `${module.source}: function ${function_.name} block table index ${blockIndex} contains ID ${block.id}`,
      );
    }
    for (const parameter of block.parameters) {
      requireType(
        module,
        parameter.type,
        `block ${function_.name}:${block.id} parameter`,
      );
      defineValue(
        module,
        function_,
        values,
        parameter.value,
        parameter.type,
        block.id,
        -1,
      );
    }
    for (const [operationIndex, operation] of block.operations.entries()) {
      requireType(
        module,
        operation.type,
        `operation ${function_.name}:${operation.result}`,
      );
      defineValue(
        module,
        function_,
        values,
        operation.result,
        operation.type,
        block.id,
        operationIndex,
      );
    }
  }
  const predecessors = function_.blocks.map(() => new Set<number>());
  for (const block of function_.blocks) {
    recordPredecessors(module, function_, block, predecessors);
  }
  const dominators = calculateDominators(function_, predecessors);
  for (const block of function_.blocks) {
    for (const [operationIndex, operation] of block.operations.entries()) {
      for (const operand of operation.operands) {
        requireDominatingValue(
          module,
          function_,
          values,
          dominators,
          operand,
          block.id,
          operationIndex,
        );
      }
      validateOperation(
        module,
        function_,
        operation,
        capabilityOperations,
        linkOperations,
        values,
      );
      if (
        function_.reuse === "checked" &&
        (operation.kind === "store.write" || operation.kind === "store.grow") &&
        operation.update !== "owned-reuse"
      ) {
        throw new TypeError(
          `${module.source}: reuse-checked function ${function_.name} contains persistent ${operation.kind}`,
        );
      }
    }
    for (const operand of terminatorValues(block.terminator)) {
      requireDominatingValue(
        module,
        function_,
        values,
        dominators,
        operand,
        block.id,
        block.operations.length,
      );
    }
    validateTerminator(module, function_, block, values, signature.result);
  }
}

function recordPredecessors(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  block: BlotRuntimeBlock,
  predecessors: readonly Set<number>[],
): void {
  const terminator = block.terminator;
  let targets: readonly number[] = [];
  if (terminator.kind === "branch") targets = [terminator.target];
  if (terminator.kind === "conditional") {
    targets = [terminator.consequent, terminator.alternate];
  }
  if (terminator.kind === "switch") {
    targets = [
      ...terminator.cases.map((case_) => case_.target),
      terminator.fallback,
    ];
  }
  for (const target of targets) {
    if (function_.blocks[target] === undefined) {
      throw new TypeError(
        `${module.source}: function ${function_.name} block ${block.id} targets absent block ${target}`,
      );
    }
    predecessors[target].add(block.id);
  }
}

function calculateDominators(
  function_: BlotRuntimeFunction,
  predecessors: readonly ReadonlySet<number>[],
): readonly ReadonlySet<number>[] {
  const allBlocks = new Set(function_.blocks.map((block) => block.id));
  const dominators = function_.blocks.map((block) => {
    if (block.id === function_.entryBlock) return new Set([block.id]);
    return new Set(allBlocks);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of function_.blocks) {
      if (block.id === function_.entryBlock) continue;
      const incoming = [...predecessors[block.id]];
      let intersection = new Set<number>();
      if (incoming.length > 0) {
        intersection = new Set(dominators[incoming[0]]);
      }
      for (const predecessor of incoming.slice(1)) {
        for (const candidate of intersection) {
          if (!dominators[predecessor].has(candidate)) {
            intersection.delete(candidate);
          }
        }
      }
      intersection.add(block.id);
      if (!setsEqual(intersection, dominators[block.id])) {
        dominators[block.id] = intersection;
        changed = true;
      }
    }
  }
  return dominators;
}

function requireDominatingValue(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  dominators: readonly ReadonlySet<number>[],
  value: number,
  useBlock: number,
  useOperation: number,
): void {
  const definition = values.get(value);
  if (definition === undefined) {
    throw new TypeError(
      `${module.source}: function ${function_.name} uses undefined value ${value}`,
    );
  }
  if (
    definition.block === useBlock && definition.operation < useOperation
  ) {
    return;
  }
  if (
    definition.block !== useBlock && dominators[useBlock].has(definition.block)
  ) {
    return;
  }
  throw new TypeError(
    `${module.source}: value ${value} does not dominate its use in ${function_.name}:${useBlock}`,
  );
}

function terminatorValues(
  terminator: BlotRuntimeTerminator,
): readonly number[] {
  if (terminator.kind === "return") return [terminator.value];
  if (terminator.kind === "branch") return terminator.arguments;
  if (terminator.kind === "trap") return [];
  if (terminator.kind === "switch") return [terminator.selector];
  return [
    terminator.condition,
    ...terminator.consequentArguments,
    ...terminator.alternateArguments,
  ];
}

function setsEqual<Value>(
  left: ReadonlySet<Value>,
  right: ReadonlySet<Value>,
): boolean {
  return left.size === right.size &&
    [...left].every((value) => right.has(value));
}

function validateOperation(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  operation: BlotRuntimeOperation,
  capabilityOperations: ReadonlyMap<string, number>,
  linkOperations: ReadonlyMap<string, number>,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
): void {
  if (operation.kind.startsWith("scratch.")) {
    validateScratchOperation(module, function_, operation, values);
  }
  if (operation.kind === "vector" && operation.operator === "shuffle") {
    if (operation.operands.length !== 6) {
      throw new TypeError(
        `${module.source}: vector shuffle ${function_.name}:${operation.result} requires two vectors and four selectors; received ${operation.operands.length} operands`,
      );
    }
    const resultType = module.types[operation.type];
    const vectorOperands = operation.operands.slice(0, 2).map((operand) => {
      const definition = values.get(operand);
      if (definition === undefined) {
        throw new TypeError(
          `${module.source}: vector shuffle ${function_.name}:${operation.result} uses undefined vector ${operand}`,
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
        `${module.source}: vector shuffle ${function_.name}:${operation.result} requires F32x4 operands and result`,
      );
    }
    for (const selector of operation.operands.slice(2)) {
      const definition = values.get(selector);
      if (definition === undefined) {
        throw new TypeError(
          `${module.source}: vector shuffle ${function_.name}:${operation.result} uses undefined selector ${selector}`,
        );
      }
      const selectorType = module.types[definition.type];
      const definingOperation = function_.blocks[definition.block]
        .operations[definition.operation];
      if (
        selectorType.kind !== "integer-32" ||
        definingOperation?.kind !== "constant" ||
        typeof definingOperation.value !== "number" ||
        !Number.isInteger(definingOperation.value) ||
        definingOperation.value < 0 ||
        definingOperation.value > 7
      ) {
        throw new TypeError(
          `${module.source}: vector shuffle ${function_.name}:${operation.result} selector ${selector} must be a dominating integer-32 constant from 0 through 7`,
        );
      }
    }
  }
  if (operation.kind === "call.direct" || operation.kind === "closure.make") {
    requireFunction(
      module,
      operation.function,
      `${operation.kind} ${function_.name}:${operation.result}`,
    );
  }
  if (operation.kind === "call.indirect") {
    requireSignature(
      module,
      operation.signature,
      `indirect call ${function_.name}:${operation.result}`,
    );
  }
  if (operation.kind === "host.call") {
    const signature = capabilityOperations.get(
      `${operation.capability}\u0000${operation.operation}`,
    );
    if (signature === undefined) {
      throw new TypeError(
        `${module.source}: host call ${operation.capability}.${operation.operation} is not declared`,
      );
    }
    const requiredEffect = operation.capability;
    const functionEffects = module.signatures[function_.signature].effects;
    if (!functionEffects.includes(requiredEffect)) {
      throw new TypeError(
        `${module.source}: function ${function_.name} calls ${operation.capability}.${operation.operation} outside capability ${requiredEffect} in its effect row`,
      );
    }
  }
  if (operation.kind === "call.external") {
    const signature = linkOperations.get(
      `${operation.capability}\u0000${operation.operation}`,
    );
    if (signature === undefined) {
      throw new TypeError(
        `${module.source}: external call ${operation.capability}.${operation.operation} is not declared`,
      );
    }
    if (signature !== operation.signature) {
      throw new TypeError(
        `${module.source}: external call ${operation.capability}.${operation.operation} declares signature ${operation.signature}, expected ${signature}`,
      );
    }
  }
  if (
    (operation.kind === "store.write" || operation.kind === "store.grow") &&
    operation.update === "owned-reuse"
  ) {
    if (operation.ownership !== "owned") {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${operation.result} claims owned reuse with ${operation.ownership} ownership`,
      );
    }
    const source = values.get(operation.operands[0]);
    if (source === undefined) {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${operation.result} has no source Store`,
      );
    }
    const sourceType = module.types[source.type];
    const resultType = module.types[operation.type];
    if (sourceType.kind !== "store" || resultType.kind !== "store") {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${operation.result} claims owned reuse without Store source and result types`,
      );
    }
    const sourceLayout = runtimeLayoutWitness(module, source.type);
    const resultLayout = runtimeLayoutWitness(module, operation.type);
    if (sourceLayout.fingerprint !== resultLayout.fingerprint) {
      throw new TypeError(
        `${module.source}: ${operation.kind} ${function_.name}:${operation.result} claims owned reuse across incompatible layouts ${sourceLayout.fingerprint} and ${resultLayout.fingerprint}`,
      );
    }
  }
}

function validateScratchOperation(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  operation: BlotRuntimeOperation,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
): void {
  const location = `${operation.kind} ${function_.name}:${operation.result}`;
  const resultType = module.types[operation.type];
  const operandTypeId = (index: number): number => {
    const operand = operation.operands[index];
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
      operation.operands.length !== 1 || resultType.kind !== "scratch" ||
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
      operation.operands.length !== 2 || resultType.kind !== "scratch" ||
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
      operation.operands.length !== 1 || resultType.kind !== "store" ||
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
    operation.operands.length !== 1 || resultType.kind !== "scratch" ||
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

function validateEffectClosure(
  module: BlotRuntimeModule,
): void {
  const declaredCapabilities = new Set(
    module.capabilities.map((capability) => capability.name),
  );
  module.signatures.forEach((signature, signatureId) => {
    for (const effect of signature.effects) {
      if (!declaredCapabilities.has(effect)) {
        throw new TypeError(
          `${module.source}: signature ${signatureId} names undeclared effect ${effect}`,
        );
      }
    }
  });
  const observed = module.functions.map(() => new Set<string>());
  const directCalls = module.functions.map(() => new Set<number>());
  for (const function_ of module.functions) {
    const reachable = reachableBlocks(function_);
    for (const block of function_.blocks) {
      if (!reachable.has(block.id)) continue;
      for (const operation of block.operations) {
        if (operation.kind === "host.call") {
          observed[function_.id].add(
            operation.capability,
          );
        } else if (operation.kind === "call.direct") {
          directCalls[function_.id].add(operation.function);
        } else if (operation.kind === "call.external") {
          module.signatures[operation.signature].effects.forEach((effect) =>
            observed[function_.id].add(effect)
          );
        } else if (operation.kind === "call.indirect") {
          module.signatures[operation.signature].effects.forEach((effect) =>
            observed[function_.id].add(effect)
          );
        }
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const function_ of module.functions) {
      for (const callee of directCalls[function_.id]) {
        for (const effect of observed[callee]) {
          if (observed[function_.id].has(effect)) continue;
          observed[function_.id].add(effect);
          changed = true;
        }
      }
    }
  }
  for (const function_ of module.functions) {
    const declared = new Set(module.signatures[function_.signature].effects);
    if (setsEqual(declared, observed[function_.id])) continue;
    throw new TypeError(
      `${module.source}: function ${function_.name} effect row [${
        [...declared].sort().join(", ")
      }] differs from reachable effects [${
        [...observed[function_.id]].sort().join(", ")
      }]`,
    );
  }
}

function reachableBlocks(function_: BlotRuntimeFunction): ReadonlySet<number> {
  const reachable = new Set<number>();
  const pending = [function_.entryBlock];
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (reachable.has(block)) continue;
    reachable.add(block);
    const terminator = function_.blocks[block].terminator;
    if (terminator.kind === "branch") pending.push(terminator.target);
    if (terminator.kind === "conditional") {
      pending.push(terminator.consequent, terminator.alternate);
    }
    if (terminator.kind === "switch") {
      pending.push(
        ...terminator.cases.map((case_) => case_.target),
        terminator.fallback,
      );
    }
  }
  return reachable;
}

function validateTerminator(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  block: BlotRuntimeBlock,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  resultType: number,
): void {
  const terminator = block.terminator;
  if (terminator.kind === "return") {
    const definition = values.get(terminator.value);
    if (definition === undefined) {
      throw new TypeError(
        `${module.source}: return ${function_.name}:${block.id} uses undefined value ${terminator.value}`,
      );
    }
    if (definition.type !== resultType) {
      throw new TypeError(
        `${module.source}: return ${function_.name}:${block.id} has type ${definition.type}; signature requires ${resultType}`,
      );
    }
    return;
  }
  if (terminator.kind === "trap") return;
  if (terminator.kind === "conditional") {
    const conditionType = values.get(terminator.condition)?.type;
    if (
      conditionType === undefined ||
      module.types[conditionType]?.kind !== "boolean"
    ) {
      throw new TypeError(
        `${module.source}: conditional ${function_.name}:${block.id} requires boolean value; received ${terminator.condition} of type ${conditionType}`,
      );
    }
    validateEdge(
      module,
      function_,
      terminator.consequent,
      terminator.consequentArguments,
      values,
      `${block.id} consequent`,
    );
    validateEdge(
      module,
      function_,
      terminator.alternate,
      terminator.alternateArguments,
      values,
      `${block.id} alternate`,
    );
    return;
  }
  if (terminator.kind === "switch") {
    const selectorType = values.get(terminator.selector)?.type;
    const selectorKind = selectorType === undefined
      ? undefined
      : module.types[selectorType]?.kind;
    if (selectorKind !== "integer-32" && selectorKind !== "signed-integer-64") {
      throw new TypeError(
        `${module.source}: switch ${function_.name}:${block.id} requires an integer selector; received ${terminator.selector} of type ${selectorType}`,
      );
    }
    const expectedConstantKind = selectorKind;
    const seen = new Set<string>();
    for (const case_ of terminator.cases) {
      if (case_.value.kind !== expectedConstantKind) {
        throw new TypeError(
          `${module.source}: switch ${function_.name}:${block.id} case ${case_.value.value} has kind ${case_.value.kind}; selector requires ${expectedConstantKind}`,
        );
      }
      const key = `${case_.value.kind}:${case_.value.value}`;
      if (seen.has(key)) {
        throw new TypeError(
          `${module.source}: switch ${function_.name}:${block.id} repeats case ${case_.value.value}`,
        );
      }
      seen.add(key);
      validateEdge(
        module,
        function_,
        case_.target,
        [],
        values,
        `${block.id} switch case ${case_.value.value}`,
      );
    }
    validateEdge(
      module,
      function_,
      terminator.fallback,
      [],
      values,
      `${block.id} switch fallback`,
    );
    return;
  }
  validateEdge(
    module,
    function_,
    terminator.target,
    terminator.arguments,
    values,
    `${block.id} branch`,
  );
}

function validateEdge(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  target: number,
  arguments_: readonly number[],
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  location: string,
): void {
  const targetBlock = function_.blocks[target];
  if (targetBlock === undefined) {
    throw new TypeError(
      `${module.source}: ${function_.name}:${location} targets absent block ${target}`,
    );
  }
  if (arguments_.length !== targetBlock.parameters.length) {
    throw new TypeError(
      `${module.source}: ${function_.name}:${location} passes ${arguments_.length} values to ${targetBlock.parameters.length} block parameters`,
    );
  }
  arguments_.forEach((argument, index) => {
    const type = values.get(argument)?.type;
    const expected = targetBlock.parameters[index].type;
    if (type !== expected) {
      throw new TypeError(
        `${module.source}: ${function_.name}:${location} argument ${index} has type ${type}; target requires ${expected}`,
      );
    }
  });
}

function defineValue(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  values: Map<number, BlotRuntimeValueDefinition>,
  value: number,
  type: number,
  block: number,
  operation: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `${module.source}: function ${function_.name} defines invalid value ID ${value}`,
    );
  }
  if (values.has(value)) {
    throw new TypeError(
      `${module.source}: function ${function_.name} defines value ${value} more than once`,
    );
  }
  values.set(value, { type, block, operation });
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
