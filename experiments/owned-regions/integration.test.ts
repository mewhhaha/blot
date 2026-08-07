import { assert, assertEquals } from "@std/assert";
import { claim, freeze } from "./model.ts";
import { quicksort } from "./quicksort.ts";
import { verifyRegionAuthorityCertificate } from "../../src/linear/region_certificate.ts";

Deno.test("quicksort runtime invariant and compiler authority graph agree", () => {
  const frozen = freeze(quicksort(claim([9, 4, 7, 3, 8, 2, 6, 1, 5])));
  assertEquals(frozen.values, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert(frozen.authorityVerified);
  assert(
    verifyRegionAuthorityCertificate(frozen.authorityCertificate) !== null,
  );
  assertEquals(frozen.stats.storeAllocations, 1);
  assertEquals(frozen.stats.elementCopies, 0);
});
