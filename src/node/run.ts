import { AbiMemoryLayouts } from "../compiler/backend/runtime/memory_layout.ts";
import {
  type BlotAbiManifest,
  type BlotAbiType,
  flattenedAbiType,
} from "../compiler/backend/runtime/abi.ts";
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
      value = readMemory(
        resultType,
        new DataView(memory.buffer),
        raw,
      );
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
    return new TextDecoder("utf-8", { fatal: true }).decode(
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
