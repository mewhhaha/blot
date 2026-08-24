import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coreRuntimeImportModule,
  createRuntimeHeap,
  createRuntimeImports,
} from "@mewhhaha/gpupaper/runtime";
import { coreTextLiteralsSectionName } from "@mewhhaha/gpupaper";
import { Compiler } from "../../src/compiler/session.ts";

const sizes = [16, 32, 64, 128];
const samples = 11;
const warmups = 3;
const dynamic = 100;

interface Counters {
  empty: number;
  growOwned: number;
  growPersistent: number;
  new_: number;
  writeOwned: number;
  writePersistent: number;
}

interface Measurement extends Counters {
  readonly algorithm: "persistent-map" | "owned-ordered-map";
  readonly compileMs: number;
  readonly medianUs: number;
  readonly ownedWriteSites: number;
  readonly persistentWriteSites: number;
  readonly size: number;
  readonly wasmBytes: number;
}

const directory = await mkdtemp(join(tmpdir(), "blot-owned-maps-"));
const compiler = await Compiler.create();
try {
  await compiler.check(
    new URL("../../examples/minimal.blot", import.meta.url).pathname,
  );
  const measurements: Measurement[] = [];
  for (const size of sizes) {
    measurements.push(
      await measure(
        compiler,
        directory,
        "persistent-map",
        size,
        persistentSource(size),
      ),
    );
    measurements.push(
      await measure(
        compiler,
        directory,
        "owned-ordered-map",
        size,
        ownedSource(size),
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
    "persistent write sites": measurement.persistentWriteSites,
    "owned write sites": measurement.ownedWriteSites,
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
  const counted = await instantiate(artifact.wasm, dynamic);
  const observed = counted.run();
  const expected = checksum(size, dynamic);
  if (observed !== expected) {
    throw new Error(
      `${algorithm} n=${size} returned ${observed}; expected ${expected}`,
    );
  }
  for (let index = 0; index < warmups; index += 1) {
    const warm = await instantiate(artifact.wasm, dynamic);
    warm.run();
  }
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const trial = await instantiate(artifact.wasm, dynamic);
    const before = performance.now();
    trial.run();
    times.push((performance.now() - before) * 1_000);
  }
  const operations = hir.functions.flatMap((fn) =>
    fn.blocks.flatMap((block) => block.operations)
  );
  return {
    algorithm,
    compileMs,
    medianUs: median(times),
    ownedWriteSites:
      operations.filter((operation) =>
        operation.kind === "store.write" && operation.update === "owned-reuse"
      ).length,
    persistentWriteSites:
      operations.filter((operation) =>
        operation.kind === "store.write" && operation.update === "persistent"
      ).length,
    size,
    wasmBytes: artifact.wasm.byteLength,
    ...counted.counters,
  };
}

function persistentSource(size: number): string {
  return `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

let rec update_all :: (Map.of (Text, Int), Int, Int) -> Map.of (Text, Int)
let rec update_all = fn (entries, index, base) =>
  return case Array.get (entries, index) of
    #None => entries
    #Some entry =>
      return case Array.set (entries, index, (entry.0, base + index)) of
        #Some updated => update_all (updated, index + 1, base)
        #None => entries

dynamic <- Source.value 0
let entries = [${entries(size, "dynamic")}]
let updated = update_all (entries, 0, dynamic)
${checksumSource(size, "updated")}
`;
}

function ownedSource(size: number): string {
  return `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }

let replace_keep ::
  (OrderedTextMap.of Int, Text, Int) -> (OrderedTextMap.of Int, Int)
let replace_keep = fn (!entries, key, value) =>
  return case OrderedTextMap.replace ((!entries), key, value) of
    #MapReplaced (previous, !updated) => (updated, previous)
    #MapMissing (returned, !original) => (original, returned)

let rec update_all ::
  (OrderedTextMap.of Int, [Text], Int, Int) -> OrderedTextMap.of Int
let rec update_all = fn (!entries, keys, index, base) =>
  let count = Array.length keys
  if count <= index:
    return entries
  else:
    let key = case Array.get (keys, index) of
      #Some found => found
      #None => @panic "owned-map benchmark key escaped its input"
    let (updated, previous) = replace_keep ((!entries), key, base + index)
    return update_all (!updated, keys, index + 1, base)

dynamic <- Source.value 0
let entries = OrderedTextMap.copy [${entries(size, "dynamic")}]
let keys = [${keys(size)}]
let updated = update_all (!entries, keys, 0, dynamic)
let frozen = OrderedTextMap.freeze (!updated)
${checksumSource(size, "frozen")}
`;
}

function entries(size: number, first: string): string {
  return Array.from({ length: size }, (_, index) => {
    let value = String(index);
    if (index === 0) value = first;
    return `("${key(index)}", ${value})`;
  }).join(", ");
}

function keys(size: number): string {
  return Array.from({ length: size }, (_, index) => `"${key(index)}"`)
    .join(", ");
}

function key(index: number): string {
  return index.toString().padStart(4, "0");
}

function checksumSource(size: number, name: string): string {
  const middle = Math.floor(size / 2);
  return `let first = case Array.get (${name}, 0) of
  #Some entry => entry.1
  #None => 0
let middle = case Array.get (${name}, ${middle}) of
  #Some entry => entry.1
  #None => 0
let last = case Array.get (${name}, ${size - 1}) of
  #Some entry => entry.1
  #None => 0
return first * 1000000 + middle * 1000 + last`;
}

function checksum(size: number, base: number): bigint {
  const middle = Math.floor(size / 2);
  return BigInt(
    base * 1_000_000 + (base + middle) * 1_000 + base + size - 1,
  );
}

async function instantiate(
  wasm: Uint8Array,
  value: number,
): Promise<{ readonly counters: Counters; readonly run: () => bigint }> {
  const counters: Counters = {
    empty: 0,
    growOwned: 0,
    growPersistent: 0,
    new_: 0,
    writeOwned: 0,
    writePersistent: 0,
  };
  const module = await WebAssembly.compile(wasm as BufferSource);
  const sections = WebAssembly.Module.customSections(
    module,
    coreTextLiteralsSectionName,
  );
  let textLiterals: readonly string[] = [];
  if (sections.length === 1) {
    textLiterals = JSON.parse(
      new TextDecoder().decode(sections[0]),
    ) as readonly string[];
  }
  const runtime = createRuntimeImports(createRuntimeHeap(textLiterals));
  count(runtime, "store_empty", counters, "empty");
  count(runtime, "store_grow_owned", counters, "growOwned");
  count(runtime, "store_grow_persistent", counters, "growPersistent");
  count(runtime, "store_new", counters, "new_");
  count(runtime, "store_write_owned", counters, "writeOwned");
  count(runtime, "store_write_persistent", counters, "writePersistent");
  const instance = await WebAssembly.instantiate(module, {
    [coreRuntimeImportModule]: runtime,
    "blot:host/Source": {
      value() {
        return BigInt(value);
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
  counter: keyof Counters,
): void {
  const original = imports[name];
  if (typeof original !== "function") {
    throw new Error(`gpupaper runtime omitted ${name}`);
  }
  imports[name] = (...arguments_: unknown[]) => {
    counters[counter] += 1;
    return original(...arguments_);
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}
