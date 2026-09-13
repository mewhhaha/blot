import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";

test("collection adapters sequence suspended callbacks and stop at the requested element", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/lib/collection_libraries.blot";
    const trace: RuntimeValue[] = [];
    let cancelled = false;
    let started: (() => void) | undefined;
    let drained = false;
    const visit: HostOperation = ({ signal }, value) => {
      trace.push(value);
      assert.equal(typeof value, "bigint");
      if (!cancelled) return Promise.resolve(BigInt(String(value)) * 2n);
      if (started === undefined) {
        throw new Error("cancellation test omitted its start observer");
      }
      started();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          queueMicrotask(() => {
            drained = true;
            reject(signal.reason);
          });
        }, { once: true })
      );
    };
    const guest = await instantiateArtifact(
      await compiler.compile(path),
      new Map([
        ["Visit", new Map([["value", visit]])],
      ]),
    );
    try {
      for (
        const [name, expected, visits] of [
          ["map", [2n, 4n, 6n], [1n, 2n, 3n]],
          ["filter", [2n, 3n], [1n, 2n, 3n]],
          ["fold", 12n, [1n, 2n, 3n]],
          ["find", { kind: "variant", name: "Some", payload: 2n }, [1n, 2n]],
        ] as const
      ) {
        trace.length = 0;
        assert.deepEqual(await guest.callAsync(name, [[1n, 2n, 3n]]), expected);
        assert.deepEqual(trace, visits);
      }
      trace.length = 0;
      assert.equal(await guest.callAsync("first", [100n]), 20n);
      assert.deepEqual(trace, [0n, 10n]);
      trace.length = 0;
      assert.equal(await guest.callAsync("first", [0n]), -1n);
      assert.deepEqual(trace, []);
      assert.deepEqual(await guest.callAsync("map", [[]]), []);
      assert.deepEqual(await guest.callAsync("find", [[]]), {
        kind: "variant",
        name: "None",
      });
      cancelled = true;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      const reason = new Error("stop collection traversal");
      const pending = guest.callAsync("map", [[1n, 2n, 3n]], {
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, (error) => error === reason);
      await entered;
      controller.abort(reason);
      await rejected;
      assert.equal(drained, true);
      assert.deepEqual(trace, [1n]);
    } finally {
      await guest.close();
    }
    await assert.rejects(
      () =>
        compiler.checkSource(
          "/tmp/blot-borrowed-map.blot",
          `open import "blot:prelude"
const Pipeline = import "blot:pipeline"
const Visit = @effect.host { .value = Effect.suspends (Int -> Int); }
const run = fn &values => do:
  use mapped <- values |> Pipeline.map_with (fn value => Visit.value value)
  return (mapped, Array.length (&values))
return run
`,
        ),
      /BLOT_BORROW_ACROSS_SUSPENSION|BLOT_BORROW/,
    );
  } finally {
    compiler.destroy();
  }
});
