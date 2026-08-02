// The parse entry point. Every compiler command uses baba's generated
// WebAssembly parser, so parsing never depends on a WebGPU adapter.

import { createParser, type ParserInstance } from "../../generated/wasm/mod.ts";
import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import type { Module } from "./ast.ts";
import { lowerModule, type Rule } from "./lower.ts";

const wasmUrl = new URL("../../generated/wasm/parser.wasm", import.meta.url);
const planUrl = new URL("../../generated/wasm/parser.plan", import.meta.url);

let shared: ParserInstance | null = null;

async function parser(): Promise<ParserInstance> {
  if (shared !== null) return shared;
  shared = createParser({
    bytes: await Deno.readFile(wasmUrl),
    plan: await Deno.readFile(planUrl),
  });
  return shared;
}

export type ParseResult =
  | { readonly ok: true; readonly module: Module }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export async function parse(source: string): Promise<ParseResult> {
  const instance = await parser();
  const result = instance.parse(source);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        span: diagnostic.span,
      })),
    };
  }

  try {
    return {
      ok: true,
      module: lowerModule(result.cursor as unknown as Rule, source),
    };
  } catch (error) {
    if (error instanceof BlotError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}

export function dispose(): void {
  if (shared !== null) {
    shared.dispose();
    shared = null;
  }
}
