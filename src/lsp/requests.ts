// Request lifecycle for the Blot language server.
//
// Every accepted request moves pending -> running -> settled, and settles
// exactly once through the single idempotent settle path. Settlement maps
// outcomes through the failure table from errors.ts:
//
//   - a result for a client-cancelled request settles RequestCancelled.
//   - a result for an invalidated request settles ContentModified.
//   - an explicit error always settles as itself: a racing cancel never masks
//     a deadline, resource, worker, or backend failure.
//
// Deadlines are measured from request ingress. Only the coordinator arms
// them, and only formatting carries one by default.

import {
  contentModifiedFailure,
  deadlineFailure,
  requestCancelledFailure,
} from "./errors.ts";
import { JsonRpcError } from "./errors.ts";
import type { RequestId } from "./errors.ts";

/** The injectable clock behind deadlines, debounce, and grace timers. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The production clock: wall time and global timers. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/** Where a request stands. Settled is terminal. */
export type RequestState = "pending" | "running" | "settled";

/** What a request settles with: a value or an explicit failure. */
export type Settlement =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly error: JsonRpcError };

/** A read-only view of one tracked request. */
export interface RequestRecord {
  readonly id: RequestId;
  readonly method: string;
  readonly uri: string | null;
  readonly state: RequestState;
  readonly ingressTime: number;
  readonly cancelledByClient: boolean;
  readonly invalidated: boolean;
}

interface MutableRecord {
  readonly id: RequestId;
  readonly method: string;
  readonly uri: string | null;
  readonly ingressTime: number;
  state: RequestState;
  cancelledByClient: boolean;
  invalidated: boolean;
  deadlineHandle: unknown;
  deadlineMs: number;
}

/** Receives each settlement exactly once, in settle order. */
export type SettlementHandler = (
  id: RequestId,
  settlement: Settlement,
) => void;

export interface RequestRegistryOptions {
  readonly onSettle: SettlementHandler;
  readonly onDeadline?: (record: RequestRecord) => void;
}

/**
 * Tracks every live request and settles each exactly once. The registry owns
 * state transitions and deadline timers; the coordinator owns lanes, hosts,
 * and the writer behind onSettle.
 */
export class RequestRegistry {
  readonly #clock: Clock;
  readonly #onSettle: SettlementHandler;
  readonly #onDeadline: ((record: RequestRecord) => void) | undefined;
  readonly #records = new Map<RequestId, MutableRecord>();

  constructor(clock: Clock, options: RequestRegistryOptions) {
    this.#clock = clock;
    this.#onSettle = options.onSettle;
    this.#onDeadline = options.onDeadline;
  }

  /**
   * Accepts a request. A duplicate of a live id settles the newcomer at once
   * with a duplicate failure; reuse after settlement is always allowed.
   */
  accept(
    id: RequestId,
    method: string,
    uri: string | null,
    deadlineMs?: number,
  ): RequestRecord {
    const live = this.#records.get(id);
    if (live !== undefined && live.state !== "settled") {
      const rejected: RequestRecord = {
        id,
        method,
        uri,
        state: "settled",
        ingressTime: this.#clock.now(),
        cancelledByClient: false,
        invalidated: false,
      };
      this.#onSettle(id, {
        kind: "error",
        error: new JsonRpcError(
          -32600,
          `request id ${JSON.stringify(id)} is already active`,
        ),
      });
      return rejected;
    }
    const record: MutableRecord = {
      id,
      method,
      uri,
      ingressTime: this.#clock.now(),
      state: "pending",
      cancelledByClient: false,
      invalidated: false,
      deadlineHandle: undefined,
      deadlineMs: 0,
    };
    this.#records.set(id, record);
    if (deadlineMs !== undefined) {
      record.deadlineMs = deadlineMs;
      record.deadlineHandle = this.#clock.setTimeout(() => {
        this.#fireDeadline(id);
      }, deadlineMs);
    }
    return this.#snapshot(record);
  }

  /** Moves a pending request to running. Returns false unless it was pending. */
  markRunning(id: RequestId): boolean {
    const record = this.#records.get(id);
    if (record === undefined || record.state !== "pending") return false;
    record.state = "running";
    return true;
  }

  /**
   * Notes an explicit client cancellation. Returns true when the request was
   * still live. Settlement converts the eventual result; explicit errors
   * still surface as themselves.
   */
  clientCancel(id: RequestId): boolean {
    const record = this.#records.get(id);
    if (record === undefined || record.state === "settled") return false;
    record.cancelledByClient = true;
    return true;
  }

  /**
   * Marks one live request as server-invalidated. Returns false when the
   * request is unknown or already settled. The lane uses this when a ledger
   * check finds staleness the registry has not observed yet.
   */
  markInvalidated(id: RequestId): boolean {
    const record = this.#records.get(id);
    if (record === undefined || record.state === "settled") return false;
    record.invalidated = true;
    return true;
  }

  /**
   * Marks every live request for one document as server-invalidated. Returns
   * the invalidated ids so the coordinator can drop queued work. Requests
   * without a document are never invalidated by document movement.
   */
  invalidateUri(uri: string): readonly RequestId[] {
    const invalidated: RequestId[] = [];
    for (const record of this.#records.values()) {
      if (record.state === "settled") continue;
      if (record.uri !== uri) continue;
      record.invalidated = true;
      invalidated.push(record.id);
    }
    return invalidated;
  }

  /**
   * The single settlement path. The first call for an id wins and the
   * responder runs exactly once; later calls are no-ops that return false.
   * Unknown ids return false without throwing, so late worker results and
   * racing cancels are safe.
   */
  settle(id: RequestId, settlement: Settlement): boolean {
    const record = this.#records.get(id);
    if (record === undefined || record.state === "settled") return false;
    record.state = "settled";
    this.#clearDeadline(record);
    if (settlement.kind === "result") {
      if (record.cancelledByClient) {
        this.#onSettle(id, {
          kind: "error",
          error: requestCancelledFailure(),
        });
        return true;
      }
      if (record.invalidated) {
        let uri = "";
        if (record.uri !== null) uri = record.uri;
        this.#onSettle(id, {
          kind: "error",
          error: contentModifiedFailure(uri),
        });
        return true;
      }
    }
    this.#onSettle(id, settlement);
    return true;
  }

  /**
   * Settles every live request with one shared outcome, for shutdown drain.
   * Returns the settled count.
   */
  settleAllLive(settlement: Settlement): number {
    let settled = 0;
    for (const record of this.#records.values()) {
      if (record.state === "settled") continue;
      if (this.settle(record.id, settlement)) settled += 1;
    }
    return settled;
  }

  /** Reads one request without changing it. */
  get(id: RequestId): RequestRecord | undefined {
    const record = this.#records.get(id);
    if (record === undefined) return undefined;
    return this.#snapshot(record);
  }

  /** Counts live requests, for bounded-overload checks. */
  liveCount(): number {
    let count = 0;
    for (const record of this.#records.values()) {
      if (record.state !== "settled") count += 1;
    }
    return count;
  }

  /** Clears deadline timers. Records stay readable after dispose. */
  dispose(): void {
    for (const record of this.#records.values()) {
      this.#clearDeadline(record);
    }
  }

  #fireDeadline(id: RequestId): void {
    const record = this.#records.get(id);
    if (record === undefined || record.state === "settled") return;
    record.deadlineHandle = undefined;
    const snapshot = this.#snapshot(record);
    this.settle(id, {
      kind: "error",
      error: deadlineFailure(record.method, record.deadlineMs),
    });
    if (this.#onDeadline !== undefined) this.#onDeadline(snapshot);
  }

  #clearDeadline(record: MutableRecord): void {
    if (record.deadlineHandle === undefined) return;
    this.#clock.clearTimeout(record.deadlineHandle);
    record.deadlineHandle = undefined;
  }

  #snapshot(record: MutableRecord): RequestRecord {
    return {
      id: record.id,
      method: record.method,
      uri: record.uri,
      state: record.state,
      ingressTime: record.ingressTime,
      cancelledByClient: record.cancelledByClient,
      invalidated: record.invalidated,
    };
  }
}

/**
 * The formatting watchdog budget: 10s from request ingress, with headroom
 * below the 20s default most clients wait before abandoning formatting.
 */
export const FORMAT_DEADLINE_MS = 10_000;
