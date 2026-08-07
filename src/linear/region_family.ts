/**
 * Local proof interface for one partitioned-ownership region family.
 *
 * This deliberately contains no source control-flow logic. Blot's ordinary
 * ownership checker decides whether the values carrying regions are consumed on
 * every path. A RegionFamily validates only the local spatial derivation attached
 * to one trusted operation.
 *
 * Keeping this interface independent of arrays is the reusable pattern: an array
 * interval, matrix tile, byte-buffer range, or another proof-producing
 * collection may supply its own witnesses without changing algebraic subtyping
 * or duplicating branch/closure ownership analysis.
 */
export interface RegionFamily<
  Region,
  PartitionWitness,
  CombineWitness,
  AccessWitness,
> {
  /** Stable compiler identity recorded by region lineage. */
  readonly name: string;

  /** Is this one region representation well formed? */
  readonly valid: (region: Region) => boolean;

  /** Can both regions authorize writes simultaneously? */
  readonly disjoint: (left: Region, right: Region) => boolean;

  /**
   * Does `parts` form exactly the partition of `source` described by `witness`?
   *
   * A family must check both separation and conservation here. Merely proving
   * that the parts do not overlap would permit authority to disappear.
   */
  readonly verifyPartition: (
    source: Region,
    witness: PartitionWitness,
    parts: readonly Region[],
  ) => boolean;

  /**
   * Is `result` exactly the valid composition of `parts` described by `witness`?
   *
   * A family may make composition partial. For array intervals, ordered
   * adjacency is required; arbitrary disjoint intervals with a gap do not join.
   */
  readonly verifyCombine: (
    parts: readonly Region[],
    witness: CombineWitness,
    result: Region,
  ) => boolean;

  /** Does an operation-relative access witness name a location in the region? */
  readonly contains: (region: Region, access: AccessWitness) => boolean;

  /** May this region be released back as the complete ordinary resource? */
  readonly full: (region: Region) => boolean;
}

/**
 * Generic sanity check useful before a family-specific partition verifier runs.
 * It cannot establish exact coverage because only the family knows its region
 * algebra; `verifyPartition` remains the authority for conservation.
 */
export function pairwiseDisjoint<Region>(
  family: Pick<RegionFamily<Region, never, never, never>, "valid" | "disjoint">,
  regions: readonly Region[],
): boolean {
  if (regions.some((region) => !family.valid(region))) return false;
  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      if (!family.disjoint(regions[left], regions[right])) return false;
    }
  }
  return true;
}
