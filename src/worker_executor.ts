import type { RuntimeValue } from "./abi_values.ts";
import type { CallbackExecutor, CompiledCallback } from "./callbacks.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { HostScope } from "./resources.ts";
import type { SharedLoan } from "./shared_memory.ts";
import { type WorkerConnection, workerResponse } from "./worker_protocol.ts";

interface PendingJob {
  readonly id: number;
  readonly program: number;
  readonly callback: CompiledCallback;
  readonly argument: RuntimeValue;
  readonly shared: SharedLoan | undefined;
  readonly signal: AbortSignal;
  readonly completion: PromiseWithResolvers<RuntimeValue>;
  readonly detach: () => void;
  worker: PoolWorker | undefined;
  priority: "required" | "speculative";
  started: boolean;
}

interface PoolWorker {
  readonly connection: WorkerConnection;
  readonly installed: Set<number>;
  readonly detach: () => void;
  job: PendingJob | undefined;
}

/** A reusable pool; each admitted callback runs at most once in a private heap. */
export class WorkerExecutor implements CallbackExecutor {
  readonly #size: number;
  readonly #createWorker: () => WorkerConnection;
  readonly #workers = new Set<PoolWorker>();
  readonly #pending = new Map<number, PendingJob>();
  readonly #programs = new WeakMap<WebAssembly.Module, number>();
  readonly #developmentPrograms = new Map<string, number>();
  readonly #modules = new WeakMap<WebAssembly.Module, number>();
  #nextModule = 1;
  readonly #controller = new AbortController();
  readonly #retiring = new Set<Promise<void>>();
  readonly #retirementFailures: unknown[] = [];
  readonly #detach: () => void;
  #nextProgram = 1;
  #nextJob = 1;
  #started = 0;
  #installed = 0;
  #completed = 0;
  #jobsStarted = 0;
  #closing: Promise<void> | undefined;

  constructor(
    root: HostScope,
    options: {
      readonly size: number;
      readonly createWorker: () => WorkerConnection;
    },
  ) {
    if (!Number.isSafeInteger(options.size) || options.size < 1) {
      throw new RangeError("worker count must be a positive integer");
    }
    this.#size = options.size;
    this.#createWorker = options.createWorker;
    this.#detach = root.own(() => this.close());
  }

  get statistics(): Readonly<
    {
      workersStarted: number;
      programsInstalled: number;
      programsCached: number;
      jobsSubmitted: number;
      jobsStarted: number;
      jobsCompleted: number;
    }
  > {
    return Object.freeze({
      workersStarted: this.#started,
      programsInstalled: this.#installed,
      programsCached: [...this.#workers].reduce(
        (count, worker) => count + worker.installed.size,
        0,
      ),
      jobsSubmitted: this.#nextJob - 1,
      jobsStarted: this.#jobsStarted,
      jobsCompleted: this.#completed,
    });
  }

  execute(
    callback: CompiledCallback,
    argument: RuntimeValue,
    signal: AbortSignal,
    options: {
      readonly priority: "required" | "speculative";
      readonly shared?: SharedLoan;
    },
  ): Promise<RuntimeValue> {
    this.#controller.signal.throwIfAborted();
    signal.throwIfAborted();
    requirePrivateCaptures(callback.environmentType);
    if (options.shared !== undefined && options.priority !== "required") {
      throw new TypeError("shared kernels cannot be speculative");
    }
    if (
      !Number.isSafeInteger(this.#nextJob) ||
      !Number.isSafeInteger(this.#nextProgram)
    ) throw new RangeError("worker identity space exhausted");
    let program = this.#programs.get(callback.module);
    let developmentKey: string | undefined;
    if (callback.development !== undefined) {
      const units = [...callback.development.units].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      developmentKey = JSON.stringify([
        callback.development.entryUnit,
        units.map((unit) => {
          let identity = this.#modules.get(unit.module);
          if (identity === undefined) {
            identity = this.#nextModule++;
            this.#modules.set(unit.module, identity);
          }
          return [unit.name, identity];
        }),
      ]);
      program = this.#developmentPrograms.get(developmentKey);
    }
    if (program === undefined) {
      program = this.#nextProgram++;
      if (developmentKey === undefined) {
        this.#programs.set(callback.module, program);
      } else {
        if (this.#developmentPrograms.size >= 64) {
          const retired = this.#developmentPrograms.keys().next().value;
          if (retired === undefined) {
            throw new Error(
              "development program identities lost their oldest entry",
            );
          }
          this.#developmentPrograms.delete(retired);
        }
        this.#developmentPrograms.set(developmentKey, program);
      }
    }
    const cancellation = AbortSignal.any([signal, this.#controller.signal]);
    const abort = () => {
      if (job.worker === undefined) {
        this.#finish(job, { error: cancellation.reason });
      } else {
        try {
          job.worker.connection.postMessage({ kind: "cancel", job: job.id });
        } catch (error) {
          this.#lose(job.worker, error);
        }
      }
    };
    const job: PendingJob = {
      id: this.#nextJob++,
      program,
      callback,
      argument,
      shared: options.shared,
      signal: cancellation,
      completion: Promise.withResolvers<RuntimeValue>(),
      worker: undefined,
      priority: options.priority,
      started: false,
      detach: () => cancellation.removeEventListener("abort", abort),
    };
    this.#pending.set(job.id, job);
    cancellation.addEventListener("abort", abort, { once: true });
    this.#dispatch();
    return job.completion.promise;
  }

  promote(callback: CompiledCallback): void {
    const job = [...this.#pending.values()].find((job) =>
      job.callback === callback
    );
    if (job === undefined) return;
    job.priority = "required";
    this.#dispatch();
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = Promise.resolve().then(async () => {
      await Promise.allSettled(
        [...this.#pending.values()].map((job) => job.completion.promise),
      );
      const outcomes = await Promise.allSettled(
        [...this.#workers].map(async (worker) => {
          worker.detach();
          await worker.connection.terminate();
        }),
      );
      await Promise.all(this.#retiring);
      this.#workers.clear();
      this.#detach();
      const failures = [...this.#retirementFailures];
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") failures.push(outcome.reason);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "worker executor cleanup failed");
      }
    });
    this.#controller.abort(
      new DOMException("worker executor closed", "AbortError"),
    );
    return this.#closing;
  }

  #dispatch(): void {
    if (this.#controller.signal.aborted) return;
    const waiting = [...this.#pending.values()];
    waiting.sort((left, right) => {
      if (left.priority === right.priority) return left.id - right.id;
      if (left.priority === "required") return -1;
      return 1;
    });
    for (const job of waiting) {
      if (job.worker !== undefined) continue;
      if (job.priority === "speculative") {
        const speculative = [...this.#workers].filter((worker) =>
          worker.job?.priority === "speculative"
        ).length;
        // Keep one worker available for required work even if a spark diverges.
        if (speculative >= this.#size - 1) {
          continue;
        }
      }
      let worker = [...this.#workers].find((worker) =>
        worker.job === undefined
      );
      if (worker === undefined) {
        if (this.#workers.size === this.#size) return;
        try {
          worker = this.#startWorker();
        } catch (error) {
          this.#finish(job, { error });
          continue;
        }
      }
      worker.job = job;
      job.worker = worker;
      try {
        if (!worker.installed.has(job.program)) {
          if (worker.installed.size >= 16) {
            const retired = worker.installed.values().next().value;
            if (retired === undefined) {
              throw new Error("worker program cache lost its oldest entry");
            }
            worker.connection.postMessage({
              kind: "uninstall",
              program: retired,
            });
            worker.installed.delete(retired);
          }
          worker.connection.postMessage({
            kind: "install",
            program: job.program,
            module: job.callback.module,
            manifestBytes: job.callback.manifestBytes,
            development: job.callback.development,
          });
          worker.installed.add(job.program);
          this.#installed += 1;
        }
        worker.installed.delete(job.program);
        worker.installed.add(job.program);
        let argument = job.argument;
        if (job.shared !== undefined) {
          argument = job.shared.argument;
          job.shared.admitted();
        }
        worker.connection.postMessage({
          kind: "run",
          program: job.program,
          job: job.id,
          entry: job.callback.entry,
          arguments: [argument, ...job.callback.captures],
          shared: job.shared?.memories,
        });
      } catch (error) {
        this.#lose(worker, error);
      }
    }
  }

  #startWorker(): PoolWorker {
    const connection = this.#createWorker();
    const offMessage = connection.onMessage((message) => {
      try {
        const response = workerResponse(message);
        const job = worker.job;
        if (job === undefined || job.id !== response.job) {
          throw new Error("worker completion has a stale job identity");
        }
        if (response.kind === "started") {
          if (job.started) throw new Error("worker started a job twice");
          job.started = true;
          this.#jobsStarted += 1;
          return;
        }
        if (job.signal.aborted) this.#finish(job, { error: job.signal.reason });
        else if (response.kind === "returned") {
          this.#finish(job, { value: response.value });
        } else if (response.kind === "cancelled") {
          throw new Error(
            "worker cancelled a job without a cancellation request",
          );
        } else {
          const error = new Error(response.message);
          error.name = response.name;
          this.#finish(job, { error });
        }
        this.#dispatch();
      } catch (error) {
        this.#lose(worker, error);
      }
    });
    const offError = connection.onError((error) => this.#lose(worker, error));
    const worker: PoolWorker = {
      connection,
      installed: new Set(),
      job: undefined,
      detach: () => {
        offMessage();
        offError();
      },
    };
    this.#workers.add(worker);
    this.#started += 1;
    return worker;
  }

  #finish(
    job: PendingJob,
    outcome: { readonly value: RuntimeValue } | { readonly error: unknown },
  ): void {
    if (!this.#pending.delete(job.id)) {
      throw new Error("worker job completed twice");
    }
    job.detach();
    if (job.worker !== undefined) job.worker.job = undefined;
    this.#completed += 1;
    if ("error" in outcome) job.completion.reject(outcome.error);
    else job.completion.resolve(outcome.value);
  }

  #lose(worker: PoolWorker, error: unknown): void {
    if (!this.#workers.delete(worker)) return;
    worker.detach();
    const job = worker.job;
    const retirement = Promise.resolve().then(() =>
      worker.connection.terminate()
    )
      .catch((error: unknown) => {
        this.#retirementFailures.push(error);
      })
      .finally(() => {
        if (job !== undefined) this.#finish(job, { error });
        this.#retiring.delete(retirement);
      });
    this.#retiring.add(retirement);
    this.#dispatch();
  }
}

function requirePrivateCaptures(type: BlotAbiType): void {
  switch (type.kind) {
    case "resource":
    case "callback":
      throw new TypeError(
        "worker callbacks require private canonical captures; resource and callback captures cannot cross workers",
      );
    case "record":
      for (const field of type.fields) requirePrivateCaptures(field.type);
      break;
    case "array":
      requirePrivateCaptures(type.element);
      break;
    case "variant":
      for (const case_ of type.cases) {
        if (case_.payload !== undefined) {
          requirePrivateCaptures(case_.payload);
        }
      }
      break;
    case "sealed":
      requirePrivateCaptures(type.inner);
      break;
  }
}
