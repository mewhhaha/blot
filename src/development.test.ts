import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { BlotAbiManifest } from "./compiler/backend/runtime/abi.ts";
import { DevelopmentProject } from "./development.ts";
import { DevelopmentRuntime } from "./development_runtime.ts";

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
    const initial = await project.build();
    assertEquals(initial.changedUnits.map((unit) => unit.name).sort(), [
      "codec",
      "game",
    ]);
    await runtime.activate(initial);
    const entry = runtime.entryInstance;
    const provider = runtime.unitInstance("codec");
    assertEquals(run(entry), 141n);

    await Deno.writeTextFile(providerPath, providerSource(", request.seed"));
    await project.markChanged(providerPath);
    const edited = await project.build();
    assertEquals(edited.changedUnits.map((unit) => unit.name), ["codec"]);
    assertEquals(edited.retainedUnits.map((unit) => unit.name), ["game"]);
    await runtime.activate(edited);

    assertStrictEquals(runtime.entryInstance, entry);
    assertNotEquals(runtime.unitInstance("codec"), provider);
    assertEquals(run(runtime.entryInstance), 142n);

    const unchanged = await project.build();
    assertEquals(unchanged.changedUnits, []);
    assertEquals(
      unchanged.retainedUnits.map((unit) => unit.name).sort(),
      ["codec", "game"],
    );

    const activeRevision = runtime.revision;
    await assertRejects(
      () =>
        runtime.activate({
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
      const initial = await project.build();
      assertEquals(initial.changedUnits.length, 2);
      assertEquals(initial.edges.length, 1);
      assertEquals(initial.edges[0].provider, "frame");

      const repeated = await project.build();
      assertEquals(repeated.changedUnits, []);
      assertEquals(repeated.retainedUnits.length, 2);
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
    const initial = await project.build();
    const provider = initial.changedUnits.find((unit) =>
      unit.name === "provider"
    );
    if (provider === undefined) {
      throw new Error("initial development build omitted provider");
    }

    await Deno.writeTextFile(
      providerPath,
      providerSource(' .label = "changed";'),
    );
    await project.markChanged(providerPath);
    const edited = await project.build();

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
  } finally {
    project.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development activation rejects malformed and mismatched ABI manifests", async () => {
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
    const build = await project.build();
    const artifact = build.changedUnits[0];
    if (artifact === undefined) {
      throw new Error("initial development build omitted game");
    }
    const manifestText = new TextDecoder().decode(artifact.manifestBytes);
    const malformedBytes = new TextEncoder().encode(
      manifestText.replace('"signed-integer-64"', '"unsupported"'),
    );
    const malformedRuntime = new DevelopmentRuntime();
    await assertRejects(
      () =>
        malformedRuntime.activate({
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
        mismatchedRuntime.activate({
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

Deno.test("development links copy every first-order ABI representation", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    join(directory, "codec.blot"),
    `open import "blot:prelude"
let reflect = fn value => value
return { .reflect = reflect; }
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
return label + single + double
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
    const build = await project.build();
    const consumer = build.changedUnits.find((unit) => unit.name === "game");
    if (consumer === undefined) {
      throw new Error("development build omitted game");
    }
    const manifest = JSON.parse(
      new TextDecoder().decode(consumer.manifestBytes),
    ) as BlotAbiManifest;
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
    await runtime.activate(build);
    assertEquals(run(runtime.entryInstance), 10n);
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
