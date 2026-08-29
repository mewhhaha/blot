import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  PROJECT_FORMAT_VERSION,
  ProjectManifestError,
  readProjectManifest,
} from "./project_format.ts";

Deno.test("project manifests resolve a named entry and confined unit roots", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.mkdir(join(directory, "src"));
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: PROJECT_FORMAT_VERSION,
      entryUnit: "game",
      units: {
        game: "./src/main.blot",
        renderer: "./src/render.blot",
      },
    }),
  );

  const manifest = await readProjectManifest(manifestPath);

  assertEquals(manifest.entryUnit, "game");
  assertEquals(
    [...manifest.units],
    [
      ["game", join(directory, "src", "main.blot")],
      ["renderer", join(directory, "src", "render.blot")],
    ],
  );
});

Deno.test("project manifests reject an absent entry unit", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: PROJECT_FORMAT_VERSION,
      entryUnit: "game",
      units: { renderer: "./render.blot" },
    }),
  );

  const failure = await assertRejects(
    () => readProjectManifest(manifestPath),
    ProjectManifestError,
  );
  assertStringIncludes(failure.message, 'entry unit "game" is absent');
});

Deno.test("project manifests reject sources outside the project", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: PROJECT_FORMAT_VERSION,
      entryUnit: "game",
      units: { game: "../game.blot" },
    }),
  );

  const failure = await assertRejects(
    () => readProjectManifest(manifestPath),
    ProjectManifestError,
  );
  assertStringIncludes(failure.message, "escapes its project");
});

Deno.test("project manifests reject repeated unit roots", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: PROJECT_FORMAT_VERSION,
      entryUnit: "game",
      units: {
        game: "./game.blot",
        renderer: "./game.blot",
      },
    }),
  );

  const failure = await assertRejects(
    () => readProjectManifest(manifestPath),
    ProjectManifestError,
  );
  assertStringIncludes(failure.message, "repeat source");
});
