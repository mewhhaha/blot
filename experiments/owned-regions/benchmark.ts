import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compiler } from "../../src/compiler/session.ts";

const sizes = [16, 32, 64, 128];
const samples = 11;
const warmups = 3;

interface Measurement {
  readonly algorithm: "owned-region";
  readonly compileMs: number;
  readonly medianUs: number;
  readonly size: number;
  readonly wasmBytes: number;
  readonly growOwnedSites: number;
  readonly growPersistentSites: number;
  readonly writeOwnedSites: number;
  readonly writePersistentSites: number;
  readonly storeImports: readonly string[];
}

const directory = await mkdtemp(join(tmpdir(), "blot-owned-regions-"));
const compiler = await Compiler.create();
try {
  await compiler.check(
    new URL("../../examples/minimal.blot", import.meta.url).pathname,
  );
  const ownedTemplate = await readFile(
    new URL("./owned_slice_quicksort.blot", import.meta.url),
    "utf8",
  );
  const ownedPrefix = ownedTemplate.slice(
    0,
    ownedTemplate.indexOf("use dynamic <-"),
  );
  const measurements: Measurement[] = [];
  for (const size of sizes) {
    const values = shuffledRange(size);
    measurements.push(
      await measure(
        compiler,
        directory,
        "owned-region",
        size,
        ownedSource(ownedPrefix, values),
      ),
    );
  }
  console.table(measurements.map((measurement) => ({
    algorithm: measurement.algorithm,
    n: measurement.size,
    "compile ms": measurement.compileMs.toFixed(2),
    "run median us": measurement.medianUs.toFixed(2),
    "wasm bytes": measurement.wasmBytes,
    "persistent grow sites": measurement.growPersistentSites,
    "owned grow sites": measurement.growOwnedSites,
    "persistent write sites": measurement.writePersistentSites,
    "owned write sites": measurement.writeOwnedSites,
    "store imports": measurement.storeImports.join(", ") || "none",
  })));
} finally {
  compiler.destroy();
  await rm(directory, { recursive: true, force: true });
}

async function measure(
  compiler: Compiler,
  directory: string,
  algorithm: Measurement["algorithm"],
  size: number,
  source: string,
): Promise<Measurement> {
  const path = join(directory, `${algorithm}-${size}.blot`);
  await writeFile(path, source);
  const started = performance.now();
  const hir = await compiler.prepare(path);
  const artifact = await compiler.compile(path);
  const compileMs = performance.now() - started;
  const expected = checksum(
    shuffledRange(size).sort((left, right) => left - right),
  );
  const run = await instantiate(artifact.wasm, shuffledRange(size)[0]);
  const observed = run();
  if (observed !== expected) {
    throw new Error(
      `${algorithm} n=${size} returned ${observed}; expected ${expected}`,
    );
  }
  for (let index = 0; index < warmups; index += 1) {
    const warm = await instantiate(artifact.wasm, shuffledRange(size)[0]);
    warm();
  }
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const trial = await instantiate(artifact.wasm, shuffledRange(size)[0]);
    const before = performance.now();
    trial();
    times.push((performance.now() - before) * 1_000);
  }
  const operations = hir.functions.flatMap((fn) =>
    fn.blocks.flatMap((block) => block.operations)
  );
  const writeOwnedSites =
    operations.filter((operation) =>
      operation.kind === "store.write" && operation.update === "owned-reuse"
    ).length;
  const writePersistentSites =
    operations.filter((operation) =>
      operation.kind === "store.write" && operation.update === "persistent"
    ).length;
  const growOwnedSites =
    operations.filter((operation) =>
      operation.kind === "store.grow" && operation.update === "owned-reuse"
    ).length;
  const growPersistentSites =
    operations.filter((operation) =>
      operation.kind === "store.grow" && operation.update === "persistent"
    ).length;
  const module = await WebAssembly.compile(artifact.wasm as BufferSource);
  const storeImports = WebAssembly.Module.imports(module)
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("store_"));
  if (
    writeOwnedSites === 0 ||
    growPersistentSites !== 0 ||
    writePersistentSites !== 0 ||
    storeImports.length !== 0
  ) {
    throw new Error(
      `owned path did not lower to direct owned writes: ${
        JSON.stringify({
          growPersistentSites,
          writeOwnedSites,
          writePersistentSites,
          storeImports,
        })
      }`,
    );
  }
  return {
    algorithm,
    compileMs,
    medianUs: median(times),
    size,
    wasmBytes: artifact.wasm.byteLength,
    growOwnedSites,
    growPersistentSites,
    writeOwnedSites,
    writePersistentSites,
    storeImports,
  };
}

function ownedSource(prefix: string, values: readonly number[]): string {
  return `${prefix}use dynamic <- Source.value 0
let values = Slice.copy [dynamic, ${values.slice(1).join(", ")}]
let sorted_region = quicksort_owned (
  (!values),
  fn (left, right) => left <= right
)
let sorted = Slice.freeze (!sorted_region)
${checksumSource()}
`;
}

function checksumSource(): string {
  return `let rec ordered_checksum :: ([Int], Int, Int) -> Int
let rec ordered_checksum = fn (values, index, total) => do:
  if index >= Array.length values:
    return total
  else:
    let value = case Array.get (values, index) of
      #Some item => item
      #None => 0
    return ordered_checksum (values, index + 1, total + (index + 1) * value)

return ordered_checksum (sorted, 0, 0)`;
}

async function instantiate(
  wasm: Uint8Array,
  first: number,
): Promise<() => bigint> {
  const module = await WebAssembly.compile(wasm as BufferSource);
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Source": {
      value() {
        return BigInt(first);
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (typeof run !== "function") throw new Error("benchmark export is missing");
  return run as () => bigint;
}

function shuffledRange(size: number): number[] {
  const values = Array.from({ length: size }, (_, index) => index + 1);
  let state = 0x9e3779b9 ^ size;
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = Math.imul(state ^ state >>> 16, 0x21f0aaad);
    state = Math.imul(state ^ state >>> 15, 0x735a2d97);
    state ^= state >>> 15;
    const selected = (state >>> 0) % (index + 1);
    const value = values[index];
    values[index] = values[selected];
    values[selected] = value;
  }
  return values;
}

function checksum(values: readonly number[]): bigint {
  return BigInt(values.reduce(
    (total, value, index) => total + (index + 1) * value,
    0,
  ));
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}
