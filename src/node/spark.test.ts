import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("source Spark starts concurrent jobs once and joins them through an explicit executor", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/spark.blot");
    const runtime = new SparkRuntime(root);
    const capabilities = new Map(runtime.capabilitiesFor(artifact));
    const first = Promise.withResolvers<bigint>();
    const second = Promise.withResolvers<bigint>();
    const started = Promise.withResolvers<void>();
    const observed: bigint[] = [];
    const tick: HostOperation = (_context, value) => {
      assert.equal(typeof value, "bigint");
      observed.push(BigInt(String(value)));
      if (value === 10n) return first.promise;
      assert.equal(value, 11n);
      started.resolve();
      return second.promise;
    };
    capabilities.set("Clock", new Map([["tick", tick]]));
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      const pending = hosted.callAsync("run", [{
        kind: "record",
        fields: new Map([["executor", runtime.executor]]),
      }, 10n]);
      await started.promise;
      assert.deepEqual(observed, [10n, 11n]);
      second.resolve(22n);
      first.resolve(20n);
      assert.equal(await pending, 42n);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("cancelling a Spark scope cancels and drains its running jobs", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/spark.blot");
    const runtime = new SparkRuntime(root);
    const capabilities = new Map(runtime.capabilitiesFor(artifact));
    const started = Promise.withResolvers<void>();
    let running = 0;
    let drained = 0;
    const tick: HostOperation = async (context) => {
      running += 1;
      if (running === 2) started.resolve();
      try {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
        throw new Error("cancelled clock unexpectedly completed");
      } finally {
        drained += 1;
      }
    };
    capabilities.set("Clock", new Map([["tick", tick]]));
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      const controller = new AbortController();
      const cancellation = new Error("stop scoped work");
      const pending = hosted.callAsync("run", [{
        kind: "record",
        fields: new Map([["executor", runtime.executor]]),
      }, 10n], { signal: controller.signal });
      const rejected = assert.rejects(
        pending,
        (error) => error === cancellation,
      );
      await started.promise;
      controller.abort(cancellation);
      await rejected;
      assert.equal(drained, 2);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("a required Spark failure cancels and drains sibling work", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/spark.blot");
    const sparks = new SparkRuntime(root);
    const failure = new Error("required job failed");
    const first = Promise.withResolvers<bigint>();
    const bothStarted = Promise.withResolvers<void>();
    let drained = false;
    const tick: HostOperation = async ({ signal }, value) => {
      if (value === 10n) return first.promise;
      assert.equal(value, 11n);
      bothStarted.resolve();
      try {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        );
        throw new Error("sibling unexpectedly returned");
      } finally {
        drained = true;
      }
    };
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    capabilities.set("Clock", new Map([["tick", tick]]));
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      const pending = hosted.callAsync("run", [{
        kind: "record",
        fields: new Map([["executor", sparks.executor]]),
      }, 10n]);
      const rejected = assert.rejects(pending, (error) => error === failure);
      await bothStarted.promise;
      first.reject(failure);
      await rejected;
      assert.equal(drained, true);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("child scopes inherit the executor, cancellation drains one job, and scope return joins unobserved jobs", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_lifecycle.blot",
    );
    const sparks = new SparkRuntime(root);
    const io = {
      kind: "record" as const,
      fields: new Map([["executor", sparks.executor]]),
    };
    let drained = 0;
    let started = Promise.withResolvers<void>();
    let finished = Promise.withResolvers<bigint>();
    let mode = 0;
    const tick: HostOperation = async ({ signal }, argument) => {
      started.resolve();
      if (mode === 0) {
        assert.equal(argument, 3n);
        return 6n;
      }
      assert.equal(argument, 4n);
      try {
        if (mode === 1) {
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          );
          throw new Error("cancelled job unexpectedly returned");
        }
        return await finished.promise;
      } finally {
        drained += 1;
      }
    };
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    capabilities.set("Clock", new Map([["tick", tick]]));
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      assert.equal(await hosted.callAsync("run", [io, 0n]), 6n);
      mode = 1;
      assert.equal(await hosted.callAsync("run", [io, 1n]), 10n);
      assert.equal(drained, 1);
      mode = 2;
      started = Promise.withResolvers<void>();
      finished = Promise.withResolvers<bigint>();
      let returned = false;
      const pending = hosted.callAsync("run", [io, 2n]).then((result) => {
        returned = true;
        return result;
      });
      await started.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      assert.equal(returned, false);
      finished.resolve(8n);
      assert.equal(await pending, 20n);
      assert.equal(drained, 2);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
