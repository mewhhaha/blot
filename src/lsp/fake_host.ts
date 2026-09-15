// A deterministic worker host for tests.
//
// The fake records every job it receives and resolves each one only when the
// test says so: automatically through a handler, or manually one release at a
// time. It also injects the three worker failure modes: crash (fatal error,
// host dead), terminate (deliberate abandon, host stopped), and startup
// failure (start rejects until cleared). Results always arrive
// asynchronously, like a real thread boundary.

import type { LspWorkerHost, WorkerRole } from "./hosts.ts";
import type {
  LspWorkerJob,
  LspWorkerJobKind,
  LspWorkerResult,
} from "./workers/protocol.ts";
import {
  SEMANTIC_WORKER_KINDS,
  workerFailureResult,
  workerSuccess,
} from "./workers/protocol.ts";

/** How the fake resolves jobs: by handler, or by manual release. */
export type FakeBehavior =
  | {
    readonly mode: "auto";
    readonly handle: (job: LspWorkerJob) => Promise<unknown> | unknown;
  }
  | { readonly mode: "manual" };

export interface FakeHostOptions {
  readonly label?: string;
  readonly kinds?: ReadonlySet<LspWorkerJobKind>;
  readonly behavior?: FakeBehavior;
}

/** A scripted host that resolves jobs only on test command. */
export class FakeLspWorkerHost implements LspWorkerHost {
  readonly role: WorkerRole;
  readonly label: string;
  readonly #kinds: ReadonlySet<LspWorkerJobKind>;
  readonly #resultListeners = new Set<(result: unknown) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  /** Every job received, in send order. */
  readonly sentJobs: LspWorkerJob[] = [];
  readonly #held: LspWorkerJob[] = [];
  #behavior: FakeBehavior;
  #started = false;
  #run = 0;
  #startupFailure: Error | undefined = undefined;
  #startCount = 0;

  constructor(role: WorkerRole, options: FakeHostOptions = {}) {
    this.role = role;
    let label = `${role} fake host`;
    if (options.label !== undefined) label = options.label;
    this.label = label;
    this.#kinds = options.kinds ||
      new Set<LspWorkerJobKind>(SEMANTIC_WORKER_KINDS);
    this.#behavior = options.behavior || { mode: "manual" };
  }

  /** How many times start resolved. */
  get startCount(): number {
    return this.#startCount;
  }

  /** Jobs held in manual mode, oldest first. */
  heldJobs(): readonly LspWorkerJob[] {
    return [...this.#held];
  }

  offered(kind: LspWorkerJobKind): boolean {
    return this.#kinds.has(kind);
  }

  get started(): boolean {
    return this.#started;
  }

  setBehavior(behavior: FakeBehavior): void {
    this.#behavior = behavior;
  }

  /** Arms a startup failure: start rejects until clearStartupFailure. */
  failStartupWith(error: Error): void {
    this.#startupFailure = error;
  }

  clearStartupFailure(): void {
    this.#startupFailure = undefined;
  }

  start(): Promise<void> {
    if (this.#startupFailure !== undefined) {
      return Promise.reject(this.#startupFailure);
    }
    if (this.#started) return Promise.resolve();
    this.#started = true;
    this.#run += 1;
    this.#startCount += 1;
    return Promise.resolve();
  }

  send(job: LspWorkerJob): void {
    if (!this.#started) {
      throw new Error(`${this.label} host is not started`);
    }
    if (!this.#kinds.has(job.kind)) {
      throw new Error(`${this.label} host does not offer ${job.kind}`);
    }
    this.sentJobs.push(job);
    if (this.#behavior.mode === "manual") {
      this.#held.push(job);
      return;
    }
    const run = this.#run;
    const handle = this.#behavior.handle;
    void Promise.resolve().then(async () => {
      let result: LspWorkerResult;
      try {
        const value = await handle(job);
        result = workerSuccess(job, value);
      } catch (error) {
        result = workerFailureResult(job, error);
      }
      if (run !== this.#run) return;
      this.#emitResult(result);
    });
  }

  /**
   * Resolves the oldest held job with a value. Returns false when no job is
   * held or the host moved on by terminate or crash.
   */
  releaseNext(value: unknown): boolean {
    const job = this.#held.shift();
    if (job === undefined) return false;
    this.#emitResult(workerSuccess(job, value));
    return true;
  }

  /** Fails the oldest held job with a thrown value. */
  releaseNextThrow(error: unknown): boolean {
    const job = this.#held.shift();
    if (job === undefined) return false;
    this.#emitResult(workerFailureResult(job, error));
    return true;
  }

  /** Posts an arbitrary value as a result, for invalid-result tests. */
  emitRawResult(value: unknown): void {
    this.#emitResult(value);
  }

  /**
   * Simulates a worker crash: the host dies with a fatal error and every
   * held job is abandoned. A later start reconstructs the host.
   */
  crash(error: Error): void {
    this.#started = false;
    this.#run += 1;
    this.#held.length = 0;
    for (const fail of this.#errorListeners) fail(error);
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
    this.#held.length = 0;
    return Promise.resolve();
  }

  #emitResult(result: unknown): void {
    for (const receive of this.#resultListeners) receive(result);
  }
}
