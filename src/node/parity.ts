import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Compiler } from "../compiler.ts";
import { CompilerWasm } from "../compiler/wasm.ts";
import { BlotError } from "../diagnostic.ts";
import { load, type Loaded, LoadError } from "../load.ts";
import type { BlotRuntimeModule } from "../runtime/hir.ts";
import { validateBlotRuntimeModule } from "../runtime/hir.ts";
import { parse } from "../syntax/parse.ts";
import { encodePortableModule } from "../syntax/portable.ts";
import {
  type CompilerAcceptance,
  type CompilerObservation,
  type CompilerRejection,
  type CompilerStage,
  compareObservations,
  type ParityGap,
  type ParityGapSignature,
  parityGapSignature,
  sameParityGapBaseline,
} from "./parity_report.ts";

const compilerWasmUrl = new URL(
  "../../generated/compiler/compiler.wasm",
  import.meta.url,
);
const arguments_ = process.argv.slice(2);
const strict = arguments_.includes("--strict");
const requested = arguments_.filter((argument) => argument !== "--strict");
let paths = requested;
if (paths.length === 0) paths = await repositoryCorpus();
if (paths.length === 0) throw new Error("compiler parity corpus is empty");

const rust = await CompilerWasm.load(await readFile(compilerWasmUrl));
const node = await Compiler.create();
const gaps: ParityGap[] = [];
let matchingAcceptances = 0;
let matchingRejections = 0;

try {
  for (const path of paths) {
    const nodeObservation = await observeNode(node, path);
    const rustObservation = await observeRust(rust, path);
    const gap = compareObservations(path, nodeObservation, rustObservation);
    if (gap !== undefined) {
      gaps.push(gap);
      continue;
    }
    if (nodeObservation.status === "accepted") matchingAcceptances += 1;
    else matchingRejections += 1;
  }
} finally {
  node.destroy();
}

const signatures = gaps.map(parityGapSignature);
let mode = "report";
let passes = true;
if (strict) {
  mode = "strict";
  passes = signatures.length === 0;
} else if (requested.length === 0) {
  mode = "baseline";
  const baselineUrl = new URL(
    "../../conformance/node-rust-gaps.json",
    import.meta.url,
  );
  const expected = JSON.parse(
    await readFile(baselineUrl, "utf8"),
  ) as ParityGapSignature[];
  passes = sameParityGapBaseline(signatures, expected);
}

console.log(JSON.stringify({
  mode,
  passes,
  corpus: paths.length,
  matchingAcceptances,
  matchingRejections,
  gaps: signatures,
  details: gaps.map((gap) => ({
    path: gap.path,
    node: observationDetail(gap.node),
    rust: observationDetail(gap.rust),
  })),
}, null, 2));
if (!passes) process.exitCode = 1;

async function observeNode(
  compiler: Compiler,
  path: string,
): Promise<CompilerObservation> {
  const absolute = resolve(path);
  const source = await readFile(absolute, "utf8");
  const parsed = await parse(source);
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic === undefined) {
      return rejection(
        "frontend",
        "NODE_FRONTEND_ERROR",
        "Node frontend rejected without a diagnostic",
      );
    }
    return rejection("frontend", diagnostic.code, diagnostic.message);
  }

  let checked: { readonly type: string; readonly effects: string };
  try {
    checked = await compiler.check(absolute);
  } catch (error) {
    return errorRejection("check", error, "NODE_CHECK_ERROR");
  }

  let hir: BlotRuntimeModule;
  try {
    hir = await compiler.prepare(absolute);
  } catch (error) {
    return errorRejection("prepare", error, "NODE_PREPARE_ERROR");
  }

  try {
    const artifact = await compiler.compile(absolute);
    return acceptance(
      hir,
      artifact.manifestBytes,
      artifact.capabilities,
    );
  } catch (error) {
    return errorRejection("compile", error, "NODE_COMPILE_ERROR");
  }
}

async function observeRust(
  rust: CompilerWasm,
  path: string,
): Promise<CompilerObservation> {
  const absolute = resolve(path);
  const source = await readFile(absolute, "utf8");
  const lowered = rust.lower(source);
  if (!lowered.ok) {
    return rustFailure("frontend", lowered, "RUST_FRONTEND_ERROR");
  }

  let root: Loaded;
  try {
    root = await load(absolute);
  } catch (error) {
    return errorRejection("load", error, "RUST_LOAD_ERROR");
  }

  const session = rust.createCompilerSession();
  try {
    const modules = new Map<string, Loaded>();
    collect(root, modules);
    for (const loaded of modules.values()) {
      let added;
      if (loaded.storage.tag === "source") {
        added = rust.addCompilerSessionModule(
          session,
          loaded.path,
          loaded.source,
        );
      } else {
        added = rust.addCompilerSessionAst(
          session,
          loaded.path,
          JSON.stringify(encodePortableModule(loaded.module)),
        );
      }
      if (!added.ok) {
        return rustFailure("load", added, "RUST_LOAD_ERROR");
      }
    }
    for (const loaded of modules.values()) {
      rust.configureCompilerSessionModule(session, loaded.path, {
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
      });
    }

    const checked = rust.checkCompilerSessionModule(session, absolute);
    if (!checked.ok) {
      return rustFailure("check", checked, "RUST_CHECK_ERROR");
    }
    const prepared = rust.prepareCompilerSessionRuntimeHir(session, absolute);
    if (!prepared.ok) {
      return rustFailure("prepare", prepared, "RUST_PREPARE_ERROR");
    }
    const compiled = rust.compileCompilerSessionModule(session, absolute);
    if (!compiled.ok) {
      return rustFailure("compile", compiled, "RUST_COMPILE_ERROR");
    }
    if (!WebAssembly.validate(compiled.wasm)) {
      return rejection(
        "compile",
        "RUST_INVALID_WASM",
        "Rust compiler emitted invalid WebAssembly",
      );
    }
    return acceptance(
      validateBlotRuntimeModule(prepared.module),
      compiled.manifestBytes,
      compiled.capabilities,
    );
  } catch (error) {
    return errorRejection("load", error, "RUST_LOAD_ERROR");
  } finally {
    rust.destroyCompilerSession(session);
  }
}

function acceptance(
  hir: BlotRuntimeModule,
  manifestBytes: Uint8Array,
  capabilities: readonly string[],
): CompilerAcceptance {
  return {
    status: "accepted",
    exports: hir.exports.map((exported) =>
      `${exported.sourceName}:${exported.phase}`
    ),
    manifest: new TextDecoder().decode(manifestBytes),
    capabilities: [...capabilities].sort(),
  };
}

function rustFailure(
  stage: CompilerStage,
  failure: {
    readonly message?: string;
    readonly diagnostic?: { readonly code: string; readonly message: string };
    readonly diagnostics?: readonly {
      readonly code: string;
      readonly message: string;
    }[];
  },
  fallbackCode: string,
): CompilerRejection {
  const diagnostic = failure.diagnostic;
  if (diagnostic !== undefined) {
    return rejection(stage, diagnostic.code, diagnostic.message);
  }
  const diagnostics = failure.diagnostics;
  if (diagnostics !== undefined && diagnostics[0] !== undefined) {
    return rejection(stage, diagnostics[0].code, diagnostics[0].message);
  }
  let message = failure.message;
  if (message === undefined) message = "compiler rejected without a message";
  const code = message.match(/BLOT_[A-Z_]+/)?.[0];
  if (code !== undefined) return rejection(stage, code, message);
  return rejection(stage, fallbackCode, message);
}

function errorRejection(
  stage: CompilerStage,
  error: unknown,
  fallbackCode: string,
): CompilerRejection {
  if (error instanceof LoadError) {
    const diagnostic = error.diagnostics[0];
    if (diagnostic !== undefined) {
      return rejection("load", diagnostic.code, diagnostic.message);
    }
  }
  if (error instanceof BlotError) {
    return rejection(stage, error.diagnostic.code, error.diagnostic.message);
  }
  let message = String(error);
  if (error instanceof Error) message = error.message;
  return rejection(stage, fallbackCode, message);
}

function observationDetail(
  observation: CompilerObservation,
): string | {
  readonly stage: CompilerStage;
  readonly code: string;
  readonly message: string;
} {
  if (observation.status === "accepted") return "accepted";
  return {
    stage: observation.stage,
    code: observation.code,
    message: observation.message,
  };
}

function rejection(
  stage: CompilerStage,
  code: string,
  message: string,
): CompilerRejection {
  return { status: "rejected", stage, code, message };
}

function collect(loaded: Loaded, modules: Map<string, Loaded>): void {
  if (modules.has(loaded.path)) return;
  modules.set(loaded.path, loaded);
  for (const dependency of loaded.dependencies.values()) {
    collect(dependency, modules);
  }
}

async function repositoryCorpus(): Promise<string[]> {
  const paths: string[] = [];
  for (const directory of ["examples", "case-studies", "src/prelude"]) {
    await collectBlotFiles(directory, paths);
  }
  paths.sort();
  return paths;
}

async function collectBlotFiles(
  directory: string,
  paths: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectBlotFiles(path, paths);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".blot")) paths.push(path);
  }
}
