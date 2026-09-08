import { assertEquals } from "@std/assert";
import { Compiler } from "./compiler.ts";
import { instantiateArtifact } from "./host.ts";
import { HostScope } from "./resources.ts";
import { SparkRuntime } from "./spark.ts";
import { SharedRuntime } from "./shared.ts";
import { createWebWorkerExecutor } from "./web_worker_executor.ts";

Deno.test("Web Worker transport executes precompiled Sparks and reuses its modules", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/spark_parallel.blot");
    const workers = createWebWorkerExecutor(root, {
      size: 2,
      workerUrl: new URL("./web_worker.ts", import.meta.url),
    });
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
      assertEquals(await hosted.callAsync("run", [io, 2000n]), 4000000n);
      assertEquals(await hosted.callAsync("run", [io, 1000n]), 1000000n);
      assertEquals(workers.statistics, {
        workersStarted: 2,
        programsInstalled: 2,
        programsCached: 2,
        jobsSubmitted: 4,
        jobsStarted: 4,
        jobsCompleted: 4,
      });
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

Deno.test("Web Workers share disjoint numeric partitions and atomic progress", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/shared.blot");
    const workers = createWebWorkerExecutor(root, {
      size: 2,
      workerUrl: new URL("./web_worker.ts", import.meta.url),
    });
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
    assertEquals(await hosted.callAsync("run", [io]), {
      kind: "record",
      fields: new Map<string, import("./abi_values.ts").RuntimeValue>([[
        "values",
        [11n, 12n, 13n, 14n],
      ], ["completed", 4n]]),
    });
    await hosted.close();
  } finally {
    await root.close();
    compiler.destroy();
  }
});
