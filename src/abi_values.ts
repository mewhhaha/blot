import { AbiMemoryLayouts } from "./compiler/backend/runtime/memory_layout.ts";
import {
  type BlotAbiManifest,
  type BlotAbiType,
  flattenedAbiType,
} from "./compiler/backend/runtime/abi.ts";

export type RuntimeValue =
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

export function decodeManifest(bytes: Uint8Array): BlotAbiManifest {
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

export function requiredFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: readonly (number | bigint)[]) => unknown {
  const value = instance.exports[name];
  if (typeof value !== "function") {
    throw new TypeError(`Wasm export ${name} is not callable`);
  }
  return value as (...arguments_: readonly (number | bigint)[]) => unknown;
}

export function requiredMemory(
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

export function readDirect(type: BlotAbiType, value: unknown): RuntimeValue {
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

export function readMemory(
  type: BlotAbiType,
  view: DataView,
  offset: number,
  layouts?: AbiMemoryLayouts,
): RuntimeValue {
  if (type.kind === "unit") return null;
  if (type.kind === "boolean") return view.getUint8(offset) !== 0;
  if (type.kind === "signed-integer-64") return view.getBigInt64(offset, true);
  if (type.kind === "float-32") return view.getFloat32(offset, true);
  if (type.kind === "float-64") return view.getFloat64(offset, true);
  if (type.kind === "text") {
    const pointer = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    // ABI Text has no encoding signature; retain a leading U+FEFF.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new Uint8Array(view.buffer, pointer, length),
    );
  }
  if (type.kind === "sealed") {
    return {
      kind: "sealed",
      name: type.name,
      value: readMemory(type.inner, view, offset, layouts),
    };
  }
  // Scalars and text do not need layout metadata. Allocate a cache only when
  // an aggregate first needs it, then share it throughout this result read.
  if (layouts === undefined) layouts = new AbiMemoryLayouts();
  if (type.kind === "array") {
    const pointer = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    const element = layouts.get(type.element);
    const values: RuntimeValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(
        readMemory(type.element, view, pointer + index * element.size, layouts),
      );
    }
    return values;
  }
  if (type.kind === "record") {
    const fields = new Map<string, RuntimeValue>();
    for (const field of layouts.get(type).fields) {
      fields.set(
        field.name,
        readMemory(field.type, view, offset + field.offset, layouts),
      );
    }
    return { kind: "record", fields };
  }
  const layout = layouts.get(type);
  let tag: number;
  if (layout.discriminantSize === 1) tag = view.getUint8(offset);
  else if (layout.discriminantSize === 2) tag = view.getUint16(offset, true);
  else tag = view.getUint32(offset, true);
  const selected = layout.cases[tag];
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
      view,
      offset + layout.payloadOffset,
      layouts,
    ),
  };
}

/** Copy a logical host value into canonical guest memory, refreshing views after allocation. */
export function writeMemory(
  type: BlotAbiType,
  value: RuntimeValue,
  memory: WebAssembly.Memory,
  offset: number,
  allocate: (alignment: number, size: number) => number,
  layouts = new AbiMemoryLayouts(),
): void {
  const view = () => new DataView(memory.buffer);
  if (type.kind === "unit" && value === null) return;
  if (type.kind === "boolean" && typeof value === "boolean") {
    let flag = 0;
    if (value) flag = 1;
    view().setUint8(offset, flag);
    return;
  }
  if (type.kind === "signed-integer-64" && typeof value === "bigint") {
    if (value < -9223372036854775808n || value > 9223372036854775807n) {
      throw new RangeError("Int host value is outside signed 64-bit range");
    }
    view().setBigInt64(offset, value, true);
    return;
  }
  if (type.kind === "float-32" && typeof value === "number") {
    view().setFloat32(offset, value, true);
    return;
  }
  if (type.kind === "float-64" && typeof value === "number") {
    view().setFloat64(offset, value, true);
    return;
  }
  if (type.kind === "text" && typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    const pointer = allocate(1, bytes.length);
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    view().setUint32(offset, pointer, true);
    view().setUint32(offset + 4, bytes.length, true);
    return;
  }
  if (type.kind === "array" && Array.isArray(value)) {
    const element = layouts.get(type.element);
    const pointer = allocate(element.alignment, element.size * value.length);
    value.forEach((elementValue: RuntimeValue, index: number) => {
      writeMemory(
        type.element,
        elementValue,
        memory,
        pointer + index * element.size,
        allocate,
        layouts,
      );
    });
    view().setUint32(offset, pointer, true);
    view().setUint32(offset + 4, value.length, true);
    return;
  }
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new TypeError(`expected ${type.kind} host value`);
  }
  if (type.kind === "record" && value.kind === "record") {
    if (type.fields.length !== value.fields.size) {
      throw new TypeError("host record field count mismatch");
    }
    for (const field of layouts.get(type).fields) {
      const fieldValue = value.fields.get(field.name);
      if (fieldValue === undefined) {
        throw new TypeError(`host record omitted ${field.name}`);
      }
      writeMemory(
        field.type,
        fieldValue,
        memory,
        offset + field.offset,
        allocate,
        layouts,
      );
    }
    return;
  }
  if (
    type.kind === "sealed" && value.kind === "sealed" &&
    value.name === type.name
  ) {
    writeMemory(type.inner, value.value, memory, offset, allocate, layouts);
    return;
  }
  if (type.kind === "variant" && value.kind === "variant") {
    const layout = layouts.get(type);
    const tag = layout.cases.findIndex((case_) => case_.name === value.name);
    if (tag < 0) throw new TypeError(`unknown host variant ${value.name}`);
    const selected = layout.cases[tag];
    if (selected.payload !== undefined) {
      if (value.payload === undefined) {
        throw new TypeError(`host variant ${value.name} omitted its payload`);
      }
      writeMemory(
        selected.payload,
        value.payload,
        memory,
        offset + layout.payloadOffset,
        allocate,
        layouts,
      );
    } else if (value.payload !== undefined) {
      throw new TypeError(
        `host variant ${value.name} has an unexpected payload`,
      );
    }
    if (layout.discriminantSize === 1) view().setUint8(offset, tag);
    else if (layout.discriminantSize === 2) view().setUint16(offset, tag, true);
    else view().setUint32(offset, tag, true);
    return;
  }
  throw new TypeError(`expected ${type.kind} host value`);
}

export function formatValue(value: RuntimeValue): string {
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
