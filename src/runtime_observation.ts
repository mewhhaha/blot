import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { RuntimeValue } from "./abi_values.ts";

/** Decode reference observations against the caller's declared representation. */
export function evaluationObservation(
  encoded: unknown,
  type: BlotAbiType,
): RuntimeValue {
  if (
    typeof encoded !== "object" || encoded === null || Array.isArray(encoded)
  ) {
    throw new TypeError(`Expected an evaluated ${type.kind} object`);
  }
  const value = encoded as Record<string, unknown>;
  if (value.tag === "extended") {
    return evaluationObservation(value.inner, type);
  }
  switch (type.kind) {
    case "unit":
      if (value.tag === "unit") return null;
      break;
    case "signed-integer-64": {
      if (value.tag !== "int" || typeof value.value !== "string") break;
      if (!/^-?(0|[1-9][0-9]*)$/.test(value.value)) break;
      const integer = BigInt(value.value);
      if (integer < -(1n << 63n) || integer >= 1n << 63n) break;
      return integer;
    }
    case "text":
      if (value.tag === "text" && typeof value.value === "string") {
        return value.value;
      }
      break;
    case "float-32": {
      if (value.tag !== "float32" || typeof value.bits !== "string") break;
      if (!/^[0-9a-f]{8}$/.test(value.bits)) break;
      const bytes = new DataView(new ArrayBuffer(4));
      bytes.setUint32(0, Number.parseInt(value.bits, 16));
      return bytes.getFloat32(0);
    }
    case "float-64": {
      if (value.tag !== "float" || typeof value.bits !== "string") break;
      if (!/^[0-9a-f]{16}$/.test(value.bits)) break;
      const bytes = new DataView(new ArrayBuffer(8));
      bytes.setBigUint64(0, BigInt(`0x${value.bits}`));
      return bytes.getFloat64(0);
    }
    case "boolean":
      if (value.tag !== "tag" || value.payload !== null) break;
      if (value.name === "True") return true;
      if (value.name === "False") return false;
      break;
    case "array":
      if (value.tag !== "array" || !Array.isArray(value.elements)) break;
      return value.elements.map((element) =>
        evaluationObservation(element, type.element)
      );
    case "record": {
      if (value.tag !== "shape" || !Array.isArray(value.fields)) break;
      const encodedFields = new Map<string, unknown>();
      for (const field of value.fields) {
        if (
          !Array.isArray(field) || field.length !== 2 ||
          typeof field[0] !== "string"
        ) {
          throw new TypeError("Invalid evaluated record field");
        }
        if (encodedFields.has(field[0])) {
          throw new TypeError(`Duplicate evaluated field ${field[0]}`);
        }
        encodedFields.set(field[0], field[1]);
      }
      const fields = new Map<string, RuntimeValue>();
      for (const field of type.fields) {
        if (!encodedFields.has(field.name)) {
          throw new TypeError(`Missing evaluated field ${field.name}`);
        }
        fields.set(
          field.name,
          evaluationObservation(encodedFields.get(field.name), field.type),
        );
      }
      if (encodedFields.size !== fields.size) {
        throw new TypeError("Evaluated fields differ from the public record");
      }
      return { kind: "record", fields };
    }
    case "variant": {
      if (value.tag !== "tag" || typeof value.name !== "string") break;
      const selected = type.cases.find((candidate) =>
        candidate.name === value.name
      );
      if (selected === undefined) {
        throw new TypeError(`Unknown evaluated constructor ${value.name}`);
      }
      if (selected.payload === undefined) {
        if (value.payload !== null) {
          throw new TypeError(`Unexpected payload for ${value.name}`);
        }
        return { kind: "variant", name: value.name };
      }
      return {
        kind: "variant",
        name: value.name,
        payload: evaluationObservation(value.payload, selected.payload),
      };
    }
    case "sealed":
      if (value.tag !== "sealed" || value.name !== type.name) break;
      return {
        kind: "sealed",
        name: type.name,
        value: evaluationObservation(value.inner, type.inner),
      };
    case "callback":
    case "resource":
      throw new TypeError(
        `${type.kind} observations require an explicit lifecycle fixture`,
      );
  }
  throw new TypeError(
    `Invalid evaluated ${type.kind}: ${JSON.stringify(encoded)}`,
  );
}
