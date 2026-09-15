import { assert, assertEquals } from "@std/assert";
import type { DocumentSnapshot } from "./documents.ts";
import { CoordinatorDocuments } from "./documents.ts";
import type { RequestId } from "./errors.ts";
import { FakeLspWorkerHost } from "./fake_host.ts";
import { RequestRegistry } from "./requests.ts";
import type { Settlement } from "./requests.ts";
import { laneForMethod, Scheduler } from "./scheduler.ts";
import type { LaneName, LaneTask, TraceEvent } from "./scheduler.ts";
import { FakeClock, settleMicrotasks } from "./testing.ts";
import { LSP_WORKER_PROTOCOL_VERSION } from "./workers/protocol.ts";
import type { LspWorkerJobKind, LspWorkerResult } from "./workers/protocol.ts";

interface Harness {
  clock: FakeClock;
  documents: CoordinatorDocuments;
  registry: RequestRegistry;
  syntax: FakeLspWorkerHost;
  semantic: FakeLspWorkerHost;
  scheduler: Scheduler;
  settled: { id: RequestId; settlement: Settlement }[];
  traces: TraceEvent[];
  reconstructed: LaneName[];
}

function harness(options: {
  maxPendingPerLane?: number;
  obsoleteGraceMs?: number;
  syntaxKinds?: LspWorkerJobKind[];
  semanticKinds?: LspWorkerJobKind[];
} = {}): Harness {
  const clock = new FakeClock();
  const documents = new CoordinatorDocuments();
  const settled: Harness["settled"] = [];
  const traces: TraceEvent[] = [];
  const reconstructed: LaneName[] = [];
  const syntaxOptions: { kinds?: Set<LspWorkerJobKind> } = {};
  if (options.syntaxKinds !== undefined) {
    syntaxOptions.kinds = new Set(options.syntaxKinds);
  }
  const semanticOptions: { kinds?: Set<LspWorkerJobKind> } = {};
  if (options.semanticKinds !== undefined) {
    semanticOptions.kinds = new Set(options.semanticKinds);
  }
  const syntax = new FakeLspWorkerHost("syntax", syntaxOptions);
  const semantic = new FakeLspWorkerHost("semantic", semanticOptions);
  const registry = new RequestRegistry(clock, {
    onSettle: (id, settlement) => {
      settled.push({ id, settlement });
    },
    onDeadline: (record) => scheduler.noteExpired(record.id),
  });
  const scheduler = new Scheduler({
    clock,
    documents,
    registry,
    syntaxHost: syntax,
    semanticHost: semantic,
    maxPendingPerLane: options.maxPendingPerLane,
    obsoleteGraceMs: options.obsoleteGraceMs,
    onTrace: (event) => traces.push(event),
    onLaneReconstructed: (lane) => reconstructed.push(lane),
  });
  return {
    clock,
    documents,
    registry,
    syntax,
    semantic,
    scheduler,
    settled,
    traces,
    reconstructed,
  };
}

function openEntry(
  test: Harness,
  uri: string,
  version: number,
): DocumentSnapshot {
  return test.documents.open(uri, "return 1\n", version);
}

function requestTask(
  test: Harness,
  id: number,
  method: string,
  uri: string | null,
  entry: DocumentSnapshot | null,
): LaneTask {
  let deadline: number | undefined = undefined;
  if (method === "textDocument/formatting") deadline = 1000;
  test.registry.accept(id, method, uri, deadline);
  return {
    kind: "service/request",
    requestId: id,
    uri,
    entry,
    priority: false,
    build: (jobId: number) => ({
      protocol: LSP_WORKER_PROTOCOL_VERSION,
      job: jobId,
      kind: "service/request",
      method,
      uri,
      params: {},
    }),
    settle: (result: LspWorkerResult): void => {
      if (!result.ok) return;
      test.registry.settle(id, { kind: "result", value: result.value });
    },
    abandon: (settlement: Settlement): void => {
      test.registry.settle(id, settlement);
    },
  };
}

function internalTask(
  uri: string | null,
  entry: DocumentSnapshot | null,
  seen: { settled: number; abandoned: number },
): LaneTask {
  return {
    kind: "service/request",
    requestId: undefined,
    uri,
    entry,
    priority: false,
    build: (jobId: number) => ({
      protocol: LSP_WORKER_PROTOCOL_VERSION,
      job: jobId,
      kind: "service/request",
      method: "textDocument/diagnostic",
      uri,
      params: {},
    }),
    settle: (): void => {
      seen.settled += 1;
    },
    abandon: (): void => {
      seen.abandoned += 1;
    },
  };
}

function settlementCode(settlement: Settlement): number | null {
  if (settlement.kind === "result") return null;
  return settlement.error.code;
}

Deno.test("lanes run one active job each, independently", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/completion", "u", entry),
    "syntax",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 1);
  assertEquals(test.semantic.sentJobs.length, 1);
  assertEquals(test.scheduler.laneStats("syntax").active, true);
  assertEquals(test.scheduler.laneStats("semantic").active, true);
  test.syntax.releaseNext("syntax-value");
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
  assertEquals(test.settled[0].settlement, {
    kind: "result",
    value: "syntax-value",
  });
  assertEquals(test.semantic.heldJobs().length, 1);
  test.semantic.releaseNext("semantic-value");
  await settleMicrotasks();
  assertEquals(test.settled.length, 2);
});

Deno.test("each lane serializes its own queue in order", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/completion", "u", entry),
    "syntax",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/completion", "u", entry),
    "syntax",
  );
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 1);
  assertEquals(test.scheduler.laneStats("syntax").queued, 1);
  test.syntax.releaseNext("first");
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 2);
  test.syntax.releaseNext("second");
  await settleMicrotasks();
  assertEquals(test.settled.length, 2);
  assertEquals(test.settled[0].id, 1);
  assertEquals(test.settled[1].id, 2);
});

Deno.test("jobs overflow to the lane whose host offers the kind", async () => {
  const test = harness({ syntaxKinds: ["cpu/probe", "syntax/parse-facts"] });
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/completion", "u", entry),
    "syntax",
  );
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 0);
  assertEquals(test.semantic.sentJobs.length, 1);
  assert(test.traces.some((event) => event.kind === "lane/overflow"));
  test.semantic.releaseNext("overflowed");
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
});

Deno.test("unoffered jobs fail explicitly without touching a host", async () => {
  const test = harness({
    syntaxKinds: ["cpu/probe"],
    semanticKinds: ["cpu/probe"],
  });
  const entry = openEntry(test, "u", 1);
  const accepted = test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/completion", "u", entry),
    "syntax",
  );
  assertEquals(accepted, false);
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 0);
  assertEquals(test.semantic.sentJobs.length, 0);
  assertEquals(test.settled.length, 1);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
});

Deno.test("bounded lanes fail fast while priority sync bypasses", async () => {
  const test = harness({ maxPendingPerLane: 1 });
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  const third = test.scheduler.enqueue(
    requestTask(test, 3, "textDocument/hover", "u", entry),
    "semantic",
  );
  assertEquals(third, false);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  assertEquals(test.settled.length, 1);
  assertEquals(test.settled[0].id, 3);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
  const seen = { settled: 0, abandoned: 0 };
  const sync: LaneTask = {
    ...internalTask("u", null, seen),
    kind: "doc/change",
    priority: true,
    build: (jobId: number) => ({
      protocol: LSP_WORKER_PROTOCOL_VERSION,
      job: jobId,
      kind: "doc/change",
      uri: "u",
      changes: [],
      version: 2,
    }),
  };
  assertEquals(test.scheduler.enqueue(sync, "semantic"), true);
  test.semantic.releaseNext("first");
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs[1].kind, "doc/change");
});

Deno.test("cancel before dispatch never reaches the host", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  test.registry.clientCancel(2);
  test.scheduler.pump();
  test.semantic.releaseNext("first");
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  assertEquals(test.settled.length, 2);
  assertEquals(settlementCode(test.settled[1].settlement), -32800);
});

Deno.test("a reopened generation goes stale at dispatch", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  test.documents.close("u");
  test.documents.open("u", "return 1\n", 1);
  test.semantic.releaseNext("first");
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  assertEquals(test.settled.length, 2);
  assertEquals(settlementCode(test.settled[1].settlement), -32801);
});

Deno.test("a reopened generation goes stale at result arrival", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  test.documents.close("u");
  test.documents.open("u", "return 1\n", 1);
  test.semantic.releaseNext("stale-value");
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
  assertEquals(settlementCode(test.settled[0].settlement), -32801);
});

Deno.test("an invalid result fails the active job and is ignored when idle", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.semantic.emitRawResult({ garbage: true });
  await settleMicrotasks();
  assertEquals(test.settled.length, 0);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  test.semantic.emitRawResult({ garbage: true });
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
  assertEquals(test.scheduler.laneStats("semantic").active, false);
});

Deno.test("results for unknown jobs are discarded without settling", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  test.semantic.emitRawResult({
    protocol: 1,
    job: 4242,
    ok: true,
    kind: "service/request",
    value: "stray",
  });
  await settleMicrotasks();
  assertEquals(test.settled.length, 0);
  assert(test.traces.some((event) => event.kind === "lane/discard"));
  test.semantic.releaseNext("real");
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
});

Deno.test("a crash fails the active job, holds the queue, and resumes", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  test.semantic.crash(new Error("boom"));
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
  assertEquals(test.settled[0].id, 1);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
  assertEquals(test.semantic.startCount, 2);
  assertEquals(test.reconstructed, ["semantic"]);
  assertEquals(test.scheduler.laneStats("semantic").generation, 1);
  assertEquals(test.semantic.sentJobs.length, 2);
  test.semantic.releaseNext("second");
  await settleMicrotasks();
  assertEquals(test.settled.length, 2);
  assertEquals(test.settled[1].settlement, { kind: "result", value: "second" });
});

Deno.test("startup failure settles requests but parks internal work", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.semantic.failStartupWith(new Error("no thread for you"));
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
  const seen = { settled: 0, abandoned: 0 };
  test.scheduler.enqueue(internalTask("u", null, seen), "semantic");
  await settleMicrotasks();
  assertEquals(seen.abandoned, 0);
  assertEquals(test.scheduler.laneStats("semantic").queued, 1);
  test.semantic.clearStartupFailure();
  test.scheduler.pump();
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  test.semantic.releaseNext(null);
  await settleMicrotasks();
  assertEquals(seen.settled, 1);
});

Deno.test("an expired active job gets grace, then terminate plus reconstruct", async () => {
  const test = harness({ obsoleteGraceMs: 50 });
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/formatting", "u", entry),
    "syntax",
  );
  await settleMicrotasks();
  const jobId = test.syntax.sentJobs[0].job;
  await test.clock.advance(1000);
  assertEquals(test.settled.length, 1);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
  assertEquals(test.syntax.startCount, 1);
  await test.clock.advance(49);
  assertEquals(test.syntax.startCount, 1);
  await test.clock.advance(1);
  assertEquals(test.syntax.startCount, 2);
  assertEquals(test.scheduler.laneStats("syntax").generation, 1);
  assertEquals(test.reconstructed, ["syntax"]);
  test.syntax.emitRawResult({
    protocol: 1,
    job: jobId,
    ok: true,
    kind: "service/request",
    value: "late",
  });
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
});

Deno.test("work that finishes inside grace avoids reconstruction", async () => {
  const test = harness({ obsoleteGraceMs: 50 });
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/formatting", "u", entry),
    "syntax",
  );
  await settleMicrotasks();
  await test.clock.advance(1000);
  assertEquals(test.settled.length, 1);
  test.syntax.releaseNext("just in time");
  await settleMicrotasks();
  await test.clock.advance(1000);
  assertEquals(test.syntax.startCount, 1);
  assertEquals(test.reconstructed.length, 0);
  assertEquals(test.settled.length, 1);
});

Deno.test("expired pending tasks are dropped without dispatch", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/completion", "u", entry),
    "syntax",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/formatting", "u", entry),
    "syntax",
  );
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 1);
  await test.clock.advance(1000);
  assertEquals(test.settled.length, 1);
  assertEquals(test.settled[0].id, 2);
  assertEquals(test.scheduler.laneStats("syntax").queued, 0);
  test.syntax.releaseNext("first");
  await settleMicrotasks();
  assertEquals(test.syntax.sentJobs.length, 1);
  assertEquals(test.settled.length, 2);
});

Deno.test("drain completes pending work and terminates the hosts", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  const drained = test.scheduler.drain(1000);
  test.semantic.releaseNext("first");
  await settleMicrotasks();
  test.semantic.releaseNext("second");
  await drained;
  assertEquals(test.settled.length, 2);
  assertEquals(test.semantic.started, false);
  assertEquals(test.syntax.started, false);
});

Deno.test("drain abandons leftovers once the bound lapses", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  await settleMicrotasks();
  const drained = test.scheduler.drain(100);
  await test.clock.advance(101);
  await drained;
  assertEquals(test.settled.length, 2);
  assertEquals(settlementCode(test.settled[0].settlement), -32603);
  assertEquals(settlementCode(test.settled[1].settlement), -32603);
});

Deno.test("dropping a uri settles queued work but spares the active job", async () => {
  const test = harness();
  const entry = openEntry(test, "u", 1);
  const vEntry = openEntry(test, "v", 1);
  test.scheduler.enqueue(
    requestTask(test, 1, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 2, "textDocument/hover", "u", entry),
    "semantic",
  );
  test.scheduler.enqueue(
    requestTask(test, 3, "textDocument/hover", "v", vEntry),
    "semantic",
  );
  await settleMicrotasks();
  test.registry.invalidateUri("u");
  assertEquals(test.scheduler.dropUriTasks("u"), 1);
  await settleMicrotasks();
  assertEquals(test.settled.length, 1);
  assertEquals(test.settled[0].id, 2);
  assertEquals(settlementCode(test.settled[0].settlement), -32801);
  test.semantic.releaseNext("first");
  await settleMicrotasks();
  assertEquals(settlementCode(test.settled[1].settlement), -32801);
  test.semantic.releaseNext("third");
  await settleMicrotasks();
  assertEquals(test.settled[2].settlement, { kind: "result", value: "third" });
});

Deno.test("methods split across syntax and semantic lanes", () => {
  assertEquals(laneForMethod("textDocument/completion"), "syntax");
  assertEquals(laneForMethod("textDocument/formatting"), "syntax");
  assertEquals(laneForMethod("textDocument/codeAction"), "syntax");
  assertEquals(laneForMethod("workspace/symbol"), "syntax");
  assertEquals(laneForMethod("textDocument/hover"), "semantic");
  assertEquals(laneForMethod("textDocument/definition"), "semantic");
  assertEquals(laneForMethod("codeAction/resolve"), "semantic");
});
