import type { Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import { type Primitive, PRIMITIVES } from "./primitives.ts";
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
    "@region.array.type",
    {
      arity: 1,
      run: ([element]) => ({ tag: "region-type", element }),
    },
  ],
  [
    "@region.array.claim",
    {
      arity: 1,
      run: ([array], span) => {
        if (array.tag !== "array") {
          fail(
            "BLOT_TYPE",
            `@region.array.claim expects an array, found ${show(array)}.`,
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
    "@region.array.length",
    {
      arity: 1,
      run: ([value], span) => {
        const region = regionOf(value, span, "@region.array.length");
        return { tag: "int", value: BigInt(region.end - region.start) };
      },
    },
  ],
  [
    "@region.array.get",
    {
      arity: 2,
      run: ([value, index], span) => {
        const region = regionOf(value, span, "@region.array.get");
        const absolute = relativeIndex(
          region,
          index,
          span,
          "@region.array.get",
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
    "@region.array.set",
    {
      arity: 3,
      run: ([value, index, replacement], span) => {
        const region = regionOf(value, span, "@region.array.set");
        const absolute = relativeIndex(
          region,
          index,
          span,
          "@region.array.set",
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
    "@region.array.swap",
    {
      arity: 3,
      run: ([value, left, right], span) => {
        const region = regionOf(value, span, "@region.array.swap");
        const leftIndex = relativeIndex(
          region,
          left,
          span,
          "@region.array.swap",
        );
        const rightIndex = relativeIndex(
          region,
          right,
          span,
          "@region.array.swap",
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
    "@region.array.split",
    {
      arity: 2,
      run: ([value, at], span) => {
        const region = regionOf(value, span, "@region.array.split");
        const offset = indexOf(at, span, "@region.array.split");
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
          ]),
        };
      },
    },
  ],
  [
    "@region.array.join",
    {
      arity: 2,
      run: ([leftValue, rightValue], span) => {
        const left = regionOf(leftValue, span, "@region.array.join");
        const right = regionOf(rightValue, span, "@region.array.join");
        if (left.store !== right.store || left.end !== right.start) {
          fail(
            "BLOT_REGION_JOIN_UNPROVED",
            "Region join requires adjacent slices produced from one backing Store.",
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
    "@region.array.freeze",
    {
      arity: 1,
      run: ([value], span) => {
        const region = regionOf(value, span, "@region.array.freeze");
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
