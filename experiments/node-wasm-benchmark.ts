import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Compiler } from "../src/compiler.ts";
import { CompilerWasm } from "../src/compiler/wasm.ts";
import { load, type Loaded, refreshLoadedModules } from "../src/load.ts";
import type { BlotRuntimeModule } from "../src/runtime/hir.ts";
import { validateBlotRuntimeModule } from "../src/runtime/hir.ts";
import { encodePortableModule } from "../src/syntax/portable.ts";
import {
  compareObservations,
  type CompilerAcceptance,
} from "../src/node/parity_report.ts";

const samples = 9;
const arguments_ = process.argv.slice(2);
let nodeOnly = false;
let requestedPath: string | undefined;
for (const argument of arguments_) {
  if (argument === "--") continue;
  if (argument === "--node-only") {
    nodeOnly = true;
    continue;
  }
  if (requestedPath !== undefined) {
    throw new Error(
      `unexpected benchmark argument ${JSON.stringify(argument)}`,
    );
  }
  requestedPath = argument;
}
let sourcePath = "examples/minimal.blot";
if (requestedPath !== undefined) sourcePath = requestedPath;
sourcePath = resolve(sourcePath);

interface BenchmarkArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
}

interface BenchmarkCompiler {
  check(path: string): Promise<unknown>;
  prepare(path: string): Promise<BlotRuntimeModule>;
  compile(path: string): Promise<BenchmarkArtifact>;
}

interface PhaseTimes {
  readonly check: number;
  readonly prepare_after_check: number;
  readonly compile_after_prepare: number;
}

interface IncrementalTimes {
  readonly node: number;
  readonly rust: number | null;
}

interface CompilerEntry {
  readonly name: "node" | "rust";
  readonly compiler: BenchmarkCompiler;
}

async function main(): Promise<void> {
  const nodeInitializationStarted = performance.now();
  const node = await Compiler.create();
  const nodeInitialization = performance.now() - nodeInitializationStarted;
  let rust: RustBenchmarkCompiler | undefined;

  try {
    // The qualification compile is also the cold sample. No repeated timing is
    // performed until both compilers have proved that sample comparable.
    const nodeColdStarted = performance.now();
    const nodeArtifact = await node.compile(sourcePath);
    const nodeCold = performance.now() - nodeColdStarted;
    const nodeHir = await node.prepare(sourcePath);
    requireValidWasm("Node", nodeArtifact);

    let rustArtifact: BenchmarkArtifact | undefined;
    let rustHir: BlotRuntimeModule | undefined;
    let rustArtifactHash: string | null = null;
    let rustInitialization: number | null = null;
    let rustCold: number | null = null;
    if (!nodeOnly) {
      const compilerWasmUrl = new URL(
        "../generated/compiler/compiler.wasm",
        import.meta.url,
      );
      const rustInitializationStarted = performance.now();
      const compilerBytes = await readFile(compilerWasmUrl);
      const compilerWasm = await CompilerWasm.load(compilerBytes);
      rust = new RustBenchmarkCompiler(compilerWasm);
      rustInitialization = performance.now() - rustInitializationStarted;
      rustArtifactHash = createHash("sha256").update(compilerBytes).digest(
        "hex",
      );

      const rustColdStarted = performance.now();
      rustArtifact = await rust.compile(sourcePath);
      rustCold = performance.now() - rustColdStarted;
      rustHir = await rust.prepare(sourcePath);
      requireComparable(
        sourcePath,
        nodeHir,
        nodeArtifact,
        rustHir,
        rustArtifact,
      );
    }

    const compilers: CompilerEntry[] = [{ name: "node", compiler: node }];
    if (rust !== undefined) compilers.push({ name: "rust", compiler: rust });

    const nodeResident = await median(samples, async () => {
      await node.compile(sourcePath);
    });
    const nodeCheck = await median(samples, async () => {
      await node.check(sourcePath);
    });
    let rustResident: number | null = null;
    let rustCheck: number | null = null;
    if (rust !== undefined) {
      const residentRust = rust;
      rustResident = await median(samples, async () => {
        await residentRust.compile(sourcePath);
      });
      rustCheck = await median(samples, async () => {
        await residentRust.check(sourcePath);
      });
    }

    const sourceOnly = await incrementalTimes(
      compilers,
      sourcePath,
      editedComment,
    );
    const changedModule = await incrementalTimes(
      compilers,
      sourcePath,
      editedModule,
    );
    const changedPhases = await incrementalPhaseTimes(compilers, sourcePath);

    let rustMilliseconds: Record<string, number> | null = null;
    let rustPhases: PhaseTimes | null = null;
    let rustWasmBytes: number | null = null;
    let ratios: Record<string, number> | null = null;
    if (
      rustArtifact !== undefined && rustInitialization !== null &&
      rustCold !== null && rustResident !== null && rustCheck !== null &&
      sourceOnly.rust !== null && changedModule.rust !== null
    ) {
      rustPhases = requiredMapValue(changedPhases, "rust");
      rustWasmBytes = rustArtifact.wasm.byteLength;
      rustMilliseconds = {
        compiler_initialization: rustInitialization,
        cold_after_initialization: rustCold,
        cold_end_to_end: rustInitialization + rustCold,
        resident_compile: rustResident,
        resident_check: rustCheck,
        source_only_edit: sourceOnly.rust,
        changed_module_edit: changedModule.rust,
      };
      const nodePhases = requiredMapValue(changedPhases, "node");
      ratios = {
        cold_after_initialization: nodeCold / rustCold,
        cold_end_to_end: (nodeInitialization + nodeCold) /
          (rustInitialization + rustCold),
        resident_compile: nodeResident / rustResident,
        resident_check: nodeCheck / rustCheck,
        source_only_edit: sourceOnly.node / sourceOnly.rust,
        changed_module_edit: changedModule.node / changedModule.rust,
        changed_module_check: nodePhases.check / rustPhases.check,
        prepare_after_check: nodePhases.prepare_after_check /
          rustPhases.prepare_after_check,
        compile_after_prepare: nodePhases.compile_after_prepare /
          rustPhases.compile_after_prepare,
      };
    }

    let mode = "node-rust";
    let comparison: Record<string, unknown> = {
      status: "matched",
      fields: [
        "acceptance",
        "Runtime HIR exports",
        "ABI manifest",
        "capabilities",
        "Wasm validation",
      ],
    };
    if (nodeOnly) {
      mode = "node-only";
      comparison = { status: "not-run", reason: "--node-only" };
    }
    let rustCompilerIdentity: Record<string, string> | null = null;
    if (rustArtifactHash !== null) {
      rustCompilerIdentity = { artifact_sha256: rustArtifactHash };
    }
    console.log(JSON.stringify(
      {
        schema: 1,
        source: sourcePath,
        mode,
        samples,
        statistic: "median",
        comparison,
        compiler: {
          node: {
            host: process.version,
            pipeline: "Baba Wasm -> Node -> gpupaper Rust/Wasm",
          },
          rust: rustCompilerIdentity,
        },
        wasm_bytes: {
          node: nodeArtifact.wasm.byteLength,
          rust: rustWasmBytes,
        },
        milliseconds: {
          node: {
            compiler_initialization: nodeInitialization,
            cold_after_initialization: nodeCold,
            cold_end_to_end: nodeInitialization + nodeCold,
            resident_compile: nodeResident,
            resident_check: nodeCheck,
            source_only_edit: sourceOnly.node,
            changed_module_edit: changedModule.node,
          },
          rust: rustMilliseconds,
        },
        changed_module_phases: {
          node: requiredMapValue(changedPhases, "node"),
          rust: rustPhases,
        },
        node_over_rust_ratio: ratios,
      },
      null,
      2,
    ));
  } finally {
    node.destroy();
    if (rust !== undefined) rust.destroy();
  }
}

class RustBenchmarkCompiler implements BenchmarkCompiler {
  readonly #compiler: CompilerWasm;
  readonly #session: number;
  readonly #installed = new Map<string, Loaded>();

  constructor(compiler: CompilerWasm) {
    this.#compiler = compiler;
    this.#session = compiler.createCompilerSession();
  }

  async check(path: string): Promise<unknown> {
    const absolute = await this.#sync(path);
    return requireRustSuccess(
      this.#compiler.checkCompilerSessionModule(this.#session, absolute),
      "check",
    );
  }

  async prepare(path: string): Promise<BlotRuntimeModule> {
    const absolute = await this.#sync(path);
    const prepared = requireRustSuccess(
      this.#compiler.prepareCompilerSessionRuntimeHir(this.#session, absolute),
      "prepare Runtime HIR",
    );
    return validateBlotRuntimeModule(prepared.module);
  }

  async compile(path: string): Promise<BenchmarkArtifact> {
    const absolute = await this.#sync(path);
    return requireRustSuccess(
      this.#compiler.compileCompilerSessionModule(this.#session, absolute),
      "compile",
    );
  }

  destroy(): void {
    this.#compiler.destroyCompilerSession(this.#session);
  }

  async #sync(path: string): Promise<string> {
    await refreshLoadedModules();
    const root = await load(path);
    const modules = new Map<string, Loaded>();
    collectLoaded(root, modules);
    for (const loaded of modules.values()) {
      if (this.#installed.get(loaded.path) === loaded) continue;
      let added;
      if (loaded.storage.tag === "source") {
        added = this.#compiler.addCompilerSessionModule(
          this.#session,
          loaded.path,
          loaded.source,
        );
      } else {
        added = this.#compiler.addCompilerSessionAst(
          this.#session,
          loaded.path,
          JSON.stringify(encodePortableModule(loaded.module)),
        );
      }
      requireRustSuccess(added, `load ${loaded.path}`);
      this.#compiler.configureCompilerSessionModule(
        this.#session,
        loaded.path,
        {
          imports: Object.fromEntries(
            [...loaded.dependencies].map(([specifier, dependency]) => [
              specifier,
              dependency.path,
            ]),
          ),
          includes: Object.fromEntries(
            [...loaded.includedFiles].map(([specifier, included]) => [
              specifier,
              { path: included.path, text: included.source },
            ]),
          ),
        },
      );
      this.#installed.set(loaded.path, loaded);
    }
    return root.path;
  }
}

async function incrementalTimes(
  compilers: readonly CompilerEntry[],
  measuredPath: string,
  edit: (source: string, revision: number) => string,
): Promise<IncrementalTimes> {
  const source = await readFile(measuredPath, "utf8");
  const paths = new Map<"node" | "rust", string>();
  const qualifications = new Map<
    "node" | "rust",
    { readonly hir: BlotRuntimeModule; readonly artifact: BenchmarkArtifact }
  >();
  try {
    const path = temporarySourcePath(measuredPath, "incremental");
    for (const entry of compilers) {
      paths.set(entry.name, path);
      await writeFile(path, edit(source, 0));
      const artifact = await entry.compiler.compile(path);
      const hir = await entry.compiler.prepare(path);
      requireValidWasm(entry.name, artifact);
      qualifications.set(entry.name, { hir, artifact });
    }
    requireQualifiedCompilers(qualifications);

    const times = new Map<"node" | "rust", number>();
    for (const entry of compilers) {
      const path = requiredMapValue(paths, entry.name);
      let revision = 1;
      const elapsed = await median(samples, async () => {
        await writeFile(path, edit(source, revision));
        revision += 1;
        await entry.compiler.compile(path);
      });
      times.set(entry.name, elapsed);
    }
    let rustTime: number | null = null;
    const measuredRust = times.get("rust");
    if (measuredRust !== undefined) rustTime = measuredRust;
    return { node: requiredMapValue(times, "node"), rust: rustTime };
  } finally {
    await removeTemporarySources(paths);
  }
}

async function incrementalPhaseTimes(
  compilers: readonly CompilerEntry[],
  measuredPath: string,
): Promise<ReadonlyMap<"node" | "rust", PhaseTimes>> {
  const source = await readFile(measuredPath, "utf8");
  const paths = new Map<"node" | "rust", string>();
  const qualifications = new Map<
    "node" | "rust",
    { readonly hir: BlotRuntimeModule; readonly artifact: BenchmarkArtifact }
  >();
  const results = new Map<"node" | "rust", PhaseTimes>();
  try {
    const path = temporarySourcePath(measuredPath, "phases");
    for (const entry of compilers) {
      paths.set(entry.name, path);
      await writeFile(path, editedModule(source, 0));
      const artifact = await entry.compiler.compile(path);
      const hir = await entry.compiler.prepare(path);
      requireValidWasm(entry.name, artifact);
      qualifications.set(entry.name, { hir, artifact });
    }
    requireQualifiedCompilers(qualifications);

    for (const entry of compilers) {
      const path = requiredMapValue(paths, entry.name);
      const checks: number[] = [];
      const preparations: number[] = [];
      const compilations: number[] = [];
      for (let revision = 1; revision <= samples; revision += 1) {
        await writeFile(path, editedModule(source, revision));
        let started = performance.now();
        await entry.compiler.check(path);
        checks.push(performance.now() - started);
        started = performance.now();
        await entry.compiler.prepare(path);
        preparations.push(performance.now() - started);
        started = performance.now();
        await entry.compiler.compile(path);
        compilations.push(performance.now() - started);
      }
      results.set(entry.name, {
        check: medianValue(checks),
        prepare_after_check: medianValue(preparations),
        compile_after_prepare: medianValue(compilations),
      });
    }
    return results;
  } finally {
    await removeTemporarySources(paths);
  }
}

function requireQualifiedCompilers(
  qualifications: ReadonlyMap<
    "node" | "rust",
    { readonly hir: BlotRuntimeModule; readonly artifact: BenchmarkArtifact }
  >,
): void {
  const nodeQualification = requiredMapValue(qualifications, "node");
  const rustQualification = qualifications.get("rust");
  if (rustQualification === undefined) return;
  requireComparable(
    "incremental qualification",
    nodeQualification.hir,
    nodeQualification.artifact,
    rustQualification.hir,
    rustQualification.artifact,
  );
}

function requireComparable(
  path: string,
  nodeHir: BlotRuntimeModule,
  nodeArtifact: BenchmarkArtifact,
  rustHir: BlotRuntimeModule,
  rustArtifact: BenchmarkArtifact,
): void {
  requireValidWasm("Node", nodeArtifact);
  requireValidWasm("Rust", rustArtifact);
  const gap = compareObservations(
    path,
    acceptance(nodeHir, nodeArtifact),
    acceptance(rustHir, rustArtifact),
  );
  if (gap === undefined) return;
  throw new Error(
    `${path}: benchmark compilers differ in ${gap.differences.join(", ")}`,
  );
}

function acceptance(
  hir: BlotRuntimeModule,
  artifact: BenchmarkArtifact,
): CompilerAcceptance {
  return {
    status: "accepted",
    exports: hir.exports.map((exported) =>
      `${exported.sourceName}:${exported.phase}`
    ),
    manifest: new TextDecoder().decode(artifact.manifestBytes),
    capabilities: [...artifact.capabilities].sort(),
  };
}

function requireValidWasm(name: string, artifact: BenchmarkArtifact): void {
  if (WebAssembly.validate(Uint8Array.from(artifact.wasm))) return;
  throw new Error(`${name} benchmark compiler emitted invalid WebAssembly`);
}

function requireRustSuccess<T extends { readonly ok: boolean }>(
  result: T,
  operation: string,
): Extract<T, { readonly ok: true }> {
  if (!result.ok) {
    const failure = result as T & {
      readonly message: string | undefined;
      readonly diagnostic:
        | { readonly code: string; readonly message: string }
        | undefined;
      readonly diagnostics:
        | readonly {
          readonly code: string;
          readonly message: string;
        }[]
        | undefined;
    };
    let message = failure.message;
    if (failure.diagnostic !== undefined) {
      message = `${failure.diagnostic.code}: ${failure.diagnostic.message}`;
    }
    if (
      message === undefined && failure.diagnostics !== undefined &&
      failure.diagnostics[0] !== undefined
    ) {
      const diagnostic = failure.diagnostics[0];
      message = `${diagnostic.code}: ${diagnostic.message}`;
    }
    if (message === undefined) message = "compiler rejected without a message";
    throw new Error(`Rust compiler could not ${operation}: ${message}`);
  }
  return result as Extract<T, { readonly ok: true }>;
}

function collectLoaded(loaded: Loaded, found: Map<string, Loaded>): void {
  if (found.has(loaded.path)) return;
  found.set(loaded.path, loaded);
  for (const dependency of loaded.dependencies.values()) {
    collectLoaded(dependency, found);
  }
}

function editedComment(source: string, revision: number): string {
  return `${source}\n// benchmark source revision ${revision}\n`;
}

function editedModule(source: string, revision: number): string {
  const exportStart = source.lastIndexOf("\nexport ");
  if (exportStart < 0) {
    throw new Error("benchmark source has no top-level export");
  }
  const insertion = `\nlet benchmark_revision = ${revision}`;
  return source.slice(0, exportStart) + insertion + source.slice(exportStart);
}

function temporarySourcePath(path: string, label: string): string {
  return join(
    dirname(path),
    `.blot-benchmark-${label}-${randomUUID()}.blot`,
  );
}

async function removeTemporarySources(
  paths: ReadonlyMap<"node" | "rust", string>,
): Promise<void> {
  await Promise.all([...new Set(paths.values())].map(async (path) => {
    await rm(path, { force: true });
  }));
}

async function median(
  count: number,
  operation: () => Promise<void>,
): Promise<number> {
  const measurements: number[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const started = performance.now();
    await operation();
    measurements.push(performance.now() - started);
  }
  return medianValue(measurements);
}

function medianValue(measurements: number[]): number {
  measurements.sort((left, right) => left - right);
  const result = measurements[Math.floor(measurements.length / 2)];
  if (result === undefined) throw new Error("benchmark produced no samples");
  return result;
}

function requiredMapValue<K, V>(values: ReadonlyMap<K, V>, key: K): V {
  const value = values.get(key);
  if (value === undefined) throw new Error("benchmark result is incomplete");
  return value;
}

await main();
