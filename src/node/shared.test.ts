import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { decodeManifest, type RuntimeValue } from "../abi_values.ts";
import type { CallbackExecutor } from "../callbacks.ts";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SharedRuntime } from "../shared.ts";
import { SparkRuntime } from "../spark.ts";
import { createNodeWorkerExecutor } from "./worker_executor.ts";
import { type SharedLoan, sharedMemoryWire } from "../shared_memory.ts";

const header = `open import "blot:prelude"
const Spark = import "blot:spark"
const Shared = import "blot:shared"
`;

function scoped(body: string, result: string, declarations = ""): string {
  return `${header}${declarations}
let run :: Spark.Executor -> ${result} ~ { Spark.Effect, Shared.Effect, Shared.Access }
let run = fn executor => do:
  let body :: Spark.Scope -> ${result} ~ { Spark.Effect, Shared.Effect, Shared.Access }
  let body = fn scope => do:
${body}
  return Spark.scope executor body
return { .run = run; }
`;
}

test("shared float partitions support nested exact-cover joins", async () => {
  const compiler = await Compiler.create();
  try {
    for (const [storage, type] of [["f32", "F32"], ["f64", "F64"]]) {
      const root = new HostScope();
      try {
        const path = resolve(`shared-${storage}.blot`);
        await compiler.checkSource(
          path,
          scoped(
            `    use values <- Shared.${storage} scope [0.25, 1.5, 2.75, 4.0]
    use halves <- Shared.split 2 values
    use quarters <- Shared.split 1 halves.left
    use () <- Shared.run scope quarters.left kernel
    use () <- Shared.run scope quarters.right kernel
    use left <- Shared.join quarters.rejoin
    use () <- Shared.run scope left kernel
    use () <- Shared.run scope halves.right kernel
    use whole <- Shared.join halves.rejoin
    return Shared.snapshot whole`,
            `[${type}]`,
            `let kernel :: Shared.Partition ${type} -> Unit ~ { Shared.Access }
let kernel = fn partition => do:
  let increment :: ${type} = 1.25
  use length <- Shared.length partition
  for index in Iter.range (0, length):
    use current <- Shared.read partition index
    use Shared.write partition index (current + increment)
  return ()
`,
          ),
        );
        const artifact = await compiler.compile(path);
        const workers = createNodeWorkerExecutor(root, { size: 2 });
        const sparks = new SparkRuntime(root, { workers });
        const shared = new SharedRuntime(root, sparks, workers);
        const hosted = await instantiateArtifact(
          artifact,
          new Map([
            ...sparks.capabilitiesFor(artifact),
            ...shared.capabilitiesFor(artifact),
          ]),
          { scope: root },
        );
        assert.deepEqual(await hosted.callAsync("run", [sparks.executor]), [
          2.75,
          4,
          4,
          5.25,
        ]);
        await hosted.close();
      } finally {
        await root.close();
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("shared partitions reject stale parents, incomplete joins, duplicate joins, bounds, and non-i32 writes", async () => {
  const compiler = await Compiler.create();
  try {
    const cases = [
      {
        body: `    use halves <- Shared.split 1 values
    return Shared.snapshot values`,
        error: /shared partition is split/,
      },
      {
        body: `    use halves <- Shared.split 1 values
    use quarters <- Shared.split 0 halves.left
    use whole <- Shared.join halves.rejoin
    return Shared.snapshot whole`,
        error: /both exact children/,
      },
      {
        body: `    use halves <- Shared.split 1 values
    use whole <- Shared.join halves.rejoin
    return Shared.snapshot values`,
        error: /handle is stale/,
      },
      {
        body: `    use halves <- Shared.split 1 values
    use whole <- Shared.join halves.rejoin
    use again <- Shared.join halves.rejoin
    return Shared.snapshot again`,
        error: /already been consumed/,
      },
      {
        body: `    use halves <- Shared.split 3 values
    return Shared.snapshot halves.left`,
        error: /split boundary/,
      },
      {
        body:
          `    use () <- Shared.run scope values (fn partition => Shared.write partition 2 0)
    return Shared.snapshot values`,
        error: /shared index/,
      },
      {
        body:
          `    use () <- Shared.run scope values (fn partition => Shared.write partition 0 2147483648)
    return Shared.snapshot values`,
        error: /shared i32 value/,
      },
    ];
    for (const [index, probe] of cases.entries()) {
      const root = new HostScope();
      try {
        const path = resolve(`shared-rejection-${index}.blot`);
        await compiler.checkSource(
          path,
          scoped(
            `    use values <- Shared.i32 scope [1, 2]
${probe.body}`,
            "[Int]",
          ),
        );
        const artifact = await compiler.compile(path);
        const workers = createNodeWorkerExecutor(root, { size: 1 });
        const sparks = new SparkRuntime(root, { workers });
        const shared = new SharedRuntime(root, sparks, workers);
        const hosted = await instantiateArtifact(
          artifact,
          new Map([
            ...sparks.capabilitiesFor(artifact),
            ...shared.capabilitiesFor(artifact),
          ]),
          { scope: root },
        );
        await assert.rejects(
          hosted.callAsync("run", [sparks.executor]),
          probe.error,
          `probe ${index}`,
        );
        await hosted.close();
      } finally {
        await root.close();
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("cancelling a queued shared loan preserves its partition and never starts that kernel", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const path = resolve("shared-queued-cancel.blot");
    await compiler.checkSource(
      path,
      scoped(
        `    use values <- Shared.i32 scope [1, 2]
    use initial <- Shared.snapshot values
    let count = Array.length initial * 500000000
    use blocker <- Spark.parallel scope (fn () => sum count)
    use () <- Shared.run scope values kernel
    use Spark.cancel blocker
    use () <- Shared.run scope values kernel
    return Shared.snapshot values`,
        "[Int]",
        `const sum :: Int -> Int = fn count => do:
  let total = 0
  for index in Iter.range (0, count):
    total := total + index
  return total
let kernel :: Shared.Partition Int -> Unit ~ { Shared.Access }
let kernel = fn partition => Shared.write partition 0 9
`,
      ),
    );
    const artifact = await compiler.compile(path);
    const workers = createNodeWorkerExecutor(root, { size: 1 });
    const sparks = new SparkRuntime(root, { workers });
    const shared = new SharedRuntime(root, sparks, workers);
    const capabilities = new Map([
      ...sparks.capabilitiesFor(artifact),
      ...shared.capabilitiesFor(artifact),
    ]);
    const operations = new Map(capabilities.get("SharedRuntime"));
    const run = operations.get("run");
    const snapshot = operations.get("snapshot");
    const declaration = decodeManifest(artifact.manifestBytes).imports.find((
      operation,
    ) =>
      operation.capability === "SharedRuntime" &&
      operation.sourceName === "snapshot"
    );
    assert(
      run !== undefined && snapshot !== undefined && declaration !== undefined,
    );
    let inspected = false;
    operations.set("run", async (context, request) => {
      if (inspected) return run(context, request);
      const cancellation = new AbortController();
      const reason = new Error("cancel only the queued shared kernel");
      const pending = Promise.resolve(
        run({ ...context, signal: cancellation.signal }, request),
      );
      const cancelled = assert.rejects(pending, (error) => error === reason);
      await waitUntil(() => workers.statistics.jobsSubmitted === 2);
      cancellation.abort(reason);
      await cancelled;
      assert(
        typeof request === "object" && request !== null && "kind" in request &&
          request.kind === "record",
      );
      const partition = request.fields.get("1");
      assert(partition !== undefined);
      assert.deepEqual(
        await snapshot({ ...context, operation: declaration }, partition),
        [1n, 2n],
      );
      inspected = true;
      return null;
    });
    capabilities.set("SharedRuntime", operations);
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    assert.deepEqual(await hosted.callAsync("run", [sparks.executor]), [
      9n,
      2n,
    ]);
    assert.equal(inspected, true);
    assert.equal(workers.statistics.jobsSubmitted, 3);
    assert.equal(workers.statistics.jobsStarted, 2);
    assert.equal(workers.statistics.jobsCompleted, 3);
    await hosted.close();
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("cancelling an admitted shared kernel drains execution and invalidates its allocation", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const path = resolve("shared-active-cancel.blot");
    await compiler.checkSource(
      path,
      scoped(
        `    use values <- Shared.i32 scope [1, 2]
    use () <- Shared.run scope values kernel
    return Shared.snapshot values`,
        "[Int]",
        `let kernel :: Shared.Partition Int -> Unit ~ { Shared.Access }
let kernel = fn partition => do:
  for index in Iter.range (0, 1000000000):
    use Shared.write partition 0 9
  return ()
`,
      ),
    );
    const artifact = await compiler.compile(path);
    const workers = createNodeWorkerExecutor(root, { size: 1 });
    let loan: SharedLoan | undefined;
    const executor: CallbackExecutor = {
      execute(callback, argument, signal, options) {
        loan = options.shared;
        return workers.execute(callback, argument, signal, options);
      },
      promote(callback) {
        workers.promote(callback);
      },
    };
    const sparks = new SparkRuntime(root, { workers: executor });
    const shared = new SharedRuntime(root, sparks, executor);
    const capabilities = new Map([
      ...sparks.capabilitiesFor(artifact),
      ...shared.capabilitiesFor(artifact),
    ]);
    const operations = new Map(capabilities.get("SharedRuntime"));
    const run = operations.get("run");
    assert(run !== undefined);
    let inspected = false;
    operations.set("run", async (context, request) => {
      const cancellation = new AbortController();
      const reason = new Error("cancel only the admitted kernel");
      const pending = Promise.resolve(
        run({ ...context, signal: cancellation.signal }, request),
      );
      const cancelled = assert.rejects(pending, (error) => error === reason);
      await waitUntil(() => workers.statistics.jobsStarted === 1);
      cancellation.abort(reason);
      await cancelled;
      assert(loan !== undefined);
      assert.equal(workers.statistics.jobsCompleted, 1);
      assert.equal(
        Atomics.load(new Int32Array(loan.memories[0].control), 0),
        0,
      );
      inspected = true;
      return null;
    });
    capabilities.set("SharedRuntime", operations);
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    await assert.rejects(
      hosted.callAsync("run", [sparks.executor]),
      /allocation has been invalidated/,
    );
    assert.equal(inspected, true);
    await hosted.close();
  } finally {
    await root.close();
    compiler.destroy();
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("worker did not reach the expected admission state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("parallel and speculative Sparks reject shared effects in their pure callbacks", async () => {
  const compiler = await Compiler.create();
  try {
    for (const operation of ["parallel", "speculate"]) {
      await assert.rejects(
        compiler.checkSource(
          resolve(`shared-${operation}-refusal.blot`),
          scoped(
            `    use values <- Shared.i32 scope [1, 2]
    let work :: Unit -> Unit ~ { Shared.Effect, Shared.Access }
    let work = fn () => Shared.run scope values kernel
    use job <- Spark.${operation} scope work
    use () <- Spark.join job
    return Shared.snapshot values`,
            "[Int]",
            `let kernel :: Shared.Partition Int -> Unit ~ { Shared.Access }
let kernel = fn partition => Shared.write partition 0 9
`,
          ),
        ),
        /BLOT_TYPE_ERROR/,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("shared numeric wire descriptors reject malformed memory and ranges", () => {
  const valid = {
    storage: "f64",
    buffer: new SharedArrayBuffer(16),
    control: new SharedArrayBuffer(4),
    start: 0,
    length: 2,
    generation: 1,
  };
  assert.equal(sharedMemoryWire(valid).length, 2);
  for (
    const change of [
      { buffer: new ArrayBuffer(16) },
      { control: new SharedArrayBuffer(8) },
      { start: -1 },
      { length: 3 },
      { generation: 0 },
      { generation: 2147483648 },
      { buffer: new SharedArrayBuffer(15) },
      { storage: "atomic_i32" },
    ]
  ) assert.throws(() => sharedMemoryWire({ ...valid, ...change }));
});

test("shared loans reject overlapping admission and invalidate a failed worker's entire allocation", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const path = resolve("shared-failure.blot");
    await compiler.checkSource(
      path,
      scoped(
        `    use values <- Shared.i32 scope [7, 8]
    use halves <- Shared.split 1 values
    use result <- Shared.run scope halves.left kernel
    return Shared.snapshot halves.right`,
        "[Int]",
        `let kernel :: Shared.Partition Int -> Int ~ { Shared.Access }
let kernel = fn partition => do:
  use Shared.write partition 0 0
  use zero <- Shared.read partition 0
  return 1 / zero
`,
      ),
    );
    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    const workers = createNodeWorkerExecutor(root, { size: 1 });
    let loan: SharedLoan | undefined;
    const executor: CallbackExecutor = {
      execute(callback, argument, signal, options) {
        loan = options.shared;
        assert(loan !== undefined);
        return workers.execute(callback, argument, signal, options);
      },
      promote(callback) {
        workers.promote(callback);
      },
    };
    const sparks = new SparkRuntime(root, { workers: executor });
    const shared = new SharedRuntime(root, sparks, executor);
    const capabilities = new Map([
      ...sparks.capabilitiesFor(artifact),
      ...shared.capabilitiesFor(artifact),
    ]);
    const operations = new Map(capabilities.get("SharedRuntime"));
    const run = operations.get("run");
    const snapshot = operations.get("snapshot");
    const snapshotDeclaration = manifest.imports.find((operation) =>
      operation.capability === "SharedRuntime" &&
      operation.sourceName === "snapshot"
    );
    assert(
      run !== undefined && snapshot !== undefined &&
        snapshotDeclaration !== undefined,
    );
    let sibling: RuntimeValue | undefined;
    const split = operations.get("split");
    assert(split !== undefined);
    operations.set("split", async (context, request) => {
      const result = await split(context, request);
      assert(
        typeof result === "object" && result !== null && "kind" in result &&
          result.kind === "record",
      );
      sibling = result.fields.get("right");
      return result;
    });
    let inspected = false;
    operations.set("run", async (context, request) => {
      const pending = Promise.resolve(run(context, request));
      const failed = assert.rejects(pending, /divide by zero/);
      assert(
        typeof request === "object" && request !== null && "kind" in request &&
          request.kind === "record",
      );
      const partition = request.fields.get("1");
      assert(partition !== undefined);
      assert.throws(
        () =>
          snapshot({ ...context, operation: snapshotDeclaration }, partition),
        /shared partition is running/,
      );
      await failed;
      assert(loan !== undefined && sibling !== undefined);
      // Inspect before Spark unwinds its scope, so scope cleanup cannot mask a missing invalidation.
      assert.equal(
        Atomics.load(new Int32Array(loan.memories[0].control), 0),
        0,
      );
      const invalidSibling = sibling;
      assert.throws(
        () =>
          snapshot(
            { ...context, operation: snapshotDeclaration },
            invalidSibling,
          ),
        /allocation has been invalidated/,
      );
      inspected = true;
      return 0n;
    });
    capabilities.set("SharedRuntime", operations);
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    await assert.rejects(
      hosted.callAsync("run", [sparks.executor]),
      /allocation has been invalidated/,
    );
    assert.equal(inspected, true);
    assert.equal(workers.statistics.jobsSubmitted, 1);
    await hosted.close();
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("disjoint shared kernels write numeric partitions and rejoin their exact cover", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/shared.blot");
    const workers = createNodeWorkerExecutor(root, { size: 2 });
    const sparks = new SparkRuntime(root, { workers });
    const shared = new SharedRuntime(root, sparks, workers);
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        ...sparks.capabilitiesFor(artifact),
        ...shared.capabilitiesFor(artifact),
      ]),
      { scope: root },
    );
    const io = {
      kind: "record" as const,
      fields: new Map([["executor", sparks.executor]]),
    };
    assert.deepEqual(await hosted.callAsync("run", [io]), {
      kind: "record",
      fields: new Map<string, RuntimeValue>([["values", [11n, 12n, 13n, 14n]], [
        "completed",
        4n,
      ]]),
    });
    assert.equal(workers.statistics.jobsCompleted, 3);
    await hosted.close();
  } finally {
    await root.close();
    compiler.destroy();
  }
});
