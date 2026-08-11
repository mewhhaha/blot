import {
  type BlotAbiManifest,
  type BlotAbiType,
  flattenedAbiType,
} from "../conformance/gpufuck/runtime/abi.ts";
import type { CompilerArtifact } from "../compiler/session.ts";

type RuntimeValue =
  | null
  | bigint
  | number
  | boolean
  | string
  | readonly RuntimeValue[]
  | {
    readonly kind: "record";
    readonly fields: ReadonlyMap<string, RuntimeValue>;
  }
  | {
    readonly kind: "variant";
    readonly name: string;
    readonly payload?: RuntimeValue;
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly value: RuntimeValue;
  };

export async function runArtifact(artifact: CompilerArtifact): Promise<string> {
  const manifest = decodeManifest(artifact.manifestBytes);
  const exported = selectExport(manifest);
  if (manifest.imports.length > 0) {
    const imports = manifest.imports.map((imported) =>
      `${imported.capability}.${imported.operation}`
    );
    throw new TypeError(
      `run cannot supply host operations: ${imports.join(", ")}`,
    );
  }
  if (exported.function === null || exported.name === null) {
    throw new TypeError("run selected an export without a runtime function");
  }
  if (exported.function.parameters.length > 0) {
    throw new TypeError(
      `run requires a zero-parameter export; ${exported.sourceName} takes ${exported.function.parameters.length}`,
    );
  }
  const instantiated = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const callable = requiredFunction(instantiated.instance, exported.name);
  const resultType = exported.function.result;
  const flattened = flattenedAbiType(resultType);
  const postReturn = exported.postReturn;
  const raw = callable();
  let value: RuntimeValue;
  if (flattened.length <= 1) value = readDirect(resultType, raw);
  else {
    if (postReturn === null) {
      throw new TypeError(`${exported.name} omitted its indirect post-return`);
    }
    if (typeof raw !== "number") {
      throw new TypeError(`${exported.name} did not return a result pointer`);
    }
    const memory = requiredMemory(instantiated.instance, manifest);
    try {
      value = readMemory(resultType, memory, raw);
    } finally {
      requiredFunction(instantiated.instance, postReturn)(raw);
    }
  }
  return formatValue(value);
}

function decodeManifest(bytes: Uint8Array): BlotAbiManifest {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("format" in decoded) ||
    decoded.format !== "blot-core-wasm"
  ) {
    throw new TypeError("compiled artifact has an invalid Blot ABI manifest");
  }
  return decoded as BlotAbiManifest;
}

function selectExport(manifest: BlotAbiManifest) {
  const runtime = manifest.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  const defaultExport = runtime.find((exported) =>
    exported.sourceName === "default"
  );
  if (defaultExport !== undefined) return defaultExport;
  if (runtime.length === 1) return runtime[0];
  if (runtime.length === 0) {
    throw new TypeError("run found no runtime export");
  }
  const names = runtime.map((exported) => exported.sourceName);
  throw new TypeError(
    `run needs a default export when a module has several runtime exports: ${
      names.join(", ")
    }`,
  );
}

function requiredFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: readonly number[]) => unknown {
  const value = instance.exports[name];
  if (typeof value !== "function") {
    throw new TypeError(`Wasm export ${name} is not callable`);
  }
  return value as (...arguments_: readonly number[]) => unknown;
}

function requiredMemory(
  instance: WebAssembly.Instance,
  manifest: BlotAbiManifest,
): WebAssembly.Memory {
  const value = instance.exports[manifest.abi.memoryExport];
  if (!(value instanceof WebAssembly.Memory)) {
    throw new TypeError(
      `Wasm export ${manifest.abi.memoryExport} is not memory`,
    );
  }
  return value;
}

function readDirect(type: BlotAbiType, value: unknown): RuntimeValue {
  if (type.kind === "unit") return null;
  if (type.kind === "boolean") return value !== 0;
  if (
    type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64"
  ) {
    if (typeof value !== "number" && typeof value !== "bigint") {
      throw new TypeError(`Wasm returned an invalid ${type.kind}`);
    }
    return value;
  }
  if (type.kind === "sealed") {
    return {
      kind: "sealed",
      name: type.name,
      value: readDirect(type.inner, value),
    };
  }
  if (type.kind === "record") {
    const fields = new Map<string, RuntimeValue>();
    for (const field of type.fields) {
      if (flattenedAbiType(field.type).length === 0) {
        fields.set(field.name, readDirect(field.type, undefined));
      } else fields.set(field.name, readDirect(field.type, value));
    }
    return { kind: "record", fields };
  }
  if (type.kind === "variant" && typeof value === "number") {
    const cases = [...type.cases].sort(byName);
    const selected = cases[value];
    if (selected === undefined) {
      throw new RangeError(`invalid variant tag ${value}`);
    }
    if (selected.payload === undefined) {
      return { kind: "variant", name: selected.name };
    }
    return {
      kind: "variant",
      name: selected.name,
      payload: readDirect(selected.payload, undefined),
    };
  }
  throw new TypeError(`run cannot decode direct ${type.kind}`);
}

function readMemory(
  type: BlotAbiType,
  memory: WebAssembly.Memory,
  offset: number,
): RuntimeValue {
  const view = new DataView(memory.buffer);
  if (type.kind === "unit") return null;
  if (type.kind === "boolean") return view.getUint8(offset) !== 0;
  if (type.kind === "signed-integer-64") return view.getBigInt64(offset, true);
  if (type.kind === "float-32") return view.getFloat32(offset, true);
  if (type.kind === "float-64") return view.getFloat64(offset, true);
  if (type.kind === "text") {
    const pointer = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(memory.buffer, pointer, length),
    );
  }
  if (type.kind === "array") {
    const pointer = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    const element = memoryLayout(type.element);
    const values: RuntimeValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(
        readMemory(type.element, memory, pointer + index * element.size),
      );
    }
    return values;
  }
  if (type.kind === "sealed") {
    return {
      kind: "sealed",
      name: type.name,
      value: readMemory(type.inner, memory, offset),
    };
  }
  if (type.kind === "record") {
    const fields = new Map<string, RuntimeValue>();
    for (const field of recordLayout(type)) {
      fields.set(
        field.name,
        readMemory(field.type, memory, offset + field.offset),
      );
    }
    return { kind: "record", fields };
  }
  const layout = variantLayout(type);
  let tag: number;
  if (layout.discriminantSize === 1) tag = view.getUint8(offset);
  else if (layout.discriminantSize === 2) tag = view.getUint16(offset, true);
  else tag = view.getUint32(offset, true);
  const cases = [...type.cases].sort(byName);
  const selected = cases[tag];
  if (selected === undefined) {
    throw new RangeError(`invalid variant tag ${tag}`);
  }
  if (selected.payload === undefined) {
    return { kind: "variant", name: selected.name };
  }
  return {
    kind: "variant",
    name: selected.name,
    payload: readMemory(
      selected.payload,
      memory,
      offset + layout.payloadOffset,
    ),
  };
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
        Math.max(maximum, field.offset + memoryLayout(field.type).size),
      0,
    );
    return { alignment, size: alignTo(end, alignment) };
  }
  const layout = variantLayout(type);
  return { alignment: layout.alignment, size: layout.size };
}

function recordLayout(type: Extract<BlotAbiType, { kind: "record" }>) {
  let offset = 0;
  return [...type.fields].sort(byName).map((field) => {
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

function formatValue(value: RuntimeValue): string {
  if (value === null) return "()";
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "bigint" || typeof value === "number" ||
    typeof value === "boolean"
  ) return String(value);
  if (isRuntimeArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (value.kind === "record") {
    const fields = [...value.fields].map(([name, field]) =>
      `.${name} = ${formatValue(field)}`
    );
    return `{ ${fields.join("; ")} }`;
  }
  if (value.kind === "variant") {
    if (value.payload === undefined) return `#${value.name}`;
    return `#${value.name} ${formatValue(value.payload)}`;
  }
  return `${value.name}(${formatValue(value.value)})`;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function isRuntimeArray(value: RuntimeValue): value is readonly RuntimeValue[] {
  return Array.isArray(value);
}
