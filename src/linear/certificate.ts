import type {
  NamePattern,
  OwnershipExtraction,
  OwnershipPathSegment,
  OwnershipTargetPathSegment,
} from "./check.ts";

export interface PublishedOwnershipLineage {
  readonly sourceBindingId: number;
  readonly sourcePath: readonly OwnershipPathSegment[];
  readonly targetPath: readonly OwnershipTargetPathSegment[];
  readonly extractions: readonly OwnershipExtraction[];
}

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
  readonly lineage: readonly PublishedOwnershipLineage[];
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
  readonly schema: 2;
  readonly entries: readonly OwnershipCertificateEntry[];
}

export function ownershipCertificate(
  ownership: ReadonlyMap<NamePattern, PublishedOwnershipFact>,
): OwnershipCertificate {
  return {
    tag: "ownership",
    schema: 2,
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
  readonly lineage: ReadonlyMap<string, readonly PublishedOwnershipLineage[]>;
}

export function verifyOwnershipCertificate(
  certificate: OwnershipCertificate,
): VerifiedOwnershipCertificate | null {
  if (certificate.schema !== 2) return null;
  const identities = new Set<string>();
  const reusable = new Set<string>();
  const lineage = new Map<string, readonly PublishedOwnershipLineage[]>();
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

  const extractionGroups = new Map<
    string,
    {
      readonly operation: OwnershipExtraction["operation"];
      readonly parts: Set<number>;
    }
  >();
  for (const entry of certificate.entries) {
    const entryLineage = new Set<string>();
    for (const origin of entry.lineage) {
      if (
        !Number.isSafeInteger(origin.sourceBindingId) ||
        origin.sourceBindingId < 0
      ) return null;
      const sourceIdentity = `${entry.path}:${origin.sourceBindingId}`;
      if (!identities.has(sourceIdentity)) return null;
      if (!validOwnershipPath(origin.sourcePath)) return null;
      if (!validOwnershipPath(origin.targetPath)) return null;
      const identity = publishedLineageIdentity(origin);
      if (entryLineage.has(identity)) return null;
      entryLineage.add(identity);
      for (const extraction of origin.extractions) {
        if (!validSpan(extraction.span)) return null;
        const count = extractionPartCount(extraction.operation);
        if (count === null || extraction.part < 0 || extraction.part >= count) {
          return null;
        }
        const group = `${sourceIdentity}:` +
          `${JSON.stringify(origin.sourcePath)}:` +
          `${extraction.operation}@${extraction.span.start}:${extraction.span.end}`;
        let extractionGroup = extractionGroups.get(group);
        if (extractionGroup === undefined) {
          extractionGroup = {
            operation: extraction.operation,
            parts: new Set(),
          };
          extractionGroups.set(group, extractionGroup);
        }
        extractionGroup.parts.add(extraction.part);
      }
    }
    lineage.set(ownershipIdentity(entry), entry.lineage);
  }
  for (const extractionGroup of extractionGroups.values()) {
    const count = extractionPartCount(extractionGroup.operation);
    if (count === null || extractionGroup.parts.size !== count) return null;
  }
  return { reusable, lineage };
}

function validOwnershipPath(
  path: readonly (
    | OwnershipPathSegment
    | OwnershipTargetPathSegment
  )[],
): boolean {
  for (const segment of path) {
    if (segment.tag === "field" || segment.tag === "case") {
      if (segment.name.length === 0) return false;
      continue;
    }
    if (!Number.isSafeInteger(segment.index) || segment.index < 0) return false;
  }
  return true;
}

function extractionPartCount(
  operation: string,
): number | null {
  if (operation === "@array.take") return 2;
  if (operation === "@array.split") return 3;
  if (operation === "@region.split") return 2;
  if (operation === "@region.replace") return 2;
  return null;
}

function publishedLineageIdentity(
  lineage: PublishedOwnershipLineage,
): string {
  return JSON.stringify(lineage);
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
