import type { RuntimeValue } from "./abi_values.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { HostOperation } from "./host.ts";
import type { HostScope, ResourceFamily } from "./resources.ts";

export type SharedStorage = "i32" | "f32" | "f64" | "atomic_i32";

export interface SharedMemoryWire {
  readonly storage: SharedStorage;
  readonly buffer: SharedArrayBuffer;
  readonly control: SharedArrayBuffer;
  readonly start: number;
  readonly length: number;
  readonly generation: number;
}

export interface SharedLoan {
  readonly argument: RuntimeValue;
  readonly memories: readonly SharedMemoryWire[];
  admitted(): void;
}

export function sharedMemoryWire(value: unknown): SharedMemoryWire {
  if (
    typeof value !== "object" || value === null || !("storage" in value) ||
    (value.storage !== "i32" && value.storage !== "f32" &&
      value.storage !== "f64" && value.storage !== "atomic_i32") ||
    !("buffer" in value) || !(value.buffer instanceof SharedArrayBuffer) ||
    !("control" in value) || !(value.control instanceof SharedArrayBuffer) ||
    !("start" in value) || typeof value.start !== "number" ||
    !Number.isSafeInteger(value.start) || value.start < 0 ||
    !("length" in value) || typeof value.length !== "number" ||
    !Number.isSafeInteger(value.length) || value.length < 0 ||
    !("generation" in value) || typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    value.generation > 2147483647
  ) throw new TypeError("invalid shared numeric descriptor");
  let width = 4;
  if (value.storage === "f64") width = 8;
  if (
    value.buffer.byteLength % width !== 0 || value.control.byteLength !== 4 ||
    value.start + value.length > value.buffer.byteLength / width ||
    (value.storage === "atomic_i32" &&
      (value.start !== 0 || value.length !== 1))
  ) throw new RangeError("shared numeric descriptor is out of bounds");
  return {
    storage: value.storage,
    buffer: value.buffer,
    control: value.control,
    start: value.start,
    length: value.length,
    generation: value.generation,
  };
}

export function sharedStorage(type: BlotAbiType): SharedStorage {
  if (type.kind === "resource") {
    if (type.name === "Shared.AtomicI32" && type.payload.kind === "unit") {
      return "atomic_i32";
    }
    if (type.name === "Shared.Partition" || type.name === "Shared.Rejoin") {
      if (type.payload.kind === "signed-integer-64") return "i32";
      if (type.payload.kind === "float-32") return "f32";
      if (type.payload.kind === "float-64") return "f64";
    }
  }
  throw new TypeError("expected a supported shared numeric resource type");
}

export function sharedTuple(
  value: RuntimeValue,
  arity: number,
): RuntimeValue[] {
  if (
    typeof value !== "object" || value === null || !("kind" in value) ||
    value.kind !== "record" || value.fields.size !== arity
  ) throw new TypeError(`expected a ${arity}-field Shared operation tuple`);
  return Array.from({ length: arity }, (_, index) => {
    const field = value.fields.get(String(index));
    if (field === undefined) {
      throw new TypeError(`missing Shared field ${index}`);
    }
    return field;
  });
}

/** Replace only resource leaves, following the compiler's checked ABI shape. */
export function mapSharedResources(
  type: BlotAbiType,
  value: RuntimeValue,
  resource: (
    type: Extract<BlotAbiType, { kind: "resource" }>,
    value: RuntimeValue,
  ) => RuntimeValue,
): RuntimeValue {
  switch (type.kind) {
    case "resource":
      return resource(type, value);
    case "callback":
      throw new TypeError("callbacks cannot be shared kernel arguments");
    case "array":
      if (!Array.isArray(value)) {
        throw new TypeError("expected a shared kernel array argument");
      }
      return value.map((element) =>
        mapSharedResources(type.element, element, resource)
      );
    case "record": {
      if (
        typeof value !== "object" || value === null || !("kind" in value) ||
        value.kind !== "record" || value.fields.size !== type.fields.length
      ) {
        throw new TypeError("expected a shared kernel record argument");
      }
      return {
        kind: "record",
        fields: new Map(type.fields.map((field) => {
          const member = value.fields.get(field.name);
          if (member === undefined) {
            throw new TypeError(`missing shared kernel field ${field.name}`);
          }
          return [field.name, mapSharedResources(field.type, member, resource)];
        })),
      };
    }
    case "variant": {
      if (
        typeof value !== "object" || value === null || !("kind" in value) ||
        value.kind !== "variant"
      ) {
        throw new TypeError("expected a shared kernel variant argument");
      }
      const selected = type.cases.find((case_) => case_.name === value.name);
      if (selected === undefined) {
        throw new TypeError("unknown shared kernel variant");
      }
      if (selected.payload === undefined) {
        if (value.payload !== undefined) {
          throw new TypeError("unexpected shared kernel variant payload");
        }
        return value;
      }
      if (value.payload === undefined) {
        throw new TypeError("missing shared kernel variant payload");
      }
      return {
        kind: "variant",
        name: value.name,
        payload: mapSharedResources(selected.payload, value.payload, resource),
      };
    }
    case "sealed":
      if (
        typeof value !== "object" || value === null || !("kind" in value) ||
        value.kind !== "sealed" || value.name !== type.name
      ) {
        throw new TypeError("expected a shared kernel sealed argument");
      }
      return {
        kind: "sealed",
        name: value.name,
        value: mapSharedResources(type.inner, value.value, resource),
      };
    default:
      return value;
  }
}

export function sharedView(
  wire: SharedMemoryWire,
): Int32Array | Float32Array | Float64Array {
  if (Atomics.load(new Int32Array(wire.control), 0) !== wire.generation) {
    throw new TypeError("shared numeric allocation has been invalidated");
  }
  if (wire.storage === "f32") {
    return new Float32Array(wire.buffer, wire.start * 4, wire.length);
  }
  if (wire.storage === "f64") {
    return new Float64Array(wire.buffer, wire.start * 8, wire.length);
  }
  return new Int32Array(wire.buffer, wire.start * 4, wire.length);
}

export function sharedNumber(
  storage: SharedStorage,
  value: RuntimeValue,
): number {
  if (storage === "i32" || storage === "atomic_i32") {
    if (
      typeof value !== "bigint" || value < -2147483648n || value > 2147483647n
    ) {
      throw new RangeError(
        "shared i32 value must be between -2147483648 and 2147483647",
      );
    }
    return Number(value);
  }
  if (typeof value !== "number") {
    throw new TypeError("shared float value must be a number");
  }
  return value;
}

export function sharedIndex(value: RuntimeValue, length: number): number {
  if (typeof value !== "bigint" || value < 0n || value >= BigInt(length)) {
    throw new RangeError(`shared index must be between 0 and ${length - 1}`);
  }
  return Number(value);
}

/** The worker receives explicit numeric leases; its Wasm heap stays private. */
export class SharedWorkerAccess {
  readonly #root: HostScope;
  readonly #families = new Map<string, ResourceFamily<SharedMemoryWire>>();
  readonly operations: ReadonlyMap<string, HostOperation>;

  constructor(root: HostScope) {
    this.#root = root;
    this.operations = new Map<string, HostOperation>([
      [
        "length",
        (context, handle) =>
          BigInt(
            this.#wire(context.operation.function.parameters[0], handle).length,
          ),
      ],
      ["read", (context, request) => {
        const [handle, index] = sharedTuple(request, 2);
        const wire = this.#wire(
          this.#firstType(context.operation.function.parameters[0]),
          handle,
        );
        const value = sharedView(wire)[sharedIndex(index, wire.length)];
        if (wire.storage === "i32") return BigInt(value);
        return value;
      }],
      ["write", (context, request) => {
        const [handle, index, value] = sharedTuple(request, 3);
        const wire = this.#wire(
          this.#firstType(context.operation.function.parameters[0]),
          handle,
        );
        sharedView(wire)[sharedIndex(index, wire.length)] = sharedNumber(
          wire.storage,
          value,
        );
        return null;
      }],
      ["atomic_load", (context, handle) => {
        const wire = this.#wire(
          context.operation.function.parameters[0],
          handle,
        );
        return BigInt(Atomics.load(this.#atomic(wire), 0));
      }],
      ["atomic_store", (context, request) => {
        const [handle, value] = sharedTuple(request, 2);
        const wire = this.#wire(
          this.#firstType(context.operation.function.parameters[0]),
          handle,
        );
        Atomics.store(this.#atomic(wire), 0, sharedNumber(wire.storage, value));
        return null;
      }],
      ["atomic_add", (context, request) => {
        const [handle, value] = sharedTuple(request, 2);
        const wire = this.#wire(
          this.#firstType(context.operation.function.parameters[0]),
          handle,
        );
        return BigInt(
          Atomics.add(this.#atomic(wire), 0, sharedNumber(wire.storage, value)),
        );
      }],
    ]);
  }

  restore(
    type: BlotAbiType,
    argument: RuntimeValue,
    memories: readonly SharedMemoryWire[],
    scope: HostScope,
  ): RuntimeValue {
    return mapSharedResources(type, argument, (type, encoded) => {
      if (
        typeof encoded !== "bigint" || encoded < 0n ||
        encoded >= BigInt(memories.length)
      ) {
        throw new TypeError("shared kernel resource has no descriptor");
      }
      const wire = memories[Number(encoded)];
      if (
        type.name === "Shared.Rejoin" || sharedStorage(type) !== wire.storage
      ) {
        throw new TypeError(
          "shared kernel resource contradicts its checked type",
        );
      }
      sharedView(wire);
      return this.#family(type).grant(scope, wire);
    });
  }

  #firstType(type: BlotAbiType): BlotAbiType {
    if (type.kind !== "record") {
      throw new Error("checked Shared access has no tuple");
    }
    const first = type.fields.find((field) => field.name === "0");
    if (first === undefined) {
      throw new Error("checked Shared access has no resource");
    }
    return first.type;
  }

  #family(type: BlotAbiType): ResourceFamily<SharedMemoryWire> {
    sharedStorage(type);
    if (type.kind !== "resource") {
      throw new Error("checked Shared access lost its resource type");
    }
    const key = JSON.stringify([type.name, type.payload]);
    let family = this.#families.get(key);
    if (family === undefined) {
      family = this.#root.resource<SharedMemoryWire>(type.name, {
        payload: type.payload,
      });
      this.#families.set(key, family);
    }
    return family;
  }

  #wire(type: BlotAbiType, handle: RuntimeValue): SharedMemoryWire {
    const wire = this.#family(type).get(handle);
    sharedView(wire);
    return wire;
  }

  #atomic(wire: SharedMemoryWire): Int32Array {
    const view = sharedView(wire);
    if (wire.storage !== "atomic_i32" || !(view instanceof Int32Array)) {
      throw new TypeError("expected a shared atomic i32 counter");
    }
    return view;
  }
}
