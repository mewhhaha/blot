import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { ChannelRuntime } from "../channel.ts";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("source channels rendezvous and buffer messages in order until the sender closes", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/channel.blot");
    const sparks = new SparkRuntime(root);
    const channels = new ChannelRuntime(root, sparks);
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        ...sparks.capabilitiesFor(artifact),
        ...channels.capabilitiesFor(artifact),
      ]),
      { scope: root },
    );
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor]]),
      };
      for (const capacity of [0n, 1n, 2n, 16n]) {
        assert.equal(await hosted.callAsync("run", [io, capacity]), 55n);
      }
      assert.equal(await hosted.callAsync("closed", [io]), false);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("scope cancellation wakes blocked channel sends and receives", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/channel.blot");
    const sparks = new SparkRuntime(root);
    const channels = new ChannelRuntime(root, sparks);
    for (const sending of [true, false]) {
      const started = Promise.withResolvers<void>();
      const capabilities = new Map(sparks.capabilitiesFor(artifact));
      for (
        const [capability, operations] of channels.capabilitiesFor(artifact)
      ) {
        capabilities.set(
          capability,
          new Map([...operations].map(([name, operation]) => {
            const observed: HostOperation = (context, ...arguments_) => {
              const result = operation(context, ...arguments_);
              if (name === "send" || name === "receive") started.resolve();
              return result;
            };
            return [name, observed];
          })),
        );
      }
      const hosted = await instantiateArtifact(artifact, capabilities, {
        scope: root,
      });
      try {
        const controller = new AbortController();
        const cancellation = new Error("cancel blocked channel operation");
        const pending = hosted.callAsync("wait", [{
          kind: "record",
          fields: new Map([["executor", sparks.executor]]),
        }, sending], { signal: controller.signal });
        const rejected = assert.rejects(
          pending,
          (error) => error === cancellation,
        );
        await started.promise;
        controller.abort(cancellation);
        await rejected;
      } finally {
        await hosted.close();
      }
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("affine array messages cross the channel once and source reuse is rejected", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const path = resolve("examples/lib/channel_owned.blot");
  try {
    const artifact = await compiler.compile(path);
    const sparks = new SparkRuntime(root);
    const channels = new ChannelRuntime(root, sparks);
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        ...sparks.capabilitiesFor(artifact),
        ...channels.capabilitiesFor(artifact),
      ]),
      { scope: root },
    );
    try {
      assert.equal(
        await hosted.callAsync("run", [{
          kind: "record",
          fields: new Map([["executor", sparks.executor]]),
        }]),
        6n,
      );
    } finally {
      await hosted.close();
    }
    const source = await readFile(path, "utf8");
    await assert.rejects(
      compiler.checkSource(
        path,
        source.replace("Iter.items received", "Iter.items values"),
      ),
      /BLOT_LINEAR_CONSUMED_TWICE/,
    );
  } finally {
    await root.close();
    compiler.destroy();
  }
});
