import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import type { RuntimeValue } from "../abi_values.ts";
import { requiredFunction } from "../abi_values.ts";
import { CompilerTargetRefusal } from "../compiler/policy.ts";

const header = `open import "blot:prelude"
const Device = @effect.host { .read = Effect.suspends (Int -> Int); }
`;

test("portable suspension retains values without replaying host calls", async () => {
  const compiler = await Compiler.create();
  const path = "/tmp/blot-suspension-values.blot";
  try {
    await compiler.checkSource(
      path,
      header + `
const run :: Int -> Int ~ { Device }
const run = fn x => do:
  use first <- Device.read x
  use second <- Device.read (first + 1)
  return second + first
return { .run = run; }
`,
    );
    const artifact = await compiler.compile(path);
    const reference = path.replace(".blot", "-reference.blot");
    await compiler.checkSource(
      reference,
      header + `
const run = fn x => do:
  use first <- Device.read x
  use second <- Device.read (first + 1)
  return second + first
use answer <- @handle (Device, fn () => run 7, {
  .read = fn (value, ?resume) => do:
    use result <- resume (value + 10)
    return result
  ;
})
return answer
`,
    );
    assert.equal((await compiler.evaluate(reference)).display, "45");
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    assert.equal(manifest.abi.major, 3);
    assert.equal(manifest.exports[0].suspension, "may-suspend");
    assert.equal(manifest.imports[0].suspension, "may-suspend");
    const calls: bigint[] = [];
    const read: HostOperation = async (argument) => {
      assert.equal(typeof argument, "bigint");
      const value = argument as bigint;
      calls.push(value);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return value + 10n;
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Device", new Map([["read", read]])]]),
    );
    try {
      assert.throws(() => hosted.call("run", [7n]), /callAsync/);
      assert.equal(await hosted.callAsync("run", [7n]), 45n);
      assert.equal(await hosted.callAsync("run", [2n]), 35n);
      assert.deepEqual(calls, [7n, 18n, 2n, 13n]);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("suspension preserves recursive activations and conditional joins", async () => {
  const compiler = await Compiler.create();
  const path = "/tmp/blot-suspension-recursion.blot";
  try {
    await compiler.checkSource(
      path,
      header + `
const rec visit = fn n => do:
  if n <= 0:
    return 0
  use value <- Device.read n
  use rest <- visit (n - 1)
  return value + rest
const run :: Int -> Int ~ { Device }
const run = fn n => do:
  use answer <- visit n
  return answer + 1
return { .run = run; }
`,
    );
    const calls: bigint[] = [];
    const read: HostOperation = async (argument) => {
      assert.equal(typeof argument, "bigint");
      calls.push(argument as bigint);
      return argument;
    };
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Device", new Map([["read", read]])]]),
    );
    try {
      assert.equal(await hosted.callAsync("run", [5n]), 16n);
      assert.equal(await hosted.callAsync("run", [0n]), 1n);
      assert.deepEqual(calls, [5n, 4n, 3n, 2n, 1n]);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("cancellation prevents a late response from resuming a released activation", async () => {
  const compiler = await Compiler.create();
  const path = "/tmp/blot-suspension-cancel.blot";
  try {
    await compiler.checkSource(
      path,
      header + `
const run = fn n => do:
  use answer <- Device.read n
  return answer + 1
return { .run = run; }
`,
    );
    let resolveFirst!: (value: bigint) => void;
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const read: HostOperation = (argument, { signal }) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = signal;
        return new Promise<bigint>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(argument);
    };
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Device", new Map([["read", read]])]]),
    );
    try {
      const controller = new AbortController();
      const pending = hosted.callAsync("run", [10n], {
        signal: controller.signal,
      });
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(firstSignal?.aborted, true);
      assert.equal(await hosted.callAsync("run", [20n]), 21n);
      resolveFirst(1000n);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(await hosted.callAsync("run", [30n]), 31n);
      assert.equal(calls, 3);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("suspending host results copy canonical text and aggregate values", async () => {
  const compiler = await Compiler.create();
  const path = "/tmp/blot-suspension-text.blot";
  try {
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Device = @effect.host { .read = Effect.suspends (Int -> { .message = Text; .count = Int; }); }
const run = fn n => do:
  use answer <- Device.read n
  return { .message = answer.message <> "!"; .count = answer.count + n; }
return { .run = run; }
`,
    );
    const read: HostOperation = async () => ({
      kind: "record",
      fields: new Map<string, RuntimeValue>([["count", 5n], [
        "message",
        "\uFEFFhéllo 😀",
      ]]),
    });
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Device", new Map([["read", read]])]]),
    );
    try {
      assert.deepEqual(await hosted.callAsync("run", [7n]), {
        kind: "record",
        fields: new Map<string, RuntimeValue>([["count", 12n], [
          "message",
          "\uFEFFhéllo 😀!",
        ]]),
      });
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("a borrowed parameter cannot remain live across suspension", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      compiler.checkSource(
        "/tmp/blot-suspension-borrow.blot",
        header + `
const run = fn &values => do:
  use answer <- Device.read 1
  return Array.length (&values) + answer
return { .run = run; }
`,
      ),
      /BLOT_BORROW_ACROSS_SUSPENSION/,
    );
    await compiler.checkSource(
      "/tmp/blot-synchronous-borrow.blot",
      `open import "blot:prelude"
const Device = @effect.host {
  .read = Int -> Int;
  .wait = Effect.suspends (Int -> Int);
}
const run = fn &values => do:
  use answer <- Device.read 1
  return Array.length (&values) + answer
return { .run = run; }
`,
    );
    await assert.rejects(
      compiler.checkSource(
        "/tmp/blot-suspension-transitive-borrow.blot",
        header + `
const read = fn n => do:
  use value <- Device.read n
  return value
const run = fn &values => do:
  use answer <- read 1
  return Array.length (&values) + answer
return { .run = run; }
`,
      ),
      /BLOT_BORROW_ACROSS_SUSPENSION/,
    );
  } finally {
    compiler.destroy();
  }
});

test("unsupported suspension layouts and ownership fail before emission", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-refusal.blot";
    for (
      const [source, reason] of [
        [
          `open import "blot:prelude"
const Device = @effect.host { .read = Effect.suspends (Int -> [Int]); }
const run = fn n => do:
  use values <- Device.read n
  return Array.length values
return { .run = run; }
`,
          /canonical element copying/,
        ],
        [
          `open import "blot:prelude"
const Device = @effect.host { .read = Effect.suspends (Int -> (#Number Int | #Text Text)); }
const run = fn n => do:
  use value <- Device.read n
  return case value of
    #Number number => number
    #Text text => Text.length text
return { .run = run; }
`,
          /different Wasm layouts/,
        ],
        [
          `open import "blot:prelude"
const Jobs = @effect.host {
  .acquire = { .signature = Int -> Int; .input = #Unrestricted; .result = #Linear; .suspension = #MaySuspend; };
  .release = Effect.consumes (Int -> Unit);
}
const run :: Int -> Int ~ { Jobs }
const run = fn n => do:
  use handle <- Jobs.acquire n
  use Jobs.release (!handle)
  return n
return { .run = run; }
`,
          /checked cancellation cleanup/,
        ],
      ] as const
    ) {
      await compiler.checkSource(path, source);
      await assert.rejects(compiler.compile(path), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof CompilerTargetRefusal, error.message);
        assert.match(error.message, reason);
        return true;
      });
    }
  } finally {
    compiler.destroy();
  }
});

test("development compilation refuses suspension before publishing units", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-development.blot";
    await compiler.checkSource(
      path,
      header + `
const run = fn n => do:
  use value <- Device.read n
  return value
return { .run = run; }
`,
    );
    await assert.rejects(
      compiler.compileDevelopment({
        entryPath: path,
        entryUnit: "main",
        units: new Map([["main", path]]),
      }),
      /suspension-aware links/,
    );
  } finally {
    compiler.destroy();
  }
});

test("suspending calls marshal text arguments and variant completions", async () => {
  const compiler = await Compiler.create();
  const path = "/tmp/blot-suspension-variants.blot";
  try {
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Network = @effect.host { .get = Effect.suspends (Text -> (#Z Int | #A Int)); }
const run :: Text -> Int ~ { Network }
const run = fn url => do:
  use response <- Network.get url
  return case response of
    #Z value => value + 1
    #A value => value - 1
return { .run = run; }
`,
    );
    const requests: RuntimeValue[] = [];
    const get: HostOperation = async (url) => {
      requests.push(url);
      if (url === "number") return { kind: "variant", name: "Z", payload: 41n };
      return { kind: "variant", name: "A", payload: 6n };
    };
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Network", new Map([["get", get]])]]),
    );
    try {
      assert.equal(await hosted.callAsync("run", ["number"]), 42n);
      assert.equal(await hosted.callAsync("run", ["text"]), 5n);
      assert.deepEqual(requests, ["number", "text"]);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("curried arguments and float state survive mixed synchronous and suspending effects", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-floats.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Device = @effect.host {
  .mark = Int -> Unit;
  .tick = Effect.suspends (Unit -> Unit);
}
const run :: F32 -> F64 -> Bool -> { .single = F32; .double = F64; .flag = Bool; } ~ { Device }
const run = fn x => fn y => fn flag => do:
  use Device.mark 1
  use Device.tick ()
  use Device.mark 2
  return { .single = -x; .double = y; .flag = flag; }
return { .run = run; }
`,
    );
    const calls: RuntimeValue[] = [];
    const operations = new Map<string, HostOperation>([
      ["mark", (value) => {
        calls.push(value);
        return null;
      }],
      ["tick", async (value) => {
        calls.push(value);
        return await Promise.resolve(null);
      }],
    ]);
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Device", operations]]),
    );
    try {
      assert.deepEqual(await hosted.callAsync("run", [1.25, 2.5, true]), {
        kind: "record",
        fields: new Map<string, RuntimeValue>([
          ["double", 2.5],
          ["flag", true],
          ["single", -1.25],
        ]),
      });
      assert.deepEqual(calls, [1n, null, 2n]);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("raw resumption rejects stale tokens and repeated requests, and releases allocations", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-protocol.blot";
    await compiler.checkSource(
      path,
      header + `
const run = fn n => do:
  use first <- Device.read n
  use second <- Device.read first
  return second
return { .run = run; }
`,
    );
    const artifact = await compiler.compile(path);
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    const imported = manifest.imports[0];
    let pending!: { output: number; request: number; value: bigint };
    let memory!: WebAssembly.Memory;
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {
        [imported.module]: {
          [imported.name]: (
            token: number,
            input: number,
            output: number,
            request: number,
          ) => {
            assert.throws(
              () => requiredFunction(instance, "blot:resume")(token, request),
              WebAssembly.RuntimeError,
            );
            pending = {
              output,
              request,
              value: new DataView(memory.buffer).getBigInt64(input, true),
            };
            return 1;
          },
        },
      },
    );
    memory = instance.exports[manifest.abi.memoryExport] as WebAssembly.Memory;
    const begin = requiredFunction(instance, "blot:begin");
    const start = requiredFunction(instance, manifest.exports[0].name);
    const resume = requiredFunction(instance, "blot:resume");
    const result = requiredFunction(instance, "blot:result");
    const release = requiredFunction(instance, "blot:release");
    const allocate = requiredFunction(instance, "cabi_realloc");
    let previous = 0;
    let peakBytes = 0;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const token = begin() as number;
      assert.notEqual(token, previous);
      const input = allocate(0, 0, 8, 8) as number;
      new DataView(memory.buffer).setBigInt64(input, 7n, true);
      start(token, input);
      assert.throws(() => start(token, input), WebAssembly.RuntimeError);
      assert.throws(() => result(token), WebAssembly.RuntimeError);
      assert.throws(() => resume(previous, 0), WebAssembly.RuntimeError);
      assert.equal(resume(token, 0), 1);
      assert.equal(pending.value, 7n);
      new DataView(memory.buffer).setBigInt64(pending.output, 17n, true);
      const first = pending.request;
      assert.throws(() => resume(token, first + 1), WebAssembly.RuntimeError);
      assert.equal(resume(token, first), 1);
      assert.equal(pending.value, 17n);
      assert.throws(() => resume(token, first), WebAssembly.RuntimeError);
      new DataView(memory.buffer).setBigInt64(pending.output, 27n, true);
      assert.equal(resume(token, pending.request), 2);
      assert.equal(
        new DataView(memory.buffer).getBigInt64(result(token) as number, true),
        27n,
      );
      assert.throws(
        () => resume(token, pending.request),
        WebAssembly.RuntimeError,
      );
      // A large temporary region must be reclaimed along with the frames.
      allocate(0, 0, 16, 256 * 1024);
      if (iteration === 0) peakBytes = memory.buffer.byteLength;
      assert.equal(memory.buffer.byteLength, peakBytes);
      release(token);
      assert.throws(() => release(token), WebAssembly.RuntimeError);
      assert.throws(
        () => resume(token, pending.request),
        WebAssembly.RuntimeError,
      );
      previous = token;
    }
  } finally {
    compiler.destroy();
  }
});

test("host failures, invalid completions, and close release the active call", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-suspension-failure.blot";
    await compiler.checkSource(
      path,
      header + `
const run = fn n => do:
  use answer <- Device.read n
  return answer + 1
return { .run = run; }
`,
    );
    let calls = 0;
    let signal!: AbortSignal;
    const failure = new Error("device unavailable");
    const read: HostOperation = (argument, context) => {
      calls += 1;
      if (argument === 0n) throw failure;
      if (argument === 1n) return Promise.reject(failure);
      if (argument === 2n) return Promise.resolve("invalid Int");
      if (argument === 3n) {
        signal = context.signal;
        return new Promise(() => {});
      }
      return argument;
    };
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["Device", new Map([["read", read]])]]),
    );
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        hosted.callAsync("run", [0n], { signal: controller.signal }),
        { name: "AbortError" },
      );
      assert.equal(calls, 0);
      await assert.rejects(
        hosted.callAsync("run", [0n]),
        (error) => error === failure,
      );
      await assert.rejects(
        hosted.callAsync("run", [1n]),
        (error) => error === failure,
      );
      await assert.rejects(hosted.callAsync("run", [2n]), /Int|integer/);
      assert.equal(await hosted.callAsync("run", [10n]), 11n);
      const pending = hosted.callAsync("run", [3n]);
      const rejected = assert.rejects(pending, { name: "AbortError" });
      await assert.rejects(hosted.callAsync("run", [4n]), /already active/);
      await hosted.close();
      await rejected;
      assert.equal(signal.aborted, true);
      await assert.rejects(hosted.callAsync("run", [4n]), /destroyed|closed/);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});
