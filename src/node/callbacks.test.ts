import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import {
  type HostCallback,
  isHostCallback,
  moveHostCallback,
} from "../callbacks.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";

test("precompiled affine callbacks preserve captures and latent effects with evaluator/Wasm agreement", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/compiled_callback.blot",
    );
    assert.equal(evaluated.display, "23");
    const artifact = await compiler.compile(
      "examples/lib/compiled_callback.blot",
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    assert.equal(manifest.callbacks.length, 1);
    let captured: HostCallback | undefined;
    const run: HostOperation = async (_context, work) => {
      assert.ok(isHostCallback(work));
      captured = work;
      return await work.call();
    };
    const tick: HostOperation = async (_context, value) => {
      assert.equal(typeof value, "bigint");
      return await Promise.resolve(BigInt(String(value)) * 2n);
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        ["Executor", new Map([["run", run]])],
        ["Clock", new Map([["tick", tick]])],
      ]),
    );
    try {
      assert.equal(
        String(await hosted.callAsync("run", [10n])),
        evaluated.display,
      );
      assert.ok(captured !== undefined);
      await assert.rejects(captured.call(), /already been consumed/);
    } finally {
      await hosted.close();
    }
    const handled = await instantiateArtifact(
      await compiler.compile("examples/compiled_callback.blot"),
    );
    try {
      assert.equal(String(handled.call("default")), evaluated.display);
    } finally {
      await handled.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("callbacks cannot escape the defining artifact and uncalled callbacks are revoked", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const path = "/tmp/blot-revoked-callback.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Executor = @effect.host { .save = Effect.suspends ((Unit -> Int) -> Unit); }
const run :: Int -> Unit ~ { Executor }
const run = fn x => Executor.save (fn () => x + 1)
return run
`,
    );
    let captured: HostCallback | undefined;
    const save: HostOperation = (_context, work) => {
      assert.ok(isHostCallback(work));
      captured = work;
      assert.throws(
        () => moveHostCallback(work, root),
        /cannot escape its execution authority/,
      );
      return null;
    };
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Executor", new Map([["save", save]])]]),
      { scope: root },
    );
    try {
      await hosted.callAsync("default", [10n]);
      assert.ok(captured !== undefined);
      await assert.rejects(captured.call(), /released/);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("pure callback recursion yields, reuses tail frames, and observes cancellation", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-pure-callback.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Executor = @effect.host { .run = Effect.suspends ((Unit -> Int) -> Int); }
const rec count :: (Int, Int) -> Int
const rec count = fn (remaining, total) => do:
  if remaining < 1:
    return total
  return count (remaining - 1, total + 1)
const run :: Int -> Int ~ { Executor }
const run = fn n => Executor.run (fn () => count (n, 0))
const direct :: Int -> Int
const direct = fn n => count (n, 0)
return { .run = run; .direct = direct; }
`,
    );
    const artifact = await compiler.compile(path);
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    assert.equal(
      manifest.exports.find((entry: { sourceName: string }) =>
        entry.sourceName === "direct"
      ).execution,
      "direct",
    );
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm)),
      {
        "blot:host/Executor": {
          run() {
            throw new Error("unexpected direct executor call");
          },
        },
      },
    );
    const invoke = (name: string, ...arguments_: (number | bigint)[]) => {
      const fn = instance.exports[name];
      assert.equal(typeof fn, "function");
      return (fn as (...arguments_: (number | bigint)[]) => number)(
        ...arguments_,
      );
    };
    const memory = instance.exports.memory as WebAssembly.Memory;
    const scope = invoke("cabi_enter");
    const frame = invoke(manifest.callbacks[0].name, scope, 50000n);
    const initialBytes = memory.buffer.byteLength;
    let yields = 0;
    for (;;) {
      const status = invoke("blot:poll", scope, frame, 1024);
      if (status === 4) {
        yields += 1;
        continue;
      }
      assert.equal(status, 2);
      const view = new DataView(memory.buffer);
      assert.equal(
        view.getBigInt64(view.getUint32(frame + 20, true), true),
        50000n,
      );
      break;
    }
    assert.ok(yields > 10);
    assert.equal(memory.buffer.byteLength, initialBytes);
    invoke("blot:release", scope, frame);
    invoke("cabi_leave", scope);
    const run: HostOperation = (_context, work) => {
      assert.ok(isHostCallback(work));
      return work.call();
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Executor", new Map([["run", run]])]]),
    );
    try {
      const controller = new AbortController();
      const reason = new Error("cancel CPU work");
      const pending = hosted.callAsync("run", [1000000000n], {
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(reason), 10);
      try {
        await assert.rejects(pending, (error) => error === reason);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(hosted.call("direct", [100n]), 100n);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});
