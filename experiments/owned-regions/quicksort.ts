import {
  get,
  join,
  length,
  type Region,
  RegionModelError,
  split,
  swap,
} from "./model.ts";

/**
 * In-place Lomuto quicksort over partitioned ownership regions.
 *
 * Split/join allocate permit metadata only. Every element remains in the one
 * Store established by `claim`.
 */
export function quicksort(region: Region<number>): Region<number> {
  const size = length(region);
  if (size <= 1) return region;

  const partitioned = partition(region);
  const aroundPivot = splitOrThrow(partitioned.region, partitioned.pivot);
  const pivotAndRight = splitOrThrow(aroundPivot.right, 1);

  const left = quicksort(aroundPivot.left);
  const right = quicksort(pivotAndRight.right);

  const throughPivot = joinOrThrow(left, pivotAndRight.left);
  return joinOrThrow(throughPivot, right);
}

function partition(
  input: Region<number>,
): { readonly region: Region<number>; readonly pivot: number } {
  const size = length(input);
  if (size === 0) return { region: input, pivot: 0 };

  const pivotValue = requiredGet(input, size - 1);
  let region = input;
  let destination = 0;

  for (let scan = 0; scan < size - 1; scan += 1) {
    const value = requiredGet(region, scan);
    if (value >= pivotValue) continue;
    region = swapOrThrow(region, destination, scan);
    destination += 1;
  }

  region = swapOrThrow(region, destination, size - 1);
  return { region, pivot: destination };
}

function splitOrThrow<T>(
  region: Region<T>,
  offset: number,
): { readonly left: Region<T>; readonly right: Region<T> } {
  const result = split(region, offset);
  if (result.tag === "split") return result;
  throw new RegionModelError(
    "REGION_INTERNAL_SPLIT",
    `proved quicksort split ${offset} was rejected`,
  );
}

function joinOrThrow<T>(left: Region<T>, right: Region<T>): Region<T> {
  const result = join(left, right);
  if (result.tag === "joined") return result.region;
  throw new RegionModelError(
    "REGION_INTERNAL_JOIN",
    `quicksort produced ${result.tag} regions`,
  );
}

function swapOrThrow<T>(
  region: Region<T>,
  left: number,
  right: number,
): Region<T> {
  const result = swap(region, left, right);
  if (result.tag === "updated") return result.region;
  throw new RegionModelError(
    "REGION_INTERNAL_SWAP",
    `proved quicksort swap (${left}, ${right}) was rejected`,
  );
}

function requiredGet<T>(region: Region<T>, index: number): T {
  const result = get(region, index);
  if (result.tag === "read") return result.value;
  throw new RegionModelError(
    "REGION_INTERNAL_GET",
    `proved quicksort read ${index} was rejected`,
  );
}
