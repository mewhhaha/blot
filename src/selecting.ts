import type { RuntimeValue } from "./abi_values.ts";
import type { ClockService } from "./io.ts";
import type { ReceiveSource } from "./receiving.ts";

export type SelectArm = {
  readonly kind: "receive";
  readonly source: ReceiveSource;
} | {
  readonly kind: "timer";
  readonly clock: ClockService;
  readonly milliseconds: number;
};

export async function selectFrom(
  arms: readonly SelectArm[],
  signal: AbortSignal,
): Promise<RuntimeValue> {
  signal.throwIfAborted();
  const completion = Promise.withResolvers<RuntimeValue>();
  const unregister: (() => void)[] = [];
  const timers: {
    index: number;
    controller: AbortController;
    drained: Promise<void>;
  }[] = [];
  const drainFailures: unknown[] = [];
  const cancelled = new DOMException("selection completed", "AbortError");
  let pending = true;
  const detach = (winner?: number) => {
    signal.removeEventListener("abort", abort);
    for (const remove of unregister) remove();
    unregister.length = 0;
    for (const timer of timers) {
      if (timer.index !== winner) timer.controller.abort(cancelled);
    }
  };
  const reject = (cause: unknown) => {
    if (!pending) return;
    pending = false;
    detach();
    completion.reject(cause);
  };
  const accept = (index: number, take: () => RuntimeValue) => {
    if (!pending) return false;
    pending = false;
    try {
      // Taking the winner precedes abort listeners, which may reenter a source.
      const outcome = take();
      detach(index);
      completion.resolve({
        kind: "record",
        fields: new Map<string, RuntimeValue>([
          ["index", BigInt(index)],
          ["outcome", outcome],
        ]),
      });
    } catch (cause) {
      detach();
      completion.reject(cause);
    }
    return true;
  };
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  for (let index = 0; index < arms.length && pending; index += 1) {
    const arm = arms[index];
    try {
      if (arm.kind === "receive") {
        const remove = arm.source.register({
          accept: (take) =>
            accept(
              index,
              () => ({ kind: "variant", name: "Message", payload: take() }),
            ),
          reject,
        });
        if (pending) unregister.push(remove);
        else remove();
      } else {
        const controller = new AbortController();
        const drained = arm.clock.sleep(arm.milliseconds, controller.signal)
          .then(
            () => {
              accept(index, () => ({ kind: "variant", name: "Timeout" }));
            },
            (cause: unknown) => {
              if (pending) reject(cause);
              else if (
                !controller.signal.aborted || cause !== controller.signal.reason
              ) {
                drainFailures.push(cause);
              }
            },
          );
        timers.push({ index, controller, drained });
        if (!pending) controller.abort(cancelled);
      }
    } catch (cause) {
      reject(cause);
    }
  }
  const outcome = await completion.promise.then(
    (value) => ({ value }),
    (cause: unknown) => ({ cause }),
  );
  await Promise.all(timers.map((timer) => timer.drained));
  if (drainFailures.length > 0) {
    if ("cause" in outcome) drainFailures.unshift(outcome.cause);
    throw new AggregateError(drainFailures, "selection timer cleanup failed");
  }
  if ("cause" in outcome) throw outcome.cause;
  return outcome.value;
}
