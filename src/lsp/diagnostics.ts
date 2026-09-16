// Diagnostics orchestration: debounce, latest-only, round-robin, save-promote.
//
// Each open document funnels through one per-uri slot: typing re-arms a 150ms
// debounce, the timer hands the latest entry to a ready table, and flushes
// move ready entries onto the semantic lane in fair round-robin order. The
// lane holds at most one diagnostic job per uri, and the lane itself runs one
// active job, so a typing burst across many documents converges on one latest
// publication each without piling up. Save promotes the current entry at once
// instead of waiting out the debounce, and because diagnostics ride the
// semantic lane they never delay syntax-lane formatting.
//
// Freshness gates close the loop: the scheduler re-checks entry snapshots at
// dispatch and result arrival, and the orchestrator re-checks at publication,
// so only diagnostics for the current revision reach the client. Abandoned or
// failed jobs publish nothing: backend failures are never converted into
// synthetic diagnostics.

import type { CoordinatorDocuments, DocumentSnapshot } from "./documents.ts";
import type { Clock } from "./requests.ts";
import type { LaneTask, Scheduler, TraceSink } from "./scheduler.ts";
import { LSP_WORKER_PROTOCOL_VERSION } from "./workers/protocol.ts";
import type { LspWorkerResult } from "./workers/protocol.ts";

/** The debounce after typing before diagnostics are requested. */
export const DIAGNOSTICS_DEBOUNCE_MS = 150;

export interface DiagnosticsOrchestratorOptions {
  readonly clock: Clock;
  readonly documents: CoordinatorDocuments;
  readonly scheduler: Scheduler;
  readonly debounceMs?: number;
  readonly onTrace?: TraceSink;
  readonly publish: (
    uri: string,
    version: number,
    diagnostics: unknown,
  ) => void;
}

interface UriDiagnostics {
  timer: unknown;
  timerEntry: DocumentSnapshot | null;
  laneTask: LaneTask | null;
  laneToken: number;
}

/** Schedules one latest diagnostic job per open document, fairly. */
export class DiagnosticsOrchestrator {
  readonly #clock: Clock;
  readonly #documents: CoordinatorDocuments;
  readonly #scheduler: Scheduler;
  readonly #debounceMs: number;
  readonly #trace: TraceSink | undefined;
  readonly #publish: (
    uri: string,
    version: number,
    diagnostics: unknown,
  ) => void;
  readonly #states = new Map<string, UriDiagnostics>();
  readonly #ready = new Map<string, DocumentSnapshot>();
  #cursor: string | null = null;
  #tokens = 0;
  #closed = false;

  constructor(options: DiagnosticsOrchestratorOptions) {
    this.#clock = options.clock;
    this.#documents = options.documents;
    this.#scheduler = options.scheduler;
    this.#debounceMs = definedOr(options.debounceMs, DIAGNOSTICS_DEBOUNCE_MS);
    this.#trace = options.onTrace;
    this.#publish = options.publish;
  }

  /** Requests prompt diagnostics for a freshly opened document. */
  noteOpened(uri: string, entry: DocumentSnapshot): void {
    if (this.#closed) return;
    this.#emit("diagnostics/opened", { uri, version: entry.version });
    this.#schedule(uri, entry);
  }

  /** Re-arms the typing debounce with the latest entry. */
  noteChanged(uri: string, entry: DocumentSnapshot): void {
    if (this.#closed) return;
    const state = this.#stateFor(uri);
    if (state.timer !== undefined) this.#clock.clearTimeout(state.timer);
    state.timerEntry = entry;
    this.#emit("diagnostics/debounced", { uri, version: entry.version });
    state.timer = this.#clock.setTimeout(() => {
      state.timer = undefined;
      const latest = state.timerEntry;
      state.timerEntry = null;
      if (latest === null) return;
      this.#schedule(uri, latest);
    }, this.#debounceMs);
  }

  /** Promotes the current entry at once instead of waiting out typing. */
  noteSaved(uri: string, entry: DocumentSnapshot): void {
    if (this.#closed) return;
    const state = this.#stateFor(uri);
    if (state.timer !== undefined) {
      this.#clock.clearTimeout(state.timer);
      state.timer = undefined;
      state.timerEntry = null;
    }
    this.#emit("diagnostics/promoted", { uri, version: entry.version });
    this.#schedule(uri, entry);
  }

  /** Drops every pending diagnostic for a closed document. */
  noteClosed(uri: string): void {
    const state = this.#states.get(uri);
    if (state !== undefined && state.timer !== undefined) {
      this.#clock.clearTimeout(state.timer);
    }
    this.#states.delete(uri);
    this.#ready.delete(uri);
    if (this.#cursor === uri) this.#cursor = null;
    this.#emit("diagnostics/closed", { uri });
  }

  /** Stops timers and flushes for shutdown. The drain settles lane tasks. */
  shutdown(): void {
    this.#closed = true;
    for (const state of this.#states.values()) {
      if (state.timer !== undefined) this.#clock.clearTimeout(state.timer);
      state.timer = undefined;
      state.timerEntry = null;
    }
    this.#ready.clear();
  }

  /** Reads orchestrator shape for tests. */
  debugState(): { ready: readonly string[]; tasked: readonly string[] } {
    const tasked: string[] = [];
    for (const [uri, state] of this.#states) {
      if (state.laneTask !== null) tasked.push(uri);
    }
    return { ready: [...this.#ready.keys()], tasked };
  }

  #schedule(uri: string, entry: DocumentSnapshot): void {
    if (this.#closed) return;
    if (!this.#documents.isOpen(uri)) return;
    const state = this.#stateFor(uri);
    this.#ready.set(uri, entry);
    const held = state.laneTask;
    if (held !== null) {
      this.#scheduler.dropQueued(
        (task) => task === held,
        () => ({ kind: "result", value: null }),
      );
    }
    this.#flush();
  }

  #flush(): void {
    if (this.#closed || this.#ready.size === 0) return;
    for (const uri of this.#rotatedReady()) {
      const entry = this.#ready.get(uri);
      if (entry === undefined) continue;
      const state = this.#stateFor(uri);
      if (state.laneTask !== null) continue;
      if (!this.#documents.isFresh(entry)) {
        this.#ready.delete(uri);
        this.#emit("diagnostics/stale-ready", { uri });
        continue;
      }
      this.#tokens += 1;
      const token = this.#tokens;
      const task: LaneTask = {
        kind: "service/request",
        requestId: undefined,
        uri,
        entry,
        priority: false,
        build: (jobId: number) => ({
          protocol: LSP_WORKER_PROTOCOL_VERSION,
          job: jobId,
          kind: "service/request",
          method: "textDocument/diagnostic",
          uri,
          params: {},
        }),
        settle: (result: LspWorkerResult) => {
          this.#onTaskSettled(uri, token, entry, result);
        },
        abandon: () => {
          this.#onTaskAbandoned(uri, token);
        },
      };
      const accepted = this.#scheduler.enqueue(task, "semantic");
      if (!accepted) {
        this.#emit("diagnostics/retry", { uri });
        this.noteChanged(uri, entry);
        continue;
      }
      state.laneTask = task;
      state.laneToken = token;
      this.#ready.delete(uri);
      this.#cursor = uri;
      this.#emit("diagnostics/enqueued", { uri, version: entry.version });
    }
  }

  #onTaskSettled(
    uri: string,
    token: number,
    entry: DocumentSnapshot,
    result: LspWorkerResult,
  ): void {
    const state = this.#states.get(uri);
    if (state === undefined || state.laneToken !== token) return;
    state.laneTask = null;
    state.laneToken = 0;
    if (!result.ok) {
      this.#emit("diagnostics/dropped-error", { uri });
      this.#flush();
      return;
    }
    if (!this.#documents.isFresh(entry)) {
      this.#emit("diagnostics/stale-result", { uri });
      this.#flush();
      return;
    }
    this.#emit("diagnostics/published", { uri, version: entry.version });
    this.#publish(uri, entry.version, result.value);
    this.#flush();
  }

  #onTaskAbandoned(uri: string, token: number): void {
    const state = this.#states.get(uri);
    if (state === undefined || state.laneToken !== token) return;
    state.laneTask = null;
    state.laneToken = 0;
    this.#emit("diagnostics/abandoned", { uri });
    this.#flush();
  }

  #rotatedReady(): readonly string[] {
    const uris = [...this.#ready.keys()];
    if (this.#cursor === null) return uris;
    const at = uris.indexOf(this.#cursor);
    if (at < 0) return uris;
    return [...uris.slice(at + 1), ...uris.slice(0, at + 1)];
  }

  #stateFor(uri: string): UriDiagnostics {
    const existing = this.#states.get(uri);
    if (existing !== undefined) return existing;
    const fresh: UriDiagnostics = {
      timer: undefined,
      timerEntry: null,
      laneTask: null,
      laneToken: 0,
    };
    this.#states.set(uri, fresh);
    return fresh;
  }

  #emit(kind: string, detail: unknown): void {
    if (this.#trace === undefined) return;
    this.#trace({ at: this.#clock.now(), kind, detail });
  }
}

/** Returns the override when defined, even when it is zero. */
function definedOr(value: number | undefined, fallback: number): number {
  if (value !== undefined) return value;
  return fallback;
}
