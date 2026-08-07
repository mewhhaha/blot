/**
 * Generic certificate graph for partitioned ownership authorities.
 *
 * This module deliberately knows nothing about arrays or intervals. It proves
 * only the linear authority graph: a permit is produced once, consumed once,
 * partitions do not retain their parent, combinations consume every input, and
 * all parts preserve one origin/family.
 *
 * A region-family validator is responsible for the semantic half: e.g. an
 * array-interval partition must be a disjoint cover, a combine must join
 * compatible regions, and a write must stay inside the carried interval.
 * Runtime HIR must bind each certificate event to the corresponding trusted
 * operation before destructive reuse is permitted.
 */

export type RegionPermitId = number;
export type RegionOriginId = number;

export interface RegionAuthorityCertificate {
  readonly tag: "region-authority";
  readonly schema: 1;
  readonly events: readonly RegionAuthorityEvent[];
}

export type RegionAuthorityEvent =
  | {
    readonly tag: "claim";
    readonly origin: RegionOriginId;
    readonly family: string;
    readonly permit: RegionPermitId;
    readonly operation: string;
  }
  | {
    readonly tag: "partition";
    readonly source: RegionPermitId;
    readonly parts: readonly RegionPermitId[];
    readonly operation: string;
  }
  | {
    readonly tag: "combine";
    readonly parts: readonly RegionPermitId[];
    readonly result: RegionPermitId;
    readonly operation: string;
  }
  | {
    readonly tag: "transform";
    readonly source: RegionPermitId;
    readonly result: RegionPermitId;
    readonly operation: string;
  }
  | {
    readonly tag: "release";
    readonly permit: RegionPermitId;
    readonly operation: string;
  };

export interface VerifiedRegionAuthorityCertificate {
  readonly permits: ReadonlyMap<RegionPermitId, VerifiedRegionPermit>;
  readonly released: ReadonlySet<RegionPermitId>;
}

export interface VerifiedRegionPermit {
  readonly origin: RegionOriginId;
  readonly family: string;
  readonly producedBy: number;
  readonly consumedBy: number;
}

interface LivePermit {
  readonly origin: RegionOriginId;
  readonly family: string;
  readonly producedBy: number;
}

/**
 * Replays the authority graph. A complete certificate must release every leaf.
 * Partial compilation can use `allowLive=true` while constructing a graph, but
 * Runtime HIR validation should require the default closed form.
 */
export function verifyRegionAuthorityCertificate(
  certificate: RegionAuthorityCertificate,
  allowLive = false,
): VerifiedRegionAuthorityCertificate | null {
  if (certificate.schema !== 1) return null;

  const produced = new Map<RegionPermitId, number>();
  const live = new Map<RegionPermitId, LivePermit>();
  const verified = new Map<RegionPermitId, VerifiedRegionPermit>();
  const released = new Set<RegionPermitId>();

  const produce = (
    permit: RegionPermitId,
    origin: RegionOriginId,
    family: string,
    event: number,
  ): boolean => {
    if (!validId(permit) || !validId(origin) || family.length === 0) return false;
    if (produced.has(permit)) return false;
    produced.set(permit, event);
    live.set(permit, { origin, family, producedBy: event });
    return true;
  };

  const consume = (
    permit: RegionPermitId,
    event: number,
  ): LivePermit | null => {
    if (!validId(permit)) return null;
    const found = live.get(permit);
    if (found === undefined) return null;
    live.delete(permit);
    verified.set(permit, {
      ...found,
      consumedBy: event,
    });
    return found;
  };

  for (const [index, event] of certificate.events.entries()) {
    if (event.operation.length === 0) return null;

    if (event.tag === "claim") {
      if (!produce(event.permit, event.origin, event.family, index)) return null;
      continue;
    }

    if (event.tag === "partition") {
      if (event.parts.length < 2 || duplicateIds(event.parts)) return null;
      const source = consume(event.source, index);
      if (source === null) return null;
      for (const part of event.parts) {
        if (!produce(part, source.origin, source.family, index)) return null;
      }
      continue;
    }

    if (event.tag === "combine") {
      if (event.parts.length < 2 || duplicateIds(event.parts)) return null;
      const inputs: LivePermit[] = [];
      // Validate all inputs before consuming any so malformed certificates are
      // not accidentally accepted through a partially mutated verifier state.
      for (const part of event.parts) {
        const found = live.get(part);
        if (found === undefined) return null;
        inputs.push(found);
      }
      const first = inputs[0];
      if (
        inputs.some((input) =>
          input.origin !== first.origin || input.family !== first.family
        )
      ) return null;
      for (const part of event.parts) {
        if (consume(part, index) === null) return null;
      }
      if (!produce(event.result, first.origin, first.family, index)) return null;
      continue;
    }

    if (event.tag === "transform") {
      const source = consume(event.source, index);
      if (source === null) return null;
      if (!produce(event.result, source.origin, source.family, index)) return null;
      continue;
    }

    if (consume(event.permit, index) === null) return null;
    released.add(event.permit);
  }

  if (!allowLive && live.size !== 0) return null;
  if (allowLive) {
    // A live permit has no consuming event yet. Preserve it in the verified map
    // with a sentinel at the end of the event stream for debugging/prototyping.
    for (const [permit, state] of live) {
      verified.set(permit, {
        ...state,
        consumedBy: certificate.events.length,
      });
    }
  }

  return { permits: verified, released };
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function duplicateIds(values: readonly number[]): boolean {
  return new Set(values).size !== values.length;
}
