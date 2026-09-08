import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import {
  decodeManifest,
  requiredFunction,
  requiredMemory,
} from "../abi_values.ts";

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
