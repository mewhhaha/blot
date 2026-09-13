import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Compiler } from "../../src/compiler.ts";
import { instantiateArtifact } from "../../src/host.ts";

const compiler = await Compiler.create();
try {
  const path = "/tmp/blot-float-format-benchmark.blot";
  const started = performance.now();
  await compiler.checkSource(
    path,
    `const Float = import "blot:float"
return { .f64 = Float.F64.to_text; .f32 = Float.F32.to_text; }
`,
  );
  const artifact = await compiler.compile(path);
  const compileMilliseconds = performance.now() - started;
  const guest = await instantiateArtifact(artifact);
  const measurements = [];
  try {
    for (
      const [name, value, expected] of [
        ["f64", 0.1, "0.1"],
        ["f64", Number.MIN_VALUE, "5e-324"],
        ["f64", Number.MAX_VALUE, "1.7976931348623157e+308"],
        ["f32", Math.fround(0.1), "0.1"],
        ["f32", 2 ** -149, "1e-45"],
      ] as const
    ) {
      for (let warmup = 0; warmup < 3; warmup += 1) {
        assert.equal(guest.call(name, [value]), expected);
      }
      const milliseconds = [];
      for (let sample = 0; sample < 7; sample += 1) {
        const start = performance.now();
        for (let repetition = 0; repetition < 100; repetition += 1) {
          assert.equal(guest.call(name, [value]), expected);
        }
        milliseconds.push((performance.now() - start) / 100);
      }
      measurements.push({
        name,
        value,
        expected,
        medianMilliseconds: milliseconds.toSorted((a, b) => a - b)[3],
        milliseconds,
      });
    }
  } finally {
    await guest.close();
  }
  console.log(JSON.stringify(
    {
      schema: 1,
      host: process.versions,
      compiler: JSON.parse(
        await readFile(
          new URL(
            "../../generated/compiler/compiler-artifact.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
      compileMilliseconds,
      wasmBytes: artifact.wasm.byteLength,
      measurements,
    },
    null,
    2,
  ));
} finally {
  compiler.destroy();
}
