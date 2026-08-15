import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadProgram } from "../src/compiler/frontend.ts";
import { encodePortableModule } from "../src/syntax/portable.ts";

const root = await loadProgram(resolve("examples/storage.blot"));
const dependency = [...root.dependencies][0];
if (dependency === undefined) {
  throw new Error("storage benchmark has no dependency");
}
const [specifier, loadedDependency] = dependency;

const dependencyPayload = JSON.stringify({
  path: loadedDependency.path,
  module: encodePortableModule(loadedDependency.module),
  dependencies: [],
  includedFiles: [],
});
const dependencyDigest = digest(dependencyPayload);
const rootModule = encodePortableModule(root.module);
const samples = 1_000;

const nested = measure(() =>
  JSON.stringify({
    path: root.path,
    module: rootModule,
    dependencies: [{ specifier, revision: dependencyPayload }],
    includedFiles: [],
  })
);
const hashed = measure(() =>
  digest(JSON.stringify({
    path: root.path,
    module: rootModule,
    dependencies: [{ specifier, revision: dependencyDigest }],
    includedFiles: [],
  }))
);

console.log(JSON.stringify({
  source: root.path,
  samples,
  milliseconds: {
    nested_serialized_key: nested.milliseconds,
    fixed_size_digest: hashed.milliseconds,
  },
  key_bytes: {
    nested_serialized_key: nested.value.length,
    fixed_size_digest: hashed.value.length,
    dependency_serialized_key: dependencyPayload.length,
    dependency_digest: dependencyDigest.length,
  },
}, null, 2));

function measure(operation: () => string): {
  readonly milliseconds: number;
  readonly value: string;
} {
  const started = performance.now();
  let value = "";
  for (let index = 0; index < samples; index += 1) value = operation();
  return {
    milliseconds: (performance.now() - started) / samples,
    value,
  };
}

function digest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
