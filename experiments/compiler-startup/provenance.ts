import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { promisify } from "node:util";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "../../src/compiler/artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../../src/compiler/host_abi.ts";
import type { CompilerStartupProvenance } from "./schema.ts";
import { compilerStartupNodeInvocationSha256 } from "./invocation.ts";

const exec = promisify(execFile);
const hostInputScopes = [
  "src",
  "generated/wasm",
  "generated/queries",
  "generated/.baba-manifest.json",
  "generated/compiler/prelude.snapshot",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "deno.json",
] as const;
const benchmarkInputPaths = [
  "experiments/compiler-startup/benchmark.ts",
  "experiments/compiler-startup/invocation.ts",
  "experiments/compiler-startup/provenance.ts",
  "experiments/compiler-startup/sample.ts",
  "experiments/compiler-startup/schema.ts",
] as const;

export async function startupBenchmarkInputsIdentity(): Promise<string> {
  return await inputFilesIdentity(benchmarkInputPaths);
}

export async function startupHostInputsIdentity(): Promise<string> {
  const listed = await exec("git", [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
    "--",
    ...hostInputScopes,
  ]);
  const paths = listed.stdout.split("\0").filter((path) => path.length > 0)
    .sort();
  if (paths.length === 0) {
    throw new Error("compiler startup host-input set is empty");
  }
  if (!paths.includes(".pnp.cjs")) paths.push(".pnp.cjs");
  paths.sort();
  return await inputFilesIdentity(paths, new Set([".pnp.cjs"]));
}

export function startupSourceGraphIdentity(
  source: string,
  preludeSha256: string,
): string {
  requireHash(preludeSha256, "prelude");
  return createHash("sha256").update(JSON.stringify({
    schema: 1,
    module: source,
    dependencies: [{
      specifier: "blot:prelude",
      module: { snapshotSha256: preludeSha256 },
    }],
    includedFiles: [],
  })).digest("hex");
}

export async function compilerStartupProvenance(
  sourcePath: string,
): Promise<CompilerStartupProvenance> {
  const [
    source,
    compilerBytes,
    manifestBytes,
    preludeSnapshot,
    commitResult,
    hostInputsSha256,
    benchmarkInputsSha256,
  ] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile("generated/compiler/compiler.wasm"),
    readFile("generated/compiler/compiler-artifact.json"),
    readFile("generated/compiler/prelude.snapshot"),
    exec("git", ["rev-parse", "HEAD"]),
    startupHostInputsIdentity(),
    startupBenchmarkInputsIdentity(),
  ]);
  const manifest = decodeCompilerArtifactManifest(
    new TextDecoder().decode(manifestBytes),
  );
  const compilerPreludeSha256 = await sha256(preludeSnapshot);
  await validateCompilerArtifact(compilerBytes, manifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: compilerPreludeSha256,
  });
  const commit = commitResult.stdout.trim();
  requireGitIdentity(commit, "repository commit");
  return {
    commit,
    hostInputsSha256,
    benchmarkInputsSha256,
    graphIdentity: startupSourceGraphIdentity(source, compilerPreludeSha256),
    compilerArtifactSha256: manifest.sha256,
    compilerManifestSha256: await sha256(manifestBytes),
    compilerInputsSha256: manifest.compilerInputsSha256,
    compilerPreludeSha256,
    compilerSourceCommit: manifest.sourceCommit,
    compilerSourceTree: manifest.sourceTree,
    compilerRustc: manifest.rustc,
    sourceBytes: Buffer.byteLength(source),
    environment: startupEnvironment(),
  };
}

function startupEnvironment(): CompilerStartupProvenance["environment"] {
  const processors = cpus();
  if (processors.length === 0) {
    throw new Error("compiler startup could not identify the host CPU");
  }
  const cpuModels = [...new Set(processors.map((processor) => processor.model))]
    .sort();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModels,
    logicalCpuCount: processors.length,
    nodeInvocationSha256: compilerStartupNodeInvocationSha256(
      process.env.NODE_OPTIONS,
    ),
  };
}

async function inputFilesIdentity(
  paths: readonly string[],
  requiredPaths: ReadonlySet<string> = new Set(),
): Promise<string> {
  const identity = createHash("sha256");
  for (const path of paths) {
    identity.update(`${path.length}:${path}:`);
    try {
      const bytes = await readFile(path);
      identity.update(`present:${bytes.byteLength}:`);
      identity.update(bytes);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (requiredPaths.has(path)) {
        throw new Error(`compiler startup requires host input ${path}`, {
          cause: error,
        });
      }
      identity.update("missing:");
    }
  }
  return identity.digest("hex");
}

function requireHash(value: string, evidence: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`compiler startup has an invalid ${evidence} identity`);
  }
}

function requireGitIdentity(value: string, evidence: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error(`compiler startup has an invalid ${evidence}`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
