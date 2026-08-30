import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { BlotAbiManifest } from "./compiler/backend/runtime/abi.ts";
import { type DevelopmentBuild, DevelopmentProject } from "./development.ts";
import { developmentRevision } from "./development_identity.ts";
import { DevelopmentRuntime } from "./development_runtime.ts";

Deno.test("development revisions canonicalize order and cover every identity field", async () => {
  const units = [
    {
      name: "game",
      interfaceDigest: "game-interface",
      implementationDigest: "game-implementation",
      wasmDigest: "game-wasm",
    },
    {
      name: "simulation",
      interfaceDigest: "simulation-interface",
      implementationDigest: "simulation-implementation",
      wasmDigest: "simulation-wasm",
    },
  ];
  const revision = await developmentRevision("game", units);
  assertEquals(
    await developmentRevision("game", [...units].reverse()),
    revision,
  );
  assertNotEquals(await developmentRevision("simulation", units), revision);
  for (
    const field of [
      "name",
      "interfaceDigest",
      "implementationDigest",
      "wasmDigest",
    ] as const
  ) {
    const changed = units.map((unit, index) => {
      if (index !== 0) return unit;
      return { ...unit, [field]: `${unit[field]}-changed` };
    });
    assertNotEquals(
      await developmentRevision("game", changed),
      revision,
    );
  }
});

Deno.test("returning to an evicted implementation still replaces the unit", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  const sourcePath = join(directory, "main.blot");
  await Deno.writeTextFile(sourcePath, "return 1\n");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );
  const project = await DevelopmentProject.create(manifestPath);
  try {
    const initial = await project.prepareBuild();
    project.commitBuild(initial);
    await Deno.writeTextFile(sourcePath, "return 2\n");
    await project.markChanged(sourcePath);
    const intermediate = await project.prepareBuild();
    project.commitBuild(intermediate);
    await Deno.writeTextFile(sourcePath, "return 1\n");
    await project.markChanged(sourcePath);
    const reverted = await project.prepareBuild();
    project.commitBuild(reverted);

    assertEquals(initial.changedUnits.length, 1);
    assertEquals(intermediate.changedUnits.length, 1);
    assertEquals(reverted.changedUnits.length, 1);
    assertEquals(reverted.retainedUnits, []);
    const initialUnit = initial.changedUnits[0];
    const revertedUnit = reverted.changedUnits[0];
    if (initialUnit === undefined || revertedUnit === undefined) {
      throw new Error("reverted implementation was classified as retained");
    }
    assertEquals(
      revertedUnit.implementationDigest,
      initialUnit.implementationDigest,
    );
    assertEquals(revertedUnit.interfaceDigest, initialUnit.interfaceDigest);
    assertEquals(revertedUnit.wasmDigest, initialUnit.wasmDigest);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development builds reload an edited provider without replacing its consumer", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  const providerPath = join(directory, "codec.blot");
  const providerSource = (extraSeed: string): string =>
    `open import "blot:prelude"
let expand = fn request => {
  .choice = request.choice;
  .label = request.label;
  .values = [...request.values, request.seed${extraSeed}];
}
return { .expand = expand; }
`;
  await Deno.writeTextFile(providerPath, providerSource(""));
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const codec = import "./codec.blot"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
let values = [value, value + 1]
let response = codec.expand {
  .choice = #Some (value + 2);
  .label = "oak";
  .seed = value + 3;
  .values = values;
}
let first = case Array.get (response.values, 0) of
  #Some found => found
  #None => 0
let third = case Array.get (response.values, 2) of
  #Some found => found
  #None => 0
let chosen = case response.choice of
  #Some found => found
  #None => 0
let unchanged = case Array.get (values, 2) of
  #Some _ => 0
  #None => 100
return
  first + third + chosen + @text.len response.label + unchanged +
  Array.length response.values
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: {
        game: "./main.blot",
        codec: "./codec.blot",
      },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  const runtime = new DevelopmentRuntime(() => ({
    "blot:host/Source": { value: () => 10n },
  }));
  try {
    const initial = await project.activate(runtime);
    assertEquals(initial.changedUnits.map((unit) => unit.name).sort(), [
      "codec",
      "game",
    ]);
    const entry = runtime.entryInstance;
    const provider = runtime.unitInstance("codec");
    assertEquals(run(entry), 141n);

    let forgedImportCalls = 0;
    const forgedRuntime = new DevelopmentRuntime(() => {
      forgedImportCalls += 1;
      return { "blot:host/Source": { value: () => 10n } };
    });
    await assertRejects(
      () => forgedRuntime.prepareActivation({ ...initial, edges: [] }),
      Error,
      "declares edges",
    );
    assertEquals(forgedImportCalls, 0);

    const gameArtifact = initial.changedUnits.find((unit) =>
      unit.name === "game"
    );
    if (gameArtifact === undefined) {
      throw new Error("initial development build omitted game");
    }
    const missingProviderRevision = await developmentRevision(
      initial.entryUnit,
      [gameArtifact],
    );
    await assertRejects(
      () =>
        runtime.prepareActivation({
          ...initial,
          baseRevision: initial.revision,
          revision: missingProviderRevision,
          changedUnits: [],
          retainedUnits: [{
            name: gameArtifact.name,
            interfaceDigest: gameArtifact.interfaceDigest,
            implementationDigest: gameArtifact.implementationDigest,
            wasmDigest: gameArtifact.wasmDigest,
          }],
          removedUnits: ["codec"],
          edges: [],
        }),
      Error,
      'to inactive provider "codec"',
    );
    assertStrictEquals(runtime.entryInstance, entry);
    assertStrictEquals(runtime.unitInstance("codec"), provider);
    assertEquals(runtime.revision, initial.revision);

    await Deno.writeTextFile(providerPath, providerSource(", request.seed"));
    await project.markChanged(providerPath);
    const edited = await project.prepareBuild();
    assertEquals(edited.changedUnits.map((unit) => unit.name), ["codec"]);
    assertEquals(edited.retainedUnits.map((unit) => unit.name), ["game"]);
    await assertRejects(
      () =>
        runtime.prepareActivation({
          ...edited,
          revision: initial.revision,
        }),
      Error,
      "has canonical revision",
    );
    const activation = await runtime.prepareActivation(edited);

    assertStrictEquals(runtime.entryInstance, entry);
    assertStrictEquals(runtime.unitInstance("codec"), provider);
    assertEquals(runtime.revision, initial.revision);

    project.commitBuild(edited);
    runtime.commitActivation(activation);

    assertStrictEquals(runtime.entryInstance, entry);
    assertNotEquals(runtime.unitInstance("codec"), provider);
    assertEquals(run(runtime.entryInstance), 142n);

    const unchanged = await project.prepareBuild();
    assertEquals(unchanged.changedUnits, []);
    assertEquals(
      unchanged.retainedUnits.map((unit) => unit.name).sort(),
      ["codec", "game"],
    );
    project.commitBuild(unchanged);

    const activeRevision = runtime.revision;
    await assertRejects(
      () =>
        runtime.prepareActivation({
          ...unchanged,
          revision: "invalid",
          changedUnits: [],
          retainedUnits: unchanged.retainedUnits.filter((unit) =>
            unit.name === "codec"
          ),
          removedUnits: ["game"],
          edges: [],
        }),
      Error,
      "omitted entry unit",
    );
    await assertRejects(
      () => runtime.prepareActivation(initial),
      Error,
      "starts from revision undefined",
    );
    assertStrictEquals(runtime.entryInstance, entry);
    assertEquals(runtime.revision, activeRevision);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser and desktop engine projects prepare reloadable frame units", async () => {
  for (const manifestName of ["browser.blot.json", "desktop.blot.json"]) {
    const manifestPath = fromFileUrl(
      new URL(`../case-studies/engine/${manifestName}`, import.meta.url),
    );
    const project = await DevelopmentProject.create(manifestPath);
    try {
      const initial = await project.prepareBuild();
      assertEquals(initial.changedUnits.length, 2);
      assertEquals(initial.edges.length, 1);
      assertEquals(initial.edges[0].provider, "frame");
      project.commitBuild(initial);

      const repeated = await project.prepareBuild();
      assertEquals(repeated.changedUnits, []);
      assertEquals(repeated.retainedUnits.length, 2);
      project.commitBuild(repeated);
    } finally {
      project.destroy();
    }
  }
});

Deno.test("a changed development interface rebuilds its consumer", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  const providerPath = join(directory, "provider.blot");
  const providerSource = (label: string): string =>
    `open import "blot:prelude"
let describe = fn value => { .value = value;${label} }
return { .describe = describe; }
`;
  await Deno.writeTextFile(providerPath, providerSource(""));
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const provider = import "./provider.blot"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return (provider.describe value).value
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: {
        game: "./main.blot",
        provider: "./provider.blot",
      },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  try {
    const initial = await project.prepareBuild();
    const provider = initial.changedUnits.find((unit) =>
      unit.name === "provider"
    );
    if (provider === undefined) {
      throw new Error("initial development build omitted provider");
    }
    project.commitBuild(initial);

    await Deno.writeTextFile(
      providerPath,
      providerSource(' .label = "changed";'),
    );
    await project.markChanged(providerPath);
    const edited = await project.prepareBuild();

    assertEquals(
      edited.changedUnits.map((unit) => unit.name).sort(),
      ["game", "provider"],
    );
    assertEquals(edited.retainedUnits, []);
    const editedProvider = edited.changedUnits.find((unit) =>
      unit.name === "provider"
    );
    if (editedProvider === undefined) {
      throw new Error("edited development build omitted provider");
    }
    assertNotEquals(
      editedProvider.interfaceDigest,
      provider.interfaceDigest,
    );
    project.commitBuild(edited);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development activation rejects mismatched artifact identities", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return value
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  try {
    const build = await project.prepareBuild();
    const artifact = build.changedUnits[0];
    if (artifact === undefined) {
      throw new Error("initial development build omitted game");
    }
    const mismatchedWasmRuntime = new DevelopmentRuntime();
    await assertRejects(
      () =>
        mismatchedWasmRuntime.prepareActivation({
          ...build,
          revision: "mismatched-wasm",
          changedUnits: [{ ...artifact, wasmDigest: "0".repeat(64) }],
        }),
      Error,
      "Wasm digest",
    );
    const missingWasmIdentityRuntime = new DevelopmentRuntime();
    await assertRejects(
      () =>
        missingWasmIdentityRuntime.prepareActivation({
          ...build,
          revision: "missing-wasm-identity",
          changedUnits: [{ ...artifact, wasmDigest: "" }],
        }),
      TypeError,
      'Wasm digest for changed unit "game" must be non-empty text',
    );
    const retainedIdentityRuntime = new DevelopmentRuntime(() => ({
      "blot:host/Source": { value: () => 0n },
    }));
    const initialActivation = await retainedIdentityRuntime.prepareActivation(
      build,
    );
    project.commitBuild(build);
    retainedIdentityRuntime.commitActivation(initialActivation);
    const retained = await project.prepareBuild();
    const retainedUnit = retained.retainedUnits[0];
    if (retainedUnit === undefined) {
      throw new Error("repeated development build did not retain game");
    }
    await assertRejects(
      () =>
        retainedIdentityRuntime.prepareActivation({
          ...retained,
          revision: "missing-retained-wasm-identity",
          retainedUnits: [{ ...retainedUnit, wasmDigest: "" }],
        }),
      TypeError,
      'Wasm digest for retained unit "game" must be non-empty text',
    );
    project.abortBuild(retained);
    const manifestText = new TextDecoder().decode(artifact.manifestBytes);
    const malformedBytes = new TextEncoder().encode(
      manifestText.replace('"signed-integer-64"', '"unsupported"'),
    );
    const malformedRuntime = new DevelopmentRuntime();
    await assertRejects(
      () =>
        malformedRuntime.prepareActivation({
          ...build,
          revision: "malformed",
          changedUnits: [{ ...artifact, manifestBytes: malformedBytes }],
        }),
      TypeError,
      "kind is unsupported",
    );

    const mismatchedBytes = new TextEncoder().encode(
      manifestText.replace("{", '{\n  "tampered": true,'),
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", mismatchedBytes),
    );
    const interfaceDigest = [...digest]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const mismatchedRuntime = new DevelopmentRuntime();
    await assertRejects(
      () =>
        mismatchedRuntime.prepareActivation({
          ...build,
          revision: "mismatched",
          changedUnits: [{
            ...artifact,
            manifestBytes: mismatchedBytes,
            interfaceDigest,
          }],
        }),
      Error,
      "sidecar and embedded ABI manifests differ",
    );
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("activation rejects provider Wasm exports that contradict the manifest before imports", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    join(directory, "codec.blot"),
    `open import "blot:prelude"
let reflect = fn value => value
let increment = fn value => value + 1
return { .increment = increment; .reflect = reflect; }
`,
  );
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const codec = import "./codec.blot"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
let reflected = codec.reflect { .label = "oak"; .value = value; }
return codec.increment reflected.value + @text.len reflected.label
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: {
        game: "./main.blot",
        codec: "./codec.blot",
      },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  try {
    const build = await project.prepareBuild();
    project.commitBuild(build);
    const provider = build.changedUnits.find((unit) => unit.name === "codec");
    const consumer = build.changedUnits.find((unit) => unit.name === "game");
    if (provider === undefined || consumer === undefined) {
      throw new Error("development build omitted codec or game");
    }
    const providerManifest = JSON.parse(
      new TextDecoder().decode(provider.manifestBytes),
    ) as BlotAbiManifest;
    const consumerManifest = JSON.parse(
      new TextDecoder().decode(consumer.manifestBytes),
    ) as BlotAbiManifest;
    const links = consumerManifest.links?.filter((link) =>
      link.unit === "codec"
    );
    const directLink = links?.find((link) => {
      const exported = providerManifest.exports.find((candidate) =>
        candidate.name === `blot:dev:${link.name}`
      );
      return exported?.postReturn === null;
    });
    const indirectLink = links?.find((link) => {
      const exported = providerManifest.exports.find((candidate) =>
        candidate.name === `blot:dev:${link.name}`
      );
      return exported?.postReturn !== null &&
        exported?.postReturn !== undefined;
    });
    if (directLink === undefined || indirectLink === undefined) {
      throw new Error(
        `development build did not expose direct and indirect codec links ${
          JSON.stringify(links)
        }`,
      );
    }
    const directExportName = `blot:dev:${directLink.name}`;
    const indirectExport = providerManifest.exports.find((candidate) =>
      candidate.name === `blot:dev:${indirectLink.name}`
    );
    if (indirectExport?.postReturn === null || indirectExport === undefined) {
      throw new Error(
        `development build omitted the indirect codec post-return ${
          JSON.stringify(providerManifest.exports)
        }`,
      );
    }

    const rejectBeforeImports = async (
      forged: DevelopmentBuild,
      message: string,
    ): Promise<void> => {
      let importCalls = 0;
      const runtime = new DevelopmentRuntime(() => {
        importCalls += 1;
        return {};
      });
      await assertRejects(
        () => runtime.prepareActivation(forged),
        Error,
        message,
      );
      assertEquals(importCalls, 0);
    };

    const missingEntry = await replaceDevelopmentWasm(
      build,
      provider.name,
      mutateWasmExport(provider.wasm, directExportName, "rename"),
    );
    await rejectBeforeImports(missingEntry, "has Wasm export kinds []");

    const nonFunctionEntry = await replaceDevelopmentWasm(
      build,
      provider.name,
      mutateWasmExport(provider.wasm, directExportName, "non-function"),
    );
    await rejectBeforeImports(
      nonFunctionEntry,
      'has Wasm export kinds ["memory"]',
    );

    const missingPostReturn = await replaceDevelopmentWasm(
      build,
      provider.name,
      mutateWasmExport(
        provider.wasm,
        indirectExport.postReturn,
        "rename",
      ),
    );
    await rejectBeforeImports(
      missingPostReturn,
      "has post-return Wasm export kinds []",
    );
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("activation snapshots the complete external build before awaiting", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return value
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  const imports = () => ({
    "blot:host/Source": { value: () => 7n },
  });
  const runtime = new DevelopmentRuntime(imports);
  try {
    const build = await project.prepareBuild();
    const artifact = build.changedUnits[0];
    if (artifact === undefined) {
      throw new Error("initial development build omitted game");
    }
    const externalArtifact = {
      ...artifact,
      wasm: artifact.wasm.slice(),
      manifestBytes: artifact.manifestBytes.slice(),
      capabilities: [...artifact.capabilities],
    };
    const externalChangedUnits = [externalArtifact];
    const externalRemovedUnits = [...build.removedUnits];
    const externalEdges = build.edges.map((edge) => ({ ...edge }));
    const externalBuild = {
      ...build,
      changedUnits: externalChangedUnits,
      retainedUnits: build.retainedUnits.map((unit) => ({ ...unit })),
      removedUnits: externalRemovedUnits,
      edges: externalEdges,
    };

    const preparation = runtime.prepareActivation(build);
    assertEquals(Reflect.set(build, "revision", "mutated"), false);
    assertEquals(Reflect.set(build, "entryUnit", "missing"), false);
    artifact.wasm.fill(0);
    artifact.manifestBytes.fill(0);
    assertEquals(
      Reflect.set(
        artifact.capabilities,
        artifact.capabilities.length,
        "poisoned",
      ),
      true,
    );
    const activation = await preparation;
    project.commitBuild(build);
    runtime.commitActivation(activation);
    assertEquals(run(runtime.entryInstance), 7n);

    const repeated = await project.prepareBuild();
    assertEquals(repeated.baseRevision, build.revision);
    assertEquals(repeated.changedUnits, []);
    assertEquals(repeated.retainedUnits.map((unit) => unit.name), ["game"]);
    project.abortBuild(repeated);

    const externalRuntime = new DevelopmentRuntime(imports);
    const externalPreparation = externalRuntime.prepareActivation(
      externalBuild,
    );
    externalArtifact.wasm.fill(0);
    externalArtifact.manifestBytes.fill(0);
    externalArtifact.capabilities.push("poisoned");
    externalChangedUnits.length = 0;
    externalRemovedUnits.push("game");
    externalEdges.push({ consumer: "missing", provider: "game", name: "x" });
    externalBuild.entryUnit = "missing";
    externalBuild.revision = "mutated";
    const externalActivation = await externalPreparation;
    externalRuntime.commitActivation(externalActivation);
    assertEquals(run(externalRuntime.entryInstance), 7n);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed activation preserves both committed baselines and retries", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  const sourcePath = join(directory, "main.blot");
  const source = (increment: number): string =>
    `open import "blot:prelude"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return value + ${increment}
`;
  await Deno.writeTextFile(sourcePath, source(0));
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  let failure: "imports" | "destroy" | undefined = "imports";
  const runtime = new DevelopmentRuntime(() => {
    if (failure === "imports") throw new Error("host imports unavailable");
    if (failure === "destroy") project.destroy();
    return { "blot:host/Source": { value: () => 5n } };
  });
  try {
    await assertRejects(
      () => project.activate(runtime),
      Error,
      "host imports unavailable",
    );
    assertEquals(runtime.revision, undefined);
    assertThrows(
      () => runtime.entryInstance,
      Error,
      "has not activated a build",
    );

    failure = undefined;
    const initial = await project.activate(runtime);
    assertEquals(initial.changedUnits.map((unit) => unit.name), ["game"]);
    assertEquals(run(runtime.entryInstance), 5n);

    const initialInstance = runtime.entryInstance;
    const initialRevision = runtime.revision;
    await Deno.writeTextFile(sourcePath, source(1));
    await project.markChanged(sourcePath);
    failure = "destroy";
    await assertRejects(
      () => project.activate(runtime),
      Error,
      "cannot destroy while build",
    );
    assertStrictEquals(runtime.entryInstance, initialInstance);
    assertEquals(runtime.revision, initialRevision);

    failure = undefined;
    const retried = await project.activate(runtime);
    assertEquals(retried.changedUnits.map((unit) => unit.name), ["game"]);
    assertNotEquals(runtime.entryInstance, initialInstance);
    assertEquals(run(runtime.entryInstance), 6n);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("closing a diskless overlay releases its source root", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(join(directory, "main.blot"), "return 1\n");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );

  const overlayPath = join(directory, "unsaved.blot");
  const project = await DevelopmentProject.create(manifestPath);
  try {
    await project.setOverlay(overlayPath, "return 2\n", 1);
    await project.releaseRoot(overlayPath);
    await project.clearOverlay(overlayPath);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a pending build excludes another build and source mutations", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  const sourcePath = join(directory, "main.blot");
  await Deno.writeTextFile(sourcePath, "return 1\n");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  try {
    const preparing = project.prepareBuild();
    await assertRejects(
      () => project.prepareBuild(),
      Error,
      "while preparing a build",
    );
    const build = await preparing;
    await assertRejects(
      () => project.prepareBuild(),
      Error,
      "is pending",
    );
    await assertRejects(
      () => project.markChanged(sourcePath),
      Error,
      "is pending",
    );
    await assertRejects(
      () => project.setOverlay(sourcePath, "return 2\n", 1),
      Error,
      "is pending",
    );
    await assertRejects(
      () => project.clearOverlay(sourcePath),
      Error,
      "is pending",
    );
    await assertRejects(
      () => project.releaseRoot(sourcePath),
      Error,
      "is pending",
    );
    assertThrows(() => project.destroy(), Error, "is pending");
    project.abortBuild(build);

    const retried = await project.prepareBuild();
    assertEquals(retried.changedUnits.map((unit) => unit.name), ["game"]);
    project.abortBuild(retried);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("publication candidates belong to one owner and are single-use", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return value
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: { game: "./main.blot" },
    }),
  );

  const firstProject = await DevelopmentProject.create(manifestPath);
  const secondProject = await DevelopmentProject.create(manifestPath);
  try {
    const firstBuild = await firstProject.prepareBuild();
    const secondBuild = await secondProject.prepareBuild();
    assertThrows(
      () => firstProject.commitBuild(secondBuild),
      Error,
      "pending revision",
    );
    assertThrows(
      () => firstProject.commitBuild({ ...firstBuild }),
      Error,
      "pending revision",
    );
    firstProject.abortBuild(firstBuild);
    assertThrows(
      () => firstProject.abortBuild(firstBuild),
      Error,
      "pending revision is none",
    );
    assertThrows(
      () => firstProject.commitBuild(firstBuild),
      Error,
      "pending revision is none",
    );

    const imports = () => ({
      "blot:host/Source": { value: () => 1n },
    });
    const firstRuntime = new DevelopmentRuntime(imports);
    const secondRuntime = new DevelopmentRuntime(imports);
    const activation = await firstRuntime.prepareActivation(secondBuild);
    await assertRejects(
      () => firstRuntime.prepareActivation(secondBuild),
      Error,
      "is pending",
    );
    assertThrows(
      () => secondRuntime.commitActivation(activation),
      Error,
      "pending revision is none",
    );
    assertThrows(
      () => firstRuntime.commitActivation({ ...activation }),
      Error,
      "pending revision",
    );
    firstRuntime.abortActivation(activation);
    assertThrows(
      () => firstRuntime.abortActivation(activation),
      Error,
      "pending revision is none",
    );
    assertThrows(
      () => firstRuntime.commitActivation(activation),
      Error,
      "pending revision is none",
    );
    secondProject.abortBuild(secondBuild);
  } finally {
    firstProject.destroy();
    secondProject.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development links copy every first-order ABI representation", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    join(directory, "codec.blot"),
    `open import "blot:prelude"
let reflect = fn value => value
let increment = fn value => value + 1
return { .increment = increment; .reflect = reflect; }
`,
  );
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const codec = import "./codec.blot"
const Choice = #Count Int | #Label Text
const Scalar = #Single F32 | #Flag Bool
const Wide = #Double F64 | #Number Int
const Distance = @type.seal "Distance" Int
const Source = @effect.host {
  .value = Unit -> Int;
  .distance = Unit -> Distance;
}
use value <- Source.value ()
use distance <- Source.distance ()
let incremented = codec.increment value
let choice :: Choice
let choice = #Label "oak"
let scalar :: Scalar
let scalar = #Single (F32.of_int 3)
let wide :: Wide
let wide = #Double 4.0
let payload = codec.reflect {
  .nothing = ();
  .integer = value;
  .single = F32.of_int 3;
  .double = 4.0;
  .flag = True;
  .label = "oak";
  .values = [5, 6];
  .choice = choice;
  .scalar = scalar;
  .wide = wide;
  .distance = distance;
}
let label = case payload.choice of
  #Count found => found
  #Label found => @text.len found
let single = case payload.scalar of
  #Single found => F32.truncate found
  #Flag #True => 1
  #Flag #False => 0
let double = case payload.wide of
  #Double found => F64.truncate found
  #Number found => found
return label + single + double + incremented
`,
  );
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units: {
        game: "./main.blot",
        codec: "./codec.blot",
      },
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  const runtime = new DevelopmentRuntime(() => ({
    "blot:host/Source": { value: () => 2n, distance: () => 8n },
  }));
  try {
    const build = await project.activate(runtime);
    const consumer = build.changedUnits.find((unit) => unit.name === "game");
    if (consumer === undefined) {
      throw new Error("development build omitted game");
    }
    const manifest = JSON.parse(
      new TextDecoder().decode(consumer.manifestBytes),
    ) as BlotAbiManifest;
    const codecLinks = manifest.links?.filter((link) => link.unit === "codec");
    assertEquals(codecLinks?.length, 2);
    assertEquals(new Set(codecLinks?.map((link) => link.name)).size, 2);
    const reflected = manifest.links?.find((link) =>
      link.function.parameters[0]?.kind === "record"
    );
    const parameter = reflected?.function.parameters[0];
    if (parameter?.kind !== "record") {
      throw new Error(
        `development build omitted the reflected record link from ${
          JSON.stringify(manifest.links)
        }`,
      );
    }
    assertEquals(
      parameter.fields.map((field) => [field.name, field.type.kind]),
      [
        ["choice", "variant"],
        ["distance", "sealed"],
        ["double", "float-64"],
        ["flag", "boolean"],
        ["integer", "signed-integer-64"],
        ["label", "text"],
        ["nothing", "unit"],
        ["scalar", "variant"],
        ["single", "float-32"],
        ["values", "array"],
        ["wide", "variant"],
      ],
    );
    assertEquals(run(runtime.entryInstance), 13n);
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

function run(instance: WebAssembly.Instance): bigint {
  const exported = instance.exports["blot:default"];
  if (typeof exported !== "function") {
    throw new Error("development entry unit omitted blot:default");
  }
  return (exported as () => bigint)();
}

async function replaceDevelopmentWasm(
  build: DevelopmentBuild,
  unitName: string,
  wasm: Uint8Array,
): Promise<DevelopmentBuild> {
  const wasmDigest = await sha256Hex(wasm);
  const changedUnits = build.changedUnits.map((unit) => {
    if (unit.name !== unitName) return unit;
    return { ...unit, wasm, wasmDigest };
  });
  const revision = await developmentRevision(build.entryUnit, [
    ...changedUnits,
    ...build.retainedUnits,
  ]);
  return { ...build, revision, changedUnits };
}

function mutateWasmExport(
  wasm: Uint8Array,
  exportName: string,
  mutation: "rename" | "non-function",
): Uint8Array {
  const mutated = wasm.slice();
  let sectionOffset = 8;
  while (sectionOffset < mutated.length) {
    const sectionKind = mutated[sectionOffset];
    if (sectionKind === undefined) break;
    const sectionSize = readUnsignedLeb128(mutated, sectionOffset + 1);
    const sectionEnd = sectionSize.next + sectionSize.value;
    if (sectionEnd > mutated.length) {
      throw new Error(
        `Wasm section ${sectionKind} ends at ${sectionEnd}, beyond ${mutated.length} bytes`,
      );
    }
    if (sectionKind !== 7) {
      sectionOffset = sectionEnd;
      continue;
    }

    const exportCount = readUnsignedLeb128(mutated, sectionSize.next);
    let exportOffset = exportCount.next;
    for (let index = 0; index < exportCount.value; index += 1) {
      const nameSize = readUnsignedLeb128(mutated, exportOffset);
      const nameStart = nameSize.next;
      const nameEnd = nameStart + nameSize.value;
      if (nameEnd >= sectionEnd) {
        throw new Error(
          `Wasm export ${index} name ends at ${nameEnd}, beyond section ${sectionEnd}`,
        );
      }
      const name = new TextDecoder().decode(
        mutated.subarray(nameStart, nameEnd),
      );
      const kindOffset = nameEnd;
      const indexOffset = kindOffset + 1;
      const exportedIndex = readUnsignedLeb128(mutated, indexOffset);
      if (name === exportName) {
        if (mutation === "rename") {
          mutated.fill("x".charCodeAt(0), nameStart, nameEnd);
          return mutated;
        }
        mutated[kindOffset] = 2;
        for (
          let offset = indexOffset;
          offset < exportedIndex.next - 1;
          offset += 1
        ) {
          mutated[offset] = 0x80;
        }
        mutated[exportedIndex.next - 1] = 0;
        return mutated;
      }
      exportOffset = exportedIndex.next;
    }
    throw new Error(
      `Wasm export section omitted ${JSON.stringify(exportName)}`,
    );
  }
  throw new Error("Wasm module omitted its export section");
}

function readUnsignedLeb128(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    if (byte === undefined) break;
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    if (shift > 49) {
      throw new Error(`Wasm unsigned LEB128 at ${offset} exceeds 53 bits`);
    }
  }
  throw new Error(`Wasm unsigned LEB128 at ${offset} is truncated`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
