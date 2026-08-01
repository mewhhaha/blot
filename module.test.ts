import { assertEquals, assertRejects } from "@std/assert";
import { checkFile, type CheckResult } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";
import { refreshLoadedModules } from "./src/load.ts";

async function writeModule(
  directory: string,
  name: string,
  source: string,
): Promise<string> {
  const path = `${directory}/${name}.blot`;
  await Deno.writeTextFile(path, source);
  return path;
}

/**
 * Every field set the check recorded that mentions `.zoom`, sorted.
 *
 * The library's projection and the caller's literal both land here, and both
 * have to name the record the caller built: the projection's own demand is one
 * field, and Core has no nominal for "one field of three".
 */
function zoomShapes(checked: CheckResult): string[] {
  const found = new Set<string>();
  for (const shape of checked.shapes.values()) {
    if (shape.tag !== "fields") continue;
    if (!shape.fields.includes("zoom")) continue;
    found.add([...shape.fields].sort().join(" "));
  }
  return [...found].sort();
}

/** A library that reads one field of a record its callers build. */
const READS_ONE_FIELD = 'open {} = (@import "blot:prelude") ();\n' +
  "return { .zoom_of = fn c => c.zoom; };";

Deno.test("checking includes ownership errors in transitive dependencies", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "leaf",
    "let !token = 1;\nreturn @int.add token token;",
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
  assertEquals(error.diagnostic.code, "BLOT_LINEAR_CONSUMED_TWICE");
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

Deno.test("checking observes an edited dependency after a cached build", async () => {
  const directory = await Deno.makeTempDir();
  const dependency = await writeModule(directory, "dependency", "return 1;");
  const root = await writeModule(
    directory,
    "root",
    'return (@import "./dependency.blot") ();',
  );
  assertEquals((await checkFile(root)).type, "1");

  await Deno.writeTextFile(dependency, "return 2;");
  await refreshLoadedModules();

  assertEquals((await checkFile(root)).type, "2");
});

Deno.test("a library reads a record with more fields than it projects", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  const root = await writeModule(
    directory,
    "root",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return lib.zoom_of { .zoom = 3; .angle = 7; };",
  );

  const checked = await checkFile(root);
  assertEquals(checked.type, "3");
  // The projection inside the library is one of these. Reading it when the
  // library finished checking would have answered `zoom`, because at that
  // moment `.angle` had not been written anywhere.
  assertEquals(zoomShapes(checked), ["angle zoom"]);
});

Deno.test("a module missing a field the imported module reads is rejected", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "lib",
    "module input;\nreturn input.zoom;",
  );
  const root = await writeModule(
    directory,
    "root",
    'return (@import "./lib.blot") { .angle = 7; };',
  );

  const error = await assertRejects(() => checkFile(root), BlotError);
  assertEquals(error.diagnostic.code, "BLOT_TYPE_ERROR");
});

Deno.test("two programs sharing a library each get their own field sets", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  const narrow = await writeModule(
    directory,
    "narrow",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return lib.zoom_of { .zoom = 3; .angle = 7; };",
  );
  const wide = await writeModule(
    directory,
    "wide",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return lib.zoom_of { .zoom = 3; .scale = 1; .tint = 2; };",
  );

  // Checked in one process, sharing the loader's modules and so the very AST
  // nodes these facts are keyed by. Neither program may inherit the other's
  // record, and the one checked first may not decide for the one checked
  // second.
  const first = await checkFile(narrow);
  const second = await checkFile(wide);

  assertEquals(zoomShapes(first), ["angle zoom"]);
  assertEquals(zoomShapes(second), ["scale tint zoom"]);
  assertEquals(zoomShapes(await checkFile(narrow)), ["angle zoom"]);
});

Deno.test("a field set found two modules down reaches the root's facts", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  await writeModule(
    directory,
    "middle",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return { .v = lib.zoom_of { .zoom = 3; .angle = 7; }; };",
  );
  const root = await writeModule(
    directory,
    "root",
    'const middle = @import "./middle.blot" ();\nreturn middle.v;',
  );

  // The backend inlines the whole subtree into the root, so a fact found in a
  // module the root never named still has to arrive here.
  assertEquals(zoomShapes(await checkFile(root)), ["angle zoom"]);
});

Deno.test("two records reaching one library's projection disagree rather than pick", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  await writeModule(
    directory,
    "left",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return { .v = lib.zoom_of { .zoom = 3; .angle = 7; }; };",
  );
  await writeModule(
    directory,
    "right",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return { .v = lib.zoom_of { .zoom = 3; .scale = 1; }; };",
  );
  const root = await writeModule(
    directory,
    "root",
    'open {} = (@import "blot:prelude") ();\n' +
      'const left = @import "./left.blot" ();\n' +
      'const right = @import "./right.blot" ();\n' +
      "return left.v + right.v;",
  );

  // Well typed under width subtyping, and Core has no nominal that is both. The
  // honest answer is the two sets, so lowering can refuse by name; picking the
  // one that happened to be checked first is the bug this whole staging exists
  // to prevent.
  const checked = await checkFile(root);
  const disagreements = [...checked.shapes.values()].filter((shape) =>
    shape.tag === "disagreement"
  );
  assertEquals(disagreements.length, 1);
});

Deno.test("checking one program twice records the same field sets", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  const root = await writeModule(
    directory,
    "root",
    'open {} = (@import "blot:prelude") ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return lib.zoom_of { .zoom = 3; .angle = 7; };",
  );

  const first = await checkFile(root);
  const second = await checkFile(root);

  assertEquals(zoomShapes(second), zoomShapes(first));
  assertEquals(second.type, first.type);
  // Facts are keyed by AST node identity and the loader hands out the same
  // tree both times, so a second check must have written an answer for every
  // node the first one did rather than leaving the cached one behind.
  assertEquals(second.shapes.size, first.shapes.size);
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
