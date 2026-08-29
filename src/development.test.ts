import { assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
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
