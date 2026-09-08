import { decodeManifest, type RuntimeValue } from "./abi_values.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";
import type { HostCapabilities, HostOperation } from "./host.ts";
import {
  type HostResource,
  HostScope,
  type ResourceFamily,
} from "./resources.ts";
import type { SparkRuntime } from "./spark.ts";

interface Sending {
  readonly message: RuntimeValue;
  readonly finish: (accepted: boolean) => void;
  readonly cancel: (reason: unknown) => void;
}

interface Receiving {
  readonly finish: (message: RuntimeValue) => void;
  readonly cancel: (reason: unknown) => void;
}

const closed: RuntimeValue = Object.freeze({ kind: "variant", name: "None" });

/** A bounded mailbox. Capacity zero is a rendezvous between sender and receiver. */
class ScopedChannel {
  readonly #capacity: number;
  readonly #messages: RuntimeValue[] = [];
  readonly #senders = new Map<symbol, Sending>();
  readonly #receivers = new Map<symbol, Receiving>();
  readonly #signal: AbortSignal;
  readonly #cancel: () => void;
  #closed = false;

  constructor(capacity: number, scope: HostScope) {
    scope.assertOpen();
    this.#capacity = capacity;
    this.#signal = scope.signal;
    this.#cancel = () => {
      this.#closed = true;
      for (const sender of this.#senders.values()) {
        sender.cancel(this.#signal.reason);
      }
      for (const receiver of this.#receivers.values()) {
        receiver.cancel(this.#signal.reason);
      }
      this.#messages.length = 0;
    };
    this.#signal.addEventListener("abort", this.#cancel, { once: true });
  }

  send(message: RuntimeValue, signal: AbortSignal): boolean | Promise<boolean> {
    signal.throwIfAborted();
    this.#signal.throwIfAborted();
    if (this.#closed) return false;
    const receiver = this.#receivers.values().next();
    if (!receiver.done) {
      receiver.value.finish({
        kind: "variant",
        name: "Some",
        payload: message,
      });
      return true;
    }
    if (this.#messages.length < this.#capacity) {
      this.#messages.push(message);
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      const id = Symbol("pending send");
      const remove = () => {
        this.#senders.delete(id);
        signal.removeEventListener("abort", abort);
      };
      const cancel = (reason: unknown) => {
        remove();
        reject(reason);
      };
      const abort = () => cancel(signal.reason);
      this.#senders.set(id, {
        message,
        finish(accepted) {
          remove();
          resolve(accepted);
        },
        cancel,
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  receive(signal: AbortSignal): RuntimeValue | Promise<RuntimeValue> {
    signal.throwIfAborted();
    this.#signal.throwIfAborted();
    if (this.#messages.length > 0) {
      const message = this.#messages.shift()!;
      const sender = this.#senders.values().next();
      if (!sender.done) {
        this.#messages.push(sender.value.message);
        sender.value.finish(true);
      }
      return { kind: "variant", name: "Some", payload: message };
    }
    const sender = this.#senders.values().next();
    if (!sender.done) {
      const message = sender.value.message;
      sender.value.finish(true);
      return { kind: "variant", name: "Some", payload: message };
    }
    if (this.#closed) return closed;
    return new Promise<RuntimeValue>((resolve, reject) => {
      const id = Symbol("pending receive");
      const remove = () => {
        this.#receivers.delete(id);
        signal.removeEventListener("abort", abort);
      };
      const cancel = (reason: unknown) => {
        remove();
        reject(reason);
      };
      const abort = () => cancel(signal.reason);
      this.#receivers.set(id, {
        finish(message) {
          remove();
          resolve(message);
        },
        cancel,
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const sender of this.#senders.values()) sender.finish(false);
    for (const receiver of this.#receivers.values()) receiver.finish(closed);
  }

  dispose(): void {
    this.close();
    this.#messages.length = 0;
    this.#signal.removeEventListener("abort", this.#cancel);
  }
}

export class ChannelRuntime {
  readonly #root: HostScope;
  readonly #families = new Map<string, ResourceFamily<ScopedChannel>>();
  readonly #operations: ReadonlyMap<string, HostOperation>;

  constructor(root: HostScope, sparks: SparkRuntime) {
    this.#root = root;
    this.#operations = new Map<string, HostOperation>([
      ["bounded", (context, request) => {
        const [scope, capacity] = tuple(request, 2);
        if (
          typeof capacity !== "bigint" || capacity < 0n ||
          capacity > 2147483647n
        ) {
          throw new RangeError(
            "channel capacity must be an integer between 0 and 2147483647",
          );
        }
        const lifetime = sparks.scopeLifetime(resource(scope));
        const type = context.operation.function.result;
        if (type.kind !== "record") {
          throw new Error("checked channel constructor has no endpoint record");
        }
        const sender = type.fields.find((field) => field.name === "sender");
        const receiver = type.fields.find((field) => field.name === "receiver");
        if (
          sender === undefined || receiver === undefined ||
          type.fields.length !== 2
        ) {
          throw new Error("checked channel constructor has invalid endpoints");
        }
        const senders = this.#family(sender.type);
        const receivers = this.#family(receiver.type);
        const channel = new ScopedChannel(Number(capacity), lifetime);
        let sending: HostResource;
        try {
          sending = senders.grant(
            lifetime,
            channel,
            (channel) => channel.dispose(),
          );
        } catch (error) {
          channel.dispose();
          throw error;
        }
        const fields = new Map<string, RuntimeValue>([
          ["sender", sending],
          ["receiver", receivers.grant(lifetime, channel)],
        ]);
        return { kind: "record", fields };
      }],
      ["send", (context, request) => {
        const [sender, message] = tuple(request, 2);
        const parameter = context.operation.function.parameters[0];
        if (parameter.kind !== "record") {
          throw new Error("checked channel send has no tuple parameter");
        }
        const endpoint = parameter.fields.find((field) => field.name === "0");
        if (endpoint === undefined) {
          throw new Error("checked channel send has no sender");
        }
        return this.#family(endpoint.type).get(sender).send(
          message,
          context.signal,
        );
      }],
      [
        "receive",
        (context, receiver) =>
          this.#family(context.operation.function.parameters[0]).get(receiver)
            .receive(context.signal),
      ],
      ["close", (context, sender) => {
        this.#family(context.operation.function.parameters[0]).get(sender)
          .close();
        return null;
      }],
    ]);
  }

  capabilitiesFor(
    artifact: Pick<CompilerArtifact, "manifestBytes">,
  ): HostCapabilities {
    const requested = new Map<string, HostOperation>();
    for (const imported of decodeManifest(artifact.manifestBytes).imports) {
      if (imported.capability !== "ChannelRuntime") continue;
      const operation = this.#operations.get(imported.sourceName);
      if (operation === undefined) {
        throw new TypeError(
          `unsupported Channel operation ${imported.sourceName}`,
        );
      }
      requested.set(imported.sourceName, operation);
    }
    if (requested.size === 0) return new Map();
    return new Map([["ChannelRuntime", requested]]);
  }

  #family(type: BlotAbiType): ResourceFamily<ScopedChannel> {
    if (
      type.kind !== "resource" ||
      (type.name !== "Channel.Sender" && type.name !== "Channel.Receiver")
    ) {
      throw new Error("checked channel operation has no endpoint type");
    }
    const key = JSON.stringify([type.name, type.payload]);
    let family = this.#families.get(key);
    if (family === undefined) {
      family = this.#root.resource<ScopedChannel>(type.name, {
        payload: type.payload,
      });
      this.#families.set(key, family);
    }
    return family;
  }
}

function resource(value: RuntimeValue): HostResource {
  if (
    value === null || typeof value !== "object" || !("kind" in value) ||
    value.kind !== "resource"
  ) {
    throw new TypeError("expected a Spark scope resource");
  }
  return value;
}

function tuple(value: RuntimeValue, arity: number): readonly RuntimeValue[] {
  if (
    value === null || typeof value !== "object" || !("kind" in value) ||
    value.kind !== "record" || value.fields.size !== arity
  ) {
    throw new TypeError(`expected a ${arity}-field Channel operation tuple`);
  }
  return Array.from({ length: arity }, (_, index) => {
    const field = value.fields.get(String(index));
    if (field === undefined) {
      throw new TypeError(`missing Channel tuple field ${index}`);
    }
    return field;
  });
}
