// The parse entry point. Every compiler command runs Baba in Node: its
// generated Wasm owns lexing, while Baba's general-profile CPU island executor
// owns parsing. The general plan is intentionally not accepted by Baba's
// strict-only generated-Wasm island parser.

import { BlotError, type Diagnostic, diagnosticCode } from "../diagnostic.ts";
import type { Module } from "./ast.ts";
import { babaRuntime, disposeBabaRuntime } from "./baba_runtime.ts";
import type { Rule } from "./cursor.ts";
import { materializeCpuCst } from "./cpu_cst.ts";
import { ingestCpuSource } from "./cpu_ingest.ts";
import { lowerModule } from "./lower.ts";
import { elaborateLayout } from "./layout.ts";
import { rebindingFrameDiagnostics } from "./rebinding.ts";
import { elaborateSurface } from "./surface.ts";

export { ingestCpuSource };

export type ParseResult =
  | { readonly ok: true; readonly module: Module }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export async function parse(source: string): Promise<ParseResult> {
  const result = await parseConcrete(source);
  if (!result.ok) return result;
  const rebinding = rebindingFrameDiagnostics(result.cst);
  if (rebinding.length > 0) return { ok: false, diagnostics: rebinding };
  return { ok: true, module: result.module };
}

export type ConcreteParseResult =
  | { readonly ok: true; readonly module: Module; readonly cst: Rule }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** Parses source while retaining Baba's concrete tree for source tooling. */
export async function parseConcrete(
  source: string,
): Promise<ConcreteParseResult> {
  const elaborated = await elaborateLayout(source);
  if (!elaborated.ok) return elaborated;
  const runtime = await babaRuntime();

  const lexed = runtime.wasmLexer.lex(elaborated.layout.source);
  if (lexed.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: lexed.diagnostics.map((diagnostic) => ({
        code: diagnosticCode(diagnostic.code),
        message: diagnostic.message,
        span: {
          start: elaborated.layout.originalOffset(diagnostic.span.start),
          end: elaborated.layout.originalOffset(diagnostic.span.end),
        },
      })),
    };
  }

  const result = ingestCpuSource(
    runtime.cpuParser,
    elaborated.layout.source,
  );
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnosticCode(diagnostic.code),
        message: diagnostic.message,
        span: {
          start: elaborated.layout.originalOffset(diagnostic.start),
          end: elaborated.layout.originalOffset(diagnostic.end),
        },
      })),
    };
  }

  try {
    const cst = materializeCpuCst(
      runtime.cpuParser,
      result.program,
      elaborated.layout.source,
      elaborated.layout.originalOffset,
    );
    return {
      ok: true,
      module: elaborateSurface(lowerModule(cst, source)),
      cst,
    };
  } catch (error) {
    if (error instanceof BlotError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}

export function dispose(): void {
  disposeBabaRuntime();
}
