import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Compiler } from "../src/compiler.ts";

const sourcePath = resolve(process.argv[2] || "examples/storage.blot");
const samples = 9;
const compilerStarted = performance.now();
const compiler = await Compiler.create();
const instantiation = performance.now() - compilerStarted;

try {
  const coldStarted = performance.now();
  const artifact = await compiler.compile(sourcePath);
  const cold = performance.now() - coldStarted;

  const resident = await median(samples, async () => {
    await compiler.compile(sourcePath);
  });
  const check = await median(samples, async () => {
    await compiler.check(sourcePath);
  });
  const sourceOnly = await incremental(
    compiler,
    sourcePath,
    samples,
    editedComment,
  );
  const changedModule = await incremental(
    compiler,
    sourcePath,
    samples,
    editedModule,
  );

  console.log(JSON.stringify({
    source: sourcePath,
    samples,
    wasm_bytes: artifact.wasm.byteLength,
    milliseconds: {
      node_compiler_creation: instantiation,
      node_wasm_cold_after_creation: cold,
      node_wasm_cold_end_to_end: instantiation + cold,
      node_wasm_resident: resident,
      node_wasm_resident_check: check,
      node_wasm_source_only_edit: sourceOnly,
      node_wasm_changed_module_edit: changedModule,
    },
  }, null, 2));
} finally {
  compiler.destroy();
}

async function incremental(
  compiler: Compiler,
  sourcePath: string,
  sampleCount: number,
  edit: (source: string, revision: number) => string,
): Promise<number> {
  const source = await readFile(sourcePath, "utf8");
  const temporary = await mkdtemp(join(dirname(sourcePath), ".node-benchmark-"));
  const path = join(temporary, "revision.blot");
  try {
    await writeFile(path, edit(source, 0));
    await compiler.compile(path);
    let revision = 1;
    return await median(sampleCount, async () => {
      await writeFile(path, edit(source, revision));
      revision += 1;
      await compiler.compile(path);
    });
  } finally {
    await rm(temporary, { recursive: true });
  }
}

function editedComment(source: string, revision: number): string {
  return `${source}\n// benchmark source revision ${revision}\n`;
}

function editedModule(source: string, revision: number): string {
  const returnStart = source.lastIndexOf("\nreturn ");
  if (returnStart < 0) {
    throw new Error("benchmark source has no top-level return declaration");
  }
  const insertion = `\nlet benchmark_revision = ${revision}`;
  return source.slice(0, returnStart) + insertion + source.slice(returnStart);
}

async function median(
  sampleCount: number,
  operation: () => Promise<void>,
): Promise<number> {
  const measurements: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const started = performance.now();
    await operation();
    measurements.push(performance.now() - started);
  }
  measurements.sort((left, right) => left - right);
  const result = measurements[Math.floor(measurements.length / 2)];
  if (result === undefined) throw new Error("benchmark produced no samples");
  return result;
}
