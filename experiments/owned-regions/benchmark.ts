import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coreRuntimeImportModule,
  createRuntimeHeap,
  createRuntimeImports,
} from "@mewhhaha/gpupaper/runtime";
import { Compiler } from "../../src/compiler/session.ts";

const sizes = [16, 32, 64, 128];
const samples = 11;
const warmups = 3;

interface Counters {
  empty: number;
  growOwned: number;
  growPersistent: number;
  new_: number;
  writeOwned: number;
  writePersistent: number;
}

interface Measurement extends Counters {
  readonly algorithm: "structural-persistent" | "persistent" | "owned-region";
  readonly compileMs: number;
  readonly medianUs: number;
  readonly size: number;
  readonly wasmBytes: number;
  readonly growImport: "none" | "owned" | "persistent" | "both";
  readonly growOwnedSites: number;
  readonly growPersistentSites: number;
  readonly writeImport: "none" | "owned" | "persistent" | "both";
  readonly writeOwnedSites: number;
  readonly writePersistentSites: number;
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
    ownedTemplate.indexOf("dynamic <-"),
  );
  const measurements: Measurement[] = [];
  for (const size of sizes) {
    const values = shuffledRange(size);
    measurements.push(
      await measure(
        compiler,
        directory,
        "structural-persistent",
        size,
        structuralPersistentSource(values),
      ),
    );
    measurements.push(
      await measure(
        compiler,
        directory,
        "persistent",
        size,
        persistentSource(values),
      ),
    );
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
    "store new/empty": measurement.new_ + measurement.empty,
    "persistent grow": measurement.growPersistent,
    "persistent write": measurement.writePersistent,
    "owned grow": measurement.growOwned,
    "owned write": measurement.writeOwned,
    "grow import": measurement.growImport,
    "write import": measurement.writeImport,
    "persistent grow sites": measurement.growPersistentSites,
    "owned grow sites": measurement.growOwnedSites,
    "persistent write sites": measurement.writePersistentSites,
    "owned write sites": measurement.writeOwnedSites,
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
  const counted = await instantiate(artifact.wasm, shuffledRange(size)[0]);
  const observed = counted.run();
  if (observed !== expected) {
    throw new Error(
      `${algorithm} n=${size} returned ${observed}; expected ${expected}`,
    );
  }
  for (let index = 0; index < warmups; index += 1) {
    const warm = await instantiate(artifact.wasm, shuffledRange(size)[0]);
    warm.run();
  }
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const trial = await instantiate(artifact.wasm, shuffledRange(size)[0]);
    const before = performance.now();
    trial.run();
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
  const importedNames = new Set(
    WebAssembly.Module.imports(module).map((entry) => entry.name),
  );
  const importsOwnedWrite = importedNames.has("store_write_owned");
  const importsPersistentWrite = importedNames.has("store_write_persistent");
  const importsOwnedGrow = importedNames.has("store_grow_owned");
  const importsPersistentGrow = importedNames.has("store_grow_persistent");
  const growImport = classifyUpdateImport(
    importsOwnedGrow,
    importsPersistentGrow,
  );
  const writeImport = classifyWriteImport(
    importsOwnedWrite,
    importsPersistentWrite,
  );
  if (
    algorithm === "persistent" &&
    (counted.counters.writePersistent === 0 ||
      counted.counters.writeOwned !== 0 ||
      writePersistentSites === 0 ||
      writeOwnedSites !== 0 ||
      writeImport !== "persistent")
  ) {
    throw new Error(
      "persistent path did not lower exclusively to persistent writes",
    );
  }
  if (
    algorithm === "structural-persistent" &&
    (counted.counters.growPersistent === 0 ||
      counted.counters.growOwned !== 0 ||
      counted.counters.writeOwned !== 0 ||
      growPersistentSites === 0 ||
      growOwnedSites !== 0 ||
      writeOwnedSites !== 0 ||
      growImport !== "persistent" ||
      !operations.some((operation) => operation.kind === "call.direct") ||
      operations.some((operation) =>
        operation.kind.includes("quicksort") ||
        operation.kind.includes("partition") ||
        operation.kind.includes("uncons") ||
        operation.kind.includes("take") ||
        operation.kind.includes("split")
      ))
  ) {
    throw new Error(
      "structural persistent path did not lower exclusively to persistent growth",
    );
  }
  if (
    algorithm === "owned-region" &&
    (counted.counters.writeOwned === 0 ||
      counted.counters.writePersistent !== 0 ||
      writeOwnedSites === 0 ||
      writePersistentSites !== 0 ||
      writeImport !== "owned")
  ) {
    throw new Error(
      "owned path did not lower exclusively to owned writes",
    );
  }
  return {
    algorithm,
    compileMs,
    medianUs: median(times),
    size,
    wasmBytes: artifact.wasm.byteLength,
    growImport,
    growOwnedSites,
    growPersistentSites,
    writeImport,
    writeOwnedSites,
    writePersistentSites,
    ...counted.counters,
  };
}

function classifyUpdateImport(
  owned: boolean,
  persistent: boolean,
): Measurement["growImport"] {
  if (owned && persistent) return "both";
  if (owned) return "owned";
  if (persistent) return "persistent";
  return "none";
}

function classifyWriteImport(
  owned: boolean,
  persistent: boolean,
): Measurement["writeImport"] {
  if (owned && persistent) return "both";
  if (owned) return "owned";
  if (persistent) return "persistent";
  return "none";
}

function structuralPersistentSource(values: readonly number[]): string {
  return `operators {
  infixl 55 (<>) = Array.append;
}

open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

sig quicksort = [Int] -> [Int]
let rec quicksort = fn values => case Array.uncons values of
  #None => []
  #Some (pivot, rest) => do:
    let (smaller, larger) =
      Array.partition (rest, fn value => value <= pivot)
    return quicksort smaller <> [pivot] <> quicksort larger

dynamic <- Source.value 0
let values = [dynamic, ${values.slice(1).join(", ")}]
let sorted = quicksort values
${checksumSource()}
`;
}

function persistentSource(values: readonly number[]): string {
  return `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

sig keep_swap = ([Int], Int, Int) -> [Int]
let keep_swap = fn (values, left, right) => do:
  let left_value = case Array.get (values, left) of
    #Some value => value
    #None => 0
  let right_value = case Array.get (values, right) of
    #Some value => value
    #None => 0
  let first = case Array.set (values, left, right_value) of
    #Some updated => updated
    #None => values
  return case Array.set (first, right, left_value) of
    #Some updated => updated
    #None => first

sig partition = ([Int], Int, Int, Int, Int, Int) -> ([Int], Int)
let rec partition = fn (values, pivot, low, scan, boundary, limit) => do:
  if scan >= limit:
    return (values, boundary)
  else:
    let current = case Array.get (values, scan) of
      #Some value => value
      #None => 0
    if current <= pivot:
      return partition (keep_swap (values, scan, boundary), pivot, low, scan + 1, boundary + 1, limit)
    else:
      return partition (values, pivot, low, scan + 1, boundary, limit)

sig sort_range = ([Int], Int, Int) -> [Int]
let rec sort_range = fn (values, low, high) => do:
  if high - low < 2:
    return values
  else:
    let last = high - 1
    let pivot = case Array.get (values, last) of
      #Some value => value
      #None => 0
    let (partitioned, boundary) = partition (values, pivot, low, low, low, last)
    let updated = keep_swap (partitioned, boundary, last)
    let right = boundary + 1
    if boundary - low < high - right:
      let smaller = sort_range (updated, low, boundary)
      return sort_range (smaller, right, high)
    else:
      let smaller = sort_range (updated, right, high)
      return sort_range (smaller, low, boundary)

dynamic <- Source.value 0
let values = [dynamic, ${values.slice(1).join(", ")}]
let sorted = sort_range (values, 0, Array.length values)
${checksumSource()}
`;
}

function ownedSource(prefix: string, values: readonly number[]): string {
  return `${prefix}dynamic <- Source.value 0
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
  return `sig ordered_checksum = ([Int], Int, Int) -> Int
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
): Promise<{ readonly counters: Counters; readonly run: () => bigint }> {
  const counters: Counters = {
    empty: 0,
    growOwned: 0,
    growPersistent: 0,
    new_: 0,
    writeOwned: 0,
    writePersistent: 0,
  };
  const runtime = createRuntimeImports(createRuntimeHeap([]));
  count(runtime, "store_empty", counters, "empty");
  count(runtime, "store_grow_owned", counters, "growOwned");
  count(runtime, "store_grow_persistent", counters, "growPersistent");
  count(runtime, "store_new", counters, "new_");
  count(runtime, "store_write_owned", counters, "writeOwned");
  count(runtime, "store_write_persistent", counters, "writePersistent");
  const module = await WebAssembly.compile(wasm as BufferSource);
  const instance = await WebAssembly.instantiate(module, {
    [coreRuntimeImportModule]: runtime,
    "blot:host/Source": {
      value() {
        return BigInt(first);
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (typeof run !== "function") throw new Error("benchmark export is missing");
  return { counters, run: run as () => bigint };
}

function count(
  imports: Record<string, WebAssembly.ImportValue>,
  name: string,
  counters: Counters,
  key: keyof Counters,
): void {
  const original = imports[name];
  if (typeof original !== "function") {
    throw new Error(`gpupaper runtime omitted ${name}`);
  }
  imports[name] = (...args: unknown[]) => {
    counters[key] += 1;
    return original(...args);
  };
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
