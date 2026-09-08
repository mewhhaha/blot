import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { EventRuntime, type EventSink } from "../events.ts";
import { instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("source event actors select latest or bounded queues and release subscriptions", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/events.blot");
    const sparks = new SparkRuntime(root);
    const events = new EventRuntime(root, sparks);
    let detached = 0;
    const changes = events.source(
      root,
      { kind: "signed-integer-64" },
      (sink) => {
        for (const value of [1n, 2n, 3n]) sink.emit(value);
        return () => {
          detached += 1;
        };
      },
    );
    const capabilities = new Map([
      ...sparks.capabilitiesFor(artifact),
      ...events.capabilitiesFor(artifact),
    ]);
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor], ["changes", changes]]),
      };
      assert.equal(
        await hosted.callAsync("run", [
          io,
          { kind: "variant", name: "Latest" },
          1n,
        ]),
        3n,
      );
      assert.equal(detached, 1);
      assert.equal(
        await hosted.callAsync("run", [io, {
          kind: "variant",
          name: "Queue",
          payload: 3n,
        }, 3n]),
        6n,
      );
      assert.equal(detached, 2);
      await assert.rejects(
        hosted.callAsync("run", [io, {
          kind: "variant",
          name: "Queue",
          payload: 2n,
        }, 3n]),
        /event queue exceeded/,
      );
      assert.equal(detached, 3);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("cancelling an event wait drains the subscription and late events are ignored", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/events.blot");
    const sparks = new SparkRuntime(root);
    const events = new EventRuntime(root, sparks);
    const attached = Promise.withResolvers<EventSink>();
    let detached = 0;
    const changes = events.source(
      root,
      { kind: "signed-integer-64" },
      (sink) => {
        attached.resolve(sink);
        return () => {
          detached += 1;
        };
      },
    );
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        ...sparks.capabilitiesFor(artifact),
        ...events.capabilitiesFor(artifact),
      ]),
      { scope: root },
    );
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor], ["changes", changes]]),
      };
      const controller = new AbortController();
      const reason = new Error("replace event actor");
      const pending = hosted.callAsync("run", [io, {
        kind: "variant",
        name: "Latest",
      }, 1n], { signal: controller.signal });
      const rejected = assert.rejects(pending, (error) => error === reason);
      const sink = await attached.promise;
      controller.abort(reason);
      await rejected;
      assert.equal(detached, 1);
      sink.emit(42n);
      sink.close();
      assert.equal(detached, 1);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
