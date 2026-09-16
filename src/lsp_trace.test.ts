import { assert, assertEquals } from "@std/assert";
import {
  type LanguageServerOptions,
  runLanguageServer,
  type TraceEvent,
} from "./lsp.ts";

Deno.test("coordinator traces lane lifecycle for a formatting request", async () => {
  const uri = "untitled:lsp-trace-order.blot";
  const events: TraceEvent[] = [];
  const responses = await exchange(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "initialized", params: {} },
      {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, version: 1, text: "let   x=1\nreturn x\n" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "textDocument/formatting",
        params: { textDocument: { uri }, options: {} },
      },
      { jsonrpc: "2.0", id: 3, method: "shutdown", params: null },
      { jsonrpc: "2.0", method: "exit", params: null },
    ],
    { traceSink: (event) => events.push(event) },
  );
  assertEquals(responses.find((response) => response.id === 2)?.result, [{
    range: {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 8 },
    },
    newText: "x = ",
  }]);
  const kinds = events.map((event) => event.kind);
  for (
    const required of [
      "server/start",
      "server/initializing",
      "diagnostics/opened",
      "lane/enqueue",
      "lane/dispatch",
      "lane/result",
      "server/shutdown",
    ]
  ) {
    assert(kinds.includes(required), `trace omits ${required}`);
  }
  for (const event of events) assert(typeof event.at === "number");
  const enqueued = events.findIndex((event) =>
    event.kind === "lane/enqueue" &&
    (event.detail as { requestId?: unknown }).requestId === 2
  );
  const dispatched = events.findIndex((event) =>
    event.kind === "lane/dispatch" &&
    (event.detail as { requestId?: unknown }).requestId === 2
  );
  assert(enqueued >= 0 && dispatched > enqueued);
  const jobId = (events[dispatched] as TraceEvent).detail as {
    jobId?: unknown;
  };
  const resulted = events.findIndex((event) =>
    event.kind === "lane/result" &&
    (event.detail as { job?: unknown }).job === jobId.jobId
  );
  assert(resulted > dispatched);
});

Deno.test("coordinator tracing never writes to stdout", async () => {
  const uri = "untitled:lsp-trace-stdout.blot";
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = (...args: unknown[]): void => {
    calls.push(args);
  };
  console.info = (...args: unknown[]): void => {
    calls.push(args);
  };
  try {
    const events: TraceEvent[] = [];
    await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "initialized", params: {} },
        {
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: { uri, version: 1, text: "return 1\n" },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "shutdown", params: null },
        { jsonrpc: "2.0", method: "exit", params: null },
      ],
      { traceSink: (event) => events.push(event) },
    );
    assert(events.length > 0);
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
  assertEquals(calls, []);
});

async function exchange(
  messages: readonly unknown[],
  options?: LanguageServerOptions,
): Promise<Record<string, unknown>[]> {
  const encoder = new TextEncoder();
  const input = new Blob(messages.map((message) => {
    const body = JSON.stringify(message);
    return `Content-Length: ${encoder.encode(body).byteLength}\r\n\r\n${body}`;
  })).stream();
  const chunks: Uint8Array[] = [];
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });

  await runLanguageServer(input, output, options);

  const byteLength = chunks.reduce(
    (length, chunk) => length + chunk.byteLength,
    0,
  );
  const bytes = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  const responses: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = new TextDecoder().decode(bytes.slice(offset));
    const boundary = remaining.indexOf("\r\n\r\n");
    if (boundary < 0) throw new Error("LSP response omitted its header body");
    const header = remaining.slice(0, boundary);
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isInteger(length)) {
      throw new Error(`LSP response has invalid Content-Length: ${header}`);
    }
    const bodyStart = offset + encoder.encode(
      remaining.slice(0, boundary + 4),
    ).byteLength;
    const bodyEnd = bodyStart + length;
    responses.push(
      JSON.parse(new TextDecoder().decode(bytes.slice(bodyStart, bodyEnd))),
    );
    offset = bodyEnd;
  }
  return responses;
}
