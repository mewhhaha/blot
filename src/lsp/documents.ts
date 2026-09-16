// Coordinator-side documents over the shared document store.
//
// The coordinator tracks the same immutable snapshots the language service
// binds: P1's DocumentStore owns text, lifecycles, versions, and revisions,
// and sameDocumentRevision decides freshness. There is exactly one snapshot
// model; the coordinator must not invent another.
//
// The coordinator keeps its own store rather than borrowing the service's:
// in worker-backed mode no local service exists, and the store doubles as
// the resync source that replays full text into a reconstructed replica. In
// inline mode the coordinator and the service apply the same validated
// changes in the same order, so their texts agree while each layer compares
// only its own lifecycles and revisions.
//
// A closed document has no entry: absence means stale everywhere. Close plus
// reopen mints a new lifecycle, so reused versions still invalidate
// in-flight snapshots from the previous generation.

import type { ContentChange } from "../text/document.ts";
import {
  type DocumentSnapshot,
  DocumentStore,
  sameDocumentRevision,
} from "../text/store.ts";

export type { DocumentSnapshot } from "../text/store.ts";
export { sameDocumentRevision } from "../text/store.ts";

/** Open documents plus freshness answers for the scheduler lanes. */
export class CoordinatorDocuments {
  readonly #store = new DocumentStore();

  /** Records a didOpen and returns its snapshot. */
  open(uri: string, text: string, version: number): DocumentSnapshot {
    return this.#store.open(uri, text, version);
  }

  /** Applies validated didChange content and returns its snapshot. */
  change(
    uri: string,
    changes: readonly ContentChange[],
    version: number,
  ): DocumentSnapshot {
    return this.#store.changeRanges(uri, changes, version);
  }

  /** Records a didClose; the uri reads stale from here on. */
  close(uri: string): void {
    this.#store.close(uri);
  }

  /** Reads the current snapshot, or null when closed or never seen. */
  current(uri: string): DocumentSnapshot | null {
    return this.#store.snapshot(uri);
  }

  /** True when the uri is currently open. */
  isOpen(uri: string): boolean {
    return this.#store.snapshot(uri) !== null;
  }

  /** True when the entry snapshot still names the current revision. */
  isFresh(entry: DocumentSnapshot): boolean {
    const current = this.#store.snapshot(entry.uri);
    if (current === null) return false;
    return sameDocumentRevision(current, entry);
  }

  /** Every open snapshot, for replica resync after reconstruction. */
  snapshots(): readonly DocumentSnapshot[] {
    return this.#store.snapshots();
  }
}
