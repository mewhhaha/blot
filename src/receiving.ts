import type { RuntimeValue } from "./abi_values.ts";

export interface ReceiveWaiter {
  accept(take: () => RuntimeValue): boolean;
  reject(cause: unknown): void;
}

export interface ReceiveSource {
  register(waiter: ReceiveWaiter): () => void;
}

export function receiveFrom(
  source: ReceiveSource,
  signal: AbortSignal,
): Promise<RuntimeValue> {
  signal.throwIfAborted();
  const completion = Promise.withResolvers<RuntimeValue>();
  let settled = false;
  let unregister: (() => void) | undefined;
  const detach = () => {
    unregister?.();
    signal.removeEventListener("abort", abort);
  };
  const reject = (cause: unknown) => {
    if (settled) return;
    settled = true;
    detach();
    completion.reject(cause);
  };
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    unregister = source.register({
      accept(take) {
        if (settled) return false;
        settled = true;
        detach();
        try {
          completion.resolve(take());
        } catch (cause) {
          completion.reject(cause);
        }
        return true;
      },
      reject,
    });
    if (settled) unregister();
  } catch (cause) {
    reject(cause);
  }
  return completion.promise;
}
