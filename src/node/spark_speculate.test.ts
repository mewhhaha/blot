import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";
import { createNodeWorkerExecutor } from "./worker_executor.ts";

test("a completed speculative failure stays buffered until demand", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const path = resolve("examples/lib/spark_speculate.blot");
    const source = await readFile(path, "utf8");
    await compiler.checkSource(
      path,
      source.replace(
        'const Spark = import "blot:spark"',
        'const Spark = import "blot:spark"\nconst Gate = @effect.host { .ready = Effect.suspends (Unit -> Unit); }',
      ).replaceAll("~ { Spark.Effect }", "~ { Spark.Effect, Gate }").replace(
        "return choose wanted (Spark.join spark)",
        "use () <- Gate.ready ()\n    return choose wanted (Spark.join spark)",
      ),
    );
    const artifact = await compiler.compile(path);
    const workers = createNodeWorkerExecutor(root, { size: 2 });
    const sparks = new SparkRuntime(root, { workers });
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    capabilities.set(
      "Gate",
      new Map([["ready", async () => {
        while (
          workers.statistics.jobsCompleted !== workers.statistics.jobsSubmitted
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        return null;
      }]]),
    );
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor]]),
      };
      assert.equal(await hosted.callAsync("run", [io, 0n, false]), 42n);
      assert.equal(workers.statistics.jobsCompleted, 1);
      await assert.rejects(
        hosted.callAsync("run", [io, 0n, true]),
        (error: unknown) =>
          error instanceof Error && error.name === "RuntimeError",
      );
      assert.equal(workers.statistics.jobsCompleted, 2);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("speculative work is skipped until affine demand when no spare worker exists", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_speculate.blot",
    );
    const workers = createNodeWorkerExecutor(root, { size: 1 });
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
      assert.equal(await hosted.callAsync("run", [io, 0n, false]), 42n);
      assert.equal(workers.statistics.workersStarted, 0);
      assert.equal(await hosted.callAsync("run", [io, 100n, true]), 49n);
      assert.equal(workers.statistics.jobsSubmitted, 2);
      assert.equal(workers.statistics.jobsCompleted, 2);
      await assert.rejects(
        hosted.callAsync("run", [io, 0n, true]),
        (error: unknown) =>
          error instanceof Error && error.name === "RuntimeError",
      );
      assert.equal(workers.statistics.jobsSubmitted, 3);
      assert.equal(workers.statistics.jobsCompleted, 3);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("unused CPU speculation drains and leaves capacity for required work", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_speculate.blot",
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
      assert.equal(await hosted.callAsync("progress", [io, 1000000000n]), 4n);
      assert.equal(workers.statistics.workersStarted, 2);
      assert.equal(workers.statistics.jobsSubmitted, 2);
      assert.equal(workers.statistics.jobsCompleted, 2);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
