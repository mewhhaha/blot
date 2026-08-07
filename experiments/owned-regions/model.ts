import {
  type RegionAuthorityCertificate,
  type RegionAuthorityEvent,
  verifyRegionAuthorityCertificate,
} from "../../src/linear/region_certificate.ts";

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
const ARRAY_INTERVAL_FAMILY = "array-interval-v1";

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

export interface RegionStats {
  readonly storeAllocations: number;
  /** Elements copied while acquiring a private Store from shared input. */
  readonly acquisitionCopies: number;
  readonly permitAllocations: number;
  readonly splits: number;
  readonly joins: number;
  readonly writes: number;
  readonly swaps: number;
  /** Element copies caused after acquisition by region operations. */
  readonly elementCopies: number;
}

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

export type UpdateResult<T> =
  | { readonly tag: "updated"; readonly region: Region<T> }
  | { readonly tag: "out_of_bounds"; readonly original: Region<T> };

interface MutableStats {
  storeAllocations: number;
  acquisitionCopies: number;
  permitAllocations: number;
  splits: number;
  joins: number;
  writes: number;
  swaps: number;
  elementCopies: number;
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
  return claimStore(allocateStore(values, values.length));
}

/**
 * Creates model-only unique Store provenance. Think of this as a fresh array
 * allocation whose identity the compiler still owns, before it becomes an
 * ordinary shareable source value.
 */
export function freshOwned<T>(values: readonly T[]): OwnedStore<T> {
  return new OwnedStoreImpl(allocateStore(values, 0));
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

/** Models total borrowed relative indexing. */
export function get<T>(region: Region<T>, index: number): T | undefined {
  const permit = live(region);
  if (!relativeIndex(permit, index)) return undefined;
  return permit.store.cells[permit.start + index];
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
    stats: snapshotStats(store.stats),
    authorityCertificate,
    authorityVerified:
      verifyRegionAuthorityCertificate(
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
  acquisitionCopies: number,
): Store<T> {
  const id = nextStore++;
  return {
    id,
    root: `fresh-store:${id}`,
    cells: [...values],
    live: new Map(),
    stats: {
      storeAllocations: 1,
      acquisitionCopies,
      permitAllocations: 0,
      splits: 0,
      joins: 0,
      writes: 0,
      swaps: 0,
      elementCopies: 0,
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
  return integer(index) && index >= 0 && index < permit.end - permit.start;
}

function integer(value: number): boolean {
  return Number.isSafeInteger(value);
}

function assertInvariant<T>(store: Store<T>): void {
  const permits = [...store.live.values()];
  for (const permit of permits) {
    if (!permit.alive) {
      throw new Error(`dead permit ${permit.id} remained in live set`);
    }
    if (
      !integer(permit.start) || !integer(permit.end) ||
      permit.start < 0 || permit.start > permit.end ||
      permit.end > store.cells.length
    ) {
      throw new Error(
        `invalid permit ${permit.id} [${permit.start},${permit.end})`,
      );
    }
  }
  for (let left = 0; left < permits.length; left += 1) {
    for (let right = left + 1; right < permits.length; right += 1) {
      const a = permits[left];
      const b = permits[right];
      // Empty permits authorize no location and may share an endpoint/range.
      if (a.start === a.end || b.start === b.end) continue;
      if (a.end <= b.start || b.end <= a.start) continue;
      throw new Error(
        `overlapping live permits ${a.id} [${a.start},${a.end}) and ` +
          `${b.id} [${b.start},${b.end})`,
      );
    }
  }
}

function snapshotStats(stats: MutableStats): RegionStats {
  return { ...stats };
}
