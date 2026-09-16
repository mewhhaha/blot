import { assert, assertEquals } from "@std/assert";
import { JsonRpcError } from "./errors.ts";
import type { RequestId } from "./errors.ts";
import { FORMAT_DEADLINE_MS, RequestRegistry } from "./requests.ts";
import type { RequestRecord, Settlement } from "./requests.ts";
import { FakeClock } from "./testing.ts";

interface Harness {
  clock: FakeClock;
  registry: RequestRegistry;
  settled: { id: RequestId; settlement: Settlement }[];
  deadlines: RequestRecord[];
}

function harness(): Harness {
  const clock = new FakeClock();
  const settled: Harness["settled"] = [];
  const deadlines: RequestRecord[] = [];
  const registry = new RequestRegistry(clock, {
    onSettle: (id, settlement) => {
      settled.push({ id, settlement });
    },
    onDeadline: (record) => {
      deadlines.push(record);
    },
  });
  return { clock, registry, settled, deadlines };
}

Deno.test("requests move pending to running to settled exactly once", () => {
  const test = harness();
  const record = test.registry.accept(1, "textDocument/hover", "u");
  assertEquals(record.state, "pending");
  assertEquals(record.ingressTime, 0);
  assertEquals(test.registry.markRunning(1), true);
  assertEquals(test.registry.get(1)?.state, "running");
  assertEquals(test.registry.markRunning(1), false);
  assertEquals(
    test.registry.settle(1, { kind: "result", value: 42 }),
    true,
  );
  assertEquals(test.registry.get(1)?.state, "settled");
  assertEquals(
    test.registry.settle(1, { kind: "result", value: 43 }),
    false,
  );
  assertEquals(test.registry.settle(999, { kind: "result", value: 1 }), false);
  assertEquals(test.settled.length, 1);
  assertEquals(test.settled[0].settlement, { kind: "result", value: 42 });
});

Deno.test("a client cancel converts the result to RequestCancelled", () => {
  const test = harness();
  test.registry.accept(1, "textDocument/hover", "u");
  assertEquals(test.registry.clientCancel(1), true);
  assertEquals(test.registry.clientCancel(999), false);
  test.registry.settle(1, { kind: "result", value: 1 });
  assertEquals(test.settled.length, 1);
  const settlement = test.settled[0].settlement;
  assert(settlement.kind === "error");
  assertEquals(settlement.error.code, -32800);
  assertEquals(test.registry.clientCancel(1), false);
});

Deno.test("invalidation converts the result to ContentModified", () => {
  const test = harness();
  test.registry.accept(1, "textDocument/hover", "u:a");
  test.registry.accept(2, "workspace/symbol", null);
  assertEquals(test.registry.invalidateUri("u:a"), [1]);
  assertEquals(test.registry.invalidateUri("u:missing"), []);
  test.registry.settle(1, { kind: "result", value: 1 });
  test.registry.settle(2, { kind: "result", value: 2 });
  const first = test.settled[0].settlement;
  assert(first.kind === "error");
  assertEquals(first.error.code, -32801);
  assertEquals(first.error.data, { uri: "u:a" });
  assertEquals(test.settled[1].settlement, { kind: "result", value: 2 });
});

Deno.test("cancel wins over invalidation but never masks an error", () => {
  const test = harness();
  test.registry.accept(1, "textDocument/hover", "u");
  test.registry.accept(2, "textDocument/hover", "u");
  test.registry.clientCancel(1);
  test.registry.invalidateUri("u");
  test.registry.clientCancel(2);
  test.registry.invalidateUri("u");
  test.registry.settle(1, { kind: "result", value: 1 });
  const explicit = new JsonRpcError(-32602, "bad params");
  test.registry.settle(2, { kind: "error", error: explicit });
  const first = test.settled[0].settlement;
  assert(first.kind === "error");
  assertEquals(first.error.code, -32800);
  assertEquals(test.settled[1].settlement, { kind: "error", error: explicit });
});

Deno.test("a duplicate live id fails fast while reuse after settle works", () => {
  const test = harness();
  test.registry.accept(1, "textDocument/hover", "u");
  const duplicate = test.registry.accept(1, "textDocument/hover", "u");
  assertEquals(duplicate.state, "settled");
  assertEquals(test.settled.length, 1);
  const rejection = test.settled[0].settlement;
  assert(rejection.kind === "error");
  assertEquals(rejection.error.code, -32600);
  assertEquals(test.registry.get(1)?.state, "pending");
  test.registry.settle(1, { kind: "result", value: "original" });
  const reused = test.registry.accept(1, "workspace/symbol", null);
  assertEquals(reused.state, "pending");
  assertEquals(reused.method, "workspace/symbol");
});

Deno.test("deadlines fire from ingress and clear on early settlement", async () => {
  const test = harness();
  assertEquals(FORMAT_DEADLINE_MS, 10_000);
  test.registry.accept(1, "textDocument/formatting", "u", 100);
  test.registry.accept(2, "textDocument/hover", "u");
  await test.clock.advance(99);
  assertEquals(test.settled.length, 0);
  test.registry.settle(2, { kind: "result", value: 2 });
  await test.clock.advance(1);
  assertEquals(test.settled.length, 2);
  const expired = test.settled[1].settlement;
  assert(expired.kind === "error");
  assertEquals(expired.error.code, -32603);
  assertEquals(expired.error.data, {
    kind: "deadline",
    method: "textDocument/formatting",
    deadlineMs: 100,
  });
  assertEquals(test.deadlines.length, 1);
  assertEquals(test.deadlines[0].id, 1);
  test.registry.accept(3, "textDocument/formatting", "u", 50);
  test.registry.settle(3, { kind: "result", value: 3 });
  await test.clock.advance(1000);
  assertEquals(test.deadlines.length, 1);
});

Deno.test("shutdown settles every live request once", () => {
  const test = harness();
  test.registry.accept(1, "a", "u");
  test.registry.accept(2, "b", "u");
  test.registry.accept(3, "c", null);
  test.registry.settle(3, { kind: "result", value: 3 });
  assertEquals(test.registry.liveCount(), 2);
  const shutdown = new JsonRpcError(-32603, "shutting down");
  assertEquals(
    test.registry.settleAllLive({ kind: "error", error: shutdown }),
    2,
  );
  assertEquals(test.registry.liveCount(), 0);
  assertEquals(
    test.registry.settleAllLive({ kind: "error", error: shutdown }),
    0,
  );
});

Deno.test("dispose clears deadline timers while records stay readable", async () => {
  const test = harness();
  test.registry.accept(1, "textDocument/formatting", "u", 10);
  test.registry.dispose();
  await test.clock.advance(100);
  assertEquals(test.settled.length, 0);
  assertEquals(test.registry.get(1)?.state, "pending");
});

Deno.test("single invalidation flags one request without touching others", () => {
  const test = harness();
  test.registry.accept(1, "textDocument/hover", "u");
  test.registry.accept(2, "textDocument/hover", "u");
  assertEquals(test.registry.markInvalidated(1), true);
  assertEquals(test.registry.markInvalidated(999), false);
  test.registry.settle(1, { kind: "result", value: 1 });
  test.registry.settle(2, { kind: "result", value: 2 });
  const first = test.settled[0].settlement;
  assert(first.kind === "error");
  assertEquals(first.error.code, -32801);
  assertEquals(test.settled[1].settlement, { kind: "result", value: 2 });
  assertEquals(test.registry.markInvalidated(1), false);
});
