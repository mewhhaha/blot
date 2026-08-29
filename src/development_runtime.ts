import type {
  BlotAbiFunction,
  BlotAbiManifest,
  BlotAbiType,
} from "./compiler/backend/runtime/abi.ts";
import { flattenedAbiType } from "./compiler/backend/runtime/abi.ts";
import type {
  DevelopmentBuild,
  RetainedDevelopmentUnit,
} from "./development.ts";
import type { DevelopmentUnitArtifact } from "./compiler/session.ts";

type WasmValue = number | bigint;
type Reallocate = (
  previousPointer: number,
  previousSize: number,
  alignment: number,
  newSize: number,
) => number;

type DevelopmentManifest = BlotAbiManifest & {
  readonly links: NonNullable<BlotAbiManifest["links"]>;
};

interface UnitActivation {
  readonly artifact: DevelopmentUnitArtifact;
  readonly manifest: DevelopmentManifest;
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
}

interface Allocation {
  readonly pointer: number;
  readonly size: number;
  readonly alignment: number;
}

export interface DevelopmentRuntimeContext {
  readonly unit: string;
  memory(): WebAssembly.Memory;
}

export type DevelopmentRuntimeImports = (
  context: DevelopmentRuntimeContext,
) => WebAssembly.Imports | Promise<WebAssembly.Imports>;

export class DevelopmentRuntime {
  readonly #imports: DevelopmentRuntimeImports;
  readonly #units = new Map<string, UnitActivation>();
  #entryUnit: string | undefined;
  #revision: string | undefined;

  constructor(imports: DevelopmentRuntimeImports = () => ({})) {
    this.#imports = imports;
  }

  get revision(): string | undefined {
    return this.#revision;
  }

  get entryInstance(): WebAssembly.Instance {
    if (this.#entryUnit === undefined) {
      throw new Error("development runtime has not activated a build");
    }
    return this.unitInstance(this.#entryUnit);
  }

  unitInstance(name: string): WebAssembly.Instance {
    const active = this.#units.get(name);
    if (active === undefined) {
      throw new Error(
        `development runtime has no active unit ${JSON.stringify(name)}`,
      );
    }
    return active.instance;
  }

  async activate(build: DevelopmentBuild): Promise<void> {
    this.#requireRetainedUnits(build.retainedUnits);
    const compiled = await Promise.all(
      build.changedUnits.map(async (artifact) => ({
        artifact,
        manifest: decodeManifest(artifact),
        module: await WebAssembly.compile(
          Uint8Array.from(artifact.wasm) as BufferSource,
        ),
      })),
    );
    const candidates = new Map<string, UnitActivation>();
    for (const prepared of compiled) {
      const activation: { instance?: WebAssembly.Instance } = {};
      const context: DevelopmentRuntimeContext = {
        unit: prepared.artifact.name,
        memory: () => {
          if (activation.instance === undefined) {
            throw new Error(
              `unit ${
                JSON.stringify(prepared.artifact.name)
              } used host memory during instantiation`,
            );
          }
          return requiredMemory(
            activation.instance,
            prepared.manifest,
            prepared.artifact.name,
          );
        },
      };
      const imports = await this.#imports(context);
      const linkedImports = this.#linkImports(
        prepared.artifact.name,
        prepared.manifest,
        imports,
        () => {
          if (activation.instance === undefined) {
            throw new Error(
              `unit ${
                JSON.stringify(prepared.artifact.name)
              } called a development link during instantiation`,
            );
          }
          return activation.instance;
        },
      );
      activation.instance = await WebAssembly.instantiate(
        prepared.module,
        linkedImports,
      );
      candidates.set(prepared.artifact.name, {
        ...prepared,
        instance: activation.instance,
      });
    }

    for (const removed of build.removedUnits) this.#units.delete(removed);
    for (const [name, active] of candidates) this.#units.set(name, active);
    if (!this.#units.has(build.entryUnit)) {
      throw new Error(
        `development build ${
          JSON.stringify(build.revision)
        } omitted entry unit ${JSON.stringify(build.entryUnit)}`,
      );
    }
    this.#entryUnit = build.entryUnit;
    this.#revision = build.revision;
  }

  #requireRetainedUnits(retained: readonly RetainedDevelopmentUnit[]): void {
    for (const expected of retained) {
      const active = this.#units.get(expected.name);
      if (active === undefined) {
        throw new Error(
          `development build retained inactive unit ${
            JSON.stringify(expected.name)
          }`,
        );
      }
      if (
        active.artifact.interfaceDigest !== expected.interfaceDigest ||
        active.artifact.implementationDigest !== expected.implementationDigest
      ) {
        throw new Error(
          `development build retained stale unit ${
            JSON.stringify(expected.name)
          }`,
        );
      }
    }
  }

  #linkImports(
    consumerName: string,
    manifest: DevelopmentManifest,
    hostImports: WebAssembly.Imports,
    consumerInstance: () => WebAssembly.Instance,
  ): WebAssembly.Imports {
    const imports: Record<string, WebAssembly.ModuleImports> = {
      ...hostImports,
    };
    for (const link of manifest.links) {
      if (Object.hasOwn(imports, link.module)) {
        throw new Error(
          `host imports for unit ${
            JSON.stringify(consumerName)
          } collide with development module ${JSON.stringify(link.module)}`,
        );
      }
      imports[link.module] = {
        [`blot:dev:${link.name}`]: (...arguments_: WasmValue[]) => {
          const consumer = consumerInstance();
          const provider = this.#units.get(link.unit);
          if (provider === undefined) {
            throw new Error(
              `unit ${JSON.stringify(consumerName)} called inactive provider ${
                JSON.stringify(link.unit)
              }`,
            );
          }
          return invokeLink(
            consumerName,
            consumer,
            link.function,
            provider,
            link.name,
            arguments_,
          );
        },
      };
    }
    return imports;
  }
}

function decodeManifest(
  artifact: DevelopmentUnitArtifact,
): DevelopmentManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(artifact.manifestBytes));
  } catch (cause) {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has an invalid ABI manifest`,
      { cause },
    );
  }
  if (!isRecord(decoded) || decoded.format !== "blot-core-wasm") {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has an unknown ABI manifest format`,
    );
  }
  const manifest = decoded as BlotAbiManifest;
  if (manifest.abi?.major !== 2 || !Array.isArray(manifest.exports)) {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has an incompatible ABI manifest`,
    );
  }
  const links = manifest.links;
  if (links !== undefined && !Array.isArray(links)) {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has invalid development links`,
    );
  }
  if (links === undefined) return { ...manifest, links: [] };
  return { ...manifest, links };
}

function invokeLink(
  consumerName: string,
  consumer: WebAssembly.Instance,
  function_: BlotAbiFunction,
  provider: UnitActivation,
  linkName: string,
  arguments_: readonly WasmValue[],
): WasmValue | undefined {
  const exported = provider.manifest.exports.find((candidate) =>
    candidate.name === `blot:dev:${linkName}`
  );
  if (
    exported === undefined || exported.function === null ||
    exported.name === null
  ) {
    throw new Error(
      `provider ${
        JSON.stringify(provider.artifact.name)
      } omitted development export ${JSON.stringify(linkName)}`,
    );
  }
  if (JSON.stringify(exported.function) !== JSON.stringify(function_)) {
    throw new Error(
      `development link ${JSON.stringify(linkName)} from ${
        JSON.stringify(consumerName)
      } disagrees with provider ${JSON.stringify(provider.artifact.name)}`,
    );
  }

  const consumerMemory = requiredMemory(
    consumer,
    provider.manifest,
    consumerName,
  );
  const providerMemory = requiredMemory(
    provider.instance,
    provider.manifest,
    provider.artifact.name,
  );
  const providerReallocate = requiredReallocate(provider);
  const allocations: Allocation[] = [];
  const parameterWidth = function_.parameters.flatMap(flattenedAbiType).length;
  const resultWidth = flattenedAbiType(function_.result).length;
  let expectedArguments = parameterWidth;
  if (resultWidth > 1) expectedArguments += 1;
  if (arguments_.length !== expectedArguments) {
    throw new Error(
      `development link ${
        JSON.stringify(linkName)
      } received ${arguments_.length} Wasm values, expected ${expectedArguments}`,
    );
  }

  let offset = 0;
  const providerArguments: WasmValue[] = [];
  for (const parameter of function_.parameters) {
    const width = flattenedAbiType(parameter).length;
    providerArguments.push(...copyFlatValue(
      parameter,
      arguments_.slice(offset, offset + width),
      consumerMemory,
      providerMemory,
      providerReallocate,
      allocations,
    ));
    offset += width;
  }

  const callable = requiredExportedFunction(provider.instance, exported.name);
  let providerResultPointer: number | undefined;
  try {
    const raw = callable(...providerArguments);
    if (resultWidth === 0) return undefined;
    if (resultWidth === 1) {
      if (!isWasmValue(raw)) {
        throw new Error(
          `development export ${
            JSON.stringify(exported.name)
          } returned an invalid direct value`,
        );
      }
      return copyFlatValue(
        function_.result,
        [raw],
        providerMemory,
        consumerMemory,
        requiredReallocateFromInstance(consumer, consumerName),
        [],
      )[0];
    }
    if (typeof raw !== "number") {
      throw new Error(
        `development export ${
          JSON.stringify(exported.name)
        } omitted its result pointer`,
      );
    }
    providerResultPointer = raw;
    const resultPointer = arguments_[arguments_.length - 1];
    if (typeof resultPointer !== "number") {
      throw new Error(
        `development link ${
          JSON.stringify(linkName)
        } received an invalid caller result pointer`,
      );
    }
    copyMemoryValue(
      function_.result,
      providerMemory,
      raw,
      consumerMemory,
      resultPointer,
      requiredReallocateFromInstance(consumer, consumerName),
      [],
    );
    return undefined;
  } finally {
    if (exported.postReturn !== null && providerResultPointer !== undefined) {
      const postReturn = requiredExportedFunction(
        provider.instance,
        exported.postReturn,
      );
      postReturn(providerResultPointer);
    }
    for (const allocation of allocations.reverse()) {
      providerReallocate(
        allocation.pointer,
        allocation.size,
        allocation.alignment,
        0,
      );
    }
  }
}

function copyFlatValue(
  type: BlotAbiType,
  values: readonly WasmValue[],
  sourceMemory: WebAssembly.Memory,
  targetMemory: WebAssembly.Memory,
  targetReallocate: Reallocate,
  allocations: Allocation[],
): WasmValue[] {
  if (type.kind === "unit") return [];
  if (
    type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64" || type.kind === "boolean"
  ) return [requiredWasmValue(values[0], type.kind)];
  if (type.kind === "sealed") {
    return copyFlatValue(
      type.inner,
      values,
      sourceMemory,
      targetMemory,
      targetReallocate,
      allocations,
    );
  }
  if (type.kind === "text") {
    const pointer = requiredPointer(values[0], "text pointer");
    const length = requiredLength(values[1], "text length");
    const copied = copyBytes(
      sourceMemory,
      pointer,
      length,
      targetMemory,
      1,
      targetReallocate,
      allocations,
    );
    return [copied, length];
  }
  if (type.kind === "array") {
    const pointer = requiredPointer(values[0], "array pointer");
    const length = requiredLength(values[1], "array length");
    const element = memoryLayout(type.element);
    const size = checkedSize(length, element.size, "array allocation");
    const copied = allocate(
      targetReallocate,
      size,
      element.alignment,
      allocations,
    );
    for (let index = 0; index < length; index += 1) {
      copyMemoryValue(
        type.element,
        sourceMemory,
        pointer + index * element.size,
        targetMemory,
        copied + index * element.size,
        targetReallocate,
        allocations,
      );
    }
    return [copied, length];
  }
  if (type.kind === "record") {
    const copied: WasmValue[] = [];
    let offset = 0;
    for (const field of type.fields) {
      const width = flattenedAbiType(field.type).length;
      copied.push(...copyFlatValue(
        field.type,
        values.slice(offset, offset + width),
        sourceMemory,
        targetMemory,
        targetReallocate,
        allocations,
      ));
      offset += width;
    }
    return copied;
  }
  const tag = requiredLength(values[0], "variant tag");
  const selected = type.cases[tag];
  if (selected === undefined) {
    throw new RangeError(
      `variant tag ${tag} exceeds ${type.cases.length} cases`,
    );
  }
  const joined = flattenedAbiType(type).slice(1);
  const copied: WasmValue[] = [tag, ...joined.map(zeroWasmValue)];
  if (selected.payload === undefined) return copied;
  const width = flattenedAbiType(selected.payload).length;
  const payload = copyFlatValue(
    selected.payload,
    values.slice(1, 1 + width),
    sourceMemory,
    targetMemory,
    targetReallocate,
    allocations,
  );
  copied.splice(1, payload.length, ...payload);
  return copied;
}

function copyMemoryValue(
  type: BlotAbiType,
  sourceMemory: WebAssembly.Memory,
  sourcePointer: number,
  targetMemory: WebAssembly.Memory,
  targetPointer: number,
  targetReallocate: Reallocate,
  allocations: Allocation[],
): void {
  const layout = memoryLayout(type);
  requireMemoryRange(sourceMemory, sourcePointer, layout.size, "source value");
  requireMemoryRange(targetMemory, targetPointer, layout.size, "target value");
  if (type.kind === "unit") return;
  if (type.kind === "boolean") {
    writeView(targetMemory).setUint8(
      targetPointer,
      readView(sourceMemory).getUint8(sourcePointer),
    );
    return;
  }
  if (type.kind === "signed-integer-64") {
    writeView(targetMemory).setBigInt64(
      targetPointer,
      readView(sourceMemory).getBigInt64(sourcePointer, true),
      true,
    );
    return;
  }
  if (type.kind === "float-32") {
    writeView(targetMemory).setFloat32(
      targetPointer,
      readView(sourceMemory).getFloat32(sourcePointer, true),
      true,
    );
    return;
  }
  if (type.kind === "float-64") {
    writeView(targetMemory).setFloat64(
      targetPointer,
      readView(sourceMemory).getFloat64(sourcePointer, true),
      true,
    );
    return;
  }
  if (type.kind === "sealed") {
    copyMemoryValue(
      type.inner,
      sourceMemory,
      sourcePointer,
      targetMemory,
      targetPointer,
      targetReallocate,
      allocations,
    );
    return;
  }
  if (type.kind === "text") {
    const source = readView(sourceMemory);
    const pointer = source.getUint32(sourcePointer, true);
    const length = source.getUint32(sourcePointer + 4, true);
    const copied = copyBytes(
      sourceMemory,
      pointer,
      length,
      targetMemory,
      1,
      targetReallocate,
      allocations,
    );
    const target = writeView(targetMemory);
    target.setUint32(targetPointer, copied, true);
    target.setUint32(targetPointer + 4, length, true);
    return;
  }
  if (type.kind === "array") {
    const source = readView(sourceMemory);
    const pointer = source.getUint32(sourcePointer, true);
    const length = source.getUint32(sourcePointer + 4, true);
    const element = memoryLayout(type.element);
    const size = checkedSize(length, element.size, "array allocation");
    const copied = allocate(
      targetReallocate,
      size,
      element.alignment,
      allocations,
    );
    for (let index = 0; index < length; index += 1) {
      copyMemoryValue(
        type.element,
        sourceMemory,
        pointer + index * element.size,
        targetMemory,
        copied + index * element.size,
        targetReallocate,
        allocations,
      );
    }
    const target = writeView(targetMemory);
    target.setUint32(targetPointer, copied, true);
    target.setUint32(targetPointer + 4, length, true);
    return;
  }
  if (type.kind === "record") {
    for (const field of recordLayout(type)) {
      copyMemoryValue(
        field.type,
        sourceMemory,
        sourcePointer + field.offset,
        targetMemory,
        targetPointer + field.offset,
        targetReallocate,
        allocations,
      );
    }
    return;
  }
  const variant = variantLayout(type);
  const source = readView(sourceMemory);
  let tag: number;
  if (variant.discriminantSize === 1) tag = source.getUint8(sourcePointer);
  else if (variant.discriminantSize === 2) {
    tag = source.getUint16(sourcePointer, true);
  } else tag = source.getUint32(sourcePointer, true);
  const selected = type.cases[tag];
  if (selected === undefined) {
    throw new RangeError(
      `variant tag ${tag} exceeds ${type.cases.length} cases`,
    );
  }
  const target = writeView(targetMemory);
  if (variant.discriminantSize === 1) target.setUint8(targetPointer, tag);
  else if (variant.discriminantSize === 2) {
    target.setUint16(targetPointer, tag, true);
  } else target.setUint32(targetPointer, tag, true);
  if (selected.payload === undefined) return;
  copyMemoryValue(
    selected.payload,
    sourceMemory,
    sourcePointer + variant.payloadOffset,
    targetMemory,
    targetPointer + variant.payloadOffset,
    targetReallocate,
    allocations,
  );
}

function copyBytes(
  sourceMemory: WebAssembly.Memory,
  sourcePointer: number,
  length: number,
  targetMemory: WebAssembly.Memory,
  alignment: number,
  targetReallocate: Reallocate,
  allocations: Allocation[],
): number {
  if (length === 0) return 0;
  requireMemoryRange(sourceMemory, sourcePointer, length, "byte sequence");
  const bytes = new Uint8Array(sourceMemory.buffer, sourcePointer, length)
    .slice();
  const pointer = allocate(targetReallocate, length, alignment, allocations);
  requireMemoryRange(targetMemory, pointer, length, "copied byte sequence");
  new Uint8Array(targetMemory.buffer, pointer, length).set(bytes);
  return pointer;
}

function allocate(
  reallocate: Reallocate,
  size: number,
  alignment: number,
  allocations: Allocation[],
): number {
  if (size === 0) return 0;
  const pointer = reallocate(0, 0, alignment, size);
  allocations.push({ pointer, size, alignment });
  return pointer;
}

function requiredMemory(
  instance: WebAssembly.Instance,
  manifest: BlotAbiManifest,
  unit: string,
): WebAssembly.Memory {
  const memory = instance.exports[manifest.abi.memoryExport];
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error(
      `development unit ${JSON.stringify(unit)} omitted memory export ${
        JSON.stringify(manifest.abi.memoryExport)
      }`,
    );
  }
  return memory;
}

function requiredReallocate(active: UnitActivation): Reallocate {
  return requiredReallocateFromInstance(active.instance, active.artifact.name);
}

function requiredReallocateFromInstance(
  instance: WebAssembly.Instance,
  unit: string,
): Reallocate {
  const value = instance.exports.cabi_realloc;
  if (typeof value !== "function") {
    throw new Error(
      `development unit ${JSON.stringify(unit)} omitted cabi_realloc`,
    );
  }
  return value as Reallocate;
}

function requiredExportedFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: WasmValue[]) => unknown {
  const value = instance.exports[name];
  if (typeof value !== "function") {
    throw new Error(
      `development provider omitted Wasm export ${JSON.stringify(name)}`,
    );
  }
  return value as (...arguments_: WasmValue[]) => unknown;
}

function memoryLayout(type: BlotAbiType): { alignment: number; size: number } {
  if (type.kind === "unit") return { alignment: 1, size: 0 };
  if (type.kind === "boolean") return { alignment: 1, size: 1 };
  if (type.kind === "float-32") return { alignment: 4, size: 4 };
  if (type.kind === "signed-integer-64" || type.kind === "float-64") {
    return { alignment: 8, size: 8 };
  }
  if (type.kind === "text" || type.kind === "array") {
    return { alignment: 4, size: 8 };
  }
  if (type.kind === "sealed") return memoryLayout(type.inner);
  if (type.kind === "record") {
    const fields = recordLayout(type);
    const alignment = fields.reduce(
      (maximum, field) => Math.max(maximum, memoryLayout(field.type).alignment),
      1,
    );
    const end = fields.reduce(
      (maximum, field) =>
        Math.max(
          maximum,
          field.offset + memoryLayout(field.type).size,
        ),
      0,
    );
    return { alignment, size: alignTo(end, alignment) };
  }
  const variant = variantLayout(type);
  return { alignment: variant.alignment, size: variant.size };
}

function recordLayout(type: Extract<BlotAbiType, { kind: "record" }>) {
  let offset = 0;
  return type.fields.map((field) => {
    const layout = memoryLayout(field.type);
    offset = alignTo(offset, layout.alignment);
    const result = { ...field, offset };
    offset += layout.size;
    return result;
  });
}

function variantLayout(type: Extract<BlotAbiType, { kind: "variant" }>) {
  let discriminantSize = 4;
  if (type.cases.length <= 65_536) discriminantSize = 2;
  if (type.cases.length <= 256) discriminantSize = 1;
  let payloadAlignment = 1;
  let payloadSize = 0;
  for (const case_ of type.cases) {
    if (case_.payload === undefined) continue;
    const layout = memoryLayout(case_.payload);
    payloadAlignment = Math.max(payloadAlignment, layout.alignment);
    payloadSize = Math.max(payloadSize, layout.size);
  }
  const alignment = Math.max(discriminantSize, payloadAlignment);
  const payloadOffset = alignTo(discriminantSize, payloadAlignment);
  return {
    discriminantSize,
    payloadOffset,
    alignment,
    size: alignTo(payloadOffset + payloadSize, alignment),
  };
}

function requiredPointer(
  value: WasmValue | undefined,
  position: string,
): number {
  const pointer = requiredLength(value, position);
  if (pointer > 0xffff_ffff) {
    throw new RangeError(`${position} ${pointer} exceeds memory32`);
  }
  return pointer;
}

function requiredLength(
  value: WasmValue | undefined,
  position: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${position} is not a non-negative i32: ${String(value)}`,
    );
  }
  return value;
}

function requiredWasmValue(
  value: WasmValue | undefined,
  position: string,
): WasmValue {
  if (!isWasmValue(value)) {
    throw new TypeError(`${position} has invalid Wasm value ${String(value)}`);
  }
  return value;
}

function requireMemoryRange(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
  position: string,
): void {
  if (
    !Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 ||
    length < 0 || pointer + length > memory.buffer.byteLength
  ) {
    throw new RangeError(
      `${position} range ${pointer}..${
        pointer + length
      } exceeds ${memory.buffer.byteLength}-byte memory`,
    );
  }
}

function checkedSize(count: number, size: number, position: string): number {
  const result = count * size;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new RangeError(`${position} ${count} * ${size} exceeds memory32`);
  }
  return result;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function readView(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

function writeView(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

function zeroWasmValue(type: "i32" | "i64" | "f32" | "f64"): WasmValue {
  if (type === "i64") return 0n;
  return 0;
}

function isWasmValue(value: unknown): value is WasmValue {
  return typeof value === "number" || typeof value === "bigint";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
