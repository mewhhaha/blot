import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("source finalizers run in reverse registration order before their resources are revoked", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const trace: string[] = [];
  try {
    const artifact = await compiler.compile("examples/lib/spark_cleanup.blot");
    const sparks = new SparkRuntime(root);
    const handles = root.resource<string>("Example.Handle");
    const handle = handles.grant(root, "open", () => {
      trace.push("host release");
    });
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    const release: HostOperation = async ({ signal }, request) => {
      assert.ok(
        request !== null && typeof request === "object" && "kind" in request &&
          request.kind === "record",
      );
      assert.equal(handles.get(request.fields.get("0")), "open");
      assert.equal(signal.aborted, false);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      trace.push(`guest ${request.fields.get("1")}`);
      return null;
    };
    capabilities.set(
      "Cleanup",
      new Map<string, HostOperation>([
        ["release", release],
        ["wait", () => {
          throw new Error("unexpected wait");
        }],
      ]),
    );
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      assert.equal(
        await hosted.callAsync("run", [{
          kind: "record",
          fields: new Map([["executor", sparks.executor], ["handle", handle]]),
        }, false]),
        42n,
      );
      assert.deepEqual(trace, ["guest 2", "guest 1"]);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
  assert.deepEqual(trace, ["guest 2", "guest 1", "host release"]);
});

test("module shutdown drains the suspended body and runs masked guest cleanup using the retained artifact", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const trace: string[] = [];
  try {
    const artifact = await compiler.compile("examples/lib/spark_cleanup.blot");
    const sparks = new SparkRuntime(root);
    const handles = root.resource<string>("Example.Handle");
    const handle = handles.grant(root, "open", () => {
      trace.push("host release");
    });
    const started = Promise.withResolvers<void>();
    const release: HostOperation = async ({ signal }, request) => {
      assert.ok(
        request !== null && typeof request === "object" && "kind" in request &&
          request.kind === "record",
      );
      assert.equal(signal.aborted, false);
      assert.equal(handles.get(request.fields.get("0")), "open");
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      trace.push(`guest ${request.fields.get("1")}`);
      return null;
    };
    const wait: HostOperation = async ({ signal }) => {
      started.resolve();
      try {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        );
        throw new Error("wait unexpectedly returned");
      } finally {
        trace.push("body drained");
      }
    };
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    capabilities.set(
      "Cleanup",
      new Map([["release", release], ["wait", wait]]),
    );
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    const pending = hosted.callAsync("run", [{
      kind: "record",
      fields: new Map([["executor", sparks.executor], ["handle", handle]]),
    }, true]);
    const rejected = assert.rejects(pending, /hosted module closed/);
    await started.promise;
    await hosted.close();
    await rejected;
    assert.deepEqual(trace, ["body drained", "guest 2", "guest 1"]);
  } finally {
    await root.close();
    compiler.destroy();
  }
  assert.deepEqual(trace, [
    "body drained",
    "guest 2",
    "guest 1",
    "host release",
  ]);
});

test("a Wasm trap skips guest finalizers and still reclaims host resources", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  let finalized = 0;
  let reclaimed = 0;
  try {
    const artifact = await compiler.compile("examples/lib/spark_cleanup.blot");
    const sparks = new SparkRuntime(root);
    const handles = root.resource<string>("Example.Handle");
    const handle = handles.grant(root, "open", () => {
      reclaimed += 1;
    });
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    capabilities.set(
      "Cleanup",
      new Map<string, HostOperation>([
        ["release", () => {
          finalized += 1;
          return null;
        }],
        ["wait", () => 0n],
      ]),
    );
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      await assert.rejects(
        hosted.callAsync("run", [{
          kind: "record",
          fields: new Map([["executor", sparks.executor], ["handle", handle]]),
        }, true]),
        WebAssembly.RuntimeError,
      );
      assert.equal(finalized, 0);
      assert.throws(() => hosted.callAsync("run", []), /destroyed|closing/);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
  assert.equal(reclaimed, 1);
});
