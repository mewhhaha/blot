import { LanguageService } from "./language_service.ts";
import type { Position, Range } from "./language_service.ts";

type RequestId = number | string | null;

interface RpcMessage {
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
}

interface TextDocumentIdentifier {
  readonly uri: string;
}

interface VersionedTextDocument extends TextDocumentIdentifier {
  readonly version: number;
}

interface OpenedTextDocument extends VersionedTextDocument {
  readonly text: string;
}

interface TextDocumentParams {
  readonly textDocument: TextDocumentIdentifier;
}

interface OpenParams {
  readonly textDocument: OpenedTextDocument;
}

interface ChangeParams {
  readonly textDocument: VersionedTextDocument;
  readonly contentChanges: readonly { readonly text: string }[];
}

interface PositionParams extends TextDocumentParams {
  readonly position: Position;
}

interface CodeActionParams extends TextDocumentParams {
  readonly range: Range;
}

export async function runLanguageServer(
  input: ReadableStream<Uint8Array> = Deno.stdin.readable,
  output: WritableStream<Uint8Array> = Deno.stdout.writable,
): Promise<void> {
  const reader = new MessageReader(input.getReader());
  const writer = output.getWriter();
  const service = new LanguageService();
  let shutdown = false;
  try {
    while (true) {
      const message = await reader.read();
      if (message === null) return;
      if (message.method === "exit") return;
      try {
        if (message.method === "initialize") {
          await respond(writer, message.id, {
            capabilities: {
              textDocumentSync: 1,
              definitionProvider: true,
              hoverProvider: true,
              documentFormattingProvider: true,
              codeActionProvider: true,
            },
            serverInfo: { name: "blot", version: "0.1.0" },
          });
          continue;
        }
        if (
          message.method === "initialized" ||
          message.method === "$/cancelRequest"
        ) {
          continue;
        }
        if (message.method === "shutdown") {
          shutdown = true;
          await respond(writer, message.id, null);
          continue;
        }
        if (shutdown) {
          await reject(writer, message.id, -32600, "server has shut down");
          continue;
        }
        if (message.method === "textDocument/didOpen") {
          const params = message.params as OpenParams;
          service.open(
            params.textDocument.uri,
            params.textDocument.text,
            params.textDocument.version,
          );
          await publishDiagnostics(service, writer, params.textDocument.uri);
          continue;
        }
        if (message.method === "textDocument/didChange") {
          const params = message.params as ChangeParams;
          const change = params.contentChanges.at(-1);
          if (change === undefined) {
            throw new Error(
              `document ${params.textDocument.uri} changed without replacement text`,
            );
          }
          service.change(
            params.textDocument.uri,
            change.text,
            params.textDocument.version,
          );
          await publishDiagnostics(service, writer, params.textDocument.uri);
          continue;
        }
        if (message.method === "textDocument/didSave") {
          const params = message.params as TextDocumentParams;
          await publishDiagnostics(service, writer, params.textDocument.uri);
          continue;
        }
        if (message.method === "textDocument/didClose") {
          const params = message.params as TextDocumentParams;
          service.close(params.textDocument.uri);
          await notify(writer, "textDocument/publishDiagnostics", {
            uri: params.textDocument.uri,
            diagnostics: [],
          });
          continue;
        }
        if (message.method === "textDocument/definition") {
          const params = message.params as PositionParams;
          const location = await service.definition(
            params.textDocument.uri,
            params.position,
          );
          await respond(writer, message.id, location);
          continue;
        }
        if (message.method === "textDocument/hover") {
          const params = message.params as PositionParams;
          const hover = await service.hover(
            params.textDocument.uri,
            params.position,
          );
          await respond(writer, message.id, hover);
          continue;
        }
        if (message.method === "textDocument/formatting") {
          const params = message.params as TextDocumentParams;
          const edits = await service.formatting(params.textDocument.uri);
          await respond(writer, message.id, edits);
          continue;
        }
        if (message.method === "textDocument/codeAction") {
          const params = message.params as CodeActionParams;
          const actions = await service.codeActions(
            params.textDocument.uri,
            params.range,
          );
          await respond(writer, message.id, actions);
          continue;
        }
        await reject(
          writer,
          message.id,
          -32601,
          `method ${JSON.stringify(message.method)} is not supported`,
        );
      } catch (error) {
        const messageText = error instanceof Error
          ? error.message
          : String(error);
        if (message.id !== undefined) {
          await reject(writer, message.id, -32603, messageText);
        } else {
          await notify(writer, "window/logMessage", {
            type: 1,
            message: messageText,
          });
        }
      }
    }
  } finally {
    await service.destroy();
    writer.releaseLock();
    reader.releaseLock();
  }
}

async function publishDiagnostics(
  service: LanguageService,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  uri: string,
): Promise<void> {
  const diagnostics = await service.diagnostics(uri);
  await notify(writer, "textDocument/publishDiagnostics", {
    uri,
    version: service.version(uri),
    diagnostics,
  });
}

async function respond(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  id: RequestId | undefined,
  result: unknown,
): Promise<void> {
  if (id === undefined) return;
  await writeMessage(writer, { jsonrpc: "2.0", id, result });
}

async function reject(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  id: RequestId | undefined,
  code: number,
  message: string,
): Promise<void> {
  if (id === undefined) return;
  await writeMessage(writer, {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function notify(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  method: string,
  params: unknown,
): Promise<void> {
  await writeMessage(writer, { jsonrpc: "2.0", method, params });
}

async function writeMessage(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: unknown,
): Promise<void> {
  const encoder = new TextEncoder();
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  await writer.write(concatenate(header, body));
}

class MessageReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array();

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async read(): Promise<RpcMessage | null> {
    while (true) {
      const headerEnd = headerBoundary(this.#buffer);
      if (headerEnd >= 0) {
        const header = new TextDecoder().decode(
          this.#buffer.slice(0, headerEnd),
        );
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
        if (match === null) {
          throw new Error(`LSP message omitted Content-Length: ${header}`);
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.#buffer.byteLength >= bodyEnd) {
          const body = new TextDecoder().decode(
            this.#buffer.slice(bodyStart, bodyEnd),
          );
          this.#buffer = this.#buffer.slice(bodyEnd);
          return JSON.parse(body) as RpcMessage;
        }
      }

      const chunk = await this.#reader.read();
      if (chunk.done) {
        if (this.#buffer.byteLength === 0) return null;
        throw new Error("LSP input ended in the middle of a message");
      }
      this.#buffer = concatenate(this.#buffer, chunk.value);
    }
  }

  releaseLock(): void {
    this.#reader.releaseLock();
  }
}

function headerBoundary(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 13 && bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 && bytes[index + 3] === 10
    ) return index;
  }
  return -1;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}
