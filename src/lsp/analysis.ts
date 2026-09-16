// Shared semantic analysis values for the Blot language service.
//
// One AnalysisResult per revision carries everything the editor features
// need: the snapshot workspace identity (uri, lifecycle, revision, workspace
// epoch, overlay manifest digest), the semantic facts or a structured source
// failure, the root-inclusive dependency closure the computation observed,
// and the measured host-side phase work. Diagnostics, hover, completion,
// inlay hints, and the remaining semantic details all subscribe to one
// in-flight computation per key: duplicate same-key analysis is one shared
// promise with multiple subscribers.
//
// Invalidation is lazy and precise. Every overlay, disk, or configuration
// change bumps the monotonic workspace epoch and appends its absolute paths
// to the bounded epoch log. A settled cache entry stays valid while no
// logged change since its epoch touches its dependency closure (read from
// the existing WorkspaceGraph via Compiler.workspaceClosure, never a second
// resolver). Entries with an unknown closure (load failures, truncated log)
// fall back to the coarse rule: any change since their epoch invalidates.
// The revision guard from src/text/cache.ts is preserved: a stale result
// never displaces a newer slot, and stale completions are dropped at settle
// time instead of served.
//
// Structured source failures (BlotError, LoadError) cache as results like
// successes; canceled or infrastructure-failed promises are shared
// in-flight but never served from the cache afterwards.

import type { CompilerAnalysis } from "../compiler.ts";
import type { Diagnostic } from "../diagnostic.ts";
import { contentId } from "../text/document.ts";

/** One unsaved document as the compiler workspace sees it. */
export interface OverlayEntry {
  readonly uri: string;
  readonly path: string;
  readonly version: number;
  readonly contentId: string;
}

/**
 * An immutable capture of every open overlay at request time, sorted by
 * path. The service synchronizes the full manifest before semantic
 * analysis so the requested root sees every relevant unsaved overlay, not
 * just its own text.
 */
export interface OverlayManifest {
  readonly epoch: number;
  readonly entries: readonly OverlayEntry[];
}

export interface ManifestSnapshot {
  readonly uri: string;
  readonly path: string;
  readonly version: number;
  readonly source: string;
}

/** Captures one frozen manifest over the given open snapshots. */
export function captureOverlayManifest(
  snapshots: readonly ManifestSnapshot[],
  epoch: number,
): OverlayManifest {
  const entries = snapshots.map((snapshot) =>
    Object.freeze({
      uri: snapshot.uri,
      path: snapshot.path,
      version: snapshot.version,
      contentId: contentId(snapshot.source),
    })
  ).toSorted((left, right) => {
    if (left.path !== right.path) {
      if (left.path < right.path) return -1;
      return 1;
    }
    if (left.uri !== right.uri) {
      if (left.uri < right.uri) return -1;
      return 1;
    }
    return 0;
  });
  return Object.freeze({ epoch, entries: Object.freeze(entries) });
}

/** A stable digest naming one manifest for cache values and traces. */
export function overlayManifestDigest(manifest: OverlayManifest): string {
  return manifest.entries.map((entry) =>
    `${entry.path}\n${entry.version}\n${entry.contentId}`
  ).join("\n");
}

/**
 * Diffs one manifest against the previously synchronized one. Returns the
 * entries to stage (new or changed content) in manifest order. Removals
 * are owned by close, which clears overlays eagerly, so they need no
 * staging here.
 */
export function diffOverlayManifest(
  previous: OverlayManifest | null,
  current: OverlayManifest,
): readonly OverlayEntry[] {
  const synced = new Map<string, OverlayEntry>();
  if (previous !== null) {
    for (const entry of previous.entries) synced.set(entry.path, entry);
  }
  return current.entries.filter((entry) => {
    const known = synced.get(entry.path);
    return known === undefined ||
      known.contentId !== entry.contentId ||
      known.version !== entry.version;
  });
}

/** Host-measured phase work behind one analysis computation. */
export interface AnalysisWork {
  /** Milliseconds spent synchronizing overlays before the analysis ran. */
  readonly syncMs: number;
  /** Milliseconds spent inside the compiler analysis call. */
  readonly analysisMs: number;
}

/** A structured source failure: diagnostics with real source evidence. */
export interface AnalysisSourceFailure {
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The one shared semantic value per revision. Exactly one of `analysis`
 * and `failure` is non-null. `dependencies` is the root-inclusive closure
 * the computation observed, or null when the failure happened before the
 * graph was known; null forces coarse invalidation.
 */
export interface AnalysisResult {
  readonly uri: string;
  readonly lifecycle: number;
  readonly revision: number;
  readonly workspaceEpoch: number;
  readonly manifestDigest: string;
  readonly analysis: CompilerAnalysis | null;
  readonly failure: AnalysisSourceFailure | null;
  readonly dependencies: readonly string[] | null;
  readonly work: AnalysisWork;
}

/**
 * Builds one successful result. Callers pass the closure the compiler
 * reported after the analysis completed.
 */
export function successfulAnalysis(
  identity: {
    readonly uri: string;
    readonly lifecycle: number;
    readonly revision: number;
    readonly workspaceEpoch: number;
    readonly manifestDigest: string;
  },
  analysis: CompilerAnalysis,
  dependencies: readonly string[],
  work: AnalysisWork,
): AnalysisResult {
  return {
    ...identity,
    analysis,
    failure: null,
    dependencies: [...dependencies],
    work,
  };
}

/** Builds one structured source-failure result. */
export function failedAnalysis(
  identity: {
    readonly uri: string;
    readonly lifecycle: number;
    readonly revision: number;
    readonly workspaceEpoch: number;
    readonly manifestDigest: string;
  },
  failure: AnalysisSourceFailure,
  dependencies: readonly string[] | null,
  work: AnalysisWork,
): AnalysisResult {
  let closure: readonly string[] | null = null;
  if (dependencies !== null) closure = [...dependencies];
  return {
    ...identity,
    analysis: null,
    failure,
    dependencies: closure,
    work,
  };
}

/**
 * How one computation settled. Successes and structured source failures
 * serve from the cache while their closure is quiet; infrastructure
 * failures (canceled or crashed work) are shared in-flight but never
 * served afterwards.
 */
export type DependencyOutcome =
  | "ok"
  | "source-failure"
  | "infrastructure-failure";

type EntryStatus =
  | { readonly settled: false }
  | { readonly settled: true; readonly outcome: DependencyOutcome };

interface DependencyEntry<Value> {
  readonly revision: number;
  readonly epoch: number;
  readonly source: string;
  readonly root: string;
  readonly value: Promise<Value>;
  status: EntryStatus;
  dependencies: readonly string[] | null;
}

export interface DependencyCacheSettled {
  readonly revision: number;
  readonly dependencies: readonly string[] | null;
  readonly outcome: DependencyOutcome;
}

/**
 * A bounded content-keyed cache of in-flight or settled promises with
 * dependency-aware lazy invalidation.
 *
 * Keys name content alone (see analysisCacheKey in ../text/cache.ts), so
 * repeated or restored content hits across revisions while every distinct
 * edit fills one slot. Lookups verify full source equality, so a contentId
 * hash collision degrades to a miss. Setting past capacity evicts the
 * least-recently-used entry; gets refresh recency.
 *
 * Freshness: `get` takes the paths changed since the entry's epoch (null
 * when the epoch log no longer reaches it). In-flight entries are always
 * shared; settled entries are served only when no change touches their
 * closure, or when nothing changed at all for unknown closures. The
 * revision guard refuses to overwrite a newer slot with an older
 * revision's computation, so stale completions never displace newer
 * results; callers drop them via `delete` instead.
 */
export class DependencyCache<Value> {
  readonly #entries = new Map<string, DependencyEntry<Value>>();
  readonly #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `dependency cache capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /**
   * Reads one entry. `changedSinceEpoch` reports the paths changed since
   * the entry's epoch, or null when that is unknowable. Returns undefined
   * on any miss: absent, source mismatch, infrastructure failure, or an
   * unknown or touched closure.
   */
  get(
    key: string,
    source: string,
    changedSinceEpoch: (epoch: number) => ReadonlySet<string> | null,
  ): Promise<Value> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.source !== source) return undefined;
    if (
      entry.status.settled &&
      entry.status.outcome === "infrastructure-failure"
    ) return undefined;
    if (entry.status.settled) {
      const changed = changedSinceEpoch(entry.epoch);
      if (changed === null) return undefined;
      if (entry.dependencies === null) {
        if (changed.size > 0) return undefined;
      } else {
        // The root's bytes already matched above, so only non-root
        // dependency changes invalidate; the root stays in the closure so
        // settle guards and traces name the full observed input set.
        for (const dependency of entry.dependencies) {
          if (dependency !== entry.root && changed.has(dependency)) {
            return undefined;
          }
        }
      }
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /**
   * Stores a computation only when no newer revision already holds the
   * slot. A same-revision overwrite replaces the entry; an older revision
   * never displaces a newer one.
   */
  set(
    key: string,
    source: string,
    revision: number,
    epoch: number,
    root: string,
    value: Promise<Value>,
  ): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.revision > revision) return;
    this.#entries.delete(key);
    this.#entries.set(key, {
      revision,
      epoch,
      source,
      root,
      value,
      status: { settled: false },
      dependencies: null,
    });
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /**
   * Records how one computation settled. Applies only when the slot still
   * holds the same revision, so a superseding dispatch keeps its own meta.
   */
  noteSettled(
    key: string,
    revision: number,
    settled: DependencyCacheSettled,
  ): void {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.revision !== revision) return;
    entry.status = { settled: true, outcome: settled.outcome };
    entry.dependencies = settled.dependencies;
  }

  /**
   * Drops the slot only when it still holds the given revision. Settle
   * guards use this to discard stale completions without touching a newer
   * dispatch that reused the key.
   */
  delete(key: string, revision: number): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.revision !== revision) return false;
    this.#entries.delete(key);
    return true;
  }

  clear(): void {
    this.#entries.clear();
  }
}
