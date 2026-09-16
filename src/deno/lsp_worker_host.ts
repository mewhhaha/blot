// The Deno worker host adapter: runs LSP workers in Deno worker threads.
//
// start boots a module worker for the role and resolves once the worker posts
// its ready sentinel, so the lane never sends before the job loop listens.
// The boot carries a startup timeout: a worker that never reports ready is
// terminated and start rejects with an explicit startup failure. Deliberate
// terminate calls suppress the worker error events that follow; anything
// else fatal surfaces through onError for the lane crash path.

import type { LspWorkerHost, WorkerRole } from "../lsp/hosts.ts";
import type { Clock } from "../lsp/requests.ts";
import { systemClock } from "../lsp/requests.ts";
import {
  isWorkerReady,
  SEMANTIC_WORKER_KINDS,
  SYNTAX_WORKER_KINDS,
} from "../lsp/workers/protocol.ts";
import type {
  LspWorkerJob,
  LspWorkerJobKind,
} from "../lsp/workers/protocol.ts";

export interface DenoWorkerHostOptions {
  readonly label?: string;
  readonly clock?: Clock;
  readonly startupTimeoutMs?: number;
}

/** The default budget for a worker to report ready. */
export const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 30_000;

/** Resolves the Deno worker entry for one role. */
export function entryUrlFor(role: WorkerRole): URL {
  const extension = workerExtension();
  if (role === "syntax") {
    return new URL(
      `../lsp/workers/syntax_worker${extension}`,
      import.meta.url,
    );
  }
  return new URL(
    `../lsp/workers/semantic_worker${extension}`,
    import.meta.url,
  );
}

/**
 * The worker entry mirrors its host module: checkout TypeScript resolves
 * the `.ts` entry beside it, while the emitted Node package resolves the
 * compiled `.js` entry in the same relative place.
 */
function workerExtension(): string {
  if (import.meta.url.endsWith(".js")) return ".js";
  return ".ts";
}

/** Creates a Deno worker thread host for one lane. */
export function createDenoLspWorkerHost(
  role: WorkerRole,
  options: DenoWorkerHostOptions = {},
): LspWorkerHost {
  return new DenoLspWorkerHost(role, options);
}

/** A LspWorkerHost over one Deno worker thread. */
class DenoLspWorkerHost implements LspWorkerHost {
  readonly role: WorkerRole;
  readonly label: string;
  readonly #kinds: ReadonlySet<LspWorkerJobKind>;
  readonly #clock: Clock;
  readonly #startupTimeoutMs: number;
  readonly #resultListeners = new Set<(result: unknown) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  #worker: Worker | undefined = undefined;
  #started = false;
  #starting: Promise<void> | undefined = undefined;
  #terminating = false;

  constructor(role: WorkerRole, options: DenoWorkerHostOptions) {
    this.role = role;
    let label = `${role} deno worker`;
    if (options.label !== undefined) label = options.label;
    this.label = label;
    if (role === "syntax") this.#kinds = new Set(SYNTAX_WORKER_KINDS);
    else this.#kinds = new Set(SEMANTIC_WORKER_KINDS);
    if (options.clock !== undefined) this.#clock = options.clock;
    else this.#clock = systemClock();
    this.#startupTimeoutMs = options.startupTimeoutMs ||
      DEFAULT_WORKER_STARTUP_TIMEOUT_MS;
  }

  offered(kind: LspWorkerJobKind): boolean {
    return this.#kinds.has(kind);
  }

  get started(): boolean {
    return this.#started;
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    if (this.#starting !== undefined) return this.#starting;
    const booting = this.#boot();
    this.#starting = booting;
    return booting;
  }

  send(job: LspWorkerJob): void {
    if (!this.#started || this.#worker === undefined) {
      throw new Error(`${this.label} host is not started`);
    }
    if (!this.#kinds.has(job.kind)) {
      throw new Error(`${this.label} host does not offer ${job.kind}`);
    }
    this.#worker.postMessage(job);
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
    const worker = this.#worker;
    this.#worker = undefined;
    this.#started = false;
    this.#starting = undefined;
    this.#terminating = true;
    if (worker !== undefined) worker.terminate();
    return Promise.resolve();
  }

  async #boot(): Promise<void> {
    this.#terminating = false;
    const worker = new Worker(entryUrlFor(this.role), { type: "module" });
    this.#worker = worker;
    try {
      await this.#awaitReady(worker);
    } catch (error) {
      this.#worker = undefined;
      this.#starting = undefined;
      try {
        worker.terminate();
      } catch {
        // The worker is already dead; the startup error below explains it.
      }
      throw error;
    }
    this.#started = true;
    this.#starting = undefined;
  }

  #awaitReady(worker: Worker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `${this.label} worker startup timed out after ${this.#startupTimeoutMs}ms`,
          ),
        );
      }, this.#startupTimeoutMs);
      const onMessage = (event: MessageEvent): void => {
        if (!isWorkerReady(event.data)) return;
        cleanup();
        worker.addEventListener("message", this.#forwardResult);
        worker.addEventListener("error", this.#forwardError);
        resolve();
      };
      const onError = (event: ErrorEvent): void => {
        cleanup();
        reject(
          new Error(event.message || `${this.label} worker failed to start`),
        );
      };
      const cleanup = (): void => {
        this.#clock.clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  readonly #forwardResult = (event: MessageEvent): void => {
    if (isWorkerReady(event.data)) return;
    for (const receive of this.#resultListeners) receive(event.data);
  };

  readonly #forwardError = (event: Event): void => {
    if (this.#terminating) return;
    let message = `${this.label} worker failed`;
    if (event instanceof ErrorEvent && event.message.length > 0) {
      message = event.message;
    }
    this.#started = false;
    for (const fail of this.#errorListeners) fail(new Error(message));
  };
}
