/**
 * Single-path trace oracle for partitioned ownership authorities.
 *
 * This module deliberately knows nothing about arrays or intervals. Given one
 * concrete execution trace, it proves the linear authority graph: one
 * externally authorized Store root is claimed once, one origin generation is
 * claimed once, a permit is produced once and consumed once, partitions do not
 * retain their parent, combinations consume every input, and all parts preserve
 * one root/origin/family.
 *
 * This is executable evidence for the region algebra and a hostile-input
 * verifier for evaluator/runtime experiments. It is NOT sufficient as Blot's
 * static source ownership certificate: mutually exclusive branch consumptions
 * are alternatives, not sequential trace events. Production integration must
 * carry region derivation alongside the existing path-sensitive ownership
 * certificate, as specified in `spec/OWNED_REGIONS.md`.
 *
 * Every event tag is matched explicitly. A trace is data, not a typed value:
 * the union below constrains well-typed callers, and an event carrying any
 * other tag is rejected rather than falling through to the release rule.
 *
 * A region-family validator supplies the semantic half for each trace event:
 * e.g. an array-interval partition must be a disjoint cover, a combine must
 * join compatible regions, and a write must stay inside its carried interval.
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
    /**
     * Identity of an external Store-uniqueness proof. A production reuse path
     * would name a fresh-allocation/reuse lineage fact, not merely a linear
     * binding. The executable model always roots this in a fresh Store.
     */
    readonly root: string;
    /** One acquisition generation derived from `root`. */
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
  readonly root: string;
  readonly origin: RegionOriginId;
  readonly family: string;
  readonly producedBy: number;
  readonly consumedBy: number;
}

interface LivePermit {
  readonly root: string;
  readonly origin: RegionOriginId;
  readonly family: string;
  readonly producedBy: number;
}

/**
 * Replays one authority trace. A complete trace must release every leaf.
 * `allowLive=true` is useful while constructing/debugging a trace.
 *
 * `authorizedRoots` is deliberately external. Store provenance establishes
 * that a destructive allocation has no persistent observer; this verifier only
 * establishes that authority derived from that root is not duplicated along
 * the represented execution path.
 *
 * `origin` names one acquisition generation, not merely a raw pointer. Releasing
 * an authority and later reacquiring unique access to the same Store uses a
 * fresh authorized root and a fresh origin id.
 */
export function verifyRegionAuthorityCertificate(
  certificate: RegionAuthorityCertificate,
  authorizedRoots: ReadonlySet<string>,
  allowLive = false,
): VerifiedRegionAuthorityCertificate | null {
  if (certificate.schema !== 1) return null;

  const claimedRoots = new Set<string>();
  const claimedOrigins = new Set<RegionOriginId>();
  const produced = new Map<RegionPermitId, number>();
  const live = new Map<RegionPermitId, LivePermit>();
  const verified = new Map<RegionPermitId, VerifiedRegionPermit>();
  const released = new Set<RegionPermitId>();

  const produce = (
    permit: RegionPermitId,
    root: string,
    origin: RegionOriginId,
    family: string,
    event: number,
  ): boolean => {
    if (
      !validId(permit) || !validId(origin) || root.length === 0 ||
      family.length === 0
    ) return false;
    if (produced.has(permit)) return false;
    produced.set(permit, event);
    live.set(permit, { root, origin, family, producedBy: event });
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
      if (
        event.root.length === 0 || !authorizedRoots.has(event.root) ||
        claimedRoots.has(event.root) || !validId(event.origin) ||
        claimedOrigins.has(event.origin)
      ) return null;
      if (
        !produce(
          event.permit,
          event.root,
          event.origin,
          event.family,
          index,
        )
      ) return null;
      claimedRoots.add(event.root);
      claimedOrigins.add(event.origin);
      continue;
    }

    if (event.tag === "partition") {
      if (event.parts.length < 2 || duplicateIds(event.parts)) return null;
      const source = consume(event.source, index);
      if (source === null) return null;
      for (const part of event.parts) {
        if (
          !produce(
            part,
            source.root,
            source.origin,
            source.family,
            index,
          )
        ) return null;
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
          input.root !== first.root || input.origin !== first.origin ||
          input.family !== first.family
        )
      ) return null;
      for (const part of event.parts) {
        if (consume(part, index) === null) return null;
      }
      if (
        !produce(
          event.result,
          first.root,
          first.origin,
          first.family,
          index,
        )
      ) return null;
      continue;
    }

    if (event.tag === "transform") {
      const source = consume(event.source, index);
      if (source === null) return null;
      if (
        !produce(
          event.result,
          source.root,
          source.origin,
          source.family,
          index,
        )
      ) return null;
      continue;
    }

    if (event.tag !== "release") return null;
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
