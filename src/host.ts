import {
  decodeManifest,
  readDirect,
  readMemory,
  requiredFunction,
  requiredMemory,
  type RuntimeValue,
  writeMemory,
} from "./abi_values.ts";
import {
  type BlotAbiManifest,
  type BlotAbiType,
  flattenedAbiType,
} from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";
import { AbiMemoryLayouts } from "./compiler/backend/runtime/memory_layout.ts";

export type HostScalar = null | boolean | bigint | number;
export type HostResult = RuntimeValue;
export type HostOperation = (
  argument: RuntimeValue,
  context: { readonly signal: AbortSignal },
) => RuntimeValue | Promise<RuntimeValue>;
export type HostCapabilities = ReadonlyMap<
  string,
  ReadonlyMap<string, HostOperation>
>;

/** An ABI 3 instance with direct calls and portable resumable calls. */
export interface HostedModule {
  call(name: string, arguments_?: readonly HostScalar[]): HostResult;
  callAsync(
    name: string,
    arguments_?: readonly RuntimeValue[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<HostResult>;
  close(): Promise<void>;
}

interface PendingOperation {
  readonly request: number;
  readonly output: number;
  readonly type: BlotAbiType;
  readonly result: Promise<RuntimeValue>;
}

interface ActiveCall {
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  pending: PendingOperation | undefined;
  token: number | undefined;
}

/**
 * Instantiate compiler-produced ABI 3 bytes with an exact, explicit set of
 * capabilities. Suspending operations receive an AbortSignal and copied
 * canonical arguments. Owned capability transfers and split units are refused.
 */
export async function instantiateArtifact(
  artifact: Pick<CompilerArtifact, "wasm" | "manifestBytes">,
  capabilities: HostCapabilities = new Map(),
): Promise<HostedModule> {
  const wasm = Uint8Array.from(artifact.wasm);
  const bytes = Uint8Array.from(artifact.manifestBytes);
  const manifest = decodeManifest(bytes);
  if (
    manifest.abi.major !== 3 || manifest.abi.minor !== 0 ||
    manifest.abi.memory !== "memory32" ||
    manifest.abi.stringEncoding !== "utf-8"
  ) throw new TypeError("host requires Blot Core Wasm ABI 3.0");
  if (manifest.links !== undefined && manifest.links.length > 0) {
    throw new TypeError("host requires a closed artifact, not a split unit");
  }
  // Snapshot capability maps before an asynchronous Wasm compilation can yield.
  const supplied = new Map(
    [...capabilities].map(([name, operations]) => [name, new Map(operations)]),
  );
  const imports: WebAssembly.Imports = Object.create(null);
  let instance: WebAssembly.Instance | null = null;
  let active: ActiveCall | undefined;
  let closing = false;
  let executing = false;
  const synchronousSignal = new AbortController().signal;
  const requested = new Map<string, Set<string>>();
  const externalNames = new Set<string>();
  for (const imported of manifest.imports) {
    if (
      imported.ownership.input !== "unrestricted" ||
      imported.ownership.result !== "unrestricted"
    ) {
      throw new TypeError(
        "host operations require unrestricted ownership",
      );
    }
    if (imported.suspension === "never") {
      requireParameters(imported.function.parameters);
      requireScalar(imported.function.result);
    } else if (imported.suspension !== "may-suspend") {
      throw new TypeError("host operation has no suspension contract");
    }
    const operations = supplied.get(imported.capability);
    const operation = operations?.get(imported.operation);
    if (typeof operation !== "function") {
      throw new TypeError(
        `missing host operation ${imported.capability}.${imported.operation}`,
      );
    }
    let names = requested.get(imported.capability);
    if (names === undefined) {
      names = new Set();
      requested.set(imported.capability, names);
    }
    if (names.has(imported.operation)) {
      throw new TypeError("duplicate host operation");
    }
    names.add(imported.operation);
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
    if (imported.suspension === "may-suspend") {
      namespace[imported.name] = (
        token: number,
        input: number,
        output: number,
        request: number,
      ) => {
        if (
          instance === null || active === undefined ||
          active.pending !== undefined || active.token !== token
        ) {
          throw new Error("suspending operation has no available active call");
        }
        const memory = requiredMemory(instance, manifest);
        const argument = readMemory(
          imported.function.parameters[0],
          new DataView(memory.buffer),
          input >>> 0,
        );
        const result = Promise.resolve(
          operation(argument, { signal: active.controller.signal }),
        );
        // Attach observation in this turn, including when cancellation wins.
        void result.catch(() => {});
        active.pending = {
          request,
          output: output >>> 0,
          type: imported.function.result,
          result,
        };
        return 1;
      };
      continue;
    }
    namespace[imported.name] = (...raw: readonly (number | bigint)[]) => {
      let position = 0;
      const arguments_ = imported.function.parameters.map((parameter) => {
        if (parameter.kind === "unit") return null;
        const value = liftScalar(parameter, raw[position]);
        position += 1;
        return value;
      });
      if (position !== raw.length) {
        throw new TypeError("host import arity mismatch");
      }
      let signal = synchronousSignal;
      if (active !== undefined) signal = active.controller.signal;
      const result = operation(arguments_[0], { signal });
      // Invalid objects may be rejected Promises, including cross-realm
      // Promises or thenables. Observe their rejection before refusing the
      // synchronous call so a caught contract error cannot later crash Node.
      if (
        (typeof result === "object" && result !== null) ||
        typeof result === "function"
      ) {
        void Promise.resolve(result).catch(() => {});
      }
      // In particular, a Promise must not silently become a Unit result.
      const lowered = lowerScalar(
        imported.function.result,
        result,
      );
      if (lowered.length === 0) return undefined;
      return lowered[0];
    };
  }
  for (const [capability, operations] of supplied) {
    const names = requested.get(capability);
    if (names === undefined) {
      throw new TypeError(`unused host capability ${capability}`);
    }
    for (const name of operations.keys()) {
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
    if (exported.suspension === "never") {
      requireParameters(exported.function.parameters);
    } else if (exported.suspension !== "may-suspend") {
      throw new TypeError("export has no suspension contract");
    }
    if (
      flattenedAbiType(exported.function.result).length > 1 &&
      exported.postReturn === null && exported.suspension === "never"
    ) {
      throw new TypeError("indirect result has no post-return operation");
    }
    exports.set(exported.sourceName, exported);
  }
  const module = await WebAssembly.compile(wasm);
  const sections = WebAssembly.Module.customSections(module, "blot:abi");
  if (sections.length !== 1 || !sameBytes(bytes, new Uint8Array(sections[0]))) {
    throw new TypeError("embedded and sidecar ABI manifests disagree");
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
  instance = await WebAssembly.instantiate(
    module,
    imports,
  );
  let calling = false;
  const hosted = {
    call(name: string, arguments_: readonly RuntimeValue[] = []): HostResult {
      if (instance === null || closing) {
        throw new Error("hosted module is closed");
      }
      if (calling) throw new Error("reentrant guest calls are not supported");
      const exported = exports.get(name);
      if (
        exported === undefined || exported.function === null ||
        exported.name === null
      ) {
        throw new TypeError(`unknown runtime export ${name}`);
      }
      if (arguments_.length !== exported.function.parameters.length) {
        throw new TypeError(
          `export ${name} requires ${exported.function.parameters.length} arguments`,
        );
      }
      const signature = exported.function;
      if (exported.suspension !== "never") {
        throw new TypeError(`export ${name} requires callAsync`);
      }
      const lowered = arguments_.flatMap((value, index) =>
        lowerScalar(signature.parameters[index], value)
      );
      calling = true;
      executing = true;
      try {
        const raw = requiredFunction(instance, exported.name)(...lowered);
        if (flattenedAbiType(exported.function.result).length <= 1) {
          return readDirect(exported.function.result, raw);
        }
        if (typeof raw !== "number" || exported.postReturn === null) {
          throw new TypeError("invalid indirect result pointer");
        }
        const postReturn = requiredFunction(instance, exported.postReturn);
        const pointer = raw >>> 0;
        try {
          const memory = requiredMemory(instance, manifest);
          return readMemory(
            exported.function.result,
            new DataView(memory.buffer),
            pointer,
          );
        } finally {
          postReturn(pointer);
        }
      } finally {
        calling = false;
        executing = false;
      }
    },
    async callAsync(
      name: string,
      arguments_: readonly RuntimeValue[] = [],
      options: { readonly signal?: AbortSignal } = {},
    ): Promise<HostResult> {
      if (instance === null || closing) {
        throw new Error("hosted module is closed");
      }
      if (calling) throw new Error("a guest call is already active");
      options.signal?.throwIfAborted();
      const exported = exports.get(name);
      if (
        exported === undefined || exported.name === null ||
        exported.function === null
      ) {
        throw new TypeError(`unknown runtime export ${name}`);
      }
      if (exported.suspension !== "may-suspend") {
        return hosted.call(name, arguments_);
      }
      if (arguments_.length !== exported.function.parameters.length) {
        throw new TypeError(
          `export ${name} requires ${exported.function.parameters.length} arguments`,
        );
      }
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const current: ActiveCall = {
        controller,
        finished,
        pending: undefined,
        token: undefined,
      };
      active = current;
      calling = true;
      let token: number | undefined;
      const guest = instance;
      const invoke = (name: string, ...arguments_: (number | bigint)[]) => {
        executing = true;
        try {
          return requiredFunction(guest, name)(...arguments_);
        } finally {
          executing = false;
        }
      };
      try {
        controller.signal.throwIfAborted();
        const begun = invoke("blot:begin");
        if (typeof begun !== "number") {
          throw new TypeError("invalid async call token");
        }
        token = begun;
        current.token = token;
        const argumentType: BlotAbiType = {
          kind: "record",
          fields: exported.function.parameters.map((type, index) => ({
            name: String(index),
            type,
          })),
        };
        const layout = new AbiMemoryLayouts().get(argumentType);
        const allocate = (alignment: number, size: number) => {
          const pointer = invoke("cabi_realloc", 0, 0, alignment, size);
          if (typeof pointer !== "number") {
            throw new TypeError("invalid host allocation pointer");
          }
          return pointer >>> 0;
        };
        const argumentsPointer = allocate(
          layout.alignment,
          Math.max(1, layout.size),
        );
        writeMemory(
          argumentType,
          {
            kind: "record",
            fields: new Map(
              arguments_.map((value, index) => [String(index), value]),
            ),
          },
          requiredMemory(guest, manifest),
          argumentsPointer,
          allocate,
        );
        invoke(exported.name, token, argumentsPointer);
        let request = 0;
        for (;;) {
          controller.signal.throwIfAborted();
          const status = invoke("blot:resume", token, request);
          if (status === 2) {
            const pointer = invoke("blot:result", token);
            if (typeof pointer !== "number") {
              throw new TypeError("invalid async result pointer");
            }
            return readMemory(
              exported.function.result,
              new DataView(requiredMemory(guest, manifest).buffer),
              pointer >>> 0,
            );
          }
          if (status !== 1 || current.pending === undefined) {
            throw new Error("Wasm suspension omitted its pending operation");
          }
          const pending = current.pending;
          let rejectAbort!: (reason: unknown) => void;
          const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
          const cancel = () => rejectAbort(controller.signal.reason);
          controller.signal.addEventListener("abort", cancel, { once: true });
          let response: RuntimeValue;
          try {
            if (controller.signal.aborted) cancel();
            response = await Promise.race([pending.result, aborted]);
          } finally {
            controller.signal.removeEventListener("abort", cancel);
          }
          controller.signal.throwIfAborted();
          const memory = requiredMemory(guest, manifest);
          writeMemory(pending.type, response, memory, pending.output, allocate);
          request = pending.request;
          current.pending = undefined;
        }
      } finally {
        try {
          if (token !== undefined) invoke("blot:release", token);
        } finally {
          options.signal?.removeEventListener("abort", abort);
          active = undefined;
          calling = false;
          finish();
        }
      }
    },
    close(): Promise<void> {
      if (executing) {
        throw new Error("cannot close a module during a guest call");
      }
      closing = true;
      if (active === undefined) {
        instance = null;
        return Promise.resolve();
      }
      active.controller.abort(
        new DOMException("Hosted module closed", "AbortError"),
      );
      return active.finished.then(() => {
        instance = null;
      });
    },
  } satisfies HostedModule;
  return Object.freeze(hosted);
}

function requireParameters(types: readonly BlotAbiType[]): void {
  types.forEach(requireScalar);
  const lanes = types.reduce(
    (count, type) => count + flattenedAbiType(type).length,
    0,
  );
  if (lanes > 16) {
    throw new TypeError(
      "scalar host adapter does not marshal indirect parameter blocks",
    );
  }
}

function requireScalar(type: BlotAbiType): void {
  if (
    !["unit", "boolean", "signed-integer-64", "float-32", "float-64"].includes(
      type.kind,
    )
  ) {
    throw new TypeError(
      `scalar host adapter does not accept ${type.kind} inputs`,
    );
  }
}

function lowerScalar(
  type: BlotAbiType,
  value: unknown,
): (number | bigint)[] {
  if (type.kind === "unit" && value === null) return [];
  if (type.kind === "boolean" && typeof value === "boolean") {
    if (value) return [1];
    return [0];
  }
  if (type.kind === "signed-integer-64" && typeof value === "bigint") {
    if (value >= -9223372036854775808n && value <= 9223372036854775807n) {
      return [value];
    }
    throw new RangeError("Int host value is outside signed 64-bit range");
  }
  if (
    (type.kind === "float-32" || type.kind === "float-64") &&
    typeof value === "number"
  ) return [value];
  throw new TypeError(`expected synchronous ${type.kind} host value`);
}

function liftScalar(type: BlotAbiType, raw: unknown): HostScalar {
  if (type.kind === "boolean") {
    if (raw === 0) return false;
    if (raw === 1) return true;
    throw new TypeError("invalid host Boolean");
  }
  if (type.kind === "signed-integer-64" && typeof raw === "bigint") return raw;
  if (
    (type.kind === "float-32" || type.kind === "float-64") &&
    typeof raw === "number"
  ) return raw;
  throw new TypeError(`invalid host ${type.kind}`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
