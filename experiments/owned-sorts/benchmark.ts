import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Compiler } from "../../src/compiler/session.ts";

const algorithms = [
  "quicksort",
  "merge",
  "radix-unstable",
  "radix-stable",
] as const;
const sizes = [32, 128] as const;
const directory = await mkdtemp(join(tmpdir(), "blot-owned-sorts-"));
const compiler = await Compiler.create();

try {
  const rows = [];
  for (const size of sizes) {
    const values = shuffledRange(size);
    const expected = checksum([...values].sort((a, b) => a - b));
    for (const algorithm of algorithms) {
      const path = join(directory, `${algorithm}-${size}.blot`);
      await writeFile(path, source(values, algorithm));
      const started = performance.now();
      const hir = await compiler.prepare(path);
      const artifact = await compiler.compile(path);
      const compileMs = performance.now() - started;
      const bytes = Uint8Array.from(artifact.wasm);
      assert.equal(WebAssembly.validate(bytes), true);
      const module = await WebAssembly.compile(bytes as BufferSource);
      const run = await instantiate(module, values[0]);
      assert.equal(run.value(), expected, `${algorithm} n=${size}`);
      const operations = hir.functions.flatMap((function_) =>
        function_.blocks.flatMap((block) => block.operations)
      );
      const beforePages = run.pages();
      for (let index = 0; index < 64; index += 1) run.value();
      const memoryPages = run.pages() - beforePages;
      const samples = [];
      for (let sample = 0; sample < 7; sample += 1) {
        const trial = await instantiate(module, values[0]);
        for (let warmup = 0; warmup < 3; warmup += 1) trial.value();
        const before = performance.now();
        for (let iteration = 0; iteration < 32; iteration += 1) trial.value();
        samples.push((performance.now() - before) * 1_000 / 32);
      }
      samples.sort((a, b) => a - b);
      rows.push({
        algorithm,
        n: size,
        "compile ms": compileMs.toFixed(1),
        "median us": samples[Math.floor(samples.length / 2)].toFixed(2),
        "Wasm bytes": bytes.byteLength,
        "Store writes": operations.filter((op) =>
          op.kind === "store.write"
        ).length,
        "Scratch ops": operations.filter((op) =>
          op.kind.startsWith("scratch.")
        ).length,
        "pages / 64": memoryPages,
      });
    }
  }
  console.table(rows);
} finally {
  compiler.destroy();
  await rm(directory, { recursive: true, force: true });
}

async function instantiate(module: WebAssembly.Module, first: number) {
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Source": { value: () => BigInt(first) },
  });
  const value = instance.exports["blot:default"];
  const memory = instance.exports.memory;
  assert.equal(typeof value, "function");
  assert.ok(memory instanceof WebAssembly.Memory);
  return {
    value: value as () => bigint,
    pages: () => memory.buffer.byteLength / 65_536,
  };
}

function source(
  values: readonly number[],
  algorithm: typeof algorithms[number],
): string {
  let sort: string;
  if (algorithm === "quicksort") {
    sort = "Array.quicksort (values, fn (a, b) => a <= b)";
  } else if (algorithm === "merge") {
    sort = "Array.merge_sort (values, fn (a, b) => a <= b)";
  } else if (algorithm === "radix-stable") {
    sort = "Array.radix_sort (values, fn value => value, Radix.stable)";
  } else {
    sort = "Array.radix_sort (values, fn value => value, Radix.unstable)";
  }
  return `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

sig checksum = ([Int], Int, Int) -> Int
const rec checksum = fn (values, index, total) => do:
  if index >= Array.length (&values):
    return total
  else:
    let value = Array.expect_get ((&values), index)
    return checksum (values, index + 1, total + (index + 1) * value)

dynamic <- Source.value 0
sig values = [Int]
let values = [dynamic, ${values.slice(1).join(", ")}]
let sorted = ${sort}
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
  return BigInt(values.reduce(
    (total, value, index) => total + (index + 1) * value,
    0,
  ));
}
