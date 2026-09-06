import {
  decodeManifest,
  readDirect,
  readMemory,
  requiredFunction,
  requiredMemory,
  type RuntimeValue,
} from "./abi_values.ts";
import {
  type BlotAbiManifest,
  type BlotAbiType,
  flattenedAbiType,
} from "./compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "./compiler.ts";

export type HostScalar = null | boolean | bigint | number;
export type HostResult = RuntimeValue;
export type HostOperation = (
  ...arguments_: readonly HostScalar[]
) => HostScalar;
export type HostCapabilities = ReadonlyMap<
  string,
  ReadonlyMap<string, HostOperation>
>;

/** An ABI 2 instance with scalar inputs and copied canonical result values. */
export interface HostedModule {
  call(name: string, arguments_?: readonly HostScalar[]): HostResult;
  destroy(): void;
}

/**
 * Instantiate compiler-produced ABI 2 bytes with an exact, explicit set of
 * synchronous scalar capabilities. This is a host adapter, not a sandbox or a
 * suspending guest ABI. It rejects owned capability transfers and split units.
 */
export async function instantiateArtifact(
  artifact: Pick<CompilerArtifact, "wasm" | "manifestBytes">,
  capabilities: HostCapabilities = new Map(),
): Promise<HostedModule> {
  const wasm = Uint8Array.from(artifact.wasm);
  const bytes = Uint8Array.from(artifact.manifestBytes);
  const manifest = decodeManifest(bytes);
  if (
    manifest.abi.major !== 2 || manifest.abi.minor !== 0 ||
    manifest.abi.memory !== "memory32" ||
    manifest.abi.stringEncoding !== "utf-8"
  ) throw new TypeError("host requires Blot Core Wasm ABI 2.0");
  if (manifest.links !== undefined && manifest.links.length > 0) {
    throw new TypeError("host requires a closed artifact, not a split unit");
  }
  // Snapshot capability maps before an asynchronous Wasm compilation can yield.
  const supplied = new Map(
    [...capabilities].map(([name, operations]) => [name, new Map(operations)]),
  );
  const imports: WebAssembly.Imports = Object.create(null);
  const requested = new Map<string, Set<string>>();
  const externalNames = new Set<string>();
  for (const imported of manifest.imports) {
    if (
      imported.ownership.input !== "unrestricted" ||
      imported.ownership.result !== "unrestricted"
    ) {
      throw new TypeError(
        "scalar host operations require unrestricted ownership",
      );
    }
    requireParameters(imported.function.parameters);
    requireScalar(imported.function.result);
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
      const result = operation(...arguments_);
      // In particular, a Promise must not silently become a Unit result.
      const lowered = lowerScalar(imported.function.result, result);
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
    requireParameters(exported.function.parameters);
    if (
      flattenedAbiType(exported.function.result).length > 1 &&
      exported.postReturn === null
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
  let instance: WebAssembly.Instance | null = await WebAssembly.instantiate(
    module,
    imports,
  );
  let calling = false;
  return Object.freeze({
    call(name: string, arguments_: readonly HostScalar[] = []): HostResult {
      if (instance === null) throw new Error("hosted module is destroyed");
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
      const lowered = arguments_.flatMap((value, index) =>
        lowerScalar(signature.parameters[index], value)
      );
      calling = true;
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
      }
    },
    destroy(): void {
      if (calling) {
        throw new Error("cannot destroy a module during a guest call");
      }
      instance = null;
    },
  });
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
  value: HostScalar,
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
