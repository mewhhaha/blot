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
  readonly work: HostCallback;
  readonly kind: "required" | "speculative";
  demanded: boolean;
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
          demanded: false,
        };
        const handle = this.#jobFamily(result.payload).grant(
          scope.lifetime,
          job,
          async () => {
            await lifetime.close();
            await job.outcome;
          },
        );
        scope.jobs.add(job);
        // Admission, capture transfer, and cleanup registration precede execution.
        void Promise.resolve().then(() => work.call()).then(
          (value) => completion.resolve({ kind: "returned", value }),
          (cause: unknown) => {
            if (
              (job.kind === "required" || job.demanded) &&
              (!lifetime.signal.aborted || cause !== lifetime.signal.reason)
            ) {
              scope.failures.add(cause);
              scope.lifetime.cancel(cause);
            }
            completion.resolve({ kind: "failed", cause });
          },
        );
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
        const job = this.#requireJob(parameter, handle);
        job.demanded = true;
        demandHostCallback(job.work);
        const outcome = await job.outcome;
        if (outcome.kind === "failed") throw outcome.cause;
        return outcome.value;
      }],
      ["cancel", async (context, handle) => {
        const job = this.#requireJob(
          context.operation.function.parameters[0],
          handle,
        );
        await job.scope.close(
          new DOMException("Spark job cancelled", "AbortError"),
        );
        await job.outcome;
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
    let failure: { readonly cause: unknown } | undefined;
    try {
      moveHostCallback(body, lifetime);
      const handle = this.#scopes.grant(lifetime, scope);
      const result = await body.call(handle);
      scope.phase = "joining";
      await Promise.all(
        [...scope.jobs].filter((job) =>
          job.kind === "speculative" && !job.demanded
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
      return result;
    } catch (cause) {
      failure = { cause };
      throw cause;
    } finally {
      scope.phase = "closed";
      try {
        await lifetime.close();
      } catch (error) {
        if (failure !== undefined) {
          throw new AggregateError(
            [failure.cause, error],
            "Spark scope cleanup failed",
          );
        }
        throw error;
      }
    }
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

  #requireJob(type: BlotAbiType, handle: RuntimeValue): SparkJob {
    if (type.kind !== "resource" || type.name !== "Spark.Job") {
      throw new Error("checked Spark operation has no job parameter");
    }
    return this.#jobFamily(type.payload).get(handle);
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
