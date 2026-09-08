import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";
import { createNodeWorkerExecutor } from "./worker_executor.ts";

test("source map_parallel preserves input order and does no work for an empty array", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_map_parallel.blot",
    );
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
      assert.deepEqual(await hosted.callAsync("run", [io, []]), []);
      assert.equal(workers.statistics.jobsSubmitted, 0);
      assert.deepEqual(await hosted.callAsync("run", [io, [3n, 1n, 4n, 2n]]), [
        9n,
        1n,
        16n,
        4n,
      ]);
      assert.equal(workers.statistics.jobsSubmitted, 4);
      assert.equal(workers.statistics.jobsCompleted, 4);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
