import { assert, assertEquals } from "@std/assert";
import { DiagnosticsOrchestrator } from "./diagnostics.ts";
import { CoordinatorDocuments } from "./documents.ts";
import { FakeLspWorkerHost } from "./fake_host.ts";
import { RequestRegistry } from "./requests.ts";
import { Scheduler } from "./scheduler.ts";
import { FakeClock, settleMicrotasks } from "./testing.ts";

interface Harness {
  clock: FakeClock;
  documents: CoordinatorDocuments;
  scheduler: Scheduler;
  semantic: FakeLspWorkerHost;
  orchestrator: DiagnosticsOrchestrator;
  published: { uri: string; version: number; diagnostics: unknown }[];
}

function harness(): Harness {
  const clock = new FakeClock();
  const documents = new CoordinatorDocuments();
  const syntax = new FakeLspWorkerHost("syntax");
  const semantic = new FakeLspWorkerHost("semantic");
  const registry = new RequestRegistry(clock, {
    onSettle: () => undefined,
    onDeadline: (record) => scheduler.noteExpired(record.id),
  });
  const scheduler = new Scheduler({
    clock,
    documents,
    registry,
    syntaxHost: syntax,
    semanticHost: semantic,
  });
  const published: Harness["published"] = [];
  const orchestrator = new DiagnosticsOrchestrator({
    clock,
    documents,
    scheduler,
    publish: (uri, version, diagnostics) => {
      published.push({ uri, version, diagnostics });
    },
  });
  return { clock, documents, scheduler, semantic, orchestrator, published };
}

Deno.test("opening publishes promptly without waiting out typing", async () => {
  const test = harness();
  const entry = test.documents.open("u", "return 1\n", 1);
  test.orchestrator.noteOpened("u", entry);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  test.semantic.releaseNext([{ range: 0 }]);
  await settleMicrotasks();
  assertEquals(test.published.length, 1);
  assertEquals(test.published[0].uri, "u");
  assertEquals(test.published[0].version, 1);
});

Deno.test("a typing burst yields one latest pending diagnostic", async () => {
  const test = harness();
  test.orchestrator.noteOpened("u", test.documents.open("u", "return 1\n", 1));
  await settleMicrotasks();
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 1);
  for (let version = 2; version <= 6; version += 1) {
    const entry = test.documents.change("u", [{ text: "return 2\n" }], version);
    test.orchestrator.noteChanged("u", entry);
  }
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  await test.clock.advance(150);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 2);
  test.semantic.releaseNext([{ latest: true }]);
  await settleMicrotasks();
  assertEquals(test.published.length, 2);
  assertEquals(test.published[1].version, 6);
  assertEquals(test.semantic.sentJobs.length, 2);
});

Deno.test("saving promotes the current diagnostics without delay", async () => {
  const test = harness();
  test.orchestrator.noteOpened("u", test.documents.open("u", "return 1\n", 1));
  await settleMicrotasks();
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  const entry = test.documents.change("u", [{ text: "return 2\n" }], 2);
  test.orchestrator.noteChanged("u", entry);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  const current = test.documents.current("u");
  assert(current !== null);
  test.orchestrator.noteSaved("u", current);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 2);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 2);
  assertEquals(test.published[1].version, 2);
  await test.clock.advance(1000);
  assertEquals(test.semantic.sentJobs.length, 2);
});

Deno.test("closing cancels timers, slots, and queued jobs", async () => {
  const test = harness();
  test.orchestrator.noteOpened("u", test.documents.open("u", "return 1\n", 1));
  await settleMicrotasks();
  const entry = test.documents.change("u", [{ text: "return 2\n" }], 2);
  test.orchestrator.noteChanged("u", entry);
  test.documents.close("u");
  test.orchestrator.noteClosed("u");
  await test.clock.advance(1000);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 0);
  assertEquals(test.orchestrator.debugState(), { ready: [], tasked: [] });
});

Deno.test("a stale result is dropped while the newer job follows", async () => {
  const test = harness();
  test.orchestrator.noteOpened("u", test.documents.open("u", "return 1\n", 1));
  await settleMicrotasks();
  const entry = test.documents.change("u", [{ text: "return 2\n" }], 2);
  test.orchestrator.noteChanged("u", entry);
  await test.clock.advance(150);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  test.semantic.releaseNext([{ old: true }]);
  await settleMicrotasks();
  assertEquals(test.published.length, 0);
  assertEquals(test.semantic.sentJobs.length, 2);
  test.semantic.releaseNext([{ fresh: true }]);
  await settleMicrotasks();
  assertEquals(test.published.length, 1);
  assertEquals(test.published[0].version, 2);
});

Deno.test("a failed diagnostic job publishes nothing", async () => {
  const test = harness();
  test.orchestrator.noteOpened("u", test.documents.open("u", "return 1\n", 1));
  await settleMicrotasks();
  test.semantic.releaseNextThrow(new Error("backend blew up"));
  await settleMicrotasks();
  assertEquals(test.published.length, 0);
  const entry = test.documents.change("u", [{ text: "return 2\n" }], 2);
  test.orchestrator.noteChanged("u", entry);
  await test.clock.advance(150);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 2);
});

Deno.test("a newer change replaces the queued job instead of piling up", async () => {
  const test = harness();
  test.orchestrator.noteOpened("a", test.documents.open("a", "return 1\n", 1));
  test.orchestrator.noteOpened("b", test.documents.open("b", "return 1\n", 1));
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  assertEquals(test.scheduler.laneStats("semantic").queued, 1);
  const entry = test.documents.change("b", [{ text: "return 2\n" }], 2);
  test.orchestrator.noteChanged("b", entry);
  await test.clock.advance(150);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 1);
  assertEquals(test.scheduler.laneStats("semantic").queued, 1);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 1);
  assertEquals(test.published[0].uri, "a");
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 2);
  assertEquals(test.published[1].uri, "b");
  assertEquals(test.published[1].version, 2);
});

Deno.test("interleaved documents each converge on one latest publication", async () => {
  const test = harness();
  test.orchestrator.noteOpened("a", test.documents.open("a", "return 1\n", 1));
  test.orchestrator.noteOpened("b", test.documents.open("b", "return 1\n", 1));
  await settleMicrotasks();
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 2);
  for (let round = 0; round < 3; round += 1) {
    const aEntry = test.documents.change(
      "a",
      [{ text: "return 2\n" }],
      2 + round,
    );
    const bEntry = test.documents.change(
      "b",
      [{ text: "return 2\n" }],
      2 + round,
    );
    test.orchestrator.noteChanged("a", aEntry);
    test.orchestrator.noteChanged("b", bEntry);
  }
  await test.clock.advance(150);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 3);
  assertEquals(test.scheduler.laneStats("semantic").queued, 1);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.semantic.sentJobs.length, 4);
  test.semantic.releaseNext([]);
  await settleMicrotasks();
  assertEquals(test.published.length, 4);
  const versions = new Map(test.published.map((one) => [one.uri, one.version]));
  assertEquals(versions.get("a"), 4);
  assertEquals(versions.get("b"), 4);
});
