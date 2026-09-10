import type { RuntimeValue } from "./abi_values.ts";
import {
  abiLayoutIdentity,
  type BlotAbiType,
} from "./compiler/backend/runtime/abi.ts";
import type { HostScope } from "./resources.ts";
import type { SharedLoan } from "./shared_memory.ts";

const callbackBrand: unique symbol = Symbol("Blot compiled callback");

export type CallbackType = Extract<BlotAbiType, { kind: "callback" }>;
export type HostCallbackFactory = (
  type: CallbackType,
  environment: RuntimeValue,
) => HostCallback;

export interface CompiledCallback {
  readonly module: WebAssembly.Module;
  readonly manifestBytes: Uint8Array;
  readonly entry: string;
  readonly environmentType: BlotAbiType;
  readonly captures: readonly RuntimeValue[];
  readonly development?: CompiledDevelopmentProgram;
}

export interface CompiledDevelopmentProgram {
  readonly entryUnit: string;
  readonly units: readonly {
    readonly name: string;
    readonly root: string;
    readonly module: WebAssembly.Module;
    readonly manifestBytes: Uint8Array;
  }[];
}

export interface CallbackExecutor {
  execute(
    callback: CompiledCallback,
    argument: RuntimeValue,
    signal: AbortSignal,
    options: {
      readonly priority: "required" | "speculative";
      readonly shared?: SharedLoan;
    },
  ): Promise<RuntimeValue>;
  promote(callback: CompiledCallback): void;
}

/** A checked, precompiled, one-shot guest closure. */
export interface HostCallback {
  readonly kind: "callback";
  readonly [callbackBrand]: true;
  call(
    argument?: RuntimeValue,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RuntimeValue>;
}

interface CallbackState {
  owner: HostScope;
  detach: () => void;
  phase: "ready" | "registered" | "running" | "released";
  validateScope: (scope: HostScope) => void;
  readonly release: () => Promise<void>;
  compiled: CompiledCallback | undefined;
  type: CallbackType | undefined;
  executor: CallbackExecutor | undefined;
  priority: "required" | "speculative";
  shared: SharedLoan | undefined;
}

const callbacks = new WeakMap<HostCallback, CallbackState>();

export function createHostCallback(
  owner: HostScope,
  validateScope: (scope: HostScope) => void,
  invoke: (
    scope: HostScope,
    argument: RuntimeValue,
    signal?: AbortSignal,
  ) => Promise<RuntimeValue>,
  compiled?: CompiledCallback,
  options: {
    readonly dispose?: () => Promise<void>;
    readonly type?: CallbackType;
  } = {},
): HostCallback {
  let invokeCallback: typeof invoke | undefined = invoke;
  let disposeCallback = options.dispose;
  let pending: Promise<RuntimeValue> | undefined;
  const finalize = async () => {
    state.phase = "released";
    state.detach();
    state.detach = () => {};
    invokeCallback = undefined;
    state.compiled = undefined;
    state.type = undefined;
    state.validateScope = () => {
      throw new Error("compiled callback has been released");
    };
    state.executor = undefined;
    state.shared = undefined;
    const disposal = disposeCallback;
    disposeCallback = undefined;
    if (disposal !== undefined) await disposal();
  };
  const release = async () => {
    state.phase = "released";
    if (pending !== undefined) await pending.then(() => {}, () => {});
    await finalize();
  };
  const state: CallbackState = {
    owner,
    detach: owner.own(release),
    phase: "ready",
    validateScope,
    release,
    compiled,
    type: options.type,
    executor: undefined,
    priority: "required",
    shared: undefined,
  };
  const callback: HostCallback = Object.freeze(
    {
      kind: "callback",
      [callbackBrand]: true,
      call(
        argument: RuntimeValue = null,
        options: { readonly signal?: AbortSignal } = {},
      ) {
        if (state.phase !== "ready") {
          return Promise.reject(
            new Error(
              "compiled callback has already been consumed or released",
            ),
          );
        }
        state.owner.assertOpen();
        state.phase = "running";
        pending = Promise.resolve().then(() => {
          if (state.executor === undefined) {
            if (invokeCallback === undefined) {
              throw new Error("compiled callback lost its invocation");
            }
            return invokeCallback(state.owner, argument, options.signal);
          }
          if (state.compiled === undefined) {
            throw new Error("worker callback lost its compiled entry");
          }
          let signal = state.owner.signal;
          if (options.signal !== undefined) {
            signal = AbortSignal.any([signal, options.signal]);
          }
          return state.executor.execute(state.compiled, argument, signal, {
            priority: state.priority,
            shared: state.shared,
          });
        }).then(async (result) => {
          await finalize();
          return result;
        }, async (cause) => {
          try {
            await finalize();
          } catch (cleanup) {
            throw new AggregateError(
              [cause, cleanup],
              "callback execution and snapshot disposal failed",
            );
          }
          throw cause;
        }).finally(() => {
          pending = undefined;
        });
        return pending;
      },
    } as const,
  );
  callbacks.set(callback, state);
  return callback;
}

export function moveHostCallback(
  callback: HostCallback,
  destination: HostScope,
): void {
  const state = callbacks.get(callback);
  if (state === undefined || state.phase !== "ready") {
    throw new TypeError("expected an unconsumed compiled callback");
  }
  state.owner.assertOpen();
  destination.assertOpen();
  state.validateScope(destination);
  const detach = destination.own(state.release);
  state.detach();
  state.owner = destination;
  state.detach = detach;
}

export function isHostCallback(value: unknown): value is HostCallback {
  return typeof value === "object" && value !== null &&
    callbacks.has(value as HostCallback);
}

export function assignCallbackExecutor(
  callback: HostCallback,
  executor: CallbackExecutor,
  options: {
    readonly priority: "required" | "speculative";
    readonly shared?: SharedLoan;
  } = {
    priority: "required",
  },
): void {
  const state = callbacks.get(callback);
  if (
    state === undefined || state.phase !== "ready" ||
    state.compiled === undefined
  ) {
    throw new TypeError("expected an unconsumed compiled worker callback");
  }
  state.owner.assertOpen();
  state.executor = executor;
  state.priority = options.priority;
  state.shared = options.shared;
}

export function demandHostCallback(callback: HostCallback): void {
  const state = callbacks.get(callback);
  if (state === undefined) throw new TypeError("expected a compiled callback");
  state.priority = "required";
  if (state.executor !== undefined && state.compiled !== undefined) {
    state.executor.promote(state.compiled);
  }
}

export function registerHostFinalizer(
  callback: HostCallback,
  destination: HostScope,
): void {
  const state = callbacks.get(callback);
  if (state === undefined || state.phase !== "ready") {
    throw new TypeError("expected an unconsumed cleanup callback");
  }
  state.owner.assertOpen();
  destination.assertOpen();
  state.validateScope(destination);
  destination.onExit(async (masked) => {
    state.owner = masked;
    state.phase = "ready";
    await callback.call();
  });
  state.detach();
  state.detach = () => {};
  state.owner = destination;
  state.phase = "registered";
}

/** Consume a compiler-checked development link argument and transfer its captures. */
export function takeDevelopmentCallback(
  callback: HostCallback,
  type: CallbackType,
  destination: HostScope,
): {
  readonly environment: RuntimeValue;
  readonly release: () => Promise<void>;
} {
  const state = callbacks.get(callback);
  if (
    state === undefined || state.phase !== "ready" ||
    state.compiled === undefined || state.type === undefined
  ) {
    throw new TypeError(
      "development link requires an unconsumed compiled callback",
    );
  }
  state.owner.assertOpen();
  destination.assertOpen();
  state.validateScope(destination);
  if (
    abiLayoutIdentity(state.type) !== abiLayoutIdentity(type) ||
    state.compiled.environmentType.kind !== "record"
  ) {
    throw new TypeError(
      "development callback disagrees with its checked link layout",
    );
  }
  const compiled = state.compiled;
  const environment: RuntimeValue = {
    kind: "record",
    fields: new Map(
      state.compiled.environmentType.fields.map((
        field,
        index,
      ) => [field.name, compiled.captures[index]]),
    ),
  };
  state.phase = "released";
  state.detach();
  return { environment, release: state.release };
}
