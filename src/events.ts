import { decodeManifest, type RuntimeValue } from "./abi_values.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";
import type { HostCapabilities, HostOperation } from "./host.ts";
import type { HostResource, HostScope, ResourceFamily } from "./resources.ts";
import type { SparkRuntime } from "./spark.ts";
import { Queue } from "./queue.ts";
import {
  receiveFrom,
  type ReceiveSource,
  type ReceiveWaiter,
} from "./receiving.ts";

export interface EventSink {
  emit(message: RuntimeValue): void;
  close(): void;
  fail(cause: unknown): void;
}

type Subscribe = (sink: EventSink) => () => void;
type EventPolicy = { readonly kind: "latest" } | {
  readonly kind: "queue";
  readonly capacity: number;
};

class Subscription implements EventSink, ReceiveSource {
  readonly #messages = new Queue<RuntimeValue>();
  readonly #waiting = new Queue<ReceiveWaiter>();
  readonly #policy: EventPolicy;
  #state: { kind: "open" } | { kind: "closed" } | {
    kind: "failed";
    cause: unknown;
  } = { kind: "open" };
  #detach: (() => void) | undefined;

  constructor(policy: EventPolicy) {
    this.#policy = policy;
  }

  attach(subscribe: Subscribe): void {
    const detach = subscribe(this);
    if (this.#state.kind === "open") this.#detach = detach;
    else detach();
  }

  emit(message: RuntimeValue): void {
    if (this.#state.kind !== "open") return;
    for (
      let waiting = this.#waiting.shift();
      waiting !== undefined;
      waiting = this.#waiting.shift()
    ) {
      if (
        waiting.accept(() => ({
          kind: "variant",
          name: "Some",
          payload: message,
        }))
      ) return;
    }
    if (this.#policy.kind === "latest") {
      this.#messages.clear();
      this.#messages.push(message);
    } else if (this.#messages.size < this.#policy.capacity) {
      this.#messages.push(message);
    } else {
      this.fail(
        new Error(
          `event queue exceeded its ${this.#policy.capacity}-message capacity`,
        ),
      );
    }
  }

  register(waiter: ReceiveWaiter): () => void {
    if (this.#state.kind === "failed") {
      waiter.reject(this.#state.cause);
      return () => {};
    }
    if (this.#messages.size > 0) {
      waiter.accept(() => {
        const message = this.#messages.shift();
        if (message === undefined) {
          throw new Error("subscription lost its ready message");
        }
        return { kind: "variant", name: "Some", payload: message };
      });
      return () => {};
    }
    if (this.#state.kind === "closed") {
      waiter.accept(() => ({ kind: "variant", name: "None" }));
      return () => {};
    }
    return this.#waiting.push(waiter);
  }

  close(): void {
    if (this.#state.kind !== "open") return;
    this.#state = { kind: "closed" };
    for (
      let waiting = this.#waiting.shift();
      waiting !== undefined;
      waiting = this.#waiting.shift()
    ) {
      waiting.accept(() => ({ kind: "variant", name: "None" }));
    }
    this.#unsubscribe();
  }

  fail(cause: unknown): void {
    if (this.#state.kind !== "open") return;
    this.#state = { kind: "failed", cause };
    this.#messages.clear();
    for (
      let waiting = this.#waiting.shift();
      waiting !== undefined;
      waiting = this.#waiting.shift()
    ) waiting.reject(cause);
    this.#unsubscribe();
  }

  dispose(): void {
    this.close();
    this.#messages.clear();
  }

  #unsubscribe(): void {
    const detach = this.#detach;
    this.#detach = undefined;
    detach?.();
  }
}

export class EventRuntime {
  readonly #root: HostScope;
  readonly #sources = new Map<string, ResourceFamily<Subscribe>>();
  readonly #subscriptions = new Map<string, ResourceFamily<Subscription>>();
  readonly #operations: ReadonlyMap<string, HostOperation>;

  constructor(root: HostScope, sparks: SparkRuntime) {
    this.#root = root;
    this.#operations = new Map<string, HostOperation>([
      ["subscribe", (context, request) => {
        if (
          request === null || typeof request !== "object" ||
          !("kind" in request) || request.kind !== "record" ||
          request.fields.size !== 3
        ) throw new TypeError("expected a three-field subscription request");
        const scope = request.fields.get("0");
        const source = request.fields.get("1");
        const policy = request.fields.get("2");
        const result = context.operation.function.result;
        if (
          scope === undefined || source === undefined || policy === undefined
        ) throw new TypeError("subscription request omitted a field");
        if (
          result.kind !== "resource" || result.name !== "Events.Subscription"
        ) throw new Error("checked subscribe operation lost its result type");
        const lifetime = sparks.scopeLifetime(scope);
        const subscribe = this.#sourceFamily(result.payload).get(source);
        const subscription = new Subscription(eventPolicy(policy));
        const handle = this.#subscriptionFamily(result.payload).grant(
          lifetime,
          subscription,
          () => subscription.dispose(),
        );
        subscription.attach(subscribe);
        return handle;
      }],
      [
        "next",
        (context, handle) =>
          receiveFrom(
            this.#subscription(
              context.operation.function.parameters[0],
              handle,
            ),
            context.signal,
          ),
      ],
      ["close", (context, handle) => {
        this.#subscription(context.operation.function.parameters[0], handle)
          .close();
        return null;
      }],
    ]);
  }

  source(
    scope: HostScope,
    payload: BlotAbiType,
    subscribe: Subscribe,
  ): HostResource {
    return this.#sourceFamily(payload).grant(scope, subscribe);
  }

  receiveSource(type: BlotAbiType, handle: RuntimeValue): ReceiveSource {
    return this.#subscription(type, handle);
  }

  capabilitiesFor(
    artifact: Pick<CompilerArtifact, "manifestBytes">,
  ): HostCapabilities {
    const requested = new Map<string, HostOperation>();
    for (const imported of decodeManifest(artifact.manifestBytes).imports) {
      if (imported.capability !== "Events") continue;
      const operation = this.#operations.get(imported.sourceName);
      if (operation === undefined) {
        throw new TypeError(
          `unsupported Events operation ${imported.sourceName}`,
        );
      }
      requested.set(imported.sourceName, operation);
    }
    if (requested.size === 0) return new Map();
    return new Map([["Events", requested]]);
  }

  #sourceFamily(payload: BlotAbiType): ResourceFamily<Subscribe> {
    const key = JSON.stringify(payload);
    let family = this.#sources.get(key);
    if (family === undefined) {
      family = this.#root.resource<Subscribe>("Events.Source", { payload });
      this.#sources.set(key, family);
    }
    return family;
  }

  #subscriptionFamily(payload: BlotAbiType): ResourceFamily<Subscription> {
    const key = JSON.stringify(payload);
    let family = this.#subscriptions.get(key);
    if (family === undefined) {
      family = this.#root.resource<Subscription>("Events.Subscription", {
        payload,
      });
      this.#subscriptions.set(key, family);
    }
    return family;
  }

  #subscription(type: BlotAbiType, handle: RuntimeValue): Subscription {
    if (type.kind !== "resource" || type.name !== "Events.Subscription") {
      throw new Error("checked event operation lost its subscription type");
    }
    return this.#subscriptionFamily(type.payload).get(handle);
  }
}

function eventPolicy(value: RuntimeValue): EventPolicy {
  if (
    value === null || typeof value !== "object" || !("kind" in value) ||
    value.kind !== "variant"
  ) throw new TypeError("expected an event subscription policy");
  if (value.name === "Latest" && value.payload === undefined) {
    return { kind: "latest" };
  }
  if (
    value.name === "Queue" && typeof value.payload === "bigint" &&
    value.payload > 0n && value.payload <= 2147483647n
  ) return { kind: "queue", capacity: Number(value.payload) };
  throw new RangeError(
    "event policy requires Latest or Queue with a positive capacity through 2147483647",
  );
}
