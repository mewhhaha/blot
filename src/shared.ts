import { decodeManifest, type RuntimeValue } from "./abi_values.ts";
import {
  assignCallbackExecutor,
  type CallbackExecutor,
  isHostCallback,
  moveHostCallback,
} from "./callbacks.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";
import type { HostCapabilities, HostOperation } from "./host.ts";
import { HostScope, type ResourceFamily } from "./resources.ts";
import {
  mapSharedResources,
  type SharedLoan,
  type SharedMemoryWire,
  sharedNumber,
  sharedStorage,
  sharedTuple,
  sharedView,
} from "./shared_memory.ts";
import type { SparkRuntime } from "./spark.ts";

interface Allocation {
  readonly scope: HostScope;
  readonly wire: SharedMemoryWire;
}

interface Partition {
  readonly allocation: Allocation;
  readonly start: number;
  readonly length: number;
  generation: number;
  phase:
    | { readonly kind: "idle" }
    | { readonly kind: "split"; readonly witness: Rejoin }
    | { readonly kind: "running"; readonly loan: SharedLoan }
    | { readonly kind: "joined" };
}

interface Rejoin {
  readonly parent: Partition;
  readonly left: Partition;
  readonly right: Partition;
  consumed: boolean;
}

type SharedResource =
  | {
    readonly kind: "partition";
    readonly partition: Partition;
    readonly generation: number;
  }
  | { readonly kind: "rejoin"; readonly witness: Rejoin }
  | { readonly kind: "atomic"; readonly allocation: Allocation };

/** Disjoint numeric loans and atomic counters under an explicit Spark scope. */
export class SharedRuntime {
  readonly #root: HostScope;
  readonly #families = new Map<string, ResourceFamily<SharedResource>>();
  readonly #operations: ReadonlyMap<string, HostOperation>;

  constructor(
    root: HostScope,
    sparks: SparkRuntime,
    workers: CallbackExecutor,
  ) {
    this.#root = root;
    const allocate: HostOperation = (context, request) => {
      if (typeof SharedArrayBuffer === "undefined") {
        throw new Error(
          "shared numeric storage requires SharedArrayBuffer; browser hosts must enable cross-origin isolation",
        );
      }
      const [scope, values] = sharedTuple(request, 2);
      const lifetime = sparks.scopeLifetime(scope);
      const type = context.operation.function.result;
      const storage = sharedStorage(type);
      let initial: readonly RuntimeValue[];
      if (storage === "atomic_i32") initial = [values];
      else {
        if (!Array.isArray(values)) {
          throw new TypeError("expected a shared numeric array");
        }
        initial = values;
      }
      const numbers = initial.map((value) => sharedNumber(storage, value));
      let width = 4;
      if (storage === "f64") width = 8;
      const wire: SharedMemoryWire = {
        storage,
        buffer: new SharedArrayBuffer(numbers.length * width),
        control: new SharedArrayBuffer(4),
        start: 0,
        length: numbers.length,
        generation: 1,
      };
      Atomics.store(new Int32Array(wire.control), 0, 1);
      sharedView(wire).set(numbers);
      const allocation: Allocation = { scope: lifetime, wire };
      lifetime.own(() => {
        invalidate(allocation);
        return Promise.resolve();
      });
      if (storage === "atomic_i32") {
        return this.#family(type).grant(lifetime, {
          kind: "atomic",
          allocation,
        });
      }
      const partition: Partition = {
        allocation,
        start: 0,
        length: numbers.length,
        generation: 1,
        phase: { kind: "idle" },
      };
      return this.#grant(type, partition);
    };
    this.#operations = new Map<string, HostOperation>([
      ["i32", allocate],
      ["f32", allocate],
      ["f64", allocate],
      ["atomic", allocate],
      ["split", (context, request) => {
        const [handle, boundary] = sharedTuple(request, 2);
        const parameter = fieldType(
          context.operation.function.parameters[0],
          "0",
        );
        const parent = this.#partition(parameter, handle);
        if (
          typeof boundary !== "bigint" || boundary < 0n ||
          boundary > BigInt(parent.length)
        ) {
          throw new RangeError(
            "shared split boundary is outside its partition",
          );
        }
        const left: Partition = {
          allocation: parent.allocation,
          start: parent.start,
          length: Number(boundary),
          generation: 1,
          phase: { kind: "idle" },
        };
        const right: Partition = {
          allocation: parent.allocation,
          start: parent.start + left.length,
          length: parent.length - left.length,
          generation: 1,
          phase: { kind: "idle" },
        };
        const witness: Rejoin = { parent, left, right, consumed: false };
        const result = context.operation.function.result;
        const fields = new Map<string, RuntimeValue>([
          ["left", this.#grant(fieldType(result, "left"), left)],
          ["right", this.#grant(fieldType(result, "right"), right)],
          [
            "rejoin",
            this.#family(fieldType(result, "rejoin")).grant(
              parent.allocation.scope,
              { kind: "rejoin", witness },
            ),
          ],
        ]);
        parent.phase = { kind: "split", witness };
        return { kind: "record", fields };
      }],
      ["join", (context, handle) => {
        const lease = this.#family(context.operation.function.parameters[0])
          .get(handle);
        if (lease.kind !== "rejoin") {
          throw new TypeError("expected a shared rejoin witness");
        }
        const { witness } = lease;
        const { parent, left, right } = witness;
        sharedView(parent.allocation.wire);
        if (
          witness.consumed || parent.phase.kind !== "split" ||
          parent.phase.witness !== witness
        ) {
          throw new TypeError(
            "shared rejoin witness has already been consumed",
          );
        }
        if (left.phase.kind !== "idle" || right.phase.kind !== "idle") {
          throw new TypeError(
            "shared join requires both exact children to be idle and rejoined",
          );
        }
        if (!Number.isSafeInteger(parent.generation + 1)) {
          throw new RangeError("shared partition generation exhausted");
        }
        witness.consumed = true;
        left.phase = { kind: "joined" };
        right.phase = { kind: "joined" };
        parent.generation += 1;
        parent.phase = { kind: "idle" };
        return this.#grant(context.operation.function.result, parent);
      }],
      ["snapshot", (context, handle) => {
        const partition = this.#partition(
          context.operation.function.parameters[0],
          handle,
        );
        const view = sharedView(partitionWire(partition));
        if (partition.allocation.wire.storage === "i32") {
          return Array.from(view, (value) => BigInt(value));
        }
        return Array.from(view);
      }],
      ["run", async (context, request) => {
        const [scope, argument, work] = sharedTuple(request, 3);
        if (!isHostCallback(work)) {
          throw new TypeError("Shared.run requires a compiled kernel");
        }
        const selected = sparks.scopeLifetime(scope);
        const parameter = context.operation.function.parameters[0];
        const lifetime = new HostScope(selected);
        const partitions = new Set<Partition>();
        const memories: SharedMemoryWire[] = [];
        let admitted = false;
        let claimed = false;
        let outcome:
          | { readonly kind: "returned"; readonly value: RuntimeValue }
          | { readonly kind: "failed"; readonly cause: unknown };
        const cancel = () => lifetime.cancel(context.signal.reason);
        context.signal.addEventListener("abort", cancel, { once: true });
        if (context.signal.aborted) cancel();
        let loan: SharedLoan | undefined;
        try {
          moveHostCallback(work, lifetime);
          const encoded = mapSharedResources(
            fieldType(parameter, "1"),
            argument,
            (type, handle) => {
              const lease = this.#family(type).get(handle);
              let wire: SharedMemoryWire;
              let owner: HostScope;
              if (lease.kind === "partition") {
                const partition = this.#partition(type, handle);
                owner = partition.allocation.scope;
                partitions.add(partition);
                wire = partitionWire(partition);
              } else if (lease.kind === "atomic") {
                owner = lease.allocation.scope;
                wire = lease.allocation.wire;
                sharedView(wire);
              } else {throw new TypeError(
                  "rejoin witnesses cannot enter a worker",
                );}
              if (!selected.isWithin(owner)) {
                throw new TypeError(
                  "shared kernel cannot outlive its numeric allocation",
                );
              }
              const index = memories.length;
              memories.push(wire);
              return BigInt(index);
            },
          );
          loan = {
            argument: encoded,
            memories,
            admitted() {
              admitted = true;
            },
          };
          for (const partition of partitions) {
            partition.phase = { kind: "running", loan };
          }
          claimed = true;
          assignCallbackExecutor(work, workers, {
            priority: "required",
            shared: loan,
          });
          const result = await work.call(argument, { signal: context.signal });
          // No resource authority can escape back from a worker's private registry.
          mapSharedResources(context.operation.function.result, result, () => {
            throw new TypeError(
              "shared kernels must return private canonical values",
            );
          });
          outcome = { kind: "returned", value: result };
        } catch (cause) {
          outcome = { kind: "failed", cause };
        }
        context.signal.removeEventListener("abort", cancel);
        try {
          await lifetime.close();
        } catch (cleanup) {
          let cause = cleanup;
          if (outcome.kind === "failed") {
            cause = new AggregateError(
              [outcome.cause, cleanup],
              "shared kernel and cleanup failed",
            );
          }
          outcome = { kind: "failed", cause };
        }
        if (claimed) {
          for (const partition of partitions) {
            if (
              partition.phase.kind !== "running" ||
              partition.phase.loan !== loan
            ) {
              throw new Error("shared partition lost its running loan");
            }
            if (outcome.kind === "failed" && admitted) {
              invalidate(partition.allocation);
            }
            partition.phase = { kind: "idle" };
          }
        }
        if (outcome.kind === "failed") throw outcome.cause;
        return outcome.value;
      }],
    ]);
  }

  capabilitiesFor(
    artifact: Pick<CompilerArtifact, "manifestBytes">,
  ): HostCapabilities {
    const requested = new Map<string, HostOperation>();
    const access = new Map<string, HostOperation>();
    for (const operation of decodeManifest(artifact.manifestBytes).imports) {
      if (operation.capability === "SharedAccess") {
        access.set(operation.sourceName, () => {
          throw new TypeError(
            "Shared.Access requires an explicit Shared.run kernel",
          );
        });
      }
      if (operation.capability !== "SharedRuntime") continue;
      const implementation = this.#operations.get(operation.sourceName);
      if (implementation === undefined) {
        throw new TypeError(
          `unsupported Shared operation ${operation.sourceName}`,
        );
      }
      requested.set(operation.sourceName, implementation);
    }
    const capabilities = new Map<string, ReadonlyMap<string, HostOperation>>();
    if (requested.size > 0) capabilities.set("SharedRuntime", requested);
    if (access.size > 0) capabilities.set("SharedAccess", access);
    return capabilities;
  }

  #family(type: BlotAbiType): ResourceFamily<SharedResource> {
    sharedStorage(type);
    if (type.kind !== "resource") {
      throw new Error("checked Shared operation lost its resource type");
    }
    const key = JSON.stringify([type.name, type.payload]);
    let family = this.#families.get(key);
    if (family === undefined) {
      family = this.#root.resource<SharedResource>(type.name, {
        payload: type.payload,
      });
      this.#families.set(key, family);
    }
    return family;
  }

  #grant(type: BlotAbiType, partition: Partition): RuntimeValue {
    return this.#family(type).grant(partition.allocation.scope, {
      kind: "partition",
      partition,
      generation: partition.generation,
    });
  }

  #partition(type: BlotAbiType, handle: RuntimeValue): Partition {
    const lease = this.#family(type).get(handle);
    if (lease.kind !== "partition") {
      throw new TypeError("expected a shared partition");
    }
    const { partition } = lease;
    sharedView(partition.allocation.wire);
    if (lease.generation !== partition.generation) {
      throw new TypeError("shared partition handle is stale");
    }
    if (partition.phase.kind !== "idle") {
      throw new TypeError(
        `shared partition is ${partition.phase.kind}; exclusive access requires idle ownership`,
      );
    }
    return partition;
  }
}

function fieldType(type: BlotAbiType, name: string): BlotAbiType {
  if (type.kind !== "record") {
    throw new Error("checked Shared operation has no record type");
  }
  const field = type.fields.find((field) => field.name === name);
  if (field === undefined) {
    throw new Error(`checked Shared operation has no ${name} field`);
  }
  return field.type;
}

function partitionWire(partition: Partition): SharedMemoryWire {
  return {
    ...partition.allocation.wire,
    start: partition.start,
    length: partition.length,
  };
}

function invalidate(allocation: Allocation): void {
  Atomics.store(new Int32Array(allocation.wire.control), 0, 0);
}
