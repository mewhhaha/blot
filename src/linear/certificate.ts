import type { NamePattern } from "./check.ts";

export interface PublishedOwnershipFact {
  readonly path: string;
  readonly bindingId: number;
  readonly lastUse: { readonly start: number; readonly end: number } | null;
  readonly spent: boolean;
  readonly consumptions: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  readonly reentrant: boolean;
}

export interface OwnershipCertificateEntry extends PublishedOwnershipFact {
  readonly binding: { readonly start: number; readonly end: number };
  readonly name: string;
  /** Exact path-specific consumptions at which storage reuse is authorized. */
  readonly reusableAt: readonly {
    readonly start: number;
    readonly end: number;
  }[];
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
      reusableAt: reusableSites(fact),
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
    if (entry.consumptions.some((span) => !validSpan(span))) return null;
    if (duplicateSpans(entry.consumptions)) return null;
    if (entry.spent !== (entry.consumptions.length > 0)) return null;
    const identity = ownershipIdentity(entry);
    if (identities.has(identity)) return null;
    identities.add(identity);

    const justified = reusableSites(entry);
    if (!sameSpans(entry.reusableAt, justified)) return null;
    for (const span of entry.reusableAt) {
      reusable.add(ownershipUseIdentity(entry, span));
    }
  }
  return { reusable };
}

function reusableSites(
  fact: Pick<PublishedOwnershipFact, "spent" | "reentrant" | "consumptions">,
): readonly { readonly start: number; readonly end: number }[] {
  if (!fact.spent || fact.reentrant) return [];
  return fact.consumptions;
}

export function ownershipUseIdentity(
  entry: Pick<OwnershipCertificateEntry, "path" | "bindingId">,
  span: { readonly start: number; readonly end: number },
): string {
  return `${ownershipIdentity(entry)}@${span.start}:${span.end}`;
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

function duplicateSpans(
  spans: readonly { readonly start: number; readonly end: number }[],
): boolean {
  const identities = new Set<string>();
  for (const span of spans) {
    const identity = `${span.start}:${span.end}`;
    if (identities.has(identity)) return true;
    identities.add(identity);
  }
  return false;
}

function sameSpans(
  left: readonly { readonly start: number; readonly end: number }[],
  right: readonly { readonly start: number; readonly end: number }[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right.map((span) => `${span.start}:${span.end}`));
  return left.every((span) => expected.has(`${span.start}:${span.end}`));
}
