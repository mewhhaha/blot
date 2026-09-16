// An in-process worker host.
//
// Inline hosts execute job handlers on the calling thread, which preserves
// the current single-Compiler-in-process behavior exactly while still going
// through the scheduler, generations, and watchdog like every other host.
// terminate drops in-flight results the way killing a thread would: the lane
// already abandoned them by generation, and the host run check discards any
// that finish late.

import type { LspWorkerHost, WorkerRole } from "./hosts.ts";
import type { LspWorkerJob, LspWorkerJobKind } from "./workers/protocol.ts";
import { workerFailureResult, workerSuccess } from "./workers/protocol.ts";

/** Executes one job in process and returns its plain value. */
export type InlineHandler = (
  job: LspWorkerJob,
) => Promise<unknown> | unknown;

export interface InlineHostOptions {
  readonly label?: string;
  readonly kinds: ReadonlySet<LspWorkerJobKind>;
  readonly handlers: ReadonlyMap<LspWorkerJobKind, InlineHandler>;
}

/** Runs worker jobs on this thread behind the host interface. */
export class InlineLspWorkerHost implements LspWorkerHost {
  readonly role: WorkerRole;
  readonly label: string;
  readonly #kinds: ReadonlySet<LspWorkerJobKind>;
  readonly #handlers: ReadonlyMap<LspWorkerJobKind, InlineHandler>;
  readonly #resultListeners = new Set<(result: unknown) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  #started = false;
  #run = 0;

  constructor(role: WorkerRole, options: InlineHostOptions) {
    this.role = role;
    this.label = options.label || `${role} inline host`;
    this.#kinds = options.kinds;
    this.#handlers = options.handlers;
    for (const kind of options.kinds) {
      if (!options.handlers.has(kind)) {
        throw new Error(`${this.label} offers ${kind} without a handler`);
      }
    }
  }

  offered(kind: LspWorkerJobKind): boolean {
    return this.#kinds.has(kind);
  }

  get started(): boolean {
    return this.#started;
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    this.#started = true;
    this.#run += 1;
    return Promise.resolve();
  }

  send(job: LspWorkerJob): void {
    if (!this.#started) {
      throw new Error(`${this.label} host is not started`);
    }
    if (!this.#kinds.has(job.kind)) {
      throw new Error(`${this.label} host does not offer ${job.kind}`);
    }
    const handler = this.#handlers.get(job.kind);
    if (handler === undefined) {
      throw new Error(`${this.label} host has no handler for ${job.kind}`);
    }
    const run = this.#run;
    void Promise.resolve().then(async () => {
      let result: unknown;
      try {
        const value = await handler(job);
        result = workerSuccess(job, value);
      } catch (error) {
        result = workerFailureResult(job, error);
      }
      if (run !== this.#run) return;
      for (const receive of this.#resultListeners) receive(result);
    });
  }

  onResult(receive: (result: unknown) => void): () => void {
    this.#resultListeners.add(receive);
    return () => {
      this.#resultListeners.delete(receive);
    };
  }

  onError(fail: (error: Error) => void): () => void {
    this.#errorListeners.add(fail);
    return () => {
      this.#errorListeners.delete(fail);
    };
  }

  terminate(): Promise<void> {
    this.#started = false;
    this.#run += 1;
    return Promise.resolve();
  }
}
