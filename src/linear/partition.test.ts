import { assertEquals } from "@std/assert";
import type { PartitionAlgebra, PartitionWitness } from "./partition.ts";
import { combinePartition, reassociatePartition } from "./partition.ts";

interface Interval {
  readonly root: string;
  readonly low: number;
  readonly high: number;
}

const INTERVALS: PartitionAlgebra<string, Interval> = {
  sameFamily: (left, right) => left === right,
  samePart: (left, right) =>
    left.root === right.root && left.low === right.low &&
    left.high === right.high,
  compose: (_family, left, right) => {
    if (left.root !== right.root || left.high !== right.low) return null;
    return { root: left.root, low: left.low, high: right.high };
  },
};

function interval(
  root: string,
  low: number,
  high: number,
): Interval {
  return { root, low, high };
}

function witness<Part>(
  family: string,
  parent: Part,
  left: Part,
  right: Part,
): PartitionWitness<string, Part> {
  return { family, parent, left, right };
}

Deno.test("partition witnesses combine only their exact children", () => {
  const whole = interval("store", 0, 12);
  const left = interval("store", 0, 4);
  const right = interval("store", 4, 12);
  const proof = witness("array-interval", whole, left, right);
  assertEquals(
    combinePartition(INTERVALS, "array-interval", proof, left, right),
    { ok: true, value: whole },
  );
  assertEquals(
    combinePartition(INTERVALS, "array-interval", proof, right, left),
    { ok: false, error: "left-mismatch" },
  );
});

Deno.test("partition reassociation is an inverse proof-tree rotation", () => {
  const a = interval("store", 0, 4);
  const b = interval("store", 4, 8);
  const c = interval("store", 8, 12);
  const bc = interval("store", 4, 12);
  const abc = interval("store", 0, 12);
  const outer = witness("array-interval", abc, a, bc);
  const inner = witness("array-interval", bc, b, c);
  const rotated = reassociatePartition(INTERVALS, "left", outer, inner);
  if (!rotated.ok) throw new Error(rotated.error);
  const restored = reassociatePartition(
    INTERVALS,
    "right",
    rotated.value[0],
    rotated.value[1],
  );
  assertEquals(restored, { ok: true, value: [outer, inner] });
});

Deno.test("bounded intervals satisfy unit, associativity, and coherence", () => {
  const family = "array-interval";
  const root = "bounded-store";
  for (let low = 0; low <= 4; low += 1) {
    for (let high = low; high <= 4; high += 1) {
      const part = interval(root, low, high);
      assertEquals(
        INTERVALS.compose(family, interval(root, low, low), part),
        part,
      );
      assertEquals(
        INTERVALS.compose(family, part, interval(root, high, high)),
        part,
      );
    }
  }

  for (let a = 0; a <= 4; a += 1) {
    for (let b = a; b <= 4; b += 1) {
      for (let c = b; c <= 4; c += 1) {
        for (let d = c; d <= 4; d += 1) {
          const first = interval(root, a, b);
          const second = interval(root, b, c);
          const third = interval(root, c, d);
          const firstSecond = INTERVALS.compose(family, first, second);
          const secondThird = INTERVALS.compose(family, second, third);
          if (firstSecond === null || secondThird === null) {
            throw new Error("adjacent intervals must compose");
          }
          assertEquals(
            INTERVALS.compose(family, firstSecond, third),
            INTERVALS.compose(family, first, secondThird),
          );

          const whole = interval(root, a, d);
          const outer = witness(family, whole, first, secondThird);
          const inner = witness(family, secondThird, second, third);
          const rotated = reassociatePartition(
            INTERVALS,
            "left",
            outer,
            inner,
          );
          if (!rotated.ok) throw new Error(rotated.error);
          assertEquals(
            reassociatePartition(
              INTERVALS,
              "right",
              rotated.value[0],
              rotated.value[1],
            ),
            { ok: true, value: [outer, inner] },
          );
        }
      }
    }
  }
});

Deno.test("interval composition refuses gaps and foreign roots", () => {
  const family = "array-interval";
  assertEquals(
    INTERVALS.compose(
      family,
      interval("store", 0, 1),
      interval("store", 2, 3),
    ),
    null,
  );
  assertEquals(
    INTERVALS.compose(
      family,
      interval("left-store", 0, 1),
      interval("right-store", 1, 2),
    ),
    null,
  );
});

interface KeySet {
  readonly root: string;
  readonly keys: readonly string[];
}

const KEY_SETS: PartitionAlgebra<string, KeySet> = {
  sameFamily: (left, right) => left === right,
  samePart: (left, right) =>
    left.root === right.root && left.keys.length === right.keys.length &&
    left.keys.every((key, index) => key === right.keys[index]),
  compose: (_family, left, right) => {
    if (left.root !== right.root) return null;
    if (left.keys.some((key) => right.keys.includes(key))) return null;
    return {
      root: left.root,
      keys: [...left.keys, ...right.keys].sort(),
    };
  },
};

Deno.test("the same witness core composes disjoint map key sets", () => {
  const a: KeySet = { root: "map", keys: ["a"] };
  const b: KeySet = { root: "map", keys: ["b"] };
  const c: KeySet = { root: "map", keys: ["c"] };
  const bc: KeySet = { root: "map", keys: ["b", "c"] };
  const abc: KeySet = { root: "map", keys: ["a", "b", "c"] };
  const outer = witness("map-key-set", abc, a, bc);
  const inner = witness("map-key-set", bc, b, c);
  const rotated = reassociatePartition(KEY_SETS, "left", outer, inner);
  assertEquals(rotated, {
    ok: true,
    value: [
      witness("map-key-set", abc, { root: "map", keys: ["a", "b"] }, c),
      witness("map-key-set", { root: "map", keys: ["a", "b"] }, a, b),
    ],
  });
});

Deno.test("family identity blocks structurally equal foreign proofs", () => {
  const a = interval("root", 0, 1);
  const b = interval("root", 1, 2);
  const ab = interval("root", 0, 2);
  const proof = witness("list-segment", ab, a, b);
  assertEquals(
    combinePartition(INTERVALS, "array-interval", proof, a, b),
    { ok: false, error: "family-mismatch" },
  );
});

Deno.test("reassociation refuses a non-child inner witness", () => {
  const a = interval("store", 0, 2);
  const bc = interval("store", 2, 6);
  const abc = interval("store", 0, 6);
  const foreign = interval("store", 8, 12);
  const outer = witness("array-interval", abc, a, bc);
  const inner = witness(
    "array-interval",
    foreign,
    interval("store", 8, 10),
    interval("store", 10, 12),
  );
  assertEquals(reassociatePartition(INTERVALS, "left", outer, inner), {
    ok: false,
    error: "inner-parent-mismatch",
  });
});
