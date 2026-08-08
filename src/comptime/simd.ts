import type { Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import { show, type Value } from "./value.ts";
import { intOf, type Primitive } from "./coerce.ts";

export function do_splat(lane: number): Value {
  return { tag: "vector", element: "f32", lanes: [lane, lane, lane, lane] };
}

export function vectorOf(
  value: Value,
  span: Span,
  what: string,
): readonly number[] {
  if (value.tag !== "vector" || value.element !== "f32") {
    fail("BLOT_TYPE", `${what} expects an F32x4, found ${show(value)}.`, span);
  }
  return value.lanes;
}

export function vectorMaskOf(
  value: Value,
  span: Span,
  what: string,
): readonly boolean[] {
  if (value.tag !== "vector-mask" || value.element !== "f32") {
    fail(
      "BLOT_TYPE",
      `${what} expects an F32x4Mask, found ${show(value)}.`,
      span,
    );
  }
  return value.lanes;
}

/** Lane-wise, rounding each result the way one f32 lane does. */
export function lanewise(
  left: readonly number[],
  right: readonly number[],
  step: (a: number, b: number) => number,
): Value {
  return {
    tag: "vector",
    element: "f32",
    lanes: left.map((lane, index) => Math.fround(step(lane, right[index]))),
  };
}

export type PrimitiveEntry = readonly [string, Primitive];

function simdVector(
  element: "f32" | "i32" | "i16" | "i8",
  lanes: readonly number[],
): Value {
  return { tag: "vector", element, lanes };
}

function simdMask(
  element: "f32" | "i32" | "i16" | "i8",
  lanes: readonly boolean[],
): Value {
  return { tag: "vector-mask", element, lanes };
}

function simdLanes(
  value: Value,
  element: "f32" | "i32" | "i16" | "i8",
  span: Span,
  operation: string,
): readonly number[] {
  if (value.tag === "vector" && value.element === element) return value.lanes;
  fail(
    "BLOT_TYPE",
    `${operation} expects an ${simdName(element)}, found ${show(value)}.`,
    span,
  );
}

function simdMaskLanes(
  value: Value,
  element: "f32" | "i32" | "i16" | "i8",
  span: Span,
  operation: string,
): readonly boolean[] {
  if (value.tag === "vector-mask" && value.element === element) {
    return value.lanes;
  }
  fail(
    "BLOT_TYPE",
    `${operation} expects an ${simdName(element)}Mask, found ${show(value)}.`,
    span,
  );
}

function simdName(element: "f32" | "i32" | "i16" | "i8"): string {
  if (element === "f32") return "F32x4";
  if (element === "i32") return "I32x4";
  if (element === "i16") return "I16x8";
  return "I8x16";
}

function integerLane(value: Value, span: Span, operation: string): number {
  const lane = intOf(value, span, operation);
  return Number(BigInt.asIntN(32, lane));
}

function wrapLane(value: number, bits: 8 | 16 | 32): number {
  if (bits === 32) return value | 0;
  if (bits === 16) return (value << 16) >> 16;
  return (value << 24) >> 24;
}

function unsignedLane(value: number, bits: 8 | 16 | 32): number {
  if (bits === 32) return value >>> 0;
  if (bits === 16) return value & 0xffff;
  return value & 0xff;
}

function maskReductionEntries(
  prefix: string,
  element: "f32" | "i32" | "i16" | "i8",
): PrimitiveEntry[] {
  return [
    [`@${prefix}.mask_bitmask`, {
      arity: 1,
      run: ([value], span) => {
        const lanes = simdMaskLanes(
          value,
          element,
          span,
          `@${prefix}.mask_bitmask`,
        );
        let mask = 0n;
        lanes.forEach((lane, index) => {
          if (lane) mask |= 1n << BigInt(index);
        });
        return { tag: "int", value: mask };
      },
    }],
    [`@${prefix}.mask_all`, {
      arity: 1,
      run: ([value], span) => {
        const lanes = simdMaskLanes(
          value,
          element,
          span,
          `@${prefix}.mask_all`,
        );
        let result = 0n;
        if (lanes.every(Boolean)) result = 1n;
        return { tag: "int", value: result };
      },
    }],
    [`@${prefix}.mask_any`, {
      arity: 1,
      run: ([value], span) => {
        const lanes = simdMaskLanes(
          value,
          element,
          span,
          `@${prefix}.mask_any`,
        );
        let result = 0n;
        if (lanes.some(Boolean)) result = 1n;
        return { tag: "int", value: result };
      },
    }],
  ];
}

function integerSimdEntries(
  prefix: "i32x4" | "i16x8" | "i8x16",
  element: "i32" | "i16" | "i8",
  bits: 8 | 16 | 32,
  lanes: 4 | 8 | 16,
  multiply: boolean,
  extendedComparisons: boolean,
): PrimitiveEntry[] {
  const unary = (
    name: string,
    apply: (lane: number) => number,
  ): PrimitiveEntry => [
    `@${prefix}.${name}`,
    {
      arity: 1,
      run: ([value], span) =>
        simdVector(
          element,
          simdLanes(value, element, span, `@${prefix}.${name}`).map((lane) =>
            wrapLane(apply(lane), bits)
          ),
        ),
    },
  ];
  const binary = (
    name: string,
    apply: (left: number, right: number) => number,
  ): PrimitiveEntry => [
    `@${prefix}.${name}`,
    {
      arity: 2,
      run: ([left, right], span) => {
        const leftLanes = simdLanes(left, element, span, `@${prefix}.${name}`);
        const rightLanes = simdLanes(
          right,
          element,
          span,
          `@${prefix}.${name}`,
        );
        return simdVector(
          element,
          leftLanes.map((lane, index) =>
            wrapLane(apply(lane, rightLanes[index]), bits)
          ),
        );
      },
    },
  ];
  const compare = (
    name: string,
    apply: (left: number, right: number) => boolean,
  ): PrimitiveEntry => [
    `@${prefix}.${name}`,
    {
      arity: 2,
      run: ([left, right], span) => {
        const leftLanes = simdLanes(left, element, span, `@${prefix}.${name}`);
        const rightLanes = simdLanes(
          right,
          element,
          span,
          `@${prefix}.${name}`,
        );
        return simdMask(
          element,
          leftLanes.map((lane, index) => apply(lane, rightLanes[index])),
        );
      },
    },
  ];
  const entries: PrimitiveEntry[] = [
    [`@${prefix}.splat`, {
      arity: 1,
      run: ([value], span) =>
        simdVector(
          element,
          Array.from({ length: lanes }, () =>
            wrapLane(integerLane(value, span, `@${prefix}.splat`), bits)),
        ),
    }],
    binary("add", (left, right) => left + right),
    binary("sub", (left, right) => left - right),
    binary("and", (left, right) => left & right),
    binary("or", (left, right) => left | right),
    binary("xor", (left, right) => left ^ right),
    unary("not", (lane) => ~lane),
    binary("min_s", Math.min),
    binary("max_s", Math.max),
    binary("min_u", (left, right) => {
      if (unsignedLane(left, bits) < unsignedLane(right, bits)) return left;
      return right;
    }),
    binary("max_u", (left, right) => {
      if (unsignedLane(left, bits) > unsignedLane(right, bits)) return left;
      return right;
    }),
    compare("eq", (left, right) => left === right),
    compare("lt_s", (left, right) => left < right),
    compare(
      "lt_u",
      (left, right) => unsignedLane(left, bits) < unsignedLane(right, bits),
    ),
    [`@${prefix}.shl`, {
      arity: 2,
      run: ([value, amount], span) => {
        const shift = integerLane(amount, span, `@${prefix}.shl`) & (bits - 1);
        return simdVector(
          element,
          simdLanes(value, element, span, `@${prefix}.shl`).map(
            (lane) => wrapLane(lane << shift, bits),
          ),
        );
      },
    }],
    [`@${prefix}.shr_s`, {
      arity: 2,
      run: ([value, amount], span) => {
        const shift = integerLane(amount, span, `@${prefix}.shr_s`) &
          (bits - 1);
        return simdVector(
          element,
          simdLanes(value, element, span, `@${prefix}.shr_s`).map(
            (lane) => wrapLane(lane >> shift, bits),
          ),
        );
      },
    }],
    [`@${prefix}.shr_u`, {
      arity: 2,
      run: ([value, amount], span) => {
        const shift = integerLane(amount, span, `@${prefix}.shr_u`) &
          (bits - 1);
        return simdVector(
          element,
          simdLanes(value, element, span, `@${prefix}.shr_u`).map(
            (lane) => wrapLane(unsignedLane(lane, bits) >>> shift, bits),
          ),
        );
      },
    }],
    [`@${prefix}.select`, {
      arity: 3,
      run: ([mask, whenTrue, whenFalse], span) => {
        const selected = simdMaskLanes(
          mask,
          element,
          span,
          `@${prefix}.select`,
        );
        const trueLanes = simdLanes(
          whenTrue,
          element,
          span,
          `@${prefix}.select`,
        );
        const falseLanes = simdLanes(
          whenFalse,
          element,
          span,
          `@${prefix}.select`,
        );
        return simdVector(
          element,
          selected.map((lane, index) => {
            if (lane) return trueLanes[index];
            return falseLanes[index];
          }),
        );
      },
    }],
    ...maskReductionEntries(prefix, element),
  ];
  if (multiply) entries.push(binary("mul", (left, right) => left * right));
  if (extendedComparisons) {
    entries.push(
      compare("ne", (left, right) => left !== right),
      compare("gt_s", (left, right) => left > right),
      compare(
        "gt_u",
        (left, right) => unsignedLane(left, bits) > unsignedLane(right, bits),
      ),
      compare("le_s", (left, right) => left <= right),
      compare(
        "le_u",
        (left, right) => unsignedLane(left, bits) <= unsignedLane(right, bits),
      ),
      compare("ge_s", (left, right) => left >= right),
      compare(
        "ge_u",
        (left, right) => unsignedLane(left, bits) >= unsignedLane(right, bits),
      ),
    );
  }
  if (prefix === "i32x4") {
    entries.push(
      ["@i32x4.of", {
        arity: 4,
        run: (values, span) =>
          simdVector(
            "i32",
            values.map((value) => integerLane(value, span, "@i32x4.of")),
          ),
      }],
      ["@i32x4.of_wrapping", {
        arity: 4,
        run: (values, span) =>
          simdVector(
            "i32",
            values.map((value) =>
              integerLane(value, span, "@i32x4.of_wrapping")
            ),
          ),
      }],
      ["@i32x4.lane", {
        arity: 2,
        run: ([value, selector], span) => {
          const lane = Number(intOf(selector, span, "@i32x4.lane"));
          if (!Number.isSafeInteger(lane) || lane < 0 || lane > 3) {
            fail(
              "BLOT_SIMD_IMMEDIATE_RANGE",
              `I32x4 lane ${lane} is outside 0..3.`,
              span,
            );
          }
          return {
            tag: "int",
            value: BigInt(simdLanes(value, "i32", span, "@i32x4.lane")[lane]),
          };
        },
      }],
      ...[0, 1, 2, 3].map((lane): PrimitiveEntry => [
        `@i32x4.lane${lane}`,
        {
          arity: 1,
          run: ([value], span) => ({
            tag: "int",
            value: BigInt(
              simdLanes(value, "i32", span, `@i32x4.lane${lane}`)[lane],
            ),
          }),
        },
      ]),
      ...[0, 1, 2, 3].map((lane): PrimitiveEntry => [
        `@i32x4.with_lane${lane}`,
        {
          arity: 2,
          run: ([value, replacement], span) => {
            const result = [
              ...simdLanes(value, "i32", span, `@i32x4.with_lane${lane}`),
            ];
            result[lane] = integerLane(
              replacement,
              span,
              `@i32x4.with_lane${lane}`,
            );
            return simdVector("i32", result);
          },
        },
      ]),
      ...[0, 1, 2, 3].map((lane): PrimitiveEntry => [
        `@i32x4.with_lane${lane}_wrapping`,
        {
          arity: 2,
          run: ([value, replacement], span) => {
            const result = [
              ...simdLanes(
                value,
                "i32",
                span,
                `@i32x4.with_lane${lane}_wrapping`,
              ),
            ];
            result[lane] = integerLane(
              replacement,
              span,
              `@i32x4.with_lane${lane}_wrapping`,
            );
            return simdVector("i32", result);
          },
        },
      ]),
    );
  }
  return entries;
}

export function additionalSimdEntries(): PrimitiveEntry[] {
  const entries: PrimitiveEntry[] = [
    ...integerSimdEntries("i32x4", "i32", 32, 4, true, true),
    ...integerSimdEntries("i16x8", "i16", 16, 8, true, true),
    ...integerSimdEntries("i8x16", "i8", 8, 16, false, true),
  ];
  for (const prefix of ["i32x4", "i16x8", "i8x16"] as const) {
    const splat = entries.find(([name]) => name === `@${prefix}.splat`);
    if (splat === undefined) throw new Error(`missing @${prefix}.splat`);
    entries.push([`@${prefix}.splat_wrapping`, splat[1]]);
  }
  return entries;
}
