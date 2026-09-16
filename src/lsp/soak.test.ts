// src/lsp/soak.test.ts
//
// Cache/worker soak: repeated open/change/close + format + hover cycles
// against auto-resolving hosts, with one injected semantic crash mid-soak.
// Every request settles exactly once, no cycle accumulates unsettled work,
// the crash reconstructs and resyncs, and shutdown terminates cleanly.

import { assert, assertEquals } from "@std/assert";
import { FakeLspWorkerHost } from "./fake_host.ts";
import { runCoordinatorServer } from "./server.ts";
import type { TraceEvent } from "./scheduler.ts";
import {
  decodeCaptured,
  FakeClock,
  memoryTransport,
  settleMicrotasks,
} from "./testing.ts";
import type { LspWorkerJob } from "./workers/protocol.ts";

const CYCLES = 30;
const CRASH_AT_CYCLE = 15;

function syntaxAnswer(job: LspWorkerJob): unknown {
  if (
    job.kind === "service/request" && job.method === "textDocument/formatting"
  ) {
    return [];
  }
  return null;
}

function semanticAnswer(job: LspWorkerJob): unknown {
  if (job.kind === "service/request" && job.method === "textDocument/hover") {
    return { contents: "soak" };
  }
  if (
    job.kind === "service/request" && job.method === "textDocument/diagnostic"
  ) {
    return [];
  }
  return null;
}

Deno.test("open/change/close soak settles every cycle without growth", async () => {
  const transport = memoryTransport();
  const clock = new FakeClock();
  const syntax = new FakeLspWorkerHost("syntax", {
    behavior: { mode: "auto", handle: syntaxAnswer },
  });
  const semantic = new FakeLspWorkerHost("semantic", {
    behavior: { mode: "auto", handle: semanticAnswer },
  });
  const traces: TraceEvent[] = [];
  const workerErrors: Error[] = [];
  syntax.onError((error) => workerErrors.push(error));
  semantic.onError((error) => workerErrors.push(error));
  let syntaxResults = 0;
  let semanticResults = 0;
  syntax.onResult(() => {
    syntaxResults += 1;
  });
  semantic.onResult(() => {
    semanticResults += 1;
  });
  const done = runCoordinatorServer(transport.input, transport.output, {
    clock,
    syntaxHost: syntax,
    semanticHost: semantic,
    traceSink: (event) => traces.push(event),
    shutdownDrainMs: 0,
  });
  const uri = "untitled:soak.blot";
  const requestIds: number[] = [];
  transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  transport.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await settleMicrotasks();
  let version = 1;
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, version, text: `return ${cycle}\n` } },
    });
    await settleMicrotasks();
    version += 1;
    transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text: `return ${cycle + 1}\n` }],
      },
    });
    await settleMicrotasks();
    if (cycle === CRASH_AT_CYCLE) {
      semantic.crash(new Error("soak-injected crash"));
      await settleMicrotasks();
    }
    const formattingId = 1000 + cycle;
    const hoverId = 2000 + cycle;
    requestIds.push(formattingId, hoverId);
    transport.send({
      jsonrpc: "2.0",
      id: formattingId,
      method: "textDocument/formatting",
      params: { textDocument: { uri }, options: {} },
    });
    transport.send({
      jsonrpc: "2.0",
      id: hoverId,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line: 0, character: 7 } },
    });
    await settleMicrotasks();
    transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
    await settleMicrotasks();
    version += 1;
    // No cycle may leave unsettled requests behind: everything sent so far
    // is answered before the next cycle starts.
    const mid = await decodeCaptured(transport.chunks());
    for (const id of requestIds) {
      const matches = mid.filter((message) => {
        const record = message as Record<string, unknown>;
        return record.method === undefined && record.id === id;
      });
      assertEquals(matches.length, 1, `cycle ${cycle} left ${id} unsettled`);
    }
  }
  transport.send({ jsonrpc: "2.0", id: 9, method: "shutdown", params: null });
  await settleMicrotasks();
  transport.send({ jsonrpc: "2.0", method: "exit", params: null });
  transport.closeInput();
  await done;
  const final = await decodeCaptured(transport.chunks());
  const shutdown = final.find((message) =>
    (message as Record<string, unknown>).id === 9
  ) as Record<string, unknown>;
  assertEquals(shutdown.result, null);
  let errors = 0;
  for (const id of [...requestIds, 1, 9]) {
    const matches = final.filter((message) => {
      const record = message as Record<string, unknown>;
      return record.method === undefined && record.id === id;
    });
    assertEquals(
      matches.length,
      1,
      `request ${id} did not settle exactly once`,
    );
    if ((matches[0] as Record<string, unknown>).error !== undefined) {
      errors += 1;
    }
  }
  assertEquals(errors, 0);
  // Exactly one worker failure: the injected crash. It reconstructed and
  // resynced (a second start, a second doc/open for the soak uri).
  assertEquals(workerErrors.length, 1);
  assertEquals(semantic.startCount, 2);
  assertEquals(syntax.started, false);
  assertEquals(semantic.started, false);
  const opens = semantic.sentJobs.filter((job) =>
    job.kind === "doc/open" && job.uri === uri
  );
  assert(opens.length >= 2);
  const reconstructions = traces.filter((event) =>
    event.kind === "lane/reconstructed"
  );
  assertEquals(reconstructions.length, 1);
  // Every worker answer arrived: nothing was dropped on the floor.
  assert(syntaxResults > 0);
  assert(semanticResults > 0);
});
