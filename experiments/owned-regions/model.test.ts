import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  backingId,
  bounds,
  claim,
  freeze,
  get,
  isLive,
  join,
  RegionModelError,
  set,
  split,
  swap,
} from "./model.ts";
import { quicksort } from "./quicksort.ts";

Deno.test("split is a zero-copy disjoint cover of one backing store", () => {
  const whole = claim([10, 20, 30, 40, 50]);
  const originalBacking = backingId(whole);
  const result = split(whole, 2);
  assertEquals(result.tag, "split");
  if (result.tag !== "split") return;

  assertEquals(backingId(result.left), originalBacking);
  assertEquals(backingId(result.right), originalBacking);
  assertEquals(bounds(result.left), { start: 0, end: 2, extent: 5 });
  assertEquals(bounds(result.right), { start: 2, end: 5, extent: 5 });

  const changed = set(result.left, 1, 99);
  assertEquals(changed.tag, "updated");
  if (changed.tag !== "updated") return;
  assertEquals(get(result.right, 0), 30);

  const rejoined = join(changed.region, result.right);
  assertEquals(rejoined.tag, "joined");
  if (rejoined.tag !== "joined") return;
  const frozen = freeze(rejoined.region);
  assertEquals(frozen.values, [10, 99, 30, 40, 50]);
  assertEquals(frozen.stats.storeAllocations, 1);
  assertEquals(frozen.stats.elementCopies, 0);
});

Deno.test("consumed parents cannot be observed after split", () => {
  const whole = claim([1, 2, 3]);
  const result = split(whole, 1);
  assertEquals(result.tag, "split");
  assert(!isLive(whole));
  assertThrows(
    () => get(whole, 0),
    RegionModelError,
    "REGION_USE_AFTER_CONSUME",
  );
  if (result.tag !== "split") return;
  const joined = join(result.left, result.right);
  assertEquals(joined.tag, "joined");
  if (joined.tag === "joined") freeze(joined.region);
});

Deno.test("a failed split conserves its input authority", () => {
  const whole = claim([1, 2, 3]);
  const result = split(whole, 4);
  assertEquals(result.tag, "out_of_bounds");
  if (result.tag !== "out_of_bounds") return;
  assertEquals(result.original, whole);
  assert(isLive(whole));
  assertEquals(freeze(whole).values, [1, 2, 3]);
});

Deno.test("a failed update conserves its input authority", () => {
  const whole = claim([1, 2, 3]);
  const result = set(whole, 3, 9);
  assertEquals(result.tag, "out_of_bounds");
  if (result.tag !== "out_of_bounds") return;
  assertEquals(result.original, whole);
  assert(isLive(whole));
  assertEquals(freeze(whole).values, [1, 2, 3]);
});

Deno.test("join requires same-origin adjacency and conserves failure inputs", () => {
  const whole = claim([0, 1, 2, 3, 4, 5]);
  const first = split(whole, 2);
  assertEquals(first.tag, "split");
  if (first.tag !== "split") return;
  const second = split(first.right, 2);
  assertEquals(second.tag, "split");
  if (second.tag !== "split") return;

  const gap = join(first.left, second.right);
  assertEquals(gap.tag, "not_adjacent");
  if (gap.tag === "joined") return;
  assert(isLive(gap.left));
  assert(isLive(gap.right));

  const tail = join(second.left, gap.right);
  assertEquals(tail.tag, "joined");
  if (tail.tag !== "joined") return;
  const restored = join(gap.left, tail.region);
  assertEquals(restored.tag, "joined");
  if (restored.tag === "joined") freeze(restored.region);
});

Deno.test("join refuses authorities from different stores without consuming", () => {
  const left = claim([1]);
  const right = claim([2]);
  const result = join(left, right);
  assertEquals(result.tag, "different_origin");
  if (result.tag === "joined") return;
  assert(isLive(result.left));
  assert(isLive(result.right));
  freeze(result.left);
  freeze(result.right);
});

Deno.test("endpoint split leaves an empty owner that must be rejoined before freeze", () => {
  const whole = claim([1, 2, 3]);
  const result = split(whole, 0);
  assertEquals(result.tag, "split");
  if (result.tag !== "split") return;
  assertEquals(bounds(result.left), { start: 0, end: 0, extent: 3 });
  assertEquals(bounds(result.right), { start: 0, end: 3, extent: 3 });

  assertThrows(
    () => freeze(result.right),
    RegionModelError,
    "REGION_FREEZE_ALIASES",
  );
  const restored = join(result.left, result.right);
  assertEquals(restored.tag, "joined");
  if (restored.tag === "joined") freeze(restored.region);
});

Deno.test("swap is destructive within one region and preserves the permit range", () => {
  const whole = claim([1, 2, 3, 4]);
  const result = swap(whole, 0, 3);
  assertEquals(result.tag, "updated");
  if (result.tag !== "updated") return;
  assertEquals(bounds(result.region), { start: 0, end: 4, extent: 4 });
  const frozen = freeze(result.region);
  assertEquals(frozen.values, [4, 2, 3, 1]);
  assertEquals(frozen.stats.swaps, 1);
  assertEquals(frozen.stats.elementCopies, 0);
});

Deno.test("quicksort sorts in one Store with no element copies from split/join", () => {
  const input = [38, 27, 43, 3, 9, 82, 10, 27];
  const whole = claim(input);
  const id = backingId(whole);
  const sorted = quicksort(whole);
  assertEquals(backingId(sorted), id);
  const frozen = freeze(sorted);
  assertEquals(frozen.values, [3, 9, 10, 27, 27, 38, 43, 82]);
  assertEquals(frozen.backingId, id);
  assertEquals(frozen.stats.storeAllocations, 1);
  assertEquals(frozen.stats.elementCopies, 0);
  assert(frozen.stats.splits > 0);
  assertEquals(frozen.stats.splits, frozen.stats.joins);
});

Deno.test("quicksort preserves the region invariants over generated inputs", () => {
  let state = 0x12345678;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const size = random() % 40;
    const values = Array.from(
      { length: size },
      () => Number(random() % 23) - 11,
    );
    const expected = [...values].sort((left, right) => left - right);
    const frozen = freeze(quicksort(claim(values)));
    assertEquals(frozen.values, expected, `trial ${trial}`);
    assertEquals(frozen.stats.storeAllocations, 1);
    assertEquals(frozen.stats.elementCopies, 0);
    assertEquals(frozen.stats.splits, frozen.stats.joins);
  }
});
