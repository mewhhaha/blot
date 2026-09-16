// src/text/store.ts
//
// Open-document lifecycle plus immutable snapshots.
//
// Each open document carries three independent numbers:
// - version: the client-supplied LSP version. Versions order edits within one
//   open lifecycle but a client may reuse them after close/reopen, so a
//   version alone can never prove freshness.
// - lifecycle: a store-unique id minted by every open() call. A close/reopen
//   cycle (even one that reuses version 1) always yields a new lifecycle, so
//   comparing lifecycles rejects results computed for the previous
//   generation of the same URI.
// - revision: a store-global monotonic counter bumped by every mutation
//   (open, change, changeRanges). Within one lifecycle, revisions order
//   snapshots; across lifecycles they only ever increase.
//
// A DocumentSnapshot freezes one moment: uri, lifecycle, version, revision,
// and the immutable TextDocument. Providers must bind one snapshot at request
// start and derive everything downstream from it instead of re-reading the
// store mid-request; see sameDocumentRevision for the staleness check.

import {
  applyContentChanges,
  type ContentChange,
  TextDocument,
} from "./document.ts";

export interface DocumentSnapshot {
  readonly uri: string;
  readonly lifecycle: number;
  readonly version: number;
  readonly revision: number;
  readonly document: TextDocument;
}

interface StoreEntry {
  readonly lifecycle: number;
  snapshot: DocumentSnapshot;
}

export class DocumentStore {
  readonly #entries = new Map<string, StoreEntry>();
  #nextLifecycle = 1;
  #nextRevision = 1;

  open(uri: string, source: string, version: number): DocumentSnapshot {
    const lifecycle = this.#nextLifecycle;
    this.#nextLifecycle += 1;
    const snapshot: DocumentSnapshot = Object.freeze({
      uri,
      lifecycle,
      version,
      revision: this.#claimRevision(),
      document: new TextDocument(source),
    });
    this.#entries.set(uri, { lifecycle, snapshot });
    return snapshot;
  }

  change(uri: string, source: string, version: number): DocumentSnapshot {
    const entry = this.#requiredEntry(uri);
    this.#requireNextVersion(uri, entry.snapshot.version, version);
    const snapshot: DocumentSnapshot = Object.freeze({
      uri,
      lifecycle: entry.lifecycle,
      version,
      revision: this.#claimRevision(),
      document: new TextDocument(source),
    });
    entry.snapshot = snapshot;
    return snapshot;
  }

  changeRanges(
    uri: string,
    changes: readonly ContentChange[],
    version: number,
  ): DocumentSnapshot {
    const entry = this.#requiredEntry(uri);
    this.#requireNextVersion(uri, entry.snapshot.version, version);
    const source = applyContentChanges(
      entry.snapshot.document.source,
      changes,
      uri,
    );
    const snapshot: DocumentSnapshot = Object.freeze({
      uri,
      lifecycle: entry.lifecycle,
      version,
      revision: this.#claimRevision(),
      document: new TextDocument(source),
    });
    entry.snapshot = snapshot;
    return snapshot;
  }

  close(uri: string): void {
    this.#entries.delete(uri);
  }

  clear(): void {
    this.#entries.clear();
  }

  snapshot(uri: string): DocumentSnapshot | null {
    const entry = this.#entries.get(uri);
    if (entry === undefined) return null;
    return entry.snapshot;
  }

  version(uri: string): number | null {
    const entry = this.#entries.get(uri);
    if (entry === undefined) return null;
    return entry.snapshot.version;
  }

  snapshots(): readonly DocumentSnapshot[] {
    return [...this.#entries.values()].map((entry) => entry.snapshot);
  }

  #claimRevision(): number {
    const revision = this.#nextRevision;
    this.#nextRevision += 1;
    return revision;
  }

  #requiredEntry(uri: string): StoreEntry {
    const entry = this.#entries.get(uri);
    if (entry === undefined) {
      throw new Error(`document ${uri} is not open`);
    }
    return entry;
  }

  #requireNextVersion(uri: string, current: number, next: number): void {
    if (next <= current) {
      throw new Error(
        `document ${uri} version ${next} does not follow ${current}`,
      );
    }
  }
}

// True when both snapshots describe the same revision of the same open
// lifecycle. Honest call sites compare snapshots of one uri; the uri check
// keeps cross-document misuse false instead of silently true. A
// close/reopen that reuses the LSP version still compares false because the
// lifecycle differs.
export function sameDocumentRevision(
  left: DocumentSnapshot,
  right: DocumentSnapshot,
): boolean {
  return left.uri === right.uri &&
    left.lifecycle === right.lifecycle &&
    left.revision === right.revision;
}
