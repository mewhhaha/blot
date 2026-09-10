import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";

const resourceBrand: unique symbol = Symbol("Blot resource");
const registerResource = Symbol("register resource");
const trackAcquisition = Symbol("track acquisition");
const requireResource = Symbol("require resource");
const releaseResource = Symbol("release resource");
const cleanupScope = Symbol("masked cleanup scope");

export interface HostResource {
  readonly kind: "resource";
  readonly name: string;
  readonly [resourceBrand]: true;
}

interface Lease {
  readonly handle: HostResource;
  readonly id: bigint;
  readonly owner: HostScope;
  readonly family: object;
  readonly payloadIdentity: string;
  state:
    | { readonly kind: "live"; readonly dispose: () => void | Promise<void> }
    | { readonly kind: "released" };
}

interface Registry {
  readonly families: Map<string, object>;
  readonly handles: WeakMap<object, Lease>;
  readonly tokens: Map<bigint, Lease>;
}

interface Cleanup {
  previous: Cleanup | undefined;
  next: Cleanup | undefined;
  readonly finalize: () => Promise<void>;
}

let nextResourceId = 1n;

export interface ResourceFamily<T> {
  readonly name: string;
  grant(
    scope: HostScope,
    value: T,
    dispose?: (value: T) => void | Promise<void>,
  ): HostResource;
  get(handle: unknown): T;
  release(handle: unknown): Promise<void>;
  acquire(
    scope: HostScope,
    create: (signal: AbortSignal) => Promise<T>,
    dispose: (value: T) => void | Promise<void>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HostResource>;
}

/** An explicit lifetime and authority boundary shared by hosted calls. */
export class HostScope {
  readonly #registry: Registry;
  readonly #parent: HostScope | undefined;
  readonly #children = new Set<HostScope>();
  readonly #leases = new Map<Lease, Cleanup>();
  #lastCleanup: Cleanup | undefined;
  readonly #releases = new Set<Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #closers = new Set<() => Promise<void>>();
  readonly #controller = new AbortController();
  readonly #cleanupOwner: HostScope | undefined;
  #phase: "open" | "draining" | "finalizing" | "closed" = "open";
  #guestFinalizers = true;
  #closing: Promise<void> | undefined;

  constructor(parent?: HostScope, mode?: typeof cleanupScope) {
    this.#parent = parent;
    if (mode !== undefined && mode !== cleanupScope) {
      throw new TypeError("invalid host scope mode");
    }
    if (parent === undefined) {
      this.#registry = {
        families: new Map(),
        handles: new WeakMap(),
        tokens: new Map(),
      };
    } else {
      if (mode === cleanupScope) {
        if (parent.#phase !== "finalizing") {
          throw new Error("masked cleanup requires a finalizing scope");
        }
        this.#cleanupOwner = parent;
      } else {
        parent.assertOpen();
        this.#cleanupOwner = parent.#cleanupOwner;
      }
      this.#registry = parent.#registry;
      parent.#children.add(this);
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get hasLifetimes(): boolean {
    return this.#children.size > 0 || this.#leases.size > 0 ||
      this.#pending.size > 0 || this.#closers.size > 0 ||
      this.#lastCleanup !== undefined || this.#releases.size > 0;
  }

  get isCleanup(): boolean {
    return this.#cleanupOwner !== undefined;
  }

  cancel(reason: unknown): void {
    this.#controller.abort(reason);
    for (const child of this.#children) {
      if (child.#cleanupOwner === this) continue;
      child.cancel(reason);
    }
  }

  assertOpen(): void {
    this.signal.throwIfAborted();
    if (this.#phase !== "open") throw new Error("resource scope is closing");
  }

  onExit(finalize: (scope: HostScope) => Promise<void>): void {
    this.assertOpen();
    const cleanup = this.#appendCleanup(async () => {
      this.#removeCleanup(cleanup);
      if (!this.#guestFinalizers) return;
      const masked = new HostScope(this, cleanupScope);
      let failure: { readonly cause: unknown } | undefined;
      try {
        await finalize(masked);
      } catch (cause) {
        failure = { cause };
      }
      try {
        await masked.close();
      } catch (error) {
        if (failure !== undefined) {
          throw new AggregateError(
            [failure.cause, error],
            "masked cleanup failed",
          );
        }
        throw error;
      }
      if (failure !== undefined) throw failure.cause;
    });
  }

  reclaimAfterTrap(reason: unknown): void {
    this.#guestFinalizers = false;
    for (const child of this.#children) child.reclaimAfterTrap(reason);
    this.cancel(reason);
  }

  isWithin(ancestor: HostScope): boolean {
    if (this === ancestor) return true;
    let scope = this.#parent;
    while (scope !== undefined) {
      if (scope === ancestor) return true;
      scope = scope.#parent;
    }
    return false;
  }

  resource<T>(
    name: string,
    options: { readonly payload?: BlotAbiType } = {},
  ): ResourceFamily<T> {
    this.assertOpen();
    let payload: BlotAbiType = { kind: "unit" };
    if (options.payload !== undefined) payload = options.payload;
    const payloadIdentity = resourcePayloadIdentity(payload);
    const key = JSON.stringify([name, payloadIdentity]);
    if (name.length === 0 || this.#registry.families.has(key)) {
      throw new TypeError(
        `resource family ${JSON.stringify(name)} is empty or already defined`,
      );
    }
    const family = new RegisteredResourceFamily<T>(
      this,
      name,
      key,
      payloadIdentity,
    );
    this.#registry.families.set(key, family);
    return family;
  }

  own(close: () => Promise<void>): () => void {
    this.assertOpen();
    this.#closers.add(close);
    return () => {
      this.#closers.delete(close);
    };
  }

  [registerResource]<T>(
    family: RegisteredResourceFamily<T>,
    value: T,
    dispose: (value: T) => void | Promise<void>,
  ): HostResource {
    this.assertOpen();
    if (this.#registry.families.get(family.key) !== family) {
      throw new TypeError(
        `resource family ${family.name} belongs to another runtime`,
      );
    }
    if (nextResourceId > 9223372036854775807n) {
      throw new RangeError("resource identity space exhausted");
    }
    const handle: HostResource = Object.freeze(
      { kind: "resource", name: family.name, [resourceBrand]: true } as const,
    );
    const lease: Lease = {
      handle,
      id: nextResourceId++,
      owner: this,
      family,
      payloadIdentity: family.payloadIdentity,
      state: {
        kind: "live",
        dispose: async () => {
          await dispose(value);
        },
      },
    };
    this.#registry.handles.set(handle, lease);
    this.#registry.tokens.set(lease.id, lease);
    this.#leases.set(
      lease,
      this.#appendCleanup(() => this[releaseResource](lease)),
    );
    return handle;
  }

  [releaseResource](lease: Lease): Promise<void> {
    const cleanup = this.#leases.get(lease);
    if (lease.state.kind !== "live" || cleanup === undefined) {
      throw new Error("resource lease is absent from its owning scope");
    }
    const dispose = lease.state.dispose;
    lease.state = { kind: "released" };
    this.#registry.handles.delete(lease.handle);
    this.#registry.tokens.delete(lease.id);
    this.#leases.delete(lease);
    this.#removeCleanup(cleanup);
    // Publish disposal before invoking host code that may reenter close/release.
    const completion = Promise.withResolvers<void>();
    const pending = completion.promise.finally(() => {
      if (this.#phase === "open") this.#releases.delete(pending);
    });
    this.#releases.add(pending);
    try {
      completion.resolve(dispose());
    } catch (error) {
      completion.reject(error);
    }
    return pending;
  }

  [trackAcquisition]<T>(promise: Promise<T>): Promise<T> {
    this.assertOpen();
    this.#pending.add(promise);
    return promise.finally(() => {
      this.#pending.delete(promise);
    });
  }

  lower(
    name: string,
    handle: HostResource,
    payload: BlotAbiType = { kind: "unit" },
  ): bigint {
    this.assertOpen();
    const lease = this.#registry.handles.get(handle);
    if (lease === undefined || handle.name !== name) {
      throw new TypeError(`expected a ${name} resource from this runtime`);
    }
    if (lease.payloadIdentity !== resourcePayloadIdentity(payload)) {
      throw new TypeError(`resource ${name} has a different type argument`);
    }
    this.#checkLease(lease);
    return lease.id;
  }

  lift(
    name: string,
    id: bigint,
    payload: BlotAbiType = { kind: "unit" },
  ): HostResource {
    this.assertOpen();
    const lease = this.#registry.tokens.get(id);
    if (lease === undefined || lease.handle.name !== name) {
      throw new TypeError(`unknown or revoked ${name} resource`);
    }
    if (lease.payloadIdentity !== resourcePayloadIdentity(payload)) {
      throw new TypeError(`resource ${name} has a different type argument`);
    }
    this.#checkLease(lease);
    return lease.handle;
  }

  [requireResource](handle: unknown, family: object): Lease {
    if (typeof handle !== "object" || handle === null) {
      throw new TypeError("expected an opaque host resource");
    }
    const lease = this.#registry.handles.get(handle);
    if (
      lease === undefined ||
      lease.family !== family ||
      lease.state.kind === "released"
    ) {
      throw new TypeError(
        "resource has the wrong family, belongs to another runtime, or is revoked",
      );
    }
    return lease;
  }

  close(
    reason: unknown = new DOMException("resource scope closed", "AbortError"),
  ): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    let cancellation = reason;
    if (this.signal.aborted) cancellation = this.signal.reason;
    this.#phase = "draining";
    // Publish the closing promise before invoking callbacks that can reenter.
    this.#closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const capture = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          if (error !== cancellation) failures.push(error);
        }
      };
      const drainReleases = async () => {
        while (this.#releases.size > 0) {
          await Promise.all([...this.#releases].map(async (pending) => {
            try {
              await pending;
            } catch (error) {
              failures.push(error);
            } finally {
              this.#releases.delete(pending);
            }
          }));
        }
      };
      await Promise.all([...this.#closers].map((close) => capture(close)));
      await Promise.all(
        [...this.#children].map((child) =>
          capture(() => child.close(cancellation))
        ),
      );
      await Promise.all(
        [...this.#pending].map((pending) => capture(() => pending)),
      );
      await drainReleases();
      this.#phase = "finalizing";
      while (this.#lastCleanup !== undefined) {
        const finalizing = this.#lastCleanup.finalize();
        try {
          await finalizing;
        } catch (error) {
          failures.push(error);
        } finally {
          this.#releases.delete(finalizing);
        }
        await drainReleases();
      }
      this.#closers.clear();
      this.#phase = "closed";
      if (this.#parent !== undefined) this.#parent.#children.delete(this);
      if (failures.length > 0) {
        throw new AggregateError(failures, "resource scope cleanup failed");
      }
    });
    this.cancel(cancellation);
    return this.#closing;
  }

  #appendCleanup(finalize: () => Promise<void>): Cleanup {
    const cleanup = { previous: this.#lastCleanup, next: undefined, finalize };
    if (this.#lastCleanup !== undefined) this.#lastCleanup.next = cleanup;
    this.#lastCleanup = cleanup;
    return cleanup;
  }

  #removeCleanup(cleanup: Cleanup): void {
    if (cleanup.previous !== undefined) cleanup.previous.next = cleanup.next;
    if (cleanup.next === undefined) this.#lastCleanup = cleanup.previous;
    else cleanup.next.previous = cleanup.previous;
    cleanup.previous = undefined;
    cleanup.next = undefined;
  }

  #checkLease(lease: Lease): void {
    const cleanupCanRead = this.#cleanupOwner !== undefined &&
      this.#cleanupOwner.isWithin(lease.owner) &&
      lease.owner.#phase !== "closed";
    if (
      lease.state.kind === "released" ||
      (lease.owner.signal.aborted && !cleanupCanRead)
    ) {
      throw new TypeError("resource scope has ended");
    }
    if (this.isWithin(lease.owner)) return;
    throw new TypeError("resource cannot escape its owning scope");
  }
}

class RegisteredResourceFamily<T> implements ResourceFamily<T> {
  readonly #values = new WeakMap<HostResource, { readonly value: T }>();

  constructor(
    readonly root: HostScope,
    readonly name: string,
    readonly key: string,
    readonly payloadIdentity: string,
  ) {}

  grant(
    scope: HostScope,
    value: T,
    dispose: (value: T) => void | Promise<void> = () => {},
  ): HostResource {
    const handle = scope[registerResource](this, value, async (owned) => {
      this.#values.delete(handle);
      await dispose(owned);
    });
    this.#values.set(handle, { value });
    return handle;
  }

  get(handle: unknown): T {
    const lease = this.root[requireResource](handle, this);
    const stored = this.#values.get(lease.handle);
    if (stored === undefined) {
      throw new Error("registered resource lost its host value");
    }
    return stored.value;
  }

  async release(handle: unknown): Promise<void> {
    const lease = this.root[requireResource](handle, this);
    await lease.owner[releaseResource](lease);
  }

  acquire(
    scope: HostScope,
    create: (signal: AbortSignal) => Promise<T>,
    dispose: (value: T) => void | Promise<void>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<HostResource> {
    scope.assertOpen();
    const controller = new AbortController();
    const cancelScope = () => controller.abort(scope.signal.reason);
    const cancelCaller = () => controller.abort(options.signal?.reason);
    scope.signal.addEventListener("abort", cancelScope, { once: true });
    options.signal?.addEventListener("abort", cancelCaller, { once: true });
    if (options.signal?.aborted) cancelCaller();
    const promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const value = await create(controller.signal);
      if (controller.signal.aborted) {
        try {
          await dispose(value);
        } catch (error) {
          throw new AggregateError(
            [controller.signal.reason, error],
            "cancelled acquisition cleanup failed",
          );
        }
        controller.signal.throwIfAborted();
      }
      try {
        return this.grant(scope, value, dispose);
      } catch (error) {
        try {
          await dispose(value);
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "resource registration cleanup failed",
          );
        }
        throw error;
      }
    }).finally(() => {
      scope.signal.removeEventListener("abort", cancelScope);
      options.signal?.removeEventListener("abort", cancelCaller);
    });
    return scope[trackAcquisition](promise);
  }
}

function resourcePayloadIdentity(type: BlotAbiType): string {
  switch (type.kind) {
    case "callback":
      throw new TypeError(
        "resource type arguments cannot contain artifact-specific callbacks",
      );
    case "resource":
      return JSON.stringify([
        type.kind,
        type.name,
        resourcePayloadIdentity(type.payload),
      ]);
    case "sealed":
      return JSON.stringify([
        type.kind,
        type.name,
        resourcePayloadIdentity(type.inner),
      ]);
    case "array":
      return JSON.stringify([type.kind, resourcePayloadIdentity(type.element)]);
    case "record":
      return JSON.stringify([
        type.kind,
        type.fields.map((
          field,
        ) => [field.name, resourcePayloadIdentity(field.type)]).sort((
          [left],
          [right],
        ) => left.localeCompare(right)),
      ]);
    case "variant":
      return JSON.stringify([
        type.kind,
        type.cases.map((case_) => {
          let payload = "unit";
          if (case_.payload !== undefined) {
            payload = resourcePayloadIdentity(case_.payload);
          }
          return [case_.name, payload];
        }).sort(([left], [right]) => left.localeCompare(right)),
      ]);
    default:
      return type.kind;
  }
}
