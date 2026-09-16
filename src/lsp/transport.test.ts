import { assert, assertEquals, assertRejects } from "@std/assert";
import { settleMicrotasks } from "./testing.ts";
import {
  decodeMessage,
  encodeFrame,
  FrameReader,
  FrameWriter,
  framingLimits,
  InvalidFrameError,
  MissingContentLengthError,
  OversizedBodyError,
  OversizedHeaderError,
  ParseFrameError,
  TruncatedInputError,
} from "./transport.ts";
import type { InboundMessage } from "./transport.ts";

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(reader: FrameReader): Promise<InboundMessage[]> {
  const messages: InboundMessage[] = [];
  while (true) {
    const message = await reader.read();
    if (message === null) break;
    messages.push(message);
  }
  return messages;
}

function frameOf(message: unknown): Uint8Array {
  return encodeFrame(message);
}

Deno.test("framing reassembles one-byte chunks without losing bytes", async () => {
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const frame = frameOf(body);
  const bytes: Uint8Array[] = [];
  for (let index = 0; index < frame.byteLength; index += 1) {
    bytes.push(frame.slice(index, index + 1));
  }
  const reader = new FrameReader(streamOf(bytes).getReader());
  assertEquals(await readAll(reader), [body]);
  reader.releaseLock();
});

Deno.test("framing reads several frames packed into one chunk", async () => {
  const first = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const second = { jsonrpc: "2.0", method: "initialized", params: {} };
  const third = { jsonrpc: "2.0", id: 2, method: "shutdown", params: null };
  const packed = new Uint8Array(
    frameOf(first).byteLength + frameOf(second).byteLength +
      frameOf(third).byteLength,
  );
  packed.set(frameOf(first), 0);
  packed.set(frameOf(second), frameOf(first).byteLength);
  packed.set(
    frameOf(third),
    frameOf(first).byteLength + frameOf(second).byteLength,
  );
  const reader = new FrameReader(streamOf([packed]).getReader());
  assertEquals(await readAll(reader), [first, second, third]);
  reader.releaseLock();
});

Deno.test("framing keeps response payloads through the round trip", async () => {
  const result = { jsonrpc: "2.0", id: 4, result: { edits: [] } };
  const failure = {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32800, message: "request cancelled" },
  };
  const reader = new FrameReader(
    streamOf([frameOf(result), frameOf(failure)]).getReader(),
  );
  assertEquals(await readAll(reader), [result, failure]);
  reader.releaseLock();
});

Deno.test("framing reports invalid JSON as a parse error with null id", async () => {
  const encoder = new TextEncoder();
  const bad = encoder.encode("Content-Length: 5\r\n\r\n{oops");
  const good = { jsonrpc: "2.0", id: 9, method: "exit", params: null };
  const reader = new FrameReader(
    streamOf([bad, frameOf(good)]).getReader(),
  );
  let failure: unknown = null;
  try {
    await reader.read();
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof ParseFrameError);
  assertEquals(failure.code, -32700);
  assertEquals(failure.responseId, null);
  assertEquals(await readAll(reader), [good]);
  reader.releaseLock();
});

Deno.test("framing reports misshapen JSON as invalid requests", () => {
  const cases: { body: string; id: unknown }[] = [
    { body: "[1,2]", id: null },
    { body: "42", id: null },
    { body: '{"jsonrpc":"2.0"}', id: null },
    { body: '{"jsonrpc":"2.0","id":true,"method":"x"}', id: null },
    { body: '{"jsonrpc":"2.0","id":7,"method":5}', id: 7 },
  ];
  for (const one of cases) {
    let failure: unknown = null;
    try {
      decodeMessage(one.body);
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof InvalidFrameError, one.body);
    assertEquals(failure.code, -32600);
    assertEquals(failure.responseId, one.id);
  }
});

Deno.test("framing ends truncated input distinctly from clean EOF", async () => {
  const encoder = new TextEncoder();
  const empty = new FrameReader(streamOf([]).getReader());
  assertEquals(await empty.read(), null);
  empty.releaseLock();
  const midHeader = new FrameReader(
    streamOf([encoder.encode("Content-Length: 1")]).getReader(),
  );
  await assertRejects(() => midHeader.read(), TruncatedInputError);
  const midBody = new FrameReader(
    streamOf([encoder.encode('Content-Length: 10\r\n\r\n{"a"')]).getReader(),
  );
  await assertRejects(() => midBody.read(), TruncatedInputError);
});

Deno.test("framing skips oversized headers and bodies within bounds", async () => {
  const limits = framingLimits({ maxHeaderBytes: 32, maxBodyBytes: 64 });
  const encoder = new TextEncoder();
  const bigHeader = encoder.encode(
    "Content-Length: 2\r\nX-Pad: 0123456789abcdef\r\n\r\n{}",
  );
  const good = { jsonrpc: "2.0", id: 3, method: "exit", params: null };
  const headers = new FrameReader(
    streamOf([bigHeader, frameOf(good)]).getReader(),
    limits,
  );
  await assertRejects(() => headers.read(), OversizedHeaderError);
  assertEquals(await readAll(headers), [good]);
  headers.releaseLock();
  const badBody = `{"id":1,"pad":"${"x".repeat(100)}"}`;
  const badLength = encoder.encode(badBody).byteLength;
  assert(badLength > 64);
  const bigBody = encoder.encode(
    `Content-Length: ${badLength}\r\n\r\n${badBody}`,
  );
  const bodies = new FrameReader(
    streamOf([bigBody, frameOf(good)]).getReader(),
    limits,
  );
  let failure: unknown = null;
  try {
    await bodies.read();
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof OversizedBodyError);
  assertEquals(failure.responseId, undefined);
  assertEquals(await readAll(bodies), [good]);
  bodies.releaseLock();
});

Deno.test("framing reports a length-less header and reads past it", async () => {
  const encoder = new TextEncoder();
  const bad = encoder.encode("X-No-Length: yes\r\n\r\n");
  const good = { jsonrpc: "2.0", id: 4, method: "exit", params: null };
  const reader = new FrameReader(streamOf([bad, frameOf(good)]).getReader());
  await assertRejects(() => reader.read(), MissingContentLengthError);
  assertEquals(await readAll(reader), [good]);
  reader.releaseLock();
});

Deno.test("framing rejects nonsense limits", () => {
  const bad = [0, -1, 1.5, Number.NaN];
  for (const value of bad) {
    let headerFailed = false;
    try {
      framingLimits({ maxHeaderBytes: value });
    } catch {
      headerFailed = true;
    }
    assert(headerFailed);
    let bodyFailed = false;
    try {
      framingLimits({ maxBodyBytes: value });
    } catch {
      bodyFailed = true;
    }
    assert(bodyFailed);
  }
  assertEquals(framingLimits(), {
    maxHeaderBytes: 16 * 1024,
    maxBodyBytes: 16 * 1024 * 1024,
  });
});

Deno.test("the writer orders concurrent writes behind one another", async () => {
  const chunks: Uint8Array[] = [];
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  const writer = new FrameWriter(output.getWriter());
  const first = writer.write({ jsonrpc: "2.0", id: 1, result: null });
  const second = writer.write({ jsonrpc: "2.0", id: 2, result: null });
  const third = writer.write({ jsonrpc: "2.0", id: 3, result: null });
  await Promise.all([first, second, third]);
  assertEquals(chunks.length, 3);
  const decoder = new TextDecoder();
  const ids: unknown[] = [];
  for (const chunk of chunks) {
    const text = decoder.decode(chunk);
    const body = text.slice(text.indexOf("\r\n\r\n") + 4);
    ids.push((JSON.parse(body) as { id: unknown }).id);
  }
  assertEquals(ids, [1, 2, 3]);
  writer.releaseLock();
});

Deno.test("the writer honors backpressure with one outstanding write", async () => {
  const seen: number[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      calls += 1;
      seen.push(calls);
      if (calls === 1) await gate;
      void chunk;
    },
  });
  const writer = new FrameWriter(output.getWriter());
  const first = writer.write({ jsonrpc: "2.0", id: 1, result: null });
  const second = writer.write({ jsonrpc: "2.0", id: 2, result: null });
  await settleMicrotasks();
  assertEquals(seen, [1]);
  release();
  await Promise.all([first, second]);
  assertEquals(seen, [1, 2]);
  writer.releaseLock();
});

Deno.test("the writer latches the first failure and rejects later writes", async () => {
  const output = new WritableStream<Uint8Array>({
    write() {
      throw new Error("stream is gone");
    },
  });
  const writer = new FrameWriter(output.getWriter());
  assertEquals(writer.broken, false);
  await assertRejects(() => writer.write({ jsonrpc: "2.0", id: 1 }));
  assertEquals(writer.broken, true);
  await assertRejects(() => writer.write({ jsonrpc: "2.0", id: 2 }));
  await writer.flush();
  writer.releaseLock();
});
