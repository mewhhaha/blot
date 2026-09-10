import assert from "node:assert/strict";
import test from "node:test";
import type { CallbackExecutor } from "../callbacks.ts";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";
import { createNodeWorkerExecutor } from "./worker_executor.ts";

test("source map_parallel preserves input order with a bounded queue and no empty-array work", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_map_parallel.blot",
    );
    const workers = createNodeWorkerExecutor(root, { size: 4 });
    const secondFinished = Promise.withResolvers<void>();
    const completed: number[] = [];
    let admitted = 0;
    const reordered: CallbackExecutor = {
      async execute(callback, argument, signal, options) {
        const ordinal = admitted++;
        const value = await workers.execute(
          callback,
          argument,
          signal,
          options,
        );
        if (ordinal === 0) await secondFinished.promise;
        completed.push(ordinal);
        if (ordinal === 1) secondFinished.resolve();
        return value;
      },
      promote(callback) {
        workers.promote(callback);
      },
    };
    const sparks = new SparkRuntime(root, { workers: reordered });
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
      assert.deepEqual(await hosted.callAsync("run", [io, 2n, []]), []);
      assert.equal(workers.statistics.jobsSubmitted, 0);
      assert.deepEqual(
        await hosted.callAsync("run", [io, 2n, [3n, 1n, 4n, 2n]]),
        [
          9n,
          1n,
          16n,
          4n,
        ],
      );
      assert.equal(workers.statistics.jobsSubmitted, 4);
      assert.equal(workers.statistics.jobsCompleted, 4);
      assert.deepEqual(completed.slice(0, 2), [1, 0]);
      const values = Array.from({ length: 100 }, (_, index) => BigInt(index));
      assert.deepEqual(
        await hosted.callAsync("run", [io, 2n, values]),
        values.map((value) => value * value),
      );
      assert.equal(workers.statistics.jobsSubmitted, 104);
      assert.equal(workers.statistics.jobsCompleted, 104);
      assert.deepEqual(sparks.statistics, {
        jobsActive: 0,
        jobsRetained: 0,
        maximumJobsRetained: 2,
      });
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("map_parallel rejects nonpositive bounds before admitting any work", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_map_parallel.blot",
    );
    const workers = createNodeWorkerExecutor(root, { size: 2 });
    const sparks = new SparkRuntime(root, { workers });
    for (const concurrency of [0n, -1n]) {
      const hosted = await instantiateArtifact(
        artifact,
        sparks.capabilitiesFor(artifact),
        { scope: root },
      );
      try {
        await assert.rejects(
          hosted.callAsync("run", [
            {
              kind: "record",
              fields: new Map([["executor", sparks.executor]]),
            },
            concurrency,
            [],
          ]),
          (error: unknown) => error instanceof WebAssembly.RuntimeError,
        );
        assert.equal(workers.statistics.jobsSubmitted, 0);
        assert.equal(sparks.statistics.maximumJobsRetained, 0);
      } finally {
        await hosted.close();
      }
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
