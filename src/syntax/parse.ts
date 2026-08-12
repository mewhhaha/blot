// The parse entry point. Every compiler command runs Baba in Node: its
// generated Wasm owns lexing, while Baba's general-profile CPU island executor
// owns parsing. The general plan is intentionally not accepted by Baba's
// strict-only generated-Wasm island parser.

import type { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";
import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import type { Module } from "./ast.ts";
import { babaRuntime, disposeBabaRuntime } from "./baba_runtime.ts";
import type { Rule } from "./cursor.ts";
import { materializeCpuCst } from "./cpu_cst.ts";
import { lowerModule } from "./lower.ts";
import { elaborateLayout } from "./layout.ts";
import { rebindingFrameDiagnostics } from "./rebinding.ts";
import { elaborateSurface } from "./surface.ts";

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
        code: diagnostic.code,
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
        code: diagnostic.code,
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

export function ingestCpuSource(
  instance: CpuFrontend,
  source: string,
): ReturnType<CpuFrontend["ingest"]> {
  let result = instance.ingest(source);
  if (
    !result.ok &&
    result.diagnostics.length > 0 &&
    result.diagnostics.every((diagnostic) =>
      diagnostic.code === "GPU_FRONTEND_INTEGER_BOUNDS"
    )
  ) {
    // Baba owns syntax, but its compact frontend also applies an I32 policy
    // that is not part of Blot's I64 integer domain. Baba has already proved
    // these spans are integer tokens, so replacing their digits preserves token
    // identities and offsets without duplicating lexical logic in Blot.
    let syntaxSource = source;
    for (const diagnostic of [...result.diagnostics].reverse()) {
      syntaxSource = syntaxSource.slice(0, diagnostic.start) +
        "0".repeat(diagnostic.end - diagnostic.start) +
        syntaxSource.slice(diagnostic.end);
    }
    result = instance.ingest(syntaxSource);
  }
  return result;
}

export function dispose(): void {
  disposeBabaRuntime();
}
