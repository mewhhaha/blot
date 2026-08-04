import type { Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import {
  equal,
  inferredTypeOf,
  type Value,
  withInferredType,
} from "./value.ts";

export type JsonInference = "widen" | "exact";

const UNBOUNDED: Value = { tag: "unbounded" };
const INT: Value = {
  tag: "range",
  low: UNBOUNDED,
  high: UNBOUNDED,
  domain: "int",
};
const STR: Value = {
  tag: "range",
  low: UNBOUNDED,
  high: UNBOUNDED,
  domain: "text",
};
const F64: Value = {
  tag: "range",
  low: UNBOUNDED,
  high: UNBOUNDED,
  domain: "float",
};
const BOOL: Value = {
  tag: "union",
  members: [
    { tag: "tag", name: "True", payload: null },
    { tag: "tag", name: "False", payload: null },
  ],
};

const JSON_NUMBER = Symbol("json-number");

interface JsonNumber {
  readonly [JSON_NUMBER]: true;
  readonly source: string;
}

interface JsonReviverContext {
  readonly source: string;
}

interface JsonParser {
  (
    source: string,
    reviver: (
      key: string,
      value: unknown,
      context: JsonReviverContext,
    ) => unknown,
  ): unknown;
}

const parseWithSource = JSON.parse as unknown as JsonParser;

export function parseJson(
  source: string,
  inference: JsonInference,
  span: Span,
): Value {
  let parsed: unknown;
  try {
    parsed = parseWithSource(
      source,
      (_key: string, value: unknown, context: JsonReviverContext) => {
        if (typeof value !== "number") return value;
        return { [JSON_NUMBER]: true, source: context.source };
      },
    );
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) reason = error.message;
    fail("BLOT_JSON_PARSE", `Could not parse JSON: ${reason}`, span);
  }
  return jsonValue(parsed, inference, span);
}

function jsonValue(
  parsed: unknown,
  inference: JsonInference,
  span: Span,
): Value {
  if (parsed === null) return { tag: "unit" };
  if (typeof parsed === "string") {
    return inferred({ tag: "text", value: parsed }, STR, inference);
  }
  if (typeof parsed === "boolean") {
    let name = "False";
    if (parsed) name = "True";
    return inferred({ tag: "tag", name, payload: null }, BOOL, inference);
  }
  if (isJsonNumber(parsed)) return jsonNumber(parsed.source, inference, span);
  if (Array.isArray(parsed)) {
    const elements = parsed.map((element) =>
      jsonValue(element, inference, span)
    );
    const value: Value = { tag: "array", elements };
    const elementTypes: Value[] = [];
    for (const element of elements) {
      const widened = inferredTypeOf(element);
      let elementType = element;
      if (widened !== undefined) elementType = widened;
      if (!elementTypes.some((seen) => equal(seen, elementType))) {
        elementTypes.push(elementType);
      }
    }
    return inferred(
      value,
      { tag: "array", elements: elementTypes },
      inference,
    );
  }
  if (typeof parsed === "object") {
    const fields = new Map<string, Value>();
    const fieldTypes = new Map<string, Value>();
    for (const [name, member] of Object.entries(parsed)) {
      const value = jsonValue(member, inference, span);
      fields.set(name, value);
      const widened = inferredTypeOf(value);
      if (widened === undefined) fieldTypes.set(name, value);
      else fieldTypes.set(name, widened);
    }
    return inferred(
      { tag: "shape", fields },
      { tag: "shape", fields: fieldTypes },
      inference,
    );
  }
  fail(
    "BLOT_JSON_PARSE",
    `JSON produced unsupported ${typeof parsed} value.`,
    span,
  );
}

function jsonNumber(
  source: string,
  inference: JsonInference,
  span: Span,
): Value {
  if (/^-?(?:0|[1-9][0-9]*)$/.test(source)) {
    return inferred({ tag: "int", value: BigInt(source) }, INT, inference);
  }
  const value = Number(source);
  if (!Number.isFinite(value)) {
    fail(
      "BLOT_JSON_NUMBER",
      `JSON number ${source} is outside finite F64.`,
      span,
    );
  }
  return inferred({ tag: "float", value }, F64, inference);
}

function inferred(value: Value, type: Value, inference: JsonInference): Value {
  if (inference === "exact") return value;
  return withInferredType(value, type);
}

function isJsonNumber(value: unknown): value is JsonNumber {
  return typeof value === "object" && value !== null && JSON_NUMBER in value;
}
