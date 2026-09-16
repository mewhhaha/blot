// The Node worker host adapter: runs LSP workers in node:worker_threads.
//
// start boots a worker thread for the role and resolves once the worker posts
// its ready sentinel, so the lane never sends before the job loop listens.
// The boot carries a startup timeout: a worker that never reports ready is
// terminated and start rejects with an explicit startup failure. Deliberate
// terminate calls suppress the exit and error events that follow; anything
// else fatal surfaces through onError for the lane crash path.

import { Worker } from "node:worker_threads";
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

export interface NodeWorkerHostOptions {
  readonly label?: string;
  readonly clock?: Clock;
  readonly startupTimeoutMs?: number;
}

/** The default budget for a worker to report ready. */
export const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 30_000;

/** Resolves the Node worker entry for one role. */
export function entryUrlFor(role: WorkerRole): URL {
  const extension = workerExtension();
  if (role === "syntax") {
    return new URL(
      `../lsp/workers/syntax_worker_node${extension}`,
      import.meta.url,
    );
  }
  return new URL(
    `../lsp/workers/semantic_worker_node${extension}`,
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

/** Creates a Node worker thread host for one lane. */
export function createNodeLspWorkerHost(
  role: WorkerRole,
  options: NodeWorkerHostOptions = {},
): LspWorkerHost {
  return new NodeLspWorkerHost(role, options);
}

/** A LspWorkerHost over one Node worker thread. */
class NodeLspWorkerHost implements LspWorkerHost {
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

  constructor(role: WorkerRole, options: NodeWorkerHostOptions) {
    this.role = role;
    let label = `${role} node worker`;
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

  async terminate(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#started = false;
    this.#starting = undefined;
    this.#terminating = true;
    if (worker !== undefined) await worker.terminate();
  }

  async #boot(): Promise<void> {
    this.#terminating = false;
    const worker = new Worker(entryUrlFor(this.role));
    this.#worker = worker;
    try {
      await this.#awaitReady(worker);
    } catch (error) {
      this.#worker = undefined;
      this.#starting = undefined;
      try {
        await worker.terminate();
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
      const onMessage = (value: unknown): void => {
        if (!isWorkerReady(value)) return;
        cleanup();
        worker.on("message", this.#forwardResult);
        worker.on("error", this.#forwardError);
        worker.on("exit", this.#forwardExit);
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(
          new Error(
            `${this.label} worker exited before ready with code ${code}`,
          ),
        );
      };
      const cleanup = (): void => {
        this.#clock.clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
  }

  readonly #forwardResult = (value: unknown): void => {
    if (isWorkerReady(value)) return;
    for (const receive of this.#resultListeners) receive(value);
  };

  readonly #forwardError = (error: Error): void => {
    if (this.#terminating) return;
    this.#started = false;
    for (const fail of this.#errorListeners) fail(error);
  };

  readonly #forwardExit = (code: number): void => {
    if (this.#terminating) return;
    this.#started = false;
    for (const fail of this.#errorListeners) {
      fail(new Error(`${this.label} worker exited with status ${code}`));
    }
  };
}
