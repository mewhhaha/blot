import { assert, assertEquals } from "@std/assert";
import {
  type IntervalRegion,
  intervalAbsoluteIndex,
  intervalsDisjoint,
  isFullInterval,
  joinIntervals,
  pairwiseDisjointIntervals,
  sameInterval,
  splitInterval,
  validJoinCover,
  validSplitCover,
} from "../../src/linear/region_interval.ts";

const whole: IntervalRegion = {
  origin: 7,
  start: 0,
  end: 10,
  extent: 10,
};

Deno.test("interval split is a disjoint exact cover", () => {
  const result = splitInterval(whole, 4);
  assert(result.ok);
  if (!result.ok) return;
  assert(validSplitCover(whole, result.left, result.right));
  assert(intervalsDisjoint(result.left, result.right));
  assertEquals(result.left, { origin: 7, start: 0, end: 4, extent: 10 });
  assertEquals(result.right, { origin: 7, start: 4, end: 10, extent: 10 });
});

Deno.test("interval split failure returns the exact original region", () => {
  const result = splitInterval(whole, 11);
  assert(!result.ok);
  if (result.ok) return;
  assertEquals(result.original, whole);
});

Deno.test("ordered join is the inverse cover of split", () => {
  const result = splitInterval(whole, 6);
  assert(result.ok);
  if (!result.ok) return;
  const joined = joinIntervals(result.left, result.right);
  assert(joined.ok);
  if (!joined.ok) return;
  assert(validJoinCover(result.left, result.right, joined.region));
  assert(sameInterval(joined.region, whole));
});

Deno.test("nested joins may reassociate without a split-tree identity", () => {
  const first = splitInterval(whole, 2);
  assert(first.ok);
  if (!first.ok) return;
  const second = splitInterval(first.right, 3);
  assert(second.ok);
  if (!second.ok) return;

  const rightAssociated = joinIntervals(second.left, second.right);
  assert(rightAssociated.ok);
  if (!rightAssociated.ok) return;
  const restored = joinIntervals(first.left, rightAssociated.region);
  assert(restored.ok);
  if (!restored.ok) return;
  assert(sameInterval(restored.region, whole));
});

Deno.test("join refuses a gap", () => {
  const left: IntervalRegion = { origin: 1, start: 0, end: 2, extent: 8 };
  const right: IntervalRegion = { origin: 1, start: 3, end: 8, extent: 8 };
  const result = joinIntervals(left, right);
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "not_adjacent");
});

Deno.test("relative indexing cannot escape the interval", () => {
  const region: IntervalRegion = { origin: 1, start: 4, end: 7, extent: 10 };
  assertEquals(intervalAbsoluteIndex(region, 0), 4);
  assertEquals(intervalAbsoluteIndex(region, 2), 6);
  assertEquals(intervalAbsoluteIndex(region, 3), null);
  assertEquals(intervalAbsoluteIndex(region, -1), null);
});

Deno.test("endpoint splits produce safe empty regions", () => {
  const result = splitInterval(whole, 0);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.left.start, result.left.end);
  assert(intervalsDisjoint(result.left, result.right));
  assert(pairwiseDisjointIntervals([result.left, result.right]));
});

Deno.test("only the complete extent is a full interval", () => {
  assert(isFullInterval(whole));
  assert(!isFullInterval({ ...whole, start: 1 }));
  assert(!isFullInterval({ ...whole, end: 9 }));
});
