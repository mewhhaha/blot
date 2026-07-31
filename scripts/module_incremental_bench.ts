import { join } from "@std/path";
import { BlotCompilerSession } from "../src/backend/compile.ts";

const MODULE_COUNT = 24;
const DEFINITIONS_PER_MODULE = 24;
const SAMPLE_COUNT = 7;

const directory = await Deno.makeTempDir({ prefix: "blot-module-bench-" });
const entryPath = join(directory, "entry.blot");
const warmupPath = join(directory, "warmup.blot");
const modulePaths: string[] = [];

try {
  for (let moduleIndex = 0; moduleIndex < MODULE_COUNT; moduleIndex += 1) {
    const moduleName = moduleIndex.toString().padStart(2, "0");
    const modulePath = join(directory, `module_${moduleName}.blot`);
    modulePaths.push(modulePath);
    await Deno.writeTextFile(modulePath, moduleSource(1));
  }
  const declarations: string[] = [];
  const exports: string[] = [];
  for (let moduleIndex = 0; moduleIndex < MODULE_COUNT; moduleIndex += 1) {
    const moduleName = moduleIndex.toString().padStart(2, "0");
    declarations.push(
      `const module_${moduleName} = @import "./module_${moduleName}.blot";`,
      `let result_${moduleName} = module_${moduleName} {};`,
    );
    exports.push(`  .result_${moduleName} = result_${moduleName}.run;`);
  }
  await Deno.writeTextFile(
    entryPath,
    [...declarations, "return {", ...exports, "};", ""].join("\n"),
  );
  await Deno.writeTextFile(warmupPath, "return 0;\n");

  const serviceStart = performance.now();
  const session = await BlotCompilerSession.create();
  const serviceStartupMilliseconds = performance.now() - serviceStart;
  try {
    await session.build(warmupPath);
    const firstStart = performance.now();
    const first = await session.build(entryPath);
    const firstBuildMilliseconds = performance.now() - firstStart;

    const unchanged = await samples(async () => {
      await session.build(entryPath);
    });

    const edited: number[] = [];
    const editedModule = modulePaths[0];
    if (editedModule === undefined) {
      throw new Error("module benchmark generated no editable module");
    }
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      await Deno.writeTextFile(editedModule, moduleSource(sample + 2));
      const start = performance.now();
      await session.build(entryPath);
      edited.push(performance.now() - start);
    }

    console.log(
      `Blot module cache (${MODULE_COUNT} modules × ${DEFINITIONS_PER_MODULE} functions)`,
    );
    console.log(
      `  service GPU startup:       ${
        serviceStartupMilliseconds.toFixed(1)
      } ms`,
    );
    console.log(
      `  first clean build:         ${firstBuildMilliseconds.toFixed(1)} ms`,
    );
    console.log(
      `  unchanged median:          ${median(unchanged).toFixed(1)} ms`,
    );
    console.log(
      `  one-module edit median:    ${median(edited).toFixed(1)} ms`,
    );
    console.log(
      `  artifact:                  ${
        (first.wasm.byteLength / 1024).toFixed(1)
      } KiB`,
    );
  } finally {
    session.destroy();
  }
} finally {
  await Deno.remove(directory, { recursive: true });
}

function moduleSource(increment: number): string {
  const definitions: string[] = [];
  for (
    let definitionIndex = 0;
    definitionIndex < DEFINITIONS_PER_MODULE;
    definitionIndex += 1
  ) {
    const definitionName = `step_${
      definitionIndex.toString().padStart(2, "0")
    }`;
    const input = definitionIndex === 0
      ? "value"
      : `step_${(definitionIndex - 1).toString().padStart(2, "0")} value`;
    definitions.push(
      `let ${definitionName} = value => ${input} + ${increment};`,
    );
  }
  return [
    "module {};",
    'open {} = (@import "blot:prelude") ();',
    ...definitions,
    `return { .run = step_${
      (DEFINITIONS_PER_MODULE - 1).toString().padStart(2, "0")
    }; };`,
    "",
  ].join("\n");
}

async function samples(
  measure: () => Promise<void>,
): Promise<readonly number[]> {
  const durations: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await measure();
    durations.push(performance.now() - start);
  }
  return durations;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered[Math.floor(ordered.length / 2)];
  if (middle === undefined) {
    throw new Error("cannot take the median of no samples");
  }
  return middle;
}
