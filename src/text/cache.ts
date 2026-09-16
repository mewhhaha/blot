// src/text/cache.ts
//
// Bounded content-keyed caches for syntax and analysis results.
//
// Keys combine content identity (see contentId in ./document.ts) with an
// optional scope. Syntax entries add the frontend identity as their scope so
// a frontend change cannot serve snapshots parsed by another frontend;
// analysis entries use content alone. Revisions and LSP versions are NOT
// part of the key: identical content yields identical results whatever
// revision produced it, which is what makes version reuse after close/reopen
// safe and lets undo/redo hit the cache.
//
// Each entry records the revision that stored it. Concurrent dispatches can
// arrive out of order, so set() refuses to overwrite a newer slot with an
// older revision's result: a stale result must never displace a newer one.
// Callers store the pending promise at dispatch time (not the settled value
// at completion) so the guard orders by dispatch, and the cache itself never
// observes promise settlement.
//
// The cache is LRU-bounded: setting past capacity evicts the
// least-recently-used entry. Gets refresh recency. Lookups verify full
// source equality, so a contentId hash collision degrades to a miss instead
// of serving another document's result.

import { contentId } from "./document.ts";

// Identifies the syntax frontend whose output fills syntax caches. It must
// change whenever the syntax pipeline changes; P2 wires it to the real
// compiler-artifact input identity (compilerInputsSha256 in
// generated/compiler/compiler-artifact.json). Within one process the
// artifact is fixed, so a constant is correct for P1.
export const SYNTAX_FRONTEND_ID = "blot-syntax-frontend/1";

export function syntaxCacheKey(source: string, frontendId: string): string {
  return `${frontendId}\n${contentId(source)}`;
}

export function analysisCacheKey(source: string): string {
  return contentId(source);
}

interface CacheEntry<Value> {
  readonly revision: number;
  readonly source: string;
  readonly value: Value;
}

export class ContentCache<Value> {
  readonly #entries = new Map<string, CacheEntry<Value>>();
  readonly #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `content cache capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string, source: string): Value | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.source !== source) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  // Stores value only when no newer revision already holds the slot. A
  // same-revision overwrite replaces the entry; an older revision never
  // displaces a newer one.
  set(key: string, source: string, revision: number, value: Value): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.revision > revision) return;
    this.#entries.delete(key);
    this.#entries.set(key, { revision, source, value });
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
