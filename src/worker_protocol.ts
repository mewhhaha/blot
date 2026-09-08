import type { RuntimeValue } from "./abi_values.ts";
import type { CompiledDevelopmentProgram } from "./callbacks.ts";
import { type SharedMemoryWire, sharedMemoryWire } from "./shared_memory.ts";

export interface WorkerPort {
  postMessage(message: unknown): void;
  onMessage(receive: (message: unknown) => void): () => void;
}

export interface WorkerConnection extends WorkerPort {
  onError(fail: (error: Error) => void): () => void;
  terminate(): Promise<void>;
}

export type WorkerRequest =
  | {
    readonly kind: "install";
    readonly program: number;
    readonly module: WebAssembly.Module;
    readonly manifestBytes: Uint8Array;
    readonly development?: CompiledDevelopmentProgram;
  }
  | { readonly kind: "uninstall"; readonly program: number }
  | {
    readonly kind: "run";
    readonly job: number;
    readonly program: number;
    readonly entry: string;
    readonly arguments: readonly RuntimeValue[];
    readonly shared?: readonly SharedMemoryWire[];
  }
  | { readonly kind: "cancel"; readonly job: number };

export type WorkerResponse =
  | { readonly kind: "started"; readonly job: number }
  | {
    readonly kind: "returned";
    readonly job: number;
    readonly value: RuntimeValue;
  }
  | { readonly kind: "cancelled"; readonly job: number }
  | {
    readonly kind: "failed";
    readonly job: number;
    readonly name: string;
    readonly message: string;
  };

function cloneable(value: unknown): value is RuntimeValue {
  if (
    value === null || typeof value === "boolean" || typeof value === "bigint" ||
    typeof value === "number" || typeof value === "string"
  ) return true;
  if (Array.isArray(value)) return value.every(cloneable);
  if (typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "record") {
    return "fields" in value && value.fields instanceof Map &&
      [...value.fields].every(([name, field]) =>
        typeof name === "string" && cloneable(field)
      );
  }
  if (value.kind === "variant") {
    return "name" in value && typeof value.name === "string" &&
      (!("payload" in value) || cloneable(value.payload));
  }
  if (value.kind === "sealed") {
    return "name" in value && typeof value.name === "string" &&
      "value" in value && cloneable(value.value);
  }
  return false;
}

function identity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function developmentProgram(value: unknown): CompiledDevelopmentProgram {
  if (
    typeof value !== "object" || value === null || !("entryUnit" in value) ||
    typeof value.entryUnit !== "string" || !("units" in value) ||
    !Array.isArray(value.units)
  ) {
    throw new TypeError("invalid compiled development program");
  }
  const names = new Set<string>();
  const units = value.units.map((unit: unknown) => {
    if (
      typeof unit !== "object" || unit === null || !("name" in unit) ||
      typeof unit.name !== "string" ||
      !("root" in unit) || typeof unit.root !== "string" ||
      !("module" in unit) ||
      !(unit.module instanceof WebAssembly.Module) ||
      !("manifestBytes" in unit) || !(unit.manifestBytes instanceof Uint8Array)
    ) {
      throw new TypeError("invalid compiled development unit");
    }
    if (names.has(unit.name)) {
      throw new TypeError("repeated compiled development unit");
    }
    names.add(unit.name);
    return {
      name: unit.name,
      root: unit.root,
      module: unit.module,
      manifestBytes: unit.manifestBytes,
    };
  });
  if (!names.has(value.entryUnit)) {
    throw new TypeError("compiled development entry is missing");
  }
  return { entryUnit: value.entryUnit, units };
}

export function workerRequest(value: unknown): WorkerRequest {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new TypeError("invalid worker request");
  }
  if (
    value.kind === "install" && "program" in value && identity(value.program) &&
    "module" in value && value.module instanceof WebAssembly.Module &&
    "manifestBytes" in value && value.manifestBytes instanceof Uint8Array
  ) {
    let development: CompiledDevelopmentProgram | undefined;
    if ("development" in value && value.development !== undefined) {
      development = developmentProgram(value.development);
    }
    return {
      kind: "install",
      program: value.program,
      module: value.module,
      manifestBytes: value.manifestBytes,
      development,
    };
  }
  if (
    value.kind === "uninstall" && "program" in value && identity(value.program)
  ) {
    return { kind: "uninstall", program: value.program };
  }
  if (!("job" in value) || !identity(value.job)) {
    throw new TypeError("worker request has no job identity");
  }
  if (value.kind === "cancel") return { kind: "cancel", job: value.job };
  if (
    value.kind === "run" && "program" in value && identity(value.program) &&
    "entry" in value && typeof value.entry === "string" &&
    "arguments" in value && Array.isArray(value.arguments) &&
    value.arguments.every(cloneable)
  ) {
    let shared: readonly SharedMemoryWire[] | undefined;
    if ("shared" in value && value.shared !== undefined) {
      if (!Array.isArray(value.shared)) {
        throw new TypeError("invalid shared kernel descriptors");
      }
      shared = value.shared.map(sharedMemoryWire);
    }
    return {
      kind: "run",
      job: value.job,
      program: value.program,
      entry: value.entry,
      arguments: value.arguments,
      shared,
    };
  }
  throw new TypeError("invalid worker run request");
}

export function workerResponse(value: unknown): WorkerResponse {
  if (
    typeof value !== "object" || value === null || !("kind" in value) ||
    !("job" in value) || !identity(value.job)
  ) throw new TypeError("invalid worker response");
  if (value.kind === "started") return { kind: "started", job: value.job };
  if (value.kind === "returned" && "value" in value && cloneable(value.value)) {
    return { kind: "returned", job: value.job, value: value.value };
  }
  if (value.kind === "cancelled") return { kind: "cancelled", job: value.job };
  if (
    value.kind === "failed" && "name" in value &&
    typeof value.name === "string" && "message" in value &&
    typeof value.message === "string"
  ) {
    return {
      kind: "failed",
      job: value.job,
      name: value.name,
      message: value.message,
    };
  }
  throw new TypeError("invalid worker completion");
}
