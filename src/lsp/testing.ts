// Deterministic test support for the LSP coordinator slice.
//
// FakeClock implements the scheduler Clock with manual time. Barrier gates
// async work so tests order events without sleeping. The memory transport
// helpers feed and capture framed bytes. Nothing here is used by production
// code; it lives next to the coordinator because every coordinator test
// needs it.

import type { Clock } from "./requests.ts";
import { decodeMessage, encodeFrame, FrameReader } from "./transport.ts";

/** A clock with manual time. Timers fire in deadline order under advance. */
export class FakeClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { at: number; fire: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, { at: this.#now + ms, fire: callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  pendingCount(): number {
    return this.#timers.size;
  }

  /**
   * Moves time forward, firing every due timer in deadline order and flushing
   * microtasks between firings so promise chains settle deterministically.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    while (true) {
      let earliest: number | undefined = undefined;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const [handle, timer] of this.#timers) {
        if (timer.at <= target && timer.at < earliestAt) {
          earliest = handle;
          earliestAt = timer.at;
        }
      }
      if (earliest === undefined) break;
      const timer = this.#timers.get(earliest);
      this.#timers.delete(earliest);
      this.#now = earliestAt;
      if (timer !== undefined) timer.fire();
      await settleMicrotasks();
    }
    this.#now = target;
    await settleMicrotasks();
  }
}

/** Flushes a generous run of microtasks without touching any clock. */
export async function settleMicrotasks(rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

/** A gate that holds async work until a test releases it, one pass at a time. */
export class Barrier {
  readonly #waiters: (() => void)[] = [];
  #passes = 0;

  /** Waits for a pass. Passes granted early are consumed here. */
  wait(): Promise<void> {
    if (this.#passes > 0) {
      this.#passes -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** Grants one pass to the oldest waiter, or banks it for the next waiter. */
  release(): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter();
      return;
    }
    this.#passes += 1;
  }

  /** Grants a pass to every current waiter and banks nothing. */
  releaseAll(): void {
    let waiter = this.#waiters.shift();
    while (waiter !== undefined) {
      waiter();
      waiter = this.#waiters.shift();
    }
  }

  waitingCount(): number {
    return this.#waiters.length;
  }
}

/** A promise with its resolvers exposed for tests. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void = () => undefined;
  reject: (error: unknown) => void = () => undefined;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Feeds the server controllable input and captures its output frames. */
export interface MemoryTransport {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  send(message: unknown): void;
  sendBytes(bytes: Uint8Array): void;
  closeInput(): void;
  chunks(): readonly Uint8Array[];
}

/** Builds a memory transport around one controller pair. */
export function memoryTransport(): MemoryTransport {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined =
    undefined;
  const input = new ReadableStream<Uint8Array>({
    start(underlying) {
      controller = underlying;
    },
  });
  const captured: Uint8Array[] = [];
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      captured.push(chunk);
    },
  });
  return {
    input,
    output,
    send(message: unknown): void {
      if (controller === undefined) throw new Error("input is not readable");
      controller.enqueue(encodeFrame(message));
    },
    sendBytes(bytes: Uint8Array): void {
      if (controller === undefined) throw new Error("input is not readable");
      controller.enqueue(bytes);
    },
    closeInput(): void {
      if (controller === undefined) throw new Error("input is not readable");
      controller.close();
    },
    chunks(): readonly Uint8Array[] {
      return captured;
    },
  };
}

/** Decodes every captured output chunk back into messages, in order. */
export async function decodeCaptured(
  chunks: readonly Uint8Array[],
): Promise<unknown[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const reader = new FrameReader(stream.getReader());
  const messages: unknown[] = [];
  while (true) {
    const message = await reader.read();
    if (message === null) break;
    messages.push(message);
  }
  reader.releaseLock();
  return messages;
}

/** Encodes one message body without framing, for split-chunk tests. */
export function encodeBody(message: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

/** Re-decodes a single captured chunk, for tests that assert per frame. */
export function decodeChunk(chunk: Uint8Array): unknown {
  const text = new TextDecoder().decode(chunk);
  const boundary = text.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("captured chunk has no header body");
  return decodeMessage(text.slice(boundary + 4));
}
