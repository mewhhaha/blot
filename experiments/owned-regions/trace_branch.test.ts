import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type RegionAuthorityCertificate,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";

const ROOT = "branch-root";
const roots = new Set([ROOT]);

function oneBranch(operation: string): RegionAuthorityCertificate {
  return {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        root: ROOT,
        origin: 1,
        family: "array-interval-v1",
        permit: 0,
        operation: "claim",
      },
      {
        tag: "transform",
        source: 0,
        result: 1,
        operation,
      },
      {
        tag: "release",
        permit: 1,
        operation: "release",
      },
    ],
  };
}

Deno.test("either concrete branch trace is valid on its own", () => {
  assertNotEquals(
    verifyRegionAuthorityCertificate(oneBranch("branch A"), roots),
    null,
  );
  assertNotEquals(
    verifyRegionAuthorityCertificate(oneBranch("branch B"), roots),
    null,
  );
});

Deno.test("flattening mutually exclusive branch consumers is intentionally invalid", () => {
  const flattened: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [
      {
        tag: "claim",
        root: ROOT,
        origin: 1,
        family: "array-interval-v1",
        permit: 0,
        operation: "claim",
      },
      {
        tag: "transform",
        source: 0,
        result: 1,
        operation: "branch A",
      },
      {
        tag: "transform",
        source: 0,
        result: 2,
        operation: "branch B",
      },
    ],
  };

  assertEquals(
    verifyRegionAuthorityCertificate(flattened, roots, true),
    null,
  );
});
