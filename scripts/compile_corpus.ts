import { prepareGpupaperHir } from "../src/backend/compile.ts";
import { validateBlotRuntimeModule } from "../src/backend/runtime/hir.ts";
import { compileBlotRuntimeModulesOnRustWasm } from "../src/backend/runtime/target.ts";

const root = new URL("../examples/", import.meta.url);
const files: string[] = [];
for await (const entry of Deno.readDir(root)) {
  if (entry.isFile && entry.name.endsWith(".blot")) files.push(entry.name);
}
files.sort();

const results = [];
for (const file of files) {
  const path = new URL(file, root).pathname;
  const started = performance.now();
  try {
    const hir = await prepareGpupaperHir(path);
    const prepared = performance.now();
    const validatedModule = validateBlotRuntimeModule(hir);
    const validationFinished = performance.now();
    const compiledBatch = await compileBlotRuntimeModulesOnRustWasm([
      validatedModule,
    ]);
    const artifact = compiledBatch.artifacts[0];
    if (artifact === undefined) {
      throw new Error(
        `${file}: Rust/WebAssembly emission omitted its artifact`,
      );
    }
    const compiled = performance.now();
    results.push({
      file,
      status: "ok",
      prepare_ms: prepared - started,
      validate_ms: validationFinished - prepared,
      target_ms: compiled - validationFinished,
      wasm_bytes: artifact.wasm.byteLength,
    });
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) message = error.message;
    results.push({
      file,
      status: "error",
      total_ms: performance.now() - started,
      error: message,
    });
  }
}

const passed = results.filter((result) => result.status === "ok");
console.log(JSON.stringify(
  {
    corpus: "examples/*.blot",
    files: results.length,
    compiled: passed.length,
    rejected: results.length - passed.length,
    wasm_bytes: passed.reduce((sum, result) => {
      if ("wasm_bytes" in result && result.wasm_bytes !== undefined) {
        return sum + result.wasm_bytes;
      }
      return sum;
    }, 0),
    results,
  },
  null,
  2,
));
