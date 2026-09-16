// Real-thread smoke tests for the Node LSP worker host.
//
// Mirrors the Deno host tests: a worker thread actually boots, runs the
// deterministic cpu/probe burn, and dies on terminate. The worker entry is
// TypeScript loaded through the runtime's own module support: plain Node
// needs type-stripping (unflagged since Node 22.18; the packaged build uses
// compiled JavaScript entries instead). They use real time because thread
// boundaries do not honor a fake clock.
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LSP_WORKER_PROTOCOL_VERSION,
  lspWorkerResult,
} from "../lsp/workers/protocol.ts";
import { runCpuProbe } from "../lsp/workers/syntax_jobs.ts";
import { createNodeLspWorkerHost, entryUrlFor } from "./lsp_worker_host.ts";

test("a node worker thread runs cpu/probe for real", async () => {
  const host = createNodeLspWorkerHost("syntax", { label: "test node syntax" });
  assert.equal(host.started, false);
  assert.equal(host.offered("cpu/probe"), true);
  assert.equal(host.offered("service/request"), false);
  await host.start();
  assert.equal(host.started, true);
  const received: unknown[] = [];
  const stop = host.onResult((result: unknown) => {
    received.push(result);
  });
  try {
    const iterations = 50000;
    const seed = 7;
    host.send({
      protocol: LSP_WORKER_PROTOCOL_VERSION,
      job: 1,
      kind: "cpu/probe",
      iterations,
      seed,
    });
    const result = lspWorkerResult(await waitFor(received, 30000));
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("worker probe failed");
    assert.equal(result.job, 1);
    assert.equal(result.kind, "cpu/probe");
    assert.deepEqual(result.value, runCpuProbe(iterations, seed));
  } finally {
    stop();
    await host.terminate();
  }
  assert.equal(host.started, false);
});

test("node terminate abandons an in-flight burn and restarts", async () => {
  const host = createNodeLspWorkerHost("syntax", { label: "test node cut" });
  await host.start();
  const received: unknown[] = [];
  host.onResult((result: unknown) => {
    received.push(result);
  });
  host.send({
    protocol: LSP_WORKER_PROTOCOL_VERSION,
    job: 2,
    kind: "cpu/probe",
    iterations: 2000000000,
    seed: 1,
  });
  await host.terminate();
  await sleep(500);
  assert.equal(received.length, 0);
  await host.start();
  host.send({
    protocol: LSP_WORKER_PROTOCOL_VERSION,
    job: 3,
    kind: "cpu/probe",
    iterations: 1000,
    seed: 3,
  });
  const result = lspWorkerResult(await waitFor(received, 30000));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("worker probe failed");
  assert.equal(result.job, 3);
  assert.deepEqual(result.value, runCpuProbe(1000, 3));
  await host.terminate();
});

test("node worker entries live beside the host module", async () => {
  const syntax = entryUrlFor("syntax");
  const semantic = entryUrlFor("semantic");
  assert.equal(
    syntax.pathname.endsWith("/src/lsp/workers/syntax_worker_node.ts"),
    true,
  );
  assert.equal(
    semantic.pathname.endsWith("/src/lsp/workers/semantic_worker_node.ts"),
    true,
  );
  for (const entry of [syntax, semantic]) {
    assert.equal((await stat(fileURLToPath(entry))).isFile(), true);
  }
});

async function waitFor(
  received: readonly unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const first = received[0];
    if (first !== undefined) return first;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the worker result");
    }
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
