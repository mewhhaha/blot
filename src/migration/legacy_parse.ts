import { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";
import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import { type CompactSchema, materializeCpuCst } from "../syntax/cpu_cst.ts";
import type { Module } from "../syntax/ast.ts";
import { lowerModule, type Rule } from "../syntax/lower.ts";
import {
  compactFieldNames,
  compactNamedTokenKinds,
  compactRepeatedFields,
} from "../../migration/layout-v1/compact_schema.ts";

const planUrl = new URL(
  "../../migration/layout-v1/parser.plan",
  import.meta.url,
);

const legacySchema: CompactSchema = {
  fieldNames: compactFieldNames,
  namedTokenKinds: compactNamedTokenKinds,
  repeatedFields: compactRepeatedFields,
};

let shared: CpuFrontend | null = null;

export type LegacyParseResult =
  | {
    readonly ok: true;
    readonly module: Module | null;
    readonly diagnostic: Diagnostic | null;
    readonly cst: Rule;
  }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export async function parseLegacySource(
  source: string,
): Promise<LegacyParseResult> {
  const frontend = await legacyParser();
  const result = frontend.ingest(source);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        span: { start: diagnostic.start, end: diagnostic.end },
      })),
    };
  }
  const cst = materializeCpuCst(
    frontend,
    result.program,
    source,
    (offset) => offset,
    legacySchema,
  );
  try {
    return {
      ok: true,
      module: lowerModule(cst, source),
      diagnostic: null,
      cst,
    };
  } catch (error) {
    if (error instanceof BlotError) {
      return {
        ok: true,
        module: null,
        diagnostic: error.diagnostic,
        cst,
      };
    }
    throw error;
  }
}

async function legacyParser(): Promise<CpuFrontend> {
  if (shared === null) {
    shared = CpuFrontend.create(await Deno.readFile(planUrl));
  }
  return shared;
}
