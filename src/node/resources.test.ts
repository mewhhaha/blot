import assert from "node:assert/strict";
import test from "node:test";
import { HostScope } from "../resources.ts";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";

test("resource leases preserve family, runtime, and scope provenance", async () => {
  const root = new HostScope();
  const child = new HostScope(root);
  const other = new HostScope();
  const clients = root.resource<{ readonly label: string }>("Client");
  const parent = clients.grant(root, { label: "parent" });
  const local = clients.grant(child, { label: "child" });
  const token = child.lower("Client", local);
  assert.equal(child.lift("Client", root.lower("Client", parent)), parent);
  assert.throws(() => root.lift("Client", token), /cannot escape/);
  assert.throws(
    () => other.lower("Client", parent),
    /another runtime|this runtime/,
  );
  assert.throws(
    () => clients.get({ kind: "resource", name: "Client" }),
    /wrong family/,
  );
  assert.throws(
    () => child.lower("Other", parent),
    /expected a Other resource/,
  );
  await child.close();
  assert.throws(() => clients.get(local), /revoked/);
  assert.throws(() => root.lift("Client", token), /revoked/);
  assert.equal(clients.get(parent).label, "parent");
  await root.close();
  await other.close();
});

test("masked finalizers share reverse ordering with resource disposal and aggregate every failure", async () => {
  const root = new HostScope();
  const leases = root.resource<string>("CleanupLease");
  const trace: string[] = [];
  const first = leases.grant(root, "first", () => {
    trace.push("release first");
  });
  const firstFailure = new Error("first cleanup failed");
  const secondFailure = new Error("second cleanup failed");
  root.onExit(async (masked) => {
    const token = masked.lower("CleanupLease", first);
    assert.equal(masked.lift("CleanupLease", token), first);
    assert.equal(masked.signal.aborted, false);
    trace.push("finalize first");
    await Promise.reject(firstFailure);
  });
  const second = leases.grant(root, "second", () => {
    trace.push("release second");
  });
  root.onExit(async (masked) => {
    root.cancel(new Error("another cancellation during cleanup"));
    assert.equal(masked.signal.aborted, false);
    assert.equal(leases.get(second), "second");
    assert.throws(() => new HostScope(root));
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    trace.push("finalize second");
    throw secondFailure;
  });
  await assert.rejects(root.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [secondFailure, firstFailure]);
    return true;
  });
  assert.deepEqual(trace, [
    "finalize second",
    "release second",
    "finalize first",
    "release first",
  ]);
  assert.throws(() => leases.get(first), /revoked/);
  assert.throws(() => leases.get(second), /revoked/);
});

test("generic resource types retain their payload through specialization and the host boundary", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const integers = root.resource<bigint>("Box", {
    payload: { kind: "signed-integer-64" },
  });
  const texts = root.resource<string>("Box", { payload: { kind: "text" } });
  const integer = integers.grant(root, 42n);
  const text = texts.grant(root, "forty-two");
  try {
    const hosted = await instantiateArtifact(
      await compiler.compile("examples/lib/resource_types.blot"),
      new Map(),
      { scope: root },
    );
    try {
      assert.equal(hosted.call("integers", [integer]), integer);
      assert.equal(hosted.call("texts", [text]), text);
      assert.throws(
        () => hosted.call("integers", [text]),
        /different type argument/,
      );
      assert.throws(
        () => hosted.call("texts", [integer]),
        /different type argument/,
      );
      assert.throws(() => integers.get(text), /wrong family/);
    } finally {
      await hosted.close();
    }
    await assert.rejects(
      compiler.checkSource(
        "/tmp/blot-resource-invariant.blot",
        `open import "blot:prelude"
const Box = fn element => Resource.of_type "Box" element
let invalid :: Box Int -> Box Text
let invalid = fn value => value
return invalid
`,
      ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("Blot receives explicit opaque I/O capabilities and closes acquired resources before returning", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const clients = root.resource<{ readonly prefix: string }>("TextClient");
  const streams = root.resource<string>("TextStream");
  const trace: string[] = [];
  const client = clients.grant(root, { prefix: "read:" }, () => {
    trace.push("client closed");
  });
  try {
    const artifact = await compiler.compile(
      "examples/lib/resource_context.blot",
    );
    const open: HostOperation = ({ scope, signal }, request) => {
      assert.ok(
        typeof request === "object" && request !== null &&
          !Array.isArray(request) && "kind" in request &&
          request.kind === "record",
      );
      const connection = clients.get(request.fields.get("0"));
      const path = request.fields.get("1");
      assert.equal(typeof path, "string");
      return streams.acquire(scope, async () => {
        trace.push("opened");
        return await Promise.resolve(connection.prefix + String(path));
      }, async () => {
        await Promise.resolve();
        trace.push("stream closed");
      }, { signal });
    };
    const read: HostOperation = async (_context, stream) => {
      trace.push("read");
      return await Promise.resolve(streams.get(stream));
    };
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["IO", new Map([["open", open], ["read", read]])]]),
      { scope: root },
    );
    try {
      const io = {
        kind: "record" as const,
        fields: new Map([["client", client]]),
      };
      assert.equal(
        await hosted.callAsync("run", [io, "message.txt"]),
        "read:message.txt!",
      );
      assert.deepEqual(trace, ["opened", "read", "stream closed"]);
      assert.equal(clients.get(client).prefix, "read:");
      await hosted.close();
      assert.equal(clients.get(client).prefix, "read:");
    } finally {
      await hosted.close();
    }
    await root.close();
    assert.deepEqual(trace, [
      "opened",
      "read",
      "stream closed",
      "client closed",
    ]);
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("scope cleanup runs in reverse order, drains asynchronous release, and reports failures", async () => {
  const scope = new HostScope();
  const resources = scope.resource<string>("Connection");
  const trace: string[] = [];
  const failure = new Error("second release failed");
  resources.grant(scope, "first", (label) => {
    trace.push(label);
  });
  resources.grant(scope, "second", async (label) => {
    await Promise.resolve();
    trace.push(label);
    throw failure;
  });
  let reentered: Promise<void> | undefined;
  scope.signal.addEventListener("abort", () => {
    reentered = scope.close();
  });
  const closing = scope.close();
  assert.equal(reentered, closing);
  assert.equal(scope.close(), closing);
  await assert.rejects(closing, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.deepEqual(trace, ["second", "first"]);
});

test("cancelling a Wasm call drains acquisition and cleanup without publishing a late resource", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const clients = root.resource<string>("TextClient");
  const streams = root.resource<string>("TextStream");
  const client = clients.grant(root, "client");
  const created = Promise.withResolvers<string>();
  const opened = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const trace: string[] = [];
  const open: HostOperation = ({ scope, signal }) =>
    streams.acquire(scope, async () => {
      opened.resolve();
      return await created.promise;
    }, async () => {
      trace.push("releasing");
      await released.promise;
      trace.push("released");
    }, { signal });
  const read: HostOperation = () => {
    throw new Error("cancelled resource reached guest code");
  };
  try {
    const hosted = await instantiateArtifact(
      await compiler.compile("examples/lib/resource_context.blot"),
      new Map([["IO", new Map([["open", open], ["read", read]])]]),
      { scope: root },
    );
    try {
      const controller = new AbortController();
      const reason = new Error("cancel read");
      const pending = hosted.callAsync("run", [{
        kind: "record",
        fields: new Map([["client", client]]),
      }, "message.txt"], { signal: controller.signal });
      const rejected = assert.rejects(pending, (error) => error === reason);
      await opened.promise;
      controller.abort(reason);
      created.resolve("late stream");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(trace, ["releasing"]);
      released.resolve();
      await rejected;
      assert.deepEqual(trace, ["releasing", "released"]);
      assert.equal(clients.get(client), "client");
    } finally {
      released.resolve();
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("resource types reject source fabrication and invocation-owned results cannot escape", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  const streams = root.resource<string>("Stream");
  const trace: string[] = [];
  try {
    const path = "/tmp/blot-resource-escape.blot";
    await assert.rejects(
      compiler.checkSource(
        path,
        `open import "blot:prelude"
const Stream = Resource.of "Stream"
let run :: Int -> Stream
let run = fn value => value
return run
`,
      ),
      /BLOT_TYPE_ERROR: Int does not flow into Resource:Stream/,
    );
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Stream = Resource.of "Stream"
const IO = @effect.host { .open = Effect.suspends (Unit -> Stream); }
let run = fn () => do:
  use stream <- IO.open ()
  return stream
return run
`,
    );
    const open: HostOperation = ({ scope }) =>
      streams.grant(scope, "stream", () => {
        trace.push("closed");
      });
    const hosted = await instantiateArtifact(
      await compiler.compile(path),
      new Map([["IO", new Map([["open", open]])]]),
      { scope: root },
    );
    try {
      await assert.rejects(
        hosted.callAsync("default", [null]),
        /cannot escape/,
      );
      assert.deepEqual(trace, ["closed"]);
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("a resource acquired after cancellation is released before either lifetime finishes", async () => {
  const scope = new HostScope();
  const connections = scope.resource<string>("Connection");
  const acquired = Promise.withResolvers<string>();
  const trace: string[] = [];
  const reason = new Error("cancel scope");
  const pending = connections.acquire(scope, async (signal) => {
    trace.push("started");
    signal.addEventListener("abort", () => trace.push("cancelled"));
    return await acquired.promise;
  }, async (value) => {
    await Promise.resolve();
    trace.push(`released ${value}`);
  });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await Promise.resolve();
  const closing = scope.close(reason);
  acquired.resolve("late");
  await rejected;
  await closing;
  assert.deepEqual(trace, ["started", "cancelled", "released late"]);
});
