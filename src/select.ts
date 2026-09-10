import { decodeManifest, type RuntimeValue } from "./abi_values.ts";
import type { ChannelRuntime } from "./channel.ts";
import type { CompilerArtifact } from "./compiler.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { EventRuntime } from "./events.ts";
import type { HostCapabilities, HostOperation } from "./host.ts";
import type { IoRuntime } from "./io.ts";
import { type SelectArm, selectFrom } from "./selecting.ts";

/** Selection commits before reading, so a losing arm never takes a message. */
export class SelectRuntime {
  readonly #channels: ChannelRuntime;
  readonly #events: EventRuntime;
  readonly #io: IoRuntime;
  readonly #wait: HostOperation;

  constructor(channels: ChannelRuntime, events: EventRuntime, io: IoRuntime) {
    this.#channels = channels;
    this.#events = events;
    this.#io = io;
    this.#wait = (context, request) => {
      const arms = this.#arms(
        context.operation.function.parameters[0],
        request,
      );
      return selectFrom(arms, context.signal);
    };
  }

  capabilitiesFor(
    artifact: Pick<CompilerArtifact, "manifestBytes">,
  ): HostCapabilities {
    const operations = new Map<string, HostOperation>();
    for (const imported of decodeManifest(artifact.manifestBytes).imports) {
      if (imported.capability !== "SelectRuntime") continue;
      if (imported.sourceName !== "wait") {
        throw new TypeError(
          `unsupported Select operation ${imported.sourceName}`,
        );
      }
      operations.set("wait", this.#wait);
    }
    if (operations.size === 0) return new Map();
    return new Map([["SelectRuntime", operations]]);
  }

  #arms(type: BlotAbiType, request: RuntimeValue): readonly SelectArm[] {
    if (type.kind !== "array" || type.element.kind !== "variant") {
      throw new Error("checked Select.wait lost its arm array type");
    }
    if (!Array.isArray(request) || request.length === 0) {
      throw new RangeError("Select.wait requires at least one arm");
    }
    const cases = new Map(
      type.element.cases.map((case_) => [case_.name, case_.payload]),
    );
    return request.map((arm): SelectArm => {
      if (
        arm === null || typeof arm !== "object" || !("kind" in arm) ||
        arm.kind !== "variant"
      ) {
        throw new TypeError("expected a Select arm");
      }
      const payload = arm.payload;
      const payloadType = cases.get(arm.name);
      if (payload === undefined || payloadType === undefined) {
        throw new TypeError(`Select arm ${arm.name} has no checked payload`);
      }
      if (arm.name === "Channel") {
        return {
          kind: "receive",
          source: this.#channels.receiveSource(payloadType, payload),
        };
      }
      if (arm.name === "Events") {
        return {
          kind: "receive",
          source: this.#events.receiveSource(payloadType, payload),
        };
      }
      if (
        arm.name !== "After" || payload === null ||
        typeof payload !== "object" || !("kind" in payload) ||
        payload.kind !== "record" || payload.fields.size !== 2
      ) {
        throw new TypeError("expected a Select.after clock and duration");
      }
      const clock = payload.fields.get("0");
      const duration = payload.fields.get("1");
      if (
        clock === undefined || typeof duration !== "bigint" || duration < 0n ||
        duration > 2147483647n
      ) {
        throw new RangeError(
          "Select.after requires a clock and 0 through 2147483647 milliseconds",
        );
      }
      return {
        kind: "timer",
        clock: this.#io.clockService(clock),
        milliseconds: Number(duration),
      };
    });
  }
}
