import { assertEquals } from "@std/assert";
import {
  type RegionAuthorityCertificate,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";

Deno.test("one Store uniqueness root cannot be claimed twice", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        root: "store-root:4",
        origin: 4,
        family: "array-interval-v1",
        permit: 0,
        operation: "first claim",
      },
      {
        tag: "claim",
        root: "store-root:4",
        origin: 5,
        family: "array-interval-v1",
        permit: 1,
        operation: "forged second claim of same allocation",
      },
    ],
  };
  assertEquals(
    verifyRegionAuthorityCertificate(
      certificate,
      new Set(["store-root:4"]),
      true,
    ),
    null,
  );
});

Deno.test("one origin generation cannot be claimed twice", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        root: "store-root:a",
        origin: 4,
        family: "array-interval-v1",
        permit: 0,
        operation: "first claim",
      },
      {
        tag: "claim",
        root: "store-root:b",
        origin: 4,
        family: "array-interval-v1",
        permit: 1,
        operation: "forged reused origin",
      },
    ],
  };
  assertEquals(
    verifyRegionAuthorityCertificate(
      certificate,
      new Set(["store-root:a", "store-root:b"]),
      true,
    ),
    null,
  );
});
