import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Queue } from "../queue.ts";
import {
  receiveFrom,
  type ReceiveSource,
  type ReceiveWaiter,
} from "../receiving.ts";
import { selectFrom } from "../selecting.ts";

class Mailbox implements ReceiveSource {
  readonly messages = new Queue<RuntimeValue>();
  readonly waiting = new Queue<ReceiveWaiter>();
  register(waiter: ReceiveWaiter): () => void {
    if (this.messages.size === 0) return this.waiting.push(waiter);
    waiter.accept(() => {
      const value = this.messages.shift();
      assert(value !== undefined);
      return value;
    });
    return () => {};
  }
  send(value: RuntimeValue): void {
    for (
      let waiter = this.waiting.shift();
      waiter !== undefined;
      waiter = this.waiting.shift()
    ) {
      if (waiter.accept(() => value)) return;
    }
    this.messages.push(value);
  }
}

const signal = new AbortController().signal;
const record = (index: bigint, outcome: RuntimeValue): RuntimeValue => ({
  kind: "record",
  fields: new Map([["index", index], ["outcome", outcome]]),
});
const message = (value: RuntimeValue): RuntimeValue => ({
  kind: "variant",
  name: "Message",
  payload: value,
});

test("selection commits the lowest ready arm and retains every losing message", async () => {
  const first = new Mailbox();
  const second = new Mailbox();
  first.send(11n);
  second.send(22n);
  assert.deepEqual(
    await selectFrom([
      { kind: "receive", source: first },
      { kind: "receive", source: second },
    ], signal),
    record(0n, message(11n)),
  );
  assert.equal(await receiveFrom(second, signal), 22n);
  assert.equal(first.waiting.size, 0);
  assert.equal(second.waiting.size, 0);
});

test("first readiness after admission wins and duplicate registrations are removed", async () => {
  const first = new Mailbox();
  const second = new Mailbox();
  const pending = selectFrom([
    { kind: "receive", source: first },
    { kind: "receive", source: second },
    { kind: "receive", source: second },
  ], signal);
  second.send(22n);
  first.send(11n);
  second.send(23n);
  assert.deepEqual(await pending, record(1n, message(22n)));
  assert.equal(first.waiting.size, 0);
  assert.equal(second.waiting.size, 0);
  assert.equal(await receiveFrom(first, signal), 11n);
  assert.equal(await receiveFrom(second, signal), 23n);
});

test("cancelling selection removes all receivers and drains admitted clock work", async () => {
  const source = new Mailbox();
  const controller = new AbortController();
  const drain = Promise.withResolvers<void>();
  let clockSignal: AbortSignal | undefined;
  const pending = selectFrom([
    { kind: "receive", source },
    {
      kind: "timer",
      milliseconds: 100,
      clock: {
        now: () => 0n,
        sleep: (_duration, signal) => {
          clockSignal = signal;
          return drain.promise;
        },
      },
    },
  ], controller.signal);
  let settled = false;
  const reason = new Error("cancel selection");
  const observed = assert.rejects(pending, (cause) => {
    settled = true;
    return cause === reason;
  });
  controller.abort(reason);
  assert.equal(clockSignal?.aborted, true);
  assert.equal(source.waiting.size, 0);
  source.send(42n);
  assert.equal(await receiveFrom(source, signal), 42n);
  await Promise.resolve();
  assert.equal(settled, false);
  drain.resolve();
  await observed;
});

test("timer selection aborts and drains the losing timer before returning", async () => {
  const timers: { signal: AbortSignal; done: PromiseWithResolvers<void> }[] =
    [];
  const clock = {
    now: () => 0n,
    sleep: (_duration: number, signal: AbortSignal) => {
      const done = Promise.withResolvers<void>();
      timers.push({ signal, done });
      return done.promise;
    },
  };
  let settled = false;
  const pending = selectFrom([
    { kind: "timer", clock, milliseconds: 1 },
    { kind: "timer", clock, milliseconds: 2 },
  ], signal).then((value) => {
    settled = true;
    return value;
  });
  timers[1].done.resolve();
  await Promise.resolve();
  assert.equal(timers[0].signal.aborted, true);
  assert.equal(settled, false);
  timers[0].done.reject(timers[0].signal.reason);
  assert.deepEqual(
    await pending,
    record(1n, { kind: "variant", name: "Timeout" }),
  );
});

test("a failed receive source rejects selection and detaches every earlier arm", async () => {
  const first = new Mailbox();
  const failure = new Error("event source lost");
  await assert.rejects(
    selectFrom([
      { kind: "receive", source: first },
      {
        kind: "receive",
        source: {
          register(waiter) {
            waiter.reject(failure);
            return () => {};
          },
        },
      },
    ], signal),
    (cause) => cause === failure,
  );
  assert.equal(first.waiting.size, 0);
});

test("winner takes its message before timer abort listeners can reenter the source", async () => {
  const source = new Mailbox();
  source.send(11n);
  let reentered: Promise<RuntimeValue> | undefined;
  const pending = selectFrom([
    {
      kind: "timer",
      milliseconds: 1,
      clock: {
        now: () => 0n,
        sleep: (_duration, clockSignal) =>
          new Promise<void>((_resolve, reject) => {
            clockSignal.addEventListener("abort", () => {
              reentered = receiveFrom(source, signal);
              reject(clockSignal.reason);
            }, { once: true });
          }),
      },
    },
    { kind: "receive", source },
  ], signal);
  assert.deepEqual(await pending, record(1n, message(11n)));
  source.send(22n);
  assert.equal(await reentered, 22n);
});

test("unexpected losing timer failure is retained as cleanup evidence", async () => {
  const source = new Mailbox();
  const timer = Promise.withResolvers<void>();
  const pending = selectFrom([
    {
      kind: "timer",
      milliseconds: 1,
      clock: { now: () => 0n, sleep: () => timer.promise },
    },
    { kind: "receive", source },
  ], signal);
  source.send(11n);
  const failure = new Error("timer drain failed");
  timer.reject(failure);
  await assert.rejects(
    pending,
    (cause) => cause instanceof AggregateError && cause.errors[0] === failure,
  );
});
