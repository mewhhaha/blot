import { fromFileUrl } from "@std/path";
import { Compiler } from "../../src/compiler.ts";

const candidates = [
  "effect_stream_baseline.blot",
  "effect_stream.blot",
  "derived_accessors_baseline.blot",
  "derived_accessors.blot",
] as const;

const compiler = await Compiler.create();
try {
  const measurements = [];
  for (const candidate of candidates) {
    const path = fromFileUrl(new URL(candidate, import.meta.url));
    const source = await Deno.readTextFile(path);
    const checked = await compiler.check(path);
    const runtime = await compiler.prepare(path);
    const artifact = await compiler.compile(path);
    const continuations = runtime.functions.flatMap((fn) => fn.continuations);
    const operationKinds = [
      ...new Set(
        continuations.flatMap((continuation) =>
          continuation.instructions.map((instruction) =>
            instruction.operation.kind
          )
        ),
      ),
    ].sort();
    measurements.push({
      candidate,
      sourceLines: source.trimEnd().split("\n").length,
      type: checked.type,
      effects: checked.effects,
      functions: runtime.functions.length,
      continuations: continuations.length,
      operations: continuations.reduce(
        (total, continuation) => total + continuation.instructions.length,
        0,
      ),
      operationKinds,
      capabilities: runtime.capabilities.length,
      wasmBytes: artifact.wasm.byteLength,
    });
  }
  console.log(JSON.stringify(measurements, null, 2));
} finally {
  compiler.destroy();
}
