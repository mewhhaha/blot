import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeManifest, type RuntimeValue } from "../../src/abi_values.ts";
import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import { EventRuntime } from "../../src/events.ts";
import type { HostOperation } from "../../src/host.ts";
import { IoRuntime } from "../../src/io.ts";
import { HostScope } from "../../src/resources.ts";
import { SparkRuntime } from "../../src/spark.ts";
import { createNodeWorkerExecutor } from "../../src/node/worker_executor.ts";
import { serveHotReload } from "../hot-reload/serve.ts";

test("the browser example serves isolated assets and executes its event actor through HTTP and Wasm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-browser-events-"));
  await cp(new URL("./", import.meta.url), directory, { recursive: true });
  const server = await serveHotReload(join(directory, "blot.json"), 0, {
    page: new URL("./index.html", import.meta.url),
    client: new URL("./client.mjs", import.meta.url),
  });
  const origin = new URL(`http://127.0.0.1:${server.port}/`);
  const root = new HostScope();
  const workers = createNodeWorkerExecutor(root, { size: 2 });
  const sparks = new SparkRuntime(root, { workers });
  const services = new IoRuntime(root);
  const events = new EventRuntime(root, sparks);
  const displayed = Promise.withResolvers<RuntimeValue>();
  let message: RuntimeValue | undefined;
  let stopped = 0;
  let detached = 0;
  const ui = new Map<string, HostOperation>([
    ["show", (_context, request) => {
      displayed.resolve(request);
      return null;
    }],
    ["message", (_context, request) => {
      message = request;
      return null;
    }],
    ["stopped", () => {
      stopped += 1;
      return null;
    }],
  ]);
  const runtime = new DevelopmentRuntime(undefined, {
    scope: root,
    capabilities(artifact) {
      const capabilities = new Map([
        ...sparks.capabilitiesFor(artifact),
        ...services.capabilitiesFor(artifact),
        ...events.capabilitiesFor(artifact),
      ]);
      const selected = new Map<string, HostOperation>();
      for (const imported of decodeManifest(artifact.manifestBytes).imports) {
        if (imported.capability !== "Ui") continue;
        const operation = ui.get(imported.sourceName);
        assert(operation !== undefined);
        selected.set(imported.sourceName, operation);
      }
      if (selected.size > 0) capabilities.set("Ui", selected);
      return capabilities;
    },
  });
  try {
    const page = await fetch(origin);
    assert.equal(page.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(
      page.headers.get("Cross-Origin-Embedder-Policy"),
      "require-corp",
    );
    assert.match(await page.text(), /Stop actor/);
    const client = await (await fetch(new URL("client.js", origin))).text();
    assert.doesNotMatch(client, /node:fs|CompilerWasm|compiler\.wasm/);
    const worker = await (await fetch(new URL("worker.js", origin))).text();
    assert.doesNotMatch(worker, /node:fs|CompilerWasm|compiler\.wasm/);
    const snapshot = await (await fetch(new URL("build", origin))).json();
    const changedUnits = await Promise.all(
      snapshot.units.map(async (unit: { name: string; wasmDigest: string }) => {
        const bytes = await (await fetch(
          new URL(`units/${unit.name}/${unit.wasmDigest}`, origin),
        )).json();
        return {
          ...unit,
          wasm: Uint8Array.from(bytes.wasm),
          manifestBytes: Uint8Array.from(bytes.manifestBytes),
        };
      }),
    );
    await runtime.commitActivation(
      await runtime.prepareActivation({
        ...snapshot,
        changedUnits,
        retainedUnits: [],
        removedUnits: [],
      }),
    );
    const view = root.resource("Demo.View").grant(root, {});
    const changes = events.source(
      root,
      { kind: "signed-integer-64" },
      (sink) => {
        sink.emit(21n);
        return () => {
          detached += 1;
        };
      },
    );
    const io = {
      kind: "record" as const,
      fields: new Map([
        ["executor", sparks.executor],
        ["changes", changes],
        ["clock", services.clock(root)],
        ["http", services.http(root, { baseURL: origin })],
        ["view", view],
      ]),
    };
    const controller = new AbortController();
    const pending = runtime.callAsync("run", [io], {
      signal: controller.signal,
    });
    const cancellation = new Error("stop browser example");
    const rejected = assert.rejects(pending, (error) => error === cancellation);
    assert.deepEqual(await displayed.promise, {
      kind: "record",
      fields: new Map<string, RuntimeValue>([["0", view], ["1", 42n], [
        "2",
        1n,
      ]]),
    });
    assert.deepEqual(message, {
      kind: "record",
      fields: new Map<string, RuntimeValue>([["0", view], [
        "1",
        "Live events, editable code.\n",
      ]]),
    });
    controller.abort(cancellation);
    await rejected;
    assert.equal(stopped, 1);
    assert.equal(detached, 1);
  } finally {
    await runtime.close();
    await root.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
