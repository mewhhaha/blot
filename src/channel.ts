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

interface Sending {
  readonly message: RuntimeValue;
  readonly finish: (accepted: boolean) => void;
  readonly cancel: (reason: unknown) => void;
}

const closed: RuntimeValue = Object.freeze({ kind: "variant", name: "None" });

/** A bounded mailbox. Capacity zero is a rendezvous between sender and receiver. */
class ScopedChannel implements ReceiveSource {
  readonly #capacity: number;
  readonly #messages = new Queue<RuntimeValue>();
  readonly #senders = new Queue<Sending>();
  readonly #receivers = new Queue<ReceiveWaiter>();
  readonly #signal: AbortSignal;
  readonly #cancel: () => void;
  #closed = false;

  constructor(capacity: number, scope: HostScope) {
    scope.assertOpen();
    this.#capacity = capacity;
    this.#signal = scope.signal;
    this.#cancel = () => {
      this.#closed = true;
      for (
        let sender = this.#senders.shift();
        sender !== undefined;
        sender = this.#senders.shift()
      ) {
        sender.cancel(this.#signal.reason);
      }
      for (
        let receiver = this.#receivers.shift();
        receiver !== undefined;
        receiver = this.#receivers.shift()
      ) {
        receiver.reject(this.#signal.reason);
      }
      this.#messages.clear();
    };
    this.#signal.addEventListener("abort", this.#cancel, { once: true });
  }

  send(message: RuntimeValue, signal: AbortSignal): boolean | Promise<boolean> {
    signal.throwIfAborted();
    this.#signal.throwIfAborted();
    if (this.#closed) return false;
    for (
      let receiver = this.#receivers.shift();
      receiver !== undefined;
      receiver = this.#receivers.shift()
    ) {
      if (
        receiver.accept(() => ({
          kind: "variant",
          name: "Some",
          payload: message,
        }))
      ) return true;
    }
    if (this.#messages.size < this.#capacity) {
      this.#messages.push(message);
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      const remove = () => {
        unlink();
        signal.removeEventListener("abort", abort);
      };
      const cancel = (reason: unknown) => {
        remove();
        reject(reason);
      };
      const abort = () => cancel(signal.reason);
      const unlink = this.#senders.push({
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

  register(waiter: ReceiveWaiter): () => void {
    this.#signal.throwIfAborted();
    if (this.#messages.size > 0 || this.#senders.size > 0 || this.#closed) {
      waiter.accept(() => {
        if (this.#messages.size > 0) {
          const message = this.#messages.shift();
          if (message === undefined) {
            throw new Error("channel lost its ready message");
          }
          const sender = this.#senders.shift();
          if (sender !== undefined) {
            this.#messages.push(sender.message);
            sender.finish(true);
          }
          return { kind: "variant", name: "Some", payload: message };
        }
        const sender = this.#senders.shift();
        if (sender !== undefined) {
          sender.finish(true);
          return { kind: "variant", name: "Some", payload: sender.message };
        }
        return closed;
      });
      return () => {};
    }
    return this.#receivers.push(waiter);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (
      let sender = this.#senders.shift();
      sender !== undefined;
      sender = this.#senders.shift()
    ) sender.finish(false);
    for (
      let receiver = this.#receivers.shift();
      receiver !== undefined;
      receiver = this.#receivers.shift()
    ) receiver.accept(() => closed);
  }

  dispose(): void {
    this.close();
    this.#messages.clear();
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
          receiveFrom(
            this.#family(context.operation.function.parameters[0]).get(
              receiver,
            ),
            context.signal,
          ),
      ],
      ["close", (context, sender) => {
        this.#family(context.operation.function.parameters[0]).get(sender)
          .close();
        return null;
      }],
    ]);
  }

  receiveSource(type: BlotAbiType, handle: RuntimeValue): ReceiveSource {
    if (type.kind !== "resource" || type.name !== "Channel.Receiver") {
      throw new TypeError("expected a channel receiver type");
    }
    return this.#family(type).get(handle);
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
