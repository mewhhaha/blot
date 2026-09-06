import {
  type BlotAbiManifest,
  flattenedAbiType,
} from "../compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "../compiler/session.ts";
import {
  decodeManifest,
  formatValue,
  readDirect,
  readMemory,
  requiredFunction,
  requiredMemory,
  type RuntimeValue,
} from "../abi_values.ts";

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
  const instantiated = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const callable = requiredFunction(instantiated.instance, exported.name);
  const resultType = exported.function.result;
  const flattened = flattenedAbiType(resultType);
  const postReturn = exported.postReturn;
  const raw = callable();
  let value: RuntimeValue;
  if (flattened.length <= 1) value = readDirect(resultType, raw);
  else {
    if (postReturn === null) {
      throw new TypeError(`${exported.name} omitted its indirect post-return`);
    }
    if (typeof raw !== "number") {
      throw new TypeError(`${exported.name} did not return a result pointer`);
    }
    const memory = requiredMemory(instantiated.instance, manifest);
    try {
      value = readMemory(
        resultType,
        new DataView(memory.buffer),
        raw,
      );
    } finally {
      requiredFunction(instantiated.instance, postReturn)(raw);
    }
  }
  return formatValue(value);
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
    `run needs a default export when a module has several runtime exports: ${
      names.join(", ")
    }`,
  );
}
