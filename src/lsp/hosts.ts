// The runtime-neutral worker host interface.
//
// A host is the isolation boundary between a scheduler lane and the code that
// executes jobs: in-process handlers, a Deno worker thread, a Node worker
// thread, or a scripted fake. The lane owns queueing, freshness, deadlines,
// and generations; the host only starts, executes what it is sent, and
// reports results and fatal errors. Results arrive as unknown because the
// thread boundary cannot be trusted; the lane validates every result.
//
// Hosts are 1:1 with lanes. The scheduler never sends more than one active
// job per host: the next job waits until the active one resolves, fails, or
// is abandoned by terminate-plus-reconstruct.

import type { LspWorkerJob, LspWorkerJobKind } from "./workers/protocol.ts";

/** Which lane a host serves. */
export type WorkerRole = "syntax" | "semantic";

/**
 * Executes worker jobs somewhere: this thread, a worker thread, or a script.
 * Implementations: InlineLspWorkerHost, the Deno and Node adapters, and
 * FakeLspWorkerHost for deterministic tests.
 */
export interface LspWorkerHost {
  /** Which lane this host serves. */
  readonly role: WorkerRole;
  /** A human name for traces and failure messages. */
  readonly label: string;
  /** True when the host can execute one job kind. */
  offered(kind: LspWorkerJobKind): boolean;
  /** True between start and terminate. */
  readonly started: boolean;
  /**
   * Boots the host. Idempotent: starting a started host resolves at once.
   * Rejects when the worker cannot start; the lane settles the dispatch
   * with an explicit worker failure and retries start on the next dispatch.
   */
  start(): Promise<void>;
  /**
   * Executes one job. Throws when the host is not started or does not offer
   * the kind. Results arrive through onResult; fatal host failures arrive
   * through onError. Never blocks the caller.
   */
  send(job: LspWorkerJob): void;
  /** Subscribes to results. Listeners must not throw. */
  onResult(receive: (result: unknown) => void): () => void;
  /**
   * Subscribes to fatal host failures: crashes, unexpected exits, and port
   * errors. Deliberate terminate calls do not report here.
   */
  onError(fail: (error: Error) => void): () => void;
  /**
   * Abandons in-flight work and stops the host. A later start reconstructs
   * it. In-flight jobs never resolve after terminate; the lane already
   * moved on through worker generations.
   */
  terminate(): Promise<void>;
}
