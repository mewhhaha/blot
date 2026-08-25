import type { BlotRuntimeModule } from "../runtime/hir.ts";
import { COMPILER_HOST_ABI_VERSION } from "./host_abi.ts";

interface CompilerWasmExports {
  readonly memory: WebAssembly.Memory;
  compiler_host_abi_version(): number;
  allocate_words(wordCount: number): number;
  deallocate_words(pointer: number, wordCount: number): void;
  allocate_bytes(byteCount: number): number;
  deallocate_bytes(pointer: number, byteCount: number): void;
  lower_source(sourcePointer: number, sourceUnits: number): number;
  lower_result_pointer(): number;
  create_compiler_session(): number;
  destroy_compiler_session(handle: number): number;
  register_compiler_session_paths(
    handle: number,
    framePointer: number,
    frameBytes: number,
  ): number;
  apply_compiler_session_delta(
    handle: number,
    framePointer: number,
    frameBytes: number,
  ): number;
  check_compiler_session_module_v2(handle: number, moduleId: number): number;
  analyze_compiler_session_module_v2(
    handle: number,
    moduleId: number,
    requestedFactMask: number,
  ): number;
  remove_compiler_session_module(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
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
  analyze_compiler_session_module(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  export_compiler_session_module_ast(
    handle: number,
    pathPointer: number,
    pathUnits: number,
  ): number;
  test_compiler_session_module(
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

export type CompilerLoweringResult =
  | { readonly ok: true; readonly module: unknown }
  | CompilerSourceFailure;

export interface CompilerSourceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly origin?: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface CompilerTransportTargetRefusal {
  readonly code: string;
  readonly message: string;
}

export interface CompilerTransportLimitDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface CompilerTransportInvariantFailure {
  readonly code: "BLOT_COMPILER_INVARIANT";
  readonly phase: string;
  readonly message: string;
}

export interface CompilerTransportFailure {
  readonly ok: false;
  readonly message?: string;
  readonly diagnostic?: CompilerSourceDiagnostic;
  readonly diagnostics?: readonly CompilerSourceDiagnostic[];
  readonly limitDiagnostic?: CompilerTransportLimitDiagnostic;
  readonly targetRefusal?: CompilerTransportTargetRefusal;
  readonly invariantFailure?: CompilerTransportInvariantFailure;
}

type CompilerSourceFailure = CompilerTransportFailure;

export type AddedCompilerModuleResult =
  | {
    readonly ok: true;
    readonly module: {
      readonly imports: string[];
      readonly includes: string[];
      readonly importSites: readonly CompilerDependencySite[];
      readonly includeSites: readonly CompilerDependencySite[];
      readonly moduleHandle: string;
      readonly portableAstDigest: string;
      readonly syntaxDiagnostics: readonly CompilerSourceDiagnostic[];
      readonly syntaxSnapshot: CompilerSyntaxSnapshot | null;
    };
  }
  | CompilerSourceFailure;

export interface CompilerDependencySite {
  readonly specifier: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface CompilerNodeReuse {
  readonly previous: number;
  readonly current: number;
}

export interface CompilerSyntaxSnapshot {
  readonly tokens: readonly number[];
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
  readonly reuse: readonly CompilerNodeReuse[];
  readonly parserExecuted: boolean;
}

export interface CompilerModuleConfiguration {
  readonly imports: Readonly<Record<string, string>>;
  readonly includes: Readonly<
    Record<string, { readonly path: string; readonly text: string }>
  >;
}

export interface CompilerSessionDelta {
  readonly path: string;
  readonly payload:
    | { readonly tag: "source"; readonly source: string }
    | { readonly tag: "ast"; readonly ast: string }
    | { readonly tag: "snapshot"; readonly bytes: Uint8Array }
    | { readonly tag: "none" }
    | { readonly tag: "remove" };
  readonly configuration?: CompilerModuleConfiguration;
}

export type CompilerDeltaResult =
  | AddedCompilerModuleResult
  | { readonly ok: true; readonly removed?: boolean };

export type CompilerEvaluationResult =
  | {
    readonly ok: true;
    readonly value: unknown;
    readonly display: string;
    readonly writes: readonly string[];
  }
  | CompilerTransportFailure;

export type CompilerCheckResult =
  | { readonly ok: true; readonly type: string; readonly effects: string }
  | CompilerTransportFailure;

export interface CompilerTypeFact {
  readonly span: { readonly start: number; readonly end: number };
  readonly type: string;
}

export interface CompilerTagFact {
  readonly span: { readonly start: number; readonly end: number };
  readonly names: readonly string[];
}

export interface CompilerOwnershipFact {
  readonly path: string;
  readonly name: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly last_use: { readonly start: number; readonly end: number } | null;
  readonly spent: boolean;
}

export interface CompilerSpecializationFact {
  readonly binding: {
    readonly path: string;
    readonly name: string | null;
    readonly span: { readonly start: number; readonly end: number };
  };
  readonly specializationCount: number;
  readonly softLimit: number;
  readonly hardLimit: number;
  readonly keys: readonly {
    readonly representation: string;
    readonly reason: string;
    readonly callSites: readonly {
      readonly path: string;
      readonly span: { readonly start: number; readonly end: number };
    }[];
    readonly runtimeHirNodes: number;
    readonly wasmFunctionBytes: number;
  }[];
}

export interface CompilerWork {
  readonly schema: 3;
  readonly typeNodes: number;
  readonly typeInterns: number;
  readonly constraints: number;
  readonly settleVisits: number;
  readonly freshenVisits: number;
  readonly unionVisits: number;
  readonly boundaryMaterializations: number;
  readonly captureCandidates: number;
  readonly capturesBridged: number;
  readonly interfaceFieldsDemanded: number;
  readonly solverWorklistPeak: number;
}

export interface CompilerInvalidationTelemetry {
  readonly dirtyModules: readonly string[];
  readonly invalidationReasons: Readonly<Record<string, string>>;
  readonly checkedModules: readonly string[];
  readonly boundaryChanged: readonly string[];
  readonly boundaryUnchanged: readonly string[];
  readonly invalidatedImporters: readonly string[];
  readonly reusedArtifacts: readonly string[];
}

export interface CompilerTargetPreflight {
  readonly supported: boolean;
  readonly code: "BLOT_TARGET_REFUSAL" | null;
  readonly export: string | null;
  readonly inferredType: string;
  readonly unsupportedComponent: string | null;
  readonly alternatives: readonly string[];
}

export type CompilerAnalysisResult =
  | {
    readonly ok: true;
    readonly type: string;
    readonly effects: string;
    readonly types: readonly CompilerTypeFact[];
    readonly tags: readonly CompilerTagFact[];
    readonly ownership: readonly CompilerOwnershipFact[];
    readonly specializations: readonly CompilerSpecializationFact[];
    readonly work: CompilerWork | null;
    readonly invalidation: CompilerInvalidationTelemetry;
    readonly targetPreflight: CompilerTargetPreflight;
  }
  | CompilerTransportFailure;

export type CompilerPortableAstResult =
  | { readonly ok: true; readonly ast: string }
  | CompilerTransportFailure;

export interface CompilerTestOutcome {
  readonly status: "passed" | "failed";
  readonly path: string;
  readonly name: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly diagnostic?: CompilerSourceDiagnostic;
}

export type CompilerTestResult =
  | { readonly ok: true; readonly outcomes: readonly CompilerTestOutcome[] }
  | CompilerTransportFailure;

export type CompilerRuntimeHirResult =
  | { readonly ok: true; readonly module: BlotRuntimeModule }
  | CompilerTransportFailure;

export type CompilerCompilationResult =
  | {
    readonly ok: true;
    readonly wasm: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly capabilities: readonly string[];
  }
  | CompilerTransportFailure;

export class CompilerWasm {
  readonly #exports: CompilerWasmExports;
  readonly #pathIds = new Map<number, Map<string, number>>();

  private constructor(exports: CompilerWasmExports) {
    this.#exports = exports;
  }

  static async load(wasm: Uint8Array): Promise<CompilerWasm> {
    const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
    const instance = await WebAssembly.instantiate(module);
    const exports = instance.exports as unknown as CompilerWasmExports;
    if (
      typeof exports.compiler_host_abi_version !== "function" ||
      exports.compiler_host_abi_version() !== COMPILER_HOST_ABI_VERSION
    ) {
      throw new Error(
        `Rust compiler host ABI mismatch; expected version ${COMPILER_HOST_ABI_VERSION}`,
      );
    }
    return new CompilerWasm(exports);
  }

  lower(source: string): CompilerLoweringResult {
    const sourceAllocation = this.#allocate(textWords(source));
    try {
      const length = this.#exports.lower_source(
        sourceAllocation.pointer,
        sourceAllocation.wordCount,
      );
      return this.#readResult(length) as CompilerLoweringResult;
    } finally {
      this.#free(sourceAllocation);
    }
  }

  createCompilerSession(): number {
    const handle = this.#exports.create_compiler_session();
    this.#pathIds.set(handle, new Map());
    return handle;
  }

  memoryPages(): number {
    return this.#exports.memory.buffer.byteLength / (64 * 1024);
  }

  destroyCompilerSession(handle: number): void {
    const status = this.#exports.destroy_compiler_session(handle);
    if (status !== 0) {
      throw new Error(`unknown Rust compiler session ${handle}`);
    }
    this.#pathIds.delete(handle);
  }

  removeCompilerSessionModule(handle: number, path: string): boolean {
    const [result] = this.applyCompilerSessionDelta(handle, [{
      path,
      payload: { tag: "remove" },
    }]);
    if (result === undefined) throw new Error("compiler delta omitted removal");
    if (!result.ok) throw new Error(failureMessage(result));
    return "removed" in result && result.removed === true;
  }

  addCompilerSessionModule(
    handle: number,
    path: string,
    source: string,
  ): AddedCompilerModuleResult {
    const [result] = this.applyCompilerSessionDelta(handle, [{
      path,
      payload: { tag: "source", source },
    }]);
    if (result === undefined) {
      throw new Error("compiler delta omitted source result");
    }
    return result as AddedCompilerModuleResult;
  }

  addCompilerSessionAst(
    handle: number,
    path: string,
    ast: string,
  ): AddedCompilerModuleResult {
    const [result] = this.applyCompilerSessionDelta(handle, [{
      path,
      payload: { tag: "ast", ast },
    }]);
    if (result === undefined) {
      throw new Error("compiler delta omitted AST result");
    }
    return result as AddedCompilerModuleResult;
  }

  configureCompilerSessionModule(
    handle: number,
    path: string,
    configuration: CompilerModuleConfiguration,
  ): void {
    const [result] = this.applyCompilerSessionDelta(handle, [{
      path,
      payload: { tag: "none" },
      configuration,
    }]);
    if (result === undefined) {
      throw new Error("compiler delta omitted configuration result");
    }
    if (!result.ok) throw new Error(failureMessage(result));
  }

  registerCompilerSessionPaths(
    handle: number,
    paths: readonly string[],
  ): readonly number[] {
    const registry = this.#pathIds.get(handle);
    if (registry === undefined) {
      throw new Error(`unknown Rust compiler session ${handle}`);
    }
    const missing = [...new Set(paths.filter((path) => !registry.has(path)))];
    if (missing.length > 0) {
      const frame = new BinaryEncoder();
      frame.u32(compilerBinaryFrameMagic);
      frame.u32(COMPILER_HOST_ABI_VERSION);
      frame.u32(missing.length);
      for (const path of missing) frame.string(path);
      const allocation = this.#allocateBytes(frame.finish());
      try {
        const length = this.#exports.register_compiler_session_paths(
          handle,
          allocation.pointer,
          allocation.byteCount,
        );
        const decoder = new BinaryDecoder(this.#readBinaryResponse(length));
        const count = decoder.u32("registered path count");
        if (count !== missing.length) {
          throw new Error(
            `compiler registered ${count} paths for ${missing.length} requests`,
          );
        }
        for (const path of missing) {
          registry.set(path, decoder.u32("registered path ID"));
        }
        decoder.finish();
      } finally {
        this.#freeBytes(allocation);
      }
    }
    return paths.map((path) => {
      const id = registry.get(path);
      if (id === undefined) {
        throw new Error(`compiler did not register path ${path}`);
      }
      return id;
    });
  }

  applyCompilerSessionDelta(
    handle: number,
    deltas: readonly CompilerSessionDelta[],
  ): readonly CompilerDeltaResult[] {
    const paths: string[] = [];
    for (const delta of deltas) {
      paths.push(delta.path);
      const configuration = delta.configuration;
      if (configuration === undefined) continue;
      for (const target of Object.values(configuration.imports)) {
        paths.push(target);
      }
      for (const included of Object.values(configuration.includes)) {
        paths.push(included.path);
      }
    }
    this.registerCompilerSessionPaths(handle, paths);
    const registry = this.#pathIds.get(handle);
    if (registry === undefined) {
      throw new Error(`unknown Rust compiler session ${handle}`);
    }
    const moduleId = (path: string): number => {
      const id = registry.get(path);
      if (id === undefined) {
        throw new Error(`compiler did not register path ${path}`);
      }
      return id;
    };
    const encoder = new BinaryEncoder();
    encoder.u32(compilerBinaryFrameMagic);
    encoder.u32(COMPILER_HOST_ABI_VERSION);
    encoder.u32(deltas.length);
    for (const delta of deltas) {
      encoder.u32(moduleId(delta.path));
      encodeDeltaPayload(encoder, delta.payload);
      const configuration = delta.configuration;
      if (configuration === undefined) {
        encoder.u32(0);
        continue;
      }
      encoder.u32(1);
      const imports = Object.entries(configuration.imports).sort((
        [left],
        [right],
      ) => left.localeCompare(right));
      encoder.u32(imports.length);
      for (const [specifier, target] of imports) {
        encoder.string(specifier);
        encoder.u32(moduleId(target));
      }
      const includes = Object.entries(configuration.includes).sort((
        [left],
        [right],
      ) => left.localeCompare(right));
      encoder.u32(includes.length);
      for (const [specifier, included] of includes) {
        encoder.string(specifier);
        encoder.u32(moduleId(included.path));
        encoder.bytes(new TextEncoder().encode(included.text));
      }
    }
    const allocation = this.#allocateBytes(encoder.finish());
    try {
      const length = this.#exports.apply_compiler_session_delta(
        handle,
        allocation.pointer,
        allocation.byteCount,
      );
      const decoder = new BinaryDecoder(this.#readBinaryResponse(length));
      const count = decoder.u32("delta result count");
      if (count !== deltas.length) {
        throw new Error(
          `compiler returned ${count} delta results for ${deltas.length} records`,
        );
      }
      const results: CompilerDeltaResult[] = [];
      for (const delta of deltas) {
        const returnedId = decoder.u32("delta result module ID");
        if (returnedId !== moduleId(delta.path)) {
          throw new Error(`compiler delta result changed module ordering`);
        }
        results.push(
          JSON.parse(
            new TextDecoder().decode(decoder.bytes("delta result")),
          ) as CompilerDeltaResult,
        );
      }
      decoder.finish();
      return results;
    } finally {
      this.#freeBytes(allocation);
    }
  }

  evaluateCompilerSessionModule(
    handle: number,
    path: string,
  ): CompilerEvaluationResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.evaluate_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      return this.#readResult(length) as CompilerEvaluationResult;
    } finally {
      this.#free(pathAllocation);
    }
  }

  checkCompilerSessionModule(
    handle: number,
    path: string,
  ): CompilerCheckResult {
    const moduleId = this.#moduleId(handle, path);
    const length = this.#exports.check_compiler_session_module_v2(
      handle,
      moduleId,
    );
    const payload = this.#readBinaryResponse(length);
    const decoder = new BinaryDecoder(payload);
    const ok = decoder.u32("check success") === 1;
    if (ok) {
      const result = {
        ok: true as const,
        type: decoder.string("check type"),
        effects: decoder.string("check effects"),
      };
      decoder.finish();
      return result;
    }
    const failure = JSON.parse(
      new TextDecoder().decode(decoder.bytes("check failure")),
    ) as CompilerTransportFailure;
    decoder.finish();
    return failure;
  }

  analyzeCompilerSessionModule(
    handle: number,
    path: string,
  ): CompilerAnalysisResult {
    const moduleId = this.#moduleId(handle, path);
    const length = this.#exports.analyze_compiler_session_module_v2(
      handle,
      moduleId,
      compilerAnalysisFactMask,
    );
    return JSON.parse(
      new TextDecoder().decode(this.#readBinaryResponse(length)),
    ) as CompilerAnalysisResult;
  }

  exportCompilerSessionModuleAst(
    handle: number,
    path: string,
  ): CompilerPortableAstResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.export_compiler_session_module_ast(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      return this.#readResult(length) as CompilerPortableAstResult;
    } finally {
      this.#free(pathAllocation);
    }
  }

  testCompilerSessionModule(
    handle: number,
    path: string,
  ): CompilerTestResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.test_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      return this.#readResult(length) as CompilerTestResult;
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
    const [result] = this.applyCompilerSessionDelta(handle, [{
      path,
      payload: { tag: "snapshot", bytes: snapshot },
    }]);
    if (result === undefined) {
      throw new Error("compiler delta omitted snapshot result");
    }
    if (!result.ok) throw new Error(failureMessage(result));
  }

  prepareCompilerSessionRuntimeHir(
    handle: number,
    path: string,
  ): CompilerRuntimeHirResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.prepare_compiler_session_runtime_hir(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true; readonly module: unknown }
        | Exclude<CompilerRuntimeHirResult, { readonly ok: true }>;
      if (!result.ok) return result;
      return { ok: true, module: decodeRuntimeHir(result.module) };
    } finally {
      this.#free(pathAllocation);
    }
  }

  compileCompilerSessionModule(
    handle: number,
    path: string,
  ): CompilerCompilationResult {
    const pathAllocation = this.#allocate(textWords(path));
    try {
      const length = this.#exports.compile_compiler_session_module(
        handle,
        pathAllocation.pointer,
        pathAllocation.wordCount,
      );
      const result = this.#readResult(length) as
        | { readonly ok: true; readonly capabilities: readonly string[] }
        | Exclude<CompilerCompilationResult, { readonly ok: true }>;
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

  #moduleId(handle: number, path: string): number {
    const [moduleId] = this.registerCompilerSessionPaths(handle, [path]);
    if (moduleId === undefined) {
      throw new Error(`compiler did not register path ${path}`);
    }
    return moduleId;
  }

  #readBinaryResponse(length: number): Uint8Array {
    const bytes = new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.lower_result_pointer(),
      length,
    ).slice();
    const decoder = new BinaryDecoder(bytes);
    const magic = decoder.u32("response magic");
    if (magic !== compilerBinaryFrameMagic) {
      throw new Error(`compiler returned binary frame magic ${magic}`);
    }
    const schema = decoder.u32("response schema");
    if (schema !== COMPILER_HOST_ABI_VERSION) {
      throw new Error(
        `compiler returned binary frame schema ${schema}, expected ${COMPILER_HOST_ABI_VERSION}`,
      );
    }
    const ok = decoder.u32("response success") === 1;
    const payload = decoder.bytes("response payload");
    decoder.finish();
    if (!ok) throw new Error(new TextDecoder().decode(payload));
    return payload.slice();
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

const compilerBinaryFrameMagic = 0x32544c42;
const compilerAnalysisFactMask = 0xffff_ffff;

class BinaryEncoder {
  readonly #bytes: number[] = [];

  u32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`compiler binary u32 cannot encode ${value}`);
    }
    this.#bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  bytes(value: Uint8Array): void {
    this.u32(value.byteLength);
    for (const byte of value) this.#bytes.push(byte);
  }

  string(value: string): void {
    this.bytes(new TextEncoder().encode(value));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

class BinaryDecoder {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  u32(label: string): number {
    const end = this.#offset + 4;
    if (!Number.isSafeInteger(end) || end > this.#bytes.byteLength) {
      throw new Error(`compiler binary frame omitted ${label}`);
    }
    const value = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#offset,
      4,
    ).getUint32(0, true);
    this.#offset = end;
    return value;
  }

  bytes(label: string): Uint8Array {
    const length = this.u32(`${label} byte length`);
    const end = this.#offset + length;
    if (!Number.isSafeInteger(end) || end > this.#bytes.byteLength) {
      throw new Error(`compiler binary frame truncated ${label}`);
    }
    const value = this.#bytes.subarray(this.#offset, end);
    this.#offset = end;
    return value;
  }

  string(label: string): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(label));
  }

  finish(): void {
    if (this.#offset !== this.#bytes.byteLength) {
      throw new Error(
        `compiler binary frame has ${
          this.#bytes.byteLength - this.#offset
        } trailing bytes`,
      );
    }
  }
}

function encodeDeltaPayload(
  encoder: BinaryEncoder,
  payload: CompilerSessionDelta["payload"],
): void {
  switch (payload.tag) {
    case "none":
      encoder.u32(0);
      encoder.bytes(new Uint8Array());
      return;
    case "source":
      encoder.u32(1);
      encoder.bytes(new TextEncoder().encode(payload.source));
      return;
    case "ast":
      encoder.u32(2);
      encoder.bytes(new TextEncoder().encode(payload.ast));
      return;
    case "snapshot":
      encoder.u32(3);
      encoder.bytes(payload.bytes);
      return;
    case "remove":
      encoder.u32(4);
      encoder.bytes(new Uint8Array());
      return;
  }
}

function failureMessage(failure: CompilerTransportFailure): string {
  if (failure.message !== undefined) return failure.message;
  if (failure.diagnostic !== undefined) return failure.diagnostic.message;
  if (failure.diagnostics !== undefined && failure.diagnostics.length > 0) {
    const diagnostic = failure.diagnostics[0];
    if (diagnostic !== undefined) return diagnostic.message;
  }
  if (failure.targetRefusal !== undefined) return failure.targetRefusal.message;
  if (failure.invariantFailure !== undefined) {
    return failure.invariantFailure.message;
  }
  return "compiler binary delta failed without a transport payload";
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
