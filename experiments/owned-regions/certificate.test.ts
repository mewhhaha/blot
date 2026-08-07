import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type RegionAuthorityCertificate,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";

const valid: RegionAuthorityCertificate = {
  tag: "region-authority",
  schema: 1,
  events: [
    {
      tag: "claim",
      origin: 7,
      family: "array-interval-v1",
      permit: 0,
      operation: "@region.array.claim",
    },
    {
      tag: "partition",
      source: 0,
      parts: [1, 2],
      operation: "@region.split",
    },
    {
      tag: "transform",
      source: 1,
      result: 3,
      operation: "@region.array.swap",
    },
    {
      tag: "combine",
      parts: [3, 2],
      result: 4,
      operation: "@region.join",
    },
    {
      tag: "release",
      permit: 4,
      operation: "@region.array.freeze",
    },
  ],
};

Deno.test("region authority verifier accepts a closed linear graph", () => {
  assertNotEquals(verifyRegionAuthorityCertificate(valid), null);
});

Deno.test("partition consumes its parent authority", () => {
  const certificate: RegionAuthorityCertificate = {
    ...valid,
    events: [
      ...valid.events.slice(0, 2),
      {
        tag: "transform",
        source: 0,
        result: 9,
        operation: "forged reuse of partition parent",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate), null);
});

Deno.test("partition outputs cannot alias one permit identity", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      valid.events[0],
      {
        tag: "partition",
        source: 0,
        parts: [1, 1],
        operation: "bad partition",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate, true), null);
});

Deno.test("a permit id is produced exactly once", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      valid.events[0],
      {
        tag: "transform",
        source: 0,
        result: 0,
        operation: "bad identity reuse",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate), null);
});

Deno.test("combine cannot merge authorities from different origins", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        origin: 1,
        family: "array-interval-v1",
        permit: 0,
        operation: "claim a",
      },
      {
        tag: "claim",
        origin: 2,
        family: "array-interval-v1",
        permit: 1,
        operation: "claim b",
      },
      {
        tag: "combine",
        parts: [0, 1],
        result: 2,
        operation: "bad cross-store join",
      },
      {
        tag: "release",
        permit: 2,
        operation: "release",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate), null);
});

Deno.test("combine cannot merge different region families", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        origin: 1,
        family: "array-interval-v1",
        permit: 0,
        operation: "claim interval",
      },
      {
        tag: "claim",
        origin: 1,
        family: "matrix-tile-v1",
        permit: 1,
        operation: "claim tile",
      },
      {
        tag: "combine",
        parts: [0, 1],
        result: 2,
        operation: "bad cross-family join",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate, true), null);
});

Deno.test("closed verification rejects leaked authorities", () => {
  const open: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: valid.events.slice(0, 2),
  };
  assertEquals(verifyRegionAuthorityCertificate(open), null);
  assertNotEquals(verifyRegionAuthorityCertificate(open, true), null);
});

Deno.test("release cannot consume one authority twice", () => {
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      valid.events[0],
      {
        tag: "release",
        permit: 0,
        operation: "first release",
      },
      {
        tag: "release",
        permit: 0,
        operation: "second release",
      },
    ],
  };
  assertEquals(verifyRegionAuthorityCertificate(certificate), null);
});
