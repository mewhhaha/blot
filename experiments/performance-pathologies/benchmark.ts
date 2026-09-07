import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Compiler } from "../../src/compiler.ts";
import { parseOptions } from "./options.ts";
import {
  nestedRecordSource,
  textSearchInstance,
  textSearchSource,
} from "./workloads.ts";

const { depths, sizes, samples } = parseOptions(process.argv.slice(2));
const directory = await mkdtemp(join(tmpdir(), "blot-pathology-benchmark-"));
const compiler = await Compiler.create();
const compilation: {
  depth: number;
  sourceSha256: string;
  milliseconds: number[];
  wasmBytes: number;
}[] = [];
const runtime: {
  size: number;
  queryBytes: number;
  containsMilliseconds: number[];
  findMilliseconds: number[];
}[] = [];
try {
  const warmup = join(directory, "warmup.blot");
  await writeFile(warmup, "return 42\n");
  await compiler.compile(warmup);
  for (const depth of depths) {
    const source = nestedRecordSource(depth);
    const milliseconds: number[] = [];
    let wasmBytes = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const path = join(directory, `record-${depth}-${sample}.blot`);
      await writeFile(path, source);
      const begin = performance.now();
      const artifact = await compiler.compile(path);
      milliseconds.push(performance.now() - begin);
      wasmBytes = artifact.wasm.length;
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
      );
      const memory = instance.exports.memory;
      const nested = instance.exports["blot:default"];
      const manifest = JSON.parse(
        new TextDecoder().decode(artifact.manifestBytes),
      );
      const exported = manifest.exports.find((entry: { sourceName: string }) =>
        entry.sourceName === "default"
      );
      const postReturn = instance.exports[exported.postReturn];
      assert.ok(memory instanceof WebAssembly.Memory);
      assert.equal(typeof nested, "function");
      assert.equal(typeof postReturn, "function");
      const pointer = (nested as (input: bigint) => number)(41n);
      try {
        const view: DataView = new DataView(memory.buffer);
        assert.equal(view.getBigInt64(pointer, true), 41n);
        assert.equal(view.getBigInt64(pointer + 8, true), 42n);
      } finally {
        (postReturn as (pointer: number) => void)(pointer);
      }
    }
    compilation.push({
      depth,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      milliseconds,
      wasmBytes,
    });
  }
  const path = join(directory, "search.blot");
  await writeFile(path, textSearchSource);
  const artifact = await compiler.compile(path);
  const { instance } = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const search = textSearchInstance(instance);
  for (const size of sizes) {
    const query = "a".repeat(Math.max(1, Math.floor(size / 8))) + "b";
    const input = search.input("a".repeat(size), query);
    assert.equal(input.contains(), 0n);
    assert.equal(input.find(0), -1n);
    for (let warm = 0; warm < 3; warm += 1) {
      input.contains();
      input.find(0);
    }
    const containsMilliseconds: number[] = [];
    const findMilliseconds: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      let begin = performance.now();
      const contained = input.contains();
      containsMilliseconds.push(performance.now() - begin);
      begin = performance.now();
      const found = input.find(0);
      findMilliseconds.push(performance.now() - begin);
      assert.equal(contained, 0n);
      assert.equal(found, -1n);
    }
    runtime.push({
      size,
      queryBytes: query.length,
      containsMilliseconds,
      findMilliseconds,
    });
  }
  console.log(JSON.stringify(
    {
      schema: "blot-performance-pathologies-v1",
      node: process.versions.node,
      v8: process.versions.v8,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      compiler: JSON.parse(
        await readFile(
          new URL(
            "../../generated/compiler/compiler-artifact.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
      samples,
      compilation,
      runtime,
    },
    null,
    2,
  ));
} finally {
  compiler.destroy();
  await rm(directory, { recursive: true, force: true });
}
