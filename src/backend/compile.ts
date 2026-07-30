// Surface -> Wasm, through gpufuck.
//
// This is the one place blot touches a device outside the parser's throughput
// path, and it is deliberately the last stage: `blot check` infers, checks
// ownership, and reports everything it can without a WebGPU adapter existing.

import {
  buildSurfaceModule,
  compileModuleToWasm,
  CpuCompiler,
  EvaluationProfile,
  GpuCompiler,
  GpuEvaluator,
  type HostCapabilityDeclaration,
  requestWebGpuDevice,
  runWasmExport,
  runWasmModule,
  type Type,
  type TypeSchema,
  type WasmInit,
  type WasmValue,
} from "gpufuck";
import { BlotError } from "../diagnostic.ts";
import { load } from "../load.ts";
import { checkFile } from "../check/mod.ts";
import type { Imports } from "../comptime/eval.ts";
import { bridge } from "../check/bridge.ts";
import type { SimpleType } from "../check/type.ts";
import { lowerModule, type RuntimeConstructor } from "./lower.ts";
import { type StagedExport, stageModule } from "../stage.ts";

export interface WasmManifest {
  readonly format: "blot-wasm-v1";
  readonly source: string;
  readonly exports: readonly {
    readonly sourceName: string;
    readonly wasmName: string | null;
    readonly phase: "runtime" | "comptime";
    readonly abi: Type | null;
    readonly arity: number;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly capabilities: readonly string[];
  readonly imports: readonly {
    readonly capability: string;
    readonly operation: string;
    readonly parameter: TypeSchema;
    readonly result: TypeSchema;
  }[];
  readonly layouts: readonly {
    readonly name: string;
    readonly fields: readonly string[];
  }[];
  readonly constructors: readonly {
    readonly runtimeName: string;
    readonly kind: "variant" | "sealed";
    readonly sourceName: string;
    readonly payload: boolean;
  }[];
}

export interface Built {
  readonly wasm: Uint8Array;
  readonly manifest: WasmManifest;
  /** Host capabilities the module imports, one per host effect. */
  readonly capabilities: readonly string[];
  /** Field names per synthesized nominal, for reading a record back. */
  readonly shapes: ReadonlyMap<string, readonly string[]>;
  /** Source spellings for constructors decoded from the runtime ABI. */
  readonly constructors: ReadonlyMap<string, RuntimeConstructor>;
}

export async function build(path: string): Promise<Built> {
  const compiled = await compile(path);
  try {
    const wasm = await compileModuleToWasm(compiled.module);
    return {
      wasm,
      manifest: manifest(
        path,
        compiled.exports,
        compiled.lowered.exports,
        compiled.module.wasmExports,
        compiled.lowered.capabilities,
        compiled.lowered.shapes,
        compiled.lowered.constructors,
      ),
      capabilities: compiled.lowered.capabilities.map((capability) =>
        capability.name
      ),
      shapes: compiled.lowered.shapes,
      constructors: compiled.lowered.constructors,
    };
  } finally {
    compiled.module.destroy();
    compiled.device.destroy();
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
    return manifest(
      path,
      prepared.exports,
      prepared.lowered.exports,
      compilation.module.wasmExports,
      prepared.lowered.capabilities,
      prepared.lowered.shapes,
      prepared.lowered.constructors,
    );
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
    const execution = await runWasmExport(
      compilation.module,
      exported.wasmName,
      {
        arguments: arguments_,
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
  let evaluatorInit: WasmInit = {};
  if (options.evaluatorInit !== undefined) {
    evaluatorInit = options.evaluatorInit;
  }
  let wasmInit: WasmInit = {};
  if (options.wasmInit !== undefined) wasmInit = options.wasmInit;
  const compiled = await compile(path);
  try {
    let value: unknown = null;
    try {
      const evaluator = await GpuEvaluator.create(compiled.device);
      const execution = await evaluator.evaluate(compiled.module, {
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
    const wasm = await compileModuleToWasm(compiled.module);
    return {
      wasm,
      value,
      ran,
      manifest: manifest(
        path,
        compiled.exports,
        compiled.lowered.exports,
        compiled.module.wasmExports,
        compiled.lowered.capabilities,
        compiled.lowered.shapes,
        compiled.lowered.constructors,
      ),
      capabilities: compiled.lowered.capabilities.map((capability) =>
        capability.name
      ),
      shapes: compiled.lowered.shapes,
      constructors: compiled.lowered.constructors,
    };
  } finally {
    compiled.module.destroy();
    compiled.device.destroy();
  }
}

async function compile(path: string) {
  const prepared = await prepare(path);
  const device = await requestWebGpuDevice();
  const compiler = await GpuCompiler.create(device);
  const compilation = await compiler.compileModule(prepared.module);
  if (!compilation.ok) {
    device.destroy();
    throw loweringBug(compilation.diagnostics, prepared.loaded.module.span);
  }
  return {
    device,
    module: compilation.module,
    lowered: prepared.lowered,
    exports: prepared.exports,
  };
}

async function prepare(path: string) {
  const loaded = await load(path);
  // Checking first is not politeness: lowering consumes the field and
  // constructor sets inference recorded, and cannot proceed without them.
  const checked = await checkFile(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  const moduleImports = loaded.closure.imports;
  let imports: Imports = new Map();
  if (moduleImports !== undefined) imports = moduleImports;
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
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

  const module = buildSurfaceModule(
    lowered.definitions,
    lowered.types,
    lowered.entry,
    loaded.source.length,
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
  return {
    loaded,
    module,
    lowered,
    exports: staged.exports,
  };
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
  }[],
  compiledExports: readonly {
    readonly name: string;
    readonly type: Type;
    readonly effects: ReadonlySet<string>;
  }[],
  capabilities: readonly HostCapabilityDeclaration[],
  shapes: ReadonlyMap<string, readonly string[]>,
  constructors: ReadonlyMap<string, RuntimeConstructor>,
): WasmManifest {
  return {
    format: "blot-wasm-v1",
    source,
    exports: exports.map((exported) => {
      let wasmName: string | null = null;
      if (exported.phase === "runtime") {
        const runtime = lowered.find((candidate) =>
          candidate.sourceName === exported.sourceName
        );
        if (runtime === undefined) {
          throw new Error(
            `lowering omitted runtime export ${exported.sourceName}`,
          );
        }
        wasmName = runtime.wasmName;
      }
      let abi: Type | null = null;
      let effects: readonly string[] = [];
      let ownership: "owned" | null = null;
      if (wasmName !== null) {
        const compiled = compiledExports.find((candidate) =>
          candidate.name === wasmName
        );
        if (compiled === undefined) {
          throw new Error(`gpufuck omitted compiled export ${wasmName}`);
        }
        abi = compiled.type;
        effects = [...compiled.effects].sort();
        ownership = "owned";
      }
      return {
        sourceName: exported.sourceName,
        wasmName,
        phase: exported.phase,
        abi,
        arity: abiArity(abi),
        effects,
        ownership,
      };
    }),
    capabilities: capabilities.map((capability) => capability.name),
    imports: capabilities.flatMap((capability) =>
      capability.fields.flatMap((field) => {
        if (field.kind !== "operation") return [];
        return [{
          capability: capability.name,
          operation: field.name,
          parameter: field.parameter,
          result: field.result,
        }];
      })
    ),
    layouts: [...shapes].map(([name, fields]) => ({ name, fields })),
    constructors: [...constructors].map(([runtimeName, constructor]) => ({
      runtimeName,
      ...constructor,
    })),
  };
}

function abiArity(type: Type | null): number {
  let arity = 0;
  let current = type;
  while (current !== null && current.kind === "function") {
    arity += 1;
    current = current.result;
  }
  return arity;
}
