import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import {
  decodeManifest,
  requiredFunction,
  requiredMemory,
} from "../abi_values.ts";

test("a completed sibling scope retires while another frame keeps its pending result", async () => {
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
    const firstScope = invoke("cabi_enter");
    const first = invoke(exported.name, firstScope, 10n);
    const secondScope = invoke("cabi_enter");
    const second = invoke(exported.name, secondScope, 20n);
    assert.equal(invoke("blot:poll", firstScope, first, 1024), 1);
    assert.equal(invoke("blot:poll", secondScope, second, 1024), 1);
    const pendingResult = new DataView(memory.buffer).getUint32(
      first + 16,
      true,
    );
    const before = invoke("blot:live-bytes");
    invoke("blot:cancel", secondScope, second);
    invoke("blot:release", secondScope, second);
    invoke("cabi_leave", secondScope);
    assert.equal(invoke("blot:live-scopes"), 1);
    assert.ok(invoke("blot:live-bytes") < before);
    new DataView(memory.buffer).setBigInt64(pendingResult, 42n, true);
    invoke("blot:resume", firstScope, first);
    assert.equal(invoke("blot:poll", firstScope, first, 1024), 2);
    const view = new DataView(memory.buffer);
    assert.equal(view.getBigInt64(view.getUint32(first + 20, true), true), 42n);
    invoke("blot:release", firstScope, first);
    invoke("cabi_leave", firstScope);
    assert.equal(invoke("blot:live-scopes"), 0);
    assert.equal(invoke("blot:live-allocations"), 0);
    assert.equal(invoke("blot:live-bytes"), 0);
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
    const scope = Number(requiredFunction(instance, "cabi_enter")());
    const context = Number(
      requiredFunction(instance, exported.name)(scope, 100000n),
    );
    let requests = 0;
    let warmBytes = 0;
    let warmRequests = 0;
    let warmResults = 0;
    const requestPointers = new Set<number>();
    const resultPointers = new Set<number>();
    for (;;) {
      const status = requiredFunction(instance, "blot:poll")(
        scope,
        context,
        1024,
      );
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
      requiredFunction(instance, "blot:resume")(scope, context);
    }
    assert.equal(requests, 100000);
    assert.equal(requestPointers.size, warmRequests);
    assert.equal(resultPointers.size, warmResults);
    assert.equal(memory.buffer.byteLength, warmBytes);
    requiredFunction(instance, "blot:release")(scope, context);
    requiredFunction(instance, "cabi_leave")(scope);
  } finally {
    compiler.destroy();
  }
});
