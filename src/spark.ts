import { decodeManifest, type RuntimeValue } from "./abi_values.ts";
import {
  assignCallbackExecutor,
  type CallbackExecutor,
  demandHostCallback,
  type HostCallback,
  isHostCallback,
  moveHostCallback,
  registerHostFinalizer,
} from "./callbacks.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";
import type { HostCapabilities, HostOperation } from "./host.ts";
import {
  type HostResource,
  HostScope,
  type ResourceFamily,
} from "./resources.ts";

type JobOutcome =
  | { readonly kind: "returned"; readonly value: RuntimeValue }
  | { readonly kind: "failed"; readonly cause: unknown };

interface SparkJob {
  readonly scope: HostScope;
  readonly outcome: Promise<JobOutcome>;
  readonly kind: "required" | "speculative";
  work: HostCallback | undefined;
  state: "available" | "joining" | "cancelled" | "released";
}

interface SparkScope {
  readonly lifetime: HostScope;
  readonly jobs: Set<SparkJob>;
  readonly failures: Set<unknown>;
  phase: "open" | "joining" | "closed";
}

/** Source Spark operations scheduled against an explicit executor capability. */
export class SparkRuntime {
  readonly executor: HostResource;
  readonly #root: HostScope;
  readonly #executors: ResourceFamily<SparkRuntime>;
  readonly #scopes: ResourceFamily<SparkScope>;
  readonly #jobs = new Map<string, ResourceFamily<SparkJob>>();
  readonly #operations: ReadonlyMap<string, HostOperation>;
  #jobsActive = 0;
  #jobsRetained = 0;
  #maximumJobsRetained = 0;

  constructor(
    root: HostScope,
    options: { readonly workers?: CallbackExecutor } = {},
  ) {
    this.#root = root;
    this.#executors = root.resource<SparkRuntime>("Spark.Executor");
    this.#scopes = root.resource<SparkScope>("Spark.Scope");
    this.executor = this.#executors.grant(root, this);
    const spawn: HostOperation = async (context, request) => {
      const fields = tuple(request, 2);
      const scope = this.#scopes.get(fields[0]);
      this.#assertOpen(scope);
      const work = fields[1];
      if (!isHostCallback(work)) {
        throw new TypeError("Spark.spawn requires compiled work");
      }
      const result = context.operation.function.result;
      if (result.kind !== "resource" || result.name !== "Spark.Job") {
        throw new Error("checked Spark.spawn operation has no job result");
      }
      const lifetime = new HostScope(scope.lifetime);
      try {
        moveHostCallback(work, lifetime);
        const completion = Promise.withResolvers<JobOutcome>();
        let kind: "required" | "speculative" = "required";
        if (context.operation.sourceName === "speculate") kind = "speculative";
        const job: SparkJob = {
          scope: lifetime,
          outcome: completion.promise,
          work,
          kind,
          state: "available",
        };
        const handle = this.#jobFamily(result.payload).grant(
          scope.lifetime,
          job,
          async () => {
            try {
              if (job.state !== "joining") await lifetime.close();
              await job.outcome;
            } finally {
              job.state = "released";
              this.#jobsRetained -= 1;
            }
          },
        );
        scope.jobs.add(job);
        this.#jobsActive += 1;
        this.#jobsRetained += 1;
        this.#maximumJobsRetained = Math.max(
          this.#maximumJobsRetained,
          this.#jobsRetained,
        );
        // Admission, capture transfer, and cleanup registration precede execution.
        void this.#runJob(scope, job, work, completion.resolve);
        return handle;
      } catch (error) {
        await lifetime.close(error);
        throw error;
      }
    };
    const parallel: HostOperation = (context, request) => {
      if (options.workers === undefined) {
        throw new Error("this Spark executor has no worker pool");
      }
      const [, work] = tuple(request, 2);
      if (!isHostCallback(work)) {
        throw new TypeError("Spark worker operations require compiled work");
      }
      let priority: "required" | "speculative" = "required";
      if (context.operation.sourceName === "speculate") {
        priority = "speculative";
      }
      assignCallbackExecutor(work, options.workers, { priority });
      return spawn(context, request);
    };
    this.#operations = new Map<string, HostOperation>([
      ["scope", (context, request) => {
        const [executor, body] = tuple(request, 2);
        if (this.#executors.get(executor) !== this) {
          throw new TypeError("executor belongs to another Spark runtime");
        }
        if (!isHostCallback(body)) {
          throw new TypeError("Spark.scope requires a compiled body");
        }
        return this.#runScope(context.scope, body);
      }],
      ["child_scope", (_context, request) => {
        const [parent, body] = tuple(request, 2);
        const scope = this.#scopes.get(parent);
        this.#assertOpen(scope);
        if (!isHostCallback(body)) {
          throw new TypeError("Spark.child_scope requires a compiled body");
        }
        return this.#runScope(scope.lifetime, body);
      }],
      ["spawn", spawn],
      ["parallel", parallel],
      ["speculate", parallel],
      ["join", async (context, handle) => {
        const parameter = context.operation.function.parameters[0];
        const { family, job } = this.#requireJob(parameter, handle);
        job.state = "joining";
        if (job.work !== undefined) demandHostCallback(job.work);
        const retired = family.release(handle);
        try {
          const outcome = await job.outcome;
          if (outcome.kind === "failed") throw outcome.cause;
          return outcome.value;
        } finally {
          await retired;
        }
      }],
      ["cancel", async (context, handle) => {
        const parameter = context.operation.function.parameters[0];
        const { family, job } = this.#requireJob(parameter, handle);
        job.state = "cancelled";
        job.scope.cancel(new DOMException("Spark job cancelled", "AbortError"));
        await family.release(handle);
        return null;
      }],
      ["yield", async (_context, handle) => {
        const scope = this.#scopes.get(handle);
        this.#assertOpen(scope);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        scope.lifetime.signal.throwIfAborted();
        return null;
      }],
      ["on_exit", (_context, request) => {
        const [handle, cleanup] = tuple(request, 2);
        const scope = this.#scopes.get(handle);
        this.#assertOpen(scope);
        if (!isHostCallback(cleanup)) {
          throw new TypeError(
            "Spark.on_exit requires a compiled cleanup callback",
          );
        }
        registerHostFinalizer(cleanup, scope.lifetime);
        return null;
      }],
    ]);
  }

  get statistics(): Readonly<{
    jobsActive: number;
    jobsRetained: number;
    maximumJobsRetained: number;
  }> {
    return Object.freeze({
      jobsActive: this.#jobsActive,
      jobsRetained: this.#jobsRetained,
      maximumJobsRetained: this.#maximumJobsRetained,
    });
  }

  capabilitiesFor(
    artifact: Pick<CompilerArtifact, "manifestBytes">,
  ): HostCapabilities {
    const requested = new Map<string, HostOperation>();
    for (const imported of decodeManifest(artifact.manifestBytes).imports) {
      if (imported.capability !== "SparkRuntime") continue;
      const operation = this.#operations.get(imported.sourceName);
      if (operation === undefined) {
        throw new TypeError(
          `unsupported Spark operation ${imported.sourceName}`,
        );
      }
      requested.set(imported.sourceName, operation);
    }
    if (requested.size === 0) return new Map();
    return new Map([["SparkRuntime", requested]]);
  }

  scopeLifetime(handle: RuntimeValue): HostScope {
    const scope = this.#scopes.get(handle);
    this.#assertOpen(scope);
    return scope.lifetime;
  }

  // Keep the callback out of the handle disposer's retained lexical environment.
  async #runJob(
    scope: SparkScope,
    job: SparkJob,
    work: HostCallback,
    complete: (outcome: JobOutcome) => void,
  ): Promise<void> {
    let outcome: JobOutcome;
    try {
      const value = await work.call();
      outcome = { kind: "returned", value };
    } catch (cause) {
      if (
        (job.kind === "required" || job.state === "joining") &&
        (!job.scope.signal.aborted || cause !== job.scope.signal.reason)
      ) {
        scope.failures.add(cause);
        scope.lifetime.cancel(cause);
      }
      outcome = { kind: "failed", cause };
    }
    job.work = undefined;
    try {
      await job.scope.close();
    } catch (cause) {
      let failure = cause;
      if (outcome.kind === "failed") {
        failure = new AggregateError(
          [outcome.cause, cause],
          "Spark job cleanup failed",
        );
      }
      scope.failures.add(failure);
      scope.lifetime.cancel(failure);
      outcome = { kind: "failed", cause: failure };
    }
    scope.jobs.delete(job);
    this.#jobsActive -= 1;
    complete(outcome);
  }

  async #runScope(
    parent: HostScope,
    body: HostCallback,
  ): Promise<RuntimeValue> {
    const lifetime = new HostScope(parent);
    const scope: SparkScope = {
      lifetime,
      jobs: new Set(),
      failures: new Set(),
      phase: "open",
    };
    let outcome: { readonly value: RuntimeValue } | { readonly cause: unknown };
    try {
      moveHostCallback(body, lifetime);
      const handle = this.#scopes.grant(lifetime, scope);
      const result = await body.call(handle);
      moveResultCallbacks(result, parent);
      scope.phase = "joining";
      await Promise.all(
        [...scope.jobs].filter((job) =>
          job.kind === "speculative" && job.state === "available"
        ).map((job) =>
          job.scope.close(
            new DOMException("unused speculative Spark", "AbortError"),
          )
        ),
      );
      await Promise.all([...scope.jobs].map((job) => job.outcome));
      if (scope.failures.size > 0) {
        throw new AggregateError(scope.failures, "Spark scope failed");
      }
      outcome = { value: result };
    } catch (cause) {
      outcome = { cause };
    }
    scope.phase = "closed";
    try {
      await lifetime.close();
    } catch (error) {
      if ("cause" in outcome) {
        throw new AggregateError(
          [outcome.cause, error],
          "Spark scope cleanup failed",
        );
      }
      throw error;
    }
    if ("cause" in outcome) throw outcome.cause;
    return outcome.value;
  }

  #assertOpen(scope: SparkScope): void {
    if (scope.phase !== "open") {
      throw new Error("Spark scope is no longer admitting work");
    }
    scope.lifetime.assertOpen();
  }

  #jobFamily(payload: BlotAbiType): ResourceFamily<SparkJob> {
    const key = JSON.stringify(payload);
    let family = this.#jobs.get(key);
    if (family === undefined) {
      family = this.#root.resource<SparkJob>("Spark.Job", { payload });
      this.#jobs.set(key, family);
    }
    return family;
  }

  #requireJob(
    type: BlotAbiType,
    handle: RuntimeValue,
  ): { readonly family: ResourceFamily<SparkJob>; readonly job: SparkJob } {
    if (type.kind !== "resource" || type.name !== "Spark.Job") {
      throw new Error("checked Spark operation has no job parameter");
    }
    const family = this.#jobFamily(type.payload);
    const job = family.get(handle);
    if (job.state !== "available") {
      throw new Error("Spark job has already been consumed");
    }
    return { family, job };
  }
}

function moveResultCallbacks(
  value: RuntimeValue,
  destination: HostScope,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const element of value) moveResultCallbacks(element, destination);
    return;
  }
  if (!("kind" in value)) throw new Error("invalid Spark result");
  switch (value.kind) {
    case "callback":
      moveHostCallback(value, destination);
      return;
    case "record":
      for (const field of value.fields.values()) {
        moveResultCallbacks(field, destination);
      }
      return;
    case "variant":
      if (value.payload !== undefined) {
        moveResultCallbacks(value.payload, destination);
      }
      return;
    case "sealed":
      moveResultCallbacks(value.value, destination);
      return;
    case "resource":
      return;
  }
}

function tuple(value: RuntimeValue, arity: number): readonly RuntimeValue[] {
  if (
    value === null || typeof value !== "object" || !("kind" in value) ||
    value.kind !== "record" || value.fields.size !== arity
  ) {
    throw new TypeError(`expected a ${arity}-field Spark operation tuple`);
  }
  return Array.from({ length: arity }, (_, index) => {
    const field = value.fields.get(String(index));
    if (field === undefined) {
      throw new TypeError(`missing Spark tuple field ${index}`);
    }
    return field;
  });
}
