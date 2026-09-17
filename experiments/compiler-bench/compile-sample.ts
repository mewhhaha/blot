/** A fresh-process full-compilation sample; no latency threshold or hidden warmup. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Compiler } from "../../src/compiler.ts";

export type CompilationMode = "cold" | "split" | "resident";

export interface CompilationSampleOptions {
  readonly entry: string;
  readonly mode: CompilationMode;
  readonly wasm?: string;
  readonly snapshot?: string;
  readonly output?: string;
}

export function parseCompilationSampleOptions(
  args: readonly string[],
): CompilationSampleOptions {
  const values = new Map<string, string>();
  const names = new Set(["entry", "mode", "wasm", "snapshot", "output"]);
  for (const argument of args) {
    const match = /^--([a-z]+)=(.+)$/.exec(argument);
    if (match === null || !names.has(match[1])) {
      throw new Error(`Expected a known --name=value option: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`Duplicate option: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const entry = values.get("entry");
  if (entry === undefined) {
    throw new Error("--entry=/absolute/path/main.blot is required");
  }
  let mode: CompilationMode = "cold";
  const requestedMode = values.get("mode");
  if (requestedMode !== undefined) {
    if (!["cold", "split", "resident"].includes(requestedMode)) {
      throw new Error("--mode must be cold, split, or resident");
    }
    mode = requestedMode as CompilationMode;
  }
  const wasm = values.get("wasm");
  const snapshot = values.get("snapshot");
  if ((wasm === undefined) !== (snapshot === undefined)) {
    throw new Error("Custom compiler bytes require both --wasm and --snapshot");
  }
  return {
    entry: resolve(entry),
    mode,
    wasm,
    snapshot,
    output: values.get("output"),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sampleCompilation(options: CompilationSampleOptions) {
  if ((options.wasm === undefined) !== (options.snapshot === undefined)) {
    throw new Error("Custom compiler bytes require both --wasm and --snapshot");
  }
  // Load distribution bytes before timing compiler initialization. No application
  // source or dependency is read by this harness before Compiler.compile/prepare.
  let wasmPath = fileURLToPath(
    new URL("../../generated/compiler/compiler.wasm", import.meta.url),
  );
  let snapshotPath = fileURLToPath(
    new URL("../../generated/compiler/prelude.snapshot", import.meta.url),
  );
  let distribution = "repository";
  if (options.wasm !== undefined && options.snapshot !== undefined) {
    wasmPath = resolve(options.wasm);
    snapshotPath = resolve(options.snapshot);
    distribution = "caller-paired";
  }
  const wasm = await readFile(wasmPath);
  const preludeSnapshot = await readFile(snapshotPath);
  const initializationStarted = performance.now();
  const compiler = await Compiler.create({ wasm, preludeSnapshot });
  const initialized = performance.now();
  try {
    let prepared = initialized;
    let prepareMs: number | null = null;
    if (options.mode === "split") {
      await compiler.prepare(options.entry);
      prepared = performance.now();
      prepareMs = prepared - initialized;
    }
    const artifact = await compiler.compile(options.entry);
    const compiled = performance.now();
    if (artifact.artifactSource !== "compiled") {
      throw new Error(
        "The first compilation must not be an artifact-cache hit",
      );
    }
    let unchangedArtifactHitMs: number | null = null;
    if (options.mode === "resident") {
      const repeatStarted = performance.now();
      const repeated = await compiler.compile(options.entry);
      unchangedArtifactHitMs = performance.now() - repeatStarted;
      if (
        repeated.artifactSource !== "revision-cache" ||
        digest(repeated.wasm) !== digest(artifact.wasm) ||
        digest(repeated.manifestBytes) !== digest(artifact.manifestBytes)
      ) {
        throw new Error(
          "Unchanged revision did not preserve its exact cached artifact",
        );
      }
    }
    if (!WebAssembly.validate(new Uint8Array(artifact.wasm))) {
      throw new Error(
        "The emitted bytes are not a valid Wasm module on this host",
      );
    }
    // Identify the observed closure after timing: do not prime source I/O or
    // confuse input hashing with compilation. This is not an atomic snapshot;
    // callers must keep sources immutable for the whole sample. No paths or
    // private source contents appear in the JSON observation.
    const paths = [...await compiler.workspaceClosure(options.entry)].sort();
    const inputs = createHash("sha256");
    let inputBytes = 0;
    for (const path of paths) {
      const bytes = await readFile(path);
      inputBytes += bytes.length;
      inputs.update(JSON.stringify([path, bytes.length]));
      inputs.update(bytes);
    }
    if (options.output !== undefined) {
      await writeFile(`${options.output}.wasm`, artifact.wasm);
      await writeFile(`${options.output}.abi.json`, artifact.manifestBytes);
    }
    return {
      schema: "blot-complete-compilation-sample-v1",
      mode: options.mode,
      distribution,
      runtimeVersions: process.versions,
      initializeMs: initialized - initializationStarted,
      prepareMs,
      compileMs: compiled - prepared,
      totalCompilationMs: compiled - initialized,
      unchangedArtifactHitMs,
      artifactSource: artifact.artifactSource,
      wasmValidated: true,
      inputFiles: paths.length,
      inputBytes,
      inputSha256: inputs.digest("hex"),
      wasmBytes: artifact.wasm.length,
      wasmSha256: digest(artifact.wasm),
      abiSha256: digest(artifact.manifestBytes),
      compilerSha256: digest(wasm),
      snapshotSha256: digest(preludeSnapshot),
    };
  } finally {
    compiler.destroy();
  }
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  pathToFileURL(resolve(invoked)).href === import.meta.url
) {
  const options = parseCompilationSampleOptions(process.argv.slice(2));
  console.log(JSON.stringify(await sampleCompilation(options)));
}
