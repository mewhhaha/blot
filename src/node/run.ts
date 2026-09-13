import { instantiateArtifact } from "../host.ts";
import type {
  BlotAbiManifest,
  BlotAbiType,
} from "../compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "../compiler/session.ts";
import {
  decodeManifest,
  formatValue,
  type RuntimeValue,
} from "../abi_values.ts";

export async function runArtifact(artifact: CompilerArtifact): Promise<string> {
  const observation = await observeArtifact(artifact);
  return formatValue(observation.value);
}

export async function observeArtifact(artifact: CompilerArtifact): Promise<{
  readonly type: BlotAbiType;
  readonly value: RuntimeValue;
}> {
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
  const hosted = await instantiateArtifact(artifact);
  try {
    return {
      type: exported.function.result,
      value: await hosted.callAsync(exported.sourceName),
    };
  } finally {
    await hosted.close();
  }
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
