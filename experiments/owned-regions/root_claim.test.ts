import { assertEquals } from "@std/assert";
import {
  type RegionAuthorityCertificate,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";

Deno.test("one origin generation cannot be claimed twice", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        origin: 4,
        family: "array-interval-v1",
        permit: 0,
        operation: "first claim",
      },
      {
        tag: "claim",
        origin: 4,
        family: "array-interval-v1",
        permit: 1,
        operation: "forged second claim",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate, true), null);
});
