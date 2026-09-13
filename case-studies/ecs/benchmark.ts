import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { Compiler } from "../../src/compiler.ts";
import { scalarExport } from "../../test_support/guest_abi.ts";
import { inspectKernel } from "./verification.ts";

const variants = ["fused", "separate", "direct", "setup"] as const;
type Variant = typeof variants[number];
const sizes = [64, 512, 4096];
const samples = 7;
const warmupCalls = 16;
const sourcePaths = [
  "case-studies/ecs/ecs.blot",
  "case-studies/ecs/streams.blot",
  "case-studies/ecs/messages.blot",
  "case-studies/ecs/simulation.blot",
  ...variants.map((name) => `case-studies/ecs/bench/${name}.blot`),
  "case-studies/ecs/bench/boundary.blot",
  ...["fused", "separate", "direct"].map((name) =>
    `case-studies/ecs/kernels/${name}.blot`
  ),
  "case-studies/ecs/benchmark.ts",
  "case-studies/ecs/verification.ts",
  "test_support/guest_abi.ts",
  "src/abi_values.ts",
  "src/compiler/session.ts",
  "generated/compiler/compiler.wasm",
  "generated/compiler/compiler-artifact.json",
  "generated/compiler/prelude.snapshot",
];

const before = await provenance();
const compiler = await Compiler.create();
const workloads = new Map<Variant, {
  readonly module: WebAssembly.Module;
  readonly bytes: number;
  readonly sha256: string;
}>();
const kernels = new Map<string, Awaited<ReturnType<typeof inspectKernel>>>();
let boundaryBytes = 0;
try {
  boundaryBytes =
    (await compiler.compile("case-studies/ecs/bench/boundary.blot")).wasm
      .byteLength;
  for (const name of variants) {
    const artifact = await compiler.compile(
      `case-studies/ecs/bench/${name}.blot`,
    );
    const bytes = Uint8Array.from(artifact.wasm);
    const module = await WebAssembly.compile(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    workloads.set(name, {
      module,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    });
    const observed = await instantiate(module);
    for (const size of [0, 1, 3, 17, ...sizes]) {
      assert.equal(
        observed.run(BigInt(size)),
        expectedChecksum(name, size),
        `${name}, ${size} rows`,
      );
    }
    if (name !== "setup") {
      kernels.set(name, await inspectKernel(compiler, name));
    }
  }
} finally {
  compiler.destroy();
}

const timings = [];
for (const size of sizes) {
  const counts = new Map<Variant, number>();
  const durations = new Map<Variant, number[]>();
  const memoryPages = new Map<Variant, number[]>();
  for (const [name, workload] of workloads) {
    const calibrated = await instantiate(workload.module);
    const count = BigInt(size);
    for (let warmup = 0; warmup < warmupCalls; warmup += 1) {
      calibrated.run(count);
    }
    let iterations = 1;
    while (iterations < 1024) {
      const start = performance.now();
      for (let index = 0; index < iterations; index += 1) calibrated.run(count);
      if (performance.now() - start >= 25) break;
      iterations *= 2;
    }
    counts.set(name, iterations);
    durations.set(name, []);
    memoryPages.set(name, []);
  }
  for (let sample = 0; sample < samples; sample += 1) {
    const order = [
      ...variants.slice(sample % variants.length),
      ...variants.slice(0, sample % variants.length),
    ];
    for (const name of order) {
      const workload = workloads.get(name);
      const iterations = counts.get(name);
      const observations = durations.get(name);
      const pages = memoryPages.get(name);
      assert.ok(
        workload !== undefined && iterations !== undefined &&
          observations !== undefined && pages !== undefined,
      );
      const instance = await instantiate(workload.module);
      const count = BigInt(size);
      for (let warmup = 0; warmup < warmupCalls; warmup += 1) {
        instance.run(count);
      }
      const start = performance.now();
      for (let index = 0; index < iterations; index += 1) instance.run(count);
      observations.push((performance.now() - start) * 1_000_000 / iterations);
      pages.push(instance.memory.buffer.byteLength / 65_536);
      assert.equal(instance.run(count), expectedChecksum(name, size));
    }
  }
  for (const [name, observations] of durations) {
    const sorted = [...observations].sort((left, right) => left - right);
    timings.push({
      variant: name,
      rows: size,
      callsPerSample: counts.get(name),
      medianNanoseconds: sorted[Math.floor(sorted.length / 2)],
      samplesNanoseconds: observations,
      memoryPages: memoryPages.get(name),
    });
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
      "Warm emitted-Wasm calls, including seed construction, row work, checksum, and scalar ABI scope entry/exit; setup is reported separately without subtraction.",
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
    boundaryBytes,
    artifacts: [...workloads].map(([name, workload]) => ({
      variant: name,
      source: `case-studies/ecs/bench/${name}.blot`,
      bytes: workload.bytes,
      marginalBytes: workload.bytes - boundaryBytes,
      sha256: workload.sha256,
    })),
    kernels: Object.fromEntries(kernels),
    timings,
  },
  null,
  2,
));

async function instantiate(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module);
  const memory = instance.exports.memory;
  assert.ok(memory instanceof WebAssembly.Memory);
  return { run: scalarExport(instance, "blot:default"), memory };
}

function expectedChecksum(name: Variant, count: number): bigint {
  let total = 0n;
  for (let index = 0; index < count; index += 1) {
    let x = BigInt(index + 6);
    let y = BigInt(index);
    let velocity = 3n;
    let age = 0n;
    if (name !== "setup") {
      x += 3n;
      y += 2n;
      if (x >= 10n) velocity = -3n;
      age = 1n;
    }
    total += x * 3n + y * 5n + velocity * 7n + 22n + age;
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
