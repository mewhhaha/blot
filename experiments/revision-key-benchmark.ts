import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadProgram, type Loaded } from "../src/compiler/frontend.ts";
import { encodePortableModule } from "../src/syntax/portable.ts";

const root = await loadProgram(resolve("examples/storage.blot"));
const dependency = [...root.dependencies][0];
if (dependency === undefined) {
  throw new Error("storage benchmark has no dependency");
}
const [specifier, loadedDependency] = dependency;

const dependencyPayload = nestedRevisionKey(loadedDependency, new WeakMap());
const dependencyDigest = digestRevisionKey(loadedDependency, new WeakMap());
const rootModule = encodePortableModule(root.module);
const coldSamples = 100;
const residentSamples = 1_000;

const nestedCold = measure(coldSamples, () =>
  nestedRevisionKey(root, new WeakMap())
);
const hashedCold = measure(coldSamples, () =>
  digestRevisionKey(root, new WeakMap())
);
const nestedResident = measure(residentSamples, () =>
  JSON.stringify({
    path: root.path,
    module: rootModule,
    dependencies: [{ specifier, revision: dependencyPayload }],
    includedFiles: includedFiles(root),
  })
);
const hashedResident = measure(residentSamples, () =>
  digest(JSON.stringify({
    path: root.path,
    module: rootModule,
    dependencies: [{ specifier, revision: dependencyDigest }],
    includedFiles: includedFiles(root),
  }))
);

console.log(JSON.stringify({
  source: root.path,
  samples: { cold_graph: coldSamples, resident_root: residentSamples },
  milliseconds: {
    cold_graph: {
      nested_serialized_key: nestedCold.milliseconds,
      fixed_size_digest: hashedCold.milliseconds,
    },
    resident_root_after_dependency_keyed: {
      nested_serialized_key: nestedResident.milliseconds,
      fixed_size_digest: hashedResident.milliseconds,
    },
  },
  key_bytes: {
    nested_serialized_key: nestedResident.value.length,
    fixed_size_digest: hashedResident.value.length,
    dependency_serialized_key: dependencyPayload.length,
    dependency_digest: dependencyDigest.length,
  },
}, null, 2));

function nestedRevisionKey(
  loaded: Loaded,
  cache: WeakMap<Loaded, string>,
): string {
  const cached = cache.get(loaded);
  if (cached !== undefined) return cached;
  const key = JSON.stringify({
    path: loaded.path,
    module: encodePortableModule(loaded.module),
    dependencies: [...loaded.dependencies].map(([name, child]) => ({
      specifier: name,
      revision: nestedRevisionKey(child, cache),
    })),
    includedFiles: includedFiles(loaded),
  });
  cache.set(loaded, key);
  return key;
}

function digestRevisionKey(
  loaded: Loaded,
  cache: WeakMap<Loaded, string>,
): string {
  const cached = cache.get(loaded);
  if (cached !== undefined) return cached;
  const key = digest(JSON.stringify({
    path: loaded.path,
    module: encodePortableModule(loaded.module),
    dependencies: [...loaded.dependencies].map(([name, child]) => ({
      specifier: name,
      revision: digestRevisionKey(child, cache),
    })),
    includedFiles: includedFiles(loaded),
  }));
  cache.set(loaded, key);
  return key;
}

function includedFiles(loaded: Loaded): readonly {
  readonly specifier: string;
  readonly path: string;
  readonly source: string;
}[] {
  return [...loaded.includedFiles].map(([specifier, included]) => ({
    specifier,
    path: included.path,
    source: included.source,
  }));
}

function measure(samples: number, operation: () => string): {
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
