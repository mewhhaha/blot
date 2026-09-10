import {
  type CallbackType,
  type CompiledDevelopmentProgram,
  createHostCallback,
  type HostCallbackFactory,
  isHostCallback,
  takeDevelopmentCallback,
} from "./callbacks.ts";
import { AbiCodec } from "./abi_codec.ts";
import {
  decodeManifest,
  type GuestScopeToken,
  readDirect,
  readMemory,
  requiredFunction,
  requiredMemory,
  requireGuestScopeToken,
  type RuntimeValue,
} from "./abi_values.ts";
import {
  type BlotAbiFunction,
  type BlotAbiManifest,
  type BlotAbiType,
  flattenedAbiType,
} from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";
import { HostScope } from "./resources.ts";
import type { BlotEffectOwnership } from "./runtime/hir.ts";

export type HostScalar = null | boolean | bigint | number;
export type HostResult = RuntimeValue;
export interface ExecutionContext {
  readonly signal: AbortSignal;
  readonly scope: HostScope;
  readonly authority: HostScope;
  readonly development?: CompiledDevelopmentProgram;
}
export interface HostCallContext extends ExecutionContext {
  readonly operation: BlotAbiManifest["imports"][number];
}
export type HostOperation = (
  context: HostCallContext,
  ...arguments_: readonly RuntimeValue[]
) => RuntimeValue | PromiseLike<RuntimeValue>;
export type HostCapabilities = ReadonlyMap<
  string,
  ReadonlyMap<string, HostOperation>
>;

export interface HostedModule {
  readonly instance: WebAssembly.Instance;
  call(name: string, arguments_?: readonly RuntimeValue[]): HostResult;
  callAsync(
    name: string,
    arguments_?: readonly RuntimeValue[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<HostResult>;
  invokeLinked(
    name: string,
    arguments_: readonly (number | bigint)[],
    context: ExecutionContext,
  ): unknown;
  callLinked(
    name: string,
    arguments_: readonly RuntimeValue[],
    context: ExecutionContext,
  ): Promise<HostResult>;
  callCallback(
    entry: string,
    arguments_: readonly RuntimeValue[],
    options?: { readonly signal?: AbortSignal; readonly scope?: HostScope },
  ): Promise<HostResult>;
  close(): Promise<void>;
  destroy(): void;
}

/** Instantiate ABI 4 with explicit allocation scopes and portable Wasm suspension. */
export async function instantiateArtifact(
  artifact: Pick<CompilerArtifact, "wasm" | "manifestBytes"> | {
    readonly module: WebAssembly.Module;
    readonly manifestBytes: Uint8Array;
  },
  capabilities: HostCapabilities = new Map(),
  options: {
    readonly scope?: HostScope;
    readonly links?: WebAssembly.Imports;
    readonly development?: (previous?: CompiledDevelopmentProgram) => {
      readonly program: CompiledDevelopmentProgram;
      readonly release: () => Promise<void>;
    };
    readonly invokeLink?: (
      link: NonNullable<BlotAbiManifest["links"]>[number],
      arguments_: readonly (number | bigint)[],
      context: ExecutionContext,
    ) => number | bigint | undefined;
    readonly callLink?: (
      link: NonNullable<BlotAbiManifest["links"]>[number],
      arguments_: readonly RuntimeValue[],
      context: ExecutionContext,
    ) => Promise<RuntimeValue>;
  } = {},
): Promise<HostedModule> {
  const hostLifetime = options.scope;
  const invokeDevelopmentLink = options.callLink;
  const bytes = Uint8Array.from(artifact.manifestBytes);
  const manifest = decodeManifest(bytes);
  if (
    manifest.links !== undefined && manifest.links.length > 0 &&
    options.links === undefined
  ) {
    throw new TypeError("host requires a closed artifact, not a split unit");
  }
  const supplied = new Map(
    [...capabilities].map(([name, operations]) => [name, new Map(operations)]),
  );
  const imports: WebAssembly.Imports = Object.create(null);
  const requested = new Map<string, Set<string>>();
  const externalNames = new Set<string>();
  const operations: HostOperation[] = [];
  let activeContext: ExecutionContext | undefined;
  for (const imported of manifest.imports) {
    if (
      hasLinear(imported.contract.input) ||
      hasLinear(imported.contract.result)
    ) {
      throw new TypeError(
        "linear host transfers require registered scope cleanup",
      );
    }
    requireParameters(imported.function.parameters);
    const operation = supplied.get(imported.capability)?.get(
      imported.sourceName,
    );
    if (typeof operation !== "function") {
      throw new TypeError(
        `missing host operation ${imported.capability}.${imported.sourceName}`,
      );
    }
    operations.push(operation);
    let names = requested.get(imported.capability);
    if (names === undefined) {
      names = new Set();
      requested.set(imported.capability, names);
    }
    names.add(imported.sourceName);
    const externalName = JSON.stringify([imported.module, imported.name]);
    if (externalNames.has(externalName)) {
      throw new TypeError("duplicate Wasm import");
    }
    externalNames.add(externalName);
    let namespace = imports[imported.module];
    if (namespace === undefined) {
      namespace = Object.create(null) as WebAssembly.ModuleImports;
      imports[imported.module] = namespace;
    }
    namespace[imported.name] = (...raw: readonly (number | bigint)[]) => {
      if (imported.contract.suspends) {
        throw new Error("suspending operation reached a direct Wasm import");
      }
      if (activeContext === undefined) {
        throw new Error("host operation has no active execution context");
      }
      const allocationScope = requireGuestScopeToken(raw[0]);
      const marshaller = new AbiCodec(
        memory,
        (size, alignment) =>
          Number(realloc(allocationScope, 0, 0, alignment, size)) >>> 0,
        activeContext.scope,
        callbackFactory(
          activeContext.scope,
          activeContext.authority,
          activeContext.development,
        ),
      );
      let position = 1;
      const arguments_ = imported.function.parameters.map((type) => {
        const width = flattenedAbiType(type).length;
        const value = marshaller.lift(
          type,
          raw.slice(position, position + width),
        );
        position += width;
        return value;
      });
      const indirect = flattenedAbiType(imported.function.result).length > 1;
      let expected = position;
      if (indirect) expected += 1;
      if (expected !== raw.length) {
        throw new TypeError("host import arity mismatch");
      }
      const result = operation(
        { ...activeContext, operation: imported },
        ...arguments_,
      );
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError(
          "expected synchronous host value; declare the operation with Effect.suspends",
        );
      }
      const lowered = marshaller.lower(imported.function.result, result);
      if (indirect) {
        marshaller.writeFlat(
          imported.function.result,
          lowered,
          Number(raw[position]) >>> 0,
        );
        return undefined;
      }
      return lowered[0];
    };
  }
  for (const [capability, provided] of supplied) {
    const names = requested.get(capability);
    if (names === undefined) {
      throw new TypeError(`unused host capability ${capability}`);
    }
    for (const name of provided.keys()) {
      if (!names.has(name)) {
        throw new TypeError(`unused host operation ${capability}.${name}`);
      }
    }
  }
  const exports = new Map<string, BlotAbiManifest["exports"][number]>();
  for (const exported of manifest.exports) {
    if (exported.phase !== "runtime") continue;
    if (exported.name === null || exported.function === null) {
      throw new TypeError("runtime export has no function interface");
    }
    if (exports.has(exported.sourceName)) {
      throw new TypeError("duplicate export name");
    }
    requireParameters(exported.function.parameters);
    if (exported.execution !== "direct" && exported.execution !== "resumable") {
      throw new TypeError("invalid export execution contract");
    }
    if (
      flattenedAbiType(exported.function.result).length > 1 &&
      exported.postReturn === null
    ) throw new TypeError("indirect result has no post-return operation");
    exports.set(exported.sourceName, exported);
  }
  let module: WebAssembly.Module;
  if ("module" in artifact) module = artifact.module;
  else module = await WebAssembly.compile(Uint8Array.from(artifact.wasm));
  const sections = WebAssembly.Module.customSections(module, "blot:abi");
  if (sections.length !== 1 || !sameBytes(bytes, new Uint8Array(sections[0]))) {
    throw new TypeError("embedded and sidecar ABI manifests disagree");
  }
  if (manifest.links !== undefined) {
    for (const link of manifest.links) {
      const name = `blot:dev:${link.name}`;
      const callable = options.links?.[link.module]?.[name];
      if (typeof callable !== "function") {
        throw new TypeError(
          `missing canonical development link ${link.unit}.${link.name}`,
        );
      }
      const key = JSON.stringify([link.module, name]);
      if (externalNames.has(key)) throw new TypeError("duplicate Wasm import");
      externalNames.add(key);
      let namespace = imports[link.module];
      if (namespace === undefined) {
        namespace = Object.create(null) as WebAssembly.ModuleImports;
        imports[link.module] = namespace;
      }
      namespace[name] = (...arguments_: (number | bigint)[]) => {
        if (options.invokeLink === undefined) return callable(...arguments_);
        if (activeContext === undefined) {
          throw new Error("development link has no guest execution context");
        }
        return options.invokeLink(link, arguments_, activeContext);
      };
    }
  }
  const actualImports = WebAssembly.Module.imports(module);
  if (actualImports.length !== externalNames.size) {
    throw new TypeError("Wasm import set disagrees with manifest");
  }
  for (const imported of actualImports) {
    if (
      imported.kind !== "function" ||
      !externalNames.has(JSON.stringify([imported.module, imported.name]))
    ) {
      throw new TypeError("Wasm import set disagrees with manifest");
    }
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const memory = requiredMemory(instance, manifest);
  const realloc = requiredFunction(instance, manifest.abi.reallocExport);
  const moduleScope = new HostScope(options.scope);
  let destroyed = false;
  let trapped = false;
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  let calling = false;
  const running = new Map<AbortController, Promise<HostResult>>();
  const cleanupCalls = new Set<AbortController>();

  const invoke = (
    context: ExecutionContext,
    name: string,
    ...arguments_: readonly (number | bigint)[]
  ) => {
    if (calling) throw new Error("reentrant guest calls are not supported");
    calling = true;
    activeContext = context;
    try {
      return requiredFunction(instance, name)(...arguments_);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        trapped = true;
        moduleScope.reclaimAfterTrap(error);
      }
      throw error;
    } finally {
      activeContext = undefined;
      calling = false;
    }
  };
  const resolve = (name: string, arguments_: readonly RuntimeValue[]) => {
    if (destroyed || trapped || closing) {
      throw new Error("hosted module is destroyed or closing");
    }
    moduleScope.assertOpen();
    if (calling) throw new Error("reentrant guest calls are not supported");
    const exported = exports.get(name);
    if (
      exported === undefined || exported.function === null ||
      exported.name === null
    ) throw new TypeError(`unknown runtime export ${name}`);
    if (arguments_.length !== exported.function.parameters.length) {
      throw new TypeError(
        `export ${name} requires ${exported.function.parameters.length} arguments`,
      );
    }
    return { ...exported, name: exported.name, function: exported.function };
  };

  const start = (
    exported: BlotAbiManifest["callbacks"][number],
    arguments_: readonly RuntimeValue[],
    parent: HostScope,
    resultScope: HostScope,
    options: {
      readonly signal?: AbortSignal;
      readonly authority?: HostScope;
      readonly development?: CompiledDevelopmentProgram;
      readonly linked?: true;
    } = {},
  ): Promise<HostResult> => {
    if (destroyed || trapped || (closing && !parent.isCleanup)) {
      throw new Error("hosted module is destroyed or closing");
    }
    parent.assertOpen();
    const controller = new AbortController();
    if (parent.isCleanup) cleanupCalls.add(controller);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const execute = async (): Promise<HostResult> => {
      const signal = controller.signal;
      signal.throwIfAborted();
      const scope = new HostScope(parent);
      const cancelScope = () => scope.cancel(signal.reason);
      const cancelCall = () => controller.abort(scope.signal.reason);
      signal.addEventListener("abort", cancelScope, { once: true });
      scope.signal.addEventListener("abort", cancelCall, { once: true });
      let authority = moduleScope;
      if (options.authority !== undefined) authority = options.authority;
      const execution = {
        signal,
        scope,
        authority,
        development: options.development,
      };
      const transfers: (() => Promise<void>)[] = [];
      const transferCallback = (
        type: CallbackType,
        value: RuntimeValue,
      ): RuntimeValue => {
        if (!isHostCallback(value)) {
          throw new TypeError("development link requires a compiled callback");
        }
        const transfer = takeDevelopmentCallback(value, type, scope);
        transfers.push(transfer.release);
        return transfer.environment;
      };
      let outcome: { readonly value: HostResult } | { readonly cause: unknown };
      let allocationScope: GuestScopeToken | undefined;
      let frame: number | undefined;
      let completed = false;
      try {
        const token = requireGuestScopeToken(invoke(execution, "cabi_enter"));
        allocationScope = token;
        const marshaller = new AbiCodec(
          memory,
          (size, alignment) =>
            Number(realloc(token, 0, 0, alignment, size)) >>> 0,
          scope,
          callbackFactory(scope, authority, execution.development),
        );
        const linkMarshaller = new AbiCodec(
          memory,
          marshaller.allocate,
          scope,
          marshaller.callbacks,
          transferCallback,
        );
        let argumentMarshaller = marshaller;
        if (options.linked) argumentMarshaller = linkMarshaller;
        const lowered = arguments_.flatMap((value, index) =>
          argumentMarshaller.lower(exported.function.parameters[index], value)
        );
        frame = Number(invoke(execution, exported.name, token, ...lowered)) >>>
          0;
        for (;;) {
          signal.throwIfAborted();
          const status = invoke(execution, "blot:poll", token, frame, 1024);
          if (status === 4) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            continue;
          }
          const view = new DataView(memory.buffer);
          if (status === 2) {
            const result = readMemory(
              exported.function.result,
              view,
              view.getUint32(frame + 20, true),
              undefined,
              resultScope,
              callbackFactory(resultScope, authority, execution.development),
            );
            completed = true;
            outcome = { value: result };
            break;
          }
          if (status !== 1) {
            throw new Error(`invalid Wasm suspension status ${status}`);
          }
          const ordinal = view.getUint32(frame + 8, true);
          const imported = manifest.imports[ordinal];
          let signature: BlotAbiFunction;
          let perform: (
            inputs: readonly RuntimeValue[],
          ) => RuntimeValue | PromiseLike<RuntimeValue>;
          if (imported !== undefined) {
            if (!imported.contract.suspends) {
              throw new Error("Wasm requested a nonsuspending operation");
            }
            signature = imported.function;
            perform = (inputs) =>
              operations[ordinal](
                { ...execution, operation: imported },
                ...inputs,
              );
          } else {
            const link = manifest.links?.[ordinal - manifest.imports.length];
            const callLink = invokeDevelopmentLink;
            if (
              link === undefined || !link.suspends || callLink === undefined
            ) {
              throw new Error(
                "Wasm requested an undeclared suspending development link",
              );
            }
            signature = link.function;
            perform = (inputs) => callLink(link, inputs, execution);
          }
          let offset = view.getUint32(frame + 12, true);
          const inputs = signature.parameters.map((type) => {
            const layout = marshaller.layouts.get(type);
            offset = Math.ceil(offset / layout.alignment) * layout.alignment;
            const value = readMemory(
              type,
              view,
              offset,
              marshaller.layouts,
              scope,
              marshaller.callbacks,
            );
            offset += layout.size;
            return value;
          });
          const result = await perform(inputs);
          signal.throwIfAborted();
          const destination = new DataView(memory.buffer).getUint32(
            frame + 16,
            true,
          );
          let resultMarshaller = marshaller;
          if (imported === undefined) resultMarshaller = linkMarshaller;
          resultMarshaller.write(signature.result, result, destination);
          invoke(execution, "blot:resume", token, frame);
        }
      } catch (error) {
        outcome = { cause: error };
      }
      const cleanup: unknown[] = [];
      for (const release of transfers) {
        try {
          await release();
        } catch (error) {
          cleanup.push(error);
        }
      }
      try {
        if (allocationScope !== undefined && frame !== undefined) {
          if (!completed) {
            invoke(execution, "blot:cancel", allocationScope, frame);
          }
          invoke(execution, "blot:release", allocationScope, frame);
        }
      } catch (error) {
        cleanup.push(error);
      }
      try {
        if (allocationScope !== undefined) {
          invoke(execution, "cabi_leave", allocationScope);
        }
      } catch (error) {
        cleanup.push(error);
      }
      signal.removeEventListener("abort", cancelScope);
      scope.signal.removeEventListener("abort", cancelCall);
      try {
        await scope.close();
      } catch (error) {
        cleanup.push(error);
      }
      if (cleanup.length > 0) {
        if ("cause" in outcome) cleanup.unshift(outcome.cause);
        throw new AggregateError(cleanup, "guest call cleanup failed");
      }
      if ("cause" in outcome) throw outcome.cause;
      return outcome.value;
    };
    // Install lifetime bookkeeping before a synchronous failure or completion.
    const promise = Promise.resolve().then(execute).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      running.delete(controller);
      cleanupCalls.delete(controller);
    });
    running.set(controller, promise);
    return promise;
  };

  const callbackFactory = (
    scope: HostScope,
    authority: HostScope = moduleScope,
    development?: CompiledDevelopmentProgram,
  ): HostCallbackFactory =>
  (type, environment) => {
    const entry = manifest.callbacks.find((entry) => entry.name === type.entry);
    if (
      entry === undefined || type.environment.kind !== "record" ||
      environment === null || typeof environment !== "object" ||
      !("kind" in environment) || environment.kind !== "record"
    ) {
      throw new TypeError(
        "compiled callback has an invalid entry or environment",
      );
    }
    const captures = type.environment.fields.map((field) => {
      const value = environment.fields.get(field.name);
      if (value === undefined) {
        throw new Error("compiled callback capture is missing");
      }
      return value;
    });
    const snapshot = options.development?.(development);
    return createHostCallback(
      scope,
      (destination) => {
        if (!destination.isWithin(authority)) {
          throw new TypeError(
            "compiled callback cannot escape its execution authority",
          );
        }
        validateCaptureScope(type.environment, environment, destination);
      },
      (owner, argument, signal) =>
        start(entry, [argument, ...captures], owner, owner, {
          signal,
          authority,
          development: snapshot?.program,
        }),
      {
        module,
        manifestBytes: bytes,
        entry: entry.name,
        environmentType: type.environment,
        captures,
        development: snapshot?.program,
      },
      { type, dispose: snapshot?.release },
    );
  };

  const hosted: HostedModule = {
    instance,
    invokeLinked(name, arguments_, context) {
      if (
        options.scope === undefined || !context.scope.isWithin(options.scope) ||
        !context.scope.isWithin(context.authority)
      ) {
        throw new TypeError(
          "development call requires a scope under the shared host lifetime",
        );
      }
      return invoke(context, name, ...arguments_);
    },
    callLinked(name, arguments_, context) {
      if (
        options.scope === undefined || !context.scope.isWithin(options.scope) ||
        !context.scope.isWithin(context.authority)
      ) {
        throw new TypeError(
          "development call requires a scope under the shared host lifetime",
        );
      }
      const declaration = manifest.exports.find((exported) =>
        exported.name === name
      );
      if (declaration === undefined) {
        throw new TypeError(`unknown development export ${name}`);
      }
      const exported = resolve(declaration.sourceName, arguments_);
      if (exported.execution !== "resumable") {
        throw new TypeError(
          "scoped development call requires a resumable export",
        );
      }
      return start(exported, arguments_, context.scope, context.scope, {
        ...context,
        linked: true,
      });
    },
    callCallback(name, arguments_, options = {}) {
      const entry = manifest.callbacks.find((entry) => entry.name === name);
      if (entry === undefined) {
        throw new TypeError(`unknown compiled callback ${name}`);
      }
      if (arguments_.length !== entry.function.parameters.length) {
        throw new TypeError(
          `callback ${name} requires ${entry.function.parameters.length} arguments`,
        );
      }
      let lifetime = moduleScope;
      if (options.scope !== undefined) {
        if (
          hostLifetime === undefined || !options.scope.isWithin(hostLifetime)
        ) {
          throw new TypeError(
            "callback scope must belong to the module's host lifetime",
          );
        }
        lifetime = options.scope;
      }
      return start(entry, arguments_, lifetime, lifetime, {
        signal: options.signal,
        authority: lifetime,
      });
    },
    call(name, arguments_ = []) {
      const exported = resolve(name, arguments_);
      if (exported.execution === "resumable") {
        throw new TypeError(`export ${name} suspends; use callAsync`);
      }
      const execution = {
        signal: new AbortController().signal,
        scope: moduleScope,
        authority: moduleScope,
      };
      const allocationScope = requireGuestScopeToken(
        invoke(execution, "cabi_enter"),
      );
      try {
        const codec = new AbiCodec(
          memory,
          (size, alignment) =>
            Number(realloc(allocationScope, 0, 0, alignment, size)) >>> 0,
          moduleScope,
        );
        const lowered = arguments_.flatMap((value, index) =>
          codec.lower(exported.function.parameters[index], value)
        );
        const raw = invoke(
          execution,
          exported.name,
          allocationScope,
          ...lowered,
        );
        if (flattenedAbiType(exported.function.result).length <= 1) {
          return readDirect(exported.function.result, raw, moduleScope);
        }
        if (typeof raw !== "number" || exported.postReturn === null) {
          throw new TypeError("invalid indirect result pointer");
        }
        try {
          return readMemory(
            exported.function.result,
            new DataView(memory.buffer),
            raw >>> 0,
            undefined,
            moduleScope,
          );
        } finally {
          invoke(execution, exported.postReturn, allocationScope, raw);
        }
      } finally {
        invoke(execution, "cabi_leave", allocationScope);
      }
    },
    callAsync(name, arguments_ = [], options = {}) {
      const exported = resolve(name, arguments_);
      if (exported.execution === "direct") {
        return Promise.resolve().then(() => {
          options.signal?.throwIfAborted();
          return hosted.call(name, arguments_);
        });
      }
      return start(exported, arguments_, moduleScope, moduleScope, options);
    },
    close() {
      if (calling) throw new Error("cannot close a module during a guest call");
      if (closingPromise !== undefined) return closingPromise;
      closing = true;
      let cancellation: unknown = new DOMException(
        "hosted module closed",
        "AbortError",
      );
      if (moduleScope.signal.aborted) cancellation = moduleScope.signal.reason;
      closingPromise = Promise.resolve().then(async () => {
        const outcomes = await Promise.allSettled(running.values());
        const failures: unknown[] = outcomes.filter((outcome) =>
          outcome.status === "rejected" && outcome.reason !== cancellation
        ).map((failure) => {
          if (failure.status !== "rejected") {
            throw new Error("unfiltered close outcome");
          }
          return failure.reason;
        });
        try {
          await moduleScope.close(cancellation);
        } catch (error) {
          failures.push(error);
        }
        destroyed = true;
        detach?.();
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "hosted module failed while closing",
          );
        }
      });
      moduleScope.cancel(cancellation);
      for (const controller of running.keys()) {
        if (!cleanupCalls.has(controller)) controller.abort(cancellation);
      }
      return closingPromise;
    },
    destroy() {
      if (calling) {
        throw new Error("cannot destroy a module during a guest call");
      }
      if (running.size > 0) {
        throw new Error("module has active calls; await close()");
      }
      if (moduleScope.hasLifetimes) {
        throw new Error("module owns resources; await close()");
      }
      destroyed = true;
      detach?.();
      void moduleScope.close();
    },
  };
  const detach = options.scope?.own(() => hosted.close());
  return Object.freeze(hosted);
}

function requireParameters(types: readonly BlotAbiType[]): void {
  if (
    types.reduce((count, type) => count + flattenedAbiType(type).length, 0) > 16
  ) {
    throw new TypeError(
      "host adapter does not marshal indirect parameter blocks",
    );
  }
}

function hasLinear(ownership: BlotEffectOwnership): boolean {
  if (typeof ownership === "string") return ownership === "linear";
  if (ownership.kind === "record") {
    return ownership.fields.some((field) => hasLinear(field.ownership));
  }
  return ownership.cases.some((case_) => hasLinear(case_.ownership));
}

function isThenable(
  value: RuntimeValue | PromiseLike<RuntimeValue>,
): value is PromiseLike<RuntimeValue> {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function validateCaptureScope(
  type: BlotAbiType,
  value: RuntimeValue,
  scope: HostScope,
): void {
  if (type.kind === "resource") {
    if (
      value === null || typeof value !== "object" || !("kind" in value) ||
      value.kind !== "resource"
    ) {
      throw new TypeError("compiled callback has an invalid resource capture");
    }
    scope.lower(type.name, value, type.payload);
  } else if (type.kind === "array") {
    if (!Array.isArray(value)) {
      throw new Error("compiled callback array capture is invalid");
    }
    for (const element of value) {
      validateCaptureScope(type.element, element, scope);
    }
  } else if (type.kind === "record") {
    if (
      value === null || typeof value !== "object" || !("kind" in value) ||
      value.kind !== "record"
    ) {
      throw new Error("compiled callback record capture is invalid");
    }
    for (const field of type.fields) {
      validateCaptureScope(field.type, value.fields.get(field.name)!, scope);
    }
  } else if (type.kind === "sealed") {
    if (
      value === null || typeof value !== "object" || !("kind" in value) ||
      value.kind !== "sealed"
    ) {
      throw new Error("compiled callback sealed capture is invalid");
    }
    validateCaptureScope(type.inner, value.value, scope);
  } else if (type.kind === "variant") {
    if (
      value === null || typeof value !== "object" || !("kind" in value) ||
      value.kind !== "variant"
    ) {
      throw new Error("compiled callback variant capture is invalid");
    }
    const selected = type.cases.find((candidate) =>
      candidate.name === value.name
    );
    if (selected === undefined) {
      throw new Error("compiled callback variant is absent");
    }
    if (selected.payload !== undefined) {
      validateCaptureScope(selected.payload, value.payload!, scope);
    }
  } else if (type.kind === "callback") {
    throw new TypeError(
      "compiled callback captures cannot contain another host callback",
    );
  }
}
