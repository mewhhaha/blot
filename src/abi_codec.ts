import { readMemory, type RuntimeValue } from "./abi_values.ts";
import {
  type BlotAbiType,
  flattenedAbiType,
} from "./compiler/backend/runtime/abi.ts";
import { AbiMemoryLayouts } from "./compiler/backend/runtime/memory_layout.ts";
import type { HostScope } from "./resources.ts";
import type { HostCallbackFactory } from "./callbacks.ts";

type Lane = number | bigint;
type LaneType = "i32" | "i64" | "f32" | "f64";

/** Canonical host marshalling. All guest references are copied before returning. */
export class AbiCodec {
  readonly layouts = new AbiMemoryLayouts();

  constructor(
    readonly memory: WebAssembly.Memory,
    readonly allocate: (size: number, alignment: number) => number,
    readonly resources?: HostScope,
    readonly callbacks?: HostCallbackFactory,
  ) {}

  lower(type: BlotAbiType, value: RuntimeValue): Lane[] {
    if (type.kind === "callback") {
      throw new TypeError(
        "compiled callbacks can only leave their defining artifact",
      );
    }
    if (type.kind === "resource") {
      if (
        this.resources === undefined || typeof value !== "object" ||
        value === null || isArray(value) || value.kind !== "resource"
      ) {
        throw new TypeError(`expected an opaque ${type.name} resource`);
      }
      return [this.resources.lower(type.name, value, type.payload)];
    }
    if (type.kind === "unit" && value === null) return [];
    if (type.kind === "boolean" && typeof value === "boolean") {
      if (value) return [1];
      return [0];
    }
    if (type.kind === "signed-integer-64" && typeof value === "bigint") {
      if (value < -9223372036854775808n || value > 9223372036854775807n) {
        throw new RangeError("Int host value is outside signed 64-bit range");
      }
      return [value];
    }
    if (
      (type.kind === "float-32" || type.kind === "float-64") &&
      typeof value === "number"
    ) return [value];
    if (type.kind === "text" && typeof value === "string") {
      const bytes = new TextEncoder().encode(value);
      const pointer = this.allocate(bytes.length, 1);
      new Uint8Array(this.memory.buffer, pointer, bytes.length).set(bytes);
      return [pointer, bytes.length];
    }
    if (type.kind === "array" && isArray(value)) {
      const layout = this.layouts.get(type.element);
      const size = layout.size * value.length;
      if (!Number.isSafeInteger(size) || size > 0xffffffff) {
        throw new RangeError("array exceeds memory32");
      }
      const pointer = this.allocate(size, layout.alignment);
      for (let index = 0; index < value.length; index += 1) {
        this.write(type.element, value[index], pointer + index * layout.size);
      }
      return [pointer, value.length];
    }
    if (typeof value !== "object" || value === null || isArray(value)) {
      throw new TypeError(`expected ${type.kind} host value`);
    }
    if (
      type.kind === "sealed" && value.kind === "sealed" &&
      value.name === type.name
    ) {
      return this.lower(type.inner, value.value);
    }
    if (type.kind === "record" && value.kind === "record") {
      if (
        !(value.fields instanceof Map) ||
        value.fields.size !== type.fields.length
      ) {
        throw new TypeError("host record fields disagree with its ABI type");
      }
      return type.fields.flatMap((field) => {
        if (!value.fields.has(field.name)) {
          throw new TypeError(`missing host field ${field.name}`);
        }
        return this.lower(field.type, value.fields.get(field.name)!);
      });
    }
    if (type.kind === "variant" && value.kind === "variant") {
      const index = type.cases.findIndex((case_) => case_.name === value.name);
      if (index < 0) throw new TypeError(`unknown host variant ${value.name}`);
      const selected = type.cases[index];
      let payload: Lane[] = [];
      let payloadTypes: readonly LaneType[] = [];
      if (selected.payload === undefined) {
        if (value.payload !== undefined) {
          throw new TypeError(`variant ${value.name} has no payload`);
        }
      } else {
        if (value.payload === undefined) {
          throw new TypeError(`variant ${value.name} requires a payload`);
        }
        payload = this.lower(selected.payload, value.payload);
        payloadTypes = flattenedAbiType(selected.payload);
      }
      return [
        index,
        ...flattenedAbiType(type).slice(1).map((lane, position) => {
          if (position >= payload.length) {
            if (lane === "i64") return 0n;
            return 0;
          }
          return convertLane(payload[position], payloadTypes[position], lane);
        }),
      ];
    }
    throw new TypeError(`expected ${type.kind} host value`);
  }

  lift(type: BlotAbiType, lanes: readonly Lane[]): RuntimeValue {
    if (type.kind === "callback") {
      if (this.callbacks === undefined) {
        throw new TypeError("callback requires its artifact execution context");
      }
      return this.callbacks(type, this.lift(type.environment, lanes));
    }
    if (type.kind === "resource") {
      if (this.resources === undefined || typeof lanes[0] !== "bigint") {
        throw new TypeError("resource requires its host scope");
      }
      return this.resources.lift(type.name, lanes[0], type.payload);
    }
    if (lanes.length !== flattenedAbiType(type).length) {
      throw new TypeError("canonical lane arity mismatch");
    }
    if (type.kind === "unit") return null;
    if (type.kind === "boolean") {
      if (lanes[0] === 0) return false;
      if (lanes[0] === 1) return true;
      throw new TypeError("invalid host Boolean");
    }
    if (type.kind === "signed-integer-64") {
      if (typeof lanes[0] !== "bigint") {
        throw new TypeError("invalid host Int lane");
      }
      return lanes[0];
    }
    if (type.kind === "float-32" || type.kind === "float-64") {
      if (typeof lanes[0] !== "number") {
        throw new TypeError("invalid host float lane");
      }
      return lanes[0];
    }
    if (type.kind === "sealed") {
      return {
        kind: "sealed",
        name: type.name,
        value: this.lift(type.inner, lanes),
      };
    }
    if (type.kind === "text" || type.kind === "array") {
      const pointer = memory32(lanes[0]);
      const length = memory32(lanes[1]);
      if (type.kind === "text") {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(
            new Uint8Array(this.memory.buffer, pointer, length),
          );
      }
      const stride = this.layouts.get(type.element).size;
      if (pointer + stride * length > this.memory.buffer.byteLength) {
        throw new RangeError("array exceeds guest memory");
      }
      const values: RuntimeValue[] = [];
      for (let index = 0; index < length; index += 1) {
        values.push(
          readMemory(
            type.element,
            new DataView(this.memory.buffer),
            pointer + index * stride,
            this.layouts,
            this.resources,
            this.callbacks,
          ),
        );
      }
      return values;
    }
    if (type.kind === "record") {
      let position = 0;
      const fields = new Map<string, RuntimeValue>();
      for (const field of type.fields) {
        const width = flattenedAbiType(field.type).length;
        fields.set(
          field.name,
          this.lift(field.type, lanes.slice(position, position + width)),
        );
        position += width;
      }
      return { kind: "record", fields };
    }
    const selected = type.cases[memory32(lanes[0])];
    if (selected === undefined) throw new RangeError("invalid variant tag");
    if (selected.payload === undefined) {
      return { kind: "variant", name: selected.name };
    }
    const joined = flattenedAbiType(type);
    const payload = flattenedAbiType(selected.payload).map((lane, index) =>
      convertLane(lanes[index + 1], joined[index + 1], lane)
    );
    return {
      kind: "variant",
      name: selected.name,
      payload: this.lift(selected.payload, payload),
    };
  }

  write(type: BlotAbiType, value: RuntimeValue, pointer: number): void {
    const lanes = this.lower(type, value);
    this.writeFlat(type, lanes, pointer);
  }

  writeFlat(type: BlotAbiType, lanes: readonly Lane[], pointer: number): void {
    const view = new DataView(this.memory.buffer);
    if (type.kind === "unit") return;
    if (type.kind === "boolean") {
      view.setUint8(pointer, Number(lanes[0]));
      return;
    }
    if (type.kind === "signed-integer-64" || type.kind === "resource") {
      view.setBigInt64(pointer, BigInt(lanes[0]), true);
      return;
    }
    if (type.kind === "float-32") {
      view.setFloat32(pointer, Number(lanes[0]), true);
      return;
    }
    if (type.kind === "float-64") {
      view.setFloat64(pointer, Number(lanes[0]), true);
      return;
    }
    if (type.kind === "text" || type.kind === "array") {
      view.setUint32(pointer, memory32(lanes[0]), true);
      view.setUint32(pointer + 4, memory32(lanes[1]), true);
      return;
    }
    if (type.kind === "sealed") {
      this.writeFlat(type.inner, lanes, pointer);
      return;
    }
    if (type.kind === "callback") {
      this.writeFlat(type.environment, lanes, pointer);
      return;
    }
    if (type.kind === "record") {
      let position = 0;
      for (const field of this.layouts.get(type).fields) {
        const width = flattenedAbiType(field.type).length;
        this.writeFlat(
          field.type,
          lanes.slice(position, position + width),
          pointer + field.offset,
        );
        position += width;
      }
      return;
    }
    const layout = this.layouts.get(type);
    const tag = memory32(lanes[0]);
    if (layout.discriminantSize === 1) view.setUint8(pointer, tag);
    else if (layout.discriminantSize === 2) view.setUint16(pointer, tag, true);
    else view.setUint32(pointer, tag, true);
    const selected = layout.cases[tag];
    if (selected === undefined) throw new RangeError("invalid variant tag");
    if (selected.payload === undefined) return;
    const joined = flattenedAbiType(type);
    const payload = flattenedAbiType(selected.payload).map((lane, index) =>
      convertLane(lanes[index + 1], joined[index + 1], lane)
    );
    this.writeFlat(selected.payload, payload, pointer + layout.payloadOffset);
  }
}

function isArray(value: RuntimeValue): value is readonly RuntimeValue[] {
  return Array.isArray(value);
}

function memory32(value: Lane): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) ||
    value < -2147483648 || value > 0xffffffff
  ) {
    throw new TypeError("invalid memory32 lane");
  }
  return value >>> 0;
}

function convertLane(value: Lane, from: LaneType, to: LaneType): Lane {
  if (from === to) return value;
  const bits = new DataView(new ArrayBuffer(8));
  if (from === "i32") bits.setUint32(0, Number(value), true);
  else if (from === "i64") {
    bits.setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true);
  } else if (from === "f32") bits.setFloat32(0, Number(value), true);
  else bits.setFloat64(0, Number(value), true);
  if (to === "i32") return bits.getInt32(0, true);
  if (to === "i64") return bits.getBigInt64(0, true);
  if (to === "f32") return bits.getFloat32(0, true);
  return bits.getFloat64(0, true);
}
