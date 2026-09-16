// src/tooling/format_parity.test.ts
//
// Proves every repository formatting path runs the one formatSource engine
// with identical style resolution: the Deno CLI file command, the LSP
// formatting request, and the facade itself produce identical bytes for
// the same input.
//
// The CLI side spawns the real `fmt` command on a temporary file; the LSP
// side drives the coordinator over an in-memory transport and applies the
// returned edits. Justfile `format`/`format-check` targets and
// scripts/format_blot.ts both call this same facade with default controls,
// so byte identity here covers them too.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { runLanguageServer } from "../lsp.ts";
import { offsetAtPosition } from "../text/document.ts";
import { formatSource } from "./formatter.ts";

const FIXTURE = "const  pair  =  (1,   2)\nlet   x=1\nreturn (x,   pair)\n";

Deno.test("CLI file formatting matches LSP formatting byte for byte", async () => {
  const repository = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
  const cliBytes = await formatThroughCli(repository, FIXTURE);
  const lspBytes = await formatThroughLsp(FIXTURE);
  const facade = await formatSource(FIXTURE);
  if (!facade.ok) throw new Error(JSON.stringify(facade.diagnostics));
  assert(cliBytes !== FIXTURE, "the fixture is already formatted");
  assertEquals(lspBytes, cliBytes);
  assertEquals(facade.source, cliBytes);
});

async function formatThroughCli(
  repository: string,
  source: string,
): Promise<string> {
  const directory = await Deno.makeTempDir({ prefix: "blot-format-cli-" });
  try {
    const path = join(directory, "fixture.blot");
    await Deno.writeTextFile(path, source);
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        join(repository, "src", "cli.ts"),
        "fmt",
        path,
      ],
      cwd: repository,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = await child.output();
    if (output.code !== 0) {
      throw new Error(
        `blot fmt failed: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    return await Deno.readTextFile(path);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

interface FormatEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
}

async function formatThroughLsp(source: string): Promise<string> {
  const uri = "untitled:format-parity.blot";
  const responses = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, version: 1, text: source } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/formatting",
      params: { textDocument: { uri }, options: {} },
    },
    { jsonrpc: "2.0", id: 3, method: "shutdown", params: null },
    { jsonrpc: "2.0", method: "exit", params: null },
  ]);
  const formatting = responses.find((response) => response.id === 2);
  if (formatting === undefined) throw new Error("formatting never settled");
  if (formatting.error !== undefined) {
    throw new Error(`formatting failed: ${JSON.stringify(formatting.error)}`);
  }
  const edits = formatting.result as readonly FormatEdit[];
  let applied = source;
  for (const edit of edits) {
    const start = offsetAtPosition(applied, edit.range.start);
    const end = offsetAtPosition(applied, edit.range.end);
    applied = applied.slice(0, start) + edit.newText + applied.slice(end);
  }
  return applied;
}

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
  const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const responses: Record<string, unknown>[] = [];
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const rest = new TextDecoder().decode(bytes.slice(cursor));
    const boundary = rest.indexOf("\r\n\r\n");
    if (boundary < 0) throw new Error("LSP response omitted its header body");
    const header = rest.slice(0, boundary);
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isInteger(length)) {
      throw new Error(`LSP response has invalid Content-Length: ${header}`);
    }
    const bodyStart = cursor +
      encoder.encode(rest.slice(0, boundary + 4)).byteLength;
    const bodyEnd = bodyStart + length;
    responses.push(
      JSON.parse(new TextDecoder().decode(bytes.slice(bodyStart, bodyEnd))),
    );
    cursor = bodyEnd;
  }
  return responses;
}
