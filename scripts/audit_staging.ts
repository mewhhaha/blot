import { checkFile } from "../src/check/mod.ts";
import type { Imports } from "../src/comptime/eval.ts";
import { load } from "../src/load.ts";
import { stageModule } from "../src/stage.ts";

const root = new URL("../examples/", import.meta.url);
const results = [];
for await (const entry of Deno.readDir(root)) {
  if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
  const path = new URL(entry.name, root);
  const loaded = await load(path.pathname);
  const checked = await checkFile(path.pathname);
  let imports: Imports = new Map();
  if (
    loaded.closure.tag === "closure" && loaded.closure.imports !== undefined
  ) {
    imports = loaded.closure.imports;
  }
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
  );
  results.push({
    file: entry.name,
    exports: staged.exports.map((exported) => {
      let value: string | null = null;
      if (exported.value !== undefined) value = exported.value.tag;
      return {
        sourceName: exported.sourceName,
        phase: exported.phase,
        value,
      };
    }),
  });
}
results.sort((left, right) => left.file.localeCompare(right.file));
console.log(JSON.stringify(results, null, 2));
