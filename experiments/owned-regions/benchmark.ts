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
  readonly algorithm: "persistent" | "owned-region";
  readonly compileMs: number;
  readonly elementPersistentWrites: number;
  readonly medianUs: number;
  readonly size: number;
  readonly wasmBytes: number;
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
    "element persistent write sites": measurement.elementPersistentWrites,
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
  let elementPersistentWrites = 0;
  const operations = hir.functions.flatMap((fn) =>
    fn.blocks.flatMap((block) => block.operations)
  );
  const ownedWrite = operations.find((operation) =>
    operation.kind === "store.write" && operation.update === "owned-reuse"
  );
  if (ownedWrite !== undefined) {
    elementPersistentWrites = operations.filter((operation) =>
      operation.kind === "store.write" &&
      operation.type === ownedWrite.type &&
      operation.update === "persistent"
    ).length;
  }
  return {
    algorithm,
    compileMs,
    elementPersistentWrites,
    medianUs: median(times),
    size,
    wasmBytes: artifact.wasm.byteLength,
    ...counted.counters,
  };
}

function persistentSource(values: readonly number[]): string {
  return `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

sig keep_swap = ([Int], Int, Int) -> [Int]
let keep_swap = fn (values, left, right) =>
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
let rec partition = fn (values, pivot, low, scan, boundary, limit) =>
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

sig sort_work = ([Int], [(Int, Int)], Int) -> [Int]
let rec sort_work = fn (values, work, cursor) =>
  let count = Array.length work
  if count <= cursor:
    return values
  else:
    let (low, high) = case Array.get (work, cursor) of
      #Some entry => entry
      #None => (0, 0)
    if high - low < 2:
      return sort_work (values, work, cursor + 1)
    else:
      let last = high - 1
      let pivot = case Array.get (values, last) of
        #Some value => value
        #None => 0
      let (partitioned, boundary) = partition (values, pivot, low, low, low, last)
      let updated = keep_swap (partitioned, boundary, last)
      let pending = @array.push (@array.push work (low, boundary)) (boundary + 1, high)
      return sort_work (updated, pending, cursor + 1)

dynamic <- Source.value 0
let values = [dynamic, ${values.slice(1).join(", ")}]
let sorted = sort_work (values, [(0, Array.length values)], 0)
${checksumSource(values.length)}
`;
}

function ownedSource(prefix: string, values: readonly number[]): string {
  return `${prefix}dynamic <- Source.value 0
let region = Slice.claim [dynamic, ${values.slice(1).join(", ")}]
let length = Slice.length (&region)
let sorted_region = sort_work (!region, [(0, length)], 0)
let sorted = Slice.freeze (!sorted_region)
${checksumSource(values.length)}
`;
}

function checksumSource(size: number): string {
  const middle = Math.floor(size / 2);
  return `let first = case Array.get (sorted, 0) of
  #Some value => value
  #None => 0
let middle = case Array.get (sorted, ${middle}) of
  #Some value => value
  #None => 0
let last = case Array.get (sorted, ${size - 1}) of
  #Some value => value
  #None => 0
return first * 1000000 + middle * 1000 + last`;
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
  const middle = Math.floor(values.length / 2);
  const last = values[values.length - 1];
  if (last === undefined) throw new Error("benchmark input is empty");
  return BigInt(values[0] * 1_000_000 + values[middle] * 1_000 + last);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}
