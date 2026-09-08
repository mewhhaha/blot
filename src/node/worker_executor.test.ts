import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";
import { createNodeWorkerExecutor } from "./worker_executor.ts";
import { WorkerExecutor } from "../worker_executor.ts";

test("parallel Sparks reuse workers and precompiled modules across jobs", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/spark_parallel.blot");
    const workers = createNodeWorkerExecutor(root, { size: 2 });
    const sparks = new SparkRuntime(root, { workers });
    const hosted = await instantiateArtifact(
      artifact,
      sparks.capabilitiesFor(artifact),
      { scope: root },
    );
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor]]),
      };
      for (const count of [1000n, 2000n, 3000n, 4000n]) {
        assert.equal(await hosted.callAsync("run", [io, count]), count * count);
      }
      assert.deepEqual(workers.statistics, {
        workersStarted: 2,
        programsInstalled: 2,
        programsCached: 2,
        jobsSubmitted: 8,
        jobsStarted: 8,
        jobsCompleted: 8,
      });
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("a lost worker keeps its job pending until termination has drained", async () => {
  const root = new HostScope();
  const terminating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("worker connection failed");
  const workers = new WorkerExecutor(root, {
    size: 1,
    createWorker() {
      let failed: ((error: Error) => void) | undefined;
      return {
        postMessage(message) {
          if (
            typeof message === "object" && message !== null &&
            "kind" in message && message.kind === "run"
          ) {
            queueMicrotask(() => {
              assert(failed !== undefined);
              failed(failure);
            });
          }
        },
        onMessage() {
          return () => {};
        },
        onError(callback) {
          failed = callback;
          return () => {};
        },
        terminate() {
          terminating.resolve();
          return release.promise;
        },
      };
    },
  });
  let settled = false;
  const pending = workers.execute(
    {
      module: new WebAssembly.Module(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      ),
      manifestBytes: new Uint8Array(),
      entry: "unreachable",
      environmentType: { kind: "record", fields: [] },
      captures: [],
    },
    null,
    root.signal,
    { priority: "required" },
  );
  const observed = pending.catch((error: unknown) => {
    settled = true;
    assert.strictEqual(error, failure);
  });
  try {
    await terminating.promise;
    await Promise.resolve();
    assert.equal(settled, false);
  } finally {
    release.resolve();
    await observed;
    await root.close();
  }
  assert.equal(settled, true);
});

test("cancelling parallel CPU work drains workers and leaves them reusable", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/spark_parallel.blot");
    const workers = createNodeWorkerExecutor(root, { size: 2 });
    const sparks = new SparkRuntime(root, { workers });
    const hosted = await instantiateArtifact(
      artifact,
      sparks.capabilitiesFor(artifact),
      { scope: root },
    );
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor]]),
      };
      const controller = new AbortController();
      const cancellation = new Error("cancel CPU work");
      const pending = hosted.callAsync("run", [io, 1000000000n], {
        signal: controller.signal,
      });
      const rejected = assert.rejects(
        pending,
        (error) => error === cancellation,
      );
      const timer = setTimeout(() => controller.abort(cancellation), 50);
      try {
        await rejected;
      } finally {
        clearTimeout(timer);
      }
      assert.equal(
        workers.statistics.jobsCompleted,
        workers.statistics.jobsSubmitted,
      );
      assert.equal(await hosted.callAsync("run", [io, 100n]), 10000n);
      assert.equal(workers.statistics.workersStarted, 2);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("parallel source work must be pure", async () => {
  const compiler = await Compiler.create();
  try {
    const path = resolve("examples/lib/spark_parallel.blot");
    const source = await readFile(path, "utf8");
    await assert.rejects(
      compiler.checkSource(
        path,
        source.replace(
          "const sum :: Int -> Int",
          "const Clock = @effect.host { .tick = Effect.suspends (Int -> Int); }\nconst sum :: Int -> Int ~ { Clock }",
        ).replace("return total", "return Clock.tick total").replaceAll(
          "Unit -> Int =",
          "Unit -> Int ~ { Clock } =",
        ),
      ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});

test("a worker trap fails its job once and a later call gets a fresh private heap", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const path = resolve("examples/lib/spark_parallel.blot");
    const source = await readFile(path, "utf8");
    await compiler.checkSource(
      path,
      source.replace("return total", "return total / count"),
    );
    const artifact = await compiler.compile(path);
    const workers = createNodeWorkerExecutor(root, { size: 2 });
    const sparks = new SparkRuntime(root, { workers });
    const hosted = await instantiateArtifact(
      artifact,
      sparks.capabilitiesFor(artifact),
      { scope: root },
    );
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor]]),
      };
      await assert.rejects(
        hosted.callAsync("run", [io, 0n]),
        (error: unknown) =>
          error instanceof Error && error.name === "RuntimeError",
      );
      assert.equal(workers.statistics.jobsSubmitted, 2);
      assert.equal(workers.statistics.jobsCompleted, 2);
      assert.equal(await hosted.callAsync("run", [io, 10n]), 9n);
      assert.equal(workers.statistics.workersStarted, 2);
      assert.equal(workers.statistics.programsInstalled, 2);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
