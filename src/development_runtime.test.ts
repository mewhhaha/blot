import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { flattenedAbiType } from "./compiler/backend/runtime/abi.ts";
import type { BlotAbiType } from "./compiler/backend/runtime/abi.ts";
import type { DevelopmentBuild } from "./development.ts";
import { developmentRevision } from "./development_identity.ts";
import { DevelopmentRuntime } from "./development_runtime.ts";
import { wasmFixture } from "../test_support/wasm_fixture.ts";

test("failed argument copying releases already borrowed allocations", async () => {
  const fixture = await bridgeFixture({ kind: "unit" });
  assert.throws(() => fixture.invoke(64, 4, 65_537, 1), /exceeds/);
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.deepEqual(fixture.freed, [["provider", 1024]]);
});

test("provider traps release argument allocations in reverse order", async () => {
  const fixture = await bridgeFixture({ kind: "unit" }, { callFails: true });
  assert.throws(() => fixture.invoke(64, 4, 68, 4), /provider failed/);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.deepEqual(fixture.freed, [["provider", 1028], ["provider", 1024]]);
});

test("post-return traps release borrowed parameters and untransferred results", async () => {
  const fixture = await bridgeFixture({ kind: "text" }, { postFails: true });
  fixture.providerView().setUint32(128, 64, true);
  fixture.providerView().setUint32(132, 4, true);
  assert.throws(() => fixture.invoke(64, 4, 68, 4, 256), /post-return failed/);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.equal(fixture.outstanding.get("consumer")?.size, 0);
  assert.equal(fixture.posts(), 1);
});

test("partially copied results are released when a later field is invalid", async () => {
  const fixture = await bridgeFixture({
    kind: "record",
    fields: [
      { name: "a", type: { kind: "text" } },
      { name: "b", type: { kind: "text" } },
    ],
  });
  const view = fixture.providerView();
  view.setUint32(128, 64, true);
  view.setUint32(132, 4, true);
  view.setUint32(136, 65_537, true);
  view.setUint32(140, 1, true);
  assert.throws(() => fixture.invoke(64, 4, 68, 4, 256), /exceeds/);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.equal(fixture.outstanding.get("consumer")?.size, 0);
  assert.equal(fixture.posts(), 1);
});

test("successful result copies survive cleanup and memory growth", async () => {
  const fixture = await bridgeFixture({ kind: "text" }, { grow: true });
  fixture.providerView().setUint32(128, 64, true);
  fixture.providerView().setUint32(132, 4, true);
  fixture.invoke(64, 4, 68, 4, 256);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.equal(fixture.outstanding.get("consumer")?.size, 1);
  assert.equal(fixture.posts(), 1);
  const view = new DataView(fixture.consumerMemory().buffer);
  const pointer = view.getUint32(256, true);
  assert.equal(view.getUint32(260, true), 4);
  assert.deepEqual(
    [...new Uint8Array(fixture.consumerMemory().buffer, pointer, 4)],
    [1, 2, 3, 4],
  );
});

test("allocator failure while copying arguments releases earlier copies", async () => {
  const fixture = await bridgeFixture({ kind: "unit" }, {
    allocationFailsAt: 2,
  });
  assert.throws(() => fixture.invoke(64, 4, 68, 4), /allocation failed/);
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.deepEqual(fixture.freed, [["provider", 1024]]);
});

test("a release trap does not skip the remaining parameter releases", async () => {
  const fixture = await bridgeFixture({ kind: "unit" }, { releaseFailsAt: 1 });
  assert.throws(() => fixture.invoke(64, 4, 68, 4), /release failed/);
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.deepEqual(fixture.freed, [["provider", 1028], ["provider", 1024]]);
});

test("successful unit and direct scalar results preserve cleanup", async () => {
  for (const result of [{ kind: "unit" }, { kind: "float-64" }] as const) {
    const fixture = await bridgeFixture(result);
    const value = fixture.invoke(64, 4, 68, 4);
    if (result.kind === "unit") assert.equal(value, undefined);
    else assert.equal(value, 128);
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.posts(), 0);
    assert.equal(fixture.outstanding.get("provider")?.size, 0);
  }
});

test("nested first-order ABI results retain values across allocation growth", async () => {
  const element = {
    kind: "sealed",
    name: "Element",
    inner: {
      kind: "record",
      fields: [
        { name: "a", type: { kind: "boolean" } },
        { name: "b", type: { kind: "signed-integer-64" } },
        { name: "c", type: { kind: "float-32" } },
        { name: "d", type: { kind: "float-64" } },
        { name: "e", type: { kind: "text" } },
      ],
    },
  } as const;
  const fixture = await bridgeFixture({
    kind: "record",
    fields: [
      { name: "a", type: { kind: "array", element } },
      { name: "b", type: { kind: "boolean" } },
      { name: "c", type: { kind: "float-32" } },
      { name: "d", type: { kind: "float-64" } },
      { name: "e", type: { kind: "signed-integer-64" } },
      {
        name: "f",
        type: {
          kind: "sealed",
          name: "Box",
          inner: {
            kind: "variant",
            cases: [{ name: "None" }, {
              name: "Some",
              payload: { kind: "text" },
            }],
          },
        },
      },
      { name: "g", type: { kind: "unit" } },
    ],
  }, { grow: true });
  // These independently specified canonical offsets do not use the layout cache.
  const source = fixture.providerView();
  source.setUint32(128, 512, true);
  source.setUint32(132, 2, true);
  source.setUint8(136, 1);
  source.setFloat32(140, -1.25, true);
  source.setFloat64(144, 9.5, true);
  source.setBigInt64(152, -1_234_567_890_123n, true);
  source.setUint8(160, 1);
  source.setUint32(164, 68, true);
  source.setUint32(168, 4, true);
  for (let index = 0; index < 2; index += 1) {
    const offset = 512 + index * 40;
    source.setUint8(offset, index);
    source.setBigInt64(offset + 8, BigInt(index - 10), true);
    source.setFloat32(offset + 16, index + 0.25, true);
    source.setFloat64(offset + 24, index - 9.5, true);
    source.setUint32(offset + 32, 64 + index * 4, true);
    source.setUint32(offset + 36, 4, true);
  }
  fixture.invoke(64, 4, 68, 4, 256);
  const target = new DataView(fixture.consumerMemory().buffer);
  assert.equal(target.getUint32(260, true), 2);
  assert.equal(target.getUint8(264), 1);
  assert.equal(target.getFloat32(268, true), -1.25);
  assert.equal(target.getFloat64(272, true), 9.5);
  assert.equal(target.getBigInt64(280, true), -1_234_567_890_123n);
  assert.equal(target.getUint8(288), 1);
  const variantText = target.getUint32(292, true);
  assert.equal(target.getUint32(296, true), 4);
  assert.deepEqual(
    [...new Uint8Array(target.buffer, variantText, 4)],
    [5, 6, 7, 8],
  );
  const array = target.getUint32(256, true);
  for (let index = 0; index < 2; index += 1) {
    const offset = array + index * 40;
    assert.equal(target.getUint8(offset), index);
    assert.equal(target.getBigInt64(offset + 8, true), BigInt(index - 10));
    assert.equal(target.getFloat32(offset + 16, true), index + 0.25);
    assert.equal(target.getFloat64(offset + 24, true), index - 9.5);
    const text = target.getUint32(offset + 32, true);
    assert.equal(target.getUint32(offset + 36, true), 4);
    assert.deepEqual(
      [...new Uint8Array(target.buffer, text, 4)],
      Array.from({ length: 4 }, (_, byte) => 1 + index * 4 + byte),
    );
  }
  assert.equal(fixture.outstanding.get("provider")?.size, 0);
  assert.equal(fixture.outstanding.get("consumer")?.size, 4);
  assert.equal(fixture.posts(), 1);
  fixture.providerView().setUint8(68, 99);
  assert.equal(new Uint8Array(target.buffer, variantText, 4)[0], 5);
});

async function bridgeFixture(
  result: BlotAbiType,
  options: {
    callFails?: boolean;
    postFails?: boolean;
    grow?: boolean;
    allocationFailsAt?: number;
    releaseFailsAt?: number;
  } = {},
) {
  const function_ = {
    parameters: [{ kind: "text" }, { kind: "text" }] as const,
    result,
  };
  const width = flattenedAbiType(result).length;
  const parameters = function_.parameters.flatMap(flattenedAbiType);
  const consumerParameters = [...parameters];
  if (width > 1) consumerParameters.push("i32");
  const results: ("i32" | "i64" | "f32" | "f64")[] = [];
  if (width === 1) results.push(...flattenedAbiType(result));
  const providerResults = [...results];
  if (width > 1) providerResults.push("i32");
  let postReturn: string | null = null;
  if (width > 1) postReturn = "cabi_post_echo";
  const abi = {
    major: 3,
    minor: 0,
    memory: "memory32",
    stringEncoding: "utf-8",
    maximumFlatParameters: 16,
    maximumFlatResults: 1,
    memoryExport: "memory",
    reallocExport: "cabi_realloc",
  } as const;
  const providerManifest = {
    format: "blot-core-wasm",
    abi,
    source: "/provider.blot",
    imports: [],
    exports: [{
      sourceName: "echo",
      name: "blot:dev:echo",
      phase: "runtime",
      function: function_,
      postReturn,
      effects: [],
      ownership: "owned",
      suspension: "never",
    }],
    links: [],
  };
  const consumerManifest = {
    format: "blot-core-wasm",
    abi,
    source: "/consumer.blot",
    imports: [],
    exports: [],
    links: [{
      unit: "provider",
      name: "echo",
      module: "blot:dev/provider",
      function: function_,
    }],
  };
  const providerBytes = new TextEncoder().encode(
    JSON.stringify(providerManifest),
  );
  const consumerBytes = new TextEncoder().encode(
    JSON.stringify(consumerManifest),
  );
  const reallocateType = {
    parameters: ["i32", "i32", "i32", "i32"],
    results: ["i32"],
  } as const;
  const provider = wasmFixture({
    manifest: providerBytes,
    types: [reallocateType, { parameters, results: providerResults }, {
      parameters: ["i32"],
      results: [],
    }],
    imports: [
      { module: "fixture", name: "reallocate", type: 0 },
      { module: "fixture", name: "call", type: 1 },
      { module: "fixture", name: "post", type: 2 },
    ],
    exports: { cabi_realloc: 0, "blot:dev:echo": 1, cabi_post_echo: 2 },
  });
  const consumer = wasmFixture({
    manifest: consumerBytes,
    types: [reallocateType, { parameters: consumerParameters, results }],
    imports: [
      { module: "fixture", name: "reallocate", type: 0 },
      { module: "blot:dev/provider", name: "blot:dev:echo", type: 1 },
    ],
    exports: { cabi_realloc: 0, invoke: 1 },
  });
  const changedUnits = [
    {
      name: "consumer",
      root: "/consumer.blot",
      wasm: consumer,
      manifestBytes: consumerBytes,
    },
    {
      name: "provider",
      root: "/provider.blot",
      wasm: provider,
      manifestBytes: providerBytes,
    },
  ].map((unit) => ({
    ...unit,
    capabilities: [],
    interfaceDigest: hash(unit.manifestBytes),
    implementationDigest: hash(unit.wasm),
    wasmDigest: hash(unit.wasm),
    artifactSource: "compiled" as const,
  }));
  const build = {
    baseRevision: undefined,
    revision: await developmentRevision("consumer", changedUnits),
    entryUnit: "consumer",
    changedUnits,
    retainedUnits: [],
    removedUnits: [],
    edges: [{ consumer: "consumer", provider: "provider", name: "echo" }],
    durationMilliseconds: 0,
  } as unknown as DevelopmentBuild;
  const outstanding = new Map<string, Map<number, number>>();
  const freed: [string, number][] = [];
  let calls = 0;
  let posts = 0;
  const runtime = new DevelopmentRuntime((context) => {
    let next = 1024;
    let allocations = 0;
    let releases = 0;
    const live = new Map<number, number>();
    outstanding.set(context.unit, live);
    return {
      fixture: {
        reallocate(
          pointer: number,
          size: number,
          _alignment: number,
          newSize: number,
        ) {
          if (newSize === 0) {
            assert.equal(live.get(pointer), size);
            live.delete(pointer);
            freed.push([context.unit, pointer]);
            releases += 1;
            if (releases === options.releaseFailsAt) {
              throw new Error("release failed");
            }
            return 0;
          }
          allocations += 1;
          if (allocations === options.allocationFailsAt) {
            throw new Error("allocation failed");
          }
          if (options.grow === true) context.memory().grow(1);
          const allocated = next;
          next += newSize;
          live.set(allocated, newSize);
          return allocated;
        },
        call() {
          calls += 1;
          if (options.callFails === true) throw new Error("provider failed");
          return 128;
        },
        post() {
          posts += 1;
          if (options.postFails === true) throw new Error("post-return failed");
        },
      },
    };
  });
  runtime.commitActivation(await runtime.prepareActivation(build));
  const providerMemory = runtime.unitInstance("provider").exports
    .memory as WebAssembly.Memory;
  const consumerMemory = runtime.entryInstance.exports
    .memory as WebAssembly.Memory;
  for (const memory of [providerMemory, consumerMemory]) {
    new Uint8Array(memory.buffer, 64, 8).set([1, 2, 3, 4, 5, 6, 7, 8]);
  }
  return {
    invoke: runtime.entryInstance.exports.invoke as (
      ...values: number[]
    ) => unknown,
    outstanding,
    freed,
    calls: () => calls,
    posts: () => posts,
    providerView: () => new DataView(providerMemory.buffer),
    consumerMemory: () => consumerMemory,
  };
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
