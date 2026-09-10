import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { ChannelRuntime } from "../channel.ts";
import { Compiler } from "../compiler.ts";
import { EventRuntime, type EventSink } from "../events.ts";
import { instantiateArtifact } from "../host.ts";
import { type ClockService, IoRuntime } from "../io.ts";
import { HostScope } from "../resources.ts";
import { SelectRuntime } from "../select.ts";
import { SparkRuntime } from "../spark.ts";

const some = (payload: RuntimeValue): RuntimeValue => ({
  kind: "variant",
  name: "Some",
  payload,
});
const selected = (index: bigint, outcome: RuntimeValue): RuntimeValue => ({
  kind: "record",
  fields: new Map<string, RuntimeValue>([["index", index], [
    "outcome",
    outcome,
  ]]),
});
const message = (index: bigint, value: RuntimeValue): RuntimeValue =>
  selected(index, { kind: "variant", name: "Message", payload: value });

async function fixture(options: {
  readonly subscribe?: (sink: EventSink) => () => void;
  readonly clock?: ClockService;
} = {}) {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/select.blot");
    const sparks = new SparkRuntime(root);
    const channels = new ChannelRuntime(root, sparks);
    const events = new EventRuntime(root, sparks);
    const io = new IoRuntime(root);
    const select = new SelectRuntime(channels, events, io);
    let subscribe = options.subscribe;
    if (subscribe === undefined) subscribe = () => () => {};
    const changes = events.source(
      root,
      { kind: "signed-integer-64" },
      subscribe,
    );
    const clock = io.clock(root, options.clock);
    const hosted = await instantiateArtifact(
      artifact,
      new Map([
        ...sparks.capabilitiesFor(artifact),
        ...channels.capabilitiesFor(artifact),
        ...events.capabilitiesFor(artifact),
        ...io.capabilitiesFor(artifact),
        ...select.capabilitiesFor(artifact),
      ]),
      { scope: root },
    );
    return {
      hosted,
      executor: sparks.executor,
      changes,
      clock,
      services: {
        kind: "record" as const,
        fields: new Map([["executor", sparks.executor], ["changes", changes], [
          "clock",
          clock,
        ]]),
      },
      async close() {
        try {
          await hosted.close();
        } finally {
          await root.close();
          compiler.destroy();
        }
      },
    };
  } catch (cause) {
    await root.close();
    compiler.destroy();
    throw cause;
  }
}

test("source select retains losing buffered and rendezvous messages and accepts closed channels", async () => {
  const runtime = await fixture();
  try {
    assert.deepEqual(
      await runtime.hosted.callAsync("buffered", [runtime.executor]),
      {
        kind: "record",
        fields: new Map([
          ["selected", message(0n, some(11n))],
          ["remaining", some(22n)],
          ["duplicate", some(12n)],
        ]),
      },
    );
    assert.deepEqual(
      await runtime.hosted.callAsync("rendezvous", [runtime.executor]),
      {
        kind: "record",
        fields: new Map<string, RuntimeValue>([
          ["selected", message(0n, some(11n))],
          ["remaining", some(22n)],
          ["accepted", {
            kind: "record",
            fields: new Map([["0", true], ["1", true]]),
          }],
        ]),
      },
    );
    assert.deepEqual(
      await runtime.hosted.callAsync("closed", [runtime.executor]),
      message(0n, { kind: "variant", name: "None" }),
    );
    await assert.rejects(
      runtime.hosted.callAsync("empty", [null]),
      /at least one arm/,
    );
  } finally {
    await runtime.close();
  }
});

test("a losing event selection retains its queued message", async () => {
  const runtime = await fixture({
    subscribe(sink) {
      sink.emit(31n);
      return () => {};
    },
  });
  try {
    assert.deepEqual(
      await runtime.hosted.callAsync("events", [{
        kind: "record",
        fields: new Map([["executor", runtime.executor], [
          "changes",
          runtime.changes,
        ]]),
      }]),
      {
        kind: "record",
        fields: new Map([["selected", message(0n, some(9n))], [
          "remaining",
          some(31n),
        ]]),
      },
    );
  } finally {
    await runtime.close();
  }
});

test("event readiness, closure and failure each settle selection once and cancel its clock", async () => {
  for (const outcome of ["message", "closed", "failed"]) {
    const attached = Promise.withResolvers<EventSink>();
    const sleeping = Promise.withResolvers<void>();
    let cancelled = 0;
    let detached = 0;
    const runtime = await fixture({
      subscribe(sink) {
        attached.resolve(sink);
        return () => {
          detached += 1;
        };
      },
      clock: {
        now: () => 0n,
        sleep: (_duration, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              cancelled += 1;
              reject(signal.reason);
            }, { once: true });
            sleeping.resolve();
          }),
      },
    });
    try {
      const pending = runtime.hosted.callAsync("wait", [runtime.services]);
      const sink = await attached.promise;
      await sleeping.promise;
      if (outcome === "message") {
        sink.emit(77n);
        assert.deepEqual(await pending, message(1n, some(77n)));
      } else if (outcome === "closed") {
        sink.close();
        assert.deepEqual(
          await pending,
          message(1n, { kind: "variant", name: "None" }),
        );
      } else {
        const failure = new Error("event source lost");
        const rejected = assert.rejects(pending, (cause) => cause === failure);
        sink.fail(failure);
        await rejected;
      }
      assert.equal(cancelled, 1);
      assert.equal(detached, 1);
    } finally {
      await runtime.close();
    }
  }
});

test("source timer selection and cancellation wait for every admitted timer to drain", async () => {
  for (const cancellation of [false, true]) {
    const admitted = Promise.withResolvers<void>();
    const timers: {
      duration: number;
      signal: AbortSignal;
      done: PromiseWithResolvers<void>;
    }[] = [];
    const runtime = await fixture({
      clock: {
        now: () => 0n,
        sleep(duration, signal) {
          const done = Promise.withResolvers<void>();
          timers.push({ duration, signal, done });
          if (timers.length === 2) admitted.resolve();
          return done.promise;
        },
      },
    });
    const controller = new AbortController();
    const reason = new Error("cancel source select");
    let settled = false;
    const pending = runtime.hosted.callAsync("timers", [runtime.clock], {
      signal: controller.signal,
    });
    const observed = pending.then((value) => {
      settled = true;
      return { value };
    }, (cause: unknown) => {
      settled = true;
      return { cause };
    });
    try {
      await admitted.promise;
      assert.deepEqual(timers.map((timer) => timer.duration), [10, 20]);
      if (cancellation) controller.abort(reason);
      else timers[1].done.resolve();
      await Promise.resolve();
      assert.equal(timers[0].signal.aborted, true);
      assert.equal(settled, false);
      for (const timer of timers) timer.done.resolve();
      const result = await observed;
      if (cancellation) assert.deepEqual(result, { cause: reason });
      else {assert.deepEqual(result, {
          value: selected(1n, { kind: "variant", name: "Timeout" }),
        });}
    } finally {
      for (const timer of timers) timer.done.resolve();
      await observed;
      await runtime.close();
    }
  }
});
