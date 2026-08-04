// Surface -> Wasm, through gpufuck.
//
// This is the one place blot touches a device outside the parser's throughput
// path, and it is deliberately the last stage: `blot check` infers, checks
// ownership, and reports everything it can without a WebGPU adapter existing.

import {
  buildSurfaceModule,
  type CanonicalAbiFunction,
  type CanonicalAbiImport,
  type CanonicalAbiInterface,
  type CanonicalAbiType,
  type CompilationOptions,
  compileModuleToWasm,
  CompilerPerformanceTrace,
  CpuCompiler,
  EvaluationProfile,
  F32X4_TYPE_NAME,
  GpuCompiler,
  GpuEvaluator,
  type HostCapabilityDeclaration,
  MASK32X4_TYPE_NAME,
  requestWebGpuDevice,
  runWasmExport,
  runWasmModule,
  STORE_TYPE_NAME,
  TEXT_TYPE_NAME,
  tryRegisterLiteralModuleUpdate,
  type Type,
  type TypeSchema,
  WASM_PROVEN_STORE_READS_TRACE_ANNOTATION,
  WASM_STATIC_ANALYSIS_TRACE_STAGE,
  WASM_STORE_READS_TRACE_ANNOTATION,
  type WasmInit,
  type WasmValue,
} from "gpufuck";
import { resolve } from "@std/path";
import { BlotError, fail } from "../diagnostic.ts";
import { load, type Loaded, refreshLoadedModules } from "../load.ts";
import { checkFile } from "../check/mod.ts";
import {
  evaluate,
  evaluationRuntime,
  type Imports,
  match,
  run,
} from "../comptime/eval.ts";
import { childEnv, shapeOf, UNIT, type Value } from "../comptime/value.ts";
import { bridge } from "../check/bridge.ts";
import type { SimpleType } from "../check/type.ts";
import {
  lowerModule,
  type RuntimeConstructor,
  type RuntimeTypeDeclaration,
} from "./lower.ts";
import { type StagedExport, stageModule } from "../stage.ts";
import {
  exportConstantRuntimeHir,
  type ResidualHostCall,
  type ResidualRuntimeExport,
} from "./gpupaper_hir.ts";
import { exportResidualRuntimeHir } from "./gpupaper_residual.ts";
import type { BlotRuntimeModule } from "./runtime/hir.ts";
import type { Expr } from "../syntax/ast.ts";

export interface WasmManifest {
  readonly format: "blot-core-wasm";
  readonly abi: {
    readonly major: 1;
    readonly minor: 0;
    readonly memory: "memory32";
    readonly stringEncoding: "utf-8";
    readonly maximumFlatParameters: 16;
    readonly maximumFlatResults: 1;
    readonly memoryExport: "memory";
    readonly reallocExport: "cabi_realloc";
  };
  readonly source: string;
  readonly exports: readonly {
    readonly sourceName: string;
    readonly name: string | null;
    readonly phase: "runtime" | "comptime";
    readonly function: WasmAbiFunction | null;
    readonly postReturn: string | null;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly imports: readonly WasmAbiImport[];
}

export interface WasmAbiFunction {
  readonly parameters: readonly WasmAbiType[];
  readonly result: WasmAbiType;
}

export interface WasmAbiImport {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: WasmAbiFunction;
}

export type WasmAbiType =
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | { readonly kind: "array"; readonly element: WasmAbiType }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly type: WasmAbiType;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly payload?: WasmAbiType;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly inner: WasmAbiType;
  };

interface InternalWasmManifest {
  readonly format: WasmManifest["format"];
  readonly abi: WasmManifest["abi"];
  readonly source: string;
  readonly exports: readonly {
    readonly sourceName: string;
    readonly name: string | null;
    readonly phase: "runtime" | "comptime";
    readonly function: CanonicalAbiFunction | null;
    readonly postReturn: string | null;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly imports: readonly CanonicalAbiImport[];
}

/**
 * What gpufuck's range analysis made of the bounds blot proved.
 *
 * blot proves an index in bounds and then emits the read anyway — the check is
 * gpufuck's to remove, and until this was read there was no way to tell whether
 * it recognised the shape our guards take. `proven` short of `total` is not a
 * defect; it is the number to look at before claiming a proof paid for itself.
 */
export interface StoreReadCounts {
  readonly total: number;
  readonly proven: number;
}

export interface Built {
  readonly wasm: Uint8Array;
  /** Store reads seen, and those whose bounds check was eliminated. */
  readonly storeReads: StoreReadCounts;
  readonly manifest: WasmManifest;
  /** Exact bytes stored in the `blot:abi` custom section and sidecar. */
  readonly manifestBytes: Uint8Array;
  /** Host capabilities the module imports, one per host effect. */
  readonly capabilities: readonly string[];
  /** Field names per synthesized nominal, for reading a record back. */
  readonly shapes: ReadonlyMap<string, readonly string[]>;
  /** Source spellings for constructors decoded from the runtime ABI. */
  readonly constructors: ReadonlyMap<string, RuntimeConstructor>;
}

export class BlotCompilerSession {
  readonly #device: GPUDevice;
  readonly #compiler: GpuCompiler;
  #evaluator: Promise<GpuEvaluator> | undefined;
  #destroyed = false;

  private constructor(device: GPUDevice, compiler: GpuCompiler) {
    this.#device = device;
    this.#compiler = compiler;
  }

  static async create(): Promise<BlotCompilerSession> {
    const device = await requestWebGpuDevice();
    try {
      return new BlotCompilerSession(device, await GpuCompiler.create(device));
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  async build(path: string): Promise<Built> {
    this.#requireActive();
    await refreshLoadedModules();
    return await buildWithSession(this, resolve(path));
  }

  async verify(path: string, options: VerifyOptions = {}): Promise<Verified> {
    this.#requireActive();
    await refreshLoadedModules();
    return await verifyWithSession(this, resolve(path), options);
  }

  async compileModule(
    module: Parameters<GpuCompiler["compileModule"]>[0],
    options: CompilationOptions = {},
  ): Promise<Awaited<ReturnType<GpuCompiler["compileModule"]>>> {
    this.#requireActive();
    return await this.#compiler.compileModule(module, options);
  }

  async evaluate(
    module: Parameters<GpuEvaluator["evaluate"]>[0],
    options: Parameters<GpuEvaluator["evaluate"]>[1],
  ): Promise<Awaited<ReturnType<GpuEvaluator["evaluate"]>>> {
    this.#requireActive();
    this.#evaluator ??= GpuEvaluator.create(this.#device);
    return await (await this.#evaluator).evaluate(module, options);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#device.destroy();
  }

  #requireActive(): void {
    if (this.#destroyed) {
      throw new Error("Blot compiler session was destroyed.");
    }
  }
}

/** Reads the stable Store-analysis annotations off a finished trace. */
function storeReadCounts(trace: CompilerPerformanceTrace): StoreReadCounts {
  let total = 0;
  let proven = 0;
  for (const event of trace.snapshot()) {
    if (event.stage !== WASM_STATIC_ANALYSIS_TRACE_STAGE) continue;
    const seen = event.annotations[WASM_STORE_READS_TRACE_ANNOTATION];
    const eliminated =
      event.annotations[WASM_PROVEN_STORE_READS_TRACE_ANNOTATION];
    if (typeof seen === "number") total += seen;
    if (typeof eliminated === "number") proven += eliminated;
  }
  return { total, proven };
}

export async function build(path: string): Promise<Built> {
  const session = await BlotCompilerSession.create();
  try {
    return await session.build(path);
  } finally {
    session.destroy();
  }
}

async function buildWithSession(
  session: BlotCompilerSession,
  path: string,
): Promise<Built> {
  const compiled = await compile(path, session);
  try {
    const internalManifest = manifest(
      path,
      compiled.exports,
      compiled.lowered.exports,
      compiled.module.wasmExports,
      compiled.lowered.capabilities,
      compiled.lowered.runtimeTypes,
    );
    const builtManifest = publicManifest(internalManifest);
    const manifestBytes = serializeManifest(builtManifest);
    const trace = new CompilerPerformanceTrace();
    const coreWasm = await compileModuleToWasm(compiled.module, {
      canonicalAbi: canonicalInterface(internalManifest),
      // The four-lane operations become single instructions. Their scalar
      // bodies stay in the module and stay correct, so this is a choice about
      // how the same program is emitted rather than about what it means — and
      // `just wasm` is what holds the two to the same answers.
      simd: "wasm-simd",
      trace,
    });
    const wasm = appendCustomSection(coreWasm, "blot:abi", manifestBytes);
    return {
      wasm,
      storeReads: storeReadCounts(trace),
      manifest: builtManifest,
      manifestBytes,
      capabilities: compiled.lowered.capabilities.flatMap((capability) => {
        if (
          capability.fields.some((field) =>
            field.kind === "operation" && field.wasmIntrinsic === undefined
          )
        ) return [capability.name];
        return [];
      }),
      shapes: compiled.lowered.shapes,
      constructors: compiled.lowered.constructors,
    };
  } finally {
    compiled.module.destroy();
  }
}

/**
 * Check the exact surface module sent to gpufuck without initializing WebGPU.
 *
 * This is the backend's CPU oracle: a blot program that passes checking but
 * fails here exposes a lowering bug.
 */
export async function validateLowering(path: string): Promise<WasmManifest> {
  const prepared = await prepare(path);
  const compilation = await new CpuCompiler().compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  try {
    return publicManifest(manifest(
      path,
      prepared.exports,
      prepared.lowered.exports,
      compilation.module.wasmExports,
      prepared.lowered.capabilities,
      prepared.lowered.runtimeTypes,
    ));
  } finally {
    compilation.module.destroy();
  }
}

/** Compile with gpufuck's CPU oracle and execute the emitted WebAssembly. */
export async function runLowering(
  path: string,
  init: WasmInit = {},
): Promise<unknown> {
  const prepared = await prepare(path);
  const compilation = await new CpuCompiler().compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  try {
    const execution = await runWasmModule(compilation.module, { init });
    return execution.value;
  } finally {
    compilation.module.destroy();
  }
}

/** Invoke one runtime field from the module result by its blot source name. */
export async function runLoweringExport(
  path: string,
  sourceName: string,
  arguments_: readonly WasmValue[] = [],
  init: WasmInit = {},
): Promise<unknown> {
  const prepared = await prepare(path);
  const exported = prepared.lowered.exports.find((candidate) =>
    candidate.sourceName === sourceName
  );
  if (exported === undefined) {
    throw new BlotError({
      code: "BLOT_NO_RUNTIME_EXPORT",
      message: `Module ${path} has no runtime export \`${sourceName}\`.`,
      span: prepared.loaded.module.span,
    });
  }
  const compilation = await new CpuCompiler().compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  try {
    // A value export is compiled as a function of unit — its body reads the
    // module result, and evaluating that cannot be a memoized global thunk
    // while the canonical ABI reclaims its arena between calls. Callers still
    // ask for a value and pass nothing, so the unit is supplied here rather
    // than pushed onto every one of them.
    const applied = exported.type.kind === "function"
      ? arguments_
      : [{ kind: "unit" } as WasmValue, ...arguments_];
    const execution = await runWasmExport(
      compilation.module,
      exported.wasmName,
      {
        arguments: applied,
        init,
      },
    );
    return execution.value;
  } finally {
    compilation.module.destroy();
  }
}

export interface Verified extends Built {
  readonly value: unknown;
  readonly ran: unknown;
}

export interface VerifyOptions {
  readonly evaluatorInit?: WasmInit;
  readonly wasmInit?: WasmInit;
}

export async function verify(
  path: string,
  options: VerifyOptions = {},
): Promise<Verified> {
  const session = await BlotCompilerSession.create();
  try {
    return await session.verify(path, options);
  } finally {
    session.destroy();
  }
}

async function verifyWithSession(
  session: BlotCompilerSession,
  path: string,
  options: VerifyOptions,
): Promise<Verified> {
  let evaluatorInit: WasmInit = {};
  if (options.evaluatorInit !== undefined) {
    evaluatorInit = options.evaluatorInit;
  }
  let wasmInit: WasmInit = {};
  if (options.wasmInit !== undefined) wasmInit = options.wasmInit;
  const compiled = await compile(path, session);
  try {
    let value: unknown = null;
    try {
      const execution = await session.evaluate(compiled.module, {
        resultForm: "deep",
        wasmInit: evaluatorInit,
      });
      if (execution.ok) {
        value = execution.value;
      } else {
        value = execution.fault;
      }
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      value = {
        unavailable: message,
      };
    }
    let ran: unknown = null;
    try {
      const execution = await runWasmModule(compiled.module, {
        init: wasmInit,
      });
      ran = execution.value;
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      ran = {
        unavailable: message,
      };
    }
    const internalManifest = manifest(
      path,
      compiled.exports,
      compiled.lowered.exports,
      compiled.module.wasmExports,
      compiled.lowered.capabilities,
      compiled.lowered.runtimeTypes,
    );
    const builtManifest = publicManifest(internalManifest);
    const manifestBytes = serializeManifest(builtManifest);
    const trace = new CompilerPerformanceTrace();
    const coreWasm = await compileModuleToWasm(compiled.module, {
      canonicalAbi: canonicalInterface(internalManifest),
      // The four-lane operations become single instructions. Their scalar
      // bodies stay in the module and stay correct, so this is a choice about
      // how the same program is emitted rather than about what it means — and
      // `just wasm` is what holds the two to the same answers.
      simd: "wasm-simd",
      trace,
    });
    const wasm = appendCustomSection(coreWasm, "blot:abi", manifestBytes);
    return {
      wasm,
      storeReads: storeReadCounts(trace),
      value,
      ran,
      manifest: builtManifest,
      manifestBytes,
      capabilities: compiled.lowered.capabilities.flatMap((capability) => {
        if (
          capability.fields.some((field) =>
            field.kind === "operation" && field.wasmIntrinsic === undefined
          )
        ) return [capability.name];
        return [];
      }),
      shapes: compiled.lowered.shapes,
      constructors: compiled.lowered.constructors,
    };
  } finally {
    compiled.module.destroy();
  }
}

async function compile(path: string, session: BlotCompilerSession) {
  const prepared = await prepare(path);
  const compilation = await session.compileModule(prepared.module);
  if (!compilation.ok) {
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  return {
    module: compilation.module,
    lowered: prepared.lowered,
    exports: prepared.exports,
  };
}

interface PreparedModule {
  readonly loaded: Loaded;
  readonly module: ReturnType<typeof buildSurfaceModule>;
  readonly lowered: ReturnType<typeof lowerModule>;
  readonly exports: readonly StagedExport[];
  readonly checked: Awaited<ReturnType<typeof checkFile>>;
  readonly imports: Imports;
}

const preparedModules = new WeakMap<Loaded, PreparedModule>();
const latestPreparedModuleByPath = new Map<string, PreparedModule>();
const gpupaperHirByLoadedRevision = new WeakMap<Loaded, BlotRuntimeModule>();
const MAXIMUM_INCREMENTAL_MODULES = 64;

async function prepare(path: string) {
  const loaded = await load(path);
  const cached = preparedModules.get(loaded);
  if (cached !== undefined) return cached;
  // Checking first is not politeness: lowering consumes the field and
  // constructor sets inference recorded, and cannot proceed without them.
  const checked = await checkFile(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  const resolvedImports = loaded.closure.imports;
  let imports: Imports = new Map();
  if (resolvedImports !== undefined) imports = resolvedImports;
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
    checked.recordAdaptations,
  );
  const runtimeExports = staged.exports.flatMap((exported) => {
    if (exported.phase !== "runtime") return [];
    let type = exportType(checked.moduleType, exported.sourceName);
    if (
      exported.value !== undefined &&
      exported.value.tag !== "tag" &&
      (hasUnconstrainedType(type, new Set()) ||
        exported.value.tag === "shape")
    ) {
      const evaluated = bridge(exported.value);
      if (evaluated !== null) type = evaluated;
    }
    return [{
      sourceName: exported.sourceName,
      type,
      value: exported.value,
    }];
  });
  const lowered = lowerModule(
    staged.module,
    {
      ...checked,
      shapes: new Map([...checked.shapes, ...staged.shapes]),
    },
    checked.values,
    runtimeExports,
  );
  const sourceEncoder = new TextEncoder();
  let sourceByteLength = sourceEncoder.encode(loaded.source).byteLength;
  const remainingDependencies = [...loaded.dependencies.values()];
  const measuredDependencies = new Set<Loaded>();
  for (let index = 0; index < remainingDependencies.length; index += 1) {
    const dependency = remainingDependencies[index];
    if (dependency === undefined || measuredDependencies.has(dependency)) {
      continue;
    }
    measuredDependencies.add(dependency);
    sourceByteLength = Math.max(
      sourceByteLength,
      sourceEncoder.encode(dependency.source).byteLength,
    );
    remainingDependencies.push(...dependency.dependencies.values());
  }

  const module = buildSurfaceModule(
    lowered.definitions,
    lowered.types,
    lowered.entry,
    sourceByteLength,
    {
      evaluationProfile: EvaluationProfile.StrictEager,
      hostCapabilities: lowered.capabilities,
      hostDefinitions: lowered.hostDefinitions,
      wasmExports: lowered.exports.map((exported) => ({
        name: exported.wasmName,
        definition: exported.definition,
      })),
    },
  );
  const prepared: PreparedModule = {
    loaded,
    module,
    lowered,
    exports: staged.exports,
    checked,
    imports,
  };
  const previous = latestPreparedModuleByPath.get(loaded.path);
  if (previous !== undefined) {
    tryRegisterLiteralModuleUpdate(previous.module, prepared.module);
  }
  preparedModules.set(loaded, prepared);
  latestPreparedModuleByPath.set(loaded.path, prepared);
  while (latestPreparedModuleByPath.size > MAXIMUM_INCREMENTAL_MODULES) {
    const oldestPath = latestPreparedModuleByPath.keys().next().value;
    if (oldestPath === undefined) break;
    latestPreparedModuleByPath.delete(oldestPath);
  }
  return prepared;
}

export async function prepareGpupaperHir(
  path: string,
): Promise<BlotRuntimeModule> {
  let prepared: PreparedModule;
  try {
    prepared = await prepare(path);
  } catch (error) {
    if (
      !(error instanceof BlotError) ||
      error.diagnostic.code !== "BLOT_UNSUPPORTED_LOWERING"
    ) throw error;
    const frontend = await prepareResidualFrontend(path);
    const cached = gpupaperHirByLoadedRevision.get(frontend.loaded);
    if (cached !== undefined) return cached;
    const hir = exportResidualRuntimeHir(
      frontend.loaded.path,
      frontend.checked,
      frontend.exports,
      "blot:default",
    );
    const snapshot = freezeSnapshot(hir);
    gpupaperHirByLoadedRevision.set(frontend.loaded, snapshot);
    return snapshot;
  }
  const cached = gpupaperHirByLoadedRevision.get(prepared.loaded);
  if (cached !== undefined) return cached;
  if (prepared.lowered.usesIntegerVectors) {
    const hir = exportResidualRuntimeHir(
      prepared.loaded.path,
      prepared.checked,
      prepared.exports,
      "blot:default",
    );
    const snapshot = freezeSnapshot(hir);
    gpupaperHirByLoadedRevision.set(prepared.loaded, snapshot);
    return snapshot;
  }
  let moduleResidual: ResidualRuntimeExport;
  let hir: BlotRuntimeModule;
  try {
    moduleResidual = residualizeUnitHostModule(prepared);
  } catch (error) {
    if (
      !(error instanceof BlotError) ||
      error.diagnostic.code !== "BLOT_UNHANDLED_EFFECT"
    ) throw error;
    hir = exportResidualRuntimeHir(
      prepared.loaded.path,
      prepared.checked,
      prepared.exports,
      "blot:default",
    );
    const snapshot = freezeSnapshot(hir);
    gpupaperHirByLoadedRevision.set(prepared.loaded, snapshot);
    return snapshot;
  }
  const residual = new Map<string, ResidualRuntimeExport>();
  for (const exported of prepared.exports) {
    if (exported.phase !== "runtime") continue;
    residual.set(exported.sourceName, {
      value: runtimeExportValue(moduleResidual.value, exported.sourceName),
      hostCalls: moduleResidual.hostCalls,
    });
  }
  hir = exportConstantRuntimeHir(
    prepared.loaded.path,
    prepared.exports,
    prepared.lowered,
    residual,
  );
  const snapshot = freezeSnapshot(hir);
  gpupaperHirByLoadedRevision.set(prepared.loaded, snapshot);
  return snapshot;
}

async function prepareResidualFrontend(path: string): Promise<{
  readonly loaded: Loaded;
  readonly checked: Awaited<ReturnType<typeof checkFile>>;
  readonly exports: readonly StagedExport[];
}> {
  const loaded = await load(path);
  const checked = await checkFile(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  let imports: Imports = new Map();
  if (loaded.closure.imports !== undefined) imports = loaded.closure.imports;
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
    checked.recordAdaptations,
  );
  return { loaded, checked, exports: staged.exports };
}

function freezeSnapshot<Value>(
  value: Value,
  seen: WeakSet<object> = new WeakSet(),
): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  const object = value as object & Record<PropertyKey, unknown>;
  for (const property of Reflect.ownKeys(object)) {
    freezeSnapshot(object[property], seen);
  }
  return Object.freeze(value);
}

function residualizeUnitHostModule(
  prepared: PreparedModule,
): ResidualRuntimeExport {
  const body: Expr = {
    tag: "block",
    declarations: prepared.loaded.module.declarations,
    result: prepared.loaded.module.result,
    resultEffects: prepared.loaded.module.resultEffects,
    span: prepared.loaded.module.span,
  };
  const calls: ResidualHostCall[] = [];
  const environment = childEnv(prepared.checked.values);
  const parameter = prepared.loaded.module.parameter;
  if (parameter !== null) {
    const grants = new Map<string, Value>();
    for (const [projection, signature] of prepared.checked.grants) {
      if (
        projection.tag !== "field" ||
        !unitOrUnobservedSimpleType(signature.result, new Set())
      ) {
        throw new TypeError(
          `${prepared.loaded.path}: residual grant does not return unit`,
        );
      }
      grants.set(projection.name, {
        tag: "native",
        name: `Init.${projection.name}`,
        arity: 1,
        applied: [],
        run: ([argument]) => {
          calls.push({
            capability: "Init",
            operation: projection.name,
            argument,
          });
          return UNIT;
        },
      });
    }
    if (!match(parameter, shapeOf([...grants]), environment)) {
      throw new TypeError(
        `${prepared.loaded.path}: symbolic grants do not match the module parameter`,
      );
    }
  }
  const moduleValue = run(
    evaluate(
      body,
      environment,
      evaluationRuntime(
        prepared.imports,
        "runtime",
        undefined,
        prepared.checked.recordAdaptations,
      ),
    ),
    (perform) => {
      if (!perform.host || !unitValueType(perform.resultType)) return null;
      calls.push({
        capability: perform.effectName,
        operation: perform.operation,
        argument: perform.argument,
      });
      return UNIT;
    },
  );
  return { value: moduleValue, hostCalls: calls };
}

function runtimeExportValue(moduleValue: Value, sourceName: string): Value {
  if (sourceName === "default") return moduleValue;
  if (moduleValue.tag !== "shape") {
    throw new TypeError(`module result is not a shape exporting ${sourceName}`);
  }
  const value = moduleValue.fields.get(sourceName);
  if (value === undefined) {
    throw new TypeError(`module result omitted direct field ${sourceName}`);
  }
  return value;
}

function unitValueType(value: Value): boolean {
  if (value.tag === "unit") return true;
  return value.tag === "extended" && unitValueType(value.inner);
}

function unitOrUnobservedSimpleType(
  type: SimpleType,
  seen: Set<number>,
): boolean {
  if (type.tag === "unit") return true;
  if (type.tag !== "var" || seen.has(type.id)) return false;
  seen.add(type.id);
  const bounds = [...type.lower, ...type.upper];
  return bounds.length === 0 ||
    bounds.every((bound) => unitOrUnobservedSimpleType(bound, seen));
}

function exportType(type: SimpleType, sourceName: string): SimpleType {
  if (sourceName === "default") return type;
  const fields = recordFields(type, new Set());
  if (fields === null) {
    throw new Error(
      `checked module result omitted record type for export ${sourceName}`,
    );
  }
  const field = fields.get(sourceName);
  if (field === undefined) {
    throw new Error(
      `checked module result omitted export field ${sourceName}`,
    );
  }
  return field;
}

function recordFields(
  type: SimpleType,
  seen: Set<number>,
): ReadonlyMap<string, SimpleType> | null {
  if (type.tag === "record") return type.fields;
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);
  for (const bound of [...type.lower, ...type.upper]) {
    const fields = recordFields(bound, seen);
    if (fields !== null) return fields;
  }
  return null;
}

function hasUnconstrainedType(
  type: SimpleType,
  seen: Set<number>,
): boolean {
  switch (type.tag) {
    case "var":
      if (seen.has(type.id)) return false;
      seen.add(type.id);
      if (type.lower.length === 0 && type.upper.length === 0) return true;
      return [...type.lower, ...type.upper].some((bound) =>
        hasUnconstrainedType(bound, seen)
      );
    case "forall":
      return hasUnconstrainedType(type.body, seen);
    case "fun":
      return hasUnconstrainedType(type.param, seen) ||
        hasUnconstrainedType(type.result, seen);
    case "record":
      return [...type.fields.values()].some((field) =>
        hasUnconstrainedType(field, seen)
      );
    case "variant":
      return [...type.cases.values()].some((payload) =>
        hasUnconstrainedType(payload, seen)
      );
    case "array":
      return hasUnconstrainedType(type.element, seen);
    case "union":
      return type.members.some((member) => hasUnconstrainedType(member, seen));
    default:
      return false;
  }
}

function loweringBug(
  diagnostics: readonly [
    { readonly code: string; readonly message: string },
    ...{
      readonly code: string;
      readonly message: string;
    }[],
  ],
  span: { readonly start: number; readonly end: number },
): BlotError {
  const [first] = diagnostics;
  return new BlotError({
    code: "BLOT_LOWERING_BUG",
    message:
      `gpufuck rejected the lowered module: ${first.code}: ${first.message}. blot accepted this program, so the lowering is wrong.`,
    span,
  });
}

function manifest(
  source: string,
  exports: readonly StagedExport[],
  lowered: readonly {
    readonly sourceName: string;
    readonly wasmName: string;
    readonly type: TypeSchema;
  }[],
  compiledExports: readonly {
    readonly name: string;
    readonly type: Type;
    readonly effects: ReadonlySet<string>;
  }[],
  capabilities: readonly HostCapabilityDeclaration[],
  runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
): InternalWasmManifest {
  const imports = capabilities.flatMap((capability) =>
    capability.fields.flatMap((field) => {
      if (field.kind !== "operation") return [];
      if (field.wasmIntrinsic !== undefined) return [];
      return [{
        capability: capability.name,
        operation: field.name,
        module: `blot:host/${capability.name}`,
        name: field.name,
        function: {
          parameters: [canonicalType(field.parameter, runtimeTypes)],
          result: canonicalType(field.result, runtimeTypes),
        },
      }];
    })
  );
  return {
    format: "blot-core-wasm",
    abi: {
      major: 1,
      minor: 0,
      memory: "memory32",
      stringEncoding: "utf-8",
      maximumFlatParameters: 16,
      maximumFlatResults: 1,
      memoryExport: "memory",
      reallocExport: "cabi_realloc",
    },
    source,
    exports: exports.map((exported) => {
      let name: string | null = null;
      if (exported.phase === "runtime") {
        const runtime = lowered.find((candidate) =>
          candidate.sourceName === exported.sourceName
        );
        if (runtime === undefined) {
          throw new Error(
            `lowering omitted runtime export ${exported.sourceName}`,
          );
        }
        name = runtime.wasmName;
      }
      let function_: CanonicalAbiFunction | null = null;
      let postReturn: string | null = null;
      let effects: readonly string[] = [];
      let ownership: "owned" | null = null;
      if (name !== null) {
        const compiled = compiledExports.find((candidate) =>
          candidate.name === name
        );
        if (compiled === undefined) {
          throw new Error(`gpufuck omitted compiled export ${name}`);
        }
        const runtime = lowered.find((candidate) =>
          candidate.wasmName === name
        );
        if (runtime === undefined) {
          throw new Error(`lowering omitted runtime schema ${name}`);
        }
        function_ = canonicalFunction(runtime.type, runtimeTypes);
        if (canonicalResultIsIndirect(function_.result)) {
          postReturn = `cabi_post_${name}`;
        }
        effects = [...compiled.effects].sort();
        ownership = "owned";
      }
      return {
        sourceName: exported.sourceName,
        name,
        phase: exported.phase,
        function: function_,
        postReturn,
        effects,
        ownership,
      };
    }),
    imports,
  };
}

function canonicalInterface(
  manifest: InternalWasmManifest,
): CanonicalAbiInterface {
  return {
    version: 1,
    exports: manifest.exports.flatMap((exported) => {
      if (exported.name === null || exported.function === null) return [];
      // A value export is compiled as a function of unit, because the module
      // body it reads from is one — evaluating it cannot be a memoized global
      // thunk while the canonical ABI reclaims its private arena between calls.
      // The descriptor has to say so, since gpufuck checks it against the
      // definition it compiled. Nothing reaches the caller: unit flattens to no
      // parameters, so the published manifest and the exported signature are
      // both what they were.
      const compiled: CanonicalAbiFunction =
        exported.function.parameters.length === 0
          ? { parameters: [{ kind: "unit" }], result: exported.function.result }
          : exported.function;
      if (exported.postReturn === null) {
        return [{ name: exported.name, function: compiled }];
      }
      return [{
        name: exported.name,
        function: compiled,
        postReturn: exported.postReturn,
      }];
    }),
    imports: manifest.imports,
  };
}

function publicManifest(internal: InternalWasmManifest): WasmManifest {
  return {
    format: internal.format,
    abi: internal.abi,
    source: internal.source,
    exports: internal.exports.map((exported) => {
      let function_: WasmAbiFunction | null = null;
      if (exported.function !== null) {
        function_ = publicFunction(exported.function);
      }
      return {
        sourceName: exported.sourceName,
        name: exported.name,
        phase: exported.phase,
        function: function_,
        postReturn: exported.postReturn,
        effects: exported.effects,
        ownership: exported.ownership,
      };
    }),
    imports: internal.imports.map((imported) => ({
      capability: imported.capability,
      operation: imported.operation,
      module: imported.module,
      name: imported.name,
      function: publicFunction(imported.function),
    })),
  };
}

function publicFunction(function_: CanonicalAbiFunction): WasmAbiFunction {
  return {
    parameters: function_.parameters.map(publicType),
    result: publicType(function_.result),
  };
}

function publicType(type: CanonicalAbiType): WasmAbiType {
  if (
    type.kind === "unit" ||
    type.kind === "signed-integer-64" ||
    type.kind === "float-32" ||
    type.kind === "float-64" ||
    type.kind === "boolean" ||
    type.kind === "text"
  ) return { kind: type.kind };
  if (type.kind === "array") {
    return { kind: "array", element: publicType(type.element) };
  }
  if (type.kind === "sealed") {
    return {
      kind: "sealed",
      name: type.name,
      inner: publicType(type.inner),
    };
  }
  if (type.kind === "record") {
    return {
      kind: "record",
      fields: type.fields.map((field) => ({
        name: field.name,
        type: publicType(field.type),
      })),
    };
  }
  return {
    kind: "variant",
    cases: type.cases.map((case_) => {
      if (case_.payload === undefined) return { name: case_.name };
      return {
        name: case_.name,
        payload: publicType(case_.payload),
      };
    }),
  };
}

function canonicalFunction(
  schema: TypeSchema,
  runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
): CanonicalAbiFunction {
  const parameters: CanonicalAbiType[] = [];
  let result = schema;
  while (result.kind === "function") {
    parameters.push(canonicalType(result.parameter, runtimeTypes));
    result = result.result;
  }
  return {
    parameters,
    result: canonicalType(result, runtimeTypes),
  };
}

function canonicalType(
  schema: TypeSchema,
  runtimeTypes: ReadonlyMap<string, RuntimeTypeDeclaration>,
): CanonicalAbiType {
  if (schema.kind === "unit") return { kind: "unit" };
  if (schema.kind === "signed-integer-64") {
    return { kind: "signed-integer-64" };
  }
  if (schema.kind === "boolean") return { kind: "boolean" };
  if (schema.kind === "float-32") return { kind: "float-32" };
  if (schema.kind === "float-64") return { kind: "float-64" };
  if (schema.kind === "named" && schema.name === F32X4_TYPE_NAME) {
    fail(
      "BLOT_VECTOR_AT_BOUNDARY",
      "An `F32x4` cannot cross the module boundary: Blot Core Wasm ABI 1 " +
        "does not publish native vector values. Read its lanes at the export.",
      { start: 0, end: 0 },
    );
  }
  if (schema.kind === "named" && schema.name === MASK32X4_TYPE_NAME) {
    fail(
      "BLOT_VECTOR_AT_BOUNDARY",
      "An `F32x4Mask` cannot cross the module boundary. Use it with " +
        "`Vec4.select` before exporting the selected value.",
      { start: 0, end: 0 },
    );
  }
  if (schema.kind !== "named") {
    throw new Error(
      `Blot ABI cannot publish gpufuck ${schema.kind} as a stable type`,
    );
  }
  if (schema.name === TEXT_TYPE_NAME) return { kind: "text" };
  if (schema.name === STORE_TYPE_NAME) {
    const element = schema.arguments[0];
    if (element === undefined || schema.arguments.length !== 1) {
      throw new Error("Blot ABI Store schema must have exactly one element");
    }
    return {
      kind: "array",
      element: canonicalType(element, runtimeTypes),
    };
  }
  const declaration = runtimeTypes.get(schema.name);
  if (declaration === undefined) {
    throw new Error(
      `Blot ABI omitted runtime declaration ${schema.name}`,
    );
  }
  if (declaration.kind === "record") {
    if (schema.arguments.length !== declaration.fields.length) {
      throw new Error(
        `Blot ABI record ${schema.name} has ${schema.arguments.length} arguments for ${declaration.fields.length} fields`,
      );
    }
    const fields = declaration.fields.map((name, index) => {
      const field = schema.arguments[index];
      if (field === undefined) {
        throw new Error(`Blot ABI record ${schema.name} omitted field ${name}`);
      }
      return {
        name,
        type: canonicalType(field, runtimeTypes),
        coreIndex: index,
      };
    });
    fields.sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });
    return {
      kind: "record",
      constructor: schema.name,
      fields,
    };
  }
  if (declaration.kind === "sealed") {
    const inner = schema.arguments[0];
    if (inner === undefined || schema.arguments.length !== 1) {
      throw new Error(
        `Blot ABI seal ${schema.name} must have exactly one carrier`,
      );
    }
    return {
      kind: "sealed",
      name: declaration.sourceName,
      constructor: declaration.runtimeName,
      inner: canonicalType(inner, runtimeTypes),
    };
  }
  const payloads = new Map<string, TypeSchema>();
  let argument = 0;
  for (const case_ of declaration.cases) {
    if (!case_.payload) continue;
    const payload = schema.arguments[argument];
    if (payload === undefined) {
      throw new Error(
        `Blot ABI variant ${schema.name} omitted payload for ${case_.sourceName}`,
      );
    }
    payloads.set(case_.sourceName, payload);
    argument += 1;
  }
  if (argument !== schema.arguments.length) {
    throw new Error(
      `Blot ABI variant ${schema.name} has ${
        schema.arguments.length - argument
      } unused type arguments`,
    );
  }
  const cases = declaration.cases.map((case_) => {
    const payload = payloads.get(case_.sourceName);
    if (payload === undefined) {
      return {
        name: case_.sourceName,
        constructor: case_.runtimeName,
      };
    }
    return {
      name: case_.sourceName,
      constructor: case_.runtimeName,
      payload: canonicalType(payload, runtimeTypes),
    };
  });
  cases.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return { kind: "variant", cases };
}

function canonicalResultIsIndirect(type: CanonicalAbiType): boolean {
  return flattenCanonicalType(type).length > 1;
}

function flattenCanonicalType(
  type: CanonicalAbiType,
): readonly ("i32" | "i64" | "f32" | "f64")[] {
  if (type.kind === "unit") return [];
  if (type.kind === "signed-integer-64") return ["i64"];
  if (type.kind === "float-32") return ["f32"];
  if (type.kind === "float-64") return ["f64"];
  if (type.kind === "boolean") return ["i32"];
  if (type.kind === "text" || type.kind === "array") return ["i32", "i32"];
  if (type.kind === "sealed") return flattenCanonicalType(type.inner);
  if (type.kind === "record") {
    return type.fields.flatMap((field) => flattenCanonicalType(field.type));
  }
  let payload: ("i32" | "i64" | "f32" | "f64")[] = [];
  for (const case_ of type.cases) {
    let flattened: readonly ("i32" | "i64" | "f32" | "f64")[] = [];
    if (case_.payload !== undefined) {
      flattened = flattenCanonicalType(case_.payload);
    }
    const joined: ("i32" | "i64" | "f32" | "f64")[] = [];
    const length = Math.max(payload.length, flattened.length);
    for (let index = 0; index < length; index += 1) {
      const left = payload[index];
      const right = flattened[index];
      if (left === undefined) joined.push(right ?? "i32");
      else if (right === undefined || left === right) joined.push(left);
      else if (
        (left === "i32" || left === "f32") &&
        (right === "i32" || right === "f32")
      ) joined.push("i32");
      else joined.push("i64");
    }
    payload = joined;
  }
  return ["i32", ...payload];
}

function serializeManifest(manifest: WasmManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function appendCustomSection(
  wasm: Uint8Array,
  name: string,
  contents: Uint8Array,
): Uint8Array {
  const encodedName = new TextEncoder().encode(name);
  const payload = new Uint8Array([
    ...unsignedLeb128(encodedName.byteLength),
    ...encodedName,
    ...contents,
  ]);
  return new Uint8Array([
    ...wasm,
    0,
    ...unsignedLeb128(payload.byteLength),
    ...payload,
  ]);
}

function unsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}
