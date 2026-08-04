import type { BlotRuntimeModule } from "./runtime/hir.ts";

interface RustMiddleExports {
  readonly memory: WebAssembly.Memory;
  allocate_words(wordCount: number): number;
  deallocate_words(pointer: number, wordCount: number): void;
  allocate_bytes(byteCount: number): number;
  deallocate_bytes(pointer: number, byteCount: number): void;
  lower_source(sourcePointer: number, sourceUnits: number): number;
  lower_result_pointer(): number;
  create_compiler_session(): number;
  destroy_compiler_session(handle: number): number;
  add_compiler_session_source(
    handle: number,
    pathPointer: number,
    pathUnits: number,
    sourcePointer: number,
    sourceUnits: number,
  ): number;
  add_compiler_session_ast(
    handle: number,
    pathPointer: number,
    pathUnits: number,
    astPointer: number,
    astUnits: number,
  ): number;
  configure_compiler_session_module(
    handle: number,
    pathPointer: number,
    pathUnits: number,
    configurationPointer: number,
    configurationUnits: number,
  ): number;
  evaluate_compiler_session_module(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  check_compiler_session_module(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  export_compiler_session_module_snapshot(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  install_compiler_session_module_snapshot(
    handle: number,
    pathPointer: number,
    pathUnits: number,
    snapshotPointer: number,
    snapshotBytes: number,
  ): number;
  module_snapshot_pointer(): number;
  module_snapshot_length(): number;
  prepare_compiler_session_runtime_hir(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  compile_compiler_session_module(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  compiled_wasm_pointer(): number;
  compiled_wasm_length(): number;
  compiled_manifest_pointer(): number;
  compiled_manifest_length(): number;
}

export type RustLoweringResult =
  | { readonly ok: true; readonly module: unknown }
  | RustSourceFailure;

interface RustSourceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly origin?: string;
  readonly span: { readonly start: number; readonly end: number };
}

type RustSourceFailure = {
  readonly ok: false;
  readonly message?: string;
  readonly diagnostics?: readonly RustSourceDiagnostic[];
};

export type AddedRustModuleResult =
  | {
    readonly ok: true;
    readonly module: {
      readonly imports: string[];
      readonly includes: string[];
    };
  }
  | RustSourceFailure;

export interface RustModuleConfiguration {
  readonly imports: Readonly<Record<string, string>>;
  readonly includes: Readonly<
    Record<string, { readonly path: string; readonly text: string }>
  >;
}

export type RustEvaluationResult =
  | { readonly ok: true; readonly value: unknown; readonly display: string }
  | {
    readonly ok: false;
    readonly message?: string;
    readonly diagnostic?: {
      readonly code: string;
      readonly message: string;
      readonly origin?: string;
      readonly span: { readonly start: number; readonly end: number };
    };
  };

export type RustCheckResult =
  | { readonly ok: true; readonly type: string; readonly effects: string }
  | {
    readonly ok: false;
    readonly message?: string;
    readonly diagnostic?: {
      readonly code: string;
      readonly message: string;
      readonly origin?: string;
      readonly span: { readonly start: number; readonly end: number };
    };
  };

export type RustRuntimeHirResult =
  | { readonly ok: true; readonly module: BlotRuntimeModule }
  | {
    readonly ok: false;
    readonly message?: string;
    readonly diagnostic?: {
      readonly code: string;
      readonly message: string;
      readonly origin?: string;
      readonly span: { readonly start: number; readonly end: number };
    };
  };

export type RustCompilationResult =
  | {
    readonly ok: true;
    readonly wasm: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly capabilities: readonly string[];
  }
  | {
    readonly ok: false;
    readonly message?: string;
    readonly diagnostic?: {
      readonly code: string;
      readonly message: string;
      readonly origin?: string;
      readonly span: { readonly start: number; readonly end: number };
    };
  };

export class RustMiddle {
  readonly #exports: RustMiddleExports;

  private constructor(exports: RustMiddleExports) {
    this.#exports = exports;
  }

  static async load(wasm: Uint8Array): Promise<RustMiddle> {
    const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
    const instance = await WebAssembly.instantiate(module);
    return new RustMiddle(instance.exports as unknown as RustMiddleExports);
  }

  lower(source: string): RustLoweringResult {
    const sourceAllocation = this.#allocate(textWords(source));
    try {
      const length = this.#exports.lower_source(
        sourceAllocation.pointer,
        sourceAllocation.wordCount,
      );
      return this.#readResult(length) as RustLoweringResult;
    } finally {
      this.#free(sourceAllocation);
    }
  }

  createCompilerSession(): number {
    return this.#exports.create_compiler_session();
  }

  destroyCompilerSession(handle: number): void {
    const status = this.#exports.destroy_compiler_session(handle);
    if (status !== 0) {
      throw new Error(`unknown Rust compiler session ${handle}`);
    }
  }

  addCompilerSessionModule(
    handle: number,
    path: string,
    source: string,
  ): AddedRustModuleResult {
    const pathAllocation = this.#allocate(textWords(path));
    const sourceAllocation = this.#allocate(textWords(source));
    try {
      const length = this.#exports.add_compiler_session_source(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
        sourceAllocation.pointer,
        sourceAllocation.wordCount,
      );
      return this.#readResult(length) as AddedRustModuleResult;
    } finally {
      this.#free(sourceAllocation);
      this.#free(pathAllocation);
    }
  }

  addCompilerSessionAst(
    handle: number,
    path: string,
    ast: string,
  ): AddedRustModuleResult {
    const pathAllocation = this.#allocate(textWords(path));
    const astAllocation = this.#allocate(textWords(ast));
    try {
      const length = this.#exports.add_compiler_session_ast(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
        astAllocation.pointer,
        astAllocation.wordCount,
      );
      return this.#readResult(length) as AddedRustModuleResult;
    } finally {
      this.#free(astAllocation);
      this.#free(pathAllocation);
    }
  }

  configureCompilerSessionModule(
    handle: number,
    path: string,
    configuration: RustModuleConfiguration,
  ): void {
    const pathAllocation = this.#allocate(textWords(path));
    const configurationAllocation = this.#allocate(
      textWords(JSON.stringify(configuration)),
    );
    try {
      const length = this.#exports.configure_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
        configurationAllocation.pointer,
        configurationAllocation.wordCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true }
        | { readonly ok: false; readonly message: string };
      if (!result.ok) throw new Error(result.message);
    } finally {
      this.#free(configurationAllocation);
      this.#free(pathAllocation);
    }
  }

  evaluateCompilerSessionModule(
    handle: number,
    path: string,
  ): RustEvaluationResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.evaluate_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      return this.#readResult(length) as RustEvaluationResult;
    } finally {
      this.#free(pathAllocation);
    }
  }

  checkCompilerSessionModule(handle: number, path: string): RustCheckResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.check_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      return this.#readResult(length) as RustCheckResult;
    } finally {
      this.#free(pathAllocation);
    }
  }

  exportCompilerSessionModuleSnapshot(
    handle: number,
    path: string,
  ): Uint8Array {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.export_compiler_session_module_snapshot(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true }
        | { readonly ok: false; readonly message: string };
      if (!result.ok) throw new Error(result.message);
      return new Uint8Array(
        this.#exports.memory.buffer,
        this.#exports.module_snapshot_pointer(),
        this.#exports.module_snapshot_length(),
      ).slice();
    } finally {
      this.#free(pathAllocation);
    }
  }

  installCompilerSessionModuleSnapshot(
    handle: number,
    path: string,
    snapshot: Uint8Array,
  ): void {
    const pathAllocation = this.#allocate(textWords(path));
    const snapshotAllocation = this.#allocateBytes(snapshot);
    try {
      const length = this.#exports.install_compiler_session_module_snapshot(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
        snapshotAllocation.pointer,
        snapshotAllocation.byteCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true }
        | { readonly ok: false; readonly message: string };
      if (!result.ok) throw new Error(result.message);
    } finally {
      this.#freeBytes(snapshotAllocation);
      this.#free(pathAllocation);
    }
  }

  prepareCompilerSessionRuntimeHir(
    handle: number,
    path: string,
  ): RustRuntimeHirResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.prepare_compiler_session_runtime_hir(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true; readonly module: unknown }
        | Exclude<RustRuntimeHirResult, { readonly ok: true }>;
      if (!result.ok) return result;
      return { ok: true, module: decodeRuntimeHir(result.module) };
    } finally {
      this.#free(pathAllocation);
    }
  }

  compileCompilerSessionModule(
    handle: number,
    path: string,
  ): RustCompilationResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.compile_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true; readonly capabilities: readonly string[] }
        | Exclude<RustCompilationResult, { readonly ok: true }>;
      if (!result.ok) return result;
      const wasm = new Uint8Array(
        this.#exports.memory.buffer,
        this.#exports.compiled_wasm_pointer(),
        this.#exports.compiled_wasm_length(),
      ).slice();
      const manifestBytes = new Uint8Array(
        this.#exports.memory.buffer,
        this.#exports.compiled_manifest_pointer(),
        this.#exports.compiled_manifest_length(),
      ).slice();
      return {
        ok: true,
        wasm,
        manifestBytes,
        capabilities: result.capabilities,
      };
    } finally {
      this.#free(pathAllocation);
    }
  }

  #allocate(words: Int32Array): Allocation {
    const pointer = this.#exports.allocate_words(words.length);
    new Int32Array(this.#exports.memory.buffer, pointer, words.length).set(
      words,
    );
    return { pointer, wordCount: words.length };
  }

  #free(allocation: Allocation): void {
    this.#exports.deallocate_words(allocation.pointer, allocation.wordCount);
  }

  #allocateBytes(bytes: Uint8Array): ByteAllocation {
    const pointer = this.#exports.allocate_bytes(bytes.length);
    new Uint8Array(this.#exports.memory.buffer, pointer, bytes.length).set(
      bytes,
    );
    return { pointer, byteCount: bytes.length };
  }

  #freeBytes(allocation: ByteAllocation): void {
    this.#exports.deallocate_bytes(allocation.pointer, allocation.byteCount);
  }

  #readResult(length: number): unknown {
    const bytes = new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.lower_result_pointer(),
      length,
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  }
}

interface Allocation {
  readonly pointer: number;
  readonly wordCount: number;
}

interface ByteAllocation {
  readonly pointer: number;
  readonly byteCount: number;
}

function textWords(value: string): Int32Array {
  const words = new Int32Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    words[index] = value.charCodeAt(index);
  }
  return words;
}

function decodeRuntimeHir(value: unknown): BlotRuntimeModule {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Rust Runtime HIR result is not an object");
  }
  const module = value as Record<string, unknown>;
  const functions = module.functions;
  if (!Array.isArray(functions)) {
    throw new TypeError("Rust Runtime HIR result has no function table");
  }
  for (const function_ of functions) {
    if (typeof function_ !== "object" || function_ === null) {
      throw new TypeError("Rust Runtime HIR function is not an object");
    }
    const blocks = (function_ as Record<string, unknown>).blocks;
    if (!Array.isArray(blocks)) {
      throw new TypeError("Rust Runtime HIR function has no block table");
    }
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) {
        throw new TypeError("Rust Runtime HIR block is not an object");
      }
      const operations = (block as Record<string, unknown>).operations;
      if (!Array.isArray(operations)) {
        throw new TypeError("Rust Runtime HIR block has no operation table");
      }
      for (const operation of operations) decodeRuntimeConstant(operation);
    }
  }
  return value as BlotRuntimeModule;
}

function decodeRuntimeConstant(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const operation = value as Record<string, unknown>;
  if (operation.kind !== "constant") return;
  const wire = operation.value;
  if (typeof wire !== "object" || wire === null) {
    throw new TypeError("Rust Runtime HIR constant has no wire value");
  }
  const constant = wire as Record<string, unknown>;
  if (constant.kind === "unit") {
    operation.value = null;
    return;
  }
  if (constant.kind === "signed-integer-64") {
    if (typeof constant.value !== "string") {
      throw new TypeError("Rust Runtime HIR integer constant is not text");
    }
    operation.value = BigInt(constant.value);
    return;
  }
  if (constant.kind === "integer-32") {
    if (typeof constant.value !== "number") {
      throw new TypeError(
        "Rust Runtime HIR integer-32 constant is not numeric",
      );
    }
    operation.value = constant.value;
    return;
  }
  if (
    constant.kind === "float-32" || constant.kind === "float-64" ||
    constant.kind === "boolean" || constant.kind === "text"
  ) {
    operation.value = constant.value;
    return;
  }
  throw new TypeError(
    `Rust Runtime HIR constant has unknown kind ${String(constant.kind)}`,
  );
}
