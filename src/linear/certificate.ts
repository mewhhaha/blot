import type { NamePattern } from "./check.ts";

export interface PublishedOwnershipFact {
  readonly path: string;
  readonly bindingId: number;
  readonly lastUse: { readonly start: number; readonly end: number } | null;
  readonly spent: boolean;
  readonly reentrant: boolean;
}

export interface OwnershipCertificateEntry extends PublishedOwnershipFact {
  readonly binding: { readonly start: number; readonly end: number };
  readonly name: string;
  /** A backend may reuse storage only at this exact proved consumption. */
  readonly reusable: boolean;
}

export interface OwnershipCertificate {
  readonly tag: "ownership";
  readonly entries: readonly OwnershipCertificateEntry[];
}

export function ownershipCertificate(
  ownership: ReadonlyMap<NamePattern, PublishedOwnershipFact>,
): OwnershipCertificate {
  return {
    tag: "ownership",
    entries: [...ownership].map(([pattern, fact]) => ({
      ...fact,
      binding: pattern.span,
      name: pattern.name,
      reusable: fact.spent && fact.lastUse !== null && !fact.reentrant,
    })),
  };
}

export interface VerifiedOwnershipCertificate {
  readonly reusable: ReadonlySet<string>;
}

export function verifyOwnershipCertificate(
  certificate: OwnershipCertificate,
): VerifiedOwnershipCertificate | null {
  const identities = new Set<string>();
  const reusable = new Set<string>();
  for (const entry of certificate.entries) {
    if (!Number.isSafeInteger(entry.bindingId) || entry.bindingId < 0) {
      return null;
    }
    if (!validSpan(entry.binding)) return null;
    if (entry.lastUse !== null && !validSpan(entry.lastUse)) return null;
    const identity = ownershipIdentity(entry);
    if (identities.has(identity)) return null;
    identities.add(identity);

    const justified = entry.spent && entry.lastUse !== null &&
      !entry.reentrant;
    if (entry.reusable !== justified) return null;
    if (entry.reusable) reusable.add(identity);
  }
  return { reusable };
}

export function ownershipIdentity(
  entry: Pick<OwnershipCertificateEntry, "path" | "bindingId">,
): string {
  return `${entry.path}:${entry.bindingId}`;
}

function validSpan(span: { readonly start: number; readonly end: number }) {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
    span.start >= 0 && span.end >= span.start;
}
