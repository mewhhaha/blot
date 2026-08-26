import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Compiler } from "../../src/compiler/session.ts";

interface CompiledWorkload {
  readonly bytes: number;
  readonly module: WebAssembly.Module;
  readonly run: () => bigint;
  readonly memory: WebAssembly.Memory;
}

interface Timing {
  readonly iterations: number;
  readonly medianNanoseconds: number;
}

const sizes = [32, 128, 512];
const shapes = ["shuffled", "sorted"] as const;
const directory = await mkdtemp(join(tmpdir(), "blot-owned-arrays-"));
const compiler = await Compiler.create();

try {
  console.log(
    "shape\tsize\tsort ns\tbaseline ns\tnet ns\twasm bytes\tmemory pages",
  );
  for (const shape of shapes) {
    for (const size of sizes) {
      let values = shuffledRange(size);
      if (shape === "sorted") {
        values = Array.from({ length: size }, (_, index) => index + 1);
      }
      const expected = checksum(
        [...values].sort((left, right) => left - right),
      );
      const baselinePath = join(directory, `${shape}-${size}-baseline.blot`);
      const quicksortPath = join(directory, `${shape}-${size}-quicksort.blot`);
      await writeFile(baselinePath, source(values, false));
      await writeFile(quicksortPath, source(values, true));

      const hir = await compiler.prepare(quicksortPath);
      const operations = hir.functions.flatMap((function_) =>
        function_.blocks.flatMap((block) => block.operations)
      );
      const writes = operations.filter((operation) =>
        operation.kind === "store.write"
      );
      assert.ok(writes.length > 0, "runtime quicksort emitted no Store writes");
      for (const operation of operations) {
        if (
          operation.kind === "store.write" || operation.kind === "store.grow"
        ) {
          assert.equal(operation.update, "owned-reuse");
        }
      }
      const writers = hir.functions.filter((function_) =>
        function_.blocks.some((block) =>
          block.operations.some((operation) => operation.kind === "store.write")
        )
      );
      assert.ok(writers.length > 0);
      assert.ok(writers.every((function_) => function_.reuse === "checked"));
      assert.ok(
        operations.some((operation) => operation.kind === "call.direct"),
      );
      assert.ok(
        hir.functions.some((function_) =>
          function_.blocks.some((block) =>
            block.terminator.kind === "branch" &&
            block.terminator.target === function_.entryBlock
          )
        ),
      );

      const quicksort = await compile(compiler, quicksortPath, values[0]);
      const baseline = await compile(compiler, baselinePath, values[0]);
      assert.equal(quicksort.run(), expected);
      assert.equal(baseline.run(), checksum(values));

      const memoryRuns = Math.ceil(131_072 / size);
      const quicksortPages = pagesAfterRuns(
        await compile(compiler, quicksortPath, values[0]),
        memoryRuns,
      );
      const baselinePages = pagesAfterRuns(
        await compile(compiler, baselinePath, values[0]),
        memoryRuns,
      );
      assert.equal(quicksortPages, baselinePages);

      const sortTiming = await measure(quicksort.module, values[0]);
      const baselineTiming = await measure(baseline.module, values[0]);
      const net = Math.max(
        0,
        sortTiming.medianNanoseconds - baselineTiming.medianNanoseconds,
      );
      console.log(
        [
          shape,
          size,
          Math.round(sortTiming.medianNanoseconds),
          Math.round(baselineTiming.medianNanoseconds),
          Math.round(net),
          quicksort.bytes,
          quicksortPages,
        ].join("\t"),
      );
    }
  }
} finally {
  compiler.destroy();
  await rm(directory, { recursive: true, force: true });
}

async function compile(
  compiler: Compiler,
  path: string,
  first: number,
): Promise<CompiledWorkload> {
  const artifact = await compiler.compile(path);
  const bytes = Uint8Array.from(artifact.wasm);
  const module = await WebAssembly.compile(bytes as BufferSource);
  assert.deepEqual(
    WebAssembly.Module.imports(module).map((entry) =>
      `${entry.module}.${entry.name}`
    ),
    ["blot:host/Source.value"],
  );
  const instance = await instantiate(module, first);
  return {
    bytes: bytes.byteLength,
    module,
    run: instance.run,
    memory: instance.memory,
  };
}

async function instantiate(
  module: WebAssembly.Module,
  first: number,
): Promise<
  { readonly run: () => bigint; readonly memory: WebAssembly.Memory }
> {
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Source": {
      value(input: bigint) {
        if (input === 0n) return BigInt(first);
        return 1n;
      },
    },
  });
  const run = instance.exports["blot:default"];
  const memory = instance.exports.memory;
  assert.equal(typeof run, "function");
  assert.ok(memory instanceof WebAssembly.Memory);
  return { run: run as () => bigint, memory };
}

function pagesAfterRuns(workload: CompiledWorkload, runs: number): number {
  const before = workload.memory.buffer.byteLength;
  for (let run = 0; run < runs; run += 1) workload.run();
  return (workload.memory.buffer.byteLength - before) / 65_536;
}

async function measure(
  module: WebAssembly.Module,
  first: number,
): Promise<Timing> {
  const calibration = await instantiate(module, first);
  let iterations = 1;
  let elapsed = 0;
  while (elapsed < 40 && iterations < 2_048) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) calibration.run();
    elapsed = performance.now() - start;
    if (elapsed < 40) iterations *= 2;
  }

  const samples = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const workload = await instantiate(module, first);
    for (let warmup = 0; warmup < 3; warmup += 1) workload.run();
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) workload.run();
    samples.push((performance.now() - start) * 1_000_000 / iterations);
  }
  samples.sort((left, right) => left - right);
  return {
    iterations,
    medianNanoseconds: samples[Math.floor(samples.length / 2)],
  };
}

function source(values: readonly number[], quicksort: boolean): string {
  let sorted = "values";
  if (quicksort) {
    sorted = `Array.quicksort (
  ?values,
  fn (left, right) => do:
    if direction < 0:
      return left >= right
    else:
      return left <= right
)`;
  }
  return `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

const rec checksum :: ([Int], Int, Int) -> Int
const rec checksum = fn (values, index, total) => do:
  if index >= Array.length (&values):
    return total
  else:
    let value = Array.expect_get ((&values), index)
    return checksum (values, index + 1, total + (index + 1) * value)

use dynamic <- Source.value 0
use direction <- Source.value 1
let values = [dynamic, ${values.slice(1).join(", ")}]
let sorted = ${sorted}
return checksum (sorted, 0, 0)
`;
}

function shuffledRange(size: number): number[] {
  const values = Array.from({ length: size }, (_, index) => index + 1);
  let state = 0x9e3779b9 ^ size;
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = Math.imul(state ^ state >>> 16, 0x21f0aaad);
    state = Math.imul(state ^ state >>> 15, 0x735a2d97);
    state ^= state >>> 15;
    const selected = (state >>> 0) % (index + 1);
    [values[index], values[selected]] = [values[selected], values[index]];
  }
  return values;
}

function checksum(values: readonly number[]): bigint {
  return BigInt(
    values.reduce(
      (total, value, index) => total + (index + 1) * value,
      0,
    ),
  );
}
