import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { load, LoadError, refreshLoadedModules } from "./load.ts";

Deno.test("refreshing loaded modules replaces an edited dependency and its importer", async () => {
  const directory = await Deno.makeTempDir();
  const dependencyPath = join(directory, "dependency.blot");
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    dependencyPath,
    `return 1
`,
  );
  await Deno.writeTextFile(
    entryPath,
    `return (@import "./dependency.blot") ()
`,
  );

  const firstEntry = await load(entryPath);
  const firstDependency = firstEntry.dependencies.get("./dependency.blot");
  if (firstDependency === undefined) {
    throw new Error(`loaded ${entryPath} omitted ${dependencyPath}`);
  }

  await Deno.writeTextFile(
    dependencyPath,
    `return 2
`,
  );
  await refreshLoadedModules();
  const secondEntry = await load(entryPath);
  const secondDependency = secondEntry.dependencies.get("./dependency.blot");
  if (secondDependency === undefined) {
    throw new Error(`reloaded ${entryPath} omitted ${dependencyPath}`);
  }

  assertNotStrictEquals(secondEntry, firstEntry);
  assertNotStrictEquals(secondDependency, firstDependency);
  assertEquals(
    secondDependency.source,
    `return 2
`,
  );
});

Deno.test("refreshing loaded modules replaces an edited include and its importers", async () => {
  const directory = await Deno.makeTempDir();
  const includedPath = join(directory, "message.txt");
  const dependencyPath = join(directory, "dependency.blot");
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(includedPath, "first");
  await Deno.writeTextFile(
    dependencyPath,
    `const raw = fn source => source.text
const message = @include "./message.txt" raw
return message
`,
  );
  await Deno.writeTextFile(
    entryPath,
    `return (@import "./dependency.blot") ()
`,
  );

  const firstEntry = await load(entryPath);
  const firstDependency = firstEntry.dependencies.get("./dependency.blot");
  if (firstDependency === undefined) {
    throw new Error(`loaded ${entryPath} omitted ${dependencyPath}`);
  }

  await Deno.writeTextFile(includedPath, "second");
  await refreshLoadedModules();
  const secondEntry = await load(entryPath);
  const secondDependency = secondEntry.dependencies.get("./dependency.blot");
  if (secondDependency === undefined) {
    throw new Error(`reloaded ${entryPath} omitted ${dependencyPath}`);
  }

  assertNotStrictEquals(secondEntry, firstEntry);
  assertNotStrictEquals(secondDependency, firstDependency);
  const secondIncluded = secondDependency.includedFiles.get("./message.txt");
  if (secondIncluded === undefined) {
    throw new Error(`reloaded ${dependencyPath} omitted ${includedPath}`);
  }
  assertEquals(secondIncluded.source, "second");
});

Deno.test("loading reports a missing included file at the include site", async () => {
  const directory = await Deno.makeTempDir();
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    entryPath,
    `const raw = fn source => source.text
return @include "./missing.txt" raw
`,
  );

  const failure = await assertRejects(() => load(entryPath), LoadError);
  assertEquals(failure.diagnostics[0]?.code, "BLOT_INCLUDE_NOT_FOUND");
});
