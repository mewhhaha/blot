import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { Compiler } from "../../src/compiler.ts";
import { scalarExport } from "../../test_support/guest_abi.ts";

const workloads = ["particles", "transforms"] as const;
const variants = ["scalar", "simd", "setup"] as const;
type Workload = typeof workloads[number];
type Variant = typeof variants[number];
const sizes = [64, 512, 4096];
const frameCounts = [1, 32];
const samples = 7;
const warmupCalls = 16;
const sourcePaths = [
  "case-studies/ecs/systems.blot",
  "case-studies/ecs/planning.blot",
  ...["matrix", "transforms", "particles"].map((name) =>
    `case-studies/ecs/simd/${name}.blot`
  ),
  "case-studies/ecs/bench/simd.blot",
  "case-studies/ecs/simd-benchmark.ts",
  "test_support/guest_abi.ts",
  "src/abi_values.ts",
  "src/compiler/session.ts",
  "generated/compiler/compiler.wasm",
  "generated/compiler/compiler-artifact.json",
  "generated/compiler/prelude.snapshot",
];

const before = await provenance();
const compiler = await Compiler.create();
const artifact = await (async () => {
  try {
    return await compiler.compile("case-studies/ecs/bench/simd.blot");
  } finally {
    compiler.destroy();
  }
})();
const bytes = Uint8Array.from(artifact.wasm);
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const timings = [];
for (const workload of workloads) {
  for (const variant of variants) {
    const guest = await instantiate(variant, workload);
    for (const count of [0, 1, 3, 5, 17, ...sizes]) {
      for (const frames of [0, ...frameCounts]) {
        assert.equal(
          guest.run(BigInt(count), BigInt(frames)),
          expected(workload, variant, count, frames),
          `${variant} ${workload}, ${count} rows, ${frames} frames`,
        );
      }
    }
  }
  for (const rows of sizes) {
    for (const frames of frameCounts) {
      const measurements = new Map<
        Variant,
        { iterations: number; durations: number[]; memoryPages: number[] }
      >();
      const count = BigInt(rows);
      const steps = BigInt(frames);
      for (const variant of variants) {
        const guest = await instantiate(variant, workload);
        for (let warmup = 0; warmup < warmupCalls; warmup += 1) {
          guest.run(count, steps);
        }
        let iterations = 1;
        while (iterations < 1024) {
          const start = performance.now();
          for (let index = 0; index < iterations; index += 1) {
            guest.run(count, steps);
          }
          if (performance.now() - start >= 25) break;
          iterations *= 2;
        }
        measurements.set(variant, {
          iterations,
          durations: [],
          memoryPages: [],
        });
      }
      for (let sample = 0; sample < samples; sample += 1) {
        const order = [
          ...variants.slice(sample % variants.length),
          ...variants.slice(0, sample % variants.length),
        ];
        for (const variant of order) {
          const measurement = measurements.get(variant);
          assert.ok(measurement !== undefined);
          const guest = await instantiate(variant, workload);
          for (let warmup = 0; warmup < warmupCalls; warmup += 1) {
            guest.run(count, steps);
          }
          const start = performance.now();
          for (let index = 0; index < measurement.iterations; index += 1) {
            guest.run(count, steps);
          }
          measurement.durations.push(
            (performance.now() - start) * 1_000_000 / measurement.iterations,
          );
          measurement.memoryPages.push(guest.memory.buffer.byteLength / 65_536);
          assert.equal(
            guest.run(count, steps),
            expected(workload, variant, rows, frames),
          );
        }
      }
      for (const [variant, measurement] of measurements) {
        const sorted = [...measurement.durations].sort((left, right) =>
          left - right
        );
        timings.push({
          workload,
          variant,
          rows,
          frames,
          callsPerSample: measurement.iterations,
          medianNanoseconds: sorted[Math.floor(sorted.length / 2)],
          samplesNanoseconds: measurement.durations,
          memoryPages: measurement.memoryPages,
        });
      }
    }
  }
}
assert.deepEqual(
  await provenance(),
  before,
  "benchmark inputs changed during measurement",
);
console.log(JSON.stringify(
  {
    boundary:
      "Warm emitted-Wasm calls including seed construction, packing once, all frames, unpacking once, checksum, and scalar ABI scope entry/exit. Setup includes seed and checksum only and is not subtracted. Compilation, instantiation, warmup, and verification are untimed.",
    compileOptions: {},
    provenance: before,
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      flags: process.execArgv,
      cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
      logicalCpus: cpus().length,
    },
    warmupCalls,
    samples,
    artifact: {
      source: "case-studies/ecs/bench/simd.blot",
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    },
    timings,
  },
  null,
  2,
));

async function instantiate(variant: Variant, workload: Workload) {
  const instance = await WebAssembly.instantiate(module);
  const memory = instance.exports.memory;
  assert.ok(memory instanceof WebAssembly.Memory);
  return { run: scalarExport(instance, `blot:${variant}_${workload}`), memory };
}

function expected(
  workload: Workload,
  variant: Variant,
  count: number,
  frames: number,
): number {
  let steps = frames;
  if (variant === "setup") steps = 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (workload === "transforms") {
      if (steps > 0) {
        total = Math.fround(
          total +
            Math.fround(
              Math.fround(2 * index + 10 + 23) + Math.fround(32 + steps),
            ),
        );
      }
      continue;
    }
    let position = index % 11;
    let velocity = index % 5 - 2;
    for (let frame = 0; frame < steps; frame += 1) {
      position = Math.fround(position + velocity);
      if (!(position < 10)) velocity = Math.fround(0 - velocity);
    }
    total = Math.fround(
      total + Math.fround(position + Math.fround(7 * velocity)),
    );
  }
  return total;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function provenance() {
  const hashes: Record<string, string> = {};
  for (const path of sourcePaths) hashes[path] = digest(await readFile(path));
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
      .trim(),
    sourceHashes: hashes,
  };
}
