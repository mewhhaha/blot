import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import {
  decodeManifest,
  requiredFunction,
  requiredMemory,
} from "../abi_values.ts";

test("concurrent frames retain their arena until the last caller leaves", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-arena.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Counter = @effect.host { .next = Effect.suspends (Int -> Int); }
const run = fn total => Counter.next total
return { .run = run; }
`,
    );
    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm)),
      {
        "blot:host/Counter": {
          next() {
            throw new Error("unexpected direct import");
          },
        },
      },
    );
    const invoke = (name: string, ...arguments_: (number | bigint)[]) =>
      Number(requiredFunction(instance, name)(...arguments_));
    const memory = requiredMemory(instance, manifest);
    const exported = manifest.exports.find((entry) =>
      entry.sourceName === "run"
    );
    assert(exported !== undefined && exported.name !== null);
    invoke("cabi_enter");
    const checkpoint = invoke("cabi_realloc", 0, 0, 16, 16);
    const first = invoke(exported.name, 10n);
    const second = invoke(exported.name, 20n);
    assert.equal(invoke("blot:poll", first, 1024), 1);
    assert.equal(invoke("blot:poll", second, 1024), 1);
    const pendingResult = new DataView(memory.buffer).getUint32(
      first + 16,
      true,
    );
    invoke("blot:cancel", second);
    invoke("blot:release", second);
    const retained = invoke("cabi_realloc", 0, 0, 16, 16);
    assert.ok(retained > first && retained > second);
    new DataView(memory.buffer).setBigInt64(pendingResult, 42n, true);
    invoke("blot:resume", first);
    assert.equal(invoke("blot:poll", first, 1024), 2);
    const view = new DataView(memory.buffer);
    assert.equal(view.getBigInt64(view.getUint32(first + 20, true), true), 42n);
    invoke("blot:release", first);
    assert.ok(invoke("cabi_realloc", 0, 0, 16, 16) > retained);
    invoke("cabi_leave");
    invoke("cabi_enter");
    assert.equal(invoke("cabi_realloc", 0, 0, 16, 16), checkpoint);
    invoke("cabi_leave");
  } finally {
    compiler.destroy();
  }
});

test("a scalar event fold reuses request slots over 100000 suspensions", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-memory.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Counter = @effect.host { .next = Effect.suspends (Int -> Int); }
let run :: Int -> Int ~ { Counter }
let run = fn count => do:
  let total = 0
  for index in Iter.range (0, count):
    use next <- Counter.next total
    total := next
  return total
return { .run = run; }
`,
    );
    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm)),
      {
        "blot:host/Counter": {
          next() {
            throw new Error("suspension reached a direct import");
          },
        },
      },
    );
    const memory = requiredMemory(instance, manifest);
    const exported = manifest.exports.find((entry) =>
      entry.sourceName === "run"
    );
    assert(exported !== undefined && exported.name !== null);
    requiredFunction(instance, "cabi_enter")();
    const context = Number(requiredFunction(instance, exported.name)(100000n));
    let requests = 0;
    let warmBytes = 0;
    let warmRequests = 0;
    let warmResults = 0;
    const requestPointers = new Set<number>();
    const resultPointers = new Set<number>();
    for (;;) {
      const status = requiredFunction(instance, "blot:poll")(context, 1024);
      if (status === 4) continue;
      const view = new DataView(memory.buffer);
      if (status === 2) {
        assert.equal(
          view.getBigInt64(view.getUint32(context + 20, true), true),
          100000n,
        );
        break;
      }
      assert.equal(status, 1);
      const argument = view.getUint32(context + 12, true);
      const result = view.getUint32(context + 16, true);
      view.setBigInt64(result, view.getBigInt64(argument, true) + 1n, true);
      requestPointers.add(argument);
      resultPointers.add(result);
      requests += 1;
      if (requests === 100) {
        warmBytes = memory.buffer.byteLength;
        warmRequests = requestPointers.size;
        warmResults = resultPointers.size;
      }
      requiredFunction(instance, "blot:resume")(context);
    }
    assert.equal(requests, 100000);
    assert.equal(requestPointers.size, warmRequests);
    assert.equal(resultPointers.size, warmResults);
    assert.equal(memory.buffer.byteLength, warmBytes);
    requiredFunction(instance, "blot:release")(context);
    requiredFunction(instance, "cabi_leave")();
  } finally {
    compiler.destroy();
  }
});
