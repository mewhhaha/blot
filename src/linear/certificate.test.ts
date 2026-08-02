import { assert, assertEquals } from "@std/assert";
import type { OwnershipCertificate } from "./certificate.ts";
import { verifyOwnershipCertificate } from "./certificate.ts";

const VALID: OwnershipCertificate = {
  tag: "ownership",
  entries: [{
    path: "example.blot",
    bindingId: 0,
    binding: { start: 4, end: 10 },
    name: "values",
    lastUse: { start: 20, end: 26 },
    spent: true,
    consumptions: [{ start: 20, end: 26 }],
    reentrant: false,
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
