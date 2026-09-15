import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDenoLspWorkerHost } from "../deno/lsp_worker_host.ts";
import { FakeLspWorkerHost } from "./fake_host.ts";
import type { LspWorkerJob } from "./workers/protocol.ts";
import type { TraceEvent } from "./scheduler.ts";
import { runCoordinatorServer } from "./server.ts";
import type { LanguageServerOptions } from "./server.ts";
import {
  decodeCaptured,
  FakeClock,
  memoryTransport,
  settleMicrotasks,
} from "./testing.ts";
import type { MemoryTransport } from "./testing.ts";
import { TruncatedInputError } from "./transport.ts";

interface ServerHarness {
  transport: MemoryTransport;
  clock: FakeClock;
  syntax: FakeLspWorkerHost;
  semantic: FakeLspWorkerHost;
  traces: TraceEvent[];
  done: Promise<void>;
}

function startServer(options: LanguageServerOptions = {}): ServerHarness {
  const transport = memoryTransport();
  const clock = new FakeClock();
  const syntax = new FakeLspWorkerHost("syntax");
  const semantic = new FakeLspWorkerHost("semantic");
  const traces: TraceEvent[] = [];
  const merged: LanguageServerOptions = {
    clock,
    syntaxHost: syntax,
    semanticHost: semantic,
    traceSink: (event) => traces.push(event),
    shutdownDrainMs: 0,
    ...options,
  };
  const done = runCoordinatorServer(transport.input, transport.output, merged);
  return { transport, clock, syntax, semantic, traces, done };
}

async function openDocument(
  test: ServerHarness,
  uri: string,
  text: string,
): Promise<void> {
  test.transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  test.transport.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text } },
  });
  await settleMicrotasks();
  assertEquals(test.semantic.heldJobs().length, 1);
  assertEquals(test.semantic.heldJobs()[0].kind, "doc/open");
  test.semantic.releaseNext(null);
  await settleMicrotasks();
  assertEquals(test.semantic.heldJobs().length, 1);
  assertEquals(
    jobMethod(test.semantic.heldJobs()[0]),
    "textDocument/diagnostic",
  );
}

function jobMethod(job: LspWorkerJob): string {
  if (job.kind === "service/request") return job.method;
  return job.kind;
}

function responses(messages: readonly unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    const record = message as Record<string, unknown>;
    if (record.method === undefined) out.push(record);
  }
  return out;
}

function responseFor(
  messages: readonly unknown[],
  id: unknown,
): Record<string, unknown> | undefined {
  for (const response of responses(messages)) {
    if (response.id === id) return response;
  }
  return undefined;
}

function notificationsFor(
  messages: readonly unknown[],
  method: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    const record = message as Record<string, unknown>;
    if (record.method === method) out.push(record);
  }
  return out;
}

function errorOf(response: Record<string, unknown>): {
  code: number;
  message: string;
  data: unknown;
} {
  return response.error as { code: number; message: string; data: unknown };
}

async function releaseAll(
  test: ServerHarness,
  value: unknown = null,
): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    let released = false;
    while (test.syntax.heldJobs().length > 0) {
      test.syntax.releaseNext(value);
      released = true;
    }
    while (test.semantic.heldJobs().length > 0) {
      test.semantic.releaseNext(value);
      released = true;
    }
    await settleMicrotasks();
    if (
      !released && test.syntax.heldJobs().length === 0 &&
      test.semantic.heldJobs().length === 0
    ) {
      break;
    }
  }
}

async function finish(test: ServerHarness): Promise<unknown[]> {
  await releaseAll(test);
  test.transport.send({ jsonrpc: "2.0", method: "exit", params: null });
  test.transport.closeInput();
  await test.done;
  return await decodeCaptured(test.transport.chunks());
}

Deno.test("formatting completes while the semantic worker is held", async () => {
  const test = startServer();
  const uri = "untitled:format-barrier.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  assertEquals(jobMethod(test.semantic.heldJobs()[0]), "textDocument/hover");
  test.transport.send({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/formatting",
    params: { textDocument: { uri }, options: {} },
  });
  await settleMicrotasks();
  assertEquals(test.syntax.heldJobs().length, 1);
  const edits = [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 },
    },
    newText: "return 1\n",
  }];
  test.syntax.releaseNext(edits);
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const formatted = responseFor(mid, 3);
  assert(formatted !== undefined);
  assertEquals(formatted.result, edits);
  assert(responseFor(mid, 2) === undefined);
  test.semantic.releaseNext({ contents: "held" });
  await settleMicrotasks();
  const done = await finish(test);
  assert(responseFor(done, 2) !== undefined);
});

Deno.test("formatting settles on a real thread while semantic is held", async () => {
  // The coordinator must serve formatting from the syntax host without
  // touching the semantic host: here the syntax lane is a real worker
  // thread and the semantic lane never releases, so a format that
  // depended on semantic work could never settle.
  const transport = memoryTransport();
  const clock = new FakeClock();
  const syntax = createDenoLspWorkerHost("syntax");
  const semantic = new FakeLspWorkerHost("semantic");
  const done = runCoordinatorServer(transport.input, transport.output, {
    clock,
    syntaxHost: syntax,
    semanticHost: semantic,
    shutdownDrainMs: 0,
  });
  const uri = "untitled:held-semantic.blot";
  try {
    transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    transport.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, version: 1, text: "let   x=1\nreturn x\n" },
      },
    });
    await settleMicrotasks();
    assertEquals(semantic.heldJobs().length, 1);
    semantic.releaseNext(null);
    await settleMicrotasks();
    transport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line: 1, character: 7 } },
    });
    transport.send({
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/formatting",
      params: { textDocument: { uri }, options: {} },
    });
    for (let round = 0; round < 200; round += 1) {
      await settleMicrotasks();
      const mid = await decodeCaptured(transport.chunks());
      if (responseFor(mid, 3) !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const mid = await decodeCaptured(transport.chunks());
    const formatted = responseFor(mid, 3);
    assert(formatted !== undefined, "formatting never settled");
    assertEquals(formatted.result, [{
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 8 },
      },
      newText: "x = ",
    }]);
    assert(responseFor(mid, 2) === undefined);
  } finally {
    transport.send({ jsonrpc: "2.0", method: "exit", params: null });
    transport.closeInput();
    await done;
  }
});

Deno.test("cancellation is answered while a worker job runs", async () => {
  const test = startServer();
  const uri = "untitled:cancel-busy.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "$/cancelRequest",
    params: { id: 2 },
  });
  await settleMicrotasks();
  test.semantic.releaseNext({ contents: "too late" });
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const cancelled = responseFor(mid, 2);
  assert(cancelled !== undefined);
  assertEquals(errorOf(cancelled).code, -32800);
  await finish(test);
});

Deno.test("a typing burst publishes one latest diagnostic set", async () => {
  const test = startServer();
  const uri = "untitled:burst.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  for (let version = 2; version <= 6; version += 1) {
    test.transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text: `return ${version}\n` }],
      },
    });
  }
  await settleMicrotasks();
  const serviceSends = test.semantic.sentJobs.filter((job) =>
    job.kind === "service/request"
  );
  assertEquals(serviceSends.length, 1);
  for (let drained = 0; drained < 5; drained += 1) {
    const held = test.semantic.heldJobs();
    assertEquals(held.length, 1);
    assertEquals(held[0].kind, "doc/change");
    test.semantic.releaseNext(null);
    await settleMicrotasks();
  }
  assertEquals(test.semantic.heldJobs().length, 0);
  const drained = await decodeCaptured(test.transport.chunks());
  assertEquals(
    notificationsFor(drained, "textDocument/publishDiagnostics").length,
    1,
  );
  await test.clock.advance(150);
  await settleMicrotasks();
  const after = test.semantic.sentJobs.filter((job) =>
    job.kind === "service/request"
  );
  assertEquals(after.length, 2);
  test.semantic.releaseNext([{ burst: true }]);
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const published = notificationsFor(mid, "textDocument/publishDiagnostics");
  assertEquals(published.length, 2);
  assertEquals(
    (published[1].params as { version: number }).version,
    6,
  );
  await finish(test);
});

Deno.test("cancel before dispatch never sends the job", async () => {
  const test = startServer();
  const uri = "untitled:cancel-queued.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const hover = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  test.transport.send(hover(2));
  test.transport.send(hover(3));
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "$/cancelRequest",
    params: { id: 3 },
  });
  await settleMicrotasks();
  test.semantic.releaseNext("first");
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 3);
  const mid = await decodeCaptured(test.transport.chunks());
  const cancelled = responseFor(mid, 3);
  assert(cancelled !== undefined);
  assertEquals(errorOf(cancelled).code, -32800);
  await finish(test);
});

Deno.test("cancel after settlement changes nothing", async () => {
  const test = startServer();
  const uri = "untitled:cancel-late.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.semantic.releaseNext("value");
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "$/cancelRequest",
    params: { id: 2 },
  });
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const matching = responses(mid).filter((response) => response.id === 2);
  assertEquals(matching.length, 1);
  assertEquals(matching[0].result, "value");
  await finish(test);
});

Deno.test("a change between stages settles ContentModified", async () => {
  const test = startServer();
  const uri = "untitled:change-stages.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "return 2\n" }],
    },
  });
  await settleMicrotasks();
  test.semantic.releaseNext("stale");
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const modified = responseFor(mid, 2);
  assert(modified !== undefined);
  assertEquals(errorOf(modified).code, -32801);
  await finish(test);
});

Deno.test("queued work observes didChange invalidation without dispatch", async () => {
  const test = startServer();
  const uri = "untitled:change-queued.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const hover = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  test.transport.send(hover(2));
  test.transport.send(hover(3));
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "return 2\n" }],
    },
  });
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 3);
  assertEquals(
    test.semantic.sentJobs.map((job) => jobMethod(job)),
    ["doc/open", "textDocument/diagnostic", "textDocument/hover"],
  );
  test.semantic.releaseNext("stale");
  await settleMicrotasks();
  assertEquals(test.semantic.heldJobs().length, 1);
  assertEquals(test.semantic.heldJobs()[0].kind, "doc/change");
  const mid = await decodeCaptured(test.transport.chunks());
  assertEquals(
    errorOf(responseFor(mid, 2) as Record<string, unknown>).code,
    -32801,
  );
  assertEquals(
    errorOf(responseFor(mid, 3) as Record<string, unknown>).code,
    -32801,
  );
  await finish(test);
});

Deno.test("close while busy publishes empty without waiting", async () => {
  const test = startServer();
  const uri = "untitled:close-busy.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didClose",
    params: { textDocument: { uri } },
  });
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const published = notificationsFor(mid, "textDocument/publishDiagnostics");
  const last = published[published.length - 1];
  assertEquals(last.params, { uri, diagnostics: [] });
  assert(responseFor(mid, 2) === undefined);
  test.semantic.releaseNext("stale");
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(
    errorOf(responseFor(after, 2) as Record<string, unknown>).code,
    -32801,
  );
  await finish(test);
});

Deno.test("close and reopen with a reused version starts a new generation", async () => {
  const test = startServer();
  const uri = "untitled:reused-version.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didClose",
    params: { textDocument: { uri } },
  });
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text: "return 2\n" } },
  });
  await settleMicrotasks();
  test.semantic.releaseNext("stale");
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  assertEquals(
    errorOf(responseFor(mid, 2) as Record<string, unknown>).code,
    -32801,
  );
  test.transport.send({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  await releaseAll(test, "fresh");
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(after, 3)?.result, "fresh");
  await finish(test);
});

Deno.test("a worker crash fails loudly and the lane resumes after resync", async () => {
  const test = startServer();
  const uri = "untitled:crash.blot";
  const text = "return 1\n";
  await openDocument(test, uri, text);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const hover = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  test.transport.send(hover(2));
  test.transport.send(hover(3));
  await settleMicrotasks();
  test.semantic.crash(new Error("boom"));
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const failed = responseFor(mid, 2);
  assert(failed !== undefined);
  assertEquals(errorOf(failed).code, -32603);
  assertEquals(
    (errorOf(failed).data as { kind: string }).kind,
    "worker",
  );
  assert(responseFor(mid, 3) === undefined);
  const kinds = test.semantic.sentJobs.map((job) => jobMethod(job));
  assert(kinds.includes("doc/open"));
  const reopened = test.semantic.sentJobs.find((job) =>
    job.kind === "doc/open"
  );
  assert(reopened !== undefined && reopened.kind === "doc/open");
  assertEquals(reopened.source, text);
  test.semantic.releaseNext(null);
  await settleMicrotasks();
  test.semantic.releaseNext("third");
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(after, 3)?.result, "third");
  await finish(test);
});

Deno.test("the watchdog recycles the worker and discards late results", async () => {
  const test = startServer({ formatDeadlineMs: 200, obsoleteGraceMs: 50 });
  const uri = "untitled:watchdog.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri }, options: {} },
  });
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 1);
  const jobId = test.syntax.sentJobs[0].job;
  await test.clock.advance(200);
  const mid = await decodeCaptured(test.transport.chunks());
  const expired = responseFor(mid, 2);
  assert(expired !== undefined);
  assertEquals(errorOf(expired).code, -32603);
  assertEquals(errorOf(expired).data, {
    kind: "deadline",
    method: "textDocument/formatting",
    deadlineMs: 200,
  });
  assertEquals(test.syntax.startCount, 1);
  await test.clock.advance(50);
  assertEquals(test.syntax.startCount, 2);
  assertEquals(test.syntax.heldJobs().length, 0);
  test.syntax.emitRawResult({
    protocol: 1,
    job: jobId,
    ok: true,
    kind: "service/request",
    value: "late",
  });
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(
    responses(after).filter((response) => response.id === 2).length,
    1,
  );
  test.transport.send({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/formatting",
    params: { textDocument: { uri }, options: {} },
  });
  await settleMicrotasks();
  test.syntax.releaseNext([]);
  await settleMicrotasks();
  const recovered = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(recovered, 3)?.result, []);
  await finish(test);
});

Deno.test("startup failure settles explicitly and the next request recovers", async () => {
  const test = startServer();
  const uri = "untitled:startup.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.semantic.failStartupWith(new Error("no thread for you"));
  test.semantic.terminate();
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const failed = responseFor(mid, 2);
  assert(failed !== undefined);
  assertEquals(errorOf(failed).code, -32603);
  assertEquals((errorOf(failed).data as { kind: string }).kind, "worker");
  test.semantic.clearStartupFailure();
  test.transport.send({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.semantic.releaseNext("recovered");
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(after, 3)?.result, "recovered");
  await finish(test);
});

Deno.test("shutdown settles foreground work, then the hosts go away", async () => {
  const test = startServer({ shutdownDrainMs: 5000 });
  const uri = "untitled:drain.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const hover = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  test.transport.send(hover(2));
  test.transport.send(hover(3));
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 9,
    method: "shutdown",
    params: null,
  });
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(mid, 9)?.result, null);
  assert(responseFor(mid, 2) === undefined);
  test.semantic.releaseNext("second");
  await settleMicrotasks();
  test.semantic.releaseNext("third");
  await settleMicrotasks();
  test.transport.send({ jsonrpc: "2.0", method: "exit", params: null });
  test.transport.closeInput();
  await test.done;
  const done = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(done, 2)?.result, "second");
  assertEquals(responseFor(done, 3)?.result, "third");
  assertEquals(test.syntax.started, false);
  assertEquals(test.semantic.started, false);
});

Deno.test("the shutdown bound abandons leftovers explicitly", async () => {
  const test = startServer({ shutdownDrainMs: 500 });
  const uri = "untitled:drain-bound.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 9,
    method: "shutdown",
    params: null,
  });
  await settleMicrotasks();
  await test.clock.advance(500);
  test.transport.send({ jsonrpc: "2.0", method: "exit", params: null });
  test.transport.closeInput();
  await test.done;
  const done = await decodeCaptured(test.transport.chunks());
  const abandoned = responseFor(done, 2);
  assert(abandoned !== undefined);
  assertEquals(errorOf(abandoned).code, -32603);
  assertEquals((errorOf(abandoned).data as { kind: string }).kind, "resource");
});

Deno.test("bounded overload fails fast past the lane bound", async () => {
  const test = startServer({ maxPendingPerLane: 1 });
  const uri = "untitled:overload.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const hover = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  const sentBefore = test.semantic.sentJobs.length;
  test.transport.send(hover(2));
  test.transport.send(hover(3));
  test.transport.send(hover(4));
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, sentBefore + 1);
  const mid = await decodeCaptured(test.transport.chunks());
  const rejected = responseFor(mid, 4);
  assert(rejected !== undefined);
  assertEquals(errorOf(rejected).code, -32603);
  assertEquals((errorOf(rejected).data as { kind: string }).kind, "resource");
  test.semantic.releaseNext("second");
  await settleMicrotasks();
  test.semantic.releaseNext("third");
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(after, 2)?.result, "second");
  assertEquals(responseFor(after, 3)?.result, "third");
  await finish(test);
});

Deno.test("the server answers framing and routing failures distinctly", async () => {
  const test = startServer();
  const uri = "untitled:failures.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const encoder = new TextEncoder();
  test.transport.sendBytes(encoder.encode("Content-Length: 5\r\n\r\n{oops"));
  test.transport.send({
    jsonrpc: "2.0",
    id: 7,
    method: "nope/missing",
    params: {},
  });
  test.transport.send({
    jsonrpc: "2.0",
    id: 8,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  });
  await settleMicrotasks();
  test.semantic.releaseNext("hovered");
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const parse = responseFor(mid, null);
  assert(parse !== undefined);
  assertEquals(errorOf(parse).code, -32700);
  const missing = responseFor(mid, 7);
  assert(missing !== undefined);
  assertEquals(errorOf(missing).code, -32601);
  assertEquals(responseFor(mid, 8)?.result, "hovered");
  await finish(test);
});

Deno.test("oversized frames log while the stream continues", async () => {
  const test = startServer({ framing: { maxBodyBytes: 200 } });
  const uri = "untitled:oversize.blot";
  test.transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  test.transport.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: `x:${"y".repeat(200)}\n` },
    },
  });
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text: "ok\n" } },
  });
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const logs = notificationsFor(mid, "window/logMessage");
  assertEquals(logs.length, 1);
  assertEquals(
    (logs[0].params as { message: string }).message,
    "LSP body of 334 bytes exceeds the 200 byte limit",
  );
  assertEquals(test.semantic.heldJobs().length, 1);
  assertEquals(test.semantic.heldJobs()[0].kind, "doc/open");
  await finish(test);
});

Deno.test("truncated input rejects the run distinctly", async () => {
  const test = startServer();
  const encoder = new TextEncoder();
  test.transport.sendBytes(
    encoder.encode('Content-Length: 100\r\n\r\n{"id":1'),
  );
  test.transport.closeInput();
  await assertRejects(() => test.done, TruncatedInputError);
});

Deno.test("the lifecycle gates, runs, and shuts down in order", async () => {
  const test = startServer();
  const uri = "untitled:lifecycle.blot";
  test.transport.send({
    jsonrpc: "2.0",
    id: 10,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 0 } },
  });
  test.transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text: "return 1\n" } },
  });
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 0 } },
  });
  await settleMicrotasks();
  await releaseAll(test, "early");
  const mid = await decodeCaptured(test.transport.chunks());
  assertEquals(
    errorOf(responseFor(mid, 10) as Record<string, unknown>).code,
    -32002,
  );
  assertEquals(responseFor(mid, 2)?.result, "early");
  test.transport.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  test.transport.send({
    jsonrpc: "2.0",
    id: 9,
    method: "shutdown",
    params: null,
  });
  test.transport.send({
    jsonrpc: "2.0",
    id: 11,
    method: "shutdown",
    params: null,
  });
  test.transport.send({
    jsonrpc: "2.0",
    id: 12,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 0 } },
  });
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(after, 9)?.result, null);
  assertEquals(responseFor(after, 11)?.result, null);
  assertEquals(
    errorOf(responseFor(after, 12) as Record<string, unknown>).code,
    -32600,
  );
  await finish(test);
});

Deno.test("code actions omit deferred edits until resolve", async () => {
  const test = startServer();
  const uri = "untitled:actions.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 8 },
      },
      context: { diagnostics: [] },
    },
  });
  await settleMicrotasks();
  // Code actions can reach the compiler through the service replica, so
  // they run on the semantic lane with every other service method.
  assertEquals(test.semantic.heldJobs().length, 1);
  test.semantic.releaseNext([
    {
      title: "deferred",
      kind: "source.fixAll.blot",
      diagnostics: [],
      data: { uri, version: 1 },
      edit: { documentChanges: [] },
    },
    {
      title: "direct",
      kind: "quickfix",
      diagnostics: [],
      edit: { documentChanges: [] },
    },
  ]);
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const actions = responseFor(mid, 2)?.result as Record<string, unknown>[];
  assertEquals(actions.length, 2);
  assert(!("edit" in actions[0]));
  assert("edit" in actions[1]);
  await finish(test);
});

Deno.test("saving promotes diagnostics while formatting runs free", async () => {
  const test = startServer();
  const uri = "untitled:save-format.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "return 2\n" }],
    },
  });
  await settleMicrotasks();
  const serviceSends = test.semantic.sentJobs.filter((job) =>
    job.kind === "service/request"
  );
  assertEquals(serviceSends.length, 1);
  assertEquals(test.semantic.heldJobs()[0].kind, "doc/change");
  test.transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri }, options: {} },
  });
  await settleMicrotasks();
  assertEquals(test.syntax.heldJobs().length, 1);
  test.semantic.releaseNext(null);
  await settleMicrotasks();
  const unpromoted = test.semantic.sentJobs.filter((job) =>
    job.kind === "service/request"
  );
  assertEquals(unpromoted.length, 1);
  test.transport.send({
    jsonrpc: "2.0",
    method: "textDocument/didSave",
    params: { textDocument: { uri } },
  });
  await settleMicrotasks();
  const promoted = test.semantic.sentJobs.filter((job) =>
    job.kind === "service/request"
  );
  assertEquals(promoted.length, 2);
  test.syntax.releaseNext([]);
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(mid, 2)?.result, []);
  assertEquals(test.semantic.heldJobs().length, 1);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const done = await decodeCaptured(test.transport.chunks());
  const published = notificationsFor(done, "textDocument/publishDiagnostics");
  assertEquals(
    (published[published.length - 1].params as { version: number }).version,
    2,
  );
  await finish(test);
});

Deno.test("a duplicate live id fails the newcomer, not the original", async () => {
  const test = startServer();
  const uri = "untitled:duplicate.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const hover = {
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 0, character: 7 } },
  };
  test.transport.send(hover);
  test.transport.send(hover);
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const dupes = responses(mid).filter((response) => response.id === 2);
  assertEquals(dupes.length, 1);
  assertEquals(errorOf(dupes[0]).code, -32600);
  test.semantic.releaseNext("original");
  await settleMicrotasks();
  const after = await decodeCaptured(test.transport.chunks());
  const both = responses(after).filter((response) => response.id === 2);
  assertEquals(both.length, 2);
  assertEquals(both[1].result, "original");
  await finish(test);
});

Deno.test("diagnostics publish with the diagnosed version and value", async () => {
  const test = startServer();
  const uri = "untitled:diag-shape.blot";
  await openDocument(test, uri, "return 1\n");
  const canned = [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    code: "X",
    source: "blot",
    message: "canned",
  }];
  test.semantic.releaseNext(canned);
  await settleMicrotasks();
  const mid = await decodeCaptured(test.transport.chunks());
  const published = notificationsFor(mid, "textDocument/publishDiagnostics");
  assertEquals(published.length, 1);
  assertEquals(published[0].params, { uri, version: 1, diagnostics: canned });
  await finish(test);
});

Deno.test("a hostile burst settles every request exactly once", async () => {
  const test = startServer();
  const uri = "untitled:hostile-burst.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  for (let version = 2; version <= 21; version += 1) {
    test.transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text: `return ${version}\n` }],
      },
    });
  }
  const formattingIds = [100, 101, 102, 103, 104, 105];
  const hoverIds = [200, 201, 202, 203, 204, 205];
  for (const id of formattingIds) {
    test.transport.send({
      jsonrpc: "2.0",
      id,
      method: "textDocument/formatting",
      params: { textDocument: { uri }, options: {} },
    });
  }
  for (const id of hoverIds) {
    test.transport.send({
      jsonrpc: "2.0",
      id,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line: 0, character: 7 } },
    });
  }
  await settleMicrotasks();
  // The syntax lane drains while the semantic lane stays held: no semantic
  // result is released until every syntax-lane answer is out.
  const semanticSentBefore = test.semantic.sentJobs.length;
  assert(semanticSentBefore > 0);
  const pending = new Set(formattingIds);
  for (let round = 0; round < 40 && pending.size > 0; round += 1) {
    if (test.syntax.heldJobs().length > 0) test.syntax.releaseNext([]);
    await settleMicrotasks();
    const mid = await decodeCaptured(test.transport.chunks());
    for (const id of [...pending]) {
      if (responseFor(mid, id) !== undefined) pending.delete(id);
    }
  }
  assertEquals([...pending], []);
  const mid = await decodeCaptured(test.transport.chunks());
  for (const id of hoverIds) assert(responseFor(mid, id) === undefined);
  // The semantic lane still holds unsent work while every syntax answer
  // is out: syntax never waited on semantic.
  assert(test.semantic.heldJobs().length > 0);
  for (let round = 0; round < 80; round += 1) {
    let released = false;
    while (test.syntax.heldJobs().length > 0) {
      test.syntax.releaseNext([]);
      released = true;
    }
    while (test.semantic.heldJobs().length > 0) {
      test.semantic.releaseNext({ contents: "burst" });
      released = true;
    }
    await settleMicrotasks();
    if (
      !released && test.syntax.heldJobs().length === 0 &&
      test.semantic.heldJobs().length === 0
    ) {
      break;
    }
  }
  const done = await finish(test);
  const settled = responses(done);
  for (const id of [...formattingIds, ...hoverIds]) {
    const matches = settled.filter((response) => response.id === id);
    assertEquals(matches.length, 1);
    assert(matches[0].error === undefined);
  }
});

Deno.test("shutdown during a hostile burst settles every request", async () => {
  const test = startServer();
  const uri = "untitled:hostile-shutdown.blot";
  await openDocument(test, uri, "return 1\n");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  for (let version = 2; version <= 11; version += 1) {
    test.transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text: `return ${version}\n` }],
      },
    });
  }
  const foregroundIds = [100, 101, 102, 103, 200, 201, 202, 203];
  for (const id of foregroundIds) {
    const formatting = id < 200;
    test.transport.send({
      jsonrpc: "2.0",
      id,
      method: formatting ? "textDocument/formatting" : "textDocument/hover",
      params: formatting
        ? { textDocument: { uri }, options: {} }
        : { textDocument: { uri }, position: { line: 0, character: 7 } },
    });
  }
  await settleMicrotasks();
  test.transport.send({
    jsonrpc: "2.0",
    id: 9,
    method: "shutdown",
    params: null,
  });
  await settleMicrotasks();
  test.transport.send({ jsonrpc: "2.0", method: "exit", params: null });
  test.transport.closeInput();
  await test.done;
  const done = await decodeCaptured(test.transport.chunks());
  assertEquals(responseFor(done, 9)?.result, null);
  const settled = responses(done);
  for (const id of foregroundIds) {
    const matches = settled.filter((response) => response.id === id);
    assertEquals(matches.length, 1);
    assert(matches[0].error !== undefined);
  }
  assertEquals(test.syntax.started, false);
  assertEquals(test.semantic.started, false);
});
