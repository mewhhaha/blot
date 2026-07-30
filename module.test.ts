import { assertEquals, assertRejects } from "@std/assert";
import { checkFile } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";

async function writeModule(
  directory: string,
  name: string,
  source: string,
): Promise<string> {
  const path = `${directory}/${name}.blot`;
  await Deno.writeTextFile(path, source);
  return path;
}

Deno.test("checking includes ownership errors in transitive dependencies", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "leaf",
    "let !token = 1;\nreturn 0;",
  );
  await writeModule(
    directory,
    "middle",
    'const leaf = @import "./leaf.blot";\nreturn 0;',
  );
  const root = await writeModule(
    directory,
    "root",
    'const middle = @import "./middle.blot";\nreturn 0;',
  );

  const error = await assertRejects(
    () => checkFile(root),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_LINEAR_NOT_CONSUMED");
});

Deno.test("transitive module result types reach the importer", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "leaf",
    "return { .answer = 42; };",
  );
  await writeModule(
    directory,
    "middle",
    'const leaf = @import "./leaf.blot" ();\nreturn { .answer = leaf.answer; };',
  );
  const root = await writeModule(
    directory,
    "root",
    'const middle = @import "./middle.blot" ();\nreturn middle.answer;',
  );

  const checked = await checkFile(root);
  assertEquals(checked.type, "42");
});

Deno.test("an import cycle reports the complete cycle", async () => {
  const directory = await Deno.makeTempDir();
  const left = await writeModule(
    directory,
    "left",
    'const right = @import "./right.blot";\nreturn 0;',
  );
  await writeModule(
    directory,
    "right",
    'const left = @import "./left.blot";\nreturn 0;',
  );

  const error = await assertRejects(
    () => checkFile(left),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_IMPORT_CYCLE");
});
