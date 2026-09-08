import { decodeManifest, type RuntimeValue } from "./abi_values.ts";
import type { CompilerArtifact } from "./compiler.ts";
import type { HostCapabilities, HostOperation } from "./host.ts";
import {
  type HostResource,
  HostScope,
  type ResourceFamily,
} from "./resources.ts";

interface ClockService {
  readonly now: () => bigint;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface HttpService {
  readonly get: (path: string, signal: AbortSignal) => Promise<Response>;
}

/** The host grants each service independently; source code passes its lease. */
export class IoRuntime {
  readonly #clocks: ResourceFamily<ClockService>;
  readonly #http: ResourceFamily<HttpService>;
  readonly #operations: HostCapabilities;

  constructor(root: HostScope) {
    this.#clocks = root.resource("Io.Clock");
    this.#http = root.resource("Io.Http");
    this.#operations = new Map<string, ReadonlyMap<string, HostOperation>>([
      [
        "Clock",
        new Map<string, HostOperation>([
          ["now", (_context, clock) => this.#clocks.get(clock).now()],
          ["sleep", async ({ signal }, request) => {
            const [clock, duration] = serviceTuple(request);
            if (
              typeof duration !== "bigint" || duration < 0n ||
              duration > 2147483647n
            ) {
              throw new RangeError(
                "clock sleep must be 0 through 2147483647 milliseconds",
              );
            }
            await this.#clocks.get(clock).sleep(Number(duration), signal);
            return null;
          }],
        ]),
      ],
      [
        "Http",
        new Map<string, HostOperation>([
          ["get", async ({ signal }, request) => {
            const [http, path] = serviceTuple(request);
            if (typeof path !== "string") {
              throw new TypeError("HTTP path must be text");
            }
            const service = this.#http.get(http);
            signal.throwIfAborted();
            try {
              const response = await service.get(path, signal);
              const body = await response.text();
              signal.throwIfAborted();
              return {
                kind: "variant",
                name: "Ok",
                payload: {
                  kind: "record",
                  fields: new Map<string, RuntimeValue>([
                    ["status", BigInt(response.status)],
                    ["body", body],
                  ]),
                },
              };
            } catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof TypeError)) throw error;
              return { kind: "variant", name: "Error", payload: error.message };
            }
          }],
        ]),
      ],
    ]);
  }

  clock(scope: HostScope, service: ClockService = {
    now: () => BigInt(Math.floor(performance.now())),
    sleep: (milliseconds, signal) => {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  }): HostResource {
    return this.#clocks.grant(scope, service);
  }

  http(scope: HostScope, options: { readonly baseURL: URL }): HostResource {
    const baseURL = new URL(options.baseURL);
    if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") {
      throw new TypeError("HTTP capability requires an HTTP or HTTPS base URL");
    }
    return this.#http.grant(scope, {
      get(path, signal) {
        const url = new URL(path, baseURL);
        if (url.origin !== baseURL.origin) {
          throw new TypeError("HTTP URL is outside the granted origin");
        }
        return fetch(url, { signal, redirect: "error" });
      },
    });
  }

  capabilitiesFor(
    artifact: Pick<CompilerArtifact, "manifestBytes">,
  ): HostCapabilities {
    const requested = new Map<string, Map<string, HostOperation>>();
    for (const imported of decodeManifest(artifact.manifestBytes).imports) {
      const service = this.#operations.get(imported.capability);
      if (service === undefined) continue;
      const operation = service.get(imported.sourceName);
      if (operation === undefined) {
        throw new TypeError(
          `unsupported ${imported.capability} operation ${imported.sourceName}`,
        );
      }
      let operations = requested.get(imported.capability);
      if (operations === undefined) {
        operations = new Map();
        requested.set(imported.capability, operations);
      }
      operations.set(imported.sourceName, operation);
    }
    return requested;
  }
}

function serviceTuple(
  value: RuntimeValue,
): readonly [RuntimeValue, RuntimeValue] {
  if (
    value === null || typeof value !== "object" || !("kind" in value) ||
    value.kind !== "record" || value.fields.size !== 2
  ) {
    throw new TypeError("expected a two-field service request");
  }
  const first = value.fields.get("0");
  const second = value.fields.get("1");
  if (first === undefined || second === undefined) {
    throw new TypeError("service request omitted a tuple field");
  }
  return [first, second];
}
