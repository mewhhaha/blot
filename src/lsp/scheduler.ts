// Two foreground lanes over worker hosts, with watchdog and generations.
//
// The syntax lane serves fast foreground methods and the semantic lane serves
// deep methods; each lane is a serial foreground queue over its own host, and
// the scheduler never has more than one active job per host. Jobs whose kind
// the preferred host does not offer overflow through the other lane, so a
// syntax worker without a Compiler never sees service work.
//
// Freshness gates run before dispatch and at result arrival: entry snapshots
// are re-checked against the ledger, and stale work settles ContentModified
// instead of running or publishing. Deadlines arrive from the registry; the
// watchdog gives obsolete work a bounded grace and then terminates plus
// reconstructs the host, bumping the lane generation so older results are
// discarded. Crashes fail the active task explicitly, hold the queue,
// reconstruct, resync through the server callback, and resume.

import type { CoordinatorDocuments, DocumentSnapshot } from "./documents.ts";
import {
  backendFailure,
  JsonRpcError,
  resourceFailure,
  workerFailure,
} from "./errors.ts";
import type { RequestId } from "./errors.ts";
import type { LspWorkerHost } from "./hosts.ts";
import type { Clock, RequestRegistry, Settlement } from "./requests.ts";
import type {
  LspWorkerJob,
  LspWorkerJobKind,
  LspWorkerResult,
} from "./workers/protocol.ts";
import { lspWorkerResult } from "./workers/protocol.ts";

/** Which lane a task belongs to. */
export type LaneName = "syntax" | "semantic";

/** A trace event. Sinks must not throw. */
export interface TraceEvent {
  readonly at: number;
  readonly kind: string;
  readonly detail: unknown;
}

/** Receives coordinator trace events. */
export type TraceSink = (event: TraceEvent) => void;

/**
 * One schedulable unit. Requests carry their registry id; internal jobs such
 * as diagnostics and replica sync carry undefined and settle through their
 * own callbacks. settle runs only for fresh results; abandon finishes the
 * task with an explicit settlement the registry may still convert.
 */
export interface LaneTask {
  readonly kind: LspWorkerJobKind;
  readonly requestId: RequestId | undefined;
  readonly uri: string | null;
  readonly entry: DocumentSnapshot | null;
  readonly priority: boolean;
  readonly build: (jobId: number) => LspWorkerJob;
  readonly settle: (result: LspWorkerResult) => void;
  readonly abandon: (settlement: Settlement) => void;
}

export interface SchedulerOptions {
  readonly clock: Clock;
  readonly documents: CoordinatorDocuments;
  readonly registry: RequestRegistry;
  readonly syntaxHost: LspWorkerHost;
  readonly semanticHost: LspWorkerHost;
  readonly maxPendingPerLane?: number;
  readonly obsoleteGraceMs?: number;
  readonly onTrace?: TraceSink;
  readonly onLaneReconstructed?: (lane: LaneName) => void;
}

/** Assigns a method to its lane. Unknown methods never reach the lanes. */
export function laneForMethod(method: string): LaneName {
  switch (method) {
    case "textDocument/completion":
    case "textDocument/signatureHelp":
    case "textDocument/documentSymbol":
    case "workspace/symbol":
    case "textDocument/formatting":
    case "textDocument/inlayHint":
    case "textDocument/codeAction":
      return "syntax";
    default:
      return "semantic";
  }
}

/** True for replica-sync jobs, which are never dropped as stale. */
export function isDocTask(task: LaneTask): boolean {
  return task.kind === "doc/open" ||
    task.kind === "doc/change" ||
    task.kind === "doc/close";
}

interface ActiveTask {
  readonly task: LaneTask;
  readonly jobId: number;
  readonly generation: number;
  obsolete: boolean;
  graceHandle: unknown;
}

export interface LaneStats {
  readonly queued: number;
  readonly active: boolean;
  readonly generation: number;
}

/** The default bound on queued work per lane. Priority sync bypasses it. */
export const DEFAULT_MAX_PENDING_PER_LANE = 128;

/** The default grace for obsolete work before terminate-plus-reconstruct. */
export const DEFAULT_OBSOLETE_GRACE_MS = 1_000;

const SHUTDOWN_DRAIN_POLL_MS = 0;

/** Schedules lane tasks onto worker hosts with freshness and watchdogry. */
export class Scheduler {
  readonly #clock: Clock;
  readonly #documents: CoordinatorDocuments;
  readonly #registry: RequestRegistry;
  readonly #hosts: Record<LaneName, LspWorkerHost>;
  readonly #maxPending: number;
  readonly #graceMs: number;
  readonly #trace: TraceSink | undefined;
  readonly #onLaneReconstructed: ((lane: LaneName) => void) | undefined;
  readonly #queues: Record<
    LaneName,
    { priority: LaneTask[]; normal: LaneTask[] }
  >;
  readonly #active: Record<LaneName, ActiveTask | undefined>;
  readonly #generations: Record<LaneName, number>;
  readonly #pumping: Record<LaneName, boolean>;
  readonly #reconstructing: Record<LaneName, boolean>;
  readonly #unsubscribes: (() => void)[] = [];
  #jobSequence = 0;
  #draining = false;

  constructor(options: SchedulerOptions) {
    this.#clock = options.clock;
    this.#documents = options.documents;
    this.#registry = options.registry;
    this.#hosts = {
      syntax: options.syntaxHost,
      semantic: options.semanticHost,
    };
    this.#maxPending = definedOr(
      options.maxPendingPerLane,
      DEFAULT_MAX_PENDING_PER_LANE,
    );
    this.#graceMs = definedOr(
      options.obsoleteGraceMs,
      DEFAULT_OBSOLETE_GRACE_MS,
    );
    this.#trace = options.onTrace;
    this.#onLaneReconstructed = options.onLaneReconstructed;
    this.#queues = {
      syntax: { priority: [], normal: [] },
      semantic: { priority: [], normal: [] },
    };
    this.#active = { syntax: undefined, semantic: undefined };
    this.#generations = { syntax: 0, semantic: 0 };
    this.#pumping = { syntax: false, semantic: false };
    this.#reconstructing = { syntax: false, semantic: false };
    for (const lane of ["syntax", "semantic"] as const) {
      const host = this.#hosts[lane];
      this.#unsubscribes.push(
        host.onResult((result: unknown) => this.#onRawResult(lane, result)),
      );
      this.#unsubscribes.push(
        host.onError((error: Error) => {
          void this.#onHostError(lane, error);
        }),
      );
    }
  }

  /**
   * Enqueues a task on its preferred lane, overflowing to the other lane
   * when the preferred host does not offer the kind. Returns false when no
   * host offers the kind or the executing lane is past its bound; the task
   * is abandoned with an explicit failure either way.
   */
  enqueue(task: LaneTask, preferred: LaneName): boolean {
    if (this.#draining) {
      if (task.requestId === undefined) {
        task.abandon({ kind: "result", value: null });
      } else {
        task.abandon({
          kind: "error",
          error: resourceFailure("server is shutting down"),
        });
      }
      return false;
    }
    let lane = preferred;
    if (!this.#hosts[lane].offered(task.kind)) {
      const other = otherLane(lane);
      if (!this.#hosts[other].offered(task.kind)) {
        this.#emit("lane/unoffered", { lane, kind: task.kind });
        task.abandon({
          kind: "error",
          error: resourceFailure(`no worker offers ${task.kind}`),
        });
        return false;
      }
      this.#emit("lane/overflow", {
        from: lane,
        to: other,
        kind: task.kind,
      });
      lane = other;
    }
    if (!task.priority && this.#queued(lane) >= this.#maxPending) {
      this.#emit("lane/overload", { lane, kind: task.kind });
      task.abandon({
        kind: "error",
        error: resourceFailure(
          `${lane} lane holds ${this.#maxPending} queued jobs`,
        ),
      });
      return false;
    }
    if (task.priority) this.#queues[lane].priority.push(task);
    else this.#queues[lane].normal.push(task);
    this.#emit("lane/enqueue", {
      lane,
      preferred,
      kind: task.kind,
      requestId: task.requestId,
    });
    this.pump();
    return true;
  }

  /**
   * Drops queued tasks that match, settling each through its abandon path.
   * The active task is never dropped: it finishes and the settlement maps.
   */
  dropQueued(
    matches: (task: LaneTask) => boolean,
    settlementFor: (task: LaneTask) => Settlement,
  ): number {
    let dropped = 0;
    for (const lane of ["syntax", "semantic"] as const) {
      const queues = this.#queues[lane];
      for (const side of ["priority", "normal"] as const) {
        const kept: LaneTask[] = [];
        for (const task of queues[side]) {
          if (!matches(task)) {
            kept.push(task);
            continue;
          }
          dropped += 1;
          this.#emit("lane/drop", {
            lane,
            kind: task.kind,
            requestId: task.requestId,
          });
          task.abandon(settlementFor(task));
        }
        queues[side] = kept;
      }
    }
    if (dropped > 0) this.pump();
    return dropped;
  }

  /** Drops queued non-sync work for one document after invalidation. */
  dropUriTasks(uri: string): number {
    return this.dropQueued(
      (task) => task.uri === uri && !isDocTask(task),
      () => ({ kind: "result", value: null }),
    );
  }

  /**
   * Notes a registry deadline. Pending tasks are dropped; their settlement
   * already happened. Active tasks get a bounded obsolete grace, then the
   * host is terminated plus reconstructed.
   */
  noteExpired(requestId: RequestId): void {
    for (const lane of ["syntax", "semantic"] as const) {
      const queues = this.#queues[lane];
      for (const side of ["priority", "normal"] as const) {
        const kept: LaneTask[] = [];
        for (const task of queues[side]) {
          if (task.requestId !== requestId) {
            kept.push(task);
            continue;
          }
          this.#emit("lane/expired-pending", { lane, requestId });
          task.abandon({ kind: "result", value: null });
        }
        queues[side] = kept;
      }
      const active = this.#active[lane];
      if (active !== undefined && active.task.requestId === requestId) {
        this.#markObsolete(lane, active);
      }
    }
    this.pump();
  }

  /** Drives both lanes. Safe to call from any completion path. */
  pump(): void {
    void this.#pumpLane("syntax");
    void this.#pumpLane("semantic");
  }

  /**
   * Drains foreground work within a bound, then terminates the hosts.
   * Queued requests settle with a shutdown failure when the bound lapses;
   * internal jobs are dropped. Resolves once the hosts are terminated.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.#draining = true;
    const deadline = this.#clock.now() + timeoutMs;
    while (this.#hasWork()) {
      if (this.#clock.now() >= deadline) break;
      await sleepReal(SHUTDOWN_DRAIN_POLL_MS);
    }
    this.dropQueued(
      () => true,
      (task) => {
        if (task.requestId === undefined) {
          return { kind: "result", value: null };
        }
        return {
          kind: "error",
          error: resourceFailure("server is shutting down"),
        };
      },
    );
    const activeLanes = (["syntax", "semantic"] as const).filter((lane) =>
      this.#active[lane] !== undefined
    );
    for (const lane of activeLanes) {
      const active = this.#active[lane];
      if (active === undefined) continue;
      this.#clearGrace(active);
      this.#active[lane] = undefined;
      this.#generations[lane] += 1;
      if (active.task.requestId === undefined) {
        active.task.abandon({ kind: "result", value: null });
      } else {
        active.task.abandon({
          kind: "error",
          error: resourceFailure("server is shutting down"),
        });
      }
    }
    await this.#hosts.syntax.terminate();
    await this.#hosts.semantic.terminate();
    this.#emit("lane/drained", {});
  }

  /** Reads one lane for tests and traces. */
  laneStats(lane: LaneName): LaneStats {
    return {
      queued: this.#queued(lane),
      active: this.#active[lane] !== undefined,
      generation: this.#generations[lane],
    };
  }

  /** Unsubscribes host listeners and clears grace timers. */
  dispose(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
    for (const lane of ["syntax", "semantic"] as const) {
      const active = this.#active[lane];
      if (active !== undefined) this.#clearGrace(active);
    }
  }

  async #pumpLane(lane: LaneName): Promise<void> {
    if (this.#pumping[lane]) return;
    this.#pumping[lane] = true;
    try {
      while (
        this.#active[lane] === undefined &&
        !this.#reconstructing[lane] && this.#queued(lane) > 0
      ) {
        const task = this.#shift(lane);
        if (task === undefined) break;
        const dispatched = await this.#dispatch(lane, task);
        if (!dispatched) break;
        if (this.#active[lane] !== undefined) break;
      }
    } finally {
      this.#pumping[lane] = false;
      if (
        this.#active[lane] === undefined &&
        !this.#reconstructing[lane] && this.#queued(lane) > 0
      ) {
        void this.#pumpLane(lane);
      }
    }
  }

  async #dispatch(lane: LaneName, task: LaneTask): Promise<boolean> {
    if (task.requestId !== undefined && !this.#requestLive(task)) {
      this.#emit("lane/drop-settled", { lane, requestId: task.requestId });
      return true;
    }
    if (
      task.requestId !== undefined && this.#requestSuperseded(task.requestId)
    ) {
      this.#emit("lane/drop-superseded", { lane, requestId: task.requestId });
      task.abandon({ kind: "result", value: null });
      return true;
    }
    if (
      !isDocTask(task) && task.entry !== null &&
      !this.#documents.isFresh(task.entry)
    ) {
      this.#emit("lane/stale", { lane, kind: task.kind });
      if (task.requestId !== undefined) {
        this.#registry.markInvalidated(task.requestId);
        task.abandon({ kind: "result", value: null });
      } else {
        task.abandon({ kind: "result", value: null });
      }
      return true;
    }
    const host = this.#hosts[lane];
    try {
      await host.start();
    } catch (error) {
      this.#emit("lane/startup-failure", {
        lane,
        detail: errorMessage(error),
      });
      if (task.requestId === undefined) {
        this.#requeueHead(lane, task);
        return false;
      }
      task.abandon({
        kind: "error",
        error: workerFailure(
          `${host.label} failed to start: ${errorMessage(error)}`,
        ),
      });
      return true;
    }
    if (!host.offered(task.kind)) {
      task.abandon({
        kind: "error",
        error: backendFailure(`${host.label} does not offer ${task.kind}`),
      });
      return true;
    }
    this.#jobSequence += 1;
    const jobId = this.#jobSequence;
    let job: LspWorkerJob;
    try {
      job = task.build(jobId);
    } catch (error) {
      task.abandon({
        kind: "error",
        error: backendFailure(`job build failed: ${errorMessage(error)}`),
      });
      return true;
    }
    if (task.requestId !== undefined) {
      this.#registry.markRunning(task.requestId);
    }
    this.#active[lane] = {
      task,
      jobId,
      generation: this.#generations[lane],
      obsolete: false,
      graceHandle: undefined,
    };
    this.#emit("lane/dispatch", {
      lane,
      jobId,
      kind: task.kind,
      requestId: task.requestId,
    });
    try {
      host.send(job);
    } catch (error) {
      this.#active[lane] = undefined;
      task.abandon({
        kind: "error",
        error: backendFailure(`job send failed: ${errorMessage(error)}`),
      });
      return true;
    }
    return true;
  }

  #requestSuperseded(id: RequestId): boolean {
    const record = this.#registry.get(id);
    if (record === undefined) return true;
    return record.cancelledByClient || record.invalidated;
  }

  #requestLive(task: LaneTask): boolean {
    if (task.requestId === undefined) return true;
    const record = this.#registry.get(task.requestId);
    if (record === undefined) return false;
    return record.state !== "settled";
  }

  #onRawResult(lane: LaneName, raw: unknown): void {
    let result: LspWorkerResult;
    try {
      result = lspWorkerResult(raw);
    } catch (error) {
      this.#emit("lane/invalid-result", {
        lane,
        detail: errorMessage(error),
      });
      const active = this.#active[lane];
      if (active === undefined) return;
      this.#clearActive(lane);
      active.task.abandon({
        kind: "error",
        error: workerFailure(
          `${this.#hosts[lane].label} posted an invalid result`,
        ),
      });
      this.pump();
      return;
    }
    const active = this.#active[lane];
    if (
      active === undefined || result.job !== active.jobId ||
      active.generation !== this.#generations[lane]
    ) {
      this.#emit("lane/discard", { lane, job: result.job });
      return;
    }
    if (!isDocTask(active.task) && active.task.entry !== null) {
      if (!this.#documents.isFresh(active.task.entry)) {
        this.#emit("lane/stale-result", { lane, job: result.job });
        this.#clearActive(lane);
        if (active.task.requestId !== undefined) {
          this.#registry.markInvalidated(active.task.requestId);
        }
        active.task.abandon({ kind: "result", value: null });
        this.pump();
        return;
      }
    }
    this.#clearActive(lane);
    if (!result.ok) {
      this.#emit("lane/result-error", { lane, job: result.job });
      if (result.code !== undefined) {
        active.task.abandon({
          kind: "error",
          error: new JsonRpcError(result.code, result.message),
        });
      } else {
        active.task.abandon({
          kind: "error",
          error: backendFailure(`${result.name}: ${result.message}`),
        });
      }
      this.pump();
      return;
    }
    this.#emit("lane/result", { lane, job: result.job });
    active.task.settle(result);
    this.pump();
  }

  async #onHostError(lane: LaneName, error: Error): Promise<void> {
    this.#emit("lane/crash", { lane, detail: error.message });
    const active = this.#active[lane];
    if (active !== undefined) {
      this.#clearActive(lane);
      active.task.abandon({
        kind: "error",
        error: workerFailure(`${this.#hosts[lane].label}: ${error.message}`),
      });
    }
    await this.#reconstruct(lane, "crash");
    this.pump();
  }

  #markObsolete(lane: LaneName, active: ActiveTask): void {
    if (active.obsolete) return;
    active.obsolete = true;
    this.#emit("lane/grace-start", { lane, jobId: active.jobId });
    active.graceHandle = this.#clock.setTimeout(() => {
      void this.#onGraceFired(lane, active.jobId);
    }, this.#graceMs);
  }

  async #onGraceFired(lane: LaneName, jobId: number): Promise<void> {
    const active = this.#active[lane];
    if (active === undefined || active.jobId !== jobId) return;
    this.#emit("lane/grace-fired", { lane, jobId });
    this.#clearActive(lane);
    active.task.abandon({ kind: "result", value: null });
    await this.#reconstruct(lane, "watchdog");
    this.pump();
  }

  async #reconstruct(lane: LaneName, reason: string): Promise<void> {
    if (this.#reconstructing[lane]) return;
    this.#reconstructing[lane] = true;
    this.#generations[lane] += 1;
    const host = this.#hosts[lane];
    try {
      await host.terminate();
    } catch (error) {
      this.#emit("lane/terminate-error", {
        lane,
        detail: errorMessage(error),
      });
    }
    try {
      await host.start();
    } catch (error) {
      this.#emit("lane/reconstruct-failure", {
        lane,
        reason,
        detail: errorMessage(error),
      });
      this.#reconstructing[lane] = false;
      return;
    }
    this.#emit("lane/reconstructed", {
      lane,
      reason,
      generation: this.#generations[lane],
    });
    this.#reconstructing[lane] = false;
    if (this.#onLaneReconstructed !== undefined) {
      this.#onLaneReconstructed(lane);
    }
  }

  #clearActive(lane: LaneName): void {
    const active = this.#active[lane];
    if (active === undefined) return;
    this.#clearGrace(active);
    this.#active[lane] = undefined;
  }

  #clearGrace(active: ActiveTask): void {
    if (active.graceHandle === undefined) return;
    this.#clock.clearTimeout(active.graceHandle);
    active.graceHandle = undefined;
    active.obsolete = false;
  }

  #queued(lane: LaneName): number {
    return this.#queues[lane].priority.length +
      this.#queues[lane].normal.length;
  }

  #hasWork(): boolean {
    for (const lane of ["syntax", "semantic"] as const) {
      if (this.#active[lane] !== undefined) return true;
      if (this.#queued(lane) > 0) return true;
    }
    return false;
  }

  #shift(lane: LaneName): LaneTask | undefined {
    const queues = this.#queues[lane];
    const fast = queues.priority.shift();
    if (fast !== undefined) return fast;
    return queues.normal.shift();
  }

  #requeueHead(lane: LaneName, task: LaneTask): void {
    if (task.priority) this.#queues[lane].priority.unshift(task);
    else this.#queues[lane].normal.unshift(task);
  }

  #emit(kind: string, detail: unknown): void {
    if (this.#trace === undefined) return;
    this.#trace({ at: this.#clock.now(), kind, detail });
  }
}

function otherLane(lane: LaneName): LaneName {
  if (lane === "syntax") return "semantic";
  return "syntax";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleepReal(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Returns the override when defined, even when it is zero. */
function definedOr(value: number | undefined, fallback: number): number {
  if (value !== undefined) return value;
  return fallback;
}
