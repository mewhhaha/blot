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
const READS_ONE_FIELD = 'open @import "blot:prelude" ();\n' +
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

Deno.test("imported compile-time dispatchers specialize structured results", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "ecs",
    'open @import "blot:prelude" ();\n' +
      "const component_1 = fn _ => { .pack = fn value => value; };\n" +
      "const component_2 = fn _ => { .pack = fn (left, right) => @int.add left right; };\n" +
      "const component = fn definition => case @array.len (@shape.names definition.fields) of\n" +
      "  1 => component_1 definition,\n" +
      "  _ => component_2 definition\n" +
      "end;\n" +
      "return { .component = component; };",
  );
  await writeModule(
    directory,
    "components",
    'const Ecs = (@import "./ecs.blot") ();\n' +
      "return { .component = Ecs.component; };",
  );
  const root = await writeModule(
    directory,
    "root",
    'open @import "blot:prelude" ();\n' +
      'const Ecs = (@import "./ecs.blot") ();\n' +
      'const Components = (@import "./components.blot") ();\n' +
      "const Unary = Ecs.component { .fields = { .value = Int; }; };\n" +
      "const Binary = Components.component { .fields = { .left = Int; .right = Int; }; };\n" +
      "let unary_value = 7;\n" +
      "let binary_value = (20, 22);\n" +
      "return { .unary = Unary.pack unary_value; .binary = Binary.pack binary_value; };",
  );

  assertEquals(
    (await checkFile(root)).type,
    "{ .unary = 7; .binary = Int; }",
  );
});

Deno.test("specialization capsules bind each module application's parameter", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(
    directory,
    "components",
    "module settings;\n" +
      'open @import "blot:prelude" ();\n' +
      "const component_1 = fn _ => {\n" +
      "  .pack = fn value => settings.offset + value;\n" +
      "};\n" +
      "const component_2 = fn _ => {\n" +
      "  .pack = fn (left, right) => settings.offset + left + right;\n" +
      "};\n" +
      "const component = fn definition => case @array.len (@shape.names definition.fields) of\n" +
      "  1 => component_1 definition,\n" +
      "  _ => component_2 definition\n" +
      "end;\n" +
      "return { .component = component; };",
  );
  const root = await writeModule(
    directory,
    "root",
    'open @import "blot:prelude" ();\n' +
      'const Components = (@import "./components.blot") { .offset = 40; };\n' +
      "const Position = Components.component { .fields = { .x = Int; }; };\n" +
      "return Position.pack 2;",
  );

  assertEquals((await checkFile(root)).type, "Int");
});

Deno.test("specialization capsules freshen calls and follow dependency revisions", async () => {
  const directory = await Deno.makeTempDir();
  const library = await writeModule(
    directory,
    "components",
    'open @import "blot:prelude" ();\n' +
      "const component_1 = fn _ => { .pack = fn value => value; };\n" +
      "const component_2 = fn _ => { .pack = fn (left, right) => left + right; };\n" +
      "const component = fn definition => case @array.len (@shape.names definition.fields) of\n" +
      "  1 => component_1 definition,\n" +
      "  _ => component_2 definition\n" +
      "end;\n" +
      "return { .component = component; };",
  );
  const integerRoot = await writeModule(
    directory,
    "integer_root",
    'open @import "blot:prelude" ();\n' +
      'const Components = (@import "./components.blot") ();\n' +
      "const One = Components.component { .fields = { .value = Int; }; };\n" +
      "return One.pack 7;",
  );
  const textRoot = await writeModule(
    directory,
    "text_root",
    'open @import "blot:prelude" ();\n' +
      'const Components = (@import "./components.blot") ();\n' +
      "const One = Components.component { .fields = { .value = Str; }; };\n" +
      'return One.pack "seven";',
  );

  assertEquals((await checkFile(integerRoot)).type, "7");
  assertEquals((await checkFile(textRoot)).type, '"seven"');

  await Deno.writeTextFile(
    library,
    'open @import "blot:prelude" ();\n' +
      'const component_1 = fn _ => { .pack = fn _ => "reloaded"; };\n' +
      "const component_2 = fn _ => { .pack = fn (left, right) => left + right; };\n" +
      "const component = fn definition => case @array.len (@shape.names definition.fields) of\n" +
      "  1 => component_1 definition,\n" +
      "  _ => component_2 definition\n" +
      "end;\n" +
      "return { .component = component; };",
  );
  await refreshLoadedModules();

  assertEquals((await checkFile(integerRoot)).type, '"reloaded"');
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

Deno.test("JSON include parsers choose widened or literal inference", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${directory}/config.json`,
    '{"name":"blot","count":9007199254740993,"enabled":true}',
  );
  const root = await writeModule(
    directory,
    "root",
    'open @import "blot:prelude" ();\n' +
      'const normal = @include "./config.json" as_json;\n' +
      'const exact = @include "./config.json" as_const_json;\n' +
      "return { .normal = normal; .exact = exact; };",
  );

  assertEquals(
    (await checkFile(root)).type,
    '{ .normal = { .name = Str; .count = Int; .enabled = #True | #False; }; .exact = { .name = "blot"; .count = 9007199254740993; .enabled = #True; }; }',
  );
});

Deno.test("a library reads a record with more fields than it projects", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  const root = await writeModule(
    directory,
    "root",
    'open @import "blot:prelude" ();\n' +
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
    'open @import "blot:prelude" ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return lib.zoom_of { .zoom = 3; .angle = 7; };",
  );
  const wide = await writeModule(
    directory,
    "wide",
    'open @import "blot:prelude" ();\n' +
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
    'open @import "blot:prelude" ();\n' +
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

Deno.test("two records reaching one library retain both representation facts", async () => {
  const directory = await Deno.makeTempDir();
  await writeModule(directory, "lib", READS_ONE_FIELD);
  await writeModule(
    directory,
    "left",
    'open @import "blot:prelude" ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return { .v = lib.zoom_of { .zoom = 3; .angle = 7; }; };",
  );
  await writeModule(
    directory,
    "right",
    'open @import "blot:prelude" ();\n' +
      'const lib = @import "./lib.blot" ();\n' +
      "return { .v = lib.zoom_of { .zoom = 3; .scale = 1; }; };",
  );
  const root = await writeModule(
    directory,
    "root",
    'open @import "blot:prelude" ();\n' +
      'const left = @import "./left.blot" ();\n' +
      'const right = @import "./right.blot" ();\n' +
      "return left.v + right.v;",
  );

  // Well typed under width subtyping, and Core has no nominal that is both. The
  // honest inference fact is the two sets; call specialization consumes that
  // evidence to emit one nominal per call instead of picking whichever module
  // happened to be checked first.
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
    'open @import "blot:prelude" ();\n' +
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
