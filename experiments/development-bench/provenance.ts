import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { dirname } from "node:path";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "../../src/compiler/artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../../src/compiler/host_abi.ts";
import type {
  DevelopmentBenchmarkCompilerProfile,
  DevelopmentBenchmarkProvenance,
} from "./schema.ts";

const measuredHostRuntimePaths = [
  "generated/wasm/parser.plan",
  "generated/wasm/parser.wasm",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "deno.json",
] as const;
const provenanceFields = [
  "commit",
  "hostInputsSha256",
  "benchmarkInputsSha256",
  "compilerArtifactSha256",
  "compilerManifestSha256",
  "compilerInputsSha256",
  "compilerPreludeSha256",
  "compilerSourceCommit",
  "compilerSourceTree",
  "compilerRustc",
  "compilerProfile",
  "environment",
] satisfies readonly (keyof DevelopmentBenchmarkProvenance)[];

export interface DevelopmentBenchmarkCompilerPaths {
  readonly artifact: string;
  readonly manifest: string;
  readonly prelude: string;
}

export interface DevelopmentBenchmarkProvenanceCapture {
  readonly provenance: DevelopmentBenchmarkProvenance;
  readonly compilerOptions: {
    readonly wasm: Uint8Array;
    readonly preludeSnapshot: Uint8Array;
  };
}

export type DevelopmentBenchmarkIdentityInput =
  | {
    readonly path: string;
    readonly kind: "file";
    readonly executable: boolean;
    readonly bytes: Uint8Array;
  }
  | {
    readonly path: string;
    readonly kind: "symlink";
    readonly target: string;
  }
  | {
    readonly path: string;
    readonly kind: "missing";
  };

export function developmentBenchmarkCompilerPaths(
  profile: DevelopmentBenchmarkCompilerProfile,
): DevelopmentBenchmarkCompilerPaths {
  let root = "generated/compiler";
  if (profile === "development-profile") {
    root = "compiler/target/development-profile";
  }
  return {
    artifact: `${root}/compiler.wasm`,
    manifest: `${root}/compiler-artifact.json`,
    prelude: `${root}/prelude.snapshot`,
  };
}

export async function captureDevelopmentBenchmarkProvenance(
  profile: DevelopmentBenchmarkCompilerProfile,
): Promise<DevelopmentBenchmarkProvenanceCapture> {
  const compilerPaths = developmentBenchmarkCompilerPaths(profile);
  const [
    compilerBytes,
    manifestBytes,
    preludeBytes,
    commit,
    repositoryInputs,
    benchmarkHostInputs,
    invocationArguments,
    denoExecutableBytes,
  ] = await Promise.all([
    Deno.readFile(compilerPaths.artifact),
    Deno.readFile(compilerPaths.manifest),
    Deno.readFile(compilerPaths.prelude),
    gitText(["rev-parse", "HEAD"]),
    repositoryIdentityInputs(),
    measuredHostIdentityInputs(compilerPaths),
    currentDenoInvocationArguments(),
    Deno.readFile(Deno.execPath()),
  ]);
  requireGitIdentity(commit, "repository commit");
  const manifest = decodeCompilerArtifactManifest(
    new TextDecoder().decode(manifestBytes),
  );
  const compilerPreludeSha256 = await sha256(preludeBytes);
  await validateCompilerArtifact(compilerBytes, manifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: compilerPreludeSha256,
    profile,
  });
  const denoExecutableSha256 = await sha256(denoExecutableBytes);
  const processors = cpus();
  if (processors.length === 0) {
    throw new Error("development benchmark could not identify the host CPU");
  }
  const cpuModels = [...new Set(processors.map((processor) => processor.model))]
    .sort();
  return {
    provenance: {
      commit,
      hostInputsSha256: developmentBenchmarkInputIdentity(
        commit,
        repositoryInputs,
      ),
      benchmarkInputsSha256: developmentBenchmarkInputIdentity(
        commit,
        benchmarkHostInputs,
      ),
      compilerArtifactSha256: manifest.sha256,
      compilerManifestSha256: await sha256(manifestBytes),
      compilerInputsSha256: manifest.compilerInputsSha256,
      compilerPreludeSha256,
      compilerSourceCommit: manifest.sourceCommit,
      compilerSourceTree: manifest.sourceTree,
      compilerRustc: manifest.rustc,
      compilerProfile: manifest.profile,
      environment: {
        os: Deno.build.os,
        architecture: Deno.build.arch,
        cpuModels,
        logicalCpuCount: processors.length,
        deno: Deno.version.deno,
        v8: Deno.version.v8,
        denoExecutableSha256,
        denoInvocationSha256: developmentBenchmarkDenoInvocationIdentity({
          arguments: invocationArguments,
          executableSha256: denoExecutableSha256,
          mainModule: Deno.mainModule,
          repositoryPath: Deno.cwd(),
        }),
      },
    },
    compilerOptions: {
      wasm: compilerBytes,
      preludeSnapshot: preludeBytes,
    },
  };
}

export function requireStableDevelopmentBenchmarkProvenance(
  initial: DevelopmentBenchmarkProvenance,
  final: DevelopmentBenchmarkProvenance,
): void {
  const changed = provenanceFields.filter((name) =>
    JSON.stringify(initial[name]) !== JSON.stringify(final[name])
  );
  if (changed.length === 0) return;
  throw new Error(
    `development benchmark inputs changed while samples were running: ${
      changed.join(", ")
    }`,
  );
}

export function developmentBenchmarkInputIdentity(
  commit: string,
  inputs: readonly DevelopmentBenchmarkIdentityInput[],
): string {
  requireGitIdentity(commit, "repository commit");
  const sorted = [...inputs].sort(compareIdentityInputs);
  const identity = createHash("sha256");
  identity.update(`development-benchmark-inputs:1:${commit.length}:${commit}:`);
  let previousPath: string | null = null;
  for (const input of sorted) {
    if (input.path.length === 0) {
      throw new Error("development benchmark input path is empty");
    }
    if (input.path === previousPath) {
      throw new Error(
        `development benchmark input path ${
          JSON.stringify(input.path)
        } repeats`,
      );
    }
    previousPath = input.path;
    identity.update(`${input.path.length}:${input.path}:${input.kind}:`);
    if (input.kind === "missing") continue;
    if (input.kind === "symlink") {
      identity.update(`${input.target.length}:${input.target}:`);
      continue;
    }
    let executableIdentity = "non-executable:";
    if (input.executable) executableIdentity = "executable:";
    identity.update(executableIdentity);
    identity.update(`${input.bytes.byteLength}:`);
    identity.update(input.bytes);
  }
  return identity.digest("hex");
}

export function developmentBenchmarkDenoInvocationIdentity(invocation: {
  readonly arguments: readonly string[];
  readonly executableSha256: string;
  readonly mainModule: string;
  readonly repositoryPath: string;
}): string {
  requireHash(invocation.executableSha256, "Deno executable");
  if (invocation.arguments.length === 0) {
    throw new Error("development benchmark Deno invocation has no arguments");
  }
  const stableArguments = invocation.arguments.map((argument) =>
    stableInvocation(argument, invocation.repositoryPath)
  );
  return createHash("sha256").update(JSON.stringify({
    schema: 1,
    arguments: stableArguments,
    executableSha256: invocation.executableSha256,
    mainModule: stableInvocation(
      invocation.mainModule,
      invocation.repositoryPath,
    ),
  })).digest("hex");
}

export function decodeNullTerminatedArguments(
  bytes: Uint8Array,
): readonly string[] {
  const arguments_ = decodeNullTerminatedStrings(bytes, "process command line");
  if (arguments_[0].length === 0) {
    throw new Error(
      "development benchmark process command line has no executable",
    );
  }
  return arguments_;
}

export function developmentBenchmarkModulePaths(
  value: unknown,
  repositoryPath: string,
): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.modules)) {
    throw new Error(
      "development benchmark Deno module graph is not an object with modules",
    );
  }
  const repositoryPrefix = `${repositoryPath}/`;
  const paths: string[] = [];
  for (let index = 0; index < value.modules.length; index += 1) {
    const module = value.modules[index];
    if (!isRecord(module) || typeof module.specifier !== "string") {
      throw new Error(
        `development benchmark Deno module graph entry ${index} has no specifier`,
      );
    }
    if (module.specifier.startsWith("node:")) continue;
    let url: URL;
    try {
      url = new URL(module.specifier);
    } catch (error) {
      throw new Error(
        `development benchmark Deno module ${
          JSON.stringify(module.specifier)
        } is not a URL`,
        { cause: error },
      );
    }
    if (url.protocol !== "file:") {
      throw new Error(
        `development benchmark Deno module ${
          JSON.stringify(module.specifier)
        } is not local`,
      );
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch (error) {
      throw new Error(
        `development benchmark Deno module path ${
          JSON.stringify(url.pathname)
        } is not valid percent-encoded UTF-8`,
        { cause: error },
      );
    }
    if (!path.startsWith(repositoryPrefix)) {
      throw new Error(
        `development benchmark Deno module ${
          JSON.stringify(path)
        } is outside repository ${JSON.stringify(repositoryPath)}`,
      );
    }
    paths.push(path.slice(repositoryPrefix.length));
  }
  return [...new Set(paths)].sort();
}

function decodeNullTerminatedStrings(
  bytes: Uint8Array,
  evidence: string,
): readonly string[] {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0) {
    throw new Error(
      `development benchmark ${evidence} is not null-terminated`,
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const arguments_: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    arguments_.push(decoder.decode(bytes.subarray(start, index)));
    start = index + 1;
  }
  return arguments_;
}

async function repositoryIdentityInputs(): Promise<
  readonly DevelopmentBenchmarkIdentityInput[]
> {
  const arguments_ = [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
  ];
  const output = await gitBytes(arguments_);
  if (output.byteLength === 0) {
    throw new Error("development benchmark repository input set is empty");
  }
  const paths = [...decodeNullTerminatedStrings(output, "Git path list")]
    .sort();
  return await Promise.all(paths.map(readIdentityInput));
}

async function measuredHostIdentityInputs(
  compilerPaths: DevelopmentBenchmarkCompilerPaths,
): Promise<
  readonly DevelopmentBenchmarkIdentityInput[]
> {
  const graph = await new Deno.Command(Deno.execPath(), {
    args: [
      "info",
      "--json",
      "--no-remote",
      "--frozen=true",
      "experiments/development-bench/benchmark.ts",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!graph.success) {
    const stderr = new TextDecoder().decode(graph.stderr).trim();
    throw new Error(
      `development benchmark could not resolve its Deno module graph: deno info exited ${graph.code}: ${stderr}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(graph.stdout));
  } catch (error) {
    throw new Error("development benchmark Deno module graph is not JSON", {
      cause: error,
    });
  }
  const paths = new Set([
    ...developmentBenchmarkModulePaths(value, Deno.cwd()),
    ...measuredHostRuntimePaths,
    compilerPaths.artifact,
    compilerPaths.manifest,
    compilerPaths.prelude,
  ]);
  for (const packagePath of await installedPackagePaths([...paths])) {
    paths.add(packagePath);
  }
  return await Promise.all([...paths].sort().map(readIdentityInput));
}

async function installedPackagePaths(
  modulePaths: readonly string[],
): Promise<readonly string[]> {
  const packageRoots = new Set<string>();
  for (const path of modulePaths) {
    if (!path.startsWith("node_modules/")) continue;
    packageRoots.add(await installedPackageRoot(path));
  }
  const paths: string[] = [];
  for (const root of [...packageRoots].sort()) {
    await collectDirectoryPaths(root, paths);
  }
  return paths;
}

async function installedPackageRoot(path: string): Promise<string> {
  let candidate = dirname(path);
  while (candidate.startsWith("node_modules/")) {
    const manifestPath = `${candidate}/package.json`;
    try {
      const manifest = await Deno.lstat(manifestPath);
      if (manifest.isFile) return candidate;
      throw new Error(
        `development benchmark installed package manifest ${
          JSON.stringify(manifestPath)
        } is not a file`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(
    `development benchmark could not locate the installed package containing ${
      JSON.stringify(path)
    }`,
  );
}

async function collectDirectoryPaths(
  directory: string,
  paths: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      await collectDirectoryPaths(path, paths);
    } else {
      paths.push(path);
    }
  }
}

async function readIdentityInput(
  path: string,
): Promise<DevelopmentBenchmarkIdentityInput> {
  let file: Deno.FileInfo;
  try {
    file = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { path, kind: "missing" };
    throw error;
  }
  if (file.isSymlink) {
    return { path, kind: "symlink", target: await Deno.readLink(path) };
  }
  if (!file.isFile) {
    throw new Error(
      `development benchmark input ${JSON.stringify(path)} is not a file`,
    );
  }
  let executable = false;
  if (file.mode !== null) executable = (file.mode & 0o111) !== 0;
  return {
    path,
    kind: "file",
    executable,
    bytes: await Deno.readFile(path),
  };
}

async function currentDenoInvocationArguments(): Promise<readonly string[]> {
  if (Deno.build.os !== "linux") {
    throw new Error(
      `development benchmark requires Linux procfs to attest the exact Deno invocation, received ${Deno.build.os}`,
    );
  }
  try {
    const commandLine = await new Deno.Command("cat", {
      args: [`/proc/${Deno.pid}/cmdline`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!commandLine.success) {
      const stderr = new TextDecoder().decode(commandLine.stderr).trim();
      throw new Error(`cat exited ${commandLine.code}: ${stderr}`);
    }
    return decodeNullTerminatedArguments(
      commandLine.stdout,
    );
  } catch (error) {
    throw new Error(
      "development benchmark could not read its exact Deno invocation from /proc/self/cmdline",
      { cause: error },
    );
  }
}

async function gitText(arguments_: readonly string[]): Promise<string> {
  return new TextDecoder().decode(await gitBytes(arguments_)).trim();
}

async function gitBytes(arguments_: readonly string[]): Promise<Uint8Array> {
  const output = await new Deno.Command("git", {
    args: [...arguments_],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `git ${arguments_.join(" ")} exited ${output.code}: ${stderr}`,
    );
  }
  return output.stdout;
}

function stableInvocation(value: string, repositoryPath: string): string {
  if (repositoryPath.length === 0) {
    throw new Error("development benchmark repository path is empty");
  }
  return value.replaceAll(repositoryPath, "$repository");
}

function compareIdentityInputs(
  left: DevelopmentBenchmarkIdentityInput,
  right: DevelopmentBenchmarkIdentityInput,
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function requireHash(value: string, evidence: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `development benchmark has an invalid ${evidence} identity`,
    );
  }
}

function requireGitIdentity(value: string, evidence: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error(`development benchmark has an invalid ${evidence}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
