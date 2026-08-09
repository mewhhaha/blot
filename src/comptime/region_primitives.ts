import type { Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import { type Primitive, PRIMITIVE_VALUES, PRIMITIVES } from "./primitives.ts";
import { show, tupleOf, type Value } from "./value.ts";

function regionOf(
  value: Value,
  span: Span,
  operation: string,
): Extract<Value, { tag: "region-array" }> {
  if (value.tag !== "region-array") {
    fail(
      "BLOT_TYPE",
      `${operation} expects an owned region, found ${show(value)}.`,
      span,
    );
  }
  return value;
}

function indexOf(value: Value, span: Span, operation: string): number {
  if (value.tag !== "int") {
    fail(
      "BLOT_TYPE",
      `${operation} expects an integer index, found ${show(value)}.`,
      span,
    );
  }
  const index = Number(value.value);
  if (!Number.isSafeInteger(index)) {
    fail("BLOT_ARRAY_BOUNDS", `${operation} index is not representable.`, span);
  }
  return index;
}

function relativeIndex(
  region: Extract<Value, { tag: "region-array" }>,
  value: Value,
  span: Span,
  operation: string,
): number | null {
  const relative = indexOf(value, span, operation);
  if (relative < 0 || relative >= region.end - region.start) return null;
  return region.start + relative;
}

const entries: readonly (readonly [string, Primitive])[] = [
  [
    "@region.type",
    {
      arity: 1,
      run: ([element]) => ({ tag: "region-type", element }),
    },
  ],
  [
    "@region.claim",
    {
      arity: 1,
      run: ([array], span) => {
        if (array.tag !== "array") {
          fail(
            "BLOT_TYPE",
            `@region.claim expects an array, found ${show(array)}.`,
            span,
          );
        }
        const cells = [...array.elements];
        return {
          tag: "region-array",
          store: { cells },
          start: 0,
          end: cells.length,
        };
      },
    },
  ],
  [
    "@region.length",
    {
      arity: 1,
      run: ([value], span) => {
        const region = regionOf(value, span, "@region.length");
        return { tag: "int", value: BigInt(region.end - region.start) };
      },
    },
  ],
  [
    "@region.get",
    {
      arity: 2,
      run: ([value, index], span) => {
        const region = regionOf(value, span, "@region.get");
        const absolute = relativeIndex(
          region,
          index,
          span,
          "@region.get",
        );
        if (absolute === null) {
          return { tag: "tag", name: "None", payload: null };
        }
        return {
          tag: "tag",
          name: "Some",
          payload: region.store.cells[absolute],
        };
      },
    },
  ],
  [
    "@region.set",
    {
      arity: 3,
      run: ([value, index, replacement], span) => {
        const region = regionOf(value, span, "@region.set");
        const absolute = relativeIndex(
          region,
          index,
          span,
          "@region.set",
        );
        if (absolute === null) {
          return {
            tag: "tag",
            name: "SetOutOfBounds",
            payload: region,
          };
        }
        region.store.cells[absolute] = replacement;
        return { tag: "tag", name: "Updated", payload: region };
      },
    },
  ],
  [
    "@region.swap",
    {
      arity: 3,
      run: ([value, left, right], span) => {
        const region = regionOf(value, span, "@region.swap");
        const leftIndex = relativeIndex(
          region,
          left,
          span,
          "@region.swap",
        );
        const rightIndex = relativeIndex(
          region,
          right,
          span,
          "@region.swap",
        );
        if (leftIndex === null || rightIndex === null) {
          return {
            tag: "tag",
            name: "SwapOutOfBounds",
            payload: region,
          };
        }
        const held = region.store.cells[leftIndex];
        region.store.cells[leftIndex] = region.store.cells[rightIndex];
        region.store.cells[rightIndex] = held;
        return { tag: "tag", name: "Updated", payload: region };
      },
    },
  ],
  [
    "@region.split",
    {
      arity: 2,
      run: ([value, at], span) => {
        const region = regionOf(value, span, "@region.split");
        const offset = indexOf(at, span, "@region.split");
        const length = region.end - region.start;
        if (offset < 0 || offset > length) {
          return { tag: "tag", name: "SplitOutOfBounds", payload: region };
        }
        const middle = region.start + offset;
        return {
          tag: "tag",
          name: "Split",
          payload: tupleOf([
            {
              tag: "region-array",
              store: region.store,
              start: region.start,
              end: middle,
            },
            {
              tag: "region-array",
              store: region.store,
              start: middle,
              end: region.end,
            },
            {
              tag: "region-rejoin",
              store: region.store,
              start: region.start,
              middle,
              end: region.end,
            },
          ]),
        };
      },
    },
  ],
  [
    "@region.join",
    {
      arity: 3,
      run: ([witnessValue, leftValue, rightValue], span) => {
        if (witnessValue.tag !== "region-rejoin") {
          fail(
            "BLOT_TYPE",
            `@region.join expects a rejoin witness, found ${
              show(witnessValue)
            }.`,
            span,
          );
        }
        const left = regionOf(leftValue, span, "@region.join");
        const right = regionOf(rightValue, span, "@region.join");
        const paired = witnessValue.store === left.store &&
          witnessValue.store === right.store &&
          witnessValue.start === left.start &&
          witnessValue.middle === left.end &&
          witnessValue.middle === right.start &&
          witnessValue.end === right.end;
        if (!paired) {
          fail(
            "BLOT_REGION_JOIN_UNPROVED",
            "Region join requires the witness minted with these two parts.",
            span,
          );
        }
        return {
          tag: "region-array",
          store: left.store,
          start: left.start,
          end: right.end,
        };
      },
    },
  ],
  [
    "@region.freeze",
    {
      arity: 1,
      run: ([value], span) => {
        const region = regionOf(value, span, "@region.freeze");
        if (region.start !== 0 || region.end !== region.store.cells.length) {
          fail(
            "BLOT_REGION_PARTIAL_FREEZE",
            "Only the complete root region can be frozen.",
            span,
          );
        }
        return { tag: "array", elements: [...region.store.cells] };
      },
    },
  ],
];

const table = PRIMITIVES as Map<string, Primitive>;
for (const [name, primitive] of entries) table.set(name, primitive);

// The witness type is opaque and element-free; its pairing lives in the
// ownership analysis, never in the type lattice.
const values = PRIMITIVE_VALUES as Map<string, Value>;
values.set("@region.rejoin", { tag: "opaque-type", name: "Rejoin" });
