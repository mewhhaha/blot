import { createHash } from "node:crypto";
import { COMPILER_HOST_ABI_VERSION } from "./host_abi.ts";

export const compilerArtifactSchema = "blot-rust-compiler-artifact";
export const compilerArtifactVersion = 3;

export type CompilerArtifactProfile = "production" | "development-profile";

export interface CompilerArtifactManifest {
  readonly schema: typeof compilerArtifactSchema;
  readonly version: typeof compilerArtifactVersion;
  readonly file: "compiler.wasm";
  readonly bytes: number;
  readonly sha256: string;
  readonly hostAbi: number;
  readonly preludeSha256: string;
  readonly compilerInputsSha256: string;
  readonly profile: CompilerArtifactProfile;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly rustc: string;
}

export interface ExpectedCompilerArtifact {
  readonly hostAbi?: number;
  readonly preludeSha256?: string;
  readonly compilerInputsSha256?: string;
  readonly profile?: CompilerArtifactProfile;
}

export async function describeCompilerArtifact(
  bytes: Uint8Array,
  sourceCommit: string,
  sourceTree: string,
  rustc: string,
  preludeSha256: string,
  compilerInputsSha256: string,
  profile: CompilerArtifactProfile,
): Promise<CompilerArtifactManifest> {
  requireWasm(bytes);
  requireGitIdentity(sourceCommit, "source commit");
  requireGitIdentity(sourceTree, "source tree");
  requireToolchain(rustc);
  requireHash(preludeSha256, "prelude SHA-256");
  requireHash(compilerInputsSha256, "compiler-input SHA-256");
  return {
    schema: compilerArtifactSchema,
    version: compilerArtifactVersion,
    file: "compiler.wasm",
    bytes: bytes.byteLength,
    sha256: await sha256(bytes),
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256,
    compilerInputsSha256,
    profile,
    sourceCommit,
    sourceTree,
    rustc,
  };
}

export function decodeCompilerArtifactManifest(
  text: string,
): CompilerArtifactManifest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("compiler artifact manifest is not an object");
  }
  if (value.schema !== compilerArtifactSchema) {
    throw new Error("compiler artifact manifest has an unknown schema");
  }
  if (value.version !== compilerArtifactVersion) {
    throw new Error("compiler artifact manifest has an unknown version");
  }
  if (value.file !== "compiler.wasm") {
    throw new Error("compiler artifact manifest names an unexpected file");
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 8) {
    throw new Error("compiler artifact manifest has an invalid byte length");
  }
  if (!Number.isSafeInteger(value.hostAbi) || (value.hostAbi as number) < 1) {
    throw new Error("compiler artifact manifest has an invalid host ABI");
  }
  requireHash(value.sha256, "artifact SHA-256");
  requireHash(value.preludeSha256, "prelude SHA-256");
  requireHash(value.compilerInputsSha256, "compiler-input SHA-256");
  if (
    value.profile !== "production" && value.profile !== "development-profile"
  ) {
    throw new Error("compiler artifact manifest has an invalid build profile");
  }
  requireGitIdentity(value.sourceCommit, "source commit");
  requireGitIdentity(value.sourceTree, "source tree");
  requireToolchain(value.rustc);
  return value as unknown as CompilerArtifactManifest;
}

export async function validateCompilerArtifact(
  bytes: Uint8Array,
  manifest: CompilerArtifactManifest,
  expected: ExpectedCompilerArtifact,
): Promise<void> {
  requireWasm(bytes);
  await verifyCompilerArtifactIntegrity(bytes, manifest, expected);
}

export async function verifyCompilerArtifactIntegrity(
  bytes: Uint8Array,
  manifest: CompilerArtifactManifest,
  expected: ExpectedCompilerArtifact,
): Promise<void> {
  requireWasmHeader(bytes);
  if (expected.hostAbi !== undefined && manifest.hostAbi !== expected.hostAbi) {
    throw new Error(
      `compiler artifact host ABI is ${manifest.hostAbi}, expected ${expected.hostAbi}`,
    );
  }
  if (
    expected.preludeSha256 !== undefined &&
    manifest.preludeSha256 !== expected.preludeSha256
  ) {
    throw new Error("compiler artifact prelude does not match this checkout");
  }
  if (
    expected.compilerInputsSha256 !== undefined &&
    manifest.compilerInputsSha256 !== expected.compilerInputsSha256
  ) {
    throw new Error("compiler artifact inputs do not match this checkout");
  }
  if (expected.profile !== undefined && manifest.profile !== expected.profile) {
    throw new Error(
      `compiler artifact profile is ${manifest.profile}, expected ${expected.profile}`,
    );
  }
  if (manifest.bytes !== bytes.byteLength) {
    throw new Error(
      `compiler artifact has ${bytes.byteLength} bytes, expected ${manifest.bytes}`,
    );
  }
  const digest = await sha256(bytes);
  if (manifest.sha256 !== digest) {
    throw new Error(
      `compiler artifact SHA-256 is ${digest}, expected ${manifest.sha256}`,
    );
  }
}

export function sha256(bytes: Uint8Array): Promise<string> {
  return Promise.resolve(createHash("sha256").update(bytes).digest("hex"));
}

function requireWasm(bytes: Uint8Array): void {
  requireWasmHeader(bytes);
  if (!WebAssembly.validate(Uint8Array.from(bytes))) {
    throw new Error("compiler artifact is not valid WebAssembly");
  }
}

function requireWasmHeader(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new Error("compiler artifact has no WebAssembly header");
  }
}

function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`compiler artifact manifest has an invalid ${label}`);
  }
}

function requireGitIdentity(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error(`compiler artifact manifest has an invalid ${label}`);
  }
}

function requireToolchain(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !/^rustc [0-9]+\.[0-9]+\.[0-9]+/.test(value)
  ) {
    throw new Error("compiler artifact manifest has an invalid Rust toolchain");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
