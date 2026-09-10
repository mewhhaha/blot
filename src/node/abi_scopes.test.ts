import assert from "node:assert/strict";
import test from "node:test";
import { requiredFunction } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import {
  type HostedModule,
  type HostOperation,
  instantiateArtifact,
} from "../host.ts";

async function fixture(operation: HostOperation) {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-abi-scopes.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Echo = @effect.host { .wait = Effect.suspends (Text -> Text); }
let run :: Text -> Text ~ { Echo }
let run = fn text => Echo.wait text
let direct :: Text -> Text
let direct = fn text => text
return { .run = run; .direct = direct; }
`,
    );
    const artifact = await compiler.compile(path);
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Echo", new Map([["wait", operation]])]]),
    );
    return {
      hosted,
      async close() {
        try {
          await hosted.close();
        } finally {
          compiler.destroy();
        }
      },
    };
  } catch (cause) {
    compiler.destroy();
    throw cause;
  }
}

function allocationCounts(hosted: HostedModule) {
  return {
    scopes: Number(requiredFunction(hosted.instance, "blot:live-scopes")()),
    allocations: Number(
      requiredFunction(hosted.instance, "blot:live-allocations")(),
    ),
    bytes: Number(requiredFunction(hosted.instance, "blot:live-bytes")()),
  };
}
const empty = { scopes: 0, allocations: 0, bytes: 0 };

test("ABI4 synchronous calls copy results and leave their allocation scope after post-return", async () => {
  const runtime = await fixture((_context, text) => text);
  try {
    for (let index = 0; index < 64; index += 1) {
      const text = `scope ${index}: λ🙂`.repeat(256);
      assert.equal(runtime.hosted.call("direct", [text]), text);
      assert.deepEqual(allocationCounts(runtime.hosted), empty);
    }
    assert.throws(() => runtime.hosted.call("direct", [42n]), /expected text/);
    assert.deepEqual(allocationCounts(runtime.hosted), empty);
  } finally {
    await runtime.close();
  }
});

test("ABI4 concurrent calls retain independent scopes when a sibling completes first", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const admitted = Promise.withResolvers<void>();
  const observed: string[] = [];
  const runtime = await fixture((_context, text) => {
    assert.equal(typeof text, "string");
    if (typeof text !== "string") {
      throw new Error("checked text request was not text");
    }
    observed.push(text);
    if (observed.length === 2) admitted.resolve();
    if (text === "first") return first.promise;
    return second.promise;
  });
  try {
    const waitingFirst = runtime.hosted.callAsync("run", ["first"]);
    const waitingSecond = runtime.hosted.callAsync("run", ["second"]);
    await admitted.promise;
    assert.deepEqual(observed, ["first", "second"]);
    assert.equal(allocationCounts(runtime.hosted).scopes, 2);
    second.resolve("second result".repeat(512));
    assert.equal(await waitingSecond, "second result".repeat(512));
    assert.equal(allocationCounts(runtime.hosted).scopes, 1);
    assert.equal(runtime.hosted.call("direct", ["interleaved"]), "interleaved");
    assert.equal(allocationCounts(runtime.hosted).scopes, 1);
    first.resolve("first result".repeat(1024));
    assert.equal(await waitingFirst, "first result".repeat(1024));
    assert.deepEqual(allocationCounts(runtime.hosted), empty);
  } finally {
    first.resolve("drain");
    second.resolve("drain");
    await runtime.close();
  }
});

test("ABI4 cancellation retains its scope until admitted work drains", async () => {
  const admitted = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<string>();
  const controller = new AbortController();
  const reason = new Error("cancel scoped call");
  const runtime = await fixture(() => {
    admitted.resolve();
    return drain.promise;
  });
  let settled = false;
  try {
    const pending = runtime.hosted.callAsync("run", ["waiting"], {
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, (cause) => {
      settled = true;
      return cause === reason;
    });
    await admitted.promise;
    controller.abort(reason);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(allocationCounts(runtime.hosted).scopes, 1);
    drain.resolve("late result".repeat(1024));
    await rejected;
    assert.deepEqual(allocationCounts(runtime.hosted), empty);
  } finally {
    drain.resolve("drain");
    await runtime.close();
  }
});

test("ABI4 invalid host results release their context and scope before the next call", async () => {
  const runtime = await fixture(() => 42n);
  try {
    await assert.rejects(
      runtime.hosted.callAsync("run", ["invalid result"]),
      /expected text/,
    );
    assert.deepEqual(allocationCounts(runtime.hosted), empty);
    assert.equal(
      runtime.hosted.call("direct", ["still usable"]),
      "still usable",
    );
    assert.deepEqual(allocationCounts(runtime.hosted), empty);
  } finally {
    await runtime.close();
  }
});
