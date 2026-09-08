import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";

test("one generic host operation accepts independently specialized argument and result types", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/generic_host_effect.blot",
    );
    const artifact = await compiler.compile(
      "examples/lib/generic_host_effect.blot",
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    assert.deepEqual(
      manifest.imports.map((operation: { sourceName: string }) =>
        operation.sourceName
      ),
      ["copy", "copy"],
    );
    assert.equal(
      new Set(
        manifest.imports.map((operation: { name: string }) => operation.name),
      ).size,
      2,
    );
    const observed: unknown[] = [];
    const copy: HostOperation = async (_context, value) => {
      observed.push(value);
      return value;
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Echo", new Map([["copy", copy]])]]),
    );
    try {
      const result = await hosted.callAsync("run", [42n]);
      assert.deepEqual(result, {
        kind: "record",
        fields: new Map<string, bigint | string>([["number", 42n], ["text", "hello"]]),
      });
      assert.deepEqual(observed, [42n, "hello"]);
      const handled = await instantiateArtifact(
        await compiler.compile("examples/generic_host_effect.blot"),
      );
      try {
        assert.deepEqual(handled.call("default"), ["42", "hello"]);
      } finally {
        handled.destroy();
      }
      assert.equal(evaluated.display, '["42", "hello"]');
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("nested resumable calls agree with the Rust evaluator and source handlers", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate("examples/suspension.blot");
    assert.equal(evaluated.display, "26");
    const artifact = await compiler.compile("examples/lib/suspension.blot");
    const tick: HostOperation = async (_context, index) => {
      assert.equal(typeof index, "bigint");
      return BigInt(String(index)) * 2n;
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Clock", new Map([["tick", tick]])]]),
    );
    try {
      assert.equal(
        String(await hosted.callAsync("run", [10n])),
        evaluated.display,
      );
    } finally {
      await hosted.close();
    }
    const handled = await instantiateArtifact(
      await compiler.compile("examples/suspension.blot"),
    );
    try {
      assert.equal(String(handled.call("default")), evaluated.display);
    } finally {
      handled.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("emitted Wasm suspends a loop and resumes its live accumulator", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-loop.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Clock = @effect.host { .tick = Effect.suspends (Int -> Int); }
let run :: Int -> Int ~ { Clock }
let run = fn initial => do:
  let total = initial
  for index in Iter.range (0, 4):
    use value <- Clock.tick index
    total := total + value
  return total
return run
`,
    );
    const artifact = await compiler.compile(path);
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    assert.equal(manifest.abi.major, 3);
    assert.equal(manifest.exports[0].execution, "resumable");
    assert.equal(manifest.imports[0].contract.suspends, true);
    const module = await WebAssembly.compile(Uint8Array.from(artifact.wasm));
    const instance = await WebAssembly.instantiate(module, {
      "blot:host/Clock": {
        tick() {
          throw new Error("suspending operation called synchronously");
        },
      },
    });
    const memory = instance.exports.memory as WebAssembly.Memory;
    const invoke = (name: string, ...arguments_: (number | bigint)[]) => {
      const fn = instance.exports[name];
      assert.equal(typeof fn, "function");
      return (fn as (...arguments_: (number | bigint)[]) => number)(
        ...arguments_,
      );
    };
    const context = invoke(manifest.exports[0].name, 10n);
    const observed: bigint[] = [];
    let yields = 0;
    for (;;) {
      const status = invoke("blot:poll", context, 1);
      if (status === 4) {
        yields += 1;
        continue;
      }
      const view = new DataView(memory.buffer);
      if (status === 2) {
        assert.equal(
          view.getBigInt64(view.getUint32(context + 20, true), true),
          22n,
        );
        break;
      }
      assert.equal(status, 1);
      const argument = view.getBigInt64(
        view.getUint32(context + 12, true),
        true,
      );
      observed.push(argument);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      new DataView(memory.buffer).setBigInt64(
        view.getUint32(context + 16, true),
        argument * 2n,
        true,
      );
      invoke("blot:resume", context);
    }
    assert.deepEqual(observed, [0n, 1n, 2n, 3n]);
    assert.ok(yields > 0);
    invoke("blot:release", context);
  } finally {
    compiler.destroy();
  }
});

test("async calls on one instance retain separate frames and copy aggregate values", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-text.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Http = @effect.host { .get = Effect.suspends (Text -> Text); }
let decorate :: Text -> Text ~ { Http }
let decorate = fn path => do:
  use text <- Http.get path
  return path <> ":" <> text
return decorate
`,
    );
    const artifact = await compiler.compile(path);
    const pending = new Map<string, (text: string) => void>();
    const get: HostOperation = (_context, path) => {
      assert.equal(typeof path, "string");
      return new Promise<string>((resolve) =>
        pending.set(String(path), resolve)
      );
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Http", new Map([["get", get]])]]),
    );
    try {
      assert.throws(() => hosted.call("default", ["a"]), /callAsync/);
      const first = hosted.callAsync("default", ["a"]);
      const second = hosted.callAsync("default", ["b"]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(pending.size, 2);
      const large = "世界".repeat(20_000);
      pending.get("b")!(large);
      assert.equal(await second, `b:${large}`);
      pending.get("a")!("first");
      assert.equal(await first, "a:first");
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("cancellation drains the host operation before releasing a resumable call", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-cancel.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Clock = @effect.host { .wait = Effect.suspends (Int -> Int); }
let run = fn delay => do:
  use result <- Clock.wait delay
  return result + 1
return run
`,
    );
    const artifact = await compiler.compile(path);
    const trace: string[] = [];
    const wait: HostOperation = ({ signal }, delay) =>
      new Promise<bigint>((resolve, reject) => {
        if (delay === 0n) {
          resolve(41n);
          return;
        }
        trace.push("started");
        signal.addEventListener("abort", () => {
          trace.push("cancelled");
          setTimeout(() => {
            trace.push("drained");
            reject(signal.reason);
          }, 0);
        }, { once: true });
      });
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Clock", new Map([["wait", wait]])]]),
    );
    const controller = new AbortController();
    const reason = new Error("cancel this call");
    const result = hosted.callAsync("default", [1n], {
      signal: controller.signal,
    });
    const rejected = assert.rejects(result, (error) => error === reason);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.throws(() => hosted.destroy(), /active calls/);
    controller.abort(reason);
    await rejected;
    assert.deepEqual(trace, ["started", "cancelled", "drained"]);
    assert.equal(await hosted.callAsync("default", [0n]), 42n);
    const closingCall = hosted.callAsync("default", [1n]);
    const closed = assert.rejects(closingCall, { name: "AbortError" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await hosted.close();
    await closed;
    assert.throws(() => hosted.call("default", [0n]), /destroyed/);
  } finally {
    compiler.destroy();
  }
});

test("resuming canonical records, variants, and arrays preserves their source values", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-aggregate.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Payload = { .z = Int; .a = Text; .flags = [Bool]; .choice = #Zebra Int | #Apple Int; }
const Echo = @effect.host { .reply = Effect.suspends (Payload -> Payload); }
let run :: Payload -> Payload ~ { Echo }
let run = fn payload => do:
  use next <- Echo.reply payload
  return { .z = next.z + 1; .a = next.a <> "!"; .flags = next.flags; .choice = next.choice; }
return run
`,
    );
    const artifact = await compiler.compile(path);
    const payload = {
      kind: "record" as const,
      fields: new Map([
        ["z", 41n],
        ["a", "hello"],
        ["flags", [true, false]],
        ["choice", { kind: "variant", name: "Zebra", payload: 7n }],
      ] as [string, import("../abi_values.ts").RuntimeValue][]),
    };
    const reply: HostOperation = async (_context, value) => {
      assert.deepEqual(value, payload);
      return value;
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Echo", new Map([["reply", reply]])]]),
    );
    try {
      assert.deepEqual(await hosted.callAsync("default", [payload]), {
        kind: "record",
        fields: new Map([...payload.fields, ["z", 42n], ["a", "hello!"]]),
      });
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});
