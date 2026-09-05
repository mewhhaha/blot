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
          text: `open import "blot:prelude"
let remainder :: _
let remainder = Op.rem 5 2
const Result = Int
let typed :: Result
let typed = 1
return remainder
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
          start: { line: 2, character: 16 },
          end: { line: 2, character: 26 },
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
        position: { line: 2, character: 17 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "textDocument/completion",
      params: {
        textDocument: { uri },
        position: { line: 6, character: 7 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "textDocument/inlayHint",
      params: {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 6, character: 16 },
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 8,
      method: "textDocument/typeDefinition",
      params: {
        textDocument: { uri },
        position: { line: 5, character: 5 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: { line: 2, character: 17 },
      },
    },
    {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 6 },
    },
    { jsonrpc: "2.0", id: 5, method: "shutdown", params: null },
    { jsonrpc: "2.0", method: "exit", params: null },
  ];
  const responses = await exchange(messages);

  const initialize = responses.find((response) => response.id === 1) as {
    readonly result: { readonly capabilities: Record<string, unknown> };
  };
  assertEquals(initialize.result.capabilities.codeActionProvider, true);
  assertEquals(initialize.result.capabilities.hoverProvider, true);
  assertEquals(initialize.result.capabilities.typeDefinitionProvider, true);
  assertEquals(initialize.result.capabilities.referencesProvider, true);
  assertEquals(initialize.result.capabilities.inlayHintProvider, true);
  const codeAction = responses.find((response) => response.id === 2) as {
    readonly result: readonly { readonly title: string }[];
  };
  assertEquals(codeAction.result.map((action) => action.title), [
    "Replace `Op.rem` with `%`",
  ]);
  const completion = responses.find((response) => response.id === 4) as {
    readonly result: readonly { readonly label: string }[];
  };
  assertEquals(
    completion.result.some((item) => item.label === "return"),
    true,
  );
  const inlayHints = responses.find((response) => response.id === 7) as {
    readonly result: readonly {
      readonly position: { readonly line: number; readonly character: number };
      readonly label: string;
      readonly kind: number;
      readonly tooltip: string;
    }[];
  };
  assertEquals(inlayHints.result, [{
    position: { line: 1, character: 18 },
    label: ": Int",
    kind: 1,
    tooltip: "Compiler-inferred signature hole",
  }]);
  const typeDefinition = responses.find((response) => response.id === 8) as {
    readonly result: readonly {
      readonly uri: string;
      readonly range: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
      };
    }[];
  };
  assertEquals(typeDefinition.result, [{
    uri,
    range: {
      start: { line: 3, character: 6 },
      end: { line: 3, character: 12 },
    },
  }]);
  const cancelled = responses.find((response) => response.id === 6) as {
    readonly error: { readonly code: number };
  };
  assertEquals(cancelled.error.code, -32800);
});

Deno.test("document close releases a diskless LSP root", async () => {
  const uri = "untitled:lsp-close.blot";
  const responses = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, version: 1, text: "return missing\n" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    },
    { jsonrpc: "2.0", id: 2, method: "shutdown", params: null },
    { jsonrpc: "2.0", method: "exit", params: null },
  ]);
  const diagnostics = responses.filter((response) =>
    response.method === "textDocument/publishDiagnostics"
  );
  assertEquals(diagnostics.at(-1)?.params, { uri, diagnostics: [] });
  assertEquals(
    responses.some((response) => response.method === "window/logMessage"),
    false,
  );
});

Deno.test("the LSP removes an unreachable statement with one action", async () => {
  const uri = "untitled:lsp-unreachable-action.blot";
  const responses = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          version: 1,
          text: "return 1\nlet unreachable = 2\n",
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
          start: { line: 1, character: 0 },
          end: { line: 1, character: 19 },
        },
        context: { diagnostics: [] },
      },
    },
    { jsonrpc: "2.0", id: 3, method: "shutdown", params: null },
    { jsonrpc: "2.0", method: "exit", params: null },
  ]);

  const codeActions = responses.find((response) => response.id === 2) as {
    readonly result: readonly {
      readonly title: string;
      readonly edit: {
        readonly documentChanges: readonly [{
          readonly edits: readonly [{ readonly newText: string }];
        }];
      };
    }[];
  };
  assertEquals(codeActions.result.map((action) => action.title), [
    "Remove unreachable statement",
  ]);
  assertEquals(
    codeActions.result[0]?.edit.documentChanges[0].edits[0].newText,
    "",
  );
});

async function exchange(
  messages: readonly unknown[],
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
  return responses;
}
