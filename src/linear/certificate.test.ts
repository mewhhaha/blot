import { assert, assertEquals } from "@std/assert";
import type { OwnershipCertificate } from "./certificate.ts";
import { verifyOwnershipCertificate } from "./certificate.ts";

const VALID: OwnershipCertificate = {
  tag: "ownership",
  schema: 2,
  entries: [{
    path: "example.blot",
    bindingId: 0,
    binding: { start: 4, end: 10 },
    name: "values",
    lastUse: { start: 20, end: 26 },
    spent: true,
    consumptions: [{ start: 20, end: 26 }],
    reentrant: false,
    lineage: [],
    reusableAt: [{ start: 20, end: 26 }],
  }],
};

Deno.test("ownership certificates independently admit proved reuse", () => {
  const verified = verifyOwnershipCertificate(VALID);
  assert(verified !== null);
  assertEquals([...verified.reusable], ["example.blot:0@20:26"]);
});

Deno.test("ownership certificates reject reuse at a reentrant read", () => {
  const invalid: OwnershipCertificate = {
    ...VALID,
    entries: [{ ...VALID.entries[0], reentrant: true }],
  };
  assertEquals(verifyOwnershipCertificate(invalid), null);
});

Deno.test("ownership certificates reject duplicate binding identities", () => {
  const invalid: OwnershipCertificate = {
    ...VALID,
    entries: [VALID.entries[0], VALID.entries[0]],
  };
  assertEquals(verifyOwnershipCertificate(invalid), null);
});

Deno.test("ownership certificates retain every branch consumption", () => {
  const branched: OwnershipCertificate = {
    ...VALID,
    entries: [{
      ...VALID.entries[0],
      consumptions: [{ start: 20, end: 26 }, { start: 40, end: 46 }],
      reusableAt: [{ start: 20, end: 26 }, { start: 40, end: 46 }],
    }],
  };
  const verified = verifyOwnershipCertificate(branched);
  assert(verified !== null);
  assertEquals([...verified.reusable], [
    "example.blot:0@20:26",
    "example.blot:0@40:46",
  ]);
});

Deno.test("ownership certificates reject a missing branch consumption", () => {
  const invalid: OwnershipCertificate = {
    ...VALID,
    entries: [{
      ...VALID.entries[0],
      consumptions: [{ start: 20, end: 26 }, { start: 40, end: 46 }],
      reusableAt: [{ start: 20, end: 26 }],
    }],
  };
  assertEquals(verifyOwnershipCertificate(invalid), null);
});

Deno.test("ownership certificates reject lineage from an unknown binding", () => {
  const invalid: OwnershipCertificate = {
    ...VALID,
    entries: [{
      ...VALID.entries[0],
      lineage: [{
        sourceBindingId: 9,
        sourcePath: [],
        targetPath: [{ tag: "field", name: "selected" }],
        extractions: [],
      }],
    }],
  };
  assertEquals(verifyOwnershipCertificate(invalid), null);
});

Deno.test("ownership certificates reject an incomplete extraction partition", () => {
  const invalid: OwnershipCertificate = {
    ...VALID,
    entries: [
      VALID.entries[0],
      {
        ...VALID.entries[0],
        bindingId: 1,
        binding: { start: 30, end: 36 },
        name: "selected",
        lineage: [{
          sourceBindingId: 0,
          sourcePath: [],
          targetPath: [],
          extractions: [{
            operation: "@array.take",
            part: 0,
            span: { start: 50, end: 70 },
          }],
        }],
      },
    ],
  };
  assertEquals(verifyOwnershipCertificate(invalid), null);
});

Deno.test("ownership certificates retain a complete extraction partition", () => {
  const complete: OwnershipCertificate = {
    ...VALID,
    entries: [
      VALID.entries[0],
      {
        ...VALID.entries[0],
        bindingId: 1,
        binding: { start: 30, end: 36 },
        name: "parts",
        lineage: [0, 1].map((part) => ({
          sourceBindingId: 0,
          sourcePath: [],
          targetPath: [{ tag: "element" as const, index: part }],
          extractions: [{
            operation: "@array.take" as const,
            part,
            span: { start: 50, end: 70 },
          }],
        })),
      },
    ],
  };
  const verified = verifyOwnershipCertificate(complete);
  assert(verified !== null);
  assertEquals(verified.lineage.get("example.blot:1")?.length, 2);
});
