import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";
import type { Loaded } from "../../src/load.ts";
import { encodePortableModule } from "../../src/syntax/portable.ts";
import type { CompilerBenchmarkEnvironment } from "./schema.ts";

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

export async function hostInputsIdentity(): Promise<string> {
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
    throw new Error("compiler benchmark host-input set is empty");
  }
  if (!paths.includes(".pnp.cjs")) paths.push(".pnp.cjs");
  paths.sort();
  const identity = createHash("sha256");
  for (const path of paths) {
    identity.update(`${path.length}:${path}:`);
    try {
      const bytes = await readFile(path);
      identity.update(`present:${bytes.byteLength}:`);
      identity.update(bytes);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (path === ".pnp.cjs") {
        throw new Error(
          "compiler benchmark requires the generated .pnp.cjs loader",
          { cause: error },
        );
      }
      identity.update("missing:");
    }
  }
  return identity.digest("hex");
}

export function benchmarkEnvironment(): CompilerBenchmarkEnvironment {
  const processors = cpus();
  if (processors.length === 0) {
    throw new Error("compiler benchmark could not identify the host CPU");
  }
  const cpuModels = [...new Set(processors.map((processor) => processor.model))]
    .sort();
  let nodeOptions: string | null = null;
  if (process.env.NODE_OPTIONS !== undefined) {
    nodeOptions = stableInvocation(process.env.NODE_OPTIONS);
  }
  const nodeInvocationSha256 = createHash("sha256").update(JSON.stringify({
    execArgv: process.execArgv.map(stableInvocation),
    nodeOptions,
  })).digest("hex");
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModels,
    logicalCpuCount: processors.length,
    nodeInvocationSha256,
  };
}

export async function benchmarkInputsIdentity(): Promise<string> {
  const paths = [
    "experiments/compiler-bench/benchmark.ts",
    "experiments/compiler-bench/cold_process.ts",
    "experiments/compiler-bench/compare.ts",
    "experiments/compiler-bench/comparison.ts",
    "experiments/compiler-bench/observation.ts",
    "experiments/compiler-bench/provenance.ts",
    "experiments/compiler-bench/schema.ts",
    "experiments/compiler-bench/suite.ts",
    "experiments/compiler-bench/suite_schema.ts",
  ];
  const identity = createHash("sha256");
  for (const path of paths) {
    const bytes = await readFile(path);
    identity.update(`${path.length}:${path}${bytes.byteLength}:`);
    identity.update(bytes);
  }
  return identity.digest("hex");
}

export function workloadGraphIdentity(root: Loaded): string {
  const visiting = new Set<Loaded>();
  const moduleIds = new Map<Loaded, number>();
  const encode = (loaded: Loaded): unknown => {
    if (visiting.has(loaded)) {
      throw new Error(
        `benchmark workload graph contains a cycle at ${loaded.path}`,
      );
    }
    const existing = moduleIds.get(loaded);
    if (existing !== undefined) return { reference: existing };
    const id = moduleIds.size;
    moduleIds.set(loaded, id);
    visiting.add(loaded);
    const dependencies = [...loaded.dependencies]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([specifier, dependency]) => ({
        specifier,
        module: encode(dependency),
      }));
    const includedFiles = [...loaded.includedFiles]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([specifier, included]) => {
        let path = included.path.replaceAll("\\", "/");
        if (loaded.storage.tag !== "capsule") {
          path = relative(dirname(loaded.path), included.path).replaceAll(
            "\\",
            "/",
          );
          if (!path.startsWith(".")) path = `./${path}`;
        }
        return {
          specifier,
          path,
          source: included.source,
        };
      });
    let module: unknown = loaded.source;
    if (loaded.storage.tag !== "source") {
      module = encodePortableModule(loaded.module);
    }
    visiting.delete(loaded);
    return { id, module, dependencies, includedFiles };
  };
  return createHash("sha256").update(JSON.stringify(encode(root))).digest(
    "hex",
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stableInvocation(value: string): string {
  return value.replaceAll(process.cwd(), "$repository");
}
