import { assertEquals } from "@std/assert";
import { runLanguageServer } from "./lsp.ts";

Deno.test("the LSP advertises and returns lint code actions", async () => {
  const uri = "untitled:lsp-code-action.blot";
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          version: 1,
          text: `return Num.rem 5 2
`,
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 18 },
        },
        context: { diagnostics: [] },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: { line: 0, character: 8 },
      },
    },
    { jsonrpc: "2.0", id: 4, method: "shutdown", params: null },
    { jsonrpc: "2.0", method: "exit", params: null },
  ];
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

  await runLanguageServer(input, output);

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

  const initialize = responses.find((response) => response.id === 1) as {
    readonly result: { readonly capabilities: Record<string, unknown> };
  };
  assertEquals(initialize.result.capabilities.codeActionProvider, true);
  assertEquals(initialize.result.capabilities.hoverProvider, true);
  const codeAction = responses.find((response) => response.id === 2) as {
    readonly result: readonly { readonly title: string }[];
  };
  assertEquals(codeAction.result.map((action) => action.title), [
    "Replace `Num.rem` with `%`",
  ]);
});
