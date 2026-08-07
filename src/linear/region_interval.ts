/**
 * Array-interval region algebra for partitioned ownership.
 *
 * This module contains no ownership graph. It answers only the semantic
 * questions for one region family: validity, disjointness, split coverage,
 * ordered combination, relative indexing, and full-extent coverage.
 */

export interface IntervalRegion {
  readonly origin: number;
  readonly start: number;
  readonly end: number;
  readonly extent: number;
}

export type IntervalSplit =
  | {
    readonly ok: true;
    readonly left: IntervalRegion;
    readonly right: IntervalRegion;
  }
  | { readonly ok: false; readonly original: IntervalRegion };

export type IntervalJoin =
  | { readonly ok: true; readonly region: IntervalRegion }
  | {
    readonly ok: false;
    readonly reason: "different_origin" | "different_extent" | "not_adjacent";
    readonly left: IntervalRegion;
    readonly right: IntervalRegion;
  };

export function validInterval(region: IntervalRegion): boolean {
  return validId(region.origin) && integer(region.start) &&
    integer(region.end) &&
    integer(region.extent) && region.extent >= 0 && region.start >= 0 &&
    region.start <= region.end && region.end <= region.extent;
}

export function intervalLength(region: IntervalRegion): number {
  if (!validInterval(region)) throw new Error("invalid interval region");
  return region.end - region.start;
}

export function splitInterval(
  region: IntervalRegion,
  offset: number,
): IntervalSplit {
  if (!validInterval(region)) throw new Error("invalid interval region");
  const length = intervalLength(region);
  if (!integer(offset) || offset < 0 || offset > length) {
    return { ok: false, original: region };
  }
  const middle = region.start + offset;
  return {
    ok: true,
    left: { ...region, end: middle },
    right: { ...region, start: middle },
  };
}

export function joinIntervals(
  left: IntervalRegion,
  right: IntervalRegion,
): IntervalJoin {
  if (!validInterval(left) || !validInterval(right)) {
    throw new Error("invalid interval region");
  }
  if (left.origin !== right.origin) {
    return { ok: false, reason: "different_origin", left, right };
  }
  if (left.extent !== right.extent) {
    return { ok: false, reason: "different_extent", left, right };
  }
  if (left.end !== right.start) {
    return { ok: false, reason: "not_adjacent", left, right };
  }
  return {
    ok: true,
    region: {
      origin: left.origin,
      start: left.start,
      end: right.end,
      extent: left.extent,
    },
  };
}

export function intervalContainsRelativeIndex(
  region: IntervalRegion,
  index: number,
): boolean {
  if (!validInterval(region)) return false;
  return integer(index) && index >= 0 && index < intervalLength(region);
}

export function intervalAbsoluteIndex(
  region: IntervalRegion,
  index: number,
): number | null {
  if (!intervalContainsRelativeIndex(region, index)) return null;
  return region.start + index;
}

export function isFullInterval(region: IntervalRegion): boolean {
  return validInterval(region) && region.start === 0 &&
    region.end === region.extent;
}

export function intervalsDisjoint(
  left: IntervalRegion,
  right: IntervalRegion,
): boolean {
  if (!validInterval(left) || !validInterval(right)) return false;
  if (left.origin !== right.origin) return true;
  // Empty intervals authorize no location and are disjoint from every region.
  if (left.start === left.end || right.start === right.end) return true;
  return left.end <= right.start || right.end <= left.start;
}

export function pairwiseDisjointIntervals(
  regions: readonly IntervalRegion[],
): boolean {
  if (regions.some((region) => !validInterval(region))) return false;
  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      if (!intervalsDisjoint(regions[left], regions[right])) return false;
    }
  }
  return true;
}

/**
 * Stronger than disjointness: the two split outputs exactly cover the input in
 * order and preserve origin/extent.
 */
export function validSplitCover(
  source: IntervalRegion,
  left: IntervalRegion,
  right: IntervalRegion,
): boolean {
  if (![source, left, right].every(validInterval)) return false;
  return source.origin === left.origin && source.origin === right.origin &&
    source.extent === left.extent && source.extent === right.extent &&
    source.start === left.start && left.end === right.start &&
    right.end === source.end;
}

/**
 * Checks that `combined` is exactly the ordered union of `left` and `right`.
 */
export function validJoinCover(
  left: IntervalRegion,
  right: IntervalRegion,
  combined: IntervalRegion,
): boolean {
  const joined = joinIntervals(left, right);
  if (!joined.ok) return false;
  return sameInterval(joined.region, combined);
}

export function sameInterval(
  left: IntervalRegion,
  right: IntervalRegion,
): boolean {
  return left.origin === right.origin && left.start === right.start &&
    left.end === right.end && left.extent === right.extent;
}

function integer(value: number): boolean {
  return Number.isSafeInteger(value);
}

function validId(value: number): boolean {
  return integer(value) && value >= 0;
}
