import type { Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import { show, type Value } from "./value.ts";

export interface Primitive {
  readonly arity: number;
  readonly run: (
    args: readonly Value[],
    span: Span,
    phase: "comptime" | "runtime",
  ) => Value;
}

export const I64_LOW = -0x8000000000000000n;
export const I64_HIGH = 0x7fffffffffffffffn;

export function integerResult(
  value: bigint,
  span: Span,
  operation: string,
  phase: "comptime" | "runtime",
): Value {
  if (phase === "runtime" && (value < I64_LOW || value > I64_HIGH)) {
    fail(
      "BLOT_INTEGER_OVERFLOW",
      `${operation} produced ${value}, outside signed i64 ${I64_LOW}..${I64_HIGH}.`,
      span,
    );
  }
  return { tag: "int", value };
}

export function intOf(value: Value, span: Span, what: string): bigint {
  if (value.tag !== "int") {
    fail(
      "BLOT_TYPE",
      `${what} expects an integer, found ${show(value)}.`,
      span,
    );
  }
  return value.value;
}

export function floatOf(value: Value, span: Span, what: string): number {
  if (value.tag !== "float") {
    fail("BLOT_TYPE", `${what} expects a float, found ${show(value)}.`, span);
  }
  return value.value;
}

/**
 * Rounds on the way in and on the way out, so an `f32` value in the
 * interpreter is bit-for-bit the one the emitted module holds. Doing it once
 * at construction is what keeps a sequence of operations from drifting: every
 * intermediate is a real f32 rather than a double that happens to have started
 * as one.
 */
export function float32(value: number): Value {
  return { tag: "float32", value: Math.fround(value) };
}

export function float32Of(value: Value, span: Span, what: string): number {
  if (value.tag !== "float32") {
    fail(
      "BLOT_TYPE",
      `${what} expects an F32, found ${show(value)}.`,
      span,
    );
  }
  return value.value;
}

export function textOf(value: Value, span: Span, what: string): string {
  if (value.tag !== "text") {
    fail("BLOT_TYPE", `${what} expects text, found ${show(value)}.`, span);
  }
  return value.value;
}

export function shapeFields(
  value: Value,
  span: Span,
  what: string,
): ReadonlyMap<string, Value> {
  if (value.tag !== "shape") {
    fail("BLOT_TYPE", `${what} expects a shape, found ${show(value)}.`, span);
  }
  return value.fields;
}

export function arrayElements(
  value: Value,
  span: Span,
  what: string,
): readonly Value[] {
  if (value.tag !== "array") {
    fail("BLOT_TYPE", `${what} expects an array, found ${show(value)}.`, span);
  }
  return value.elements;
}
