import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type RegionAuthorityCertificate,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";

const ROOT = "fresh-store:7";
const ROOTS = new Set([ROOT]);

const valid: RegionAuthorityCertificate = {
  tag: "region-authority",
  schema: 1,
  events: [
    {
      tag: "claim",
      root: ROOT,
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
  assertNotEquals(verifyRegionAuthorityCertificate(valid, ROOTS), null);
});

Deno.test("a claim must be rooted in an external uniqueness proof", () => {
  assertEquals(
    verifyRegionAuthorityCertificate(valid, new Set()),
    null,
  );
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
  assertEquals(verifyRegionAuthorityCertificate(certificate, ROOTS), null);
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
  assertEquals(
    verifyRegionAuthorityCertificate(certificate, ROOTS, true),
    null,
  );
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
  assertEquals(verifyRegionAuthorityCertificate(certificate, ROOTS), null);
});

Deno.test("combine cannot merge authorities from different roots", () => {
  const roots = new Set(["root:a", "root:b"]);
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        root: "root:a",
        origin: 1,
        family: "array-interval-v1",
        permit: 0,
        operation: "claim a",
      },
      {
        tag: "claim",
        root: "root:b",
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
    ],
  };
  assertEquals(
    verifyRegionAuthorityCertificate(certificate, roots, true),
    null,
  );
});

Deno.test("combine cannot merge different region families", () => {
  const roots = new Set(["root:interval", "root:tile"]);
  const certificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        root: "root:interval",
        origin: 1,
        family: "array-interval-v1",
        permit: 0,
        operation: "claim interval",
      },
      {
        tag: "claim",
        root: "root:tile",
        origin: 2,
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
  assertEquals(
    verifyRegionAuthorityCertificate(certificate, roots, true),
    null,
  );
});

Deno.test("closed verification rejects leaked authorities", () => {
  const open: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: valid.events.slice(0, 2),
  };
  assertEquals(verifyRegionAuthorityCertificate(open, ROOTS), null);
  assertNotEquals(
    verifyRegionAuthorityCertificate(open, ROOTS, true),
    null,
  );
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
  assertEquals(verifyRegionAuthorityCertificate(certificate, ROOTS), null);
});
