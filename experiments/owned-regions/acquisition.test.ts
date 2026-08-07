import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  backingId,
  claim,
  claimOwned,
  freeze,
  freshOwned,
  isOwnedLive,
  ownedBackingId,
  RegionModelError,
} from "./model.ts";
import { quicksort } from "./quicksort.ts";

Deno.test("shared acquisition copies once then sorts without further copies", () => {
  const source = [4, 1, 3, 2];
  const frozen = freeze(quicksort(claim(source)));

  assertEquals(source, [4, 1, 3, 2]);
  assertEquals(frozen.values, [1, 2, 3, 4]);
  assertEquals(frozen.stats.storeAllocations, 1);
  assertEquals(frozen.stats.acquisitionCopies, source.length);
  assertEquals(frozen.stats.elementCopies, 0);
});

Deno.test("unique acquisition transfers the exact Store without copying", () => {
  const owned = freshOwned([4, 1, 3, 2]);
  const sourceBacking = ownedBackingId(owned);
  const slice = claimOwned(owned);

  assert(!isOwnedLive(owned));
  assertEquals(backingId(slice), sourceBacking);

  const frozen = freeze(quicksort(slice));
  assertEquals(frozen.backingId, sourceBacking);
  assertEquals(frozen.values, [1, 2, 3, 4]);
  assertEquals(frozen.stats.storeAllocations, 1);
  assertEquals(frozen.stats.acquisitionCopies, 0);
  assertEquals(frozen.stats.elementCopies, 0);
});

Deno.test("a unique Store root can enter region authority only once", () => {
  const owned = freshOwned([1, 2, 3]);
  const slice = claimOwned(owned);

  assertThrows(
    () => claimOwned(owned),
    RegionModelError,
    "REGION_STORE_ROOT_CONSUMED",
  );

  const frozen = freeze(slice);
  assert(frozen.authorityVerified);
});
