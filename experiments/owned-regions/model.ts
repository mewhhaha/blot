import {
  type RegionAuthorityCertificate,
  type RegionAuthorityEvent,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";
import { pairwiseDisjoint } from "../../src/linear/region_family.ts";
import {
  arrayIntervalFamily,
  type IntervalRegion,
} from "../../src/linear/region_interval.ts";

/**
 * Executable model for spec/OWNED_REGIONS.md.
 *
 * `claim(shared)` models the source semantics: copy into a fresh private Store.
 * `freshOwned` + `claimOwned` models the compiler's zero-copy path when Store
 * provenance has independently proved uniqueness.
 *
 * Region state is stricter than a convenient JavaScript slice API. Every
 * state-changing operation consumes its authority token and returns a fresh
 * token; attempting to use an old token is a model error. Split and join change
 * metadata only and never copy elements.
 */

const REGION_BRAND: unique symbol = Symbol("blot-owned-region");
const OWNED_STORE_BRAND: unique symbol = Symbol("blot-owned-store");
const ARRAY_INTERVAL_FAMILY = arrayIntervalFamily.name;

export interface Region<T> {
  readonly [REGION_BRAND]: T;
}

/**
 * Model-only evidence for a Store whose allocation is already unique.
 * Production obtains the equivalent fact from Store provenance, not from a
 * source-visible wrapper.
 */
export interface OwnedStore<T> {
  readonly [OWNED_STORE_BRAND]: T;
}

export interface Bounds {
  readonly start: number;
  readonly end: number;
  readonly extent: number;
}

/**
 * What one region graph did to its Store.
 *
 * These count operations the model performs; they are not evidence that no
 * other copy happened. Nothing after acquisition can copy elements, because
 * split and join only produce permit metadata and set and swap write cells in
 * place — that property is structural, so there is no counter for it.
 */
export interface RegionStats {
  /**
   * How this graph obtained its Store. `copy` is the source semantics of
   * `claim`; `transfer` is the zero-copy path a Store-provenance proof unlocks.
   */
  readonly acquisition: Acquisition;
  /** Elements copied while acquiring a private Store from shared input. */
  readonly acquisitionCopies: number;
  readonly permitAllocations: number;
  readonly splits: number;
  readonly joins: number;
  readonly writes: number;
  readonly swaps: number;
}

export type Acquisition = "copy" | "transfer";

export interface FrozenArray<T> {
  readonly backingId: number;
  readonly stats: RegionStats;
  readonly authorityCertificate: RegionAuthorityCertificate;
  readonly authorityVerified: boolean;
  /** Test/debug observation. Not a modeled Blot allocation. */
  readonly values: readonly T[];
}

export type SplitResult<T> =
  | {
    readonly tag: "split";
    readonly left: Region<T>;
    readonly right: Region<T>;
  }
  | { readonly tag: "out_of_bounds"; readonly original: Region<T> };

export type JoinResult<T> =
  | { readonly tag: "joined"; readonly region: Region<T> }
  | {
    readonly tag: "not_adjacent" | "different_origin";
    readonly left: Region<T>;
    readonly right: Region<T>;
  };

export type ReadResult<T> =
  | { readonly tag: "read"; readonly value: T }
  | { readonly tag: "out_of_bounds" };

export type UpdateResult<T> =
  | { readonly tag: "updated"; readonly region: Region<T> }
  | { readonly tag: "out_of_bounds"; readonly original: Region<T> };

interface MutableStats {
  acquisition: Acquisition;
  permitAllocations: number;
  splits: number;
  joins: number;
  writes: number;
  swaps: number;
}

interface Store<T> {
  readonly id: number;
  /** External proof identity authorizing the one root claim in this model. */
  readonly root: string;
  readonly cells: T[];
  readonly live: Map<number, Permit<T>>;
  readonly stats: MutableStats;
  readonly authorityEvents: RegionAuthorityEvent[];
}

interface Permit<T> {
  readonly id: number;
  readonly store: Store<T>;
  readonly start: number;
  readonly end: number;
  alive: boolean;
}

class RegionImpl<T> implements Region<T> {
  declare readonly [REGION_BRAND]: T;
  constructor(readonly permit: Permit<T>) {}
}

class OwnedStoreImpl<T> implements OwnedStore<T> {
  declare readonly [OWNED_STORE_BRAND]: T;
  alive = true;
  constructor(readonly store: Store<T>) {}
}

let nextStore = 1;
let nextPermit = 1;

/**
 * Source-semantic acquisition from an ordinary potentially shared array.
 *
 * The model copies every element into a fresh private Store. A compiler may
 * replace this path with `claimOwned` only when a Store-provenance proof shows
 * that the input allocation has no persistent observer.
 */
export function claim<T>(values: readonly T[]): Region<T> {
  return claimStore(allocateStore(values, "copy"));
}

/**
 * Creates model-only unique Store provenance. Think of this as a fresh array
 * allocation whose identity the compiler still owns, before it becomes an
 * ordinary shareable source value.
 */
export function freshOwned<T>(values: readonly T[]): OwnedStore<T> {
  return new OwnedStoreImpl(allocateStore(values, "transfer"));
}

/**
 * Zero-copy acquisition: transfer an independently unique Store into region
 * authority. The backing id is unchanged and acquisitionCopies remains zero.
 */
export function claimOwned<T>(owned: OwnedStore<T>): Region<T> {
  const token = liveOwned(owned);
  token.alive = false;
  return claimStore(token.store);
}

export function ownedBackingId<T>(owned: OwnedStore<T>): number {
  return liveOwned(owned).store.id;
}

export function isOwnedLive<T>(owned: OwnedStore<T>): boolean {
  return unwrapOwned(owned).alive;
}

/** Models a non-consuming metadata query. */
export function length<T>(region: Region<T>): number {
  const permit = live(region);
  return permit.end - permit.start;
}

/** Models a non-consuming metadata query. */
export function bounds<T>(region: Region<T>): Bounds {
  const permit = live(region);
  return {
    start: permit.start,
    end: permit.end,
    extent: permit.store.cells.length,
  };
}

/** Debug identity proving two regions refer to one allocation. */
export function backingId<T>(region: Region<T>): number {
  return live(region).store.id;
}

/**
 * Models total `@region.split`. Failure conserves the original authority.
 * `offset` is relative to the region start and endpoints are legal.
 */
export function split<T>(region: Region<T>, offset: number): SplitResult<T> {
  const permit = live(region);
  const size = permit.end - permit.start;
  if (!integer(offset) || offset < 0 || offset > size) {
    return { tag: "out_of_bounds", original: region };
  }

  const store = permit.store;
  const source = permit.id;
  const middle = permit.start + offset;
  // The spatial law is the family's, not the model's, and it is checked before
  // any authority moves so a disagreement conserves the original permit.
  const sourceRegion = interval(permit);
  requireFamily(
    arrayIntervalFamily.verifyPartition(sourceRegion, { offset }, [
      { ...sourceRegion, end: middle },
      { ...sourceRegion, start: middle },
    ]),
    "@region.split",
    "partition is not an exact disjoint cover of its source",
  );
  consume(permit);
  const left = spawn(store, permit.start, middle);
  const right = spawn(store, middle, permit.end);
  store.authorityEvents.push({
    tag: "partition",
    source,
    parts: [unwrap(left).id, unwrap(right).id],
    operation: "@region.split",
  });
  store.stats.splits += 1;
  assertInvariant(store);
  return { tag: "split", left, right };
}

/**
 * Models total `@region.join`. Failure conserves both input authorities.
 * Join is intentionally ordered: `left.end` must equal `right.start`.
 */
export function join<T>(
  left: Region<T>,
  right: Region<T>,
): JoinResult<T> {
  const leftPermit = live(left);
  const rightPermit = live(right);
  if (leftPermit.store !== rightPermit.store) {
    return { tag: "different_origin", left, right };
  }
  if (leftPermit === rightPermit || leftPermit.end !== rightPermit.start) {
    return { tag: "not_adjacent", left, right };
  }

  const store = leftPermit.store;
  const leftId = leftPermit.id;
  const rightId = rightPermit.id;
  const start = leftPermit.start;
  const end = rightPermit.end;
  const parts = [interval(leftPermit), interval(rightPermit)];
  requireFamily(
    arrayIntervalFamily.verifyCombine(parts, "ordered-adjacent", {
      ...parts[0],
      start,
      end,
    }),
    "@region.join",
    "combination is not the ordered union of its parts",
  );
  consume(leftPermit);
  consume(rightPermit);
  const region = spawn(store, start, end);
  store.authorityEvents.push({
    tag: "combine",
    parts: [leftId, rightId],
    result: unwrap(region).id,
    operation: "@region.join",
  });
  store.stats.joins += 1;
  assertInvariant(store);
  return { tag: "joined", region };
}

/**
 * Models total borrowed relative indexing.
 *
 * The result is discriminated rather than `T | undefined`: an element may
 * legitimately be `undefined`, and a modeled `@region.array.get` must not
 * report a value that exists as a rejected index.
 */
export function get<T>(region: Region<T>, index: number): ReadResult<T> {
  const permit = live(region);
  if (!relativeIndex(permit, index)) return { tag: "out_of_bounds" };
  return { tag: "read", value: permit.store.cells[permit.start + index] };
}

/**
 * Models `@region.array.set`: a successful destructive write consumes one
 * permit and returns its exact successor. Failure returns the original permit.
 */
export function set<T>(
  region: Region<T>,
  index: number,
  value: T,
): UpdateResult<T> {
  const permit = live(region);
  if (!relativeIndex(permit, index)) {
    return { tag: "out_of_bounds", original: region };
  }
  const store = permit.store;
  const source = permit.id;
  store.cells[permit.start + index] = value;
  store.stats.writes += 1;
  const next = replace(permit);
  store.authorityEvents.push({
    tag: "transform",
    source,
    result: unwrap(next).id,
    operation: "@region.array.set",
  });
  assertInvariant(store);
  return { tag: "updated", region: next };
}

/**
 * Models `@region.array.swap`. Values move between slots without being copied,
 * which is the operation needed by in-place quicksort.
 */
export function swap<T>(
  region: Region<T>,
  left: number,
  right: number,
): UpdateResult<T> {
  const permit = live(region);
  if (!relativeIndex(permit, left) || !relativeIndex(permit, right)) {
    return { tag: "out_of_bounds", original: region };
  }
  const store = permit.store;
  const source = permit.id;
  const leftIndex = permit.start + left;
  const rightIndex = permit.start + right;
  const held = store.cells[leftIndex];
  store.cells[leftIndex] = store.cells[rightIndex];
  store.cells[rightIndex] = held;
  store.stats.swaps += 1;
  const next = replace(permit);
  store.authorityEvents.push({
    tag: "transform",
    source,
    result: unwrap(next).id,
    operation: "@region.array.swap",
  });
  assertInvariant(store);
  return { tag: "updated", region: next };
}

/**
 * Models `@region.array.freeze`.
 *
 * The full interval is not enough in this first model: it must also be the only
 * live permit for the origin. This deliberately catches forgotten empty
 * siblings produced by endpoint splits.
 */
export function freeze<T>(region: Region<T>): FrozenArray<T> {
  const permit = live(region);
  const store = permit.store;
  if (permit.start !== 0 || permit.end !== store.cells.length) {
    throw new RegionModelError(
      "REGION_FREEZE_PARTIAL",
      `cannot freeze [${permit.start},${permit.end}) of extent ${store.cells.length}`,
    );
  }
  if (store.live.size !== 1) {
    throw new RegionModelError(
      "REGION_FREEZE_ALIASES",
      `cannot freeze while ${store.live.size - 1} other permit(s) remain live`,
    );
  }
  const permitId = permit.id;
  consume(permit);
  store.authorityEvents.push({
    tag: "release",
    permit: permitId,
    operation: "@region.array.freeze",
  });
  const authorityCertificate: RegionAuthorityCertificate = {
    tag: "region-authority",
    schema: 1,
    events: [...store.authorityEvents],
  };
  return {
    backingId: store.id,
    stats: snapshotStats(store),
    authorityCertificate,
    authorityVerified: verifyRegionAuthorityCertificate(
      authorityCertificate,
      new Set([store.root]),
    ) !== null,
    values: [...store.cells],
  };
}

/** Test helper: a failed operation must leave this true. */
export function isLive<T>(region: Region<T>): boolean {
  return unwrap(region).alive;
}

export class RegionModelError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RegionModelError";
  }
}

function allocateStore<T>(
  values: readonly T[],
  acquisition: Acquisition,
): Store<T> {
  const id = nextStore++;
  return {
    id,
    root: `fresh-store:${id}`,
    cells: [...values],
    live: new Map(),
    stats: {
      acquisition,
      permitAllocations: 0,
      splits: 0,
      joins: 0,
      writes: 0,
      swaps: 0,
    },
    authorityEvents: [],
  };
}

function claimStore<T>(store: Store<T>): Region<T> {
  if (store.live.size !== 0 || store.authorityEvents.length !== 0) {
    throw new RegionModelError(
      "REGION_ROOT_ALREADY_CLAIMED",
      `Store ${store.id} already entered region authority`,
    );
  }
  const region = spawn(store, 0, store.cells.length);
  const permit = unwrap(region);
  store.authorityEvents.push({
    tag: "claim",
    root: store.root,
    origin: store.id,
    family: ARRAY_INTERVAL_FAMILY,
    permit: permit.id,
    operation: "@region.array.claim",
  });
  return region;
}

function spawn<T>(store: Store<T>, start: number, end: number): Region<T> {
  const permit: Permit<T> = {
    id: nextPermit++,
    store,
    start,
    end,
    alive: true,
  };
  store.live.set(permit.id, permit);
  store.stats.permitAllocations += 1;
  assertInvariant(store);
  return new RegionImpl(permit);
}

function replace<T>(permit: Permit<T>): Region<T> {
  const { store, start, end } = permit;
  consume(permit);
  return spawn(store, start, end);
}

function consume<T>(permit: Permit<T>): void {
  if (!permit.alive) {
    throw new RegionModelError(
      "REGION_USE_AFTER_CONSUME",
      `permit ${permit.id} has already been consumed`,
    );
  }
  permit.alive = false;
  permit.store.live.delete(permit.id);
}

function live<T>(region: Region<T>): Permit<T> {
  const permit = unwrap(region);
  if (!permit.alive || permit.store.live.get(permit.id) !== permit) {
    throw new RegionModelError(
      "REGION_USE_AFTER_CONSUME",
      `permit ${permit.id} has already been consumed`,
    );
  }
  return permit;
}

function unwrap<T>(region: Region<T>): Permit<T> {
  if (!(region instanceof RegionImpl)) {
    throw new RegionModelError(
      "REGION_FORGED",
      "region authority was not produced by the trusted model",
    );
  }
  return region.permit;
}

function liveOwned<T>(owned: OwnedStore<T>): OwnedStoreImpl<T> {
  const token = unwrapOwned(owned);
  if (!token.alive) {
    throw new RegionModelError(
      "REGION_STORE_ROOT_CONSUMED",
      `Store ${token.store.id} uniqueness root was already consumed`,
    );
  }
  return token;
}

function unwrapOwned<T>(owned: OwnedStore<T>): OwnedStoreImpl<T> {
  if (!(owned instanceof OwnedStoreImpl)) {
    throw new RegionModelError(
      "REGION_STORE_ROOT_FORGED",
      "unique Store evidence was not produced by the trusted model",
    );
  }
  return owned;
}

function relativeIndex<T>(permit: Permit<T>, index: number): boolean {
  return arrayIntervalFamily.contains(interval(permit), index);
}

function integer(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * Every live authority for one Store must be a well-formed region of that
 * Store, and no two may authorize the same location.
 *
 * Both halves are the family's rules rather than the model's: `valid` decides
 * what a region is and `disjoint` decides what simultaneous write authority
 * means, including how empty regions behave. Restating either here would let
 * the model and the family it claims to implement drift apart.
 */
function assertInvariant<T>(store: Store<T>): void {
  const permits = [...store.live.values()];
  for (const permit of permits) {
    if (!permit.alive) {
      throw new Error(`dead permit ${permit.id} remained in live set`);
    }
    if (!arrayIntervalFamily.valid(interval(permit))) {
      throw new Error(
        `invalid permit ${permit.id} [${permit.start},${permit.end})`,
      );
    }
  }
  if (!pairwiseDisjoint(arrayIntervalFamily, permits.map(interval))) {
    throw new Error(
      `overlapping live permits for Store ${store.id}: ${
        permits.map((permit) => `${permit.id} [${permit.start},${permit.end})`)
          .join(", ")
      }`,
    );
  }
}

/** The family region one permit authorizes. */
function interval<T>(permit: Permit<T>): IntervalRegion {
  return {
    origin: permit.store.id,
    start: permit.start,
    end: permit.end,
    extent: permit.store.cells.length,
  };
}

/**
 * A family law the model believed it had already established. Unlike a bounds
 * rejection this is not a program error the caller can recover from: it means
 * the model and the family disagree about the algebra.
 */
function requireFamily(
  held: boolean,
  operation: string,
  detail: string,
): void {
  if (held) return;
  throw new RegionModelError(
    "REGION_FAMILY_LAW",
    `${operation}: ${detail}`,
  );
}

/**
 * `acquisitionCopies` is derived from how the Store was obtained and how large
 * it actually is, rather than recorded by whichever call site allocated it. A
 * path that copied the wrong array, or copied twice, cannot report zero.
 */
function snapshotStats<T>(store: Store<T>): RegionStats {
  return {
    ...store.stats,
    acquisitionCopies: store.stats.acquisition === "copy"
      ? store.cells.length
      : 0,
  };
}
