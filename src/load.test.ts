import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { load, refreshLoadedModules } from "./load.ts";

Deno.test("refreshing loaded modules replaces an edited dependency and its importer", async () => {
  const directory = await Deno.makeTempDir();
  const dependencyPath = join(directory, "dependency.blot");
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(dependencyPath, "return 1;");
  await Deno.writeTextFile(
    entryPath,
    'return (@import "./dependency.blot") ();',
  );

  const firstEntry = await load(entryPath);
  const firstDependency = firstEntry.dependencies.get("./dependency.blot");
  if (firstDependency === undefined) {
    throw new Error(`loaded ${entryPath} omitted ${dependencyPath}`);
  }

  await Deno.writeTextFile(dependencyPath, "return 2;");
  await refreshLoadedModules();
  const secondEntry = await load(entryPath);
  const secondDependency = secondEntry.dependencies.get("./dependency.blot");
  if (secondDependency === undefined) {
    throw new Error(`reloaded ${entryPath} omitted ${dependencyPath}`);
  }

  assertNotStrictEquals(secondEntry, firstEntry);
  assertNotStrictEquals(secondDependency, firstDependency);
  assertEquals(secondDependency.source, "return 2;");
});
