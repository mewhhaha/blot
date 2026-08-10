import type {
  BlotAbiManifest,
  BlotAbiType,
} from "../conformance/gpufuck/runtime/abi.ts";
import type { CompilerArtifact } from "../compiler/session.ts";

export async function runArtifact(artifact: CompilerArtifact): Promise<string> {
  const manifest = decodeManifest(artifact.manifestBytes);
  const exported = selectExport(manifest);
  if (manifest.imports.length > 0) {
    const imports = manifest.imports.map((imported) =>
      `${imported.capability}.${imported.operation}`
    );
    throw new TypeError(
      `run cannot supply host operations: ${imports.join(", ")}`,
    );
  }
  if (exported.function === null || exported.name === null) {
    throw new TypeError("run selected an export without a runtime function");
  }
  if (exported.function.parameters.length > 0) {
    throw new TypeError(
      `run requires a zero-parameter export; ${exported.sourceName} takes ${exported.function.parameters.length}`,
    );
  }
  requireScalarResult(exported.function.result);
  const instantiated = await WebAssembly.instantiate(artifact.wasm);
  const value = instantiated.instance.exports[exported.name];
  if (typeof value !== "function") {
    throw new TypeError(`Wasm export ${exported.name} is not callable`);
  }
  return formatResult(exported.function.result, value());
}

function decodeManifest(bytes: Uint8Array): BlotAbiManifest {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("format" in decoded) ||
    decoded.format !== "blot-core-wasm"
  ) {
    throw new TypeError("compiled artifact has an invalid Blot ABI manifest");
  }
  return decoded as BlotAbiManifest;
}

function selectExport(manifest: BlotAbiManifest) {
  const runtime = manifest.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  const defaultExport = runtime.find((exported) =>
    exported.sourceName === "default"
  );
  if (defaultExport !== undefined) return defaultExport;
  if (runtime.length === 1) return runtime[0];
  if (runtime.length === 0) {
    throw new TypeError("run found no runtime export");
  }
  const names = runtime.map((exported) => exported.sourceName);
  throw new TypeError(
    `run needs a default export when a module has several runtime exports: ${names.join(", ")}`,
  );
}

function requireScalarResult(type: BlotAbiType): void {
  if (type.kind === "sealed") {
    requireScalarResult(type.inner);
    return;
  }
  if (
    type.kind === "unit" ||
    type.kind === "boolean" ||
    type.kind === "signed-integer-64" ||
    type.kind === "float-32" ||
    type.kind === "float-64"
  ) return;
  throw new TypeError(
    `run currently supports scalar results; the selected export returns ${type.kind}`,
  );
}

function formatResult(type: BlotAbiType, value: unknown): string {
  if (type.kind === "sealed") return formatResult(type.inner, value);
  if (type.kind === "unit") return "()";
  if (type.kind === "boolean") {
    if (value === 0) return "false";
    return "true";
  }
  return String(value);
}
