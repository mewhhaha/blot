import { Compiler } from "../src/compiler/session.ts";
import { CompilerTargetRefusal } from "../src/compiler/policy.ts";

const root = new URL("../examples/", import.meta.url);
const files: string[] = [];
for await (const entry of Deno.readDir(root)) {
  if (entry.isFile && entry.name.endsWith(".blot")) files.push(entry.name);
}
files.sort();

const compiler = await Compiler.create();
const results = [];
try {
  for (const file of files) {
    const path = new URL(file, root).pathname;
    const started = performance.now();
    try {
      const artifact = await compiler.compile(path);
      results.push({
        file,
        status: "ok",
        total_ms: performance.now() - started,
        wasm_bytes: artifact.wasm.byteLength,
      });
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      let status = "error";
      if (error instanceof CompilerTargetRefusal) status = "refused";
      results.push({
        file,
        status,
        total_ms: performance.now() - started,
        error: message,
      });
    }
  }
} finally {
  compiler.destroy();
}

const passed = results.filter((result) => result.status === "ok");
const refused = results.filter((result) => result.status === "refused");
const failed = results.filter((result) => result.status === "error");
console.log(JSON.stringify(
  {
    corpus: "examples/*.blot",
    files: results.length,
    compiled: passed.length,
    refused: refused.length,
    failed: failed.length,
    results,
  },
  null,
  2,
));
// Top-level examples claim support by the ordinary target. A target refusal
// remains distinct from a source/compiler error in the report, but neither is
// a successful accepted-corpus run.
if (failed.length > 0 || refused.length > 0) Deno.exit(1);
