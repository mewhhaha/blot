// Real-thread smoke tests for the Deno LSP worker host.
//
// The scheduler and server suites prove ordering against the fake host; these
// tests prove a Deno worker thread actually boots, runs the deterministic
// cpu/probe burn, and dies on terminate. They use real time because thread
// boundaries do not honor a fake clock.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  LSP_WORKER_PROTOCOL_VERSION,
  lspWorkerResult,
} from "../lsp/workers/protocol.ts";
import { runCpuProbe } from "../lsp/workers/syntax_jobs.ts";
import { createDenoLspWorkerHost, entryUrlFor } from "./lsp_worker_host.ts";

Deno.test("a deno worker thread runs cpu/probe for real", async () => {
  const host = createDenoLspWorkerHost("syntax", { label: "test deno syntax" });
  assertEquals(host.started, false);
  assertEquals(host.offered("cpu/probe"), true);
  assertEquals(host.offered("service/request"), false);
  await host.start();
  assertEquals(host.started, true);
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
    assert(result.ok);
    assertEquals(result.job, 1);
    assertEquals(result.kind, "cpu/probe");
    assertEquals(result.value, runCpuProbe(iterations, seed));
  } finally {
    stop();
    await host.terminate();
  }
  assertEquals(host.started, false);
});

Deno.test("deno terminate abandons an in-flight burn and restarts", async () => {
  const host = createDenoLspWorkerHost("syntax", { label: "test deno cut" });
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
  assertEquals(received.length, 0);
  await host.start();
  host.send({
    protocol: LSP_WORKER_PROTOCOL_VERSION,
    job: 3,
    kind: "cpu/probe",
    iterations: 1000,
    seed: 3,
  });
  const result = lspWorkerResult(await waitFor(received, 30000));
  assert(result.ok);
  assertEquals(result.job, 3);
  assertEquals(result.value, runCpuProbe(1000, 3));
  await host.terminate();
});

Deno.test("deno worker entries live beside the host module", async () => {
  const syntax = entryUrlFor("syntax");
  const semantic = entryUrlFor("semantic");
  assertEquals(
    syntax.pathname.endsWith("/src/lsp/workers/syntax_worker.ts"),
    true,
  );
  assertEquals(
    semantic.pathname.endsWith("/src/lsp/workers/semantic_worker.ts"),
    true,
  );
  for (const entry of [syntax, semantic]) {
    const stat = await Deno.stat(fromFileUrl(entry));
    assert(stat.isFile, `${entry.pathname} is not a file`);
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
