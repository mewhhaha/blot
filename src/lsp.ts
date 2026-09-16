// Compatibility entry for the Blot language server.
//
// The coordinator owns the implementation in ./lsp/server.ts; this module
// preserves the historical import path and the runLanguageServer shape with
// Deno stdio defaults. The optional third parameter carries
// LanguageServerOptions (clock, trace sink, hosts, budgets).
import { runCoordinatorServer } from "./lsp/server.ts";
import type { LanguageServerOptions } from "./lsp/server.ts";

export type { LanguageServerOptions } from "./lsp/server.ts";
export type { RequestId } from "./lsp/errors.ts";
export type { Clock } from "./lsp/requests.ts";
export type { TraceEvent, TraceSink } from "./lsp/scheduler.ts";

/** Runs the language server over the given streams until exit or EOF. */
export async function runLanguageServer(
  input: ReadableStream<Uint8Array> = Deno.stdin.readable,
  output: WritableStream<Uint8Array> = Deno.stdout.writable,
  options: LanguageServerOptions = {},
): Promise<void> {
  await runCoordinatorServer(input, output, options);
}
