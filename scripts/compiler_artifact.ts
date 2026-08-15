export const compilerArtifactSchema = "blot-rust-compiler-artifact";
export const compilerArtifactVersion = 1;

export interface CompilerArtifactManifest {
  readonly schema: typeof compilerArtifactSchema;
  readonly version: typeof compilerArtifactVersion;
  readonly file: "compiler.wasm";
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly rustc: string;
}

export async function describeCompilerArtifact(
  bytes: Uint8Array,
  sourceCommit: string,
  sourceTree: string,
  rustc: string,
): Promise<CompilerArtifactManifest> {
  requireWasm(bytes);
  requireGitIdentity(sourceCommit, "source commit");
  requireGitIdentity(sourceTree, "source tree");
  requireToolchain(rustc);
  return {
    schema: compilerArtifactSchema,
    version: compilerArtifactVersion,
    file: "compiler.wasm",
    bytes: bytes.byteLength,
    sha256: await sha256(bytes),
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
  requireHash(value.sha256, "artifact SHA-256");
  requireGitIdentity(value.sourceCommit, "source commit");
  requireGitIdentity(value.sourceTree, "source tree");
  requireToolchain(value.rustc);
  return value as unknown as CompilerArtifactManifest;
}

export async function validateCompilerArtifact(
  bytes: Uint8Array,
  manifest: CompilerArtifactManifest,
  expectedTree: string,
): Promise<void> {
  requireWasm(bytes);
  requireGitIdentity(expectedTree, "expected source tree");
  if (manifest.sourceTree !== expectedTree) {
    throw new Error(
      `compiler artifact belongs to source tree ${manifest.sourceTree}, not ${expectedTree}`,
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

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requireWasm(bytes: Uint8Array): void {
  const owned = Uint8Array.from(bytes);
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d ||
    !WebAssembly.validate(owned)
  ) {
    throw new Error("compiler artifact is not valid WebAssembly");
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
